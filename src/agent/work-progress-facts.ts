/**
 * WorkProgressFacts — 共享工作事实（《收敛阶段补修》§3 P0）。
 *
 * 单一职责：在唯一装配点（每 modelTurn 感知前 beginModelTurn）消费一次
 * 去重后的工作事实，冻结成不可变快照，供感知 / 收敛 / 核销 / 工作阶段
 * 读取同一份。迁移自 CourseEpisodes.collect 的进展去重事实——保留核销、
 * probation 的既有政策，不复制第二套 Todo/义务/失败转通过判据。
 *
 * 事实契约（P0 最小集）：
 * - taskEpoch：人类任务边界号（唯一递增点 recordHumanTaskBoundary；SessionJobs
 *   经 setTaskEpochProvider 读同一边界，登记验证元数据时盖 ownerTaskEpoch 章）。
 * - mutationRevision / lastMutationSequence：当前任务已确认真实文件变化
 *   （WRITE_TOOL_NAMES 全族经 course-file-progress 三态判定，成功且实际变化
 *   才登记；同一执行事件仅登记一次——序号去重）。
 * - progressRevision / lastMeaningfulProgressModelTurn / lastProgressReason：
 *   真实进展（真实文件变化、新完成 Todo、新满足义务、可靠失败转通过；不含读取、轮询、
 *   普通成功工具返回、重复通过或相位转换）。
 * - verificationExecutions：验证执行启动事实（原始命令未截断时；启动绑定
 *   启动时的 taskEpoch/mutationRevision——迟到结果不能把后续编辑版本重新
 *   送回 verify/deliver）。结算消费同一证据记录回调，不另猜输出或改变通过判据。
 *
 * 未知事实不冒充进展：缺失判断为 unknown，不推进任何 revision。
 */
import type { AgentLoop } from './loop.js'
import type { VerificationMetadata } from '../tools/types.js'
import type { VerificationExecutionIntent } from './verification-intent.js'
import type { FileProgressFact } from './course-file-progress.js'
import { resolve } from 'node:path'
import { detectExplicitNoMutation } from './discipline-eligibility.js'
import { deriveEditExpectation } from './edit-expectation.js'
import type { IntentTaskKind } from './intent-retrieval-route.js'

/** 验证执行启动事实（章为启动时刻值）。 */
export interface VerificationExecutionStart {
  /** 共享执行序号（与文件进展共用单调计数——两者相对先后可比）。 */
  sequence: number
  purpose: VerificationExecutionIntent['purpose']
  life: VerificationExecutionIntent['lifetime']
  /** 有限性投影：lifetime === 'finite'。watch/unknown 不获得有限验证等待资格。 */
  finite: boolean
  waitingEligible: boolean
  /** 规范化目标（供重复验证身份对齐；不落 argv/正文）。 */
  scope: VerificationExecutionIntent['scope']
  cwd?: string
  /** Missing completion facts stay unknown, including legacy replay records. */
  settled?: boolean
  obligationKey?: string
  taskEpochAtStart: number
  mutationRevisionAtStart: number
  /** 启动时的 modelTurn（验证步骤时效窗口/重复判据对齐用；null = 未观测）。 */
  modelTurnAtStart: number | null
  at: number
}

  /** 每 modelTurn 一次的不可变快照（消费方只读）。 */
export interface WorkFactSnapshot {
  modelObservationTurn: number
  taskEpoch: number
  /** 当前任务边界的起始 modelTurn（无进展记录时的"任务年龄"起点；P1 重复
   *  验证判据与 P3 计时共用）。 */
  taskStartModelTurn: number
  mutationRevision: number
  lastMutationSequence: number
  progressRevision: number
  lastProgressReason: string | null
  lastMeaningfulProgressModelTurn: number
  /** SessionJobs 当前任务、额度内 running 验证投影（离开 running/过期即消失）。 */
  waitingVerification: {
    jobId: string
    purpose: string
    lifetime: string
    ownerTaskEpoch: number
    waitUntil: number
    budgetSource: string
  } | null
  latestVerificationExecution: VerificationExecutionStart | null
  lastToolExecutionSequence?: number
}

/** 验证执行事实保留窗口（内部观测/近因消费足够；不随证据账本）。 */
const EXECUTION_KEEP = 20

export class WorkProgressFacts {
  /** 人类任务边界号（权威源）。 */
  private taskEpochCounter = 0
  /** 已确认真实文件变化计数 / 最近一次的执行序号。 */
  private mutationRev = 0
  private lastMutationSeq = -1
  /** 真实进展计数 / 最近一次有意义进展的 modelTurn / 最近原因。 */
  private progressRev = 0
  private lastProgressTurn = -1
  private lastProgressReason: string | null = null
  /** 共享执行序号（file progress 与验证启动共用）。 */
  private executionSeq = 0
  private lastToolExecutionSeq = -1
  /** 验证执行启动事实（有界）。 */
  private verificationExecutions: VerificationExecutionStart[] = []
  /** 进展去重集合（迁自 CourseEpisodes；核销/probation 政策不变）。 */
  private todos = new Set<string>()
  private satisfied = new Set<string>()
  private verifications = new WeakSet<VerificationMetadata>()
  private failed = new Set<string>()
  private initialized = false
  private frozen: WorkFactSnapshot | null = null
  /** 当前任务边界的起始 modelTurn（recordHumanTaskBoundary 时记）。 */
  private taskStartTurn = 0
  private humanConstraint: 'read-only' | 'mutation-allowed' | 'unspecified' | null = null
  constructor(private self: AgentLoop) {}

  get taskEpoch(): number { return this.taskEpochCounter }
  get mutationRevision(): number { return this.mutationRev }
  get progressRevision(): number { return this.progressRev }
  get lastMutationSequence(): number { return this.lastMutationSeq }
  get taskStartModelTurn(): number { return this.taskStartTurn }
  get explicitNoMutation(): boolean | undefined { return this.humanConstraint === null ? undefined : this.humanConstraint === 'read-only' }
  get explicitMutationAllowed(): boolean { return this.humanConstraint === 'mutation-allowed' }

  editExpectation(taskKinds: readonly IntentTaskKind[], legacyInput: string) {
    const snapshot = this.currentSnapshot()
    return deriveEditExpectation({ taskKinds, explicitNoMutation: this.explicitNoMutation ?? detectExplicitNoMutation(legacyInput),
      explicitMutationAllowed: this.explicitMutationAllowed, executions: this.recentVerificationExecutions(),
      taskEpoch: snapshot?.taskEpoch ?? this.taskEpoch, lastMutationSequence: snapshot?.lastMutationSequence ?? this.lastMutationSequence,
      modelObservationTurn: snapshot?.modelObservationTurn ?? this.self.modelObservationTurn ?? 0,
    })
  }

  /** Only callers accepting a trusted human task/guidance envelope may update. */
  acceptHumanConstraints(text: string, reset = false): void {
    if (reset) this.humanConstraint = 'unspecified'
    if (detectExplicitNoMutation(text)) this.humanConstraint = 'read-only'
    else if (/(?:现在|接下来|本轮)(?:可以|允许|开始)(?:直接)?(?:修改|编辑|修复)|(?:开始|按顺序|动手)(?:实施|修改|修复)|\b(?:you may|please)\s+(?:edit|modify|implement|fix)\b/i.test(text)) {
      this.humanConstraint = 'mutation-allowed'
    }
  }

  /** 唯一的人类任务边界递增点（已接收的 human-task；同任务 followUp/引导/
   *  自动继续/压缩/普通新 run 不清空、不递增——递增由 human-input-boundary
   *  的 task 分支驱动）。清空去重集合后重新基线化：新任务从干净的事实面
   *  开始，存量（旧任务遗留的完成态）不再产生进展。 */
  recordHumanTaskBoundary(): void {
    this.taskEpochCounter++
    this.humanConstraint = 'unspecified'
    this.taskStartTurn = this.self.modelObservationTurn ?? this.frozen?.modelObservationTurn ?? this.taskStartTurn
    this.lastProgressTurn = -1
    this.lastProgressReason = null
    this.todos.clear()
    this.satisfied.clear()
    this.failed.clear()
    this.collect(false)
    this.initialized = true
  }

  /** 文件进展消费（course-file-progress 三态结果）：changed 才登记版本及进展时间；
   *  unchanged/unknown 不推进（unknown 不伪装无变化也不记功）。返回是否
   *  changed（调用方据此维护既有 episode 政策）。 */
  recordFileProgress(fact: { outcome: FileProgressFact['outcome']; targets?: string[] }): boolean {
    const sequence = ++this.executionSeq
    if (fact.outcome !== 'changed') return false
    this.mutationRev++
    this.lastMutationSeq = sequence
    this.progressRev++
    this.lastProgressReason = 'progress:file-change'
    this.lastProgressTurn = this.self.modelObservationTurn ?? this.frozen?.modelObservationTurn ?? this.taskStartTurn
    return true
  }

  /** 验证执行启动登记（执行前调用；章为启动时刻值）。 */
  recordToolExecutionStart(): void { this.lastToolExecutionSeq = ++this.executionSeq }

  recordVerificationExecutionStart(intent: VerificationExecutionIntent): number {
    const entry: VerificationExecutionStart = {
      sequence: ++this.executionSeq,
      purpose: intent.purpose,
      life: intent.lifetime,
      finite: intent.lifetime === 'finite',
      waitingEligible: intent.waitingEligible,
      scope: intent.scope ? { ...intent.scope, targetFiles: intent.scope.targetFiles?.map(path => resolve(intent.cwd, path)).sort() } : null,
      cwd: resolve(intent.cwd),
      settled: false,
      obligationKey: JSON.stringify(this.self.obligations.getStore().obligations.map(ob => ob.id).sort()),
      taskEpochAtStart: this.taskEpochCounter,
      mutationRevisionAtStart: this.mutationRev,
      modelTurnAtStart: this.self.modelObservationTurn ?? null,
      at: Date.now(),
    }
    this.verificationExecutions.push(entry)
    this.lastToolExecutionSeq = entry.sequence
    if (this.verificationExecutions.length > EXECUTION_KEEP) this.verificationExecutions.shift()
    return entry.sequence
  }

  recordVerificationExecutionSettled(sequence: number, result: VerificationMetadata): void {
    const entry = this.verificationExecutions.find(e => e.sequence === sequence)
    if (!entry || entry.settled) return
    if (!result.stale && result.scope !== 'unknown' && ['passed', 'failed'].includes(result.status)
        && !['timeout', 'tool_invocation_failure'].includes(result.failureKind ?? '')
        && (result.kind !== 'test' || result.countsReliable === true)) {
      entry.settled = true
    }
  }

  /** 每 modelTurn 一次（感知前）：消费去重事实一次并冻结快照。
   *  首次调用（无 human-task 边界时）先基线化——存量吞入、不产进展。 */
  beginModelTurn(modelObservationTurn: number): void {
    if (!this.initialized) {
      this.collect(false)
      this.initialized = true
    }
    const progress = this.collect(true)
    if (progress) {
      this.progressRev++
      this.lastProgressReason = progress
      this.lastProgressTurn = modelObservationTurn
    }
    this.frozen = {
      modelObservationTurn,
      taskEpoch: this.taskEpochCounter,
      taskStartModelTurn: this.taskStartTurn,
      mutationRevision: this.mutationRev,
      lastMutationSequence: this.lastMutationSeq,
      progressRevision: this.progressRev,
      lastProgressReason: this.lastProgressReason,
      lastMeaningfulProgressModelTurn: this.lastProgressTurn,
      waitingVerification: this.self.jobs?.verificationWaitInfo?.() ?? null,
      latestVerificationExecution: this.verificationExecutions.at(-1) ? { ...this.verificationExecutions.at(-1)! } : null,
      lastToolExecutionSequence: this.lastToolExecutionSeq,
    }
  }

  /** 当前冻结快照（未装配时 null——历史恢复缺事实不伪造）。 */
  currentSnapshot(): WorkFactSnapshot | null { return this.frozen }

  /** 验证执行事实的只读视图（近因窗口）。 */
  recentVerificationExecutions(): ReadonlyArray<VerificationExecutionStart> {
    return this.verificationExecutions
  }

  /**
   * 进展去重消费（原 CourseEpisodes.collect 逐字迁移）：
   * - 新完成 Todo / 新满足义务 → 进展（allowProgress 时）；
   * - 验证记录一次性消费：failed（非 stale、非 timeout/invocation）入失败集；
   *   passed 且可靠且同 key 失败被清 → 失败转通过 = 进展。
   * 返回本条消费发现的原因（后发现的来源覆盖先发现——与原实现循环顺序一致）。
   */
  private collect(allowProgress: boolean): string | null {
    let progress: string | null = null
    for (const todo of this.self.config.getTodos?.() ?? []) {
      if (todo.status !== 'completed' || this.todos.has(todo.id)) continue
      this.todos.add(todo.id); progress = 'progress:todo-completed'
    }
    for (const ob of this.self.obligations.getStore().obligations) {
      if (ob.state !== 'satisfied' || this.satisfied.has(ob.id)) continue
      this.satisfied.add(ob.id); progress = 'progress:obligation-satisfied'
    }
    for (const v of this.self.evidence.getState().verifications) {
      if (this.verifications.has(v)) continue
      this.verifications.add(v)
      if (!allowProgress) continue
      const key = JSON.stringify([v.resolvedCommand ?? v.command, v.kind, v.scope, [...(v.targetFiles ?? [])].sort(), v.snapshotRef, v.workspaceFingerprint])
      if (v.status === 'failed' && !v.stale && !['timeout', 'tool_invocation_failure'].includes(v.failureKind ?? '')) this.failed.add(key)
      if (v.status === 'passed' && !v.stale && v.scope !== 'unknown' && v.exitCode === 0 && (v.kind === 'test' ? v.countsReliable === true : v.countsReliable !== false) && this.failed.delete(key)) progress = 'progress:verification-passed'
    }
    return allowProgress ? progress : null
  }
}

/**
 * P1 重复验证软判据的预计算摘要（纯函数；detector 侧只消费摘要，保持纯函数）。
 *
 * 身份 = purpose + cwd/targets + kind/scope + 义务集合；不用 job id、输出文件名、时间戳
 * 或任意命令正文变化充当新义务。identity 不可确认（scope 缺失）→ 返回 undefined，
 * 软判据不启动（未知不冒充）。
 */
export interface RepeatedVerificationSignal {
  /** 同一身份、同一工作版本已可靠结算的有限验证执行数（≥2 才构成"重复"）。 */
  count: number
  /** 当前动作仍为本轮/上一轮的该验证，且晚于最后一次真实写入。 */
  currentRerun: boolean
  /** 自最后实质进展（无记录时为任务起点）起经过的 modelTurn 数。 */
  turnsSinceProgress: number
}

export function computeRepeatedVerificationSignal(input: {
  executions: ReadonlyArray<VerificationExecutionStart>
  taskEpoch: number
  /** 当前任务最近一次真实写入的序号（-1 = 无写入）。 */
  lastMutationSequence: number
  modelObservationTurn: number
  lastMeaningfulProgressModelTurn: number
  taskStartModelTurn: number
  lastToolExecutionSequence?: number
}): RepeatedVerificationSignal | undefined {
  const scoped = input.executions.filter(e => e.taskEpochAtStart === input.taskEpoch && e.finite)
  const latest = scoped.at(-1)
  if (!latest?.cwd || latest.obligationKey === undefined || !latest.scope || latest.scope.scope === 'unknown'
      || latest.scope.scope === 'targeted' && !latest.scope.targetFiles?.length) return undefined
  const key = (e: VerificationExecutionStart) => JSON.stringify([e.purpose, e.obligationKey, e.cwd && resolve(e.cwd), e.scope?.scope,
    e.scope?.kind, [...new Set(e.scope?.targetFiles?.map(path => resolve(e.cwd ?? '', path)) ?? [])].sort()])
  const latestKey = key(latest)
  // 同身份且同工作版本（以最新一次的启动版本为基准）：版本变化后的重跑是
  // 新证据，"新满足的可靠覆盖由现有证据门提供"，不在此计。
  const count = scoped.filter(e => e.settled === true && key(e) === latestKey && e.mutationRevisionAtStart === latest.mutationRevisionAtStart).length
  // At the next model boundary, the immediately preceding action may have just
  // finished. A subsequent non-verification action or idle turn disarms it.
  const currentRerun = latest.sequence > input.lastMutationSequence
    && latest.sequence === input.lastToolExecutionSequence
    && latest.modelTurnAtStart !== null && input.modelObservationTurn - latest.modelTurnAtStart <= 1
  const progressBase = Math.max(input.lastMeaningfulProgressModelTurn, input.taskStartModelTurn)
  return {
    count,
    currentRerun,
    turnsSinceProgress: Math.max(0, input.modelObservationTurn - progressBase),
  }
}
