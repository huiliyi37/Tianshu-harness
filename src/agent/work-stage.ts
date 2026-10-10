/**
 * WorkStage — 会话级工作相位确认器（《收敛阶段补修》§5 P2）。
 *
 * 单一职责：在感知生成原始候选（Sensorium/StarPhase 弱候选）之后、事件发射 /
 * prompt 相位提示 / 收敛评分消费之前，确认出一个稳定的 committedPhase——
 * 三者读同一确认结果，原始候选仅用于内部观测（不再出现「UI 看 verify、评分仍用
 * execute」的错位）。
 *
 * 转换纪律（计划 §5 转换表，逐行实现）：
 * - 强事实即时转换：明确 plan 进入事件、当前版本的有限验证启动（execute→verify，
 *   验证启动是活动不是通过证明）、验证/交付后的新真实写入（→execute，版本去重）、
 *   交付就绪（→deliver）、新 human-task（重置）。
 * - 弱感知候选需要两个不同 modelTurn 一致才可转换（重复采样不算两轮）；中途
 *   不一致重置候选计数。没有强事实的退回（execute/verify/deliver→plan/explore；
 *   verify→execute；deliver 的任何弱转换）一律拒绝，不刷新阶段计时。
 * - 首次（新实例/新任务）尚无强事实时，第一次弱候选保守初始化一次，标记
 *   provisional——不凭初始化证明编辑/验证，也不获等待豁免（等待保护只来自
 *   SessionJobs）。
 * - 未知不冒充：快照缺失（历史恢复）不转换也不初始化；editExpectation=not-required
 *   （显式只读/审查类）时写入不驱动 execute（约束与意外写入冲突留观测，不靠相位
 *   切换消掉约束）；写入效果未知（unknown）不推进版本，不触发任何转换。
 *
 * 任务寿命：实例由 AgentLoop 持有；内部状态按 taskEpoch 边界自行重置——
 * 同任务 followUp/引导/自动继续/压缩/普通新 run 不清空（perception.reset 只清
 * Sensorium 采样，不倒这个状态器）。
 */
import type { PhaseClass } from './phase-class.js'
import type { StarPhase } from './star-event.js'
import type { WorkFactSnapshot, VerificationExecutionStart } from './work-progress-facts.js'
import type { EditExpectation } from './edit-expectation.js'

/** committedPhase → 代表 StarPhase：UI 事件与感知返回事件消费同一确认结果。 */
export const STAR_PHASE_FOR_CLASS: Record<PhaseClass, StarPhase> = {
  explore: 'tianxuan-locating',
  plan: 'tianshu-planning',
  execute: 'yuheng-implementing',
  verify: 'kaiyang-testing',
  deliver: 'yaoguang-delivering',
}

export type WorkStageCandidateSource = 'sensorium' | 'verification-activity'

export interface WorkStageCandidate {
  value: PhaseClass
  /** 连续一致的不同 modelTurn 数（同轮重复采样不累计）。 */
  turns: number
  lastModelTurn: number
  source: WorkStageCandidateSource
}

export interface WorkStageState {
  /** 对齐的任务边界（-1 = 尚未对齐；变化即重置任务内状态）。 */
  taskEpoch: number
  committedPhase: PhaseClass | null
  candidate: WorkStageCandidate | null
  /** 进入当前 committedPhase 的 modelTurn（P3 计时消费；只随确认切换更新）。 */
  enteredModelTurn: number
  /** 阶段片段号（确认切换/任务重置时递增；P3 regimeKey 与观测消费）。 */
  stageEpoch: number
  /** 当前阶段是否来自首次弱候选保守初始化（仅初始化一次）。 */
  provisional: boolean
  /** 本任务内是否已初始化过（provisional 仅一次；新任务重置为 false）。 */
  initialized: boolean
  /** 已消费的工作版本（写入→execute 的版本去重依据）。 */
  consumedMutationRevision: number
  /** 进入 verify 时绑定的验证启动版本（观测/回放消费；重复启动不重置）。 */
  verifyStart: { sequence: number; mutationRevision: number } | null
}

export function createWorkStageState(): WorkStageState {
  return {
    taskEpoch: -1,
    committedPhase: null,
    candidate: null,
    enteredModelTurn: 0,
    stageEpoch: 0,
    provisional: false,
    initialized: false,
    consumedMutationRevision: 0,
    verifyStart: null,
  }
}

export interface WorkStageConfirmInput {
  modelObservationTurn: number
  /** 每 modelTurn 不可变事实快照（P0）；null = 未装配（历史恢复缺事实——不转换）。 */
  snapshot: WorkFactSnapshot | null
  /** 验证执行启动事实（P0，近因窗口）；按 taskEpochAtStart 筛当前任务。 */
  verificationExecutions: ReadonlyArray<VerificationExecutionStart>
  /** 原始感知候选（StarPhase→PhaseClass 映射；unmapped 回退 explore 由调用方处理）。 */
  rawCandidate: PhaseClass
  candidateSource: WorkStageCandidateSource
  /** 交付资格（evidence.deliveryReady()：最近验证 passed 且绿后零编辑）。 */
  deliveryReady: boolean
  /** 编辑期待投影（P1）；缺席按 required（旧行为——对齐 detector 缺省）。 */
  editExpectation?: EditExpectation
  /** 自上次确认以来发生了解明确进入/重新进入 plan 的结构化事件（enterPlanMode）。 */
  planEntry?: boolean
}

export type WorkStageTransition = 'initialized' | 'switched' | 'held' | 'no-fact'

export interface WorkStageDecision {
  committedPhase: PhaseClass | null
  transition: WorkStageTransition
  provisional: boolean
  /** 内部观测用判据（不进 prompt；供断言/遥测）。 */
  reason: string
}

/** 弱候选方向判定：false = 拒绝（无强事实的退回/需编辑期待的进入）。 */
function weakTransitionAllowed(committed: PhaseClass, target: PhaseClass, allowExecute: boolean): boolean {
  // deliver：只能被强事实改变（新写入→execute、plan 事件、新任务）。
  if (committed === 'deliver') return false
  if (committed === 'verify') {
    if (target === 'execute') return false // 需"验证开始之后的新真实写入"（强事实）
    if (target === 'explore' || target === 'plan') return false // 退回需 plan 进入事件等强事实
    return true // deliver（交付资格弱候选路径）
  }
  if (committed === 'execute') {
    if (target === 'explore' || target === 'plan') return false // 退回计划需明确 plan 进入事件
    return true // verify / deliver
  }
  // explore / plan：顺向进入 execute 要求编辑期待不为 not-required
  // （报告型/只读类/明确只读任务不因感知候选被驱入 execute；unknown 不锁死）。
  if (target === 'execute') return allowExecute
  return true
}

/**
 * 纯 reducer：输入事实 → 下一状态与决策。无 IO、无时钟（modelTurn 由调用方注入）。
 *
 * 求值顺序（首个命中决定）：
 * ⓪ 任务边界重置 → ① plan 进入事件 → ② verify/deliver 后的新真实写入
 * → ③ 交付就绪 → ④ execute/null 下的当前版本验证启动 → ⑤ 弱候选（两轮一致）
 * / 首次 provisional 初始化 → ⑥ 保持。
 */
export function confirmWorkStage(
  state: WorkStageState,
  input: WorkStageConfirmInput,
): { state: WorkStageState; decision: WorkStageDecision } {
  const prevCommitted = state.committedPhase

  // ⓪ 历史恢复/未装配：缺任务与版本事实 → 不转换、不初始化（恢复后的实际事件才建立状态）。
  if (input.snapshot === null) {
    return { state, decision: { committedPhase: state.committedPhase, transition: 'no-fact', provisional: state.provisional, reason: 'no-fact-snapshot' } }
  }
  const snapshot = input.snapshot
  const modelTurn = input.modelObservationTurn

  let s = state
  let reset = false
  if (s.taskEpoch !== snapshot.taskEpoch) {
    // 明确的新任务：清候选与当前任务阶段状态；存量版本吞入（不冒充新进展），
    // 再按新任务的强事实/弱候选重新初始化（SessionJobs 的原归属保护另行同步）。
    s = {
      ...createWorkStageState(),
      taskEpoch: snapshot.taskEpoch,
      stageEpoch: s.stageEpoch + 1,
      enteredModelTurn: modelTurn,
      consumedMutationRevision: snapshot.mutationRevision,
    }
    reset = true
  }

  const currentTaskExecs = input.verificationExecutions.filter(e => e.taskEpochAtStart === snapshot.taskEpoch)
  const latestFinite = [...currentTaskExecs].reverse().find(e => e.finite) ?? null
  // "关联当前版本"：验证启动晚于最后写入、且启动时版本 == 当前版本（迟到旧验证不能覆盖新阶段）。
  const verificationNewerThanWrite = latestFinite !== null
    && latestFinite.sequence > snapshot.lastMutationSequence
    && latestFinite.mutationRevisionAtStart === snapshot.mutationRevision
  const revAdvanced = snapshot.mutationRevision > s.consumedMutationRevision
  const editKind = input.editExpectation?.kind ?? 'required'
  const explicitNoMutation = input.editExpectation?.source === 'explicit-no-mutation'
  const allowExecute = editKind !== 'not-required'

  let committed = s.committedPhase
  let transition: WorkStageTransition = 'held'
  let reason = reset ? 'task-boundary-reset' : 'held'
  let committedNow = false

  const commit = (phase: PhaseClass, opts?: { provisional?: boolean; reason?: string }) => {
    s = {
      ...s,
      committedPhase: phase,
      candidate: null,
      enteredModelTurn: modelTurn,
      stageEpoch: s.stageEpoch + 1,
      provisional: opts?.provisional ?? false,
      initialized: true,
      consumedMutationRevision: snapshot.mutationRevision,
      verifyStart: phase === 'verify' && latestFinite
        ? { sequence: latestFinite.sequence, mutationRevision: latestFinite.mutationRevisionAtStart }
        : null,
    }
    committed = phase
    committedNow = true
    reason = opts?.reason ?? `switch-to-${phase}`
  }

  // ① 明确进入/重新进入 plan 的结构化事件（用户显式动作优先于一切自动事实；不视作工程进展）。
  if (input.planEntry) {
    commit('plan', { reason: 'plan-entered' })
  }
  // ② verify/deliver 后的新真实写入 → 离开（版本去重：consumedMutationRevision）。
  //    同轮"写入 + 新版本验证"直接落 verify（无中间 execute 闪现）。
  //    explicit-no-mutation：明确只读约束与意外写入冲突 → 留冲突观测，不靠相位切换消掉约束。
  else if ((s.committedPhase === 'verify' || s.committedPhase === 'deliver') && revAdvanced && !explicitNoMutation) {
    if (verificationNewerThanWrite) {
      if (s.committedPhase !== 'verify') commit('verify', { reason: 'write-with-new-verification' })
      // 已在 verify：保持（同轮写+测不重开阶段计时）。
    } else {
      commit('execute', { reason: s.committedPhase === 'deliver' ? 'new-change-after-deliver' : 'write-after-verify' })
    }
  }
  // ③ 交付就绪（沿用既有交付资格进入 deliver；绿后零编辑被新写入打破时 deliveryReady 已为 false）。
  if (!committedNow && input.deliveryReady && s.committedPhase !== 'deliver') {
    commit('deliver', { reason: 'delivery-ready' })
  }
  // ④ execute/未初始化下的当前版本有限验证启动 → verify 即时（验证启动是活动，不是通过证明）。
  //    已在 verify 的重复启动不重置（不进入本分支）。
  if (!committedNow && (s.committedPhase === 'execute' || s.committedPhase === null) && verificationNewerThanWrite) {
    commit('verify', { reason: 'verification-started' })
  }
  // ⑤ 弱候选：两轮一致才提交；首次（本任务内）保守初始化一次。
  if (!committedNow) {
    if (s.committedPhase === null) {
      if (!s.initialized) {
        commit(input.rawCandidate, { provisional: true, reason: 'provisional-init' })
      } else {
        reason = 'held-null-after-init'
      }
    } else {
      // 候选计数：同值且换了 modelTurn 才累计；换值即重置；同轮重复采样不计。
      let cand = s.candidate
      if (cand && cand.value === input.rawCandidate) {
        if (cand.lastModelTurn !== modelTurn) {
          cand = { ...cand, turns: cand.turns + 1, lastModelTurn: modelTurn, source: input.candidateSource }
        }
      } else {
        cand = { value: input.rawCandidate, turns: 1, lastModelTurn: modelTurn, source: input.candidateSource }
      }
      if (cand.value === s.committedPhase) {
        cand = null // 与已确认阶段一致——清理
      } else if (cand.turns >= 2) {
        if (weakTransitionAllowed(s.committedPhase, cand.value, allowExecute)) {
          commit(cand.value, { reason: `weak-candidate-${cand.value}` })
        } else {
          // 拒绝：保留候选计数（阶段计时绝不刷新）；退回/编辑期待不满足。
          reason = cand.value === 'execute' && !allowExecute
            ? 'weak-denied-edit-expectation'
            : 'weak-denied-rewind'
        }
      } else {
        reason = 'candidate-waiting'
      }
      if (!committedNow) s = { ...s, candidate: cand }
    }
  }

  // transition 语义：本轮确认对 committed 的净效果。
  if (committedNow) {
    transition = (prevCommitted === null || reset) ? 'initialized' : 'switched'
  } else if (reset) {
    transition = 'held'
  }

  return {
    state: s,
    decision: { committedPhase: committed, transition, provisional: s.provisional, reason },
  }
}

/**
 * 会话级状态器（薄包装）：AgentLoop 持有；recordPlanEntry 由 enterPlanMode 注入，
 * confirm 由感知确认点每 modelTurn 调用一次。
 */
export class WorkStage {
  private state = createWorkStageState()
  private pendingPlanEntry = false
  /** P3：最近一次确认的决策与来源——遥测/帧观测投影，不参与转换逻辑。 */
  private lastConfirm: { decision: WorkStageDecision; source: WorkStageCandidateSource } | null = null

  /** 明确进入/重新进入 plan 的结构化事件（enterPlanMode 调用点）。 */
  recordPlanEntry(): void {
    this.pendingPlanEntry = true
  }

  confirm(input: Omit<WorkStageConfirmInput, 'planEntry'>): WorkStageDecision {
    const result = confirmWorkStage(this.state, { ...input, planEntry: this.pendingPlanEntry })
    this.state = result.state
    this.pendingPlanEntry = false
    this.lastConfirm = { decision: result.decision, source: input.candidateSource }
    return result.decision
  }

  /** P3：最近确认的决策与来源（观测投影；从未确认时为 null——不伪造）。 */
  getLastConfirm(): Readonly<{ decision: WorkStageDecision; source: WorkStageCandidateSource }> | null {
    return this.lastConfirm
  }

  /** 只读状态（观测/P3 计时/测试断言）。 */
  getState(): Readonly<WorkStageState> {
    return this.state
  }

  get committedPhase(): PhaseClass | null {
    return this.state.committedPhase
  }
}
