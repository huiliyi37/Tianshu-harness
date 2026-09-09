import type { ContentBlock } from '../api/types.js'
import type { ToolErrorClass } from '../tools/types.js'
import type { TurnBudget } from './turn-budget.js'
import { enforcePerMessageBudget, enforceTurnReadBudget, enforceContextPressureTruncation, enforceToolTypeBudgets } from './per-message-budget.js'
import { perMessageToolResultBudget } from '../compact/constants.js'
import type { AgentConfig, AgentCallbacks } from './loop-types.js'
import type { TurnHarness } from './turn-harness.js'
import type { EvidenceTracker } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import { fingerprintToolCall } from './trace-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { RepairPipeline } from './repair-pipeline.js'
import type { ImportGraph } from './import-graph.js'
import type { PredictionAccumulator } from './prediction-error.js'
import { computeTurnDepth } from './p3-reward.js'
import type { VigorState } from './vigor.js'
import type { RuntimeHookSnapshot, RuntimeHookPipeline } from './runtime-hooks.js'
import type { ContextInjectionController } from './context-injection.js'
import type { RiskAssessment } from './approval-risk.js'
import type { Sensorium } from './sensorium.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { ReliabilityDecision } from './reliability-mode.js'
import { PrewarmCache } from './prewarm.js'
import { executeToolUse, type ToolPipelineDeps } from './tool-pipeline.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import type { P3Integration } from './p3-integration.js'
import type { ImmuneHook } from './immune-hook.js'
import type { LspManager } from '../lsp/manager.js'
import { classifyFailure, isReadProbeInvocation, isTestRunInvocation, type FailureClass } from './failure-classifier.js'
import { ToolAccumulator } from './tool-accumulator.js'
import { guardLossyToolResult } from './negative-fact-detector.js'
import { getToolStormLevel, type ToolStormLevel } from './trace-store.js'
import { extractTrailingArtifactId, tierToolResult } from './tool-result-tiering.js'
import {
  getInterventionLevel,
  recordPrediction,
  shouldTippingPointReset,
  resetAccumulator,
  adjustReasoningEffort,
  getErrorRate,
} from './prediction-error.js'
import type { ReasoningEffort } from './auto-reasoning.js'
import { createRuntimeHookContext } from './runtime-hooks.js'
import { toolTargetFromInput } from './tool-target.js'
import { sanitizeToolOutput } from '../tools/output-sanitizer.js'

export interface ToolExecutionDeps {
  config: AgentConfig
  cwd: string
  harness: TurnHarness
  prewarm: PrewarmCache
  evidence: EvidenceTracker
  /** 证据义务状态机——tool pipeline 把 probe/失败/RED 编辑门接进义务状态。 */
  obligations?: import('./obligation-tracker.js').ObligationTracker
  repairHintTracker: RepairHintTracker
  repairPipeline: RepairPipeline
  runtimeHooks: RuntimeHookPipeline
  contextInjection: ContextInjectionController
  trajectory: TrajectoryRecorder
  getPredictionAccumulator: () => PredictionAccumulator
  setPredictionAccumulator: (a: PredictionAccumulator) => void
  getVigorState: () => VigorState
  setVigorState: (v: VigorState) => void
  getDoomLoopLevel: () => 'none' | 'warn' | 'blocked'
  getSessionTurnCount: () => number
  getSessionId: () => string | undefined
  addToolResults: (results: ContentBlock[]) => void
  /** Vision channel: current model accepts image inputs (per-model config flag). */
  getSupportsVision?: () => boolean
  /** Vision channel: append a trailing multimodal user message (text + data-URL
   *  images). Append-only at the tail — prefix-cache safe (same boundary as
   *  the steer path). An empty image list appends plain text, which is how the
   *  bridge path below delivers its description. */
  addUserMessageWithImages?: (text: string, images: string[]) => void
  /** Vision bridge: describe tool-carried screenshots with the separately
   *  configured multimodal model, for primary models that cannot take images.
   *  Absent when no vision model is configured — then screenshots are dropped
   *  as before. Returns null when the description could not be produced. */
  describeToolImages?: (images: string[], signal?: AbortSignal) => Promise<string | null>
  /** ask_image 查询句柄：据 imageId 从会话 ImageRegistry 取图并按主控视觉能力
   *  返回原图转发 or 定向问答。Absent → ask_image 报视觉不可用。 */
  visionAsk?: (imageId: string | undefined, question: string, signal?: AbortSignal) => Promise<import('../tools/types.js').VisionAskResult>
  /** 把工具截图寄存进会话 ImageRegistry，返回分配的 id（供 ask_image 追问）。
   *  Absent（worker / 无 registry）→ 截图照旧只走描述通道，不可追问。 */
  registerImages?: (images: string[]) => string[]
  recordToolHistory: (name: string, input: Record<string, unknown>, isError: boolean, content: string, errorClass?: ToolErrorClass, errorKind?: FailureClass) => void
  buildRuntimeSnapshot: (extra?: Partial<RuntimeHookSnapshot>) => RuntimeHookSnapshot
  requestThetaCheck: (reason: string) => void
  /** Wave 2 控制面：postTool hook 结构化事实上报出口（shadow 记账，不改 prompt）。 */
  submitControlSignal?: (signal: import('./control-plane.js').ControlSignal) => void
  getAutoReasoning: () => boolean
  getReasoningEffort: () => ReasoningEffort | undefined
  setClientReasoningEffort: (effort: ReasoningEffort) => void
  getSensorium: () => Sensorium | null
  getReliabilityDecision: () => ReliabilityDecision | null
  getTurnBudget: () => TurnBudget
  /** Artifact store for persisting tool output — injected via params, no global setter */
  artifactStore?: import('../artifact/store.js').ArtifactStore
  /** Late-bound background job registry getter (server replaces it post-construction). */
  getJobs?: () => import('../tools/job-store.js').JobRegistry | undefined
  /** Late-bound monitor registry getter (monitor tool + monitor-hook share it). */
  getMonitors?: () => import('./monitor-registry.js').MonitorRegistry | undefined
  /** Session state manager for cross-turn awareness */
  sessionStateManager?: import('./session-state.js').SessionStateManager
  /** Cache advisor for adaptive thresholds */
  cacheAdvisor?: CacheAdvisor
  /** P3 integration facade */
  p3?: P3Integration
  /** Immune system hook (forwarded to tool-pipeline for adaptive learning) */
  immuneHook?: ImmuneHook
  /** Current StarPhase mapped to phaseClass. Used by tool-pipeline for phase-aware
   *  prediction recording — e.g., TDD RED in verify phase is NOT a prediction error. */
  getPhaseHint?: () => string | undefined
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy. */
  lspManager?: LspManager
  /** T4: late-bound LSP manager getter. */
  getLspManager?: () => LspManager | null
  /** Session-level estimated token count — enables context-pressure-aware truncation. */
  getEstimatedTokens?: () => number
  /** Tool name history — for tool storm detection. */
  getToolNameHistory?: () => string[]
  /** Record a named fingerprint (tool name + fingerprint) */
  recordToolNamedFingerprint?: (fingerprint: string, toolName: string) => void
  /** Capture an agent's departure mark (leave_mark tool) for 主控 to record at close. */
  onLeaveMark?: (mark: import('../tools/types.js').LeaveMarkInput) => void
  /** U6/C1: capture goal decomposition (plan_steps) for the loop's PlanExecutionTrace. */
  onPlanSteps?: (steps: import('../tools/types.js').PlanStepInput[]) => void
  /** 用户级验收面的声明与核销（todo 的 acceptance 字段 → loop）。 */
  onAcceptance?: (items: import('../tools/types.js').AcceptanceItemInput[]) => void
  /** Write a constellation milestone when plan_close succeeds with apply=true. */
  onPlanClosed?: (input: import('../tools/types.js').PlanClosedInput) => void
  /** Notify the UI that a plan was submitted for approval so it can prompt the user. */
  onPlanSubmitted?: (info: import('../tools/types.js').PlanSubmittedInfo) => void
  /** Notify the UI that the agent asked the user a question with selectable options. */
  onAskUserQuestion?: (info: import('../tools/types.js').AskUserQuestionInfo) => void
  /** Evidence-gated plan closure: assess the real delivery gate over owned/dirty files. */
  assessDelivery?: (dirtyFiles?: string[]) => import('./delivery-gate-v2.js').DeliveryGateResult
  /** 主动 plan mode：plan action=enter_mode → AgentLoop.enterPlanMode（仅主控有）。 */
  enterPlanMode?: () => { activePlanFilePath: string | null; alreadyPlanning: boolean }
  /** 闭环自动退出：plan action=close 标记 EXECUTED 后 → AgentLoop.exitPlanMode（仅主控有）。 */
  exitPlanMode?: () => void
  /** Real verification records for this session (evidence-gated plan closure). */
  getVerificationEvidence?: () => import('./evidence.js').VerificationSummary
  /** Called when the model explicitly loads a skill via the skill tool. */
  onSkillInvoked?: (name: string) => void
  /** Called when the model explicitly marks a skill as complete via the skill tool. */
  onSkillCompleted?: (name: string) => void
  /** Whether goal mode is active — relaxes doom-loop thresholds when true. */
  isGoalActive?: () => boolean
  /** 破坏性命令 pre-execution 闸门(会话级状态,loop 持有,pipeline 读写)。 */
  destructiveGate?: import('../tools/destructive-gate.js').DestructiveGateState
  /** W2 被拦不弃守护：gate/deny 拦截事件上报（loop 持 turn 级计数）。 */
  onGateBlocked?: (kind: string) => void
  /** TDD gate 被拦上报：同一 target 反复触发时 advisory 提醒（loop 持会话级计数）。 */
  onTddBlocked?: (target?: string) => void
  /** 遥测写入(缺口 B 输出裁剪计数等)。 */
  writeTelemetry?: (record: { kind: string } & Record<string, unknown>) => void
  beginToolBatchObservability?: (outputMeasured: boolean) => void
  recordSanitizedOutput?: (rawContent: string, sanitizedContent: string, filterId?: string) => void
  recordToolUiEvent?: () => void
  endToolBatchObservability?: () => void
}

export interface ToolExecBatchInput {
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  callbacks: AgentCallbacks
  turn: number
  checkpointCreatedThisTurn: boolean
  abortSignal: AbortSignal
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
}

export interface ToolExecBatchResult {
  latestRisk: RiskAssessment
}

export interface ToolExecBatchResult {
  checkpointCreated: boolean
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  latestRisk: RiskAssessment
  /** Artifact IDs created (evicted) this batch — for GhostRegistry */
  artifactIdsEvicted: string[]
  /** Artifact IDs accessed (read_section) this batch — for GhostRegistry */
  artifactIdsAccessed: string[]
  /** True when any tool returned endTurn: true (e.g. ask_user_question). */
  endTurn?: boolean
  /** Number of tool_use in this batch — for wedged-loop detection. */
  toolCount: number
  /** Number of tool_result marked is_error in this batch — for wedged-loop detection. */
  errorCount: number
}

export class ToolExecutionController {
  private accumulator = new ToolAccumulator()
  constructor(private deps: ToolExecutionDeps) {}

  /**
   * T2-02 P0: Shadow telemetry for effort bandit at intervention adjustment point.
   * Records what the bandit would recommend without changing behavior.
   */
  private shadowEffortAdjustment(oldEffort: string, newEffort: string): void {
    try {
      if (!this.deps.p3) return
      // Build lightweight context from available deps
      const predAcc = this.deps.getPredictionAccumulator()
      const errorRate = getErrorRate(predAcc)
      const ctx = [
        Math.min(1, errorRate * 2),                  // taskComplexity proxy
        errorRate,                                     // errorRate
        computeTurnDepth(this.deps.getSessionTurnCount()), // turnDepth（此层拿不到 maxTurns → 无上限口径）
        0,                                             // fileCount (not accessible at this level)
        0,                                             // isRepeat (not accessible)
        new Date().getHours() / 24,                    // timeOfDay
      ]
      this.deps.p3.shadowRecommendEffort(ctx, newEffort)
    } catch {
      // Shadow telemetry must never affect behavior
    }
  }

  /**
   * Build the ToolPipelineDeps bag for a single executeToolUse call.
   *
   * Extracted from the two verbatim-duplicated inline blocks (parallel makeDeps
   * closure + sequential pipelineDeps literal) that previously lived in
   * executeBatch. The per-batch mutable state (traceStore/importGraph/etc.)
   * evolves across the loop, so it is passed in as a snapshot each call; the
   * rest is forwarded from this.deps.
   *
   * The abortSignal threading is load-bearing: without it, deps.abortSignal
   * stays undefined, delegate_task passes undefined to coordinator.delegate,
   * and the coordinator abort path becomes dead code — workers hang past the
   * caller timeout and leak detached bash children. (root-cause 2026-06-05)
   */
  private buildDeps(state: {
    traceStore: TraceStore
    importGraph: ImportGraph | null
    lastConflictCheckCount: number
    latestRisk: RiskAssessment
    artifactIdsEvicted: string[]
    artifactIdsAccessed: string[]
    abortSignal: AbortSignal
  }): ToolPipelineDeps {
    return {
      config: this.deps.config,
      cwd: this.deps.cwd,
      harness: this.deps.harness,
      prewarm: this.deps.prewarm,
      evidence: this.deps.evidence,
      obligations: this.deps.obligations,
      traceStore: state.traceStore,
      repairHintTracker: this.deps.repairHintTracker,
      repairPipeline: this.deps.repairPipeline,
      importGraph: state.importGraph,
      meridianIndexer: this.deps.config.meridianIndexer,
      lastConflictCheckCount: state.lastConflictCheckCount,
      trajectory: this.deps.trajectory,
      getDoomLoopLevel: () => this.deps.getDoomLoopLevel(),
      isGoalActive: this.deps.isGoalActive?.() ?? false,
      latestRisk: state.latestRisk,
      sessionTurnCount: this.deps.getSessionTurnCount(),
      sessionId: this.deps.getSessionId(),
      recordToolHistory: (name, input_, isError, content, errorClass, errorKind) =>
        this.deps.recordToolHistory(name, input_, isError, content, errorClass, errorKind),
      onLeaveMark: this.deps.onLeaveMark,
      onPlanSteps: this.deps.onPlanSteps,
      onAcceptance: this.deps.onAcceptance,
      onPlanClosed: this.deps.onPlanClosed,
      onPlanSubmitted: this.deps.onPlanSubmitted,
      onAskUserQuestion: this.deps.onAskUserQuestion,
      visionAsk: this.deps.visionAsk,
      assessDelivery: this.deps.assessDelivery,
      enterPlanMode: this.deps.enterPlanMode,
      exitPlanMode: this.deps.exitPlanMode,
      getVerificationEvidence: this.deps.getVerificationEvidence,
      onSkillInvoked: this.deps.onSkillInvoked,
      onSkillCompleted: this.deps.onSkillCompleted,
      getInterventionLevel: () => getInterventionLevel(this.deps.getPredictionAccumulator()),
      recordPrediction: (correct) => {
        this.deps.setPredictionAccumulator(
          recordPrediction(this.deps.getPredictionAccumulator(), correct),
        )
      },
      getSensorium: () => this.deps.getSensorium(),
      getReliabilityDecision: () => this.deps.getReliabilityDecision(),
      turnBudget: this.deps.getTurnBudget(),
      artifactStore: this.deps.artifactStore,
      jobs: this.deps.getJobs?.(),
      monitors: this.deps.getMonitors?.(),
      cacheAdvisor: this.deps.cacheAdvisor,
      taskLedger: this.deps.config.taskLedger,
      ownershipLedger: this.deps.config.ownershipLedger,
      verificationSnapshotManager: this.deps.config.verificationSnapshotManager,
      sessionRegistry: this.deps.config.sessionRegistry,
      p3: this.deps.p3,
      immuneHook: this.deps.immuneHook,
      phaseHint: this.deps.getPhaseHint?.(),
      artifactIdsEvicted: state.artifactIdsEvicted,
      artifactIdsAccessed: state.artifactIdsAccessed,
      lspManager: this.deps.lspManager,
      getLspManager: this.deps.getLspManager,
      abortSignal: state.abortSignal,
      destructiveGate: this.deps.destructiveGate,
      onGateBlocked: this.deps.onGateBlocked,
      onTddBlocked: this.deps.onTddBlocked,
    }
  }

  async executeBatch(input: ToolExecBatchInput): Promise<ToolExecBatchResult> {
    const outputSanitizeEnabled = process.env.RIVET_OUTPUT_SANITIZE !== '0'
    this.deps.beginToolBatchObservability?.(outputSanitizeEnabled)
    try {
      const callbacks: AgentCallbacks = this.deps.recordToolUiEvent
      ? {
          ...input.callbacks,
          onToolResult: (...args) => {
            this.deps.recordToolUiEvent?.()
            input.callbacks.onToolResult(...args)
          },
        }
      : input.callbacks
    const toolResults: ContentBlock[] = []
    let checkpointCreatedThisTurn = input.checkpointCreatedThisTurn
    let traceStore = input.traceStore
    let importGraph = input.importGraph
    let endTurn = false
    let lastConflictCheckCount = input.lastConflictCheckCount
    let latestRisk = input.latestRisk
    const artifactIdsEvicted: string[] = []
    const artifactIdsAccessed: string[] = []
    // Vision channel: image attachments carried by this batch's ToolResults
    // (computer_use screenshots). Forwarded after addToolResults as a trailing
    // multimodal user message — only when the model supports vision.
    const pendingImages: string[] = []
    // 结构化失败分类侧信道：wire 块（tool_result）不携带 errorKind，
    // 按 tool_use_id 记录，postTool hook 的 vigor failureClass 优先消费。
    const errorKindByToolUse = new Map<string, FailureClass>()

    // Partition tools into concurrency-safe (parallelizable) and sequential groups.
    // Run contiguous blocks of safe tools in parallel for latency savings.
    const indexed = input.toolUses.map((tu, i) => ({ tu, i, safe: this.deps.config.toolRegistry.get(tu.name)?.isConcurrencySafe() ?? false }))

    let cursor = 0
    while (cursor < indexed.length) {
      if (input.abortSignal.aborted) break

      // Collect contiguous safe tools for parallel execution
      if (indexed[cursor]!.safe) {
        const batchStart = cursor
        while (cursor < indexed.length && indexed[cursor]!.safe) cursor++
        const batch = indexed.slice(batchStart, cursor)

        const results = await Promise.all(
          batch.map(({ tu }) => executeToolUse(
            tu,
            this.buildDeps({ traceStore, importGraph, lastConflictCheckCount, latestRisk, artifactIdsEvicted, artifactIdsAccessed, abortSignal: input.abortSignal }),
            callbacks,
            input.turn,
            checkpointCreatedThisTurn,
          )),
        )
        for (const result of results) {
          traceStore = result.traceStore
          importGraph = result.importGraph
          lastConflictCheckCount = result.lastConflictCheckCount
          latestRisk = result.latestRisk
          if (result.checkpointCreated) checkpointCreatedThisTurn = true
          if (result.endTurn) endTurn = true
          if (result.images) pendingImages.push(...result.images)
          if (result.errorKind && result.toolResult.type === 'tool_result') errorKindByToolUse.set(result.toolResult.tool_use_id, result.errorKind)
          toolResults.push(result.toolResult)
        }
      } else {
        // Sequential execution for non-safe tools
        const { tu } = indexed[cursor]!
        cursor++

        const result = await executeToolUse(
          tu,
          this.buildDeps({ traceStore, importGraph, lastConflictCheckCount, latestRisk, artifactIdsEvicted, artifactIdsAccessed, abortSignal: input.abortSignal }),
          callbacks,
          input.turn,
          checkpointCreatedThisTurn,
        )
        traceStore = result.traceStore
        importGraph = result.importGraph
        lastConflictCheckCount = result.lastConflictCheckCount
        latestRisk = result.latestRisk
        if (result.checkpointCreated) checkpointCreatedThisTurn = true
        if (result.endTurn) endTurn = true
        if (result.images) pendingImages.push(...result.images)
        if (result.errorKind && result.toolResult.type === 'tool_result') errorKindByToolUse.set(result.toolResult.tool_use_id, result.errorKind)
        toolResults.push(result.toolResult)
      }
    }

    // Enforce per-tool-type cumulative budget before aggregate budget.
    const budgetEntries = toolResults
      .map((r, i) => r.type === 'tool_result'
        ? { toolUseId: r.tool_use_id, content: typeof r.content === 'string' ? r.content : '', toolName: input.toolUses[i]?.name ?? '' }
        : null)
      .filter((e): e is NonNullable<typeof e> => e !== null)
    const toolTypeBudgeted = enforceToolTypeBudgets(budgetEntries, this.deps.config.contextWindow)
    for (const entry of toolTypeBudgeted) {
      const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
      if (idx >= 0) {
        const orig = toolResults[idx]!
        if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
          toolResults[idx] = { ...orig, content: entry.content }
        }
      }
    }

    // Enforce per-message aggregate budget before adding to conversation.
    const enforced = enforcePerMessageBudget(toolTypeBudgeted, perMessageToolResultBudget(this.deps.config.contextWindow))
    for (const entry of enforced) {
      const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
      if (idx >= 0) {
        const orig = toolResults[idx]!
        if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
          toolResults[idx] = { ...orig, content: entry.content }
       }
     }
   }

    // Enforce per-turn read budget: truncate read_file results when cumulative
    // chars exceed 15% of the context window.
    const readEnforced = enforceTurnReadBudget(enforced, this.deps.config.contextWindow)
    for (const entry of readEnforced) {
      const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
      if (idx >= 0) {
        const orig = toolResults[idx]!
        if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
          toolResults[idx] = { ...orig, content: entry.content }
       }
     }
    // Context-pressure preflight: when estimated context usage >70%, truncate
    // large read_file results to head-only to prevent context overflow.
    const estimatedTokens = this.deps.getEstimatedTokens?.()
    const ctxWindow = this.deps.config.contextWindow
    if (estimatedTokens != null && ctxWindow != null && ctxWindow > 0) {
      const usageRatio = estimatedTokens / ctxWindow
      const pressureEntries = readEnforced
      const pressureEnforced = enforceContextPressureTruncation(pressureEntries, usageRatio)
      for (const entry of pressureEnforced) {
        const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === entry.toolUseId)
        if (idx >= 0) {
          const orig = toolResults[idx]!
          if (orig.type === 'tool_result' && entry.content !== (typeof orig.content === 'string' ? orig.content : '')) {
            toolResults[idx] = { ...orig, content: entry.content }
         }
       }
     }
     }
   }

    // ── Tool Storm Guard: track & collapse consecutive same-type calls ──
    for (let i = 0; i < input.toolUses.length; i++) {
      const tu = input.toolUses[i]!
      const tr = toolResults[i]
      if (tr && tr.type === 'tool_result') {
        const content = typeof tr.content === 'string' ? tr.content : ''
        this.accumulator.record({ toolName: tu.name, toolUseId: tu.id, content, turn: input.turn })
        this.deps.recordToolNamedFingerprint?.(fingerprintToolCall(tu.name, tu.input, 'running'), tu.name)
      }
    }
    if (input.toolUses.length > 0) {
      const lastToolName = input.toolUses[input.toolUses.length - 1]!.name
      const collapse = this.accumulator.tryCollapse(lastToolName)
      if (collapse) {
        for (const collapsedId of collapse.collapsedIds) {
          const idx = toolResults.findIndex(r => r.type === 'tool_result' && r.tool_use_id === collapsedId)
          if (idx >= 0) {
            const orig = toolResults[idx]!
            if (orig.type === 'tool_result') {
              toolResults[idx] = { type: 'tool_result', tool_use_id: orig.tool_use_id, content: collapse.summary }
            }
          }
        }
      }
    }

    // Check tool storm level for strategy shift hint
    const toolNames = this.deps.getToolNameHistory?.() ?? []
    const stormLevel = getToolStormLevel(toolNames)
    if (stormLevel === 'storm') {
      const lastTr = toolResults[toolResults.length - 1]
      if (lastTr && lastTr.type === 'tool_result') {
        const existing = typeof lastTr.content === 'string' ? lastTr.content : ''
        toolResults[toolResults.length - 1] = {
          ...lastTr,
          content: existing + '\n\n⚠️ [tool-storm-detected] 同类工具连续调用过多（8+次），请考虑更换策略或汇总已有结果。',
        }
      }
    }

    // ── T10: Tool Result Tiering for 1M+ windows ──
    // Read-path tools are exempt: read_file/read_section have their own cap
    // chain (model-read-cap → artifact wrapping → per-call/turn read budgets →
    // context-pressure truncation) and deliberately keep full source inline so
    // the model can construct exact edit_file old_string matches. Tier-1's
    // head/tail summary on a read result breaks the read→edit workflow.
    const TIERING_EXEMPT_TOOLS = new Set(['read_file', 'read_section'])
    const ctxWin = this.deps.config.contextWindow
    if (ctxWin >= 500_000) {
      for (let i = 0; i < toolResults.length; i++) {
        const tr = toolResults[i]!
        if (tr.type !== 'tool_result') continue
        const tu = input.toolUses[i]
        const toolName = tu?.name ?? 'unknown'
        const content = typeof tr.content === 'string' ? tr.content : ''
        // Read-path tools are exempt from tiering at normal sizes — head/tail
        // summary breaks the read→edit workflow. B2: but when a single read
        // exceeds 300K chars, tiering still fires (content is already on disk
        // via artifact — the model can recover via read_section).
        if (TIERING_EXEMPT_TOOLS.has(toolName) && content.length < 300_000) continue
        const target = typeof tu?.input?.file_path === 'string' ? tu.input.file_path
          : typeof tu?.input?.path === 'string' ? tu.input.path
          : toolName
        // Reuse a tool-level artifact when present — it holds the untruncated
        // original, and saving a second (already budget-truncated) copy both
        // wastes disk and shadows the better artifact.
        const existingArtifactId = extractTrailingArtifactId(content)
        const tiered = await tierToolResult(
          toolName,
          content,
          String(target),
          this.deps.artifactStore,
          ctxWin,
          existingArtifactId,
        )
        if (tiered.tier > 0) {
          toolResults[i] = { ...tr, content: tiered.content }
        }
      }
    }

    // Drain steer guidance ONLY when there is a tool_result to attach it to.
    // onSteerDrain() empties the buffer, so calling it without a valid injection
    // target (e.g. abort broke the loop before any result, or last block is not
    // a tool_result) would discard the guidance. Peek the target first; if absent,
    // leave the buffer intact so the next tool-using turn injects it.
    //
    // Runs AFTER budgets/storm-guard/tiering: those transforms replace content
    // wholesale (tier-2 minimal, budget-summarized), and appending steer text
    // before them silently dropped the user's guidance for large results.
    const lastResult = toolResults.length > 0 ? toolResults[toolResults.length - 1]! : null
    if (lastResult && lastResult.type === 'tool_result') {
      const steerText = input.callbacks.onSteerDrain?.()
      if (steerText) {
        const existing = typeof lastResult.content === 'string' ? lastResult.content : ''
        toolResults[toolResults.length - 1] = { ...lastResult, content: existing + '\n\n' + steerText }
      }
    }

    // ── Lossy Observation Guard: detect negative facts in collapsed/truncated tool results
    // and inject VERIFICATION_REQUIRED marker before the model reads them.
    for (let i = 0; i < toolResults.length; i++) {
      const tr = toolResults[i]!
      if (tr.type === 'tool_result' && typeof tr.content === 'string') {
        const guarded = guardLossyToolResult(tr.content)
        if (guarded !== tr.content) {
          toolResults[i] = { ...tr, content: guarded }
        }
      }
    }

    // Backfill: guarantee one tool_result per tool_use. When the batch loop
    // breaks early on abort (see `if (input.abortSignal.aborted) break` above),
    // the remaining tools never produce a result — leaving the already-committed
    // assistant tool_calls message orphaned, which makes the NEXT request fail
    // with "insufficient tool messages following tool_calls". Synthesize an error
    // result for any tool_use missing from toolResults so history stays balanced.
    for (const tu of input.toolUses) {
      if (!toolResults.some(r => r.type === 'tool_result' && r.tool_use_id === tu.id)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: input.abortSignal.aborted
            ? '[aborted] Tool execution was interrupted before this call completed.'
            : '[skipped] Tool produced no result.',
          is_error: true,
        })
      }
    }

    // 缺口 B 输出噪声裁剪:session 只存裁剪版。必须在这里(所有分类器/修复
    // 提示/artifact 拦截/lossy guard 之后、存入历史之前)——它们依赖原始输出。
    // UI 回调(onToolResult)在管线内已收到全文,保真不受影响。
    if (outputSanitizeEnabled) {
      let totalTrimmed = 0
      const filters = new Set<string>()
      for (let i = 0; i < toolResults.length; i++) {
        const tr = toolResults[i]!
        if (tr.type !== 'tool_result' || typeof tr.content !== 'string') continue
        const tu = input.toolUses.find(t => t.id === tr.tool_use_id)
        if (!tu) continue
        const { content, trimmedBytes, filterName } = sanitizeToolOutput(tu.name, tu.input, tr.content)
        this.deps.recordSanitizedOutput?.(tr.content, content, filterName)
        if (trimmedBytes > 0) {
          toolResults[i] = { ...tr, content }
          totalTrimmed += trimmedBytes
          if (filterName) filters.add(filterName)
        }
      }
      if (totalTrimmed > 0) {
        this.deps.writeTelemetry?.({ kind: 'output-sanitize', turn: this.deps.getSessionTurnCount(), trimmedBytes: totalTrimmed, filters: [...filters] })
      }
    }
    this.deps.addToolResults(toolResults)

    // Vision channel: forward tool-carried screenshots to the model as a
    // TRAILING user message (append-only after the tool results — same
    // prefix-cache-safe boundary as the steer path; never rewrites history).
    // Cap at the 2 most recent shots — a batch with several snapshots must not
    // flood the context with megapixel base64.
    if (pendingImages.length > 0) {
      const images = pendingImages.slice(-2)
      // 寄存进会话 registry，这样 ask_image 能就**agent 自己截的图**追问，而不是只能
      // 问用户手动附的图。少了这一步，「截图 → 逐字念出报错那一行」在浏览器验证闭环
      // 里就断了（工具描述承诺可以问"本会话已发送的图片"，registry 里却没有它）。
      // 纯内存 + LRU 上限，不进 oaiMessages / 不落盘。
      const shotIds = this.deps.registerImages?.(images) ?? []
      const askHint = shotIds.length > 0
        ? ` Retained as ${shotIds.join(', ')} — use ask_image with that id to re-interrogate a specific detail.`
        : ''
      if (this.deps.getSupportsVision?.() === true && this.deps.addUserMessageWithImages) {
        this.deps.addUserMessageWithImages(
          '<system-reminder>Screenshot(s) from the tool call(s) above are attached. Use them to visually confirm UI state alongside any accessibility tree or DOM measurements; do not describe them back to the user unless asked.'
          + `${askHint}</system-reminder>`,
          images,
        )
      } else if (this.deps.describeToolImages && !input.abortSignal.aborted) {
        // Text-only primary model with a vision model configured: the bridge
        // that already served user-attached images now also serves screenshots
        // the agent took itself. Without it the agent could take a screenshot
        // and still be blind to it, which is the loop stopping one step short.
        // A failing side model must not take the tool batch down with it — the
        // tool results are already valid without the description.
        let description: string | null = null
        try {
          description = await this.deps.describeToolImages(images, input.abortSignal)
        } catch { /* bridge unavailable — fall through to text-only results */ }
        if (description) {
          this.deps.addUserMessageWithImages?.(
            `<system-reminder>Screenshot(s) from the tool call(s) above, described by the configured vision model:\n${description}`
            + `${askHint}</system-reminder>`,
            [],
          )
        }
      }
      // No vision and no bridge: images are dropped, byte-identical to legacy.
    }

    const level = getInterventionLevel(this.deps.getPredictionAccumulator())
    this.deps.contextInjection.setCerebellarHint(level)

    for (const tu of input.toolUses) {
      const result = toolResults.find(r => r.type === 'tool_result' && r.tool_use_id === tu.id)
      const hasTargetField = typeof tu.input?.file_path === 'string'
        || typeof tu.input?.path === 'string'
        || typeof tu.input?.command === 'string'
      const target = hasTargetField ? toolTargetFromInput(tu.name, tu.input as Record<string, unknown>) : undefined
      await this.deps.runtimeHooks.runPostTool(
        createRuntimeHookContext(
          this.deps.buildRuntimeSnapshot(),
          {
            setVigor: (vigor) => { this.deps.setVigorState(vigor) },
            requestThetaCheck: (reason) => { this.deps.requestThetaCheck(reason) },
            emitControlSignal: signal => { this.deps.submitControlSignal?.(signal) },
            markClaimStale: claimId => {
              this.deps.config.contextClaimStore?.updateClaimStatus(
                claimId,
                'stale',
                `invalidated by ${tu.name}${target ? ` on ${target}` : ''}`,
              )
           },
         },
        ),
        {
          name: tu.name,
          success: !(result && 'is_error' in result && result.is_error === true),
          isError: result && 'is_error' in result ? result.is_error === true : false,
          target,
          input: tu.input,
          resultContent: result && 'content' in result && typeof result.content === 'string' ? result.content : undefined,
          // 发现二修复：礼的真实判定——yolo 模式跳过审批门（approvalRequired=false），
          // 其他模式下写操作走审批门（true）。非写工具始终 undefined。
          approvalRequired: (tu.name === 'write_file' || tu.name === 'edit_file' || tu.name === 'hash_edit')
            ? this.deps.config.approvalMode !== 'dangerously-skip-permissions'
            : undefined,
          // Classify failure for vigor: environment issues (timeout, api_error)
          // get reduced phasic penalty vs semantic failures (type_error, assertion).
          // 测试运行（run_tests 或 bash 跑测试命令）的断言失败走 test_red →
          // weight=0.0（TDD 红灯不扣分）。只读探测的 not-found 走 probe_miss →
          // weight=0.3（A5：反幻影探针是信息收集，不是认知失败）。
          failureClass: result && 'is_error' in result && result.is_error === true
            ? errorKindByToolUse.get(tu.id) ?? classifyFailure(
                typeof result.content === 'string' ? result.content : '',
                {
                  isTestRun: isTestRunInvocation(tu.name, tu.input as Record<string, unknown> | undefined),
                  isReadProbe: isReadProbeInvocation(tu.name),
                },
              ).class
            : undefined,
       },
      )
   }

    // Update session state based on tool results
    const mgr = this.deps.sessionStateManager
    if (mgr) {
      for (const tu of input.toolUses) {
        const result = toolResults.find(r => r.type === 'tool_result' && r.tool_use_id === tu.id)
        const isError = result && 'is_error' in result ? result.is_error === true : false
        if (!isError) {
          if (tu.name === 'read_file' && typeof tu.input?.file_path === 'string') {
            mgr.trackFileRead(tu.input.file_path, `read:${tu.id}`)
         }
          if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input?.file_path === 'string') {
            mgr.trackFileModified(tu.input.file_path)
         }
       }
        if (tu.name === 'run_tests') {
          const target = typeof tu.input?.filter === 'string' ? tu.input.filter : 'tests'
          mgr.recordVerification(target, isError ? 'failed' : 'passed')
       }
     }
   }

    if (shouldTippingPointReset(this.deps.getPredictionAccumulator())) {
      this.deps.setPredictionAccumulator(resetAccumulator(this.deps.getPredictionAccumulator()))
      this.deps.contextInjection.clearCerebellarHint()
   }
    if (this.deps.getAutoReasoning() && this.deps.getReasoningEffort()) {
      const newEffort = adjustReasoningEffort(this.deps.getReasoningEffort()!, level)
      // T2-02 P0: shadow telemetry — record bandit recommendation without changing behavior
      this.shadowEffortAdjustment(this.deps.getReasoningEffort()!, newEffort)
      this.deps.setClientReasoningEffort(newEffort)
   }

    const errorCount = input.toolUses.reduce((n, tu) => {
      const result = toolResults.find(r => r.type === 'tool_result' && r.tool_use_id === tu.id)
      return n + (result && 'is_error' in result && result.is_error === true ? 1 : 0)
    }, 0)

      return { checkpointCreated: checkpointCreatedThisTurn, traceStore, importGraph, lastConflictCheckCount, latestRisk, artifactIdsEvicted, artifactIdsAccessed, endTurn: endTurn || undefined, toolCount: input.toolUses.length, errorCount }
    } finally {
      this.deps.endToolBatchObservability?.()
    }
 }
}
