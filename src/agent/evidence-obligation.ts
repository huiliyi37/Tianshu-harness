/**
 * Evidence Obligation — 证据义务状态机（证据驱动推理闭环的单一事实源）
 *
 * 把散落在 static prompt / Skill / hooks / TDD gate 中的「证据要求」收编为
 * 一个共享的事实对象：模型当前依赖哪条未证断言、需要什么动作关闭、失败后
 * 升级到哪一级、是否允许自然结束。
 *
 * 设计约束（计划 evidence-driven-agent-reasoning-loop）：
 * - 纯 reducer：所有变换返回新 store，无副作用、无时钟、无随机。
 * - 稳定 ID：hash(family + 归一化 claim + 排序 targets)，不含时间戳——
 *   同一事实断言跨轮/跨压缩边界收敛到同一义务，appendix 投影字节稳定。
 * - 不记录私有 CoT：只存外显事实断言摘要、证据类型、风险、动作和结果。
 * - blocked ≠ satisfied：高风险义务不得因受阻被当作已关闭；但真实证据
 *   出现后 blocked 义务仍可被 satisfy（受阻不是死刑）。
 * - final gate 只对 high 义务硬拦（low_risk_small_edit_never_gates_final）。
 *
 * @module evidence-obligation
 */

import { createHash } from 'node:crypto'
import type { VerificationMetadata } from '../tools/types.js'

// ─── 类型 ────────────────────────────────────────────────────────

export type EvidenceAction =
  | 'read_source'
  | 'cross_check'
  | 'micro_probe'
  | 'red_reproduction'
  | 'targeted_verification'
  | 'integration_environment'
  | 'baseline_diff'
  | 'ask_user'
  | 'user_acceptance'

export type ObligationState = 'open' | 'attempted' | 'satisfied' | 'blocked' | 'superseded'

export type ObligationFamily =
  | 'existence'
  | 'behavior'
  | 'bugfix'
  | 'regression'
  | 'external_claim'
  | 'environment'
  | 'delivery'
  /**
   * 用户级行为验收（2026-07-25）。与 delivery 正交：delivery 问「验没验过」，
   * acceptance 问「验在哪个层级」。**刻意不进 `applyVerificationEvent` 的
   * `awaitsVerification` 集合，也不进 `applyProbeEvent` 的家族过滤**——跑再多
   * 单测也关不掉它，只能由 agent 声明的可观察验收面被显式核销。
   * 这条排除是整个机制的支点，改动前务必读 applyVerificationEvent 的注释。
   */
  | 'acceptance'

export type ObligationRisk = 'low' | 'medium' | 'high'

export interface EvidenceObligation {
  readonly id: string
  readonly family: ObligationFamily
  readonly claim: string
  readonly targets: readonly string[]
  readonly risk: ObligationRisk
  readonly requiredAction: EvidenceAction
  readonly state: ObligationState
  readonly attempts: number
  readonly lastFailureClass?: string
  readonly evidenceRefs: readonly string[]
  /** 冗余验证声明（星河收编 #2）：达 k 个独立证据才 satisfied。缺省 =
   *  单证据关闭（现状语义）。groupId 是语义标签（如 galaxy DP 副本组），
   *  satisfy 计数不依赖它。 */
  readonly redundancy?: { kind: 'quorum'; k: number; groupId?: string }
  /** 冗余模式下已登记的满足次数（单证据模式无此字段）。 */
  readonly satisfyCount?: number
}

export interface ObligationStore {
  readonly obligations: readonly EvidenceObligation[]
}

export function emptyObligationStore(): ObligationStore {
  return { obligations: [] }
}

// ─── 稳定 ID ─────────────────────────────────────────────────────

/** claim 归一化：修剪 + 折叠空白。不同措辞 = 不同义务（设计意图）。 */
function normalizeClaim(claim: string): string {
  return claim.trim().replace(/\s+/g, ' ')
}

function normalizeTargets(targets: readonly string[]): string[] {
  return [...new Set(targets.map(t => t.trim().replaceAll('\\', '/')))].sort()
}

/** 确定性义务 ID：无时间戳/随机成分，同一事实断言恒得同一 ID。 */
export function deriveObligationId(
  family: ObligationFamily,
  claim: string,
  targets: readonly string[],
): string {
  const material = `${family}\u0001${normalizeClaim(claim)}\u0001${normalizeTargets(targets).join('\u0002')}`
  return `ob_${createHash('sha256').update(material).digest('hex').slice(0, 12)}`
}

// ─── 动作矩阵 ────────────────────────────────────────────────────

/** family → 第一动作（计划「动作升级矩阵」第一列）。 */
const FIRST_ACTION: Record<ObligationFamily, EvidenceAction> = {
  existence: 'read_source',
  behavior: 'read_source',
  bugfix: 'red_reproduction',
  regression: 'targeted_verification',
  external_claim: 'read_source',
  environment: 'integration_environment',
  delivery: 'targeted_verification',
  acceptance: 'user_acceptance',
}

/** 动作 → 面向模型的中文措辞。续轮提醒直接把枚举名塞进中文句子会读成噪声，
 *  措辞集中在这里，新增动作时一并补。 */
const ACTION_COPY: Record<EvidenceAction, string> = {
  read_source: '读源码确认',
  cross_check: '换一个独立工具交叉验证',
  micro_probe: '写最小探针验证',
  red_reproduction: '先写一个失败的测试复现目标缺陷（RED）',
  targeted_verification: '跑针对该改动的验证',
  integration_environment: '在集成环境里验证',
  baseline_diff: '与基线对照定位',
  ask_user: '向用户澄清',
  user_acceptance:
    '声明并执行用户级验收——用 todo 的 acceptance 字段写「用户做什么动作 → 看到什么可观察结果」，'
    + '执行后把该项回写为 met 并附 evidence；确实执行不了就标 blocked 并写明障碍',
}

export function describeAction(action: EvidenceAction): string {
  return ACTION_COPY[action]
}

/** 失败升级阶梯：同一义务连续无新证据或同类失败时的下一动作。
 *  终态动作映射到自身（不再升级——由 blocked/honest exit 接手）。 */
const ESCALATION: Record<ObligationFamily, Partial<Record<EvidenceAction, EvidenceAction>>> = {
  existence: { read_source: 'cross_check', cross_check: 'ask_user' },
  behavior: { read_source: 'micro_probe', micro_probe: 'integration_environment' },
  bugfix: { red_reproduction: 'integration_environment' },
  regression: { targeted_verification: 'baseline_diff' },
  external_claim: { read_source: 'micro_probe', micro_probe: 'targeted_verification' },
  environment: {},
  delivery: {},
  // 反复做不成验收 → 升级为请用户来收，而不是原地重复同一句催促。
  acceptance: { user_acceptance: 'ask_user' },
}

export function firstActionFor(family: ObligationFamily): EvidenceAction {
  return FIRST_ACTION[family]
}

export function escalateAction(family: ObligationFamily, current: EvidenceAction): EvidenceAction {
  return ESCALATION[family][current] ?? current
}

// ─── 创建与合并 ──────────────────────────────────────────────────

export interface CreateObligationInput {
  family: ObligationFamily
  claim: string
  targets?: readonly string[]
  risk?: ObligationRisk
  /** 覆盖矩阵默认第一动作（如 regression 的 baseline 条件臂）。 */
  requiredAction?: EvidenceAction
  /** 冗余验证声明：达 k 个独立证据才关闭。高风险结论（schema 变更、迁移、
   *  鉴权、资金路径）创建义务时应显式声明——只有显式声明才启用冗余模式，
   *  避免静默改变既有单证据关闭语义。 */
  redundancy?: { kind: 'quorum'; k: number; groupId?: string }
}

export function createObligation(input: CreateObligationInput): EvidenceObligation {
  const targets = normalizeTargets(input.targets ?? [])
  return {
    id: deriveObligationId(input.family, input.claim, targets),
    family: input.family,
    claim: normalizeClaim(input.claim),
    targets,
    risk: input.risk ?? 'medium',
    requiredAction: input.requiredAction ?? FIRST_ACTION[input.family],
    state: 'open',
    attempts: 0,
    evidenceRefs: [],
    ...(input.redundancy ? { redundancy: input.redundancy } : {}),
  }
}

const RISK_RANK: Record<ObligationRisk, number> = { low: 0, medium: 1, high: 2 }

/** upsert：同 ID 已存在且未 superseded 时保留其状态与进度，只把 risk 抬到
 *  两者较高值（不降级）；否则追加新义务。satisfied/blocked 义务不被重开。 */
export function upsertObligation(store: ObligationStore, input: CreateObligationInput): ObligationStore {
  const fresh = createObligation(input)
  const existing = store.obligations.find(o => o.id === fresh.id && o.state !== 'superseded')
  if (!existing) {
    return { obligations: [...store.obligations, fresh] }
  }
  const risk = RISK_RANK[fresh.risk] > RISK_RANK[existing.risk] ? fresh.risk : existing.risk
  // redundancy 合并：新声明优先，但 upsert 不撤销已有声明（同 ID 义务的
  // 冗余模式一旦启用就保持，避免重复 upsert 悄悄关闭它）。
  const redundancy = fresh.redundancy ?? existing.redundancy
  if (risk === existing.risk && redundancy === existing.redundancy) return store
  return {
    obligations: store.obligations.map(o => (o.id === existing.id ? { ...o, risk, ...(redundancy ? { redundancy } : {}) } : o)),
  }
}

// ─── 状态变换 ────────────────────────────────────────────────────

export interface AttemptInput {
  /** 本次尝试产生的新证据引用（file:line、command、probe 路径…）。无新证据则缺省。 */
  evidenceRef?: string
  /** 本次尝试的失败分类（failure-classifier 的 FailureClass 或验证域枚举）。 */
  failureClass?: string
}

/**
 * 登记一次动作尝试。升级判据（计划：失败不是重复同一动作）：
 * - 同类失败连续出现（failureClass 与 lastFailureClass 相同），或
 * - 连续两次尝试都没有带来新证据
 * → requiredAction 沿阶梯升级。
 */
export function recordAttempt(store: ObligationStore, id: string, input: AttemptInput = {}): ObligationStore {
  return mapObligation(store, id, ob => {
    if (ob.state === 'satisfied' || ob.state === 'superseded') return ob
    const attempts = ob.attempts + 1
    const evidenceRefs = input.evidenceRef && !ob.evidenceRefs.includes(input.evidenceRef)
      ? [...ob.evidenceRefs, input.evidenceRef]
      : ob.evidenceRefs
    const repeatFailure = input.failureClass !== undefined && input.failureClass === ob.lastFailureClass
    const noNewEvidence = input.evidenceRef === undefined && attempts >= 2
    const requiredAction = repeatFailure || noNewEvidence
      ? escalateAction(ob.family, ob.requiredAction)
      : ob.requiredAction
    return {
      ...ob,
      state: 'attempted',
      attempts,
      evidenceRefs,
      lastFailureClass: input.failureClass ?? ob.lastFailureClass,
      requiredAction,
    }
  })
}

/** 关闭义务。satisfied 是唯一的「证据到位」终态；blocked 义务凭真实证据仍可关闭。
 *  冗余模式（redundancy 已声明）：每次 satisfy 登记一次满足计数，达 k 才
 *  satisfied；未达保持 attempted（证据在途，不静默降级）。 */
export function satisfyObligation(store: ObligationStore, id: string, evidenceRef: string): ObligationStore {
  return mapObligation(store, id, ob => {
    if (ob.state === 'superseded') return ob
    const isNewEvidence = !ob.evidenceRefs.includes(evidenceRef)
    const evidenceRefs = isNewEvidence ? [...ob.evidenceRefs, evidenceRef] : ob.evidenceRefs
    if (!ob.redundancy) {
      return { ...ob, state: 'satisfied', evidenceRefs }
    }
    // 冗余计数按独立证据计——同一 ref 重复提交不计数，否则同一条验证命令
    // 绿两次就能满足 k=2，恰是冗余要防的单证据场景。
    const satisfyCount = (ob.satisfyCount ?? 0) + (isNewEvidence ? 1 : 0)
    if (satisfyCount >= ob.redundancy.k) {
      return { ...ob, state: 'satisfied', satisfyCount, evidenceRefs }
    }
    return { ...ob, state: 'attempted', satisfyCount, evidenceRefs }
  })
}

/** 受阻：环境/权限/依赖不可用。不是 satisfied——高风险义务受阻后主控只能
 *  诚实交付「未验证 + 具体障碍」，不能声称已证。 */
export function blockObligation(store: ObligationStore, id: string, reason: string): ObligationStore {
  return mapObligation(store, id, ob => {
    if (ob.state === 'satisfied' || ob.state === 'superseded') return ob
    return { ...ob, state: 'blocked', lastFailureClass: reason }
  })
}

/** 任务边界：上一个用户任务的未决义务全部作废（不误伤 satisfied 历史）。 */
export function supersedeOpenObligations(store: ObligationStore): ObligationStore {
  return {
    obligations: store.obligations.map(o =>
      o.state === 'open' || o.state === 'attempted' || o.state === 'blocked'
        ? { ...o, state: 'superseded' as const }
        : o,
    ),
  }
}

function mapObligation(
  store: ObligationStore,
  id: string,
  fn: (ob: EvidenceObligation) => EvidenceObligation,
): ObligationStore {
  let changed = false
  const obligations = store.obligations.map(o => {
    if (o.id !== id) return o
    const next = fn(o)
    if (next !== o) changed = true
    return next
  })
  return changed ? { obligations } : store
}

// ─── RED 语义（bugfix 义务） ─────────────────────────────────────

/** RED 证据引用前缀——bugfix 义务先 RED（目标缺陷的失败复现）再 GREEN。 */
const RED_REF_PREFIX = 'red:'

export function hasRedEvidence(ob: EvidenceObligation): boolean {
  return ob.evidenceRefs.some(r => r.startsWith(RED_REF_PREFIX))
}

/** 验证目标与义务目标是否关联：targetFiles 交集，或命令文本包含目标路径/词干。 */
function verificationMatchesTargets(meta: VerificationMetadata, targets: readonly string[]): boolean {
  if (targets.length === 0) return true // 无目标义务：任何验证都算相关（delivery 全量）
  const normalizedTargets = targets.map(t => t.replaceAll('\\', '/'))
  const metaFiles = (meta.targetFiles ?? []).map(t => t.replaceAll('\\', '/'))
  if (metaFiles.some(f => normalizedTargets.some(t => f.includes(t) || t.includes(f)))) return true
  const command = (meta.resolvedCommand ?? meta.command ?? '').replaceAll('\\', '/')
  return normalizedTargets.some(t => {
    if (command.includes(t)) return true
    const base = t.split('/').pop() ?? t
    const stem = base.replace(/\.[^.]+$/, '')
    return stem.length > 2 && command.includes(stem)
  })
}

/**
 * 把一次真实验证事件（EvidenceTracker.trackVerification 的 VerificationMetadata）
 * 归账到义务状态。规则（计划 Wave 1 波末硬门禁的三条语义）：
 *
 * - `blocked` 只记 attempted（failureClass='verification_blocked'），**不满足**
 *   RED、不关闭任何义务——「尝试过验证」≠「关闭了事实义务」。
 * - `failed` 只有当失败目标与 bugfix 义务目标关联时才算 RED（登记 red: 证据，
 *   义务仍处 attempted，等待 GREEN）；无关失败只是一次 attempt。
 * - `passed`：bugfix 需先有 RED 证据才能 GREEN→satisfied；delivery 由 full 通过
 *   或目标关联的 targeted 通过关闭；regression 由目标关联的通过关闭。
 */
export function applyVerificationEvent(store: ObligationStore, meta: VerificationMetadata): ObligationStore {
  let next = store
  for (const ob of store.obligations) {
    if (ob.state === 'satisfied' || ob.state === 'superseded') continue
    // ⚠️ `acceptance` 刻意不在此集合内，不是遗漏。它问的是「验证跑在哪个层级」，
    // 而这里的谓词是「跑没跑过」——把它加进来等于让任意一条 passed 单测关掉
    // 用户级验收义务，正是本机制要修的假绿。核销走 onAcceptance → tracker.satisfy。
    const awaitsVerification = ob.family === 'bugfix' || ob.family === 'delivery'
      || ob.family === 'regression' || ob.family === 'behavior' || ob.family === 'external_claim'
    if (!awaitsVerification) continue
    // external_claim 的核销**不绑 targets**：义务问的是「这份外部声明的结论有没有
    // 被独立验证过」，而验证证据的载体（测试结果、运行时日志、探针输出）与被质疑的
    // 文档天然不同轴——绑 targets 会造出一条永无出口的义务（2026-10-10 复核实测：
    // 跑测试时命令文本不含 doc 路径 → matches=false → 3 探针 + 3 验证后仍 attempted，
    // 义务永久悬挂在 prompt 渲染块里）。targets 仍用于义务 ID 与渲染。
    const matches = ob.family === 'external_claim' ? true : verificationMatchesTargets(meta, ob.targets)

    if (meta.status === 'blocked') {
      if (matches) next = recordAttempt(next, ob.id, { failureClass: 'verification_blocked' })
      continue
    }

    if (meta.status === 'failed') {
      if (ob.family === 'bugfix' && matches) {
        // RED 达成：目标关联的失败复现。义务不关闭——记录 red 证据等 GREEN。
        next = recordAttempt(next, ob.id, { evidenceRef: `${RED_REF_PREFIX}${meta.command}` })
      } else if (matches) {
        next = recordAttempt(next, ob.id, { failureClass: 'verification_failed' })
      }
      continue
    }

    // status === 'passed'
    if (ob.family === 'bugfix') {
      if (matches && hasRedEvidence(currentOf(next, ob.id))) {
        next = satisfyObligation(next, ob.id, `green:${meta.command}`)
      } else if (matches) {
        // GREEN without RED：通过不能证明缺陷曾存在——只记尝试，不关闭。
        next = recordAttempt(next, ob.id, { evidenceRef: `pass-without-red:${meta.command}` })
      }
    } else if (ob.family === 'delivery') {
      if (meta.scope === 'full' || matches) {
        next = satisfyObligation(next, ob.id, `verified:${meta.command}`)
      }
    } else if ((ob.family === 'regression' || ob.family === 'behavior' || ob.family === 'external_claim') && matches) {
      // behavior：「真实输出匹配断言」——目标关联的通过验证是运行时行为的
      // 实测证据（dead-end 义务也由此自然关闭：该文件验证终于转绿）。
      // external_claim：一次通过的独立验证即「外部声明已被核验」的证据——
      // 这是该家族唯一的探针外出口（探针侧 micro_probe/targeted_verification
      // 只记尝试，见 applyProbeEvent）。
      next = satisfyObligation(next, ob.id, `verified:${meta.command}`)
    }
  }
  return next
}

function currentOf(store: ObligationStore, id: string): EvidenceObligation {
  const found = store.obligations.find(o => o.id === id)
  // mapObligation 保证 id 存在；此处仅为类型收窄。
  return found!
}

// ─── 探针事件（existence / behavior / external_claim） ──────────

export interface ProbeEventInput {
  /** 执行探针的工具名（read_file / grep / bash …）。 */
  tool: string
  /** 探针目标（文件路径等）。 */
  target: string
  /** 结果是否有损（截断/摘要/hybrid 检索）。有损结果不能关闭"不存在"类断言。 */
  lossy?: boolean
  /** 证据引用（file:line 或命令）。缺省用 tool:target。 */
  evidenceRef?: string
}

/** 空 targets = 「不绑定具体目标」→ 任意探针都算相关，与 verificationMatchesTargets
 *  同向。旧实现返回 false，使空 targets 的 existence/behavior/external_claim 义务
 *  永不被探针满足——而 behavior 义务的创建点（turn-step-producer 的 review_audit /
 *  performance_diagnosis 分支）在 mentionedFiles 为空时targets 正是空。悬挂的义务
 *  每轮渲染进 prompt、并按 requiredAction 引导模型做无效动作（做了也不消解），
 *  比「一条无目标义务被任意探针闭合」更贵。目标非空时的精确匹配语义不变。 */
function probeMatchesTargets(target: string, targets: readonly string[]): boolean {
  if (targets.length === 0) return true
  const normalized = target.replaceAll('\\', '/')
  return targets.some(t => normalized.includes(t) || t.includes(normalized))
}

/** 从证据引用还原贡献过证据的工具集合（跨工具交叉验证判定）。 */
function distinctProbeTools(ob: EvidenceObligation): Set<string> {
  const tools = new Set<string>()
  for (const ref of ob.evidenceRefs) {
    const m = /^probe:([^:]+):/.exec(ref)
    if (m) tools.add(m[1]!)
  }
  return tools
}

/**
 * 把一次探针结果归账到读取类义务：
 * - 无损探针命中目标 → 关闭 read_source 阶段的 existence/behavior/external_claim 义务。
 * - 有损探针只记 attempt（升级压力）——有损搜索不能关闭"不存在"断言。
 * - cross_check 阶段需要**不同工具**再次命中同目标才关闭（独立交叉验证）。
 */
export function applyProbeEvent(store: ObligationStore, probe: ProbeEventInput): ObligationStore {
  let next = store
  const ref = probe.evidenceRef ?? `probe:${probe.tool}:${probe.target}`
  for (const ob of store.obligations) {
    if (ob.state === 'satisfied' || ob.state === 'superseded') continue
    if (ob.family !== 'existence' && ob.family !== 'behavior' && ob.family !== 'external_claim') continue
    if (!probeMatchesTargets(probe.target, ob.targets)) continue

    if (probe.lossy) {
      next = recordAttempt(next, ob.id, { failureClass: 'lossy_probe' })
      continue
    }

    if (ob.requiredAction === 'read_source') {
      next = satisfyObligation(next, ob.id, ref)
    } else if (ob.requiredAction === 'cross_check') {
      const tools = distinctProbeTools(ob)
      if (tools.size > 0 && !tools.has(probe.tool)) {
        // 第二个独立工具命中同目标 → 交叉验证成立。
        next = satisfyObligation(next, ob.id, ref)
      } else {
        next = recordAttempt(next, ob.id, { evidenceRef: `probe:${probe.tool}:${probe.target}` })
      }
    } else {
      // micro_probe / targeted_verification 等阶段：读取只是佐证，不关闭。
      next = recordAttempt(next, ob.id, { evidenceRef: ref })
    }
  }
  return next
}

// ─── final 判定 ──────────────────────────────────────────────────

export type FinalVerdict = 'allow' | 'continue_once' | 'honest_blocked'

export interface FinalEvaluation {
  verdict: FinalVerdict
  /** 高风险 open/attempted 义务（触发 continue_once 的主体）。 */
  unresolved: readonly EvidenceObligation[]
  /** 高风险 blocked 义务——允许结束，但必须在答复中披露未验证与障碍。 */
  blockedDisclosures: readonly EvidenceObligation[]
  /** verdict=continue_once 时的最短下一动作。 */
  nextAction?: { obligationId: string; action: EvidenceAction; claim: string }
}

/**
 * `evaluateFinalCandidate` 挑 `nextAction` 时的家族优先级。
 *
 * **acceptance 必须排在 delivery 之前**，理由不是"先验收后跑测试"的执行顺序
 * （这里排的不是执行顺序，delivery 被任意 passed 验证自动关闭，与排位无关），
 * 而是续轮席位的分配：`evaluateFinal` 只看 `unresolved[0]`，而 `#continuedOnce`
 * 是按义务 ID 记的 latch。排第一的那条若一直不结，第二次收尾时它仍是 `[0]`、
 * 已在 latch 里 → 直接降 honest_blocked 返回，**排在后面的义务永远拿不到
 * nextAction 席位**。delivery 本就能被任意测试自动满足，acceptance 是设计上
 * 关不掉的那条——唯一那次续轮的话语权必须归 acceptance。
 */
const FAMILY_ORDER: Record<ObligationFamily, number> = {
  bugfix: 0, regression: 1, acceptance: 2, delivery: 3,
  external_claim: 4, behavior: 5, existence: 6, environment: 7,
}

/**
 * natural-finish 候选判定。**只有 high 风险义务参与门禁**
 * （low_risk_small_edit_never_gates_final）：
 * - 高风险 open/attempted 存在 → continue_once（调用方负责"仅自动续轮一次"）。
 * - 只剩高风险 blocked → honest_blocked（允许结束，强制披露）。
 * - 其余 → allow。低/中风险义务永不阻拦 natural-finish。
 */
export function evaluateFinalCandidate(store: ObligationStore): FinalEvaluation {
  const high = store.obligations.filter(o => o.risk === 'high')
  const unresolved = high
    .filter(o => o.state === 'open' || o.state === 'attempted')
    .sort((a, b) => FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family] || (a.id < b.id ? -1 : 1))
  const blockedDisclosures = high.filter(o => o.state === 'blocked')

  if (unresolved.length > 0) {
    const first = unresolved[0]!
    return {
      verdict: 'continue_once',
      unresolved,
      blockedDisclosures,
      nextAction: { obligationId: first.id, action: first.requiredAction, claim: first.claim },
    }
  }
  if (blockedDisclosures.length > 0) {
    return { verdict: 'honest_blocked', unresolved: [], blockedDisclosures }
  }
  return { verdict: 'allow', unresolved: [], blockedDisclosures: [] }
}

// ─── 用户级验收核销 ──────────────────────────────────────────────

/**
 * acceptance 义务的核销判定（纯函数，供 AgentLoop.captureAcceptance 使用）。
 *
 * - `declared`：仍有待执行项。只留痕，义务保持未决——声明不等于执行。
 * - `missing_evidence`：标了 met 却没写做了什么。记 attempt 逼出实据，不放行。
 * - `blocked`：有受阻项且无待执行项 → honest_blocked，交付时强制披露。
 * - `met`：全部达标且都有据 → 关闭义务。
 */
export type AcceptanceOutcome =
  | { kind: 'declared' }
  | { kind: 'missing_evidence' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'met'; evidenceRef: string }

export function decideAcceptanceOutcome(
  items: readonly import('../tools/types.js').AcceptanceItemInput[],
): AcceptanceOutcome | null {
  if (items.length === 0) return null
  if (items.some(i => i.status === 'pending')) return { kind: 'declared' }
  if (items.some(i => i.status === 'met' && !i.evidence?.trim())) return { kind: 'missing_evidence' }

  const blocked = items.filter(i => i.status === 'blocked')
  if (blocked.length > 0) {
    return {
      kind: 'blocked',
      reason: `用户级验收受阻：${blocked.map(b => b.evidence?.trim() || b.criterion).join('；')}`,
    }
  }
  return { kind: 'met', evidenceRef: `acceptance:${items.map(i => i.evidence!.trim()).join('；')}` }
}

// ─── 缓存稳定投影 ────────────────────────────────────────────────

/**
 * 面向 cognitive projection / control plane 的紧凑摘要。字节稳定契约：
 * 状态不变时输出完全相同——稳定排序、固定枚举、无时间戳/随机 ID/自由文本
 * （claim 本身是归一化后的稳定文本，同一义务恒同）。
 */
export function renderObligationBlock(store: ObligationStore): string {
  const active = store.obligations
    .filter(o => o.state === 'open' || o.state === 'attempted' || o.state === 'blocked')
    .sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk] || FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family] || (a.id < b.id ? -1 : 1))
  if (active.length === 0) return ''
  const lines = active.map(o =>
    `- [${o.risk}/${o.state}] ${o.family}: ${o.claim} → next=${o.requiredAction}`,
  )
  return `<evidence-obligation count="${active.length}">\n${lines.join('\n')}\n</evidence-obligation>`
}
