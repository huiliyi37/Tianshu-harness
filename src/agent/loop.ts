import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { renderPlanExecutingBlock } from '../prompt/volatile.js'
import type { KnowledgeCandidate } from '../memory/essence-gate.js'
import { ControlPlaneController } from './control-plane-adapters.js'
import { SessionContext } from './context.js'
import { SessionPersist, getSessionDir, shouldAutoWriteHandoff } from './session-persist.js'
import { attachSessionPersistListener } from './session-persist-listener.js'
import { PrewarmCache } from './prewarm.js'
import { invalidateSessionReadDedup } from '../tools/read-file.js'
import { getTodos, getTodoRegressionStats } from '../tools/todo.js'
import { resolveDecisionsArm } from './decisions-experiment.js'
import { gateToolDefinitions, isExtendedTool } from './tool-tiers.js'
import { applyDescriptionMode } from '../tools/description-compact.js'
import { resolvePromptBlocks } from '../prompt/block-policy.js'
import { buildBudgetReport } from '../prompt/prefix-budget.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import type { ToolErrorClass } from '../tools/types.js'
import type { FailureClass } from './failure-classifier.js'
import { EvidenceTracker } from './evidence.js'
import { ObligationTracker } from './obligation-tracker.js'
import { decideAcceptanceOutcome } from './evidence-obligation.js'
import { computeVerifyFailStreak, createCvmVectorEvaluator, cvmVectorMode, type CvmVectorMode } from './hooks/cognitive-capsule-router.js'
import { ProblemAttackStore } from './problem-attack-loop.js'
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import { createTraceStore, type TraceStore } from './trace-store.js'
import { getDoomLoopLevel, getClassDoomLoopLevel, combineDoomLoopLevels, getDoomLoopThresholds } from './trace-store.js'
import { classifyActivityMode, computeFlowBeacon, evaluateConvergence, FLOW_MIN_SAMPLES, PRODUCTIVE_TOOLS } from './convergence-detector.js'
import { isInProductionFlow } from './production-flow.js'
import type { PhaseClass, ConvergenceResult } from './convergence-detector.js'
import { computeStructureFlowControl } from './structure-flow-controller.js'
import type { StructureFlowSnapshot } from './structure-flow-controller.js'
import { assembleCognitiveFrame, projectStructureFlowInputs } from './cognitive-frame.js'
import type { CognitiveFrame } from './cognitive-frame.js'
import { buildCognitiveFrameRecord, buildCognitiveFrameLiteRecord } from './cognitive-frame-replay.js'
import { createFrameRecorder } from './frame-telemetry.js'
import type { FrameRecorder } from './frame-telemetry.js'
import { emitStopReason, stopReasonAbortTag, type StopReason } from './stop-reason.js'
import type { PlanExecutionTrace, StepResult } from './plan-execution-trace.js'
import { buildGateConvergenceHint } from './delivery-gate-v2.js'
import { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { ImportGraph } from './import-graph.js'
import type { PlanModeState } from './plan-mode.js'
import { createActivePlanDraftPath } from './plan-mode.js'
import type { AskModeState } from './ask-mode.js'
import { RepairPipeline } from './repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from './repair-passes.js'
import { ctclSanitizerPass } from './ctcl-sanitizer.js'
import { RepairHintTracker } from './repair-hint.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import { createPredictionAccumulator } from './prediction-error.js'
import type { PredictionAccumulator, EFEComponents } from './prediction-error.js'
import type { Sensorium } from './sensorium.js'
import type { StrategyProfile } from './sensorium.js'
import { createThetaState } from './star-event.js'
import type { ThetaState } from './star-event.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookSnapshot } from './runtime-hooks.js'
import { TurnPerceptionController } from './turn-perception.js'
import { TurnIntentController } from './turn-intent.js'
import { ContextInjectionController } from './context-injection.js'
import { CompactionController } from './compaction-controller.js'
import { resolveActiveDomain, type ActiveStarDomain, type StarDomainId } from './star-domain.js'
import { starDomainRegistry } from './star-domain-registry.js'
import { DomainDriftDetector } from './domain-drift-detector.js'
import { touchActivity } from './stall-observer.js'
import { buildDomainKnowledgeBlock } from './domain-knowledge-block.js'
import { mintNumericId, buildAgentMark, VOID_SYMBOL } from './void-identity.js'
import { buildDepartureMilestone } from '../constellation/milestone.js'
import { appendMilestone } from '../constellation/store.js'
import { ArtifactStore } from '../artifact/store.js'
import { SessionJobs } from '../tools/job-store.js'
import { MonitorRegistry } from './monitor-registry.js'
import { COMPACT_HISTORY_TOOL } from '../compact/recall-marker.js'
import { createWriteEvidenceProbe } from '../context/write-evidence-probe.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import { compactPolicyRatios } from '../compact/constants.js'
import { SessionStateManager } from './session-state.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import { debugLog } from '../utils/debug.js'
import { renderRouteAnnotation, STALL_ROUTE_TABLE } from './failure-taxonomy.js'
import { TurnStreamController } from './turn-stream.js'
import { type CognitiveSeason } from './cognitive-season.js'
import { createVigorState } from './vigor.js'
import type { VigorState } from './vigor.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { createFsWatcher } from '../context/fs-watcher.js'
import type { FsWatcherState } from '../context/fs-watcher.js'
import { watchConfigForHooks } from '../config/config-watcher.js'
import type { ConfigWatcherHandle } from '../config/config-watcher.js'
import { type CognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { buildRuntimeSelfModel } from './runtime-self-model.js'
import { CacheAdvisor } from '../cache/advisor.js'
import type { RecallMetricsSummary } from '../cache/recall-metrics.js'
import { createSycophancyTrap, type SycophancyTrap } from './sycophancy-trap.js'
import { createP3Integration, P3Integration } from './p3-integration.js'
import { ImmuneHook } from './immune-hook.js'
import { AdvisoryBus, DISCIPLINE_REANCHOR_INTERVAL, EFFICACY_CONFIDENT_SAMPLES, HOLDOUT_MIN_DELIVERED, parseHoldoutRate, disciplineReanchorEntry } from './advisory-bus.js'
import { AdvisoryReadback, type EfficacyPriorCounts } from './advisory-readback.js'
import { applyDomainAdvisoryTone } from './domain-advisory-tone.js'
import { createDestructiveGateState } from '../tools/destructive-gate.js'
import { AdvisoryEfficacyStore, type EfficacyDelta } from '../context/advisory-efficacy-store.js'
import { PhysarumEngine } from '../repo/physarum-engine.js'
import { getPhysarumShadowStatsFromDb } from '../repo/physarum-shadow-stats.js'
import type { PhysarumShadowStats } from '../repo/physarum-shadow-stats.js'
import { createTurnBudget, type TurnBudget } from './turn-budget.js'
import { classifyRecoveryTrigger, type RecoveryTrigger } from './recovery-trigger.js'
import { modeForRecoveryTrigger, type ReliabilityDecision } from './reliability-mode.js'
import { ResourceSensor, type ResourceSensorSnapshot } from './resource-sensor.js'
import { type PlanMethodology, type TaskContract, type TaskDepthLayer } from '../context/task-contract.js'
import { StigmergyStore } from '../context/stigmergy.js'
import { describeImages, visionCacheKey } from './vision-service.js'
import { ImageRegistry } from './image-registry.js'
import { createStanceTally } from './stance-tally.js'
import { createVirtuePendingLedger, type VirtuePendingLedger, computeVirtueCredit } from './virtue-signals.js'
import { createFailureJournal, type FailureJournal } from './failure-journal.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { SensoriumEntry } from './retrospect.js'
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { extractRegressionInventory } from './regression-inventory.js'
import { extractPlanConstraints, renderPlanConstraints } from './plan-constraints.js'
import type { ApprovalMode, AgentConfig, AgentCallbacks } from './loop-types.js'
import type { PermissionAllowRule, PermissionOverlay } from './permissions.js'
import { createPermissionOverlay } from './permissions.js'
import { recordToolHistory } from "./tool-history-recorder.js";
import { requestThetaCheck } from "./theta-controller.js";
import { createTurnStreamController, createTurnCompletionController, createToolExecutionController, createPlanTraceCoordinator, createCompactBoundaryCoordinator, createTurnOrchestrator, createTurnStepProducer, createReasoningEffortController, createIntentRetrievalRouteController, createAntiAnchoringController, createModelRoutingShadowController, createPrewarmController, createRuntimeHooksPipeline, buildRuntimeSnapshot, createSidePathUsageRecorder, createReclaimDecisionRecorder, resolveHookDisabledEnv } from "./loop-factory.js";
import type { TurnStepProducer } from './turn-step-producer.js'
import { ReasoningEffortController } from './reasoning-effort-controller.js'
import { IntentRetrievalRouteController } from './intent-retrieval-route-controller.js'
import { AntiAnchoringController } from './anti-anchoring-controller.js'
import { ModelRoutingShadowController } from './model-routing-shadow-controller.js'
import { PrewarmController } from './prewarm-controller.js'
import { loadSessionMemories } from './session-memory-warmup.js'
import type { PlanTraceCoordinator } from "./plan-trace-coordinator.js";
import type { CompactBoundaryCoordinator } from "./compact-boundary-coordinator.js";
import type { TurnOrchestrator } from "./turn-orchestrator.js";
import { type EffortShadowRecord } from './p3-reward.js'
import { TurnCacheObservability } from './cache-log-observability.js'

export type { ApprovalMode, AgentConfig, AgentCallbacks }

/**
 * `AgentLoop.run()` 的结果。
 *
 * `skipped-already-running` 表示 re-entry guard 命中、本次调用没有发起任何轮次。
 * 调用方必须处理它——TUI 在调 run() 之前就把自己置成了 busy，静默跳过会让那个
 * busy 永远挂着。
 */
export type AgentRunOutcome = 'completed' | 'skipped-already-running'

/**
 * Build the tiny approved-plan pointer block injected into the dynamic appendix.
 * Carries only slug/title/path — NOT the plan body, which stays the single
 * source of truth on disk at `.rivet/plans/<slug>.md`. The agent reads it on
 * demand and tracks steps via the existing todo mechanism.
 */
export function formatActivePlanPointer(plan: { slug: string; title: string; selectedApproach?: string }): string {
  const esc = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const slug = esc(plan.slug)
  const title = esc(plan.title)
  const approach = plan.selectedApproach
    ? `已选方案: ${esc(plan.selectedApproach)}。只执行此方案，勿执行未选中的备选。 `
    : ''
  return `<active-plan slug="${slug}" title="${title}" path=".rivet/plans/${slug}.md">${approach}已批准,正在执行此方案。完整步骤见该文件,需要时用 read_file 查看;开工前先用 todo 列出有序步骤跟踪进度,完成后 plan_close。</active-plan>`
}



/** Debounce before an idle compaction pass fires after a turn settles.
 *  60s：典型「读完回答→打下一条」节奏在 20–60s 内，过短的 debounce 会让快速
 *  追问频繁 abort 进行中的 LLM 压缩（浪费已花的压缩 tokens）；真正离开的场景
 *  60s 后依然远早于用户回来。可用 RIVET_IDLE_COMPACTION_MS 覆盖。 */
const IDLE_COMPACTION_DELAY_MS = 60_000

export class AgentLoop {
    session!: SessionContext;
    config!: AgentConfig;
  /** Agent 创建时间——shutdown 自动 handoff 据此判断会话内是否已手动交接
   *  （/handoff 或人工编辑的文档 mtime 晚于它 → 结构化摘要不覆盖）。 */
  readonly createdAtMs = Date.now()
  abortController: AbortController | null = null
  /** Turn heartbeat watchdog reference (set in initializeRun, cleared on stop). */
  _turnHeartbeat: import('./turn-heartbeat.js').TurnHeartbeat | null = null
  /** True when the current abort was triggered by the hard-stall watchdog
   *  (not user Esc/Ctrl+C). Read by the UI to render a distinct message. */
  _watchdogAborted = false
  /** Count of user interrupts within the current turn (中#5). */
  _turnInterruptCount = 0
  /**
   * Pending-abort latch: set by abort() so an interrupt fired during the
   * init/warmup window (before the turn loop) is honored rather than lost.
   * Reset at the start of each run().
   */
  _pendingAbort = false
  cwd: string
  evidence: EvidenceTracker
  /** 证据义务状态机（evidence-driven reasoning loop）——与 evidence 同寿命。 */
  obligations: ObligationTracker
  /** 证据防火墙 Phase 2：external-claim tracker getter（hook 装配时回写；
   *  hook 被禁用时保持 undefined → deliver 门禁 fail-open）。 */
  externalClaimTracker?: () => import('./hooks/external-claim-tracking-hook.js').ClaimTracker
  /** Obligation final gate 遥测（auto-continue 触发/误触发/诚实受阻计数，postSession 落 meta）。 */
  obligationGateStats = { continued: 0, misfires: 0, honestBlocked: 0, suppressed: 0 }
  compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  recentToolHistory: ToolHistoryEntry[] = []
  /** Component C (typecheck-reminder): a .ts/.tsx file was written this session. */
  touchedTsFiles = false
  /** Component C: a real typecheck (tsc/typecheck) has run since the last TS edit.
   *  A new TS edit resets this to false so the reminder re-arms. */
  sawTypecheckThisTask = false
  /** W5 (render-verify): a UI file was written this session. */
  touchedUiFiles = false
  /** W5 (render-verify): a visual verification tool was used this session. */
  sawVisualVerify = false
  prewarm = new PrewarmCache(60_000, 50)
  private _running = false
  /** Idle compaction: after a run settles, a debounced timer fires a turn-0
   *  compaction pass so the NEXT user turn doesn't eat a synchronous full
   *  compaction. Gated on real pressure / pending deferred work, cancelled the
   *  moment a new run() starts. */
  private _idleTimer: ReturnType<typeof setTimeout> | null = null
  private _idleCompacting = false
  private _idleAbort: AbortController | null = null
  private _idleSettled: Promise<void> | null = null
  /** P0-1 persist drain: awaits pending async writes so tool results survive abort. */
  private _persistDrain: (() => Promise<void>) | null = null
  private physarumForWarmup?: PhysarumEngine
  private meridianDbForWarmup?: import('../repo/meridian-db.js').MeridianDb
  private memoriesWarmed = false
  streamedText = ''
  thinkingOnlyRetries = 0
  lastThinkingContent = ''
  consecutiveNoToolTurns = 0
  /** 连续全只读轮计数（B1 只读螺旋提醒）。显式初始化——历史遗漏导致
   *  首轮即只读的会话 undefined+1=NaN，B1 永久失明（turn-orchestrator
   *  有 ?? 0 兜底，此处声明保持与相邻字段一致）。 */
  consecutiveReadOnlyTurns = 0
  wedgeToolFingerprint = ''
  wedgeRepeatCount = 0
  lastTurnTextFingerprint = ''
  lastTurnThinkingFingerprint = ''
  lastPrewarmAt = 0
  private lastCacheDiagnostic: string | null = null
  latestRisk: import('./approval-risk.js').RiskAssessment = { level: 'none', reasons: [], suggestedAction: 'No additional approval required.' }
  /** Latest per-turn free-energy signals — consumed by coordinator EFE worker routing. */
  latestPolicySignals?: { efe: EFEComponents; sensorium: Sensorium }
  planModeState: PlanModeState = 'off'
  /** Relative path to the active plan file (draft or revision target). Writable in plan mode. */
  activePlanFilePath: string | null = null
  /** Ask Mode — pure read-only Q&A; mutually exclusive with planModeState. */
  askModeState: AskModeState = 'off'
  /** 主动 plan mode 建议的 one-shot 记忆：已建议过的 contract id（选「直接执行」后不复问）。 */
  planModeSuggestedContracts = new Set<string>()
  /** 「请声明验收面」的 one-shot 记忆：已催过的 contract id。义务块每轮都在
   *  渲染 `next=user_acceptance` 作被动通道，advisory 只负责响一次，不逐轮催。 */
  readonly acceptanceAdvisedContracts = new Set<string>()
  /** W3：A 前置对齐 advisory 已触发过的契约 key（collab:align:<contractId>）——
   *  每契约至多一次，澄清（新契约）后可再次触发。 */
  collabAlignFiredContracts = new Set<string>()
  /** Plan mode 状态变更通知 — server 层订阅后转发 plan_mode SSE（桌面切 Plan tab）。
   *  覆盖模型自主 enter_mode 的场景：session-manager 自己触发的切换它已经知道，
   *  工具触发的切换只能靠这条回调出圈。agent 创建后由外部回填。 */
  onPlanModeChange?: (state: PlanModeState) => void
  /** Ask mode 状态变更通知 — server 层订阅后转发 ask_mode SSE。 */
  onAskModeChange?: (state: AskModeState) => void
  /** TUI 回调：计划提交待审批时弹出审批面板（替代手动输入 /plan-approve）。 */
  onPlanApprovalRequested?: (info: import('../tools/types.js').PlanSubmittedInfo) => void
  /** TUI 回调：agent 向用户提问含选项时弹出选择面板（替代手动输入选项编号）。 */
  onAskUserQuestionRequested?: (info: import('../tools/types.js').AskUserQuestionInfo) => void
  decisions: string[] = []
  trajectory = new TrajectoryRecorder()
  failureJournal: FailureJournal = createFailureJournal()
  repairPipeline = new RepairPipeline([ctclSanitizerPass, fourHorsemenPass, semanticRepairPass])
  repairHintTracker = new RepairHintTracker()
  traceStore: TraceStore
  harness: TurnHarness
  routingMetrics = new RoutingMetricsCollector()
  importGraph: ImportGraph | null = null
  lastConflictCheckCount = 0
  predictionAccumulator: PredictionAccumulator = createPredictionAccumulator()
  sessionDomain: ActiveStarDomain | null | undefined
  /** Distinguishes an untouched session from an explicit per-session Auto
   * selection while both still expose `sessionDomain === undefined` before
   * the first bind. */
  private sessionDomainSelection: 'default' | 'auto' | 'manual' = 'default'
  private _domainWasAutoResolved = false
  private _driftDetector: DomainDriftDetector | null = null
  /** Agent's self-chosen departure mark (leave_mark tool); sealed by the
   *  constellation post-session hook. Null until the agent leaves a mark. */
  pendingLeaveMark: import('../tools/types.js').LeaveMarkInput | null = null
  /** Ephemeral per-session numeric id, minted on first run. Used in welcome
   *  display and passed to buildAgentMark when the agent departs. */
  _sessionNumericId: number | null = null

  /** The session's ephemeral numeric identity (e.g. 7281). Minted lazily. */
  get sessionNumericId(): number {
    if (this._sessionNumericId === null) {
      this._sessionNumericId = mintNumericId()
    }
    return this._sessionNumericId
  }
  /** U6: most recent convergence-detector result — consumed by the replan loop's
   *  detectDeviation (blocked/stalled signals). Null until first convergence check. */
  latestConvergenceResult: ConvergenceResult | null = null
  /** P2 阴阳调度：本 turn 的 structure-flow 控制快照（EFE 就绪时每次
   *  runConvergenceCheck 重算；EFE 缺失 = null → 一切消费方走旧行为）。
   *  只读事实，供 convergence 软阈值 / plan advisory / tdd 投影消费。 */
  latestStructureFlow: StructureFlowSnapshot | null = null
  /** P3 认知帧：本 turn 边界的只读事实帧（每次 runConvergenceCheck 重装配，
   *  恒产出——EFE 缺失时以 quality 标记而非置 null）。structure-flow 输入
   *  由它投影导出（单一装配点）；Wave 3 起同时作为回放遥测的记录源。 */
  latestCognitiveFrame: CognitiveFrame | null = null
  /** P2 plan advisory 去重键（session 级 one-shot）。用户干预与 plan
   *  生命周期（enter/exit）时清空，允许在新语境下重新建议。 */
  readonly structureFlowPlanAdvisoryKeys = new Set<string>()
  /** Most recent structured stop-reason (why the last turn loop ended). */
  latestStopReason: StopReason | null = null
  /** Fix 1 — convergence emission cooldown with backoff. The L2 side-effects
   *  (改道 card via onDecisionShift, convergence-warning phase change, and the
   *  advisory nudge) are throttled so a persistent stuck-state does NOT re-emit
   *  the same "改道" card every single turn.
   *
   *  Backoff (incident 9266c3a7): the old fixed 3-turn cooldown re-emitted the
   *  same advisory ~50 times in a 154-turn session. Now the cooldown for the
   *  SAME message variant doubles each consecutive emission (3→6→12→24…),
   *  resetting to base when the variant changes, level escalates, or the agent
   *  produces a productive tool (edit/bash/test) since the last emit.
   *
   *  Re-emit only when the cooldown elapses, the level escalates, or the message
   *  type changes. Mirrors the cooldown discipline in kick-hook.ts. */
  private readonly convergenceEmitBaseCooldownTurns = 3
  private convergenceEmitCooldownTurns = 3
  /** Consecutive emit count for the current message variant — drives both the
   *  backoff multiplier and the "第 N 次提醒" prefix in the injected message. */
  private convergenceEmitRepeatCount = 0
  private lastConvergenceEmitTurn = -Infinity
  private lastConvergenceEmitLevel = 0
  private lastConvergenceMsgKey = ''
  /** 上次发射时的验证失败流水 — 第四突破条件（流水加深 → 提前发射）的基线。 */
  private lastConvergenceEmitVerifyFailStreak = 0
  /** 上次发射时的收敛 score — 冷却期内 score 显著下降（>0.15）时打破冷却。 */
  private lastConvergenceEmitScore = 1.0
  /** B1c/M4（2026-07-23 信号互扰治理）：L2+ 警告后连续产出 N 轮 → 清
   *  priorWarningAtL2Plus 旧账。此前台账只有用户干预会清——纯自主长跑中
   *  一旦 L2 发射,几十轮产出之后的任何跌分都能拿陈旧警告直接 L3 熔断。 */
  private readonly convergenceWarningClearProductiveTurns = 5
  private turnHadProductiveTool = false
  private productiveTurnStreak = 0
  /** W1（20b9714e 复盘）：阶段相对轮数基线。phaseClass 变更时重置，收敛文案
   *  用 turn - phaseStartTurn 而非会话全局轮数——消灭"连续 90 轮未收敛"这类
   *  会话越长越吓人的假数字。 */
  private phaseStartTurn = 0
  private lastConvergencePhaseClass = ''
  /** 近 10 次收敛检查时的 todo 完成数采样（进度信标数据源，10 = 最大信号窗口）。 */
  private todoCompletedSamples: number[] = []
  /** Rolling score history from recent convergence checks (most recent last).
   *  Maintained as a sliding window of at most 20 entries. Passed to
   *  evaluateConvergence for L3 scoreAbort decline-trend detection. */
  convergenceScoreHistory: number[] = []
  /** 解耦修复：CCR/kick 的让位判据。旧判据 latestConvergenceResult.shouldKick
   *  在卡住期间恒为 true，而发射被 3 轮冷却节流——冷却静默期 CCR 也被整轮压制
   *  （守护链路静音栈的一环）。新判据只在 convergence **真实发射**过 advisory 的
   *  相邻轮让位（避免同轮双重提醒），其余轮 CCR 正常参与。 */
  wasConvergenceEmittedRecently(): boolean {
    return this.session.getTurnCount() - this.lastConvergenceEmitTurn <= 1
  }
  /** CVM-vector（v3.1 计划）：最近一次 convergence 检查的 phaseClass。
   *  '' = 本会话尚未跑过 convergence 检查（未到 perception 不分类）。 */
  getConvergencePhaseClass(): string {
    return this.lastConvergencePhaseClass
  }
  /** CVM-vector 干预路由：mode 闸门（RIVET_CVM_VECTOR，缺省 shadow）+
   *  session 级 evaluator（冷却状态内聚）。shadow 只落 telemetry 绝不 submit——
   *  该纪律由 turn-step-producer 的唯一接线点执行。 */
  readonly cvmVector: { mode: CvmVectorMode; evaluator: ReturnType<typeof createCvmVectorEvaluator> } = {
    mode: cvmVectorMode(),
    evaluator: createCvmVectorEvaluator(),
  }
  /** anchor-break-scout 已在本 session 派发过视角侦察（CV2 让位判据）。
   *  scout 是 opt-in（antiAnchoring），默认会话恒 false。 */
  anchorScoutOwned = false
  /** PAL 攻坚层（计划 v2）：会话级案件容器。attack_case 工具与
   *  problem-attack-hook 共享同一实例；所有状态迁移经纯 reducer 单入口。 */
  readonly problemAttack = new ProblemAttackStore()
  /** Phase 0 观测 — guardian（CCR / 改道 / kick）触发计数。会话内累计，
   *  随遥测与 session meta 落盘，让"守护链路被静音"从体感问题变成数据问题。 */
  readonly guardianActivity: {
    ccr: number
    shifts: Record<string, number>
    advisoriesRendered: number
    advisoriesDropped: number
    /** P1a 核销闭环：expect 谓词判定为采纳/忽略的累计数 */
    advisoriesAdopted: number
    advisoriesIgnored: number
    /** Holdout 反事实组：被静默扣留的累计数（cockpit advisory 面板消费） */
    advisoriesHeldOut: number
    /** Wave 1：SR 通道提交数 + 被 SessionContext cap 丢弃数 */
    advisoriesSrSubmitted: number
    advisoriesSrDropped: number
  } = { ccr: 0, shifts: {}, advisoriesRendered: 0, advisoriesDropped: 0, advisoriesAdopted: 0, advisoriesIgnored: 0, advisoriesHeldOut: 0, advisoriesSrSubmitted: 0, advisoriesSrDropped: 0 }
  private lastGuardianMetaFingerprint = ''
  /** 记录一次结构化改道发射（source: 'kick' | 'convergence' | …）。 */
  recordDecisionShift(source: string): void {
    this.guardianActivity.shifts[source] = (this.guardianActivity.shifts[source] ?? 0) + 1
  }
  /** 累计 advisory 投递账本（来自 AdvisoryBus.drainLedger）。 */
  recordAdvisoryLedger(delta: { rendered: number; dropped: number; heldOut?: number; srSubmitted?: number; srDropped?: number }): void {
    this.guardianActivity.advisoriesRendered += delta.rendered
    this.guardianActivity.advisoriesDropped += delta.dropped
    this.guardianActivity.advisoriesHeldOut += delta.heldOut ?? 0
    this.guardianActivity.advisoriesSrSubmitted += delta.srSubmitted ?? 0
    this.guardianActivity.advisoriesSrDropped += delta.srDropped ?? 0
  }
  /** P1a：核销判定后同步会话累计采纳/忽略（来自 AdvisoryReadback.getTotals）。 */
  recordAdvisoryOutcomes(totals: { adopted: number; ignored: number }): void {
    this.guardianActivity.advisoriesAdopted = totals.adopted
    this.guardianActivity.advisoriesIgnored = totals.ignored
    // P1：advisory 被忽略 ≥ 2 → 通知 destructive-gate 开窗
    if (totals.ignored >= 2) {
      this.destructiveGate.noteAdvisoryPressure()
    }
  }

  /**
   * B：把会话内效能计数的**增量**合并写回跨会话信息素文件。
   * 差分基线在 lastEfficacyFlush——每 20 轮 + postSession 各调一次,
   * 重复调用安全(零增量直接跳过)。失败不致命(信息素是尽力而为)。
   */
  flushAdvisoryEfficacy(): void {
    try {
      const deltas = new Map<string, EfficacyDelta>()
      for (const [key, s] of this.advisoryReadback.getStats()) {
        const base = this.lastEfficacyFlush.get(key)
        const delta: EfficacyDelta = {
          delivered: s.delivered - (base?.delivered ?? 0),
          adopted: s.adopted - (base?.adopted ?? 0),
          ignored: s.ignored - (base?.ignored ?? 0),
          shadowHeld: s.shadowHeld - (base?.shadowHeld ?? 0),
          shadowSatisfied: s.shadowSatisfied - (base?.shadowSatisfied ?? 0),
        }
        if (delta.delivered > 0 || delta.adopted > 0 || delta.ignored > 0 || delta.shadowHeld > 0 || delta.shadowSatisfied > 0) {
          deltas.set(key, delta)
        }
        this.lastEfficacyFlush.set(key, {
          delivered: s.delivered, adopted: s.adopted, ignored: s.ignored,
          shadowHeld: s.shadowHeld, shadowSatisfied: s.shadowSatisfied,
        })
      }
      if (deltas.size > 0) this.advisoryEfficacyStore.mergeAndSave(deltas)
    } catch { /* 尽力而为——写回失败不影响会话 */ }
  }
  /**
   * 记录并落盘一次结构化停止原因。此前 StopReason 只进 debugLog/遥测——
   * 不开 RIVET_DEBUG 时事后无法回答"这个 run 是谁停的"（护栏熔断 / 用户
   * 中断 / 流错误 / 自然收尾不可区分）。现在同步写进 session meta，
   * 每次 run 结束覆盖上一条。写失败不致命（观测辅助，永不阻断）。
   */
  /** Obligation final gate 遥测计数（turn-orchestrator 回调；postSession 落 meta）。 */
  recordObligationGateEvent(event: 'continued' | 'misfire' | 'honest_blocked' | 'suppressed'): void {
    if (event === 'continued') this.obligationGateStats.continued += 1
    else if (event === 'misfire') this.obligationGateStats.misfires += 1
    else if (event === 'honest_blocked') this.obligationGateStats.honestBlocked += 1
    else this.obligationGateStats.suppressed += 1
  }

  recordStopReason(r: StopReason): void {
    this.latestStopReason = r
    if (!this.persist) return
    try {
      this.persist.updateMetadata({
        lastStopReason: {
          source: r.source,
          turn: r.turn,
          voluntary: r.voluntary,
          ...(r.detail !== undefined && { detail: r.detail }),
          ...(r.score !== undefined && { score: r.score }),
          ...(r.level !== undefined && { level: r.level }),
          t: Date.now(),
        },
      })
    } catch { /* meta 摘要是观测辅助 — 永不阻断 */ }
  }
  /** 把 guardian 活动摘要写进 session meta（仅在计数变化时写，原子写、失败不致命）。 */
  flushGuardianMeta(): void {
    if (!this.persist) return
    const ga = this.guardianActivity
    const fingerprint = JSON.stringify([ga.ccr, ga.shifts, ga.advisoriesRendered, ga.advisoriesDropped, ga.advisoriesAdopted, ga.advisoriesIgnored])
    if (fingerprint === this.lastGuardianMetaFingerprint) return
    this.lastGuardianMetaFingerprint = fingerprint
    try {
      this.persist.updateMetadata({
        guardianActivity: {
          ccr: ga.ccr,
          shifts: { ...ga.shifts },
          advisoriesRendered: ga.advisoriesRendered,
          advisoriesDropped: ga.advisoriesDropped,
          advisoriesAdopted: ga.advisoriesAdopted,
          advisoriesIgnored: ga.advisoriesIgnored,
        },
      })
    } catch { /* meta 摘要是观测辅助 — 永不阻断 turn */ }
  }
  /** Goal tracker for autonomous long-running tasks. Owned by AgentLoop so that
   *  doom-loop threshold selection (getDoomLoopLevel) and goal-active checks
   *  (isGoalActive) read LOCAL state instead of reaching back into the
   *  orchestrator — breaking the former orchestrator→loop→orchestrator cycle.
   *  The orchestrator reads it via the deps.getGoalTracker getter. */
  private goalTracker: import('./goal-tracker.js').GoalTracker | null = null
  /** U6: autonomous plan execution trace. Created per task (initializeRun), steps
   *  seeded from the first todo write (capturePlanSteps), advanced per tool-turn,
   *  and checked for deviation at each turn boundary. Null outside task context. */
  planTrace: PlanExecutionTrace | null = null
  /** U6: last replan correction injected as a system-reminder — dedup guard so a
   *  persistent deviation doesn't spam an identical nudge every turn. */
  lastReplanInjection = ''
  /** Session-local affordance adaptations — per-session, never mutates global registry */
  sessionAffordanceAdaptations: Record<string, import('./affordance.js').BaseAffordance> = {}
  /** Previous anchor graph hash for HEARTH INV-5 intra-session drift detection. */
  prevAnchorGraphHash: string | null = null
  /** Previous turn's streamed assistant text for dedup-guard P5. */
  prevStreamedText: string | null = null
  /** W2 被拦不弃守护：本 turn 被闸门拦截的事件 kind 列表（pipeline onGateBlocked
   *  累计，gate-block-guard hook postTurn drain 清零）。 */
  gateBlockedKinds: string[] = []
  /** P1b: TDD gate 同 target 被拦计数 — session 级累计，≥3 触发 advisory */
  tddBlockedTargets = new Map<string, number>()
  pressureMonitor: PressureMonitor
  sycophancyTrap: SycophancyTrap = createSycophancyTrap()
  turnBudget: TurnBudget = createTurnBudget(0)
  sensorium: Sensorium | null = null
  strategy: StrategyProfile | null = null
  vigorState: VigorState = createVigorState()
  runtimeHooks: RuntimeHookPipeline
  /** P2 Wave 2: config HMR watcher（非 headless 模式装配）。persistent:false
   *  不阻塞进程退出；但不会随实例 GC 自动消失（FSWatcher 持有原生句柄），整个
   *  AgentLoop 被丢弃时须经 stopConfigWatcher() 显式 close（switch 三路径）。 */
  configWatcher: ConfigWatcherHandle | null = null
  perception: TurnPerceptionController
  intent: TurnIntentController
  contextInjection: ContextInjectionController
  compaction: CompactionController
  // P2-6 breadcrumb state — lifted from createTurnStreamController closure
  // to instance scope so it survives TurnStreamController recreation at each
  // user-message boundary (turn-step-producer.ts:122). Without this, the diff
  // against cumulative engine counters resets every segment, causing false
  // positives (e.g. toolsUpdated=true on every turn=0) and false negatives
  // (real events masked by the reset).
  prevEngineStats = { volatileSwaps: 0, frozenClamps: 0, frozenFallbackRebuilds: 0, toolsUpdates: 0 }
  prevMsgCount = 0
  prevHitRate: number | null = null
  prevTokenEfficiency: number | undefined = undefined
  /** Request-aligned cache telemetry. Tool output is consumed by the next model call. */
  turnCacheObservability = new TurnCacheObservability()
  /** 累计等首字节耗时与采样轮数。用来区分「墙钟花在等模型」与「花在跑工具」——
   *  worker 续跑判据只看工具调用数时，慢通道（每次调用间隔 15–36s）看起来和健康
   *  通道一样活跃。与 cache-log 的 ttftMs 同源，但不受缓存字段是否存在的影响。 */
  ttftTotalMs = 0
  ttftSamples = 0
  /** Estimated context tokens at the end of the previous turn — baseline for
   *  compact attribution (compactPreRatio / compactReclaimed in the cache-log). */
  prevEstTokens = 0
  /** The compact-history artifact most recently produced by a compaction, set in
   *  the onArchive callback and consumed once when the rewrite turn's cache-log
   *  entry is built (loop-factory attaches it as entry.archiveId, then clears). */
  lastArchive: { id: string; turn: number } | null = null
  turnStream: TurnStreamController | null = null
  turnCompletion: TurnCompletionController
  toolExecution: ToolExecutionController
  planTraceCoordinator: PlanTraceCoordinator
  compactBoundaryCoordinator: CompactBoundaryCoordinator
  private turnOrchestrator: TurnOrchestrator
  turnStepProducer: TurnStepProducer
  private reasoningEffort: ReasoningEffortController
  /** 用户是否手动设置了 reasoning effort（/effort max 等）。
   *  true 时 autoReasoning 不得覆盖；/effort auto 清为 false 交还 autoReasoning。 */
  userReasoningOverride = false
  intentRoute: IntentRetrievalRouteController
  antiAnchoring: AntiAnchoringController
  private modelRoutingShadow: ModelRoutingShadowController
  prewarmController: PrewarmController
  thetaCheckInFlight = false
  thetaTelemetry: {
    lastReason: string | null
    lastDurationMs: number | null
    lastErrorCount: number
    lastTimedOut: boolean
    requestedCount: number
    /** Number of consecutive theta checks that timed out. Reset to 0 on success. */
    consecutiveTimeouts: number
    /** Turn number at which backoff expires. 0 = no backoff active. */
    cooldownUntilTurn: number
    /** busy/backoff 抑制次数——与真实超时分开记账（主控可靠性闭环 Wave 1）。 */
    suppressedCount: number
    /** 各 outcome 累计（ok/type_errors/timeout/spawn_error/busy/backoff）。 */
    outcomes: Record<import('./theta-check.js').ThetaOutcome, number>
  } = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
    consecutiveTimeouts: 0,
    cooldownUntilTurn: 0,
    suppressedCount: 0,
    outcomes: { ok: 0, type_errors: 0, timeout: 0, spawn_error: 0, busy: 0, backoff: 0 },
  }
  /** Max theta checks per session. Prevents runaway tsc spawning. */
  thetaRequestsThisTurn = 0
  thetaState: ThetaState = createThetaState(7)
  artifactStore: import('../artifact/store.js').ArtifactStore | undefined
  /** Session-scoped background job registry (bash run_in_background + `job` tool).
   *  Self-created for TUI; the server replaces it via setJobs() with an instance
   *  it subscribes to for SSE + REST. */
  private _jobs: import('../tools/job-store.js').SessionJobs | undefined
  /** Session-scoped monitor registry（monitor 工具 + monitor-hook 共享；
   *  经 getter 晚绑定 _jobs——server setJobs 替换实例后自动重绑）。 */
  private _monitors: import('./monitor-registry.js').MonitorRegistry | undefined
  sessionStateManager: SessionStateManager | undefined
  stigmergyStore: StigmergyStore
  loadedPheromones: Pheromone[] = []
  readonly stanceTally = createStanceTally()
  readonly virtuePendingLedger = createVirtuePendingLedger()
  lastSeenEventId = 0
  gitChangeRate = 0
  telemetryWriter: TelemetryWriter
  /** P3-D：frame 全量记录的独立落盘通道（frames.jsonl，默认开）。 */
  frameRecorder: FrameRecorder
  baselineFingerprint: PrefixFingerprint | null = null
  sensoriumSnapshots: SensoriumEntry[] = []
  taskContract?: TaskContract
  latestCognitiveSnapshot?: CognitivePhaseSnapshot
  persist: SessionPersist | null = null
  private resourceSensor: ResourceSensor
  latestResourceSnapshot: ResourceSensorSnapshot | null = null
  latestReliabilityDecision: ReliabilityDecision | null = null
  /** Triggers that have fired at error severity this session. Used by
   *  refreshReliabilityDecision to cap recurring firings at degraded,
   *  preventing permanent lock-in from non-self-resolving conditions. */
  firedRecoveryTriggers: Set<RecoveryTrigger> = new Set()
  fsWatcher: ReturnType<typeof createFsWatcher> | null = null
  latestFsWatcherState: FsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  currentSeason: CognitiveSeason | null = null
  currentSeasonIntensity: number | null = null
  lastCompactTurn: number | null = null
  _lastRetrievalRoute: import('./intent-retrieval-route.js').RetrievalRoute | null = null
  _lastEligibility: import('./discipline-eligibility.js').DisciplineEligibility | null = null
  _taskDepthLayer: TaskDepthLayer | undefined = undefined
  _planMethodology: PlanMethodology | undefined = undefined
  _prevPhaseHint: string | undefined = undefined
  /**
   * P2-5: mid-round history rewrites break the prefix cache between two API
   * calls inside one user round (cache-log #30: input +319, cacheRead
   * 50,304→17,792). Pressure detected mid-round is deferred via these flags
   * and processed at the next user-message boundary (turn 0), keeping the
   * session append-only within a round.
   */
  pendingStaleCompact = false
  pendingHeapCompact = false
  cacheAdvisor: CacheAdvisor
  p3: P3Integration
  /** Tier 2 LLM speculation engine (null when disabled). Set by
   *  createTurnOrchestrator; read at postSession to persist fired/error
   *  counters into meta speculationStats. */
  llmSpeculationEngine: import('./llm-speculation.js').LlmSpeculationEngine | null = null
  immuneHook: ImmuneHook
  _lastImmuneHint?: import('./immune-context.js').ImmuneContextHint
  /** A1: unified advisory bus — collects corrective signals, renders ≤3 per turn */
  advisoryBus = new AdvisoryBus()
  /** P1a 核销闭环：advisory 送达后按 expect 谓词核销 adopted/ignored */
  advisoryReadback = new AdvisoryReadback()
  /** 主控心流控制面（RIVET_CONTROL_PLANE: off|shadow|active，默认 shadow）。
   *  shadow 只归并/记账（K0），不改 prompt；active 才允许 appendix 出口（Wave 4）。 */
  controlPlane = new ControlPlaneController()
  /** 破坏性命令 pre-execution 闸门(验证失败后 git 清场当轮拦截,首拦重放行)。
   *  tool-pipeline 是唯一写者兼读者,loop 只持有生命周期。 */
  destructiveGate = createDestructiveGateState({
    getVirtueCredit: () => {
      // 反证 4：reversal 季冻结——平稳期信任不适用于压力态
      if (this.currentSeason === 'reversal') return 0.5
      const signals = this.stanceTally.getAllSignals?.()
      return signals ? computeVirtueCredit(signals) : 0.5
    },
  })
  /** B 跨会话效能信息素 store（构造器内初始化） */
  advisoryEfficacyStore!: AdvisoryEfficacyStore
  /** 上次效能 flush 时的 per-key 计数快照 — mergeAndSave 只收增量,差分在此 */
  private lastEfficacyFlush = new Map<string, EfficacyDelta>()
  /** F-fix: tool calls since the last discipline re-anchor advisory. */
  private toolCallsSinceReanchor = 0
  /** Anti-habituation: turn count since last model-initiated objection/risk flag. */
  turnsSinceLastObjection = 0
  lastToolCompleteTime = 0
  initialUserMessage: string | null = null
  /** 知识重构（Wave 1/2）：候选知识缓冲——正则观察 + 手动 remember 队列，
   *  不直写存储，由 postSession essence-gate 统一裁决准入。会话级，上限 60 条 FIFO。 */
  knowledgeCandidates: KnowledgeCandidate[] = []
  /** 当前 run 的 orchestrator 循环轮数(每 run 从 0 重计)——缺口 C/D hook 消费 */
  runLoopTurn = 0
  /** 最近一次用户输入(run 启动 = 0,steer 注入时更新)的 run 轮数 */
  lastUserInputRunTurn = 0
  /** Sliding window of recent turn text fingerprints for cross-turn repetition detection. */
  recentTextFingerprints: string[] = []
  /** T2-02: Current effort shadow record (telemetry only in P0, influences effort in P3+) */
  _currentEffortShadow: EffortShadowRecord | null = null
  /** 逃生口运行时挂载的 EXTENDED 工具名（经 /tools enable 加入）。updateTools 时作为豁免传入。 */
  private readonly mountedExtras = new Set<string>()
  /** 视觉副驾短期记忆：本会话用户/工具携带的图片按短 id 寄存，供 ask_image 反复追问。
   *  纯内存、不进 prompt 历史、不落盘（见 image-registry.ts 的边界约束）。 */
  readonly imageRegistry = new ImageRegistry()

  constructor(
    config: AgentConfig,
    session: SessionContext,
    cwd?: string,
  ) {
      this.config = config; this.session = session;
    if (!this.config.permissionsOverlay) {
      this.config.permissionsOverlay = createPermissionOverlay()
    }
    this.cwd = cwd ?? process.cwd()
    // 构造期注入共享 prewarm——必须早于 createToolExecutionController（下方
    // L929 附近）：其 deps 按值捕获 self.prewarm，构造后替换字段到不了消费端。
    if (config.prewarm) this.prewarm = config.prewarm
    this.evidence = new EvidenceTracker()
    // 证据义务状态机：与 EvidenceTracker 同寿命。验证事件单向流入——
    // blocked 只记 attempted、目标不匹配的失败不满足 RED（Wave 1 语义）。
    this.obligations = new ObligationTracker()
    this.evidence.setVerificationListener(meta => this.obligations.applyVerification(meta))
    this.traceStore = createTraceStore()
    // P1b 习惯化对抗：核销账本的 ignoredStreak 驱动升级措辞/有界静音
    this.advisoryBus.setHabituationPolicy(this.advisoryReadback)
    // Phase 2 挂起观察自愈判定：expect 谓词在观察窗口内已被自发满足 → 撤销
    this.advisoryBus.setSelfHealCheck((expect, since, now) =>
      this.advisoryReadback.wasSatisfiedBetween(expect, since, now))
    // Holdout 反事实抽样：小概率静默扣留以度量真实 lift（RIVET_ADVISORY_HOLDOUT=0 关闭）
    this.advisoryBus.setHoldoutPolicy({
      rate: parseHoldoutRate(process.env.RIVET_ADVISORY_HOLDOUT),
      isEligible: key => this.advisoryReadback.getDeliveredCount(key) >= HOLDOUT_MIN_DELIVERED,
    })
    // B 跨会话效能信息素：加载 EWMA 衰减后的先验（holdout 资格/副驾闸门/
    // Top-N 次级排序三个消费方;习惯化保持会话内,guardian meta 保持会话纯度）
    this.advisoryEfficacyStore = new AdvisoryEfficacyStore(this.cwd)
    try {
      const priors = this.advisoryEfficacyStore.load()
      this.advisoryReadback.seedPriors(
        [...priors].map(([k, p]) => [k, {
          delivered: p.delivered, adopted: p.adopted, ignored: p.ignored,
          shadowHeld: p.shadowHeld, shadowSatisfied: p.shadowSatisfied,
        }] as [string, EfficacyPriorCounts]),
      )
    } catch { /* 先验加载失败不致命——回退冷启动 */ }
    this.advisoryBus.setAdoptionRateProvider(key => this.advisoryReadback.getAdoptionRate(key))
    // W2 efficacy 负反馈环（20b9714e）：发射前回读会话内 delivered/adopted——
    // 同 key 零采纳连发 3 次后冷却翻倍、6 次后会话内静默（constitutional 豁免）。
    this.advisoryBus.setEfficacyStatsProvider(key => {
      const s = this.advisoryReadback.getStats().get(key)
      return s ? { delivered: s.delivered, adopted: s.adopted } : null
    })
    // 星域措辞适配（2026-07-07）：按当前域把 advisory 翻译成该域听得进的
    // 形态（如天权的证据式裁决协议）。惰性读 sessionDomain——域激活/切换自动生效。
    this.advisoryBus.setToneAdapter((content, meta) =>
      applyDomainAdvisoryTone(this.sessionDomain?.id, content, meta))
    // Lift 消费端：成熟 lift（会话 + 先验,过成熟度门）驱动负 lift 静音与
    // Top-N 排序升级。RIVET_ADVISORY_LIFT_CONSUMER=0 关（不注入 = 全回退旧行为）。
    if (process.env.RIVET_ADVISORY_LIFT_CONSUMER !== '0') {
      this.advisoryBus.setLiftProvider(key => this.advisoryReadback.getMatureLift(key))
    }
    // T7 效力排序：让效力跨 priority 参与预算竞争（此前只在 priority 完全相等
    // 时做 tie-break，而 hook 的 priority 高度分散——实测 self-verify 采纳 77%
    // 却因 0.58 < 0.70 恒输给采纳 12% 的 todo-missing）。成熟 lift 已过样本门
    // 故满置信；回退采纳率时按决出样本数缩放，避免单样本改写优先级。
    // RIVET_ADVISORY_EFFICACY_SPAN=0 关闭调整（回退纯 priority 排序）。
    this.advisoryBus.setEfficacySignalProvider(key => {
      const lift = this.advisoryReadback.getMatureLift(key)
      if (lift !== null) return { score: (lift + 1) / 2, confidence: 1 }
      const rate = this.advisoryReadback.getAdoptionRate(key)
      if (rate === null) return null
      const decided = this.advisoryReadback.getDecidedCount(key)
      return { score: rate, confidence: Math.min(1, decided / EFFICACY_CONFIDENT_SAMPLES) }
    })
    // Phase 2 阶段抑制：产出流 = 近期编辑+验证交替且无失败（navigator 沉默规则）。
    // 只影响 encouragement/typecheck/informational 白名单——守护类不受抑制。
    // 判据本体在 production-flow.ts（EFE/affordance 的 wuwei 让位共用同一处）。
    this.advisoryBus.setFlowStateProvider(() => isInProductionFlow(this.recentToolHistory))
    this.harness = new TurnHarness(
      { maxRetries: 2, retryableClasses: ['timeout', 'flaky'] },
      this.trajectory,
      this.failureJournal,
    )
    this.pressureMonitor = new PressureMonitor(this.config.contextWindow)
    // 累加器语义是「当前历史里驻留的 CVM 字节」。任何丢弃历史消息的操作都会
    // 重置 appendix baseline，同一时刻这些字节也离开了上下文——挂在 engine 内部
    // 而非逐个调用点，两者结构上无法漂移。
    this.config.promptEngine.setOnResetAppendixBaseline(() => {
      this.pressureMonitor.resetCvmOverhead()
    })
    this.resourceSensor = new ResourceSensor(this.config.resourceSensorOptions)
    this.fsWatcher = this.config.fsWatcherEnabled === false ? null : createFsWatcher({ cwd: this.cwd })
    this.telemetryWriter = createTelemetryWriter(this.cwd, this.config.sessionId)
    this.frameRecorder = createFrameRecorder(this.cwd, this.config.sessionId)
    const sessionDir = join(getSessionDir(this.cwd), this.config.sessionId ?? 'anon')
    const pheromonesPath = join(sessionDir, 'pheromones.json')
    // 批级共享 store 优先（星河收编 #3）：同批 worker 共用内存信息素库，
    // 不各自落盘到 sessionDir。
    this.stigmergyStore = this.config.stigmergyStore ?? new StigmergyStore(pheromonesPath)

    // Initialize ArtifactStore for append-only artifact log
    if (this.config.sessionId) {
      const artifactDir = join(this.cwd, '.rivet', 'artifacts')
      this.artifactStore = new ArtifactStore(artifactDir, this.config.sessionId)
      const stateManager = new SessionStateManager(this.config.sessionId)
      this.sessionStateManager = stateManager
      this._jobs = new SessionJobs(join(artifactDir, 'jobs'), source => touchActivity(this.config.sessionId ?? 'default', source))
    }
    // MonitorRegistry 无条件创建（无会话时 getJobs 返回 undefined，subscribe 优雅降级）。
    this._monitors = new MonitorRegistry(() => this._jobs, { telemetry: this.telemetryWriter })

    this.cacheAdvisor = new CacheAdvisor({
      providerProfile: this.config.providerProfile ?? { cacheType: 'none', persistent: false },
      contextWindow: this.config.contextWindow,
    })
    // W3-C3: observe-only delay-compact decision ledger → cache-log.jsonl
    // (event:'compact_delay_decision'), same channel as per-request cache rows
    // so offline analysis joins decisions with the actual cache outcome.
    if (this.config.sessionId) {
      const sid = this.config.sessionId
      this.cacheAdvisor.setDelayDecisionListener(decision => {
        try {
          const line = JSON.stringify({ ts: Date.now(), ...decision })
          import('node:fs/promises').then(fs => {
            const dir = join(getSessionDir(this.cwd), sid)
            return fs.mkdir(dir, { recursive: true })
              .then(() => fs.appendFile(join(dir, 'cache-log.jsonl'), line + '\n'))
          }).catch(() => {})
        } catch { /* ledger is best-effort */ }
      })
    }
    // Speculative pre-execution chain SEALED by default (2026-07-07): no
    // execute callback and speculativeEnabled unset → miner still records
    // patterns, but nothing is pre-executed, cached, or served.
    // 状态更新（2026-08-07 T5a/T5b）：mtime 重启契约已实现（shadow-queue.ts），
    // 封存维持原因 = 经济性。RIVET_SPEC_OBSERVE=1 开观察态：enqueue 各臂 +
    // 命中统计活，serving 仍封存；execute 保持 no-op（观察不真预读，每条
    // 预测代价 ≈ 一次 stat）。stats 经 postSession 落 meta.speculationStats。
    this.p3 = createP3Integration({
      // P2-1 stat/归一化基准：sidecar 单进程多会话必须钉会话 cwd
      cwd: this.cwd,
      ...(process.env['RIVET_SPEC_OBSERVE'] === '1' ? { speculativeObserve: true } : {}),
    })


    // Physarum + Immune system — construction only, DB reads deferred to warmupMemories() (S9)
    const meridianDb = this.config.meridianIndexer?.getDb()
    const physarum = new PhysarumEngine(meridianDb)
    this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore, notebook: this.p3?.notebook })
    this.physarumForWarmup = physarum
    this.meridianDbForWarmup = meridianDb

    this.runtimeHooks = this.config.runtimeHooks ?? createRuntimeHooksPipeline(this)
    // P2 Wave 2: config HMR —— 非 headless 交互模式装配。配置变更（hooks.disabled）
    // 经 watcher 热更到管线，下一轮生效。缓存影响：hook 开关不动工具指纹/system
    // prompt 字节；hook 注入内容可能改变下一请求 appendix，重建一次后恢复命中。
    // 仅热更 disabled；timeoutMs/slowMs 保持启动快照。
    if (!this.config.headless) {
      this.configWatcher = watchConfigForHooks({
        cwd: this.cwd,
        // env 优先（与装配路径 resolveDisabledHookIds 同源）：RIVET_HOOKS_DISABLED
        // 是启动级约束，热更只应用 config 变更，不覆盖 env 禁用集。
        onHooksChange: hooks => this.runtimeHooks.setDisabledHookIds(resolveHookDisabledEnv() ?? hooks.disabled ?? []),
      })
    }
    this.perception = new TurnPerceptionController({
      cwd: this.cwd,
      maxTurns: this.config.maxTurns,
      runtimeHooks: this.runtimeHooks,
      telemetryWriter: this.telemetryWriter,
      getRuntimeSnapshot: extra => this.buildRuntimeSnapshot(extra),
      getProviderDegradationRatio: () => this.config.providerHealth?.getDegradationRatio() ?? 0,
      // Hook injections are pseudo-user messages: append as SR to the last
      // user message (not a new message entry) to preserve prefix cache.
      // W2-B1: K1 append-only egress — runtime hook payloads (MCTS seeds,
      // scout packets, fallback advisories) charge their bytes exactly once
      // at commit, under the 'runtime-payload' tag.
      addUserMessage: message => {
        this.session.appendSystemReminder(message)
        this.pressureMonitor.recordCvmInjection(Math.ceil(message.length / 4), 'runtime-payload')
      },
      requestThetaCheck: reason => { this.requestThetaCheck(reason) },
      setReasoningEffort: effort => { this.setReasoningEffort(effort, 'programmatic') },
      getFingerprint: () => this.config.promptEngine.getFingerprint(),
      submitControlSignal: signal => { this.controlPlane.submit(signal) },
    })
    this.intent = new TurnIntentController()
    this.contextInjection = new ContextInjectionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      getSessionId: () => this.config.sessionId,
      getTranscriptPath: () => this.config.transcriptPath,
      getSessionMemoryState: () => this.config.getSessionMemoryState?.(),
      getMessages: () => this.session.getMessages(),
      getRecentToolHistory: () => this.recentToolHistory,
      getRepairHintTracker: () => this.repairHintTracker,
      getContextClaimStore: () => this.config.contextClaimStore,
      getPlaybookStore: () => this.config.playbookStore,
      getCwd: () => this.cwd,
      advisoryBus: this.advisoryBus,
    })
    this.config.promptEngine.setOnLessonsRendered(ids => {
      try { this.config.playbookStore?.recordUsage(ids) } catch { /* non-critical */ }
    })
    this.compaction = new CompactionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      providerProfile: this.config.providerProfile,
      compactionProfile: this.config.compactionProfile,
      primaryClient: this.config.primaryClient,
      compactClient: this.config.compactClient,
      compactEnabled: this.config.compact.enabled,
      pressureMonitor: this.pressureMonitor,
      getTrajectoryEntries: () => this.trajectory.getEntries(),
      getStreamedText: () => this.streamedText,
      refreshLedger: () => { this.contextInjection.refreshLedger() },
      cacheAdvisor: this.cacheAdvisor,
      getStanceSummary: () => this.stanceTally.render(),
      persistMemories: memories => {
        const persist = this.persist
        if (!persist) return
        const createdAt = Date.now()
        for (const mem of memories) {
          persist.appendMemory({
            text: `[${mem.kind}] ${mem.text}`,
            source: 'compact',
            createdAt,
          })
        }
        // P3: hot-refresh the session-memory volatile block so memories extracted
        // during compaction are visible in THIS session's prompt — not just the
        // next session. rebuildFrozenBase defers the actual volatileBlock swap to
        // the next user message boundary, and compaction runs at turn 0, so this
        // stays prefix-cache safe. Mirrors the /remember slash-command path.
        try {
          this.config.promptEngine.updateSessionMemory(persist.buildMemoryBlock())
        } catch { /* non-critical: memories are already persisted to disk */ }
      },
      getAbortSignal: () => this.abortController?.signal,
      getActiveContract: () => this.taskContract,
      // After any compaction rewrite the historical tool_results that read-ref
      // points at may be gone — drop this session's read-dedup records so the
      // next read_file re-serves real content instead of a dangling reference.
      onHistoryRewritten: () => { invalidateSessionReadDedup(this.config.sessionId) },
      // Layered archival: persist discarded history as a recallable
      // compact-history artifact. Disk-only write, never touches the prefix.
      archiveHistory: async (input) => {
        const store = this.artifactStore
        if (!store) return null
        try {
          return await store.save({
            tool: COMPACT_HISTORY_TOOL,
            target: input.target,
            rawContent: input.rawContent,
            summary: input.summary,
            sections: input.sections,
          })
        } catch {
          return null
        }
      },
      // Recall observability: register the archive turn so recall turn-distance
      // can be computed when the model later read_sections this artifact.
      onArchive: (artifactId, turn) => {
        try { this.cacheAdvisor.registerArchive(artifactId, turn) } catch { /* non-critical */ }
        // Stash for the cache-log: the rewrite turn's entry attaches this id so
        // compaction necessity can be correlated with later recalls (consume-once).
        this.lastArchive = { id: artifactId, turn }
      },
      // Optional disaster-recovery snapshot of the full pre-compaction transcript.
      backupTranscript: (messages, turn) => {
        const persist = this.persist
        if (!persist) return
        try {
          const path = join(persist.getBackupDir(), `pre-compact-${turn}.jsonl`)
          const body = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
          writeFileSync(path, body, 'utf-8')
        } catch {
          // Snapshot is best-effort; never block compaction.
        }
      },
      // Side-path usage accounting: summary calls are billed but used to
      // discard their usage — book them into session totals + cache-log.
      // provider：专用 compact client（compact.provider+model）跑在自己的
      // provider 上，行里如实标注；未配置时回退主会话 provider（recorder 默认）。
      recordSummaryUsage: (usage, model) => {
        const provider = this.config.compactClient ? this.config.compact?.provider : undefined
        createSidePathUsageRecorder(this)('compact-summary', usage, model, provider)
      },
      onReclaimDecision: createReclaimDecisionRecorder(this),
      writeProbe: createWriteEvidenceProbe(this.cwd),
    })
    // 在 AgentLoop 构造时立即设置 prefixOverhead，关闭 UI 启动到 maybeCompact 之间的窗口。
    // 否则首次响应前 GlanceBar 显示 ctx 0%、◧ 0/1.0M（数据未接入而非真的 0%）。
    this.compaction.ensurePrefixOverhead()
    this.turnStream = this.createTurnStreamController()
    this.turnCompletion = this.createTurnCompletionController()
    this.toolExecution = this.createToolExecutionController()
    this.planTraceCoordinator = createPlanTraceCoordinator(this)
    this.compactBoundaryCoordinator = createCompactBoundaryCoordinator(this)
    this.turnOrchestrator = createTurnOrchestrator(this)
    this.turnStepProducer = createTurnStepProducer(this)
    this.reasoningEffort = createReasoningEffortController(this)
    this.intentRoute = createIntentRetrievalRouteController(this)
    this.antiAnchoring = createAntiAnchoringController(this)
    this.modelRoutingShadow = createModelRoutingShadowController(this)
    this.prewarmController = createPrewarmController(this)
    
    // 初始化 SessionPersist 用于 fuzzy checkpoint
    if (this.config.sessionId) {
      this.persist = new SessionPersist(this.config.sessionId, this.cwd)

      // P1: Initialize session metadata with model info
      this.persist.initMetadata({
        model: this.config.promptEngine.getModel(),
        cwd: this.cwd,
      })
      // R1: record cwd (cross-cwd resume gate) and reset cleanExit — the session
      // is now live, so a subsequent crash should be recoverable and a later
      // clean exit must re-mark it. Runs for both fresh and resumed sessions.
      this.persist.updateMetadata({ cwd: this.cwd, cleanExit: false })

      // P0-1: Mirror every in-memory message change to disk so non-/exit
      // shutdowns (Ctrl+C, crash, network drop) don't lose the session.
      const listener = attachSessionPersistListener({ session: this.session, persist: this.persist })
      this._persistDrain = listener.drain
    }
  }

  createTurnStreamController(): TurnStreamController {
      return createTurnStreamController(this);
  }

  createTurnCompletionController(callbacks?: AgentCallbacks): TurnCompletionController {
      return createTurnCompletionController(this, callbacks);
  }

  private createToolExecutionController(): ToolExecutionController {
      return createToolExecutionController(this);
  }
  buildRuntimeSnapshot(extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot {
      return buildRuntimeSnapshot(this, extra);
  }


  /** Capture an agent's departure mark — sealed into the starmap at session close. */
  captureLeaveMark(mark: import('../tools/types.js').LeaveMarkInput): void {
    this.pendingLeaveMark = mark
  }

  /** The pending departure mark, if the agent left one this session. */
  getPendingLeaveMark(): import('../tools/types.js').LeaveMarkInput | null {
    return this.pendingLeaveMark
  }

  /** Write a constellation milestone when plan_close applies successfully. */
  handlePlanClosed(input: import('../tools/types.js').PlanClosedInput): void {
    try {
      const domain = this.sessionDomain?.id ?? ''
      const numericId = this._sessionNumericId ?? undefined
      const mark = buildAgentMark({ symbol: VOID_SYMBOL, domain, numericId })
      const summary = `plan closed: ${input.planFile} [${input.tasks}] ${input.deliveryState}`
      const milestone = buildDepartureMilestone({
        sessionId: this.config.sessionId ?? 'anon',
        agentMark: mark,
        domain,
        summary,
        type: 'milestone',
        tags: ['plan-close'],
      })
      appendMilestone(this.cwd, milestone)
    } catch {
      // Milestone write is best-effort; must not disrupt the tool flow.
    }
  }

  /** U6/C1: seed or sync the execution trace from todo/plan_task step inputs.
   *  withPlanSteps is idempotent for first population; once history exists,
   *  only status is synced (no step insertion/removal/description changes). */
  capturePlanSteps(steps: import('../tools/types.js').PlanStepInput[]): void {
    this.planTraceCoordinator.capturePlanSteps(steps)
  }

  /**
   * 用户级验收面的声明与核销（todo 的 acceptance 字段）。这是 acceptance 义务
   * **唯一**的核销入口——它刻意不在 `applyVerificationEvent` 的自动满足集合里，
   * 跑多少测试都关不掉，只有 agent 显式回写验收结果才能关。
   *
   * 状态机：任一项 pending → 义务保持 open；有 met 但缺 evidence → 只记 attempt
   * （逼出「实际做了什么」，两次后升级为 ask_user）；有 blocked 且无 pending →
   * block（走 honest_blocked，交付时强制披露）；全部 met 且有据 → satisfy。
   */
  captureAcceptance(items: import('../tools/types.js').AcceptanceItemInput[]): void {
    if (items.length === 0) return

    // 声明落进契约：successCriteria 在 tail 区被渲染进提示词，替换默认套话。
    // 只在文本真变了才赋值——状态回写（pending→met）不该翻转提示词字节。
    const criteria = items.map(i => i.criterion)
    if (this.taskContract) {
      const prev = this.taskContract.successCriteria
      const changed = prev.length !== criteria.length || criteria.some((c, i) => c !== prev[i])
      if (changed) this.taskContract = { ...this.taskContract, successCriteria: criteria }
    }

    const ob = this.obligations.getStore().obligations.find(
      o => o.family === 'acceptance' && o.state !== 'satisfied' && o.state !== 'superseded',
    )
    if (!ob) return

    const outcome = decideAcceptanceOutcome(items)
    if (!outcome) return
    switch (outcome.kind) {
      case 'declared':
        // 留痕即可，让「请声明验收面」的 advisory 闭嘴；义务保持未决。
        this.obligations.recordAttempt(ob.id, { evidenceRef: `acceptance-declared:${criteria.length}` })
        return
      case 'missing_evidence':
        this.obligations.recordAttempt(ob.id, { failureClass: 'acceptance_no_evidence' })
        return
      case 'blocked':
        this.obligations.block(ob.id, outcome.reason)
        return
      case 'met':
        this.obligations.satisfy(ob.id, outcome.evidenceRef)
    }
  }

  /** U6: build a StepResult from the tool events recorded for a given turn. */
  private buildStepResultFromTurn(turn: number): StepResult | null {
    return this.planTraceCoordinator.buildStepResultFromTurn(turn)
  }

  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, result: string, errorClass?: ToolErrorClass, errorKind?: FailureClass): void {
      recordToolHistory(this, name, input, isError, result, errorClass, errorKind);
      // Reset convergence cooldown when the agent produces a productive tool
      // (edit/bash/test/commit/deliver). This means past convergence nudges
      // were either effective (prompted action) or irrelevant (direction was
      // fine all along) — in either case, reset the repeat counter and cooldown
      // so the next nudge starts fresh rather than escalating from a stale count.
      if (PRODUCTIVE_TOOLS.has(name)) {
        this.convergenceEmitRepeatCount = 0
        this.convergenceEmitCooldownTurns = this.convergenceEmitBaseCooldownTurns
        // B1c：turn 级产出标志,由 runConvergenceCheck 在下个 turn 边界结算
        this.turnHadProductiveTool = true
      }
      // F-fix (session 803d897d): field habituation moves discipline text out of
      // focus after ~4 turns while a heavy turn can run 20+ tool calls. Re-anchor
      // a one-line discipline summary through the advisory bus every N calls —
      // appendix-rendered, cache-safe, no frozen-prefix changes.
      this.toolCallsSinceReanchor++
      if (this.toolCallsSinceReanchor >= DISCIPLINE_REANCHOR_INTERVAL) {
        this.toolCallsSinceReanchor = 0
        this.advisoryBus.submit(disciplineReanchorEntry())
      }
  }

  recordModelRoutingShadow(currentSensorium: Sensorium, efe: EFEComponents): void {
    this.modelRoutingShadow.record(currentSensorium, efe)
  }

  bindSessionDomain(taskDescription: string, callbacks?: AgentCallbacks): void {
    if (this.sessionDomain !== undefined) return
    // 未作会话级选择时才消费持久 defaultDomain。显式 Auto 同样以
    // sessionDomain=undefined 等待首条任务，但必须越过这里进入关键词路由。
    const starSoulEnabled = isStarSoulEnabled()
    if (starSoulEnabled && this.sessionDomainSelection !== 'auto') {
      const key = this.config.defaultDomain ?? 'qiming'
      if (key !== 'auto') {
        const pinned = starDomainRegistry.get(key) ?? starDomainRegistry.get('qiming')
        if (pinned) {
          this.sessionDomain = {
            id: pinned.id as StarDomainId,
            name: pinned.name,
            volatileBlock: pinned.volatileBlock,
            motto: pinned.motto,
            courageThreshold: pinned.courageThreshold,
          }
          this.config.promptEngine.setActiveDomain(this.withDomainKnowledge(this.sessionDomain))
          this.persistSessionDomain()
          return
        }
      }
    }
    // domainKeywordRouting 默认 true：Auto 按消息在 DOMAIN_AUTO_POOL（四个均衡
    // 工程域 + 自定义域）内 matchDomain，未命中回退天权（DEFAULT_DOMAIN）；
    // 显式 false 时固定落到 DEFAULT_DOMAIN。池外特化域（含华盖）仅手动/钉定/
    // 委派进入。defaultDomain='auto' 或会话显式 Auto 走到这里，其余已钉定。
    const resolution = starSoulEnabled
      ? resolveActiveDomain(taskDescription, {
          keywordRouting: this.config.domainKeywordRouting !== false,
        })
      : null
    this.sessionDomain = resolution?.domain ?? null
    this._domainWasAutoResolved = resolution !== null
    this._driftDetector = resolution ? new DomainDriftDetector(resolution.domain.id) : null
    if (resolution) this.sessionDomainSelection = 'auto'
    this.config.promptEngine.setActiveDomain(this.withDomainKnowledge(this.sessionDomain))
    this.persistSessionDomain()
    if (resolution) {
      callbacks?.onDomainResolved?.({
        key: resolution.domain.id,
        name: resolution.domain.name,
        matchedKeywords: resolution.matchedKeywords,
        reason: resolution.reason,
      })
    }
  }

  /** 域变更即写 meta.domain——TUI /resume 恢复原域的依据（bootstrap
   *  switchAgentSession 读取；shutdown 时 buildSessionHandoff 旁另有兜底重写）。
   *  best-effort：持久化失败不阻断域切换。 */
  private persistSessionDomain(): void {
    try { this.persist?.updateMetadata({ domain: this.sessionDomain?.id }) } catch { /* best-effort */ }
  }

  /**
   * 主控会话的域经验摘要：随域绑定挂 top-3 lessons（worker 侧同源
   * buildDomainKnowledgeBlock）。与域同为会话常量、同一时机构建 → 一起进
   * FROZEN 前缀，不引入 per-turn 变化。
   */
  private withDomainKnowledge(domain: ActiveStarDomain | null): (ActiveStarDomain & { knowledgeBlock?: string }) | null {
    if (!domain || !this.config.domainKnowledgeStore) return domain
    try {
      const block = buildDomainKnowledgeBlock(this.config.domainKnowledgeStore, domain.id, { maxLessons: 3 })
      return block ? { ...domain, knowledgeBlock: block } : domain
    } catch {
      return domain
    }
  }

  abort(): void {
    this._turnInterruptCount++
    this._pendingAbort = true
    this.abortController?.abort()
    // NOTE: killAll() removed — it was a global hammer that killed processes
    // from ALL AgentLoop instances, not just this one (中间层 #1).
    // 范围化进程清理由「协作式取消」实现，而非全局硬锤：abortController 是
    // 本实例独有的，abort() 翻转其信号 → 经 tool-pipeline 透传到本实例正在跑的
    // 工具（bash/run_tests 已监听 params.abortSignal，立即 killProcessTree 自身子进程）。
    // 因信号按实例隔离，中止本实例绝不会波及另一实例的子进程（双实例隔离）。
    // 进程的最终兜底清理仍由 main.tsx 退出路径的 killAllSync() 负责。
  }

  /**
   * Synchronously persist pending debounced memory stores. Called from the exit
   * path (main.tsx shutdownCallback) so deposits inside the 200ms debounce
   * window survive Ctrl+C / shutdown. Best-effort: never throw on the exit path.
   */
  flushStigmergySync(): void {
    try {
      this.stigmergyStore.flushSync()
    } catch {
      // exit-path persistence is best-effort; a failure must not block exit
    }
    try {
      this.config.domainKnowledgeStore?.flushSync()
    } catch {
      // exit-path persistence is best-effort; a failure must not block exit
    }
  }

  /**
   * System-initiated abort (hard-stall watchdog) — breaks a wedged turn
   * WITHOUT incrementing `_turnInterruptCount`. That counter feeds the
   * recovery-trigger's "repeatedly interrupted" classification (see
   * refreshReliabilityDecision); a watchdog stall-recovery is not a user
   * interrupt and must not be mislabeled as one, especially when combined
   * with a genuine earlier interrupt in the same run.
   */
  abortStalledTurn(): void {
    this._watchdogAborted = true
    this.abortController?.abort()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
    // Mirror into the prompt engine so the permission note tracks the live mode.
    // The note lives in the dynamic appendix — the frozen base is untouched, so
    // a mid-session toggle costs one appendix delta, not a full prefix rebuild.
    this.config.promptEngine.setApprovalMode(mode)
  }

  /** C3 — current checkpoint interval for status displays. */
  getCheckpointInterval(): number {
    return this.config.checkpointEveryTurns ?? 0
  }

  /** Return the current session permission overlay, initializing if needed. */
  private getPermissionOverlay(): PermissionOverlay {
    if (!this.config.permissionsOverlay) {
      this.config.permissionsOverlay = createPermissionOverlay()
    }
    return this.config.permissionsOverlay
  }

  addAllowRule(rule: PermissionAllowRule): void {
    this.getPermissionOverlay().allow.push(rule)
  }

  addDenyRule(rule: PermissionAllowRule): void {
    this.getPermissionOverlay().deny.push(rule)
  }

  addBashAllowPrefix(prefix: string): void {
    const overlay = this.getPermissionOverlay()
    if (!overlay.bashAllow.includes(prefix)) overlay.bashAllow.push(prefix)
  }

  addBashDenyPrefix(prefix: string): void {
    const overlay = this.getPermissionOverlay()
    if (!overlay.bashDeny.includes(prefix)) overlay.bashDeny.push(prefix)
  }

  removePermissionRule(
    kind: 'allow' | 'deny' | 'bashAllow' | 'bashDeny',
    indexOrPattern: number | string,
  ): boolean {
    const overlay = this.getPermissionOverlay()
    if (kind === 'allow' || kind === 'deny') {
      const list = overlay[kind]
      if (typeof indexOrPattern === 'number') {
        if (indexOrPattern < 0 || indexOrPattern >= list.length) return false
        list.splice(indexOrPattern, 1)
        return true
      }
      const idx = list.findIndex(r => r.tool === indexOrPattern)
      if (idx === -1) return false
      list.splice(idx, 1)
      return true
    }
    const list = overlay[kind]
    if (typeof indexOrPattern === 'number') {
      if (indexOrPattern < 0 || indexOrPattern >= list.length) return false
      list.splice(indexOrPattern, 1)
      return true
    }
    const idx = list.indexOf(indexOrPattern)
    if (idx === -1) return false
    list.splice(idx, 1)
    return true
  }

  resetPermissionOverlay(): void {
    this.config.permissionsOverlay = createPermissionOverlay()
  }

  /** Attach a GoalTracker to the current run. Owned by AgentLoop; the
   *  orchestrator reads it via deps.getGoalTracker (no longer a field on
   *  TurnOrchestrator), severing the loop→orchestrator back-edge that
   *  getDoomLoopLevel/isGoalActive used to traverse. */
  setGoalTracker(tracker: import('./goal-tracker.js').GoalTracker | null): void {
    this.goalTracker = tracker
  }

  /** Expose the goal tracker for deps wiring (orchestrator reads via getter). */
  getGoalTracker(): import('./goal-tracker.js').GoalTracker | null {
    return this.goalTracker
  }

  /** Check if goal tracker is active (for doom-loop threshold selection). */
  isGoalActive(): boolean {
    return this.goalTracker?.isActive() ?? false
  }

  /**
   * Single source of truth for the abort reason passed to onAbort(). Encodes
   * whether the current abort was a watchdog hard-stall (vs. a user Ctrl+C) and,
   * for watchdog stalls during a goal run, tags `watchdog:goal` so the UI can
   * auto-recover/continue instead of treating it as a user interrupt. Used by
   * every onAbort emission site (turn-orchestrator deps + turn-step-producer)
   * so the encoding stays consistent across abort paths.
   */
  abortReason(): string | undefined {
    if (!this._watchdogAborted) return undefined
    return this.isGoalActive() ? 'watchdog:goal' : 'watchdog'
  }

  /** Sync plan-mode state into config so tool-pipeline reads it */
  syncPlanModeToConfig(): void {
    this.config.planModeState = this.planModeState
    this.config.activePlanFilePath = this.activePlanFilePath
    this.config.askModeState = this.askModeState
    this.config.promptEngine.setPlanModeState(this.planModeState)
    this.config.promptEngine.setActivePlanFilePath(this.activePlanFilePath)
    this.config.promptEngine.setAskModeState(this.askModeState)
    // 落盘到 session meta——resume 后计划模式可恢复（内存态否则随进程消失）。
    // 所有状态迁移(enter/exit/setActivePlan)都经本方法,单点持久化。
    try {
      this.persist?.updateMetadata({
        planModeState: this.planModeState,
        activePlanFilePath: this.activePlanFilePath,
        askModeState: this.askModeState,
      })
    } catch { /* best-effort */ }
  }

  /**
   * source 分流（2026-07-25 advisory-ecology-repair W1）：
   * 只有用户路径（/effort 斜杠命令、CLI、桌面端设置）才动 userReasoningOverride；
   * 程序化路径（perception strategy effort、autoReasoning 档位调整）只透传
   * reasoningEffort.set()。此前程序化调用每轮把 override 置真，
   * 自会话第 2 轮起永久架空关键词 autoReasoning（用户从未 /effort 却被当作已手动设置）。
   */
  setReasoningEffort(
    effort: import('./auto-reasoning.js').ReasoningEffort | 'auto',
    source: 'user' | 'programmatic' = 'user',
  ): void {
    if (effort === 'auto') {
      // 用户显式选 auto → autoReasoning 接管后续每轮 effort，清除 override 标志。
      if (source === 'user') this.userReasoningOverride = false
      return
    }
    if (source === 'user') this.userReasoningOverride = true
    // 用户已显式选档（/effort max 等）→ 程序化调整（perception strategy、
    // autoReasoning 档位）不得覆盖，保护显式用户意图。
    if (source === 'programmatic' && this.userReasoningOverride) return
    this.reasoningEffort.set(effort)
  }

  shadowEffortTelemetry(
    ruleBaseline: string,
    overrides?: { errorRate?: number; isRepeat?: boolean },
  ): void {
    this.reasoningEffort.shadowTelemetry(ruleBaseline, overrides)
  }

  getEffortDelta(): number | null {
    return this.reasoningEffort.getDelta()
  }

  getReasoningEffort(): import('./auto-reasoning.js').ReasoningEffort | undefined {
    return this.reasoningEffort.get()
  }

  updateSessionMemory(block: string): void {
    this.config.promptEngine.updateSessionMemory(block)
  }

  /**
   * 应用工具门控后的定义集 — 构造期之外（MCP/LSP 注册刷新、逃生口挂载）的唯一过滤入口。
   * 复用 createAgentConfig 同款 gateToolDefinitions，确保 updateTools 不会把 EXTENDED 工具
   * 整个还原（历史 bug：MCP/LSP 初始化后 updateTools 拉全量 → 门控被毫秒内覆盖）。
   */
  private gatedToolDefinitions(): import('../api/types.js').ToolDefinition[] {
    const all = this.config.toolRegistry.getDefinitions()
    const gating = this.config.toolGating
    // 描述档位：优先读会话启动期冻结的快照（config.blockPolicy）——长驻进程里
    // 进程级 memo 会被新会话创建时 invalidate，live 读会让描述从 compact 回弹
    // 成 full，system 字节中途翻转 → 整段前缀缓存 miss。快照缺省（手工构造
    // config 的测试路径）才回退 live 解析。
    const toolDescriptions = (this.config.blockPolicy
      ?? resolvePromptBlocks(this.config.cwd ?? process.cwd())).toolDescriptions
    if (!gating) return applyDescriptionMode(all, toolDescriptions)
    return gateToolDefinitions(all, {
      enabled: gating.enabled,
      coreOverride: gating.coreOverride,
      extraCore: gating.extraCore,
      domainTier: gating.domainTier,
      mountedExtras: [...this.mountedExtras],
      disabledTools: gating.disabledTools,
      toolDescriptions,
    })
  }

  updateTools(): void {
    this.config.promptEngine.updateTools(this.gatedToolDefinitions())
  }

  /** 当前主控实际可见的工具名（已应用门控 + 运行时挂载）。 */
  getActiveToolNames(): string[] {
    return this.gatedToolDefinitions().map(d => d.name)
  }

  /**
   * 逃生口：把一个 EXTENDED 工具临时挂回主控（在 turn 边界由 slash 命令触发）。
   *
   * 代价：挂载会改变 staticCtx.tools 的 fingerprint，对 exact-prefix 缓存的 provider
   * （deepseek-native / anthropic-cache-control）造成一次性全前缀缓存失效；'none' provider 无代价。
   *
   * @returns 结构化结果，供 UI 渲染（status + 缓存影响）
   */
  enableTool(name: string): {
    status: 'mounted' | 'already-active' | 'not-extended' | 'unknown' | 'gating-off'
    cacheImpact: 'prefix-invalidated' | 'none'
    prefixCacheStrategy: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  } {
    const strategy = this.config.prefixCacheStrategy ?? 'none'
    const cacheImpact: 'prefix-invalidated' | 'none' =
      strategy === 'none' ? 'none' : 'prefix-invalidated'

    // 门控未开 → 全量本就可见，无需挂载
    if (!this.config.toolGating || !this.config.toolGating.enabled) {
      return { status: 'gating-off', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // 工具必须真实注册
    if (!this.config.toolRegistry.getDefinitions().some(d => d.name === name)) {
      return { status: 'unknown', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // 仅 EXTENDED 工具需要逃生口；非 EXTENDED（CORE/MCP/LSP）默认已可见
    if (!isExtendedTool(name)) {
      return { status: 'not-extended', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // 已挂载 → 幂等
    if (this.mountedExtras.has(name)) {
      return { status: 'already-active', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    this.mountedExtras.add(name)
    this.updateTools()
    return { status: 'mounted', cacheImpact, prefixCacheStrategy: strategy }
  }

  getTrajectoryStats(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
    return this.trajectory.summarize()
  }

  getTrajectoryEntries(): import('./trajectory.js').TrajectoryEntry[] {
    return this.trajectory.getEntries()
  }

  resetTrajectory(): void {
    this.trajectory.reset()
  }

  getTraceStore(): TraceStore { return this.traceStore }

  getEvidenceState() { return this.evidence.getState() }

  getVerificationSummary() { return this.evidence.getVerificationSummary() }

  /** @deprecated Mode is now auto-detected from message content via isActionableTurn. */
  setPromptMode(_mode: string): void {
    // No-op: mode detection is automatic. Kept for backward compat with slash commands.
  }

  /** @deprecated Always returns 'task' — chat/task binary no longer exists. */
  getPromptMode(): string {
    return 'task'
  }

  /** Get the active domain (null = disabled/unavailable, undefined = not yet
   * resolved, including an explicit Auto selection waiting for its next task). */
  // ── 星域胶囊（消息级注入记账，≤2 枚）──────────────────────
  // 胶囊正文经消息流注入（/capsule → submitToAgent），与 recall_capsule 同
  // cache-safe 纪律：索引常驻冻结前缀（<seed-capsules> 一行/星），正文只进
  // 消息。本状态仅做并发上限记账与命令回显，不触碰 promptEngine/persist——
  // 正文已在会话历史不可撤回，上限防的是方法论叠加噪音；agent 重建后清零是
  // 正确语义（历史里的胶囊内容仍对模型生效）。
  static readonly MAX_CAPSULES = 2
  private _activeCapsuleStars: string[] = []

  listCapsules(): string[] {
    return [...this._activeCapsuleStars]
  }

  noteCapsuleInjection(star: string): { ok: true } | { ok: false; error: string } {
    if (this._activeCapsuleStars.includes(star)) return { ok: false, error: `${star} 胶囊已在生效中` }
    if (this._activeCapsuleStars.length >= AgentLoop.MAX_CAPSULES) {
      return { ok: false, error: `胶囊已达上限（${AgentLoop.MAX_CAPSULES} 枚，当前 ${this._activeCapsuleStars.join(' + ')}）。先 /capsule off 摘除一枚——过多方法论叠加会稀释主域身份` }
    }
    this._activeCapsuleStars.push(star)
    return { ok: true }
  }

  /** 摘除记账：胶囊正文已在消息历史不可撤回，此处只解除上限占用与回显。 */
  clearCapsule(star: string): { ok: true } | { ok: false; error: string } {
    const idx = this._activeCapsuleStars.indexOf(star)
    if (idx === -1) return { ok: false, error: `${star} 未在胶囊生效名单中` }
    this._activeCapsuleStars.splice(idx, 1)
    return { ok: true }
  }

  getSessionDomain(): ActiveStarDomain | null | undefined {
    return this.sessionDomain
  }

  /** Manually set the active star domain. Pass null to disable, or a valid ActiveStarDomain. */
  setSessionDomain(domain: ActiveStarDomain | null): void {
    this.sessionDomainSelection = 'manual'
    this._domainWasAutoResolved = false
    this._driftDetector = null
    this.sessionDomain = domain
    this.config.promptEngine.setActiveDomain(this.withDomainKnowledge(domain))
    this.persistSessionDomain()
  }

  /** Reset domain to undefined so the next run() will auto-detect from user input. */
  resetSessionDomain(): void {
    this.sessionDomainSelection = 'auto'
    this._domainWasAutoResolved = false
    this._driftDetector = null
    this.sessionDomain = undefined
    this.config.promptEngine.setActiveDomain(undefined)
    this.persistSessionDomain()
  }

  /** Restore a previously resolved Auto session without re-routing or
   * re-emitting onDomainResolved. Unlike manual selection, drift observation
   * remains active for subsequent turns. */
  restoreAutoResolvedDomain(domain: ActiveStarDomain): void {
    this.sessionDomainSelection = 'auto'
    this._domainWasAutoResolved = true
    this._driftDetector = new DomainDriftDetector(domain.id)
    this.sessionDomain = domain
    this.config.promptEngine.setActiveDomain(this.withDomainKnowledge(domain))
    this.persistSessionDomain()
  }

  /**
   * Completed-turn count for this session. Used to detect a mid-session
   * star-domain switch (>0 → switching now invalidates the prefix cache and
   * forces a full context rebuild at the next request, ~10x cost).
   */
  getSessionTurnCount(): number {
    return this.session.getTurnCount()
  }

  get domainWasAutoResolved(): boolean {
    return this._domainWasAutoResolved
  }

  get driftDetector(): DomainDriftDetector | null {
    return this._driftDetector
  }

  /**
   * PlusMenu — per-session disabled skill names. Filters the skill discovery
   * block (turn-step-producer) so disabled skills are hidden from the model.
   * Empty set = all skills available (default).
   */
  private _disabledSkills: Set<string> = new Set()

  /** Replace the per-session disabled skill set (desktop skill toggle). */
  setDisabledSkills(names: Set<string>): void {
    this._disabledSkills = new Set(names)
  }

  /** Read the per-session disabled skill set (consumed by turn-step-producer). */
  getDisabledSkills(): Set<string> {
    return this._disabledSkills
  }

  /** Mark a skill as explicitly invoked so its instructions survive compaction. */
  markSkillInvoked(name: string): void {
    this.config.promptEngine.markSkillInvoked(name)
  }

  /** Release an invoked skill so its instructions are no longer re-injected. */
  markSkillCompleted(name: string): void {
    this.config.promptEngine.markSkillCompleted(name)
  }

  getLatestPheromones() { return this.loadedPheromones }

  /** Expose MeridianIndexer for /index command */
  getIndexer() { return this.config.meridianIndexer ?? null }

  getDecisions(): string[] { return this.decisions }

  getContextLayerReport() { return this.config.promptEngine.getContextLayerReport() }

  getDoomLoopLevel(): 'none' | 'warn' | 'blocked' {
    // Goal-active mode uses relaxed thresholds to avoid false doom-loop triggers
    // during long autonomous tasks where repeated tool types are legitimate.
    const thresholds = getDoomLoopThresholds(this.goalTracker?.isActive() ?? false)
    return combineDoomLoopLevels(
      getDoomLoopLevel(this.traceStore.toolFingerprints, thresholds.exact),
      getClassDoomLoopLevel(this.traceStore.bashClassFingerprints ?? [], thresholds.class),
    )
  }

  getReliabilityDecision(): ReliabilityDecision | null { return this.latestReliabilityDecision }

  private sessionPersistPath(): string | undefined {
    return this.persist?.getFilePath()
  }

  refreshReliabilityDecision(): void {
    // User override: RIVET_RELIABILITY_OVERRIDE=full disables all reliability
    // locks. Use when the agent is permanently locked by a non-self-resolving
    // condition (e.g. orphan tool_use blocks) and you accept the risk.
    if (process.env.RIVET_RELIABILITY_OVERRIDE === 'full') {
      this.latestReliabilityDecision = null
      return
    }

    this.latestResourceSnapshot = this.resourceSensor.sample(this.sessionPersistPath())
    const disk = this.latestResourceSnapshot.disk
    const trigger = classifyRecoveryTrigger({
      interrupt: {
        interruptCountThisTurn: this._turnInterruptCount,
        hasPendingTools: this.detectPendingTools(),
        turn: this.session.getTurnCount(),
      },
      doomLoop: {
        doomLoopLevel: this.getDoomLoopLevel(),
        recentFingerprints: this.traceStore.toolFingerprints.slice(-20),
        uniqueFingerprintCount: new Set(this.traceStore.toolFingerprints.slice(-20)).size,
      },
      thrashing: {
        compactionTurns: this.pressureMonitor.getCompactionTurns(),
        currentTurn: this.session.getTurnCount(),
        consecutiveCompactFailures: this.compactFailures.consecutiveFailures,
        estimatedTokens: this.session.getEstimatedTokens(),
        contextWindow: this.config.contextWindow,
        lastCompactFailed: this.compactFailures.consecutiveFailures > 0,
      },
      integrity: this.computeSessionIntegrity(),
      resourcePressure: {
        rssBytes: this.latestResourceSnapshot.memory.rssBytes,
        heapUsedBytes: this.latestResourceSnapshot.memory.heapUsedBytes,
        memoryLimitBytes: this.latestResourceSnapshot.memory.memoryLimitBytes,
        sessionBytes: disk?.sessionBytes ?? 0,
        sessionByteLimit: disk?.sessionByteLimit ?? Number.POSITIVE_INFINITY,
        memoryTrendBytesPerSample: this.latestResourceSnapshot.memoryTrendBytesPerSample,
        suppressAbsoluteMemoryPressure: this.latestResourceSnapshot.memoryCooldownActive,
      },
    })

    this.latestReliabilityDecision = modeForRecoveryTrigger(
      trigger,
      this.isGoalActive(),
      this.firedRecoveryTriggers,
    )

    // Track triggers that fire at error severity for one-shot suppression.
    // Add AFTER modeForRecoveryTrigger so the first occurrence reaches full
    // severity (e.g. minimal). Subsequent occurrences are then capped at
    // degraded by modeForRecoveryTrigger's suppressedTriggers check.
    if (trigger && trigger.severity === 'error' && trigger.trigger) {
      this.firedRecoveryTriggers.add(trigger.trigger)
    }

    // 资源压力 TUI 提醒：只展示、不自动改任何配置（用户自行 /lean 或开新会话）。
    // 其他 trigger 或资源恢复时清除之前设置的状态行（仅当本会话设置过，避免
    // 覆盖 StatusLineRunner 命令模式的状态行）。
    const pressureText = trigger?.trigger === 'resource_pressure'
      ? this.buildResourcePressureStatusLine()
      : null
    if (pressureText !== null) {
      if (!this.resourceStatusLineActive || this.resourceStatusLineText !== pressureText) {
        this.config.onStatusLine?.(pressureText)
        this.resourceStatusLineActive = true
        this.resourceStatusLineText = pressureText
      }
    } else if (this.resourceStatusLineActive) {
      this.config.onStatusLine?.(null)
      this.resourceStatusLineActive = false
      this.resourceStatusLineText = null
    }
  }

  /** 资源压力状态行文本：heap ≥75% warn / ≥90% error、disk ≥80% warn /
   *  ≥100% error（阈值与 classifyResourcePressure 一致）；cooldown 期间
   *  （跨会话内存残差）只报 disk。纯展示——不自动改任何配置。 */
  private buildResourcePressureStatusLine(): string | null {
    const snap = this.latestResourceSnapshot
    if (!snap) return null
    const { memory, disk } = snap
    const heapRatio = memory.memoryLimitBytes > 0 ? memory.heapUsedBytes / memory.memoryLimitBytes : 0
    const suppressHeap = snap.memoryCooldownActive === true
    if (!suppressHeap) {
      if (heapRatio >= 0.9) {
        return `⚠ Memory CRITICAL ${Math.round(heapRatio * 100)}% — open new session with RIVET_LEAN=1 recommended`
      }
      if (heapRatio >= 0.75) {
        return `⚠ Memory ${Math.round(heapRatio * 100)}% — session may slow down, /lean to reduce`
      }
    }
    if (disk && disk.sessionByteLimit > 0) {
      const diskRatio = disk.sessionBytes / disk.sessionByteLimit
      if (diskRatio >= 1) return '⚠ Session log FULL — events will be trimmed, checkpoint now'
      if (diskRatio >= 0.8) {
        return `⚠ Session log ${formatBytes(disk.sessionBytes)} — near limit, checkpoint recommended`
      }
    }
    return null
  }

  /** 最近一次经 onStatusLine 推送的资源压力状态行（非 null 表示会话曾设置过）。 */
  private resourceStatusLineText: string | null = null
  private resourceStatusLineActive = false

  /** 中#5: Check for tool_calls that have no matching tool_result. */
  private detectPendingTools(): boolean {
    const msgs = this.session.getMessages()
    const pendingIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) pendingIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        pendingIds.delete(msg.tool_call_id)
      }
    }
    return pendingIds.size > 0
  }

  /** 中#5: Compute session integrity snapshot for recovery trigger.
   *
   * 2026-09-08 fix: mirror the request builder's OAI preflight instead of
   * counting the raw in-memory list. The builder repairs orphans by inserting
   * synthetic tool_results, so integrity classification must see the same
   * repaired list — otherwise an already-healed turn is still judged broken
   * and the user gets demoted to minimal reliability mode.
   */
  private computeSessionIntegrity() {
    const preflight = runResumePreflightOai(this.session.getMessages(), {
      writeProbe: createWriteEvidenceProbe(this.cwd),
    })
    const msgs = preflight.messages
    const toolCallIds = new Set<string>()
    const toolResultIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id)
      }
    }
    return {
      orphanToolUseCount: [...toolCallIds].filter(id => !toolResultIds.has(id)).length,
      orphanToolResultCount: [...toolResultIds].filter(id => !toolCallIds.has(id)).length,
      wasRepaired: preflight.repaired,
      syntheticResultsInserted: preflight.syntheticResultsInserted,
      messageCount: msgs.length,
    }
  }

  requestThetaCheck(reason: string): void {
      if (this.config.thetaCheckDisabled) return
      requestThetaCheck(this, reason);
  }

  /** Theta 一次一结果回调（controller host 接口）——落 meta 摘要。
   *  事件循环饥饿无法同线程硬抢占，验收目标是「无重复 spawn、结果可归因」：
   *  每次尝试都有唯一 outcome，超预算（timeoutOverrunMs > 0）可见。 */
  onThetaResult(result: import('./theta-check.js').ThetaCheckResult, budgetMs: number): void {
    const t = this.thetaTelemetry
    try {
      this.persist?.updateMetadata({
        thetaCheckSummary: {
          attempts: t.requestedCount,
          outcomes: t.outcomes,
          lastOutcome: result.outcome,
          lastDurationMs: result.durationMs,
          suppressedCount: t.suppressedCount,
          consecutiveTimeouts: t.consecutiveTimeouts,
          budgetMs,
          timeoutOverrunMs: result.durationMs > budgetMs ? result.durationMs - budgetMs : undefined,
        },
      })
    } catch { /* meta 摘要是观测辅助 — 永不阻断 */ }
  }

  /** Physarum provider health: feed stream outcomes into the tracker.
   *  Success slowly warms the provider; failure rapidly cools it (4x asymmetry).
   *  Degradation ratio is consumed by sensorium stability; cold tiers are
   *  skipped by coordinator worker routing. */
  recordProviderOutcome(ok: boolean): void {
    const health = this.config.providerHealth
    const providerId = this.config.providerName
    if (!health || !providerId) return
    health.registerProvider(providerId)
    if (ok) health.recordSuccess(providerId)
    else health.recordFailure(providerId)
  }

  getLatestRisk(): import('./approval-risk.js').RiskAssessment { return this.latestRisk }

  /** Latest free-energy policy signals (EFE + sensorium) for downstream routing. */
  getPolicySignals(): { efe: EFEComponents; sensorium: Sensorium } | undefined {
    return this.latestPolicySignals
  }

  /** Enter plan mode — only read-only tools allowed. Clears any stale approved-plan pointer. */
  enterPlanMode(opts?: { planFilePath?: string }): void {
    // Idempotent re-entry: already planning with a live draft and no explicit
    // target → keep the current draft. Creating a fresh one would orphan the
    // file the agent is incrementally writing to.
    if (this.planModeState === 'planning' && this.activePlanFilePath && !opts?.planFilePath) {
      return
    }
    // Mutual exclusion with Ask Mode — enter plan exits ask silently.
    if (this.askModeState === 'asking') {
      this.askModeState = 'off'
      try { this.onAskModeChange?.('off') } catch { /* non-fatal */ }
    }
    this.planModeState = 'planning'
    // P2 plan advisory 去重键随生命周期清空——新的 planning 语境允许新建议。
    this.structureFlowPlanAdvisoryKeys.clear()
    // Re-entering cancels any pending exit reminder from a prior exit.
    this.config.promptEngine.setPlanExitReminderPending(false)
    this.config.promptEngine.setActivePlan(null)
    // Re-entering plan mode is the unmount point for the <plan-executing>
    // advisory (execution completion has no mechanical signal — the block
    // stays mounted until the next planning cycle begins).
    this.config.promptEngine.setPlanExecutingBlock(null)

    const cwd = this.cwd
    if (opts?.planFilePath) {
      this.activePlanFilePath = opts.planFilePath.replace(/\\/g, '/')
    } else {
      this.activePlanFilePath = createActivePlanDraftPath()
      const abs = join(cwd, this.activePlanFilePath)
      mkdirSync(dirname(abs), { recursive: true })
      if (!existsSync(abs)) writeFileSync(abs, '', 'utf-8')
    }
    this.syncPlanModeToConfig()
    // 主动 plan mode 链路：带活跃任务契约进入时，注入一次性并行调研 advisory。
    // 主控自主决定切分（不硬派）——advisory 只给方法与素材（scope 文件分组提示）。
    // 优先使用 DisciplineEligibility.requiresEngineeringDiscipline，回退到 isActionable。
    const isEngineeringTask = this.latestCognitiveSnapshot?.requiresEngineeringDiscipline ?? this.taskContract?.isActionable
    if (isEngineeringTask) {
      const files = this.taskContract?.scope.mentionedFiles ?? []
      const fileHint = files.length > 0
        ? `契约 scope 内已提到的文件（可按此分组）：${files.slice(0, 12).join(', ')}${files.length > 12 ? ` …（共 ${files.length} 个）` : ''}。`
        : ''
      this.advisoryBus.submit({
        key: 'plan-scout-parallel',
        priority: 0.7,
        category: 'delegation',
        content: `已进入计划模式且有活跃任务契约。多模块任务先并行调研再写计划：用 \`delegate_batch\` 一次并行派 2-4 个只读 \`code_scout\`（按模块/文件域切分，每个 scout 给独立的调研目标），汇总发现后再写计划。${fileHint}单模块小任务可跳过并行直接调研。`,
        ttl: 2,
        expect: { kind: 'tool_appears', tools: ['delegate_batch'], withinTurns: 2 },
        channel: 'system-reminder',
      })
    }
    try { this.onPlanModeChange?.('planning') } catch { /* non-fatal */ }
  }

  /** Exit plan mode — user approved, all tools allowed */
  exitPlanMode(): void {
    this.planModeState = 'off'
    // P2 plan advisory 去重键随生命周期清空。
    this.structureFlowPlanAdvisoryKeys.clear()
    this.config.promptEngine.setPlanExitReminderPending(true)
    this.releasePlanModeArtifacts()
    this.syncPlanModeToConfig()
    try { this.onPlanModeChange?.('off') } catch { /* non-fatal */ }
  }

  /**
   * Shared plan-mode teardown: drop the draft pointer (removing the draft file
   * when it is still empty, so toggling in and out doesn't litter .rivet/plans/).
   */
  private releasePlanModeArtifacts(): void {
    const draft = this.activePlanFilePath
    this.activePlanFilePath = null
    if (draft && /\/draft-\d+\.md$/.test(draft.replace(/\\/g, '/'))) {
      try {
        const abs = join(this.cwd, draft)
        if (existsSync(abs) && readFileSync(abs, 'utf-8').trim() === '') rmSync(abs)
      } catch { /* best-effort cleanup */ }
      // Drop the draft from the task ledger so it is never treated as an owned
      // file at delivery/commit time. The draft is a transient planning artifact;
      // the canonical plan lives in .rivet/plans/<slug>.md once submitted.
      this.config.taskLedger?.removeEventsByPath(draft)
    }
  }

  /**
   * Set (or clear) the approved-plan pointer. Injects a tiny slug/title/path
   * reminder into the dynamic appendix — NOT the plan body (which stays on disk).
   * Approving releases plan mode (state→off) so execution tools are unblocked.
   * Cache-safe: the pointer never enters the frozen base.
   */
  setActivePlan(plan: { slug: string; title: string; selectedApproach?: string } | null): void {
    if (!plan) {
      this.config.promptEngine.setActivePlan(null)
      // Clears the <plan-executing> advisory — re-entering plan mode (or an
      // explicit clear) unmounts it. Execution completion has no mechanical
      // signal, so the block intentionally stays mounted until then.
      this.config.promptEngine.setPlanExecutingBlock(null)
      return
    }
    this.config.promptEngine.setActivePlan(formatActivePlanPointer(plan))
    // Mount the native executing-plans replacement for the approved-plan
    // execution window (cache-safe dynamic appendix).
    this.config.promptEngine.setPlanExecutingBlock(renderPlanExecutingBlock())
    // 层3 重构回归契约：计划带「回归清单」章节时灌入 task contract，
    // deliver_task 交付前对清单逐项 grep 核验（事故链缺口 3）。best-effort。
    // 层4 计划约束（D8 L2）：反目标/待验证假设随计划批准灌入契约，派发时兜底注入。
    try {
      const planContent = readFileSync(join(this.cwd, '.rivet', 'plans', `${plan.slug}.md`), 'utf-8')
      const inventory = extractRegressionInventory(planContent)
      if (inventory.length > 0 && this.taskContract) {
        this.taskContract = { ...this.taskContract, regressionInventory: inventory }
      }
      const planConstraints = renderPlanConstraints(extractPlanConstraints(planContent), `${plan.slug}.md`)
      if (planConstraints.length > 0 && this.taskContract) {
        this.taskContract = { ...this.taskContract, planConstraints }
      }
    } catch { /* best-effort: 清单/约束灌入失败不影响计划批准 */ }
    const wasPlanning = this.planModeState === 'planning'
    this.planModeState = 'off'
    if (wasPlanning) this.config.promptEngine.setPlanExitReminderPending(true)
    this.releasePlanModeArtifacts()
    this.syncPlanModeToConfig()
    if (wasPlanning) { try { this.onPlanModeChange?.('off') } catch { /* non-fatal */ } }
  }

  /** Get current plan mode state */
  getPlanModeState(): PlanModeState { return this.planModeState }

  /** Enter Ask Mode — pure read-only Q&A. Mutually exclusive with Plan Mode. */
  enterAskMode(): void {
    if (this.askModeState === 'asking') return
    // Mutual exclusion with Plan Mode — enter ask exits plan (with exit reminder).
    if (this.planModeState === 'planning') {
      this.planModeState = 'off'
      this.config.promptEngine.setPlanExitReminderPending(true)
      this.releasePlanModeArtifacts()
      try { this.onPlanModeChange?.('off') } catch { /* non-fatal */ }
    }
    this.askModeState = 'asking'
    this.syncPlanModeToConfig()
    try { this.onAskModeChange?.('asking') } catch { /* non-fatal */ }
  }

  /** Exit Ask Mode — restore normal tool access. */
  exitAskMode(): void {
    if (this.askModeState === 'off') return
    this.askModeState = 'off'
    this.syncPlanModeToConfig()
    try { this.onAskModeChange?.('off') } catch { /* non-fatal */ }
  }

  getAskModeState(): AskModeState { return this.askModeState }

  /** Relative path to the active plan file while in plan mode. */
  getActivePlanFilePath(): string | null { return this.activePlanFilePath }

  getPrewarmStats(): { hits: number; misses: number; hitRate: number } { return this.prewarm.stats() }

  getPhysarumShadowStats(): PhysarumShadowStats {
    return getPhysarumShadowStatsFromDb(this.meridianDbForWarmup)
  }

  getCacheDiagnostic(): string | null { return this.lastCacheDiagnostic }

  refreshCacheDiagnostic(turn: number): void {
    this.lastCacheDiagnostic = this.compaction.refreshCacheDiagnostic(turn)
  }

  /** Estimated token count for the current conversation (live, for desktop ctx-bar). */
  getEstimatedTokens(): number {
    return this.session.getEstimatedTokens()
  }

  /** Session-scoped background job registry (undefined in anon/no-session mode). */
  get jobs(): import('../tools/job-store.js').SessionJobs | undefined {
    return this._jobs
  }

  /** Session-scoped monitor registry (always present; degrades without jobs). */
  get monitors(): import('./monitor-registry.js').MonitorRegistry | undefined {
    return this._monitors
  }

  /** Replace the background job registry. The server injects an instance it owns
   *  (subscribed for SSE + REST). Any prior self-created jobs are terminated. */
  setJobs(jobs: import('../tools/job-store.js').SessionJobs): void {
    if (this._jobs && this._jobs !== jobs) {
      try { this._jobs.killAll() } catch { /* best-effort */ }
    }
    this._jobs = jobs
  }

  /** Real context-window occupancy (anchor on last API prompt_tokens + tail
   *  estimate) — for display only. See SessionContext.getRealOccupancy. */
  getRealOccupancy(): number {
    return this.session.getRealOccupancy()
  }

  /** Observe-only recall stats for compacted-history artifacts (for /context).
   *  Cheap delegate — avoids the heavier getDebugInfo() build. */
  getRecallSummary(): RecallMetricsSummary {
    return this.cacheAdvisor.getRecallSummary()
  }

  /** Model context window size in tokens. */
  getContextWindow(): number {
    return this.config.contextWindow
  }

  getLedger() { return this.session.getContextLedger() }

  getCognitiveSnapshot(): CognitivePhaseSnapshot | undefined { return this.latestCognitiveSnapshot }

  getTaskContract(): TaskContract | undefined { return this.taskContract }

  /** W5（incident 20b9714e）：session_vitals 工具的数据源。全部为运行时
   *  内存态实测，零磁盘 IO；拿不到的维度返回 null，工具层显式标注"无数据"。 */
  getSessionVitals(): import('../tools/session-vitals.js').SessionVitalsData {
    const estimatedTokens = this.session.getEstimatedTokens()
    const contextWindow = this.config.contextWindow
    const statsMap = this.advisoryReadback.getStats()
    const top = [...statsMap.entries()]
      .map(([key, s]) => ({
        key,
        delivered: s.delivered,
        adopted: s.adopted,
        ignored: s.ignored,
        silenced: this.advisoryBus.isEfficacySilenced(key),
      }))
      .sort((a, b) => b.delivered - a.delivered)
      .slice(0, 5)
    const s = this.sensorium
    let runtime: import('./runtime-self-model.js').RuntimeSelfModel | null = null
    try {
      const coordinator = this.config.coordinatorRef?.()
      if (coordinator) {
        const verification = this.evidence.getVerificationSummary()
        runtime = buildRuntimeSelfModel({
          phase: this.planModeState,
          turn: this.session.getTurnCount(),
          contextRatio: contextWindow > 0 ? estimatedTokens / contextWindow : 1,
          sensorium: s ? {
            pressure: s.pressure,
            confidence: s.confidence,
            stability: s.stability,
          } : null,
          verificationDebt: verification.total > 0
            ? verification.pending / verification.total
            : (this.evidence.hasVerificationDebt() ? 1 : 0),
          coordinator: coordinator.getRuntimeSnapshot(),
        })
      }
    } catch {
      // session_vitals is diagnostic; a missing coordinator must never break it.
      runtime = null
    }
    return {
      ctx: {
        estimatedTokens,
        contextWindow,
        ratio: contextWindow > 0 ? estimatedTokens / contextWindow : 1,
      },
      cache: this.session.getCacheHistory().slice(-5),
      sensorium: s ? {
        momentum: s.momentum, pressure: s.pressure, confidence: s.confidence,
        complexity: s.complexity, freshness: s.freshness, stability: s.stability,
      } : null,
      cvm: {
        overheadRatio: this.pressureMonitor.getCvmOverheadRatio(),
        throttled: this.pressureMonitor.isCvmThrottling(),
        ceiling: this.pressureMonitor.isCvmThrottlingCeiling(),
      },
      advisories: {
        rendered: this.guardianActivity.advisoriesRendered,
        dropped: this.guardianActivity.advisoriesDropped,
        adopted: this.guardianActivity.advisoriesAdopted,
        ignored: this.guardianActivity.advisoriesIgnored,
        top,
      },
      runtime,
      turn: this.session.getTurnCount(),
    }
  }

  /** 获取持久化的任务列表（从 Assistant 回复中提取），用于 TUI 固定显示和多轮回溯 */
  getTaskList() { return this.sessionStateManager?.getTaskList() ?? [] }

  addAnchor(kind: ContextAnchor['kind'], text: string): void {
    this.contextInjection.addAnchor(kind, text)
  }

  getFileHistory() { return this.config.fileHistory }

  /** Book a side-path request's usage into session totals + the cache-log.
   *  Side paths are billed like any other call, and silently discarding their
   *  usage was a real cost blind spot (2026-07-06). `kind` keeps the sources
   *  distinguishable in `cache-log.jsonl`. */
  recordSidePathUsage(kind: string, usage: Partial<import('../api/types.js').Usage>, model?: string, provider?: string): void {
    createSidePathUsageRecorder(this)(kind, usage, model, provider)
  }

  /** 本会话 frozen 前缀的分块归因（`/prefix-budget`）。档位来自会话启动时
   *  解析的策略——中途改配置不会反映在这里，正如它也不会反映在前缀里。 */
  getPrefixBudget(): { profile: string; toolDescriptions: string; report: import('../prompt/prefix-budget.js').PrefixBudgetReport } {
    const policy = this.config.blockPolicy ?? resolvePromptBlocks(this.config.cwd ?? process.cwd())
    return {
      profile: policy.profile,
      toolDescriptions: policy.toolDescriptions,
      report: buildBudgetReport(this.config.promptEngine.getPrefixBudgetInputs()),
    }
  }

  getDebugInfo() {
    const fp = this.config.promptEngine.getFingerprint()
    const sysPrompt = this.config.promptEngine.getSystemPrompt()
    return { fingerprint: fp, drift: this.config.promptEngine.checkDrift(),
      systemPromptLength: sysPrompt.length,
      systemPromptPreview: sysPrompt.slice(0, 200) + (sysPrompt.length > 200 ? '...' : ''),
      toolCount: this.config.toolRegistry.getDefinitions().length,
      toolNames: this.config.toolRegistry.getDefinitions().map(t => t.name),
      volatilePayloadReport: this.config.promptEngine.getVolatilePayloadReport(this.recentToolHistory),
      cacheAdvisor: this.cacheAdvisor.getDiagnostic() }
  }

  /** Drain pending async persist writes — public for /cd pre-migration
   *  (moving session files while a queued append is in flight would recreate
   *  a dangling jsonl at the old path). */
  async drainPersistWrites(): Promise<void> {
    await this._persistDrain?.()
  }

  async runPostSession(callbacks: AgentCallbacks): Promise<void> {
    // P0-1: drain pending async persist writes so tool results survive abort/Ctrl+C.
    await this._persistDrain?.()
    await this.runtimeHooks.runPostSession(createRuntimeHookContext(this.buildRuntimeSnapshot(),
      { emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) } }))
    if (this.config.sessionRegistry) {
      try { this.config.sessionRegistry.cleanupOldEvents(2 * 60 * 60 * 1000) } catch { /* ignore */ }
    }
    this.flushAdvisoryEfficacy()
    try { this.immuneHook.getPhysarum().save() } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveImmuneMemories(this.immuneHook.exportMemories())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      // notebook 默认停用（见 p3-integration.ts）——停用时不落盘，也不清空旧表
      //（清空交给 memory-epoch reset，保持"停用≠销毁"语义以便复活）。
      if (db && this.p3.notebook) db.saveMistakeEntries(this.p3.notebook.getAllEntries())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveToolPatternMinerSnapshot(this.p3.miner.exportSnapshot())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) {
        db.saveBanditState('bandit:reasoning_effort', this.p3.serializeEffortBandit())
        // model_style bandit sealed (zero production callers). Its state was
        // saved/restored every session but never consulted for a decision.
        db.saveBanditState('p3:plan_cache', this.p3.serializePlanCache())
      }
    } catch { /* non-critical */ }
    try {
      // 会话内 /handoff（或人工编辑）已产出更新的交接文档时，结构化摘要不覆盖——
      // 自动 handoff 只是「会话内没做手动交接」的兜底（shouldAutoWriteHandoff）。
      const sp = this.persist
      const handoffMtime = sp && existsSync(sp.getHandoffPath()) ? statSync(sp.getHandoffPath()).mtimeMs : null
      if (sp && shouldAutoWriteHandoff(handoffMtime, this.createdAtMs)) {
        const handoffText = this.compaction.buildSessionHandoff()
        sp.writeHandoff(handoffText)
      }
      if (sp) {
        const domainId = this.sessionDomain?.id
        if (domainId) sp.updateMetadata({ domain: domainId })
      }
    } catch { /* ignore */ }
    // Sink compact-history recall stats into the (gated) sensorium channel.
    // Observe-only: collects turn-distance data for a future adaptive-window
    // decision; it does NOT influence compaction thresholds today.
    try {
      this.telemetryWriter.write({ kind: 'recall-summary', ...this.cacheAdvisor.getRecallSummary() })
    } catch { /* telemetry is best-effort */ }
    // Speculation source stats → session meta. Written unconditionally of the
    // RIVET_DEBUG_TELEMETRY gate so the "should llmSpeculation default on"
    // decision has cross-session hit-rate evidence. Only written when at least
    // one source saw activity — idle sessions don't grow their meta files.
    try {
      const stats = this.p3.queue.statsBySource()
      const hasActivity = Object.values(stats).some(s => s.enqueued > 0 || s.hits > 0)
      if (hasActivity) this.persist?.updateMetadata({ speculationStats: stats })
    } catch { /* meta 摘要是观测辅助 — 永不阻断 */ }
    // LLM speculation engine call counters → meta. speculationStats.llm only
    // counts shadow-queue enqueued/hits; without fired/errors there is no
    // on-disk evidence of how many speculative API calls actually happened
    // (2026-07-06 cost blind spot fix).
    try {
      const engineStats = this.llmSpeculationEngine?.stats()
      if (engineStats && engineStats.fired > 0) {
        this.persist?.updateMetadata({ llmSpeculationEngine: engineStats })
      }
    } catch { /* meta 摘要是观测辅助 — 永不阻断 */ }
    // Obligation final gate 遥测（Wave 3 心流保护）：auto-continue 触发率与
    // 误触发率的原始计数。误触发率 >20% 时优先怀疑 task kind 分类而非调低
    // 风险阈值（计划纪律）。有活动才写，闲置会话不长 meta。
    try {
      const og = this.obligationGateStats
      if (og.continued > 0 || og.misfires > 0 || og.honestBlocked > 0 || og.suppressed > 0) {
        this.persist?.updateMetadata({ obligationGate: og })
      }
    } catch { /* meta 摘要是观测辅助 — 永不阻断 */ }
    // todo 退回计数 → meta。detectRegressions 是本仓唯一的结果侧探测器（模型是否
    // 守得住自己的任务状态），此前触发只进一条工具结果就丢了，退回率无从跨会话取。
    // 与上面几项同规格：绕过 debug 门，有写入才写，闲置会话不长 meta。
    try {
      const todoStats = (this.config.getTodoRegressionStats ?? getTodoRegressionStats)()
      if (todoStats.writes > 0) {
        // 实验臂随计数一起落盘。没有它这些计数无法分组——两个臂的会话混在一起，
        // 退回率就只是个总体数字，回答不了「decisions 通道有没有用」。
        this.persist?.updateMetadata({
          todoRegressions: todoStats,
          decisionsArm: resolveDecisionsArm(this.config.sessionId),
        })
      }
    } catch { /* meta 摘要是观测辅助 — 永不阻断 */ }
  }

  async startFsWatcher(): Promise<void> {
    try {
      await this.fsWatcher?.start()
    } catch {
      // fs.watch is an opportunistic external signal; unavailable watchers must not block turns.
    }
  }

  stopFsWatcher(): void {
    this.fsWatcher?.stop()
    this.latestFsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  }

  /** 释放 config 热载 watcher。configWatcher 生命周期=实例（构造期装配，无
   *  per-run start/stop），因此只能在整个 AgentLoop 被丢弃时关闭（/model、
   *  /resume、/cd 三条 switch 路径统一纪律，与 stopFsWatcher 同源调用）——
   *  不能并入 stopFsWatcher（那个每轮 run() 的 finally 都会跑，会把热载在
   *  第一条用户消息后关死）。不关则旧实例的 watcher 僵尸存活，继续回调死
   *  管线的 setDisabledHookIds。 */
  stopConfigWatcher(): void {
    try { this.configWatcher?.close() } catch { /* best-effort */ }
    this.configWatcher = null
  }

  isRunning(): boolean {
    return this._running
  }

  async run(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<AgentRunOutcome> {
    // Re-entry guard: prevent concurrent agent.run() calls.
    // React strict mode or rapid re-submits could trigger handleSubmit
    // while a previous run is still in-flight, corrupting SessionContext.
    // Claim the guard synchronously before any await (including the
    // cancelIdleCompaction drain) so a duplicate run() that arrives during the
    // drain sees _running=true and no-ops instead of racing _runInner.
    //
    // 返回 'skipped' 而非静默 return：调用方（TUI）在此之前已把自己置为 busy，
    // 若这里无声无息地走掉，busy 就再没人清——用户按 ESC 后立刻发的消息会落进
    // 一个没有活跃 run 的队列里，永远等不到注入边界。调用方据此复位并如实告知。
    if (this._running) {
      debugLog('[agent] run() called while already running — skipping duplicate')
      return 'skipped-already-running'
    }
    this._running = true
    // Eager abort controller: created synchronously before any await (incl. the
    // cancelIdleCompaction() drain below) so an Esc/Ctrl+C during the init/warmup
    // window aborts a live signal instead of a no-op. Pending latch is cleared
    // for this fresh run. cancelIdleCompaction only aborts the idle controller
    // and its finally nulls abortController only when it === idleAbort, so this
    // fresh user-turn controller survives the drain untouched.
    this._pendingAbort = false
    this._watchdogAborted = false
    this.abortController = new AbortController()
    // W3：每轮用户输入开始时重置 system-reminder 计数器（每轮最多 1 条）。
    this.session.resetSrCount()
    // Cancel + drain any pending/in-flight idle compaction before mutating the
    // session, so the user turn never races idle history rewrites. Awaiting the
    // settle is correct (not a stall): the idle abort makes the in-flight pass
    // bail at its next checkpoint; replaceMessages itself is synchronous so the
    // session is always in a consistent state at the await boundary.
    try {
      await this.cancelIdleCompaction()

      // 视觉副驾：先把本轮图片寄存进 registry（无论主控是否多模态），供 ask_image
      // 反复追问。id 顺序与 images 顺序一致。纯内存、不进 prompt/落盘。
      const registeredIds = images && images.length > 0 ? this.imageRegistry.register(images) : []

      // Vision bridge: when the primary model is text-only but a dedicated
      // multimodal model is configured, describe the images and prepend the
      // description to the user prompt so the primary model still receives
      // the visual information. 多模态主控则跳过桥接——images 照常进 oaiMessages 原生识图，
      // 同时已寄存进 registry 供 ask_image 复用（v4 变多模态后自动走这条路）。
      if (images && images.length > 0 && !this.config.supportsVision && this.config.visionClient) {
        // 桥接失败不得炸整轮：视觉模型超时/报错/返回空，都降级为一条可见提示，
        // 让主控知道"有图但没读到"而非静默吞图或整轮 failed。原因落 debugLog。
        // 缓存键必须按**原始** userInput 归类（与 describeImages 内部的模式判定同源）——
        // userInput 下面会被 prepend 改写，故先算好键再改写。
        const firstDescKey = visionCacheKey(undefined, this.config.visionModelPrompt, userInput)
        try {
          const description = await describeImages(this.config.visionClient, images, {
            prompt: this.config.visionModelPrompt,
            // 随图文本用于自动切通用/精确转写模式（用户没显式配 prompt 时）：
            // "这个报错怎么回事[图]" → 精确 OCR 转写，避免泛泛描述丢掉报错行。
            accompanyingText: userInput,
            maxTokens: this.config.visionModelMaxTokens,
            signal: this.abortController.signal,
          })
          if (description) {
            userInput = `[图片描述]\n${description}\n\n${userInput}`
            // 首描述写入首图缓存，供 ask_image 同角度追问命中零调用。
            const firstId = registeredIds[0]
            if (firstId) {
              this.imageRegistry.cacheDescription(firstId, firstDescKey, description)
            }
          } else {
            userInput = `[图片桥接提示] 用户发送了 ${images.length} 张图片，但识图模型返回空描述——`
              + `请告知用户重发或检查识图模型配置。\n\n${userInput}`
            debugLog('[vision] bridge returned empty description')
          }
        } catch (err) {
          const reason = (err as Error)?.message ?? String(err)
          userInput = `[图片桥接失败] 用户发送了 ${images.length} 张图片，但识图桥接出错（${reason}）——`
            + `请告知用户识图暂不可用，可检查 agent.visionModel 配置或稍后重试。\n\n${userInput}`
          debugLog(`[vision] bridge error: ${reason}`)
        }
        // text-only 主控：图已转描述，从 prompt parts 去掉（原图仍在 registry 供二次看）。
        images = undefined
      }

      await this._runInner(userInput, callbacks, images)
      return 'completed'
    } finally {
      this._running = false
      this.scheduleIdleCompaction()
    }
  }

  /**
   * Schedule a debounced idle compaction pass. Called from run()'s finally so
   * it only ever arms after at least one turn. The timer is unref'd so it never
   * keeps the TUI/sidecar process alive. Disabled when discretionary compaction
   * is off (worker sessions) or via RIVET_IDLE_COMPACTION=0.
   */
  scheduleIdleCompaction(): void {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null }
    if (!this.config.compact?.enabled) return
    if (process.env['RIVET_IDLE_COMPACTION'] === '0') return
    const delayMs = Number(process.env['RIVET_IDLE_COMPACTION_MS']) || IDLE_COMPACTION_DELAY_MS
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      if (this._running) return
      void this.runIdleCompaction()
    }, delayMs)
    this._idleTimer.unref?.()
  }

  /**
   * Cancel a scheduled idle timer and abort + await any in-flight idle
   * compaction. Resolves only once the session is safe to mutate again.
   */
  async cancelIdleCompaction(): Promise<void> {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null }
    if (this._idleCompacting && this._idleAbort) this._idleAbort.abort()
    if (this._idleSettled) { try { await this._idleSettled } catch { /* settled */ } }
  }

  /**
   * 闲时压缩生效门槛 = provider 策略的 compact 档（cache-preserving 0.86 /
   * balanced 0.78 / aggressive 0.70），可用 RIVET_IDLE_COMPACTION_RATIO 覆盖。
   *
   * 语义：闲时**只做下一轮用户边界铁定要做的重压缩**（纯时间挪移，零额外信息
   * 损失）。旧门槛 0.5 对齐的是陈旧轮截断地板——用户离开一小会旧轮工具输出就
   * 被提前截断且不可逆（「闲时压缩吃掉上下文」投诉的根因）；50–compact 档区间
   * 的渐进降压留给用户边界在正常门控（缓存健康延迟等）下决定。
   */
  private idleCompactionMinRatio(): number {
    const override = Number(process.env['RIVET_IDLE_COMPACTION_RATIO'])
    if (Number.isFinite(override) && override > 0 && override <= 1) return override
    return compactPolicyRatios(this.config.providerProfile).compact
  }

  /**
   * Run a single turn-0-equivalent compaction pass while idle. Reuses the full
   * boundary ladder (session split → maybeCompact → T9 → stale → heap, plus
   * pending-flag drain) at turn=0 semantics — prefix-cache safe, identical to
   * what the next user turn would run, just paid during idle time.
   *
   * 触发语义 = 「重压缩时间挪移 + 递延债清算」：ratio 达到 compact 档（下一轮
   * 反正要做重压缩）才主动跑；mid-turn 递延的 pendingStale/pendingHeap 债不论
   * ratio 都清算。不在闲时做 50% 档的主动陈旧轮截断。
   */
  async runIdleCompaction(): Promise<void> {
    if (this._running || this._idleCompacting) return
    if (!this.config.compact?.enabled) return
    const ctxWindow = this.config.contextWindow ?? 1_000_000
    const ratio = this.session.getEstimatedTokens() / ctxWindow
    const minRatio = this.idleCompactionMinRatio()
    if (!this.pendingStaleCompact && !this.pendingHeapCompact && ratio < minRatio) return

    this._idleCompacting = true
    const idleAbort = new AbortController()
    this._idleAbort = idleAbort
    // Point the shared abort accessor at the idle controller so the compaction
    // ladder (and its LLM stream) is cancellable via cancelIdleCompaction().
    this.abortController = idleAbort
    this._idleSettled = (async () => {
      try {
        debugLog(`[idle-compact] starting (ratio=${ratio.toFixed(2)} gate=${minRatio.toFixed(2)} pendingStale=${this.pendingStaleCompact} pendingHeap=${this.pendingHeapCompact})`)
        await this.compactBoundaryCoordinator.runCompaction(0, null)
      } catch (e) {
        debugLog(`[idle-compact] error: ${(e as Error)?.message}`)
      }
    })()
    try {
      await this._idleSettled
    } finally {
      this._idleCompacting = false
      this._idleSettled = null
      this._idleAbort = null
      if (this.abortController === idleAbort) this.abortController = null
    }
  }

  /** Load cross-session history off the construction path (S9). Idempotent. */
  async warmupMemories(): Promise<void> {
    if (this.memoriesWarmed) return
    this.memoriesWarmed = true
    // Cross-session learning load: config.crossSessionEnabled (default true) activates it.
    // Env RIVET_NO_CROSS_SESSION=1 overrides as force-off.
    if (!this.config.crossSessionEnabled) return
    if (process.env.RIVET_NO_CROSS_SESSION === '1' || process.env.RIVET_NO_CROSS_SESSION === 'true') return
    const db = this.meridianDbForWarmup
    if (!db) return
    loadSessionMemories({
      db,
      physarum: this.physarumForWarmup,
      immuneHook: this.immuneHook,
      p3: this.p3,
    })
  }

  /**
   * T2-02 Track A2: Apply bandit delta to a base reasoning effort.
   *
   * Wired into the live effort selection path. Protected by three gates:
   *   1. effortBanditEnabled flag (default false) — checked in getEffortDelta()
   *   2. Consistency-promotion gate (totalPulls ≥ 30, agreement ≥ 0.8)
   *   3. reasoningFloor still enforced (resolveEffortDelta clamp)
   *
   * When any gate is closed, returns baseEffort unchanged — zero behavior delta.
   */
  applyEffortDelta(baseEffort: string): string {
    return this.reasoningEffort.applyDelta(baseEffort)
  }

  /**
   * P3 认知帧：turn 边界的**单一装配点**——loop 控制路径上唯一直读
   * sensorium / latestPolicySignals / PAL / evidence 做控制用途的位置。
   * 全部事实先进 frame（含质量语义），控制器输入由 frame 投影导出。
   * frame 恒产出（EFE 缺失时 quality.efe='missing'）；纯组装，无 IO。
   */
  private assembleBoundaryFrame(
    turn: number,
    phaseClass: string,
    todoCompletedDelta: number,
    userMessageConsumed: boolean,
  ): CognitiveFrame {
    // flow 信号复用 P1 的 computeFlowBeacon。窗口取整个保留历史（容量 5，
    // ≤ 各 tier signalWindow），与 detector 内部 slice(-signalWindow) 对
    // 5 条历史的结果一致——不引入第二个窗口语义。
    const momentumHasData = this.sensorium
      ? (this.sensorium.quality?.momentum ?? 'measured') !== 'no-data'
      : false
    const beacon = this.sensorium && momentumHasData
      ? computeFlowBeacon({
        momentum: this.sensorium.momentum,
        momentumHasData,
        stability: this.sensorium.stability,
        recentToolHistory: this.recentToolHistory,
        todoCompletedDelta,
        signalWindow: Math.max(1, this.recentToolHistory.length),
      })
      : null

    // 连续失败：工具历史尾部连续 failed（running 在途样本跳过不断链，
    // 与 P1 flow beacon 的 settled-only 口径一致）。
    let consecutiveFailures = 0
    for (let i = this.recentToolHistory.length - 1; i >= 0; i--) {
      const status = this.recentToolHistory[i]!.status
      if (status === 'failed') consecutiveFailures++
      else if (status === 'success') break
    }

    // 验证债务判据统一走 EvidenceTracker.hasVerificationDebt()（W3 单一口径，
    // self-verify 债龄计数共用），语义不变：验证失败过或未验证编辑 ≥3。
    // 不用「存在任何未验证编辑」——正常的编辑→验证节奏会瞬时经过该状态，
    // 拿它 hardTighten 等于取消 P1 对健康构建流的保护。
    const gateState = this.evidence.getGateState()
    const hasVerificationDebt = this.evidence.hasVerificationDebt()

    return assembleCognitiveFrame({
      turn,
      phaseClass,
      efe: this.latestPolicySignals?.efe ?? null,
      sensorium: this.sensorium
        ? { momentum: this.sensorium.momentum, momentumHasData, stability: this.sensorium.stability }
        : null,
      flow: {
        score: beacon?.score ?? null,
        sampleCount: beacon?.sampleCount ?? 0,
        requiredSamples: FLOW_MIN_SAMPLES,
      },
      pal: this.problemAttack.snapshotForCvm(),
      evidence: {
        hasVerificationDebt,
        deliveryStatus: this.evidence.getState().deliveryStatus,
        consecutiveFailures,
      },
      user: { intervened: userMessageConsumed },
      // 控制器语义的「活跃计划上下文」在投影层展开为 activePlanFile ||
      // planning（projectStructureFlowInputs）；detector 的
      // progressBeacons.activePlan 保持只看批准计划文件，两个语义不混用。
      plan: { activePlanFile: this.activePlanFilePath !== null, planModeState: this.planModeState },
      progress: { todoCompletedDelta },
    })
  }

  async runConvergenceCheck(
    turn: number,
    phaseClass: string,
    assistantResponded: boolean,
    userMessageConsumed: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    action: 'proceed' | 'abort'
  }> {
    // Fix 3 — the user just intervened this turn, so any pre-intervention
    // "hesitation" (no-tool) streak is broken: zero it before evaluation so a
    // stale streak can't drive a spurious stagnation/abort right after the user
    // speaks. (Turn-start and tool-use paths reset this elsewhere; this covers
    // mid-run steer injection.)
    if (userMessageConsumed) {
      this.consecutiveNoToolTurns = 0
      // 缺口 C 意图锚点:steer 注入 = 用户刚重申过意图,stale 计时重置
      this.lastUserInputRunTurn = turn
      // P2 plan advisory：用户刚说话 = 新语境，允许重新建议（去重键清空）。
      this.structureFlowPlanAdvisoryKeys.clear()
    }

    // W1 — 阶段相对轮数：phase 切换即重置基线，文案与判定引用的是"本阶段"
    // 的轮数而非会话全局计数。
    if (phaseClass !== this.lastConvergencePhaseClass) {
      this.lastConvergencePhaseClass = phaseClass
      this.phaseStartTurn = turn
    }
    const phaseRelativeTurn = Math.max(1, turn - this.phaseStartTurn + 1)

    // W1 — 进度信标：todo 完成数在近窗口内的增量。todo 推进是最硬的
    // "未停滞"证据，交给 detector 做 L2+ 否决。
    let todoCompletedNow = 0
    try {
      todoCompletedNow = (this.config.getTodos ?? getTodos)().filter(t => t.status === 'completed').length
    } catch { /* beacon is advisory-only — never break the convergence check */ }
    this.todoCompletedSamples.push(todoCompletedNow)
    if (this.todoCompletedSamples.length > 10) this.todoCompletedSamples.shift()
    const todoCompletedDelta = todoCompletedNow - (this.todoCompletedSamples[0] ?? todoCompletedNow)

    // W3 — 诊断态识别：只读为主 + 零改动的排查会话，收敛文案分流为
    // "先核实断言再收束"（催"输出结论"是 20b9714e 三次脑补的直接诱因）。
    const activityMode = classifyActivityMode(
      this.recentToolHistory,
      this.evidence.getState().filesModified.size,
    )

    // B1c/M4：turn 边界结算上一轮产出 → 维护连续产出计数;达 N 轮且有未清
    // 警告时清台账（镜像下方 userMessageConsumed 清账路径）。清账后若再触发
    // L3,走"先警告一轮再熔断"的 grace-turn,而不是拿陈旧警告直接 abort。
    this.productiveTurnStreak = this.turnHadProductiveTool ? this.productiveTurnStreak + 1 : 0
    this.turnHadProductiveTool = false
    if (this.lastConvergenceEmitLevel >= 2 && this.productiveTurnStreak >= this.convergenceWarningClearProductiveTurns) {
      debugLog(`[convergence] turn=${turn} prior-warning cleared (${this.productiveTurnStreak} productive turns since emit)`)
      this.lastConvergenceEmitTurn = -Infinity
      this.lastConvergenceEmitLevel = 0
      this.lastConvergenceMsgKey = ''
      this.lastConvergenceEmitVerifyFailStreak = 0
    }

    // Grace-turn precondition for the score abort: a convergence warning at L2+
    // must have been delivered in a strictly earlier turn, so the model had at
    // least one turn to act on the guidance. Captured before this turn's kick
    // emission updates the fields and passed into evaluateConvergence so the
    // detector's scoreAbort decision uses the same signal as loop.ts.
    const warnedInEarlierTurn = this.lastConvergenceEmitLevel >= 2
      && this.lastConvergenceEmitTurn < turn

    // P3 认知帧：先装配 turn 边界事实帧（单一装配点），再投影出 P2 控制器
    // 输入。EFE 质量非 measured → 投影 null → latestStructureFlow=null，
    // 与 P2「EFE 缺失 → 旧行为」路径逐字节一致。
    // P2 阴阳调度：互斥仲裁——快照合格（非 missing-data）时只传
    // structureRelaxation、不传 flowInputs（同一 flow 信号绝不计两次）。
    this.latestCognitiveFrame = this.assembleBoundaryFrame(turn, phaseClass, todoCompletedDelta, userMessageConsumed)
    const structureFlowInputs = projectStructureFlowInputs(this.latestCognitiveFrame)
    this.latestStructureFlow = structureFlowInputs
      ? computeStructureFlowControl(structureFlowInputs)
      : null
    const structureRelaxation = this.latestStructureFlow !== null
      && !this.latestStructureFlow.reasons.includes('missing-data')
      ? this.latestStructureFlow.relaxation
      : null

    // W4 噪音洪流修复：计算最近工具调用中 status='failed' 的占比。
    // 高错误率时收敛检测器降级——agent 在绕工具 bug 不是 doom-loop。
    // transient 失败（pointer-guard 等格式瞬错）被排除：模型下轮即可修正。
    const toolErrorWindow = this.recentToolHistory.slice(-10)
    const recentToolErrorRatio = toolErrorWindow.length > 0
      ? toolErrorWindow.filter(h => h.status === 'failed' && !h.transient).length / toolErrorWindow.length
      : 0

    // Sanitize history for convergence detector: transient guard failures
    // (pointer-guard rejections, etc.) are format-level mistakes the model fixes
    // next turn — not competence failures. Reclassify them as 'success' so they
    // don't drag down computeErrorPenalty and trigger false stagnation signals.
    const sanitizedHistory = this.recentToolHistory.map(h =>
      h.status === 'failed' && h.transient ? { ...h, status: 'success' as const } : h)

    const convergenceCheck = evaluateConvergence({
      turn,
      phaseClass: phaseClass as PhaseClass,
      phaseRelativeTurn,
      scoreHistory: this.convergenceScoreHistory,
      contextWindow: this.config.contextWindow,
      recentToolHistory: sanitizedHistory,
      evidenceState: this.evidence.getState(),
      toolFingerprints: this.traceStore.toolFingerprints,
      noToolTurnCount: this.consecutiveNoToolTurns,
      textFingerprints: this.recentTextFingerprints,
      providerName: this.config.providerName,
      outputTokens: this.session.getTotalUsage().output_tokens,
      repeatCount: this.convergenceEmitRepeatCount,
      priorWarningAtL2Plus: warnedInEarlierTurn,
      progressBeacons: {
        todoCompletedDelta,
        activePlan: this.activePlanFilePath !== null,
        // P2 快照合格 → 单声源接管软阈值；否则 P1 心流保护：Sensorium 原始
        // 快照三字段透传——工具成功率与推进因子由 detector 内部按
        // tier.signalWindow 计算（窗口与其它信号一致）。Sensorium 缺失 →
        // 不传 → 不进入保护态，旧行为不变。P3 起从认知帧投影取数（单一
        // 装配点），字段与旧直读逐位一致。
        ...(structureRelaxation !== null ? { structureRelaxation } : (this.latestCognitiveFrame?.facts.sensorium ? {
          flowInputs: { ...this.latestCognitiveFrame.facts.sensorium },
        } : {})),
      },
      activityMode,
      recentToolErrorRatio,
    })
    this.latestConvergenceResult = convergenceCheck
    // P3 Wave 3 / P3-D：认知帧回放遥测。full 记录（facts 全量，可回放重算）
    // 默认落会话目录 frames.jsonl（独立通道，RIVET_FRAME_TELEMETRY=0 可关）；
    // lite 摘要（<200B）继续走 sensorium.jsonl。recorder 关闭时连记录构建
    // 也跳过。写失败绝不阻断 loop。
    try {
      if (this.frameRecorder.enabled) {
        this.frameRecorder.write(buildCognitiveFrameRecord(this.latestCognitiveFrame, this.latestStructureFlow, convergenceCheck))
      }
      this.telemetryWriter.write(buildCognitiveFrameLiteRecord(this.latestCognitiveFrame, this.latestStructureFlow, convergenceCheck))
    } catch { /* telemetry is diagnostics-only */ }
    // Maintain rolling score history for L3 decline-trend detection (sliding window ≤ 20)
    this.convergenceScoreHistory.push(convergenceCheck.score)
    if (this.convergenceScoreHistory.length > 20) this.convergenceScoreHistory.shift()
    debugLog(`[convergence] turn=${turn} score=${convergenceCheck.score.toFixed(2)} level=${convergenceCheck.level} phase=${phaseClass}`)

    if (convergenceCheck.shouldKick && convergenceCheck.injectedMessage) {
      // Fix 3 — user-interaction reset. When the user just spoke/intervened this
      // turn, the agent has already handed control back (the "right" convergence
      // outcome). Reset the cooldown and skip emitting a nudge this turn so we
      // don't nag right after the user starts acting. (An agent that ends a turn
      // by asking the user a question also lands here on the next turn, since the
      // user's answer arrives as a consumed message.)
      if (userMessageConsumed) {
        this.lastConvergenceEmitTurn = -Infinity
        this.lastConvergenceEmitLevel = 0
        this.lastConvergenceMsgKey = ''
        this.lastConvergenceEmitVerifyFailStreak = 0
      } else {
        // Fix 1 — cooldown + dedup gate on the visible side-effects. The message
        // type is keyed by its header line, so same-type nudges with only changed
        // diagnostic numbers do not count as a new "direction". Skip the
        // "（第 N 次同类提醒…）" progressive prefix: it varies per emission and
        // must not make a repeat look like a direction change (that would reset
        // the cooldown and re-emit every turn — the exact spam this gate exists
        // to stop).
        const msgKey = convergenceCheck.injectedMessage.split('\n')
          .find(l => l.length > 0 && !l.startsWith('（第')) ?? ''
        const cooldownElapsed = turn - this.lastConvergenceEmitTurn >= this.convergenceEmitCooldownTurns
        const scoreDropped = this.lastConvergenceEmitScore - convergenceCheck.score > 0.15
        const cooledDown = cooldownElapsed || scoreDropped
        const escalated = convergenceCheck.level > this.lastConvergenceEmitLevel
        const changedDirection = msgKey !== this.lastConvergenceMsgKey
        // 第四突破条件（2026-07-04 触发面修复）：验证失败流水加深 = 排查轮次
        // 正在膨胀，是最尖锐的"需要改道"信号——不等冷却到期，提前发射。
        // 与 CCR P7 同信号源（computeVerifyFailStreak），语义失败才计入。
        const verifyFailStreak = computeVerifyFailStreak(this.recentToolHistory)
        const verifyFailEscalated = verifyFailStreak >= 2 && verifyFailStreak > this.lastConvergenceEmitVerifyFailStreak
        if (cooledDown || escalated || changedDirection || verifyFailEscalated) {
          // Backoff: if the same message variant fires again, double the cooldown
          // (3→6→12→24…). Reset to base when direction changes or level escalates.
          if (changedDirection || escalated) {
            this.convergenceEmitRepeatCount = 0
            this.convergenceEmitCooldownTurns = this.convergenceEmitBaseCooldownTurns
          } else {
            this.convergenceEmitRepeatCount += 1
            this.convergenceEmitCooldownTurns = this.convergenceEmitBaseCooldownTurns * (1 << Math.min(this.convergenceEmitRepeatCount, 5))
          }
          this.lastConvergenceEmitTurn = turn
          this.lastConvergenceEmitLevel = convergenceCheck.level
          this.lastConvergenceMsgKey = msgKey
          this.lastConvergenceEmitVerifyFailStreak = verifyFailStreak
          this.lastConvergenceEmitScore = convergenceCheck.score
          // B1c：新警告要求 N 轮全新产出才可清账——发射即重置计数
          this.productiveTurnStreak = 0
          this.turnHadProductiveTool = false

          // Level 2: inject user guidance as a system-visible nudge
          callbacks.onPhaseChange?.('convergence-warning', {
            reason: `收敛检测 L${convergenceCheck.level}: ${phaseClass} 阶段近 ${phaseRelativeTurn} 轮进度信号弱 (score=${convergenceCheck.score.toFixed(2)})`,
            suggestion: convergenceCheck.injectedMessage.slice(0, 200),
          })
          // R4 — externalize the convergence nudge as a structured course-correction
          // so the desktop renders a "改道" card; the injected guidance below is what
          // the agent acts on next, making the cause→effect visible to the user.
          // W2 — efficacy 环静默的 key 同步抑制改道卡：advisory 都不再送达了，
          // 还继续弹卡就是纯 UI 噪音（20b9714e：32 张改道卡）。
          if (!this.advisoryBus.isEfficacySilenced('convergence')) {
            this.recordDecisionShift('convergence')
            callbacks.onDecisionShift?.({
              source: 'convergence',
              reason: `${phaseClass} 阶段近 ${phaseRelativeTurn} 轮进度信号弱，已提示换一种推进方式`,
              methods: [convergenceCheck.injectedMessage.slice(0, 200)],
              severity: convergenceCheck.level >= 2 ? 'warn' : 'info',
            })
          }
          // W4 advisory 密度感知（2026-07-28 session 0087edf0）：当会话已渲染
          // 大量 advisory（平均 >15 条/轮）时，收敛 detection 不再向 advisory
          // bus 提交——agent 已在噪音中迷失，再投喂 advisory 只会加剧正反馈回路。
          // 仍保留 onPhaseChange 事件供 TUI 观测，但不再增加 advisory 负荷。
          const avgAdvisoriesPerTurn = (turn + 1) > 0 ? this.guardianActivity.advisoriesRendered / (turn + 1) : 0
          const advisoryFlood = avgAdvisoriesPerTurn > 15
          if (!advisoryFlood) {
            this.advisoryBus.submit({
            key: 'convergence',
            priority: 0.65,
            tier: 'operational',
            category: 'discipline',
            content: convergenceCheck.injectedMessage +
              ` ${renderRouteAnnotation(STALL_ROUTE_TABLE[this.consecutiveNoToolTurns >= 2 ? 'no-tool-stall' : 'strategy-stall'])}`,
            // 谓词映射表（P1a + W3 + B1b）：
            // - 无工具僵局变体：任意工具调用即打破僵局。
            // - 诊断态变体（W3）："核实后收束"的行为签名 = 后续轮出现认知型
            //   工具调用（read/grep/glob 等）。核实了 → adopted 续命；直接
            //   无工具脑补结论 → 谓词失败计 ignored，与 efficacy 环双轨咬合。
            // - build 变体（B1b/M4，2026-07-23 信号互扰治理）：改道 = 换文件面
            //   /换工具族——course_changed 粗签名核销，填补此前刻意留空的核销位。
            expect: this.consecutiveNoToolTurns >= 2
              ? { kind: 'tool_appears', tools: [], withinTurns: 1 }
              : activityMode === 'diagnostic'
                ? { kind: 'tool_appears', tools: ['read_file', 'grep', 'glob', 'list_dir', 'bash'], withinTurns: 2 }
                : { kind: 'course_changed', withinTurns: 2 },
          })
          }

          // When convergence is detected, append the delivery gate hint so the
          // agent sees the gate state alongside the convergence message.
          // Previously only fired for doomLoopLevel==='blocked', but YELLOW
          // gates (no_test_infra, external_blocked) also need context —
          // otherwise the generic "换个角度看问题" can contradict "可带条件交付".
          if (convergenceCheck.level >= 2) {
            let gateHint = '交付门禁状态未知。请运行 deliver_task 检查。'
            try {
              const gate = this.config.deliveryGateV2?.([...this.evidence.getState().filesModified])
              if (gate) gateHint = `交付门禁：${buildGateConvergenceHint(gate, this._taskDepthLayer)}`
            } catch { /* gate evaluation must never break convergence handling */ }
            this.advisoryBus.submit({
              key: 'convergence-gate',
              priority: 0.6,
              tier: 'operational',
              category: 'discipline',
              content: gateHint,
            })
          }
        }
      }
    }

    if (convergenceCheck.shouldForceSplit) {
      // Level 3: force session split to reset context and break the loop
      debugLog(`[convergence] turn=${turn} force-split score=${convergenceCheck.score.toFixed(2)}`)
      if (await this.compaction.trySessionSplit()) {
        // split succeeded — reset turn counter and continue
        debugLog(`[convergence] turn=${turn} split-succeeded`)
      }
    }

    if (convergenceCheck.shouldAbort) {
      // Grace turn for all aborts: if no L2+ warning was delivered in an earlier
      // turn (first escalation straight to L3, or the ladder was reset by a
      // user message), demote this abort to the kick that was just emitted
      // above and let the model act on it for one turn. This applies to both
      // score-based and no-tool aborts — a model that went silent without prior
      // warning deserves one more chance after being nudged.
      if (!warnedInEarlierTurn) {
        debugLog(`[convergence] turn=${turn} score-abort demoted to kick (no prior-turn warning) score=${convergenceCheck.score.toFixed(2)}`)
        return { action: 'proceed' }
      }
      // Structured stop-reason: distinguish the no-tool hard cap from a
      // score-based abort, and tag whether the model was still reasoning (a
      // near-miss that would previously have been a silent false熔断). This is
      // the "反面找被熔断的原因" observability — emitted via debugLog +
      // onPhaseChange, and the onAbort tag lets the TUI render a labeled stop
      // instead of a bare "⏹ Interrupted" (which looked like a user interrupt).
      const stopReason: StopReason = {
        source: convergenceCheck.abortCause === 'no-tool' ? 'no-tool-abort' : 'convergence-abort',
        turn,
        voluntary: false,
        score: convergenceCheck.score,
        level: convergenceCheck.level,
        noToolTurnCount: this.consecutiveNoToolTurns,
        reasoningActive: convergenceCheck.reasoningActive,
      }
      emitStopReason(stopReason, {
        record: r => { this.recordStopReason(r) },
        debug: debugLog,
        onPhaseChange: callbacks.onPhaseChange,
      })
      if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
      callbacks.onAbort(stopReasonAbortTag(stopReason))
      return { action: 'abort' }
    }

    return { action: 'proceed' }
  }

  private async _runInner(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<void> {
    await this.turnOrchestrator.execute(userInput, callbacks, images)
  }

}

/** 资源压力状态行里的字节格式化（B/KB/MB）。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
