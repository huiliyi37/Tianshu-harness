import { recentVerification } from './verification-activity.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { EvidenceState } from './evidence.js'
import type { PredictionAccumulator } from './prediction-error.js'
import type { RuntimeHookPipeline, RuntimeHookSnapshot } from './runtime-hooks.js'
import { createRuntimeHookContext } from './runtime-hooks.js'
import type { Sensorium, SensoriumInput, StrategyProfile } from './sensorium.js'
import { adaptThetaInterval, buildStarPhaseContext, buildTelemetrySnapshot } from './perception.js'
import type { ThetaTelemetrySnapshot } from './perception.js'
import { createStarEvent } from './star-event.js'
import { PHASE_GLYPHS, PHASE_LABELS } from './star-event.js'
import { PHASE_CLASS_MAP } from './phase-class.js'
import { STAR_PHASE_FOR_CLASS, WorkStage, type WorkStageCandidateSource } from './work-stage.js'
import type { WorkFactSnapshot, VerificationExecutionStart } from './work-progress-facts.js'
import type { EditExpectation } from './edit-expectation.js'
import { routeRoutineEffort } from './effort-routing.js'
import type { StarEvent, ThetaState } from './star-event.js'
import type { VigorState } from './vigor.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import type { SensoriumEntry } from './retrospect.js'
import { getDoomLoopLevel, type TraceStore } from './trace-store.js'

export interface TurnPerceptionDeps {
  cwd: string
  maxTurns: number
  runtimeHooks: RuntimeHookPipeline
  telemetryWriter: TelemetryWriter
  getRuntimeSnapshot(extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot
  getProviderDegradationRatio(): number
  addUserMessage(message: string): void
  requestThetaCheck(reason: string): void
  setReasoningEffort(effort: StrategyProfile['reasoningEffort']): void
  getFingerprint(): PrefixFingerprint
  /** Wave 2 控制面：hook 结构化事实上报出口（shadow 记账，不改 prompt）。 */
  submitControlSignal?(signal: import('./control-plane.js').ControlSignal): void
  /** P2 工作相位确认器（AgentLoop 持有，任务寿命管理）；测试/旧路径缺省时自建实例。 */
  workStage?: WorkStage
}

export interface PerceptionInput {
  modelTurn?: number
  turn: number
  estimatedTokens: number
  pressureResult: PressureResult
  evidenceState: EvidenceState
  /** 交付就绪（EvidenceTracker.deliveryReady()）：最近验证 passed 且绿后零编辑。
   *  缺省回退 deliveryStatus==='verified'（手工构造输入的测试路径）。 */
  deliveryReady?: boolean
  predictionAccumulator: PredictionAccumulator
  recentToolHistory: ToolHistoryEntry[]
  loadedPheromones: Pheromone[]
  traceStore: TraceStore
  gitChangeRate: number
  fsEventRate?: number
  sensorium: Sensorium | null
  strategy: StrategyProfile | null
  vigor: VigorState
  thetaState: ThetaState
  thetaTelemetry: Omit<ThetaTelemetrySnapshot, 'inFlight'>
  thetaCheckInFlight: boolean
  baselineFingerprint: PrefixFingerprint | null
  /** v3：当前轮收敛评分 (ConvergenceResult.score, 0-1)，null 表示无收敛数据 */
  convergenceScore?: number | null
  /** P2：每 modelTurn 不可变事实快照（感知前装配）；null/缺省 = 未装配（不确认、不伪造）。 */
  workFactSnapshot?: WorkFactSnapshot | null
  /** P2：验证执行启动事实（近因窗口；按 taskEpochAtStart 筛当前任务）。 */
  verificationExecutions?: ReadonlyArray<VerificationExecutionStart>
  /** P2：编辑期待投影（弱候选进入 execute 的守卫；缺席按 required）。 */
  editExpectation?: EditExpectation
}

export interface PerceptionResult {
  sensorium: Sensorium
  strategy: StrategyProfile
  vigor: VigorState
  thetaState: ThetaState
  event: StarEvent
  sensoriumInput: SensoriumInput
}

const MAX_SNAPSHOTS = 100

export class TurnPerceptionController {
  private sensoriumSnapshots: SensoriumEntry[] = []
  private hasEnteredHighComplexity = false
  /** 原始候选相位记忆（仅内部观测/previousPhase 门；不对外发射）。 */
  private currentPhase = 'unknown'
  /** elmDue 冷却的上次触发轮次（per-session，避免并行子代理共享模块级全局态）。 */
  private lastElmReleaseTurn = -Infinity
  /** P2 工作相位确认器（任务寿命归 AgentLoop；reset() 不清它）。 */
  private readonly stage: WorkStage

  constructor(private deps: TurnPerceptionDeps) {
    this.stage = deps.workStage ?? new WorkStage()
  }

  async perceive(
    input: PerceptionInput,
    effects: {
      emitPhaseChange(phase: string, detail?: { tool?: string; reason?: string; suggestion?: string }): void
      /** R4 — surface a structured course-correction (kick-hook fires in preTurn). */
      emitDecisionShift?(shift: import('./loop-types.js').DecisionShift): void
    },
  ): Promise<PerceptionResult> {
    const sensoriumInput: SensoriumInput = {
      predictionAcc: input.predictionAccumulator,
      pressureResult: input.pressureResult,
      evidenceState: {
        filesModified: input.evidenceState.filesModified.size,
        verifiedCount: [...input.evidenceState.filesModified].filter(file => {
          const level = input.evidenceState.fileVerificationLevels?.get(file)
          return level !== undefined && level !== 'pending'
        }).length,
      },
      toolCallHistory: input.recentToolHistory.map(h => h.tool),
      pheromones: input.loadedPheromones,
      doomLevel: getDoomLoopLevel(input.traceStore.toolFingerprints),
      gitChangeRate: input.gitChangeRate,
      fsEventRate: input.fsEventRate,
      convergenceScore: input.convergenceScore ?? null,
    }

    let nextSensorium = input.sensorium
    let nextStrategy = input.strategy
    let nextVigor = input.vigor

    await this.deps.runtimeHooks.runPreTurn(createRuntimeHookContext(this.deps.getRuntimeSnapshot({
      sensoriumInput,
      providerDegradationRatio: this.deps.getProviderDegradationRatio(),
    }), {
      setSensorium: sensorium => { nextSensorium = sensorium },
      setStrategy: strategy => { nextStrategy = strategy },
      injectUserMessage: message => { this.deps.addUserMessage(message) },
      emitPhaseChange: (phase, detail) => { effects.emitPhaseChange(phase, detail) },
      emitDecisionShift: shift => { effects.emitDecisionShift?.(shift) },
      emitControlSignal: signal => { this.deps.submitControlSignal?.(signal) },
    }))

    if (!nextSensorium || !nextStrategy) {
      throw new Error('Perception runtime hook did not produce sensorium and strategy')
    }

    let currentStrategy = nextStrategy
    await this.deps.runtimeHooks.runAfterPerception(createRuntimeHookContext(this.deps.getRuntimeSnapshot({
      sensorium: nextSensorium,
      strategy: currentStrategy,
      vigor: nextVigor,
    }), {
      setStrategy: strategy => { currentStrategy = strategy },
      setVigor: vigor => { nextVigor = vigor },
      requestThetaCheck: reason => { this.deps.requestThetaCheck(reason) },
      emitControlSignal: signal => { this.deps.submitControlSignal?.(signal) },
    }))
    nextStrategy = currentStrategy

    if (nextSensorium.complexity > 0.5) {
      this.hasEnteredHighComplexity = true
    }

    // Phase 2A effort routing (default ON; opt out with RIVET_EFFORT_ROUTING=0):
    // step effort down one tier on routine, on-track turns. Floor is enforced
    // downstream in ReasoningEffortController.set().
    this.deps.setReasoningEffort(routeRoutineEffort(nextStrategy.reasoningEffort, {
      complexity: nextSensorium.complexity,
      momentum: nextSensorium.momentum,
      confidence: nextSensorium.confidence,
    }))
    const thetaState = {
      ...input.thetaState,
      interval: adaptThetaInterval(nextStrategy.thetaCycleInterval, input.gitChangeRate),
    }

    const recentTools = input.recentToolHistory.map(h => h.tool)
    const starCtx = buildStarPhaseContext({
      turn: input.turn,
      maxTurns: this.deps.maxTurns,
      recentTools,
      recentToolHistory: input.recentToolHistory, modelTurn: input.modelTurn,
      hasEnteredHighComplexity: this.hasEnteredHighComplexity,
      // YOLO 证据门归航：buildStarPhaseContext 只在 maxTurns<=0 时消费。
      // 判据用 deliveryReady（最近验证 passed 且绿后零编辑）而非 deliveryStatus——
      // 后者的全窗口粘滞让门在正常红→绿节奏下 91% 时间打不开（近两天日志回放）。
      deliveryVerified: input.deliveryReady ?? (input.evidenceState.deliveryStatus === 'verified'),
      // plan 进入门禁 + 后台活动守卫（2026-10-09）——相位记忆在感知层
      // （reset() 随新用户 run 清空，故「新需求进规划」不受门禁影响）。
      backgroundWorkActive: recentTools.includes('job'),
    })
    const rawCtx = this.currentPhase !== 'unknown'
      ? { ...starCtx, previousPhase: this.currentPhase as import('./star-event.js').StarPhase }
      : starCtx
    const rawEvent = createStarEvent(nextSensorium, rawCtx)
    this.currentPhase = rawEvent.phase
    const verified = recentVerification(input.recentToolHistory, input.modelTurn ?? input.turn)
    this.deps.telemetryWriter.write({ kind: 'phase-source', turn: input.modelTurn ?? input.turn, source: verified ? 'verification-activity' : 'sensorium', observedTurn: verified?.modelTurn, phase: rawEvent.phase })

    // ── P2 工作相位确认（§5）：原始候选仅内部观测（上方的 phase-source 遥测）；
    // 事件、prompt 相位提示与收敛评分统一读确认后的 committedPhase——同一
    // 确认结果，不再出现「UI 看 verify、评分仍用 execute」的错位。──
    const candidateSource: WorkStageCandidateSource = verified ? 'verification-activity' : 'sensorium'
    const decision = this.stage.confirm({
      modelObservationTurn: input.modelTurn ?? input.turn,
      snapshot: input.workFactSnapshot ?? null,
      verificationExecutions: input.verificationExecutions ?? [],
      rawCandidate: PHASE_CLASS_MAP[rawEvent.phase] ?? 'explore',
      candidateSource,
      deliveryReady: input.deliveryReady ?? (input.evidenceState.deliveryStatus === 'verified'),
      editExpectation: input.editExpectation,
    })
    // P3 观测：work-stage 确认结果落一条 lite 遥测（candidate/committed/source/
    // 转换/拒绝原因/编号）——只含枚举与编号，不记文件正文、路径或 argv。
    const stageState = this.stage.getState()
    this.deps.telemetryWriter.write({
      kind: 'work-stage',
      turn: input.modelTurn ?? input.turn,
      task: input.workFactSnapshot?.taskEpoch ?? null,
      stage: stageState.stageEpoch,
      candidate: PHASE_CLASS_MAP[rawEvent.phase] ?? 'explore',
      committed: decision.committedPhase,
      source: candidateSource,
      transition: decision.transition,
      reason: decision.reason,
      entered: stageState.enteredModelTurn,
    })
    const event: StarEvent = decision.committedPhase
      ? (() => {
          const phase = STAR_PHASE_FOR_CLASS[decision.committedPhase]
          return { ...rawEvent, phase, label: PHASE_LABELS[phase], glyph: PHASE_GLYPHS[phase] }
        })()
      : rawEvent
    effects.emitPhaseChange(event.phase, {
      tool: event.glyph,
      suggestion: event.label,
    })

    this.recordTelemetry({
      input,
      event: rawEvent, // 内部观测记原始候选；committed 观测 P3 追加（phase-source/work-stage）
      sensorium: nextSensorium,
      strategy: nextStrategy,
      vigor: nextVigor,
    })

    return {
      sensorium: nextSensorium,
      strategy: nextStrategy,
      vigor: nextVigor,
      thetaState,
      event,
      sensoriumInput,
    }
  }

  getSnapshots(): SensoriumEntry[] {
    return this.sensoriumSnapshots
  }

  getCurrentPhase(): string {
    return this.currentPhase
  }

  reset(): void {
    this.sensoriumSnapshots = []
    this.hasEnteredHighComplexity = false
    this.currentPhase = 'unknown'
    this.lastElmReleaseTurn = -Infinity
  }

  private recordTelemetry(input: {
    input: PerceptionInput
    event: StarEvent
    sensorium: Sensorium
    strategy: StrategyProfile
    vigor: VigorState
  }): void {
    const currentFP = this.deps.getFingerprint()
    const driftEvent = input.input.baselineFingerprint
      ? (currentFP.combinedSha256 !== input.input.baselineFingerprint.combinedSha256)
      : false
    const telemetrySnapshot = buildTelemetrySnapshot({
      ts: Date.now(),
      turn: input.input.turn,
      phase: input.event.phase,
      sensorium: input.sensorium,
      strategy: input.strategy,
      vigor: input.vigor,
      theta: {
        inFlight: input.input.thetaCheckInFlight,
        lastReason: input.input.thetaTelemetry.lastReason,
        lastDurationMs: input.input.thetaTelemetry.lastDurationMs,
        lastErrorCount: input.input.thetaTelemetry.lastErrorCount,
        lastTimedOut: input.input.thetaTelemetry.lastTimedOut,
        requestedCount: input.input.thetaTelemetry.requestedCount,
      },
      gitChangeRate: input.input.gitChangeRate,
      prefixDrift: driftEvent,
      lastElmReleaseTurn: this.lastElmReleaseTurn,
    })
    // 契约：elmDue 触发即记录本轮，驱动 per-session 冷却（见 buildHealthTelemetry）。
    if (telemetrySnapshot.health.elmDue) {
      this.lastElmReleaseTurn = input.input.turn
    }

    this.deps.telemetryWriter.write(telemetrySnapshot)
    this.sensoriumSnapshots.push({
      ts: telemetrySnapshot.ts,
      turn: telemetrySnapshot.turn,
      phase: telemetrySnapshot.phase,
      momentum: telemetrySnapshot.momentum,
      pressure: telemetrySnapshot.pressure,
      confidence: telemetrySnapshot.confidence,
      complexity: telemetrySnapshot.complexity,
      freshness: telemetrySnapshot.freshness,
      stability: telemetrySnapshot.stability,
      strategy: telemetrySnapshot.strategy,
      gitChangeRate: telemetrySnapshot.gitChangeRate,
    })
    if (this.sensoriumSnapshots.length > MAX_SNAPSHOTS) {
      this.sensoriumSnapshots.shift()
    }
  }
}
