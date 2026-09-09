import type { RuntimeHook } from './runtime-hooks.js'
import { createPerceptionRuntimeHook } from './hooks/perception-hook.js'
import { createKickRuntimeHook } from './hooks/kick-hook.js'
import { createVigorAfterPerceptionHook, createVigorPostToolHook } from './hooks/vigor-hook.js'
import { createThetaRuntimeHook } from './hooks/theta-hook.js'
import { createStigmergyRuntimeHook } from './hooks/stigmergy-hook.js'
import { createVirtueSettlementHook } from './hooks/virtue-settlement-hook.js'
import { createSignalConsumerRuntimeHook } from './hooks/signal-consumer-hook.js'
import { createPlaybookReflectHook } from './hooks/playbook-reflect-hook.js'
import { createAnchorBreakShadowHook } from './hooks/anchor-break-shadow-hook.js'
import { createAnchorBreakScoutHook, type AnchorBreakScoutConfig } from './hooks/anchor-break-scout-hook.js'
import type { DelegationCoordinator } from './coordinator.js'
import { createTelemetryFlushHook } from './hooks/telemetry-flush-hook.js'
import { createPhysarumShadowTelemetryHook } from './hooks/physarum-shadow-telemetry-hook.js'
import { createDreamHook } from './hooks/dream-hook.js'
import { createSkillDistillHook } from './hooks/skill-distill-hook.js'
import { createCourageHook } from './hooks/courage-hook.js'
import { createRadioHook, type RadioHookDeps } from './hooks/radio-hook.js'
import { createConsistencyCheckHook } from './hooks/consistency-check-hook.js'
import { createMeridianHook, type MeridianHookDeps } from './hooks/meridian-hook.js'
import { createPhysarumFileAccessHook, type PhysarumFileAccessHookDeps } from './hooks/physarum-file-access-hook.js'
import { createImportGraphPredictHook, type ImportGraphPredictHookDeps } from './hooks/import-graph-predict-hook.js'
import { createSonglineRuntimeHook } from './hooks/songline-hook.js'
import { createConstellationRuntimeHook } from './hooks/constellation-hook.js'
import { createHearthObserveHook } from './hooks/hearth-observe-hook.js'
import { createDedupGuardHook, type DedupGuardHookDeps } from './hooks/dedup-guard-hook.js'
import { createBlindExplorationHook } from './hooks/blind-exploration-hook.js'
import { createMCTSPlanningHook } from './hooks/mcts-planning-hook.js'
import { createDispatcherHook, type DispatcherHookDeps } from './hooks/dispatcher-hook.js'
import { createMemoryLearningPostTurnHook, type MemoryLearningHookDeps } from './hooks/memory-learning-hook.js'
import { createEssenceGateHook, type EssenceGateHookDeps } from './hooks/essence-gate-hook.js'
import { createRecallEfficacyHook, type RecallEfficacyHookDeps } from './hooks/recall-efficacy-hook.js'
import { createUserHooksBridge, type UserHooksBridgeDeps } from './hooks/user-hooks-bridge.js'
import { createCompanionHeartbeatHook } from './hooks/companion-heartbeat-hook.js'
import { createCcrHook, type CcrTriggerEvent } from './hooks/cognitive-capsule-router.js'
import { createSelfVerifyHook } from './hooks/self-verify-hook.js'
import { createPostCommitReviewPreTurnHook, createPostCommitReviewPostToolHook } from './hooks/post-commit-review-hook.js'
import { createTypecheckReminderHook } from './hooks/typecheck-reminder-hook.js'
import { createTodoReminderHook } from './hooks/todo-reminder-hook.js'
import { createBackgroundJobsHook } from './hooks/background-jobs-hook.js'
import { createMonitorHook } from './hooks/monitor-hook.js'
import { createEditToolAdvisoryHook } from './hooks/edit-tool-advisory-hook.js'
import { createSecurityPatternHook } from './hooks/security-pattern-hook.js'
import { isSecurityGuidanceEnabled } from '../config/security-guidance-config.js'
import { createEditFailureRecoveryHook } from './hooks/edit-failure-recovery-hook.js'
import { createLossyObservationHook } from './hooks/lossy-observation-hook.js'
import { createCompactionAmnesiaHook, type CompactionAmnesiaHookDeps } from './hooks/compaction-amnesia-hook.js'
import { createSearchPodHook, type SearchPodHookDeps } from './hooks/search-pod-hook.js'
import { createAutoCaptureHooks, type AutoCaptureHookDeps } from './hooks/auto-capture-hook.js'
import { createSessionConsolidationHook, type SessionConsolidationHookDeps } from './hooks/session-consolidation-hook.js'
import { createPointerRegurgitationHook } from './hooks/pointer-regurgitation-hook.js'
import { createErrorDiagnosisHook } from './hooks/error-diagnosis-hook.js'
import { createProbeTrackingHook } from './hooks/probe-tracking-hook.js'
import { createExternalClaimTrackingHook } from './hooks/external-claim-tracking-hook.js'
import { createGeneralLedgerHook } from './hooks/general-ledger-hook.js'
import { createGitClearAfterFailHook } from './hooks/git-clear-after-fail-hook.js'
import { createDeadEndDetectorHook } from './hooks/dead-end-detector.js'
import { createProbeDisciplineHook } from './hooks/probe-discipline-hook.js'
import { createScriptIterationDetectorHook } from './hooks/script-iteration-detector.js'
import { createBatchConvergenceHook } from './hooks/batch-convergence-hook.js'
import { createRegressionBisectHook } from './hooks/regression-bisect-hook.js'
import { createIntentAnchorHook } from './hooks/intent-anchor-hook.js'
import { createTurnBudgetHook } from './hooks/turn-budget-hook.js'
import { createReasoningSpiralHook } from './hooks/reasoning-spiral-hook.js'
import { createAdvisoryReadbackHooks } from './hooks/advisory-readback-hook.js'
import { createAsyncCopilotHook, type CopilotContextPack } from './hooks/async-copilot-hook.js'
import { createLanguageAnchorHook } from './hooks/language-anchor-hook.js'
import { createContextPressureHook } from './hooks/context-pressure-hook.js'
import { createGateBlockGuardHook } from './hooks/gate-block-guard-hook.js'
import { createRenderVerifyHook, type RenderVerifyHookDeps } from './hooks/render-verify-hook.js'
import { createComputerUseMountHook } from './hooks/computer-use-mount-hook.js'
import { createWrapupAnxietyGuardHook } from './hooks/wrapup-anxiety-guard-hook.js'
import { createSpecVerifyGateHook } from './hooks/spec-verify-gate-hook.js'
import { createWalkthroughRecorderHooks, type WalkthroughRecorderDeps } from './hooks/walkthrough-recorder.js'
import type { AdvisoryBus } from './advisory-bus.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { AnchorGraph } from '../prompt/anchor-graph.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import type { PlaybookStore } from './playbook-store.js'
import type { RetrospectInput } from './retrospect.js'
import type { DoomLoopLevel } from './trace-store.js'
import { MERIDIAN_INDEX_ITEM_TIMEOUT_KIND, type TelemetryWriter } from './telemetry-writer.js'
import type { EvidenceState } from './evidence.js'
import type { TaskLedgerSummary } from './task-ledger.js'
import type { ChronicleEntry } from './chronicle.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { DomainVoiceId } from './domain-voice.js'
import type { ContextClaim } from '../context/claims.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'
import type { PhysarumShadowStats } from '../repo/physarum-shadow-stats.js'
import { createProblemAttackHooks, palMode } from './hooks/problem-attack-hook.js'

export interface RuntimeHookDeps {
  stigmergyDeposit: (deposit: any) => Promise<void>
  stigmergyQuery: () => Promise<any>
  getEvidenceState: () => EvidenceState
  /** W3 债龄阶梯：验证债判据（EvidenceTracker.hasVerificationDebt()）。
   *  缺省 → self-verify 阶梯禁用，priority 恒为基线。 */
  getVerificationDebt?: () => boolean
  /** 证据义务状态机（evidence-driven reasoning loop）。缺省 → hooks 只发
   *  advisory 不做义务归账（行为与旧版一致）。 */
  obligations?: import('./obligation-tracker.js').ObligationTracker
  /** A4（信号互扰治理）：goal tracker 是否活跃。收束类 hook（context-pressure/
   *  turn-budget）据此把文案合并为"先核销再收束"，避免与续轮机制同轮对打。 */
  getGoalActive?: () => boolean
  /** control plane 信号出口（self-verify 的结构化 verification_required 用）。 */
  submitControlSignal?: (signal: import('./control-plane.js').ControlSignal) => void
  setLoadedPheromones: (pheromones: any) => void
  recordStance?: (signal: import('./virtue-signals.js').VirtueSignal) => void
  /** T2: 美德 pending 台账——stigmergy-hook submit, settlement hook drainSettled */
  virtuePendingLedger?: import('./virtue-signals.js').VirtuePendingLedger
  /** T2/T0: 当前季节（settlement hook 季节鼓励门用） */
  getCurrentSeason?: () => import('./cognitive-season.js').CognitiveSeason
  /** T3: 季节强度 */
  getCurrentSeasonIntensity?: () => number
  /** T0: 近 N 轮平均缓存命中率（信复活用） */
  getRecentCacheHitRate?: () => number | null
  getThetaState: () => any
  setThetaState: (state: any) => void
  getPredictionAccumulator: () => any
  telemetryWriter?: TelemetryWriter
  /** Runtime-only aggregate of Physarum shadow prediction observations. Never injected into prompts. */
  getPhysarumShadowStats?: () => PhysarumShadowStats
  /** Publish cross-session event (file changes, type errors, etc.) */
  publishEvent?: (input: { eventType: string; filePath?: string; detail?: string; priority?: number }) => void
  /** Current session ID for event attribution */
  sessionId?: string
  dream?: {
    cwd: string
    sessionId: string
    getDecisions: () => string[]
    getTrajectory: () => TrajectoryEntry[]
    getFailureJournal?: () => import('./failure-journal.js').FailureJournal
    /** Wave 5（反馈闭环）：dream 蒸馏候选交 essence-gate 统一裁决（见 dream-hook）。 */
    onKnowledgeCandidates?: (candidates: import('../memory/essence-gate.js').KnowledgeCandidate[]) => void
  }
  /** Essence-gate（postSession 知识准入闸）。缺省不装配 = fail-closed 无写入。 */
  essenceGate?: EssenceGateHookDeps
  /** 记忆形成侧（重要操作后模型判断 + 写入 LTM）。缺省不装配。 */
  autoCapture?: AutoCaptureHookDeps
  /** 会话结束巩固（摘要 + 可复用做法写入 LTM）。缺省不装配。 */
  sessionConsolidation?: SessionConsolidationHookDeps
  /** 召回健康账本（postSession 聚合落盘）。 */
  recallEfficacy?: RecallEfficacyHookDeps
  playbookStore?: PlaybookStore
  /** Live registry skills (name+triggers) for skill-distill dedup. */
  getRegisteredSkills?: () => Array<{ name: string; triggers: RegExp[] }>
  /** Disable session-end skill draft distillation. Default: enabled when dream deps exist. */
  skillDistillDisabled?: boolean
  buildRetrospectInput?: () => RetrospectInput
  getDoomLoopLevel?: () => DoomLoopLevel
  /** Whether convergence detection injected a kick this turn — used for kick-hook mutual exclusion. */
  wasConvergenceTriggered?: () => boolean
  /** SessionRegistry for cross-session fingerprint storage (playbook-reflect). */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current working directory — used for project-scoped fingerprint partitioning. */
  cwd?: string
  chronicle?: { addRadio: (message: string, turn: number) => void; addPhaseTransition: (input: { fromPhase: string; toPhase: string; turn: number; summary: string }) => void }
  /** Returns current star domain id for radio voice modulation. null when no domain matched. */
  getDomainId?: () => DomainVoiceId
  /** 星域勇气阈值 getter（来自 sessionDomain.courageThreshold），缺省 0.5。
   *  活引用而非构造期快照：每次求值读取最新 sessionDomain，域切换即时生效。
   *  Fix 2026-07-21：此前硬编码 0.5；2026-07-22 改为 getter 修复生命周期断裂。 */
  getCourageThreshold?: () => number
  /** File observation claims for cross-store consistency checks. */
  getFileObservations?: () => Array<Pick<ContextClaim, 'id' | 'text' | 'evidence'>>
  /** Meridian code graph indexer (optional). */
  meridianIndexer?: MeridianIndexer | null
  /** Physarum topology learner for canonical file access sequences. */
  physarumFileAccess?: PhysarumFileAccessHookDeps
  /** 经络 import-graph 观察臂（P2-2）：装配门控在 loop-factory（RIVET_SPEC_OBSERVE=1 且 meridianIndexer 存在）。 */
  importGraphPredict?: ImportGraphPredictHookDeps
  /** Explicit opt-in for Songline substrate post-session deposit. Default: false. */
  songlineEnabled?: boolean
  /** 安全模式告警（层1）。config `agent.securityGuidance`；undefined = 默认开。 */
  securityGuidance?: boolean
  /** Task summary source for Songline substrate. Required only when songlineEnabled is true. */
  getTaskSummary?: () => TaskLedgerSummary | null
  /** Optional cycle relay bridge for Songline substrate. */
  setCycleClose?: (sessionId: string, closeHash: string) => void

  // ── Project Constellation (post-session milestone capture) ──
  /** Explicit opt-in for auto milestone capture. Default: false. */
  constellationEnabled?: boolean
  /** Project root for `.rivet/constellation.json`. */
  constellationCwd?: string
  /** Optional chronicle entries source for milestone summary/files. */
  getChronicleEntries?: () => readonly ChronicleEntry[]
  /** Agent's self-chosen departure mark (leave_mark tool), recorded at close. */
  getConstellationPendingMark?: () => import('../tools/types.js').LeaveMarkInput | null
  /** Session numeric id for departure mark consistency. */
  getConstellationNumericId?: () => number | null

  // ── Companion Presence (postTurn heartbeat → .rivet/presence.json) ──
  /** Opt-in for companion heartbeat hook. Default: false (only useful with multiple concurrent sessions). */
  companionPresenceEnabled?: boolean
  /** Project root for `.rivet/presence.json`. */
  companionPresenceCwd?: string
  /** Cognitive state accessor for heartbeat payload. */
  getCognitiveSnapshot?: () => { vigor: number; stability: number; season: string; convergencePrecision?: number; outputEfficiency?: number } | null
  /** Current task objective for heartbeat. */
  getObjective?: () => string | null

  // ── Anti-anchoring (explicit opt-in, prompt-flow intervention) ──
  /** Explicit opt-in for anti-anchoring harness hooks. Default: disabled. */
  antiAnchoring?: AntiAnchoringConfig
  /** Returns the original user task for MCTS planning. */
  getInitialUserMessage?: () => string | null
  /** Lightweight seed model call for MCTS planning branches. */
  callAntiAnchoringSeedModel?: (prompt: string) => Promise<string>
  /** Observe MCTS planning result for diagnostics/tests. */
  onAntiAnchoringMCTSResult?: Parameters<typeof createMCTSPlanningHook>[0]['onResult']

  // ── DEDUP guard (postTurn: detect repeated summaries) ──
  /** Get the current turn's streamed assistant text. */
  getStreamedText?: () => string
  /** Get the previous turn's streamed assistant text. */
  getPrevStreamedText?: () => string | null
  /** Store the current turn's streamed text for next turn comparison. */
  setPrevStreamedText?: (text: string) => void
  /** Overlap ratio threshold (0-1). Default: 0.6 */
  dedupGuardThreshold?: number

  // ── HEARTH observe (pure diagnostic, no intervention) ──
  /** Explicit opt-in for HEARTH anchor invariant observation. Default: false. */
  hearthObserveEnabled?: boolean
  /** Build the current anchor graph from runtime state. */
  getAnchorGraph?: () => AnchorGraph
  /** Previous graph hash for INV-5 intra-session drift detection. */
  getPrevAnchorGraphHash?: () => string | null
  /** Store current graph hash for next turn INV-5. */
  setPrevAnchorGraphHash?: (hash: string) => void
  /** Previous session cycle_open for INV-4 perturbation check. */
  getPrevCycleOpen?: () => string | null
  /** Previous session cycle_close for INV-2 relay check. */
  getPrevSessionCycleClose?: () => string | null

  // ── Auto-delegation (lazy getter, wired by main.tsx via loop.ts) ──
  /** Optional dispatcher hook deps. When set, enables auto-delegation of exploration tasks. */
  autoDelegate?: DispatcherHookDeps
  /** Cross-session memory learning (postTurn observation extraction). */
  memoryLearning?: MemoryLearningHookDeps
  /** User-defined .rivet/hooks.json shell scripts. */
  userHooksBridge?: UserHooksBridgeDeps
  /** A1: unified advisory bus for noise-gated corrective signals */
  advisoryBus?: AdvisoryBus
  /** 证据防火墙：external-claim hook 装配成功后回传 tracker getter——
   *  bootstrap 经 AgentLoop 转交 deliver_task 门禁。hook 被开关禁用时不回调。 */
  onClaimTrackerReady?: (getTracker: () => import('./hooks/external-claim-tracking-hook.js').ClaimTracker) => void
  /** Background job registry accessor — enables the preTurn background-jobs
   *  awareness nudge. Absent → hook not installed. */
  getJobs?: () => import('../tools/job-store.js').JobRegistry | undefined
  /** Monitor registry accessor — enables the preTurn monitor-events delivery
   *  hook. Absent → hook not installed. */
  getMonitors?: () => import('./monitor-registry.js').MonitorRegistry | undefined
  /** 多会话隔离：读取本会话 TodoStore（透传给 todo-reminder 做快照/活跃度判断）。
   *  缺省时 todo-reminder 回退全局 getTodos()。 */
  getTodos?: () => import('../tools/todo-store.js').TodoItem[]
  /** CCR telemetry callback — invoked on each capsule router trigger for offline analysis. */
  onCcrTrigger?: (event: CcrTriggerEvent) => void
  /** P1a 核销闭环：advisory 采纳核销器（loop.advisoryReadback）。缺省 → 不装核销 hook。 */
  advisoryReadback?: import('./advisory-readback.js').AdvisoryReadback
  /** PAL 攻坚层（计划 v2）：会话级案件容器（loop.problemAttack）。缺省 → 不装 PAL hooks。 */
  problemAttackStore?: import('./problem-attack-loop.js').ProblemAttackStore
  /** H4-D3 保存半边：postTurn 有攻坚活动时把 PAL 快照写进 session meta。 */
  persistPalSnapshot?: (snapshot: import('./problem-attack-loop.js').PalSnapshot) => void
  /** P1a：核销判定后的会话累计回调（guardian meta 接线） */
  onAdvisoryOutcomes?: (totals: { adopted: number; ignored: number }) => void
  /** Phase 3 异步副驾：cheap model 情境合成。缺省 → 不装副驾 hook。 */
  asyncCopilot?: {
    getContext: () => CopilotContextPack
    /** resolve null = cheap client 不可用（副驾永久休眠） */
    complete: (system: string, user: string) => Promise<string | null>
  }
  /** Sycophancy trap — courage-hook consumes its cumulative state for constitutional override */
  sycophancyTrap?: import('./sycophancy-trap.js').SycophancyTrap

  // ── Context pressure advisory ──
  /** Estimated token count (used by context-pressure-hook for ratio warning). */
  getEstimatedTokens?: () => number
  /** Context window size (used by context-pressure-hook for ratio warning). */
  getContextWindow?: () => number

  // ── W2 被拦不弃守护 ──
  /** 读取并清零本 turn 的闸门拦截事件 kind 列表（loop.gateBlockedKinds）。 */
  drainGateBlockedKinds?: () => string[]

  // ── W5 渲染自检 ──
  /** 检查 browser/computer_use 是否已注册（能力降级分支）。 */
  getVisualToolsAvailable?: () => boolean

  // ── computer_use 任务感知自动挂载（2026-07-15）──
  /** AgentLoop.enableTool 桥 + 用户意图源。缺省 → 不装 hook。 */
  computerUseMount?: {
    getUserIntent: () => string | null
    enableTool: (name: string) => { status: string }
  }

  // ── P2 break-anchor scout (preTurn, opt-in real intervention) ──
  /** Present only when antiAnchoring + anchorBreakScout are both enabled and a coordinator exists. */
  anchorBreakScout?: {
    config: AnchorBreakScoutConfig
    getCoordinator: () => DelegationCoordinator | null
    getAbortSignal?: () => AbortSignal | undefined
    /** CVM-vector 让位判据：scout 派发时回调（loop.anchorScoutOwned 置位）。 */
    onScoutDispatched?: () => void
  }

  // ── 主控工作流缺口 C/D(intent-anchor / turn-budget,2026-07-04) ──
  /** 当前 run 的 orchestrator 循环轮数(每 run 从 0 重计)。 */
  getRunTurn?: () => number
  /** 最近一次用户输入(run 启动 = 0,steer 注入更新)的 run 轮数。 */
  getLastUserInputRunTurn?: () => number
  /** 意图锚点复合源:taskContract?.objective ?? initialUserMessage(截 500 字)。 */
  getIntentObjective?: () => string | null
  /** run 的 maxTurns 预算(turn-budget 预警)。 */
  getMaxTurns?: () => number

  // ── 轮内防御三层加固（2026-07）──
  /** 注入 system-reminder 到消息流末尾（不经 advisory bus 优先级竞争）。
   *  cls 缺省 'discipline'（每轮限 1 条）；必须送达的纠偏用 'functional'。 */
  addSystemReminder?: (content: string, cls?: 'user' | 'functional' | 'discipline') => void

  // ── 运行走查工件（付费版 v1 · T1）──
  /** computer_use 步骤时间线记录器 + postSession walkthrough 工件组装。
   *  缺省（无 ArtifactStore 通道）→ 不装 hook。 */
  walkthrough?: WalkthroughRecorderDeps

  // ── W3-C1 压缩失忆 shadow 账本 ──
  /** Shadow-only：不注入 prompt、不改行为，仅落行供离线分析。缺省不装 hook。 */
  compactionAmnesia?: CompactionAmnesiaHookDeps

  // ── 遗产回收 W-B 检索 POD shadow 观察 ──
  /** Shadow-only：检索工具空结果/低质量结果按检出力分类落 telemetry，
   *  零 prompt 注入。缺省不装 hook。 */
  searchPod?: SearchPodHookDeps
}

export function createDefaultRuntimeHooks(deps: RuntimeHookDeps): RuntimeHook[] {
  // Phase contract (guarded by hook-sensorium-ordering.test.ts): perception stays
  // in preTurn; vigor hooks stay in afterPerception/postTool. The sensorium they
  // consume is produced by the TurnPerceptionController between phases, so vigor's
  // dependency is satisfied by phase separation — not by array order here. Vigor
  // also no-ops when sensorium is absent, so a misorder degrades safely. Keep both
  // properties when adding/reordering hooks.
  const hooks: RuntimeHook[] = [
    createPerceptionRuntimeHook(),
    createSignalConsumerRuntimeHook({ advisoryBus: deps.advisoryBus }),
    ...(isStarSoulEnabled() ? [createCourageHook({ cooldownTurns: 5, getCourageThreshold: deps.getCourageThreshold, sycophancyTrap: deps.sycophancyTrap, advisoryBus: deps.advisoryBus })] : []),
    createKickRuntimeHook({
      deposit: deps.stigmergyDeposit,
      wasConvergenceTriggered: deps.wasConvergenceTriggered,
      advisoryBus: deps.advisoryBus,
      getEstimatedTokens: deps.getEstimatedTokens,
      getContextWindow: deps.getContextWindow,
    }),
    createVigorAfterPerceptionHook(),
    createThetaRuntimeHook({
      getThetaState: deps.getThetaState,
      setThetaState: deps.setThetaState,
    }),
    createStigmergyRuntimeHook({
      deposit: deps.stigmergyDeposit,
      query: deps.stigmergyQuery,
      getEvidenceState: deps.getEvidenceState,
      setLoadedPheromones: deps.setLoadedPheromones,
      recordStance: deps.recordStance,
      publishEvent: deps.publishEvent,
      sessionId: deps.sessionId,
      pendingLedger: deps.virtuePendingLedger,
    }),
    ...(deps.getFileObservations
      ? [createConsistencyCheckHook({ getFileObservations: deps.getFileObservations })]
      : []),
    ...(deps.antiAnchoring?.enabled && deps.antiAnchoring.blindExploration
      ? [createBlindExplorationHook({ activeTurns: [deps.antiAnchoring.planningTurn] })]
      : []),
    ...(deps.antiAnchoring?.enabled && deps.antiAnchoring.mctsPlanning && deps.callAntiAnchoringSeedModel && deps.getInitialUserMessage
      ? [createMCTSPlanningHook({
        callSeedModel: deps.callAntiAnchoringSeedModel,
        branches: deps.antiAnchoring.branches,
        planningTurn: deps.antiAnchoring.planningTurn,
        threshold: deps.antiAnchoring.projectionThreshold,
        getUserMessage: deps.getInitialUserMessage,
        onResult: deps.onAntiAnchoringMCTSResult,
      })]
      : []),
    createVigorPostToolHook({
      getPredictionAccumulator: deps.getPredictionAccumulator,
    }),
    createRadioHook({ chronicle: deps.chronicle, getDomainId: deps.getDomainId }),
  ]

  if (deps.playbookStore && deps.buildRetrospectInput && deps.getDoomLoopLevel) {
    hooks.push(createPlaybookReflectHook({
      store: deps.playbookStore,
      buildRetrospectInput: deps.buildRetrospectInput,
      getDoomLoopLevel: deps.getDoomLoopLevel,
      registry: deps.sessionRegistry,
      sessionId: deps.sessionId,
      cwd: deps.cwd,
    }))
  }

  // Anchor-break shadow (P1, observe-only): records "under-explored convergence"
  // candidates at session end. Always registered when retrospect is available;
  // no-ops when the meridian DB store is absent. Never mutates the session.
  if (deps.buildRetrospectInput && deps.sessionId) {
    hooks.push(createAnchorBreakShadowHook({
      store: deps.meridianIndexer?.getDb() ?? null,
      buildRetrospectInput: deps.buildRetrospectInput,
      getSessionId: () => deps.sessionId,
      getObjective: deps.getObjective,
      getActiveDomainId: deps.getDomainId ? () => deps.getDomainId!() ?? null : undefined,
    }))
  }

  // P2 break-anchor scout: real orthogonal-domain sub-agent dispatched mid-loop
  // when a complex task is converging without breadth exploration. Opt-in only.
  if (deps.anchorBreakScout?.config.enabled && deps.sessionId) {
    hooks.push(createAnchorBreakScoutHook({
      config: deps.anchorBreakScout.config,
      getCoordinator: deps.anchorBreakScout.getCoordinator,
      getSessionId: () => deps.sessionId,
      getObjective: deps.getObjective ?? (() => null),
      getActiveDomainId: deps.getDomainId ? () => deps.getDomainId!() ?? null : undefined,
      getDoomLoopLevel: deps.getDoomLoopLevel,
      getAbortSignal: deps.anchorBreakScout.getAbortSignal,
      store: deps.meridianIndexer?.getDb() ?? null,
      onScoutDispatched: deps.anchorBreakScout.onScoutDispatched,
    }))
  }

  if (deps.dream) {
    hooks.push(createDreamHook({
      cwd: deps.dream.cwd,
      sessionId: deps.dream.sessionId,
      getEvidenceState: deps.getEvidenceState,
      getDecisions: deps.dream.getDecisions,
      getTrajectory: deps.dream.getTrajectory,
      getFailureJournal: deps.dream.getFailureJournal,
      getPlaybookStore: deps.playbookStore ? () => deps.playbookStore : undefined,
      // 只有 essence-gate 真的装配时才转发回调——gate 缺席时 dream 保留直写通道，
      // 否则候选推进缓冲后没有任何消费者，dream 知识凭空丢失。
      onKnowledgeCandidates: deps.essenceGate ? deps.dream.onKnowledgeCandidates : undefined,
    }))

    // Skill-distill: same postSession source as dream — verified, repeatable
    // procedures are distilled into review-only SKILL.md drafts.
    if (!deps.skillDistillDisabled) {
      hooks.push(createSkillDistillHook({
        cwd: deps.dream.cwd,
        sessionId: deps.dream.sessionId,
        getEvidenceState: deps.getEvidenceState,
        getDecisions: deps.dream.getDecisions,
        getTrajectory: deps.dream.getTrajectory,
        getRegisteredSkills: deps.getRegisteredSkills,
        getObjective: deps.getObjective,
      }))
    }
  }

  // Essence-gate（Wave 2 知识重构）：postSession 知识准入闸。
  // deps-gated——没有廉价 LLM complete 通道就不装配（fail-closed：无闸即无写入）。
  if (deps.essenceGate) {
    hooks.push(createEssenceGateHook(deps.essenceGate))
  }

  // 记忆形成侧：postTool 缓冲候选，postSession 模型判断冲销（写入 LTM）。
  if (deps.autoCapture) {
    const hooksPair = createAutoCaptureHooks(deps.autoCapture)
    hooks.push(hooksPair.postTool)
    hooks.push(hooksPair.postSession)
  }

  // 会话结束巩固：postSession 生成整体摘要 + 可复用做法（写入 LTM）。
  if (deps.sessionConsolidation) {
    hooks.push(createSessionConsolidationHook(deps.sessionConsolidation))
  }

  // 召回健康账本（Wave 3 知识重构）：postSession 聚合空召回率/引用率落盘。
  if (deps.recallEfficacy) {
    hooks.push(createRecallEfficacyHook(deps.recallEfficacy))
  }

  if (deps.telemetryWriter && deps.getPhysarumShadowStats) {
    hooks.push(createPhysarumShadowTelemetryHook({
      getStats: deps.getPhysarumShadowStats,
      telemetryWriter: deps.telemetryWriter,
    }))
  }

  if (deps.telemetryWriter) {
    hooks.push(createTelemetryFlushHook(deps.telemetryWriter))
  }

  if (deps.meridianIndexer !== undefined) {
    const indexerRef = deps.meridianIndexer
    const meridianHooks = createMeridianHook({
      getIndexer: () => indexerRef,
      onItemTimeout: deps.telemetryWriter
        ? (target, indexKind, timeoutCount) => deps.telemetryWriter!.write({
            kind: MERIDIAN_INDEX_ITEM_TIMEOUT_KIND,
            target,
            indexKind,
            timeoutCount,
            at: Date.now(),
          })
        : undefined,
    })
    hooks.push(meridianHooks.postTool)
    hooks.push(meridianHooks.postSession)
  }

  if (deps.physarumFileAccess) {
    hooks.push(createPhysarumFileAccessHook(deps.physarumFileAccess))
  }

  if (deps.importGraphPredict) {
    hooks.push(createImportGraphPredictHook(deps.importGraphPredict))
  }

  if (deps.songlineEnabled && deps.getTaskSummary) {
    hooks.push(createSonglineRuntimeHook({
      enabled: true,
      getTaskSummary: deps.getTaskSummary,
      deposit: deps.stigmergyDeposit,
      sessionId: deps.sessionId,
      setCycleClose: deps.setCycleClose,
    }))
  }

  if (deps.constellationEnabled && deps.constellationCwd && deps.sessionId) {
    hooks.push(createConstellationRuntimeHook({
      enabled: true,
      cwd: deps.constellationCwd,
      sessionId: deps.sessionId,
      getPendingMark: deps.getConstellationPendingMark,
      getTaskSummary: deps.getTaskSummary,
      getChronicleEntries: deps.getChronicleEntries,
      getDomainId: deps.getDomainId,
      getNumericId: deps.getConstellationNumericId,
    }))
  }

  if (deps.hearthObserveEnabled && deps.getAnchorGraph && deps.getPrevAnchorGraphHash && deps.setPrevAnchorGraphHash) {
    hooks.push(createHearthObserveHook({
      enabled: true,
      getAnchorGraph: deps.getAnchorGraph,
      getPrevGraphHash: deps.getPrevAnchorGraphHash,
      setPrevGraphHash: deps.setPrevAnchorGraphHash,
      getPrevCycleOpen: deps.getPrevCycleOpen ?? (() => null),
      getPrevSessionCycleClose: deps.getPrevSessionCycleClose ?? (() => null),
    }))
  }

  if (deps.getStreamedText && deps.getPrevStreamedText && deps.setPrevStreamedText) {
    hooks.push(createDedupGuardHook({
      getStreamedText: deps.getStreamedText,
      getPrevStreamedText: deps.getPrevStreamedText,
      setPrevStreamedText: deps.setPrevStreamedText,
      threshold: deps.dedupGuardThreshold,
      advisoryBus: deps.advisoryBus,
    }))
  }

  // CCR: Cognitive Capsule Router — star-domain advisory routing
  if (deps.advisoryBus && isStarSoulEnabled()) {
    hooks.push(createCcrHook({
      advisoryBus: deps.advisoryBus,
      wasConvergenceTriggered: deps.wasConvergenceTriggered ?? (() => false),
      getEvidenceState: deps.getEvidenceState,
      cwd: deps.cwd,
      onTrigger: deps.onCcrTrigger,
    }))
  }

  // Self-Verify: postTurn hook — when a turn uses only read-class tools
  // with no ground-truth verification, inject a reminder for the next turn
  // to self-verify before building on the conclusions.
  if (deps.advisoryBus) {
    hooks.push(createSelfVerifyHook({
      advisoryBus: deps.advisoryBus,
      getEvidenceState: deps.getEvidenceState,
      // 结构化 verification 信号 + 同义 advisory supersede（义务在场时义务块
      // 是唯一声音，泛化 self-verify advisory 不再叠发）。
      submitControlSignal: deps.submitControlSignal,
      obligations: deps.obligations,
      // W3 债龄阶梯：债连续在场越久，advisory priority 越高（债越陈越贵）
      getVerificationDebt: deps.getVerificationDebt,
    }))
  }

  // Post-Commit Review delivery: preTurn + postTool 双相排水 — deliver_task
  // 把系统触发的提交后审查分离到后台跑（240s 超时事故链修复 2026-07-07），
  // 结论经 post-commit-review-queue 在这里投递回对话。
  if (deps.advisoryBus) {
    hooks.push(createPostCommitReviewPreTurnHook({ advisoryBus: deps.advisoryBus }))
    hooks.push(createPostCommitReviewPostToolHook({ advisoryBus: deps.advisoryBus }))
  }

  // Edit-Tool Advisory: postTool hook — detects consecutive hash_edit calls
  // on the same file (the #1 cause of bracket-mismatch debris). Uses a
  // turn-scoped Map to avoid the 5-entry recentToolHistory window limit.
  // Gated by RIVET_EDIT_SMART_ROUTING (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_EDIT_SMART_ROUTING !== '0') {
    hooks.push(createEditToolAdvisoryHook({ advisoryBus: deps.advisoryBus }))
  }

  // Security-Pattern: postTool hook — 移植自官方 security-guidance 插件的
  // PostToolUse 层。写操作后正则扫描已知危险模式（命令注入、反序列化 RCE、
  // XSS、eval、弱加密、TLS 校验关闭、XXE、SQL 注入、硬编码密钥），命中经
  // AdvisoryBus 注入中文告警。零成本零延迟（纯正则不调 API），命中才注入
  // （缓存安全），同一 (文件, 规则) 全会话只提醒一次。
  // 默认开（与其他 advisory hook 同档）；config `agent.securityGuidance=false`
  // 或 RIVET_SECURITY_GUIDANCE=0 关闭。有成本的 LLM 安全审查是层2/层3，另有开关。
  if (deps.advisoryBus && isSecurityGuidanceEnabled(deps.securityGuidance)) {
    hooks.push(createSecurityPatternHook({ advisoryBus: deps.advisoryBus }))
  }

  // Edit-Failure Recovery: postTool hook — detects consecutive edit failures
  // on the same file across turns and injects a repair advisory telling the
  // agent to undo, re-read, and switch to apply_patch/write_file.
  if (deps.advisoryBus) {
    hooks.push(createEditFailureRecoveryHook({ advisoryBus: deps.advisoryBus }))
  }

  // Lossy Observation: postTool hook — detects collapsed/truncated tool
  // output and reinforces the discipline that lossy observations cannot
  // support negative conclusions. Complements guardLossyToolResult's
  // inline VERIFICATION_REQUIRED marker (which only fires on lossy + negative).
  if (deps.advisoryBus) {
    hooks.push(createLossyObservationHook({ advisoryBus: deps.advisoryBus }))
  }

  // W3-C1 Compaction Amnesia (shadow): postTool hook — records unchanged-hash
  // full re-reads within 10 turns after a compact. Never injects into the
  // prompt; rows feed offline precision analysis only.
  // Gated by RIVET_AMNESIA_SHADOW (default on; set to '0' to disable).
  if (deps.compactionAmnesia && process.env.RIVET_AMNESIA_SHADOW !== '0') {
    hooks.push(createCompactionAmnesiaHook(deps.compactionAmnesia))
  }

  // 遗产回收 W-B Search POD (shadow): postTool hook — 检索工具空结果/低质量
  // 结果按查询检出力分类落 telemetry（"搜过 ≠ 排除"）。零 prompt 注入。
  // Gated by RIVET_SEARCH_POD (default on; set to '0' to disable).
  if (deps.searchPod && process.env.RIVET_SEARCH_POD !== '0') {
    hooks.push(createSearchPodHook(deps.searchPod))
  }

  // Pointer-Regurgitation: postTool hook — counts pointer-guard rejections
  // (model echoing "[file written to …]"-style placeholders as real content)
  // session-wide and escalates to a constitutional advisory from the 2nd
  // offense. The inline guard error alone failed to break a ~20-rejection
  // imitation loop (word-batch report 2026-07-06).
  if (deps.advisoryBus) {
    hooks.push(createPointerRegurgitationHook({ advisoryBus: deps.advisoryBus, addSystemReminder: deps.addSystemReminder }))
  }

  // Error Diagnosis: postTool hook — when a tool fails, reads the
  // failureClass (already classified by tool-execution.ts via
  // failure-classifier.ts) and injects a scenario-specific diagnosis
  // into the advisory stream. Replaces the static error-to-user
  // translation table in the system prompt — knowledge is injected
  // on-demand instead of occupying prompt space permanently.
  if (deps.advisoryBus) {
    hooks.push(createErrorDiagnosisHook({ advisoryBus: deps.advisoryBus, obligations: deps.obligations }))
  }

  // Probe-Tracking: postTool hook — detects debug probes (console.log,
  // debugger, .only) in write operations. Session-scoped tracker survives
  // across turns; deliver-task gate does authoritative fs re-scan.
  // Gated by RIVET_PROBE_TRACKING (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_PROBE_TRACKING !== '0') {
    hooks.push(createProbeTrackingHook({ advisoryBus: deps.advisoryBus }))
  }

  // External-Claim Tracking: postTool hook — detects delegate_task/batch
  // results containing file:line references, then warns if the agent edits
  // those paths without independent verification (read_file/grep) first.
  // Session-scoped claim set with TTL. Guards the "格式完整不是可信度信号"
  // discipline against authoritative-sounding worker reports.
  // Gated by RIVET_EXTERNAL_CLAIM_TRACKING (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_EXTERNAL_CLAIM_TRACKING !== '0') {
    const externalClaimHook = createExternalClaimTrackingHook({ advisoryBus: deps.advisoryBus })
    deps.onClaimTrackerReady?.(externalClaimHook.getClaimTracker)
    hooks.push(externalClaimHook)
  }

  // General-Ledger（将星记账）: postTool hook — 带账本星 authority 的 delegate
  // 完成后，informational 提醒主控核对是否有新战绩该 record_general_finding。
  // 每星每会话最多一次；账本不存在的星不催账。
  // Gated by RIVET_GENERAL_LEDGER_REMINDER (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_GENERAL_LEDGER_REMINDER !== '0') {
    hooks.push(createGeneralLedgerHook({ advisoryBus: deps.advisoryBus }))
  }

  // Git-Clear-After-Fail: postTool hook — detects the pattern of running git
  // stash/reset/checkout/restore/clean shortly after a test failure without
  // any diagnosis (read/grep) in between. Constitutional tier: the underlying
  // action is irreversible and can harm other sessions in a shared worktree.
  // Gated by RIVET_GIT_CLEAR_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_GIT_CLEAR_GUARD !== '0') {
    hooks.push(createGitClearAfterFailHook({ advisoryBus: deps.advisoryBus }))
  }

  // Dead-End Detector: postTool hook — 同一文件反复 edit→verify-fail 循环
  // (≥2 次且无 verify pass)= 盲改死路。advisory 带 tool_appears 谓词
  // (采纳 = 转向诊断),触发时同步沉积文件级 dead-end 信息素。
  // Gated by RIVET_DEAD_END_DETECTOR (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_DEAD_END_DETECTOR !== '0') {
    hooks.push(createDeadEndDetectorHook({
      advisoryBus: deps.advisoryBus,
      deposit: deps.stigmergyDeposit,
      obligations: deps.obligations,
    }))
  }

  // Probe Discipline: postTool hook — 诊断轮连续 ≥3 个只读工具而零探针 →
  // 提示「30 秒探针能否杀死当前假设」。太一域洞察机制化（2026-08-07）。
  // 冷却 8 次工具调用（防狂轰滥炸）；env RIVET_PROBE_DISCIPLINE=0 可关。
  if (deps.advisoryBus && process.env.RIVET_PROBE_DISCIPLINE !== '0') {
    hooks.push(createProbeDisciplineHook({ advisoryBus: deps.advisoryBus }))
  }

  // Script-Iteration Detector: postTool hook — 同一脚本文件 edit→bash(run)→truncated→edit
  // 迭代 ≥3 次且无诊断工具 → 脚本迭代停滞。与 dead-end-detector 互补：
  // 那边抓 edit→verify-fail（需工具失败），这边抓 edit→bash→edit（工具全成功）。
  // Gated by RIVET_SCRIPT_ITERATION_DETECTOR (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_SCRIPT_ITERATION_DETECTOR !== '0') {
    hooks.push(createScriptIterationDetectorHook({
      advisoryBus: deps.advisoryBus,
      deposit: deps.stigmergyDeposit,
    }))
  }

  // Batch Convergence: postTool hook — 单 turn 工具调用 ≥5 时触发收敛提醒，
  // 引导 agent 在汇总并行结果前进行分层收敛（分类→交叉验证→综合判断）。
  // 防止批量并行调用返回后信息过载导致误判。
  if (deps.advisoryBus) {
    hooks.push(createBatchConvergenceHook({ advisoryBus: deps.advisoryBus }))
  }

  // Regression-Bisect 断路器: postTool hook — 回归语义 + 连续 ≥5 轮只读诊断
  // 空转(零写入)时,强制策略升级到基线对照(git log → git bisect/checkpoint
  // diff → regressionInventory 逐项定位)。事故链缺口 4:20+ 轮盲排查救援。
  // Gated by RIVET_REGRESSION_BISECT (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_REGRESSION_BISECT !== '0') {
    hooks.push(createRegressionBisectHook({
      advisoryBus: deps.advisoryBus,
      getObjective: deps.getIntentObjective,
      getContextWindow: deps.getContextWindow,
    }))
  }

  // Intent Anchor: preTurn hook — 长自治 run(>20 轮且距上次用户输入 >10 轮)
  // 重锚本次 run 的启动意图(taskContract?.objective ?? initialUserMessage)。
  // 无行为签名 → 无 expect,只计送达。冷却 10 轮。
  // Gated by RIVET_INTENT_ANCHOR (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.getRunTurn && deps.getLastUserInputRunTurn && deps.getIntentObjective
    && process.env.RIVET_INTENT_ANCHOR !== '0') {
    hooks.push(createIntentAnchorHook({
      advisoryBus: deps.advisoryBus,
      getRunTurn: deps.getRunTurn,
      getLastUserInputTurn: deps.getLastUserInputRunTurn,
      getObjective: deps.getIntentObjective,
    }))
  }

  // A4（信号互扰治理）：收束类 hook 共享的续轮活跃判定——goal tracker 活跃
  // 或存在未核销的 high 义务（open/attempted）。true 时收束文案合并为
  // "先核销再收束"，不与 goal continuation / 义务门同轮对打。
  const hasActiveContinuation = (): boolean =>
    (deps.getGoalActive?.() ?? false)
    || (deps.obligations?.getStore().obligations
      .some(o => o.risk === 'high' && (o.state === 'open' || o.state === 'attempted')) ?? false)

  // Turn Budget: preTurn hook — maxTurns 预算进入危险区(剩余 ≤ max(3, 10%))
  // 时预警一次,引导收敛。expect = verify_attempted(采纳 = 先验证手头工作)。
  // Gated by RIVET_TURN_BUDGET_WARN (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.getRunTurn && deps.getMaxTurns
    && process.env.RIVET_TURN_BUDGET_WARN !== '0') {
    hooks.push(createTurnBudgetHook({
      advisoryBus: deps.advisoryBus,
      getMaxTurns: deps.getMaxTurns,
      getRunTurn: deps.getRunTurn,
      hasActiveContinuation,
    }))
  }

  // Advisory-Readback: postTool 观察 + postTurn 核销 — 对送达的 advisory 按
  // expect 谓词判定 adopted/ignored，产出采纳率账本（P1a 生命周期闭环）。
  // 无独立开关：随 advisoryBus 存在自动启用（观察半边零副作用）。
  if (deps.advisoryBus && deps.advisoryReadback) {
    hooks.push(...createAdvisoryReadbackHooks({
      readback: deps.advisoryReadback,
      writeTelemetry: deps.telemetryWriter ? (r) => deps.telemetryWriter!.write(r) : undefined,
      onOutcomes: deps.onAdvisoryOutcomes,
    }))
  }

  // PAL 攻坚层双半边（计划 v2 Wave P2）：postTool 保守谓词自动结算 + 委派窗口
  // 标记；postTurn 事件留痕落盘 + 自动结算加分的聚合鼓励（active 才 submit，
  // shadow 零发声）。store 只在模型经 attack_case 开案后才有内容——空案零开销。
  if (deps.advisoryBus && deps.problemAttackStore && palMode() !== 'off') {
    const pal = createProblemAttackHooks({
      store: deps.problemAttackStore,
      advisoryBus: deps.advisoryBus,
      mode: palMode(),
      writeTelemetry: deps.telemetryWriter ? (r) => deps.telemetryWriter!.write(r) : () => {},
      persistSnapshot: deps.persistPalSnapshot,
      // 虚空仓库 P0：收敛案件自动收割目的地 + 溯源 sessionId
      cwd: deps.cwd,
      sessionId: deps.sessionId,
    })
    hooks.push(pal.postTool, pal.postTurn)
  }

  // Virtue-Settlement: postTurn 效用核销 — 美德信号两段式
  // （stigmergy-hook 检测后 submit pending，此处 postTurn 核销效用后转正）。
  // 不需要 postTool 半边——advisory-readback-observe 已经在喂 readback 观察日志。
  if (deps.virtuePendingLedger && deps.advisoryReadback && deps.advisoryBus) {
    hooks.push(createVirtueSettlementHook({
      ledger: deps.virtuePendingLedger,
      readback: deps.advisoryReadback,
      recordStance: deps.recordStance ?? (() => {}),
      deposit: deps.stigmergyDeposit,
      advisoryBus: deps.advisoryBus,
      getSeason: () => deps.getCurrentSeason?.() ?? 'genesis',
      getSeasonIntensity: () => deps.getCurrentSeasonIntensity?.() ?? 1.0,
      getRecentCacheHitRate: () => deps.getRecentCacheHitRate?.() ?? null,
    }))
  }

  // Async-Copilot: postTurn hook — cheap-model 情境合成的中层建议（Phase 3）。
  // 可行性双闸门为运行时数据判定（全局采纳率 >30% 才激活）,自我淘汰降频。
  // Gated by RIVET_ASYNC_COPILOT (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.advisoryReadback && deps.asyncCopilot && process.env.RIVET_ASYNC_COPILOT !== '0') {
    const rb = deps.advisoryReadback
    hooks.push(createAsyncCopilotHook({
      advisoryBus: deps.advisoryBus,
      // 闸门 totals 含跨会话先验(贡献上限 20)——消灭"决出样本 ≥10"的每会话
      // 冷启动沉睡;自我淘汰的 per-key stats 保持会话实测。
      readback: { getTotals: () => rb.getTotalsWithPriors(), getStats: () => rb.getStats() },
      getContext: deps.asyncCopilot.getContext,
      complete: deps.asyncCopilot.complete,
      writeTelemetry: deps.telemetryWriter ? (r) => deps.telemetryWriter!.write(r) : undefined,
    }))
  }

  // Reasoning-Spiral Guard: preTurn hook — detects single-turn reasoning
  // spirals (3000+ chars thinking + zero tool calls). Session-scoped trend
  // tracking for escalation detection. Fills the gap that convergence-detector
  // and exploration-stall don't cover: pure thinking length without tools.
  // Gated by RIVET_REASONING_SPIRAL_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_REASONING_SPIRAL_GUARD !== '0') {
    hooks.push(createReasoningSpiralHook({ advisoryBus: deps.advisoryBus, obligations: deps.obligations }))
  }

  // Language Anchor: postTool hook — when a turn's cumulative tool output is a
  // large, overwhelmingly non-CJK dump (code/log/search floods), re-anchor the
  // reasoning language via a short Chinese advisory. Counters training-mode
  // regression (English enumerative CoT) that star-signature alone cannot hold
  // against tens of KB of English (4e1aaa21 post-mortem).
  // Gated by RIVET_LANGUAGE_ANCHOR (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_LANGUAGE_ANCHOR !== '0') {
    hooks.push(createLanguageAnchorHook({ advisoryBus: deps.advisoryBus }))
  }

  // Context Pressure: afterPerception hook — warns when context window
  // fill ratio exceeds 70%, suggesting the agent wrap up and hand off to
  // a new session before the 86% split threshold triggers.
  if (deps.advisoryBus && deps.getEstimatedTokens && deps.getContextWindow) {
    hooks.push(createContextPressureHook({
      advisoryBus: deps.advisoryBus,
      getEstimatedTokens: deps.getEstimatedTokens,
      getContextWindow: deps.getContextWindow,
      hasActiveContinuation,
    }))
  }

  // Gate-Block Guard: postTurn hook — 单 turn 被闸门拦截 ≥2 次时提醒
  // "被拦不是死路"，引导执行拦截文案里的替代路径而非放弃排查。
  // per-key 3 轮冷却防连拦 spam。
  // Gated by RIVET_GATE_BLOCK_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.drainGateBlockedKinds && process.env.RIVET_GATE_BLOCK_GUARD !== '0') {
    hooks.push(createGateBlockGuardHook({
      advisoryBus: deps.advisoryBus,
      drainBlockedKinds: deps.drainGateBlockedKinds,
    }))
  }

  // Wrapup-Anxiety Guard: postTurn hook — 收尾/新会话话术 × 实测 ctxRatio
  // 对照。ratio < 0.5 时注入硬数据反驳（焦虑话术不基于物理事实）；
  // 0.5-0.7 灰区不注入；≥0.7 不触发（context-pressure 的收束建议合法）。
  // 反驳双通道：advisory 留痕 + addSystemReminder functional 必达。
  // Gated by RIVET_WRAPUP_ANXIETY_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.getStreamedText && deps.getEstimatedTokens && deps.getContextWindow
    && process.env.RIVET_WRAPUP_ANXIETY_GUARD !== '0') {
    hooks.push(createWrapupAnxietyGuardHook({
      advisoryBus: deps.advisoryBus,
      getStreamedText: deps.getStreamedText,
      getEstimatedTokens: deps.getEstimatedTokens,
      getContextWindow: deps.getContextWindow,
      addSystemReminder: deps.addSystemReminder,
    }))
  }

  // Render-Verify: postTurn hook — UI 文件改动后未检查渲染结果时提醒。
  // 能力降级：browser/computer_use 未注册 → 提示人工过目。
  // 冷却：每会话 2 次。
  // Gated by RIVET_RENDER_VERIFY (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_RENDER_VERIFY !== '0') {
    hooks.push(createRenderVerifyHook({
      advisoryBus: deps.advisoryBus,
      getVisualToolsAvailable: deps.getVisualToolsAvailable,
    }))
  }

  // Computer-Use Mount: afterPerception hook — 任务涉及桌面 GUI 时在会话早期
  // （turn 0-1）自动挂载 computer_use（EXTENDED 层逃生口的任务感知版）。
  // Gated by RIVET_COMPUTER_USE_AUTOMOUNT (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.computerUseMount && process.env.RIVET_COMPUTER_USE_AUTOMOUNT !== '0') {
    hooks.push(createComputerUseMountHook({
      advisoryBus: deps.advisoryBus,
      getUserIntent: deps.computerUseMount.getUserIntent,
      enableTool: deps.computerUseMount.enableTool,
    }))
  }

  // Spec-Verify Gate: preTurn hook — detects "read spec → implement
  // without verification" jumps and injects a constitutional advisory.
  if (deps.advisoryBus) {
    hooks.push(createSpecVerifyGateHook({ advisoryBus: deps.advisoryBus, obligations: deps.obligations }))
  }

  // Typecheck-Reminder: postTurn hook — fills self-verify's blind spot. tsx
  // tests pass without type-checking, so "tests green" can hide a broken tsc.
  // Fires when TS files were edited + tests ran + no typecheck since.
  if (deps.advisoryBus) {
    hooks.push(createTypecheckReminderHook({ advisoryBus: deps.advisoryBus }))
  }

  // Todo-Reminder: postTurn hook — nudges the model to (a) create a todo list
  // when a multi-step task is running without one, and (b) refresh a stale list.
  // Soft by default, escalates wording when a long task still has no todo.
  if (deps.advisoryBus) {
    hooks.push(createTodoReminderHook({ advisoryBus: deps.advisoryBus, getTodos: deps.getTodos }))
  }

  // Background-jobs awareness — preTurn nudge while jobs run (requires bus + registry).
  if (deps.advisoryBus && deps.getJobs) {
    hooks.push(createBackgroundJobsHook({ advisoryBus: deps.advisoryBus, getJobs: deps.getJobs }))
  }

  // Monitor events — preTurn delivery of subscribed job-output events (requires bus + registry).
  if (deps.advisoryBus && deps.getMonitors) {
    hooks.push(createMonitorHook({ advisoryBus: deps.advisoryBus, getMonitors: deps.getMonitors }))
  }

  if (deps.companionPresenceEnabled && deps.companionPresenceCwd && deps.sessionId) {
    hooks.push(createCompanionHeartbeatHook({
      cwd: deps.companionPresenceCwd,
      getSessionId: () => deps.sessionId,
      getDomainId: deps.getDomainId ?? (() => null),
      getCognitiveSnapshot: deps.getCognitiveSnapshot ?? (() => null),
      getObjective: deps.getObjective ?? (() => null),
    }))
  }

  if (deps.autoDelegate) {
    hooks.push(createDispatcherHook({ ...deps.autoDelegate, advisoryBus: deps.advisoryBus }))
  }

  if (deps.memoryLearning) {
    hooks.push(createMemoryLearningPostTurnHook(deps.memoryLearning))
  }

  if (deps.userHooksBridge) {
    hooks.push(...createUserHooksBridge(deps.userHooksBridge))
  }

  // Walkthrough recorder（付费版 v1 · T1）: postTool 捕获 computer_use 步骤，
  // postSession 组装走查工件。记录器恒开（无 computer_use 活动时零成本），
  // 回放查看器在桌面端 Pro gate。
  if (deps.walkthrough) {
    hooks.push(...createWalkthroughRecorderHooks(deps.walkthrough))
  }

  return hooks
}
