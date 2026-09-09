import type { ToolDefinition } from '../api/types.js'
import type { ArtifactStore } from '../artifact/store.js'
import type { PrewarmCache } from '../agent/prewarm.js'
import type { ReadRefStats } from './read-file.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import type { FailureClass } from '../agent/failure-classifier.js'
import type { ContractProjection } from '../agent/contract-projection.js'
import type { OrchestrationOutcome } from '../agent/orchestration-outcome.js'

/**
 * T4 — structured per-worker delegation update for the desktop subagent panel
 * (Codex `Down` panel / Antigravity Manager parity). Emitted alongside (not
 * replacing) the existing text progress stream. `running` carries the latest
 * activity line; a terminal status carries the worker's outcome.
 */
export interface DelegationIdentity {
  /** Optional dispatch scope; stable across workers from one tool invocation. */
  dispatchId?: string
  /** Optional execution identity; unique per dispatch (in-dispatch retries/escalations reuse it). */
  attemptId?: string
  /** Execution identity of the parent worker for nested delegation. */
  parentAttemptId?: string
}

export interface DelegationActivity extends DelegationIdentity {
  /** Stable per-worker id within a run (work order id), distinct from the tool id. */
  workOrderId: string
  /** The delegation tool call that spawned this worker (delegation tree parent). */
  parentToolId: string
  /** 派发这个 worker 的父 worker 的 work order id（嵌套委派专属）。顶层
   *  委派缺省——parentToolId 已足够把 worker 挂到工具卡下；只有 worker 再派
   *  sub-worker 时由 coordinator 盖章，UI 据此渲染真实父子层级。 */
  parentWorkerId?: string
  profile?: string
  /** 星域 id（星名来源），从 WorkerActivityEvent.authority 透传。 */
  authority?: string
  /** Why this authority was chosen (from WorkOrder.authorityReason). */
  authorityReason?: string
  /** UI 活动带终态词汇（2026-08-25 收口）：'completed' 是唯一「跑完且通过」态——
   *  WorkerResult.status 的 'passed' 由 terminalActivity 统一映射而来，两值不再分裂并存。 */
  status: 'running' | 'completed' | 'failed' | 'blocked' | 'escalated'
  /** Worker task objective — prefer on first running + terminal events only
   *  to avoid repeating the same text on every activity tick. */
  objective?: string
  /** Latest worker activity line (running) or terminal summary. */
  progressLine?: string
  /** Terminal digest for the desktop thread view / 「汇入主会话」 adopt button.
   *  Distinct from progressLine (which is truncated for the live ticker). */
  summary?: string
  /** 该 worker 累计工具调用次数（CC AgentProgress 对标，运行中实时递增）。 */
  toolUseCount?: number
  /** 该 worker 累计 token 总数（input+output，来自 turn 事件的累计快照）。 */
  tokenCount?: number
  /** 原始活动事件种类（worker 消息镜像 store 重建消息流用；terminal 事件缺省）。 */
  eventKind?: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'turn' | 'retry' | 'lifecycle'
  /** 原始事件内容：text/thinking 为 delta，tool_use/tool_result 为工具名。 */
  eventDetail?: string
  /** Terminal failure classification (WorkerFailureReason in agent/work-order.ts;
   *  typed as string here to avoid a tools→agent dependency). Present only on
   *  terminal blocked/failed events. */
  failureReason?: string
  /** Actual model dispatched for this worker (insights / cost visualization). */
  model?: string
  /** Provider name for this worker (insights / cost visualization). */
  provider?: string
  /** Token usage for this worker (insights / cost visualization). */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_tokens?: number
    total_tokens?: number
  }
  /** Persisted diff artifact id (in the worker's fallback session). Lets the UI
   *  fetch this worker's diff for independent review. Absent when the worker
   *  produced no diff or persistence failed (降级：UI 隐藏 diff 入口). */
  artifactId?: string
  /** Files this worker changed (for diff review entry hints). */
  changedFiles?: string[]
  /** 用户契约投影——只随首条 running 事件携带（同 objective 先例）。 */
  contract?: ContractProjection
  /** 终态 findings 计数（不进完整数组，保持 SSE 轻量）。 */
  findingsCount?: number
  /** 终态第一条 finding claim（空/无则缺省）。 */
  topFinding?: string
  /** 终态 verification 摘要。passed/failed 随 VerificationMetadata 放宽为可选
   *  （worker 自报/系统补录的元数据可不含计数）。 */
  verificationBrief?: { status: string; passed?: number; failed?: number }
  /** 终态 evidenceStatus。 */
  evidenceStatus?: string
  /** 谁派发的该 worker：'user' = 用户侧派发（sidecar delegateWorker 直达），'agent' = 主模型
   *  派发。桌面舰队面板据此标记用户工人。coordinator 事件流不带此字段（缺省即 agent 派发），
   *  sidecar 在用户派发路径上显式补 'user'（session-manager emitDelegationActivity 同款）。 */
  origin?: 'user' | 'agent'
}

/**
 * An agent's self-chosen departure mark, captured by the `leave_mark` tool and
 * recorded by 主控 (the post-session hook) as one constellation milestone.
 */
export interface LeaveMarkInput {
  /** Agent's self-chosen symbol (any glyph). */
  symbol: string
  /** One-line summary of the journey. */
  summary: string
  type?: 'feature' | 'fix' | 'refactor' | 'architecture' | 'milestone'
  tags?: string[]
}

export interface PlanClosedInput {
  planFile: string
  tasks: string
  deliveryState: 'GREEN' | 'YELLOW' | 'RED'
  totalChangedCheckboxes: number
}

/** Plan submitted for approval — surfaced to the TUI so it can prompt the user
 *  for approve/reject without requiring a slash command. */
export interface PlanSubmittedInfo {
  slug: string
  title: string
  /** Plan options (approaches) recorded at submit time. */
  options?: Array<{ label: string; description: string }>
}

/** Ask-user-question surfaced to the TUI so it can render an arrow-key selector
 *  instead of requiring the user to type a number or option text. */
export interface AskUserQuestionInfo {
  questions: Array<{
    id: string
    prompt: string
    options: string[]
    allowMultiple: boolean
  }>
}

/** U6/C1: a step input passed through onPlanSteps to seed/sync PlanExecutionTrace. */
export interface PlanStepInput {
  /** Optional stable identifier (e.g. todo id). */
  id?: string
  /** Step description shown in trace / UI. */
  content: string
  /** Current status from the todo list, if known. */
  status?: 'pending' | 'in_progress' | 'completed'
}

/**
 * 用户级验收项（2026-07-25 交付前行为验收闸门）。经 `onAcceptance` 从 todo 工具
 * 流向 loop：声明写进 `TaskContract.successCriteria`，状态回写核销 acceptance 义务。
 */
export interface AcceptanceItemInput {
  /** 用户做什么动作 → 看到什么可观察结果。拒绝内部属性/信号级表述。 */
  criterion: string
  status: 'pending' | 'met' | 'blocked'
  /** met：实际执行了什么观察到了什么；blocked：为何执行不了。 */
  evidence?: string
}

/** ask_image → visionAsk 的结果。二选一：
 *  - answer：text-only 主控经视觉桥得到的问题答案（工具直接把它作为 content 返回）。
 *  - forwardImage：多模态主控可直接看的原图 data URL（工具作为 ToolResult.images 返回，
 *    由 tool-execution 转发通道递给主控原生识图）。
 *  error：图不存在/视觉不可用等，工具据此返回 isError。 */
export interface VisionAskResult {
  answer?: string
  forwardImage?: string
  error?: string
  /** 命中描述缓存（观测/调试用）。 */
  cached?: boolean
}

/**
 * VSW: a resolved snapshot plan attached to a verification tool call. Built by
 * the session-scoped verification-snapshot-manager from the §6 policy decision.
 */
export interface VerificationSnapshotPlan {
  /** Snapshot worktree directory (Phase A cwd). */
  path: string
  /** Content-addressed identity (baselineHead + sha(ownedDiff)) for metadata. */
  snapshotRef: string
}

export interface ToolCallParams {
  input: Record<string, unknown>
  toolUseId: string
  cwd: string
  /** 当前会话审批档（tool-pipeline 每次调用注入）。仅极少数按档分叉的工具
   *  读取（bash 沙箱拒绝的首触即授）；bare string 而非类型导入——tools 层
   *  不反向依赖 agent 层类型（sandbox-profile 同先例）。 */
  approvalMode?: string
  onOutput?: (chunk: string) => void
  /** Register a file written internally by a tool (e.g. ast-edit via writeFileAtomicAsync).
   *  Ensures evidence/filesModified and cerebellar gate are aware of the write. */
  onFileWrite?: (filePath: string) => void
  /** Capture an agent's departure mark for 主控 to record at session close. */
  onLeaveMark?: (mark: LeaveMarkInput) => void
  /** Write a constellation milestone when plan_close succeeds with apply=true. */
  onPlanClosed?: (input: PlanClosedInput) => void
  /** Notify the UI that a plan was submitted for approval so it can prompt the user. */
  onPlanSubmitted?: (info: PlanSubmittedInfo) => void
  /** Notify the UI that the agent asked the user a question with selectable options. */
  onAskUserQuestion?: (info: AskUserQuestionInfo) => void
  /** Evidence-gated plan closure (防伪闭环): assess the real delivery gate over
   *  owned/dirty files. Pre-bound to the session's evidence + ownership. Absent
   *  in worker/non-agent contexts → plan_close falls back to trusting the
   *  self-reported deliveryState. */
  assessDelivery?: (dirtyFiles?: string[]) => import('../agent/delivery-gate-v2.js').DeliveryGateResult
  /** Real verification records for this session — used by plan_close to record
   *  actual verified commands instead of the model's self-reported list. */
  getVerificationEvidence?: () => import('../agent/evidence.js').VerificationSummary
  /** U6/C1: capture the goal decomposition (ordered step descriptions) produced
   *  by the plan_steps tool during planning. The loop maps these into the active
   *  PlanExecutionTrace. Absent in non-task / worker contexts → tool is a no-op. */
  onPlanSteps?: (steps: PlanStepInput[]) => void
  /** 用户级验收面的声明与核销（todo 工具的 acceptance 字段）。loop 侧写入
   *  TaskContract.successCriteria 并 satisfy/block acceptance 义务。
   *  worker/非任务上下文缺省 → 工具侧 no-op。 */
  onAcceptance?: (items: AcceptanceItemInput[]) => void
  /** T4: structured per-worker delegation updates (subagent panel). Optional —
   *  set by the tool pipeline; absent in non-server contexts (no-op). */
  onWorkerActivity?: (activity: DelegationActivity) => void
  /** 视觉副驾查询句柄（ask_image 工具用）。据 imageId 从会话 ImageRegistry 取图后：
   *  - 主控多模态 → 返回 { forwardImage } 原图，由 pipeline 转发给主控原生识图；
   *  - 主控 text-only → 用 question 定向问视觉桥，返回 { answer } 文本（命中缓存零调用）。
   *  absent（worker/无 registry/未配桥）→ ask_image 报"视觉不可用"。 */
  visionAsk?: (
    imageId: string | undefined,
    question: string,
    signal?: AbortSignal,
  ) => Promise<VisionAskResult>
  /** Files this session/tool pipeline owns and may safely include in scoped write operations. */
  sessionModifiedFiles?: string[]
  /** Artifact store for persisting tool output — no global setter, always inject via params */
  artifactStore?: ArtifactStore
  /** Session-scoped background job registry — enables bash run_in_background and
   *  the `job` tool (list/logs/await/kill). Absent in TUI/non-server contexts →
   *  bash degrades to foreground execution. */
  jobs?: import('./job-store.js').JobRegistry
  /** Session-scoped monitor registry — enables the `monitor` tool (subscribe /
   *  list / unsubscribe). Absent → monitor degrades to a hint to use job(await). */
  monitors?: import('../agent/monitor-registry.js').MonitorRegistry
  /** Prewarm cache for speculative file reads — injected so read_file can hit
   *  warmed entries (mtime-verified) instead of a cold fs read. Per-session. */
  prewarmCache?: PrewarmCache
  /** Per-session read-ref telemetry accumulator. When injected, read-ref
   *  savings scope to this session instead of accumulating process-wide. */
  readRefStats?: ReadRefStats
  /** B1: Task identifier for ownership attribution */
  taskId?: string
  /** B1: Files owned by the current task (subset of sessionModifiedFiles, excluding externals) */
  ownedFiles?: string[]
  /** B1: Worktree baseline hash for integrity verification (structural identity, NOT a commit) */
  baselineHash?: string
  /** VSW: real baseline commit SHA captured at task start (BaselineSnapshot.head).
   *  Distinct from baselineHash — this is the commit-ish a snapshot worktree
   *  detaches onto so verification runs on (baseline.head + owned diff). */
  baselineHead?: string
  /** VSW: active snapshot plan for this verification. When present, run_tests
   *  runs two phases — Phase A in `path` (isolated, blocking) tagged with
   *  `snapshotRef`, then Phase B in the live `cwd` (integration, advisory).
   *  Absent → in-place single-phase verification (default, unchanged). */
  verificationSnapshot?: VerificationSnapshotPlan
  /** VSW C3: failure-attribution retry. Injected by the pipeline only when an
   *  in-place verification is at pollution risk (peer sessions on this cwd or
   *  recent workspace_mutation events). When the in-place run FAILS, run_tests
   *  calls this to force-build a snapshot and reruns there once — snapshot-pass
   *  + live-fail attributes the failure to workspace pollution, not the code. */
  prepareRetrySnapshot?: () => Promise<VerificationSnapshotPlan | null>
  /** P0-2: Active context window — drives per-call read caps for read_file/grep. */
  contextWindow?: number
  /** P0-2: Provider profile — read caps relax for cache-preserving providers. */
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  /** Per-agent read-cap override — wins over the contextWindow-derived cap.
   *  Workers run with compaction disabled AND the 1M-window request-side
   *  pruning skipped, so a single uncapped full-file read stays in history and
   *  is re-sent every turn until the turn budget dies (2026-07-24 诊断).
   *  Injected via AgentConfig.readCapOverride; absent → computed cap as before. */
  readCapOverride?: import('./model-read-cap.js').ModelReadCap
  /** Current session turn count — enables progressive timeout strategies. */
  sessionTurnCount?: number
  /** Session identifier — used to isolate per-session state (read history,
   *  dedup tracking) so concurrent sessions in the same cwd don't cross-
   *  contaminate (e.g. a forked session seeing "already read" for a file
   *  only the parent read). */
  sessionId?: string
  /** Review-router re-entrancy depth propagated into worker contexts. */
  reviewDepth?: number
  /** B3: delegation nesting depth of the calling agent (primary=0, worker=1).
   *  Delegate tools forward this so the coordinator can enforce the depth cap. */
  delegationDepth?: number
  /** Active plan draft file (relative to cwd) while in plan mode. */
  activePlanFilePath?: string | null
  /** 主动 plan mode：模型经 plan action=enter_mode 自主进入计划模式。
   *  Pre-bound 到主控 AgentLoop.enterPlanMode；worker/非 agent 上下文缺席 →
   *  enter_mode 返回错误（fail-closed，worker 不允许切主控状态）。
   *  alreadyPlanning=true 表示进入前已在 plan mode（幂等返回，未重建草稿）。 */
  enterPlanMode?: () => { activePlanFilePath: string | null; alreadyPlanning: boolean }
  /** 闭环自动退出 plan mode：plan action=close 把 active plan 标记 EXECUTED 后
   *  由 planCloseExecute 调用（桌面端"闭环即解锁"）。Pre-bound 到主控
   *  AgentLoop.exitPlanMode；worker/非 agent 上下文缺席 → 不退出。
   *  「未执行时退出归用户」原则不变——此处只承载闭环自动退出。 */
  exitPlanMode?: () => void
  /** 当前会话模型名 —— plan submit 用于产出模型留痕。 */
  sessionModel?: string
  /** AbortSignal from the tool pipeline — fires when the tool-level timeout
   *  rejects. Delegate tools propagate this to the coordinator so zombie
   *  workers are cleaned up immediately. */
  abortSignal?: AbortSignal
  /** Called when the model explicitly loads a skill via the skill tool. */
  onSkillInvoked?: (name: string) => void
  /** Called when the model explicitly marks a skill as complete via the skill tool. */
  onSkillCompleted?: (name: string) => void
  /**
   * E4 — client landing delegation. Write/edit/bash call this after computing
   * the final payload and before local fs/spawn. Return null → local path.
   * Structural type (tools must not import server/) — matches DelegateResult.
   */
  onClientDelegate?: (
    kind: 'apply_edit' | 'terminal_exec',
    payload: Record<string, unknown>,
  ) => Promise<{ content: string; isError?: boolean; uiContent?: string; status?: 'ok' | 'rejected' } | null>
}

export type VerificationFailureKind = 'test_failure' | 'tool_invocation_failure'

/** Root cause when status is 'blocked'. Absent for passed/failed.
 *  Enables downstream (attribution, gate, deliver_task) to give
 *  scenario-specific guidance instead of a uniform "tests blocked" message. */
export type VerificationBlockedReason =
  | 'no_test_framework'    // no package.json / no detectable runner at all
  | 'no_tests_found'        // project has a runner but no test files detected
  | 'filter_unresolved'     // run_tests(filter=...) could not resolve to a test file
  | 'unknown_runner'        // npm test script uses an unrecognized runner (not vitest/jest/node-test)
  | 'timeout'               // tests timed out
  | 'invocation_failure'    // runner crashed / EPERM / could not start

export interface VerificationMetadata {
  command: string
  status: 'passed' | 'failed' | 'blocked'
  scope: 'full' | 'targeted'
  /** 以下数值字段可选（2026-08-01）：run_tests 等真实执行始终填充；worker 自报
   *  的 verification 已降为交叉校验口径，系统补录的元数据不含计数。消费方不得
   *  假定它们必存在。 */
  exitCode?: number
  passed?: number
  failed?: number
  skipped?: number
  durationMs?: number
  failureKind?: VerificationFailureKind
  /** Why verification was blocked — enables scenario-specific guidance downstream. */
  blockedReason?: VerificationBlockedReason
  /** User-facing next step when blocked (e.g. "项目缺少测试框架，运行 npm init 后配置 test 脚本"). */
  userGuidance?: string
  targetFiles?: string[]
  resolvedCommand?: string
  recommendedCommand?: string
  /** VSW: identity of the snapshot this verification ran against
   *  (baselineHead + sha(ownedDiff)). Absent for in-place (non-snapshot) runs.
   *  When the owned diff changes, the ref changes → old verifications go stale. */
  snapshotRef?: string
  /** VSW two-phase: 'isolated' = Phase A on baseline.head + owned diff (blocking
   *  gate); 'integration' = Phase B on current HEAD + owned diff (advisory). */
  verificationPhase?: 'isolated' | 'integration'
  /** Unix ms timestamp when this verification was recorded. */
  timestamp?: number
}

/** Classification of a failing shell result — shared by ToolResult + pipeline signatures. */
export type ToolErrorClass = 'environment' | 'exec-failure' | 'timeout'

export interface ToolResult {
  /** Content sent to model as tool_result */
  content: string
  /** UI summary override — falls back to content if not provided */
  uiContent?: string
  /** Path to persisted raw output file */
  rawPath?: string
  /** Observational fidelity of this result:
   *  - lossless: full output, no truncation or collapse
   *  - truncated: output was clipped (stdout ring buffer, line limit)
   *  - collapsed: output was replaced by an aggregate summary (ToolAccumulator storm-collapse)
   *  - preview_only: output is a head/tail preview, not the full content
   *  Undefined = lossless (backward compatible default). */
  lossiness?: 'lossless' | 'truncated' | 'collapsed' | 'preview_only'
  /** Optional image attachments (data URLs, e.g. computer_use screenshots).
   *  Tool messages are text-only at the protocol level; the tool pipeline
   *  decides whether to forward these as a follow-up multimodal user message
   *  (only when the active model declares supportsVision) or drop them. */
  images?: string[]
  isError?: boolean
  verification?: VerificationMetadata
  /** Additional verification events to record beyond the primary one. VSW uses
   *  this to record the Phase B (integration) verification alongside the
   *  primary Phase A (isolated) verification from a single run_tests call. */
  extraVerifications?: VerificationMetadata[]
  /** Raw output byte count before any truncation (bash stdout+stderr). */
  rawBytes?: number
  /** Raw output line count before any truncation (bash stdout+stderr). */
  rawLines?: number
  /** Exit code for shell commands (bash). */
  exitCode?: number
  /** Classification of a failing shell result. 'environment' = the command could not
   *  run because the host lacks it (command-not-found / shell-not-found), NOT a model
   *  competence failure — downstream (momentum/doom/approval) must not penalise these,
   *  otherwise benign Windows command-name differences make the agent timid.
   *  'timeout' = the command exceeded its budget — slow ≠ dead-end, so dead-end
   *  pheromone deposition must exclude these too. */
  errorClass?: ToolErrorClass
  /** 结构化失败分类（中文化第二波解耦层）——工具自报的失败类别，
   *  优先于 failure-classifier 的英文正则文本匹配。消息文案中文化后
   *  正则会失灵，凡自家消息会被 classifyFailure 正则命中的工具
   *  （timeout / not-found / assertion 等）必须在中文化前先打此字段。
   *  与 errorClass（shell 三态，驱动 vigor 豁免）语义正交：errorKind
   *  是全谱失败分类学（FailureClass），喂给 repair-hint / antibody /
   *  doom-loop 指纹 / blocked 通知等下游。undefined = 回退文本正则。 */
  errorKind?: FailureClass
  /** Executed command (bash) — used by ToolAccumulator for per-command collapse summaries. */
  command?: string
  /** Signal the turn loop to end after this tool result (e.g. ask_user_question
   *  needs the user's next message as the answer). When true, the orchestrator
   *  completes the turn as final instead of continuing the tool loop. */
  endTurn?: boolean
  /** Write-family tools (edit_file/write_file) report the AFTER-file line ranges
   *  they touched (1-based, inclusive). The tool-pipeline uses this to narrow the
   *  whole-file LSP diagnostics it appends to the model: in-region diagnostics are
   *  surfaced fully, out-of-region errors collapse to a one-line nudge, and
   *  out-of-region warnings are dropped. Absent → append site keeps whole-file
   *  behavior. See computeChangedLineRanges / filterDiagnosticsForEdit. */
  changedRanges?: Array<{ start: number; end: number }>
  /** 编排工具（team_orchestrate 等）回给上游编排器的结构化事实。
   *  starflow 门禁优先读它，缺席才回退 formatter 文案正则——文案改动
   *  不应让门禁静默失效（见 2026-08-01 TEAM_DISPATCHED_RE 事故）。 */
  orchestration?: OrchestrationOutcome
}

export interface Tool {
  definition: ToolDefinition
  execute(params: ToolCallParams): Promise<ToolResult>
  requiresApproval(params: ToolCallParams): boolean
  isConcurrencySafe(): boolean
  isEnabled(): boolean
  /** Maximum execution time in ms before the tool-pipeline aborts.
   *  Override for long-running orchestrator tools (delegate, batch).
   *  Default: 120 000 (2 minutes). */
  timeoutMs?(params?: ToolCallParams): number
}
