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
  private currentPhase = 'unknown'
  /** elmDue 冷却的上次触发轮次（per-session，避免并行子代理共享模块级全局态）。 */
  private lastElmReleaseTurn = -Infinity

  constructor(private deps: TurnPerceptionDeps) {}

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
    })
    const event = createStarEvent(nextSensorium, starCtx)
    this.currentPhase = event.phase
    const verified = recentVerification(input.recentToolHistory, input.modelTurn ?? input.turn)
    this.deps.telemetryWriter.write({ kind: 'phase-source', turn: input.modelTurn ?? input.turn, source: verified ? 'verification-activity' : 'sensorium', observedTurn: verified?.modelTurn, phase: event.phase })
    effects.emitPhaseChange(event.phase, {
      tool: event.glyph,
      suggestion: event.label,
    })

    this.recordTelemetry({
      input,
      event,
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
