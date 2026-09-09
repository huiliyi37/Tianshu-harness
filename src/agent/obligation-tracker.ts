/**
 * ObligationTracker — evidence-obligation 纯 reducer 的会话级有状态封装。
 *
 * 与 EvidenceTracker 同寿命，由 AgentLoop 持有。所有变换委托给纯函数
 * （evidence-obligation.ts），本类只负责：
 * - 持有当前 ObligationStore 引用（immutable 替换，不 mutate）
 * - 工具管线/hook 的接入便利面（probe、verification、失败信号、RED 编辑门）
 * - final gate 的一次性续轮 latch（Wave 3 由 turn-orchestrator 消费）
 *
 * @module obligation-tracker
 */

import type { VerificationMetadata } from '../tools/types.js'
import {
  applyProbeEvent,
  applyVerificationEvent,
  blockObligation,
  emptyObligationStore,
  evaluateFinalCandidate,
  hasRedEvidence,
  recordAttempt,
  renderObligationBlock,
  satisfyObligation,
  supersedeOpenObligations,
  upsertObligation,
  deriveObligationId,
  type CreateObligationInput,
  type EvidenceObligation,
  type FinalEvaluation,
  type ObligationStore,
  type ProbeEventInput,
} from './evidence-obligation.js'

/** 测试/scratch 文件不受 RED 编辑门约束——写测试正是 RED 的第一步。 */
const RED_EXEMPT_PATH_RE = /\.test\.|\.spec\.|__tests__|_test\.|test_|(?:^|[/\\])\.rivet[/\\]scratch(?:[/\\]|$)/

export interface SourceEditGateDecision {
  block: boolean
  message?: string
}

export class ObligationTracker {
  #store: ObligationStore = emptyObligationStore()
  /** 单调递增：store 引用每次变化 +1。final gate 误触发遥测用——续轮后
   *  version 不变 = 模型没有产生任何改变义务状态的证据动作。 */
  #version = 0
  /** RED 编辑门的一次性 latch：同一义务只硬拦一次，重发放行（有界 gate，
   *  与 destructive gate 同哲学——挡的是惯性，不挡明确意图）。 */
  #redGateFired = new Set<string>()
  /** final gate 的一次性续轮 latch（Wave 3 消费）：同一义务只自动续轮一次。 */
  #continuedOnce = new Set<string>()

  getStore(): ObligationStore {
    return this.#store
  }

  /** store 版本号：任何状态变化单调 +1。状态未变（reducer 返回同引用）不变。 */
  getVersion(): number {
    return this.#version
  }

  #set(next: ObligationStore): void {
    if (next !== this.#store) {
      this.#store = next
      this.#version += 1
    }
  }

  /** 创建/合并义务，返回稳定 ID。 */
  upsert(input: CreateObligationInput): string {
    this.#set(upsertObligation(this.#store, input))
    return deriveObligationId(input.family, input.claim, input.targets ?? [])
  }

  recordAttempt(id: string, input: { evidenceRef?: string; failureClass?: string } = {}): void {
    this.#set(recordAttempt(this.#store, id, input))
  }

  satisfy(id: string, evidenceRef: string): void {
    this.#set(satisfyObligation(this.#store, id, evidenceRef))
  }

  block(id: string, reason: string): void {
    this.#set(blockObligation(this.#store, id, reason))
  }

  /** 用户任务边界：未决义务全部作废，latch 清空。 */
  supersedeOpen(): void {
    this.#set(supersedeOpenObligations(this.#store))
    this.#redGateFired.clear()
    this.#continuedOnce.clear()
  }

  applyVerification(meta: VerificationMetadata): void {
    this.#set(applyVerificationEvent(this.#store, meta))
  }

  applyProbe(probe: ProbeEventInput): void {
    this.#set(applyProbeEvent(this.#store, probe))
  }

  /** 工具失败信号（error-diagnosis / tool-pipeline catch 路径）：
   *  target 关联的未决义务登记一次失败尝试，驱动升级阶梯。 */
  recordFailureSignal(failureClass: string, target?: string): void {
    if (!target) return
    const normalized = target.replaceAll('\\', '/')
    for (const ob of this.#store.obligations) {
      if (ob.state === 'satisfied' || ob.state === 'superseded' || ob.state === 'blocked') continue
      const matches = ob.targets.some(t => normalized.includes(t) || t.includes(normalized))
      if (matches) {
        this.#set(recordAttempt(this.#store, ob.id, { failureClass }))
      }
    }
  }

  /**
   * RED 编辑门（有界）：高风险 bugfix 义务尚无 RED 证据时，对目标源文件的
   * 首次编辑返回 block + 最短动作；测试/scratch 文件豁免（写测试就是 RED）。
   * 同一义务只拦一次——模型坚持编辑（重发）则放行，不制造死锁。
   */
  evaluateSourceEditGate(filePath: string | undefined): SourceEditGateDecision {
    if (!filePath || RED_EXEMPT_PATH_RE.test(filePath)) return { block: false }
    const normalized = filePath.replaceAll('\\', '/')
    for (const ob of this.#store.obligations) {
      if (ob.family !== 'bugfix' || ob.risk !== 'high') continue
      if (ob.state !== 'open' && ob.state !== 'attempted') continue
      if (hasRedEvidence(ob)) continue
      if (this.#redGateFired.has(ob.id)) continue
      const matches = ob.targets.length === 0
        || ob.targets.some(t => normalized.includes(t) || t.includes(normalized))
      if (!matches) continue
      this.#redGateFired.add(ob.id)
      this.#set(recordAttempt(this.#store, ob.id, { failureClass: 'edit_before_red' }))
      return {
        block: true,
        message: `Edit blocked by evidence gate (once): 该任务的 bugfix 义务「${ob.claim}」还没有 RED 复现——` +
          `修复未被证明存在的缺陷是最常见的假修复。先写一个失败的测试（或 .rivet/scratch/ 探针）复现目标缺陷，看到 RED 再改 ${filePath}。` +
          `如果你确认不需要复现（例如纯重构/文案），原样重发本次编辑即可放行。`,
      }
    }
    return { block: false }
  }

  /** natural-finish 候选判定 + 一次性续轮 latch。
   *  verdict=continue_once 但该义务已续过一轮 → 降级 honest_blocked 语义
   *  （允许结束，但 unresolved 保留供披露），绝不无限循环。 */
  evaluateFinal(): FinalEvaluation & { alreadyContinued: boolean } {
    const result = evaluateFinalCandidate(this.#store)
    if (result.verdict !== 'continue_once' || !result.nextAction) {
      return { ...result, alreadyContinued: false }
    }
    if (this.#continuedOnce.has(result.nextAction.obligationId)) {
      return { ...result, verdict: 'honest_blocked', alreadyContinued: true }
    }
    return { ...result, alreadyContinued: false }
  }

  /** Wave 3：turn-orchestrator 在实际注入续轮动作后登记，保证只续一次。 */
  markContinued(obligationId: string): void {
    this.#continuedOnce.add(obligationId)
  }

  /** 缓存字节稳定的动态投影（状态不变 → 字节不变）。 */
  renderBlock(): string {
    return renderObligationBlock(this.#store)
  }

  /** 未决高风险义务（reasoning-spiral 等升级器消费）。 */
  unresolvedHigh(): readonly EvidenceObligation[] {
    return this.#store.obligations.filter(
      o => o.risk === 'high' && (o.state === 'open' || o.state === 'attempted'),
    )
  }
}
