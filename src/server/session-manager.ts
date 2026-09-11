/**
 * RuntimeSessionManager — desktop-facing multi-session layer (M0.5).
 *
 * Owns N independent agent runs and turns their AgentCallbacks into a single
 * monotonic, replayable event log per session. Deliberately separate from
 * src/agent/session-registry.ts (that is the cross-session claims/events
 * registry) — these bridge, they do not merge.
 *
 * Invariants:
 *  - Every event carries a monotonic `seq`; `getEvents(since)` replays the tail,
 *    so a dropped viewer never loses history (B3).
 *  - A viewer unsubscribing NEVER aborts the run; only abort() does.
 *  - Approvals are requestId-keyed two-way interventions resolved out of
 *    band by answerIntervention() (B2). Intent direction notes are one-way,
 *    non-blocking timeline events (intent_note) — no pending state.
 *  - Artifacts are surfaced from each session's own ArtifactStore, never shared
 *    across sessions (B4).
 */
import type { AgentCallbacks, ApprovalMode } from '../agent/loop-types.js'
import { touchActivity, markIdle } from '../agent/stall-observer.js'
import { randomUUID } from 'node:crypto'
import { debugLog } from '../utils/debug.js'
import { collectPostBoundaryEditIds } from '../agent/file-history.js'
import { loadConfig } from '../config/manager.js'
import type { DelegationActivity, Tool } from '../tools/types.js'
import type { ApprovalResult } from '../agent/approval-edit.js'
import type { HookEvent, HookResult } from '../hooks/user-hooks-runner.js'
import type { IntentPreview } from '../agent/intent-preview.js'
import { describeIntentNote } from '../agent/intent-preview.js'
import type { Artifact } from '../artifact/types.js'
import { ArtifactStore } from '../artifact/store.js'
import type { OaiMessage } from '../api/oai-types.js'
import { isAssistantWithTools, oaiMessageText, type OaiToolCall } from '../api/oai-types.js'
import { buildUserAnchors, stripInjectedSuffix } from './rewind-anchors.js'
import { toolArgSummary } from '../tui/tool-label.js'
import { listPersistedResultRounds, loadPersistedResult, type PersistedResultRound } from '../agent/coordinator.js'
import { loadWorkerSession } from '../agent/worker-session-persist.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import type { DecisionShift } from '../agent/loop-types.js'
import type { PlanModeState } from '../agent/plan-mode.js'
import type { AskModeState } from '../agent/ask-mode.js'
import {
  listPlans as storeListPlans,
  readPlan as storeReadPlan,
  rejectPlan as storeRejectPlan,
  writePlan as storeWritePlan,
  resolvePlanOptionLabel,
  parsePlanOptions,
  slugify,
  type PlanDocument,
} from '../plan/plan-store.js'
import { approvePlanWithGuards, type PlanApprovalResult } from '../plan/plan-approval.js'
import { SteerBuffer } from '../tui/steer-buffer.js'
import { TEAM_PANEL_UI_PREFIX } from '../tui/team-panel-model.js'
import { COUNCIL_PANEL_UI_PREFIX } from '../tui/council-panel-model.js'
import { containsRegisteredFrame } from '../tui/frame-codec.js'
import { buildHandoffPrompt } from '../tui/handoff.js'
import { handoffRecoveries } from '../agent/recovery-journal.js'
import { getSessionDir } from '../agent/session-persist.js'
import { WatchdogRecoveryPolicy } from '../agent/watchdog-recovery-policy.js'
import { buildDomainPickerEntries, type DomainPickerEntry } from '../agent/domain-picker-entries.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import type { ActiveStarDomain } from '../agent/star-domain.js'
import type { StarDomainId } from '../agent/star-domain.js'
import { skillRegistry, loadProjectSkills, listInstallableSkills, importSkillsIntoRivet, countInstalledSkills, readSkillContent, writeSkill, uninstallSkill, type InstallableSkill } from '../skills/skill-loader.js'
import { getSkillLoadErrorsForSession } from './skill-load-errors.js'
import type { MissionStore } from './mission-store.js'
import { join, resolve, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync, copyFileSync, statSync, mkdirSync } from 'node:fs'
import { createWorktree, removeWorktree, listWorktrees, hasUnlandedWork, commitAll, revParseHead, squashMergeBranch, pushBranch, type WorktreeEntry } from '../agent/worktree.js'
import { createPr } from './gh-cli.js'
import { getGitGraph, getWorkingTreeFiles, getFileDiff, getFileAtBase, listGitBranches } from '../tools/git.js'
import type { WorkingTreeFile } from '../tools/git.js'
import { SessionJobs, type JobEvent } from '../tools/job-store.js'
import { parseAskUserQuestions } from '../tools/ask-user-question.js'
import { grantApp as grantComputerUseApp } from '../tools/computer-use/app-grants.js'
import { outOfWorkspaceFilePaths } from '../agent/tool-pipeline.js'
import { applySandboxPolicyForApprovalMode } from '../tools/sandbox-profile.js'
import {
  DELEGATE_CAPABILITY_TTL_MS,
  DELEGATE_TIMEOUT_MS,
  isDelegateKind,
  type DelegateKind,
  type DelegateResult as ClientDelegateResult,
  type DelegatePayload,
} from './delegation-protocol.js'
import type {
  ApprovalMode as WireApprovalMode,
  PlanModeState as WirePlanModeState,
  AskModeState as WireAskModeState,
  SessionStatus,
  SessionEvent,
  SessionEventType,
  SessionRecord,
  ResolvedDomainRecord,
  PlanDraft,
} from './protocol.js'
import { redactValue, redactText, truncateUtf16Safe } from './redact.js'

// The session wire contract (event types, records, statuses) lives in
// protocol.ts so the desktop can share it type-only. Re-export so existing
// server-side importers keep working unchanged.
export type {
  SessionStatus,
  SessionEvent,
  SessionEventType,
  SessionRecord,
  ResolvedDomainRecord,
  PlanDraft,
} from './protocol.js'

// Compile-time drift guards: the wire copies of ApprovalMode / PlanModeState in
// protocol.ts must stay identical to the runtime definitions. If either side
// changes, these aliases stop typechecking.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type _ApprovalModeInSync = Assert<Equals<ApprovalMode, WireApprovalMode>>
export type _PlanModeStateInSync = Assert<Equals<PlanModeState, WirePlanModeState>>
export type _AskModeStateInSync = Assert<Equals<AskModeState, WireAskModeState>>

/** Structured approval outcome — routes surface `reason` instead of a blind 409. */
export type PlanApprovalOutcome =
  | { ok: true }
  | {
      ok: false
      code: 'session-missing' | 'session-running' | 'plan-not-found' | 'invalid-content' | 'bad-approach'
      reason: string
    }

/** Structured plan-edit outcome (PUT /plans/:slug). */
export type PlanUpdateOutcome =
  | { ok: true }
  | {
      ok: false
      code: 'session-missing' | 'plan-not-found' | 'not-editable' | 'empty-content'
      reason: string
    }

/** 工具调用参数摘要(worker 转录):优先 toolArgSummary 的领域摘要,
 *  未覆盖的工具回退原始 JSON 截断。展示用途,解析失败不抛。 */
function summarizeToolCallArgs(call: OaiToolCall | undefined): string | undefined {
  if (!call) return undefined
  const raw = call.function.arguments ?? ''
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    const summary = toolArgSummary(call.function.name, parsed)
    if (summary) return summary
  } catch {
    // 非法 JSON——直接落原文截断
  }
  return raw && raw !== '{}' ? raw.slice(0, 200) : undefined
}

/** PlusMenu — a selectable model across all configured providers. */
export interface ModelOption {
  id: string
  alias: string
  provider: string
  /** 展示 label（preset label ?? provider name）——桌面端分组标题源（2026-09-08）。 */
  providerLabel?: string
  contextWindow?: number
  /** 擅长场景 — 预设定义处填充，透传到桌面模型选择器。 */
  description?: string
}

/** PlusMenu — a model option annotated with whether it's the session's current. */
export interface ModelEntry extends ModelOption {
  current: boolean
}

/** PlusMenu — a skill's per-session enablement status. */
export interface SkillStatus {
  name: string
  description: string
  source: string
  enabled: boolean
  /** True when a backing file exists that the editor can open (not built-in/plugin). */
  editable?: boolean
}

/** Minimal agent surface the manager needs — decoupled from AgentLoop for tests. */
/** User-dispatched background worker request (from POST /sessions/:id/delegate). */
export interface DelegateWorkerInput {
  objective: string
  /** Worker role profile (code_scout / reviewer / patcher …). Defaults applied downstream. */
  profile?: string
  /** Optional star-domain authority injected into the worker. */
  authority?: string
  /** Optional files to scope the worker to. */
  files?: string[]
  /** Phase 2: resume a previous worker session by workOrderId. */
  resume?: string
}

/** Structured progress/terminal update emitted by a user-dispatched worker. */
export interface DelegateActivityUpdate {
  workOrderId: string
  parentToolId?: string
  /** Runtime execution identity; absent on legacy background updates. */
  dispatchId?: string
  attemptId?: string
  parentAttemptId?: string
  profile?: string
  authority?: string
  /** Why this authority was chosen（worker 命中理由，桌面镜像用）。 */
  authorityReason?: string
  objective?: string
  status: string
  progressLine?: string
  /** 该 worker 累计工具调用次数（运行中实时递增）。 */
  toolUseCount?: number
  /** 该 worker 累计 token 总数（turn 事件携带的累计快照）。 */
  tokenCount?: number
  /** 原始活动事件种类（桌面端 worker 活动镜像用；terminal 事件缺省）。 */
  eventKind?: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'turn' | 'retry' | 'lifecycle'
  /** 原始事件内容：text/thinking 为 delta，tool_use/tool_result 为工具名。 */
  eventDetail?: string
  /** Terminal failure classification (blocked/failed 终态事件携带)。 */
  failureReason?: string
  model?: string
  provider?: string
  usage?: DelegationActivity['usage']
  artifactId?: string
  changedFiles?: string[]
  /** Terminal digest text for the desktop "汇入主会话" adopt button. */
  summary?: string
  /** 用户契约投影（首条 running 事件携带）。 */
  contract?: DelegationActivity['contract']
  /** 终态 findings 计数（完整数组走 getWorkerLog pull）。 */
  findingsCount?: number
  /** 终态第一条 finding claim。 */
  topFinding?: string
  /** 终态 verification 摘要。 */
  verificationBrief?: DelegationActivity['verificationBrief']
  /** 终态 evidenceStatus。 */
  evidenceStatus?: string
}

export interface ManagedAgent {
  /**
   * 包装 `AgentLoop.run`。返回值透传其 outcome——`skipped-already-running`
   * 表示 re-entry guard 命中、本次没起任何轮次；sidecar 自身不消费它，但不能把
   * 它在类型上抹成 void，否则调用方失去「这次到底跑没跑」的判据。
   * 错误预检等本地短路路径仍返回 void。
   */
  run(prompt: string, callbacks: AgentCallbacks, images?: string[]): Promise<void | import('../agent/loop.js').AgentRunOutcome>
  abort(): void
  listArtifacts(): Artifact[]
  readArtifact(id: string): Promise<string | null>
  /**
   * S — live-switch the autonomy level. Mutates the agent's approval mode in
   * place (read per-tool by the pipeline), so a mid-session toggle takes effect
   * on the next tool without rebuilding the agent / losing conversation state.
   * Optional so lightweight test doubles need not implement it.
   */
  setApprovalMode?(mode: ApprovalMode): void
  /**
   * Plan mode — restrict the agent to read-only tools (planning) or release it
   * (off). Mirrors AgentLoop.enterPlanMode/exitPlanMode. Optional so lightweight
   * test doubles need not implement it.
   */
  enterPlanMode?(opts?: { planFilePath?: string }): void
  exitPlanMode?(): void
  /**
   * Ask mode — restrict the agent to pure read-only Q&A tools (asking) or
   * release it (off). Mutually exclusive with Plan Mode. Optional so lightweight
   * test doubles need not implement it.
   */
  enterAskMode?(): void
  exitAskMode?(): void
  /** 识图桥真实状态（active/source/detail）。UI 据此显示准确提示，而非只看
   *  config 有没有 visionModel 键。Optional 以便轻量测试替身无需实现。 */
  getVisionBridge?(): { active: boolean; source: 'configured' | 'auto' | 'none'; detail?: string } | undefined
  /**
   * Plan mode change notification — assigned by the session layer so agent-side
   * transitions (e.g. the model calling plan action=enter_mode) surface as
   * plan_mode SSE events. Mirrors AgentLoop.onPlanModeChange. Optional so
   * lightweight test doubles need not implement it.
   */
  onPlanModeChange?: (state: PlanModeState) => void
  /**
   * Ask mode change notification — assigned by the session layer so agent-side
   * transitions surface as ask_mode SSE events.
   */
  onAskModeChange?: (state: AskModeState) => void
  /**
   * Relative path of the working draft the agent writes while in plan mode
   * (null when not planning). Mirrors AgentLoop.getActivePlanFilePath.
   * Optional so lightweight test doubles need not implement it.
   */
  getActivePlanFilePath?(): string | null
  /**
   * Set (or clear) the approved-plan pointer. Injects a tiny slug/title/path
   * reminder into the agent's dynamic appendix (NOT the plan body, which stays
   * on disk). Mirrors AgentLoop.setActivePlan. Optional for lightweight doubles.
   */
  setActivePlan?(plan: { slug: string; title: string; selectedApproach?: string } | null): void
  /** Inject the session-owned background job registry so bash(run_in_background)
   *  and the `job` tool operate on an instance the server subscribes to. Optional
   *  so lightweight test doubles need not implement it. */
  setJobs?(jobs: import('../tools/job-store.js').SessionJobs): void
  /**
   * Mount an EXTENDED-layer tool onto the main agent (mirrors AgentLoop.enableTool).
   * Used by workflow slash-command resolution to ensure prompt-declared tools are
   * visible before run. Optional so lightweight test doubles need not implement it.
   */
  enableTool?(name: string): {
    status: 'mounted' | 'already-active' | 'not-extended' | 'unknown' | 'gating-off'
    cacheImpact: 'prefix-invalidated' | 'none'
  }
  /**
   * Hot-register tools discovered after this agent was built (MCP connect mid-
   * session). Mirrors LSP attachLspTools: registry.register is Map.set-idempotent;
   * callers should then rely on updateTools() inside the impl. Optional so
   * lightweight test doubles need not implement it.
   */
  registerExternalTools?(tools: Tool[]): void
  /** Current reasoning effort level (off/low/medium/high/max). */
  getReasoningEffort?(): string | undefined
  /** Set the reasoning effort level (off/low/medium/high/max) or return to auto. */
  setReasoningEffort?(effort: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto'): void
  /**
   * Goal mode — attach/clear an autonomous-goal tracker. The tracker drives
   * cross-turn continuation via GoalContinuationController (assembled in
   * loop-factory). Mirrors AgentLoop.setGoalTracker. Optional for lightweight
   * doubles. Note: the caller MUST also update refs.goalTrackerRef.current so
   * the update_goal / deliver_task tool closures (which read refs, not the
   * agent field) stay in sync — see RuntimeSessionManagerOptions.resolveGoalHandles.
   */
  setGoalTracker?(tracker: import('../agent/goal-tracker.js').GoalTracker | null): void
  /** Current goal tracker (null when no goal is active). Mirrors AgentLoop.getGoalTracker. */
  getGoalTracker?(): import('../agent/goal-tracker.js').GoalTracker | null
  /**
   * Cockpit snapshot — aggregated runtime state (safety/verify/context/model/
   * advisory) for the desktop cockpit panel. Built by the pure function
   * buildCockpitSnapshot (tui/cockpit/state.ts) reading agent in-memory state.
   * Returns null when the agent isn't built yet (idle/rehydrated session) or
   * the snapshot assembly throws (transient agent rebuild window).
   */
  getCockpitSnapshot?(): import('../tui/cockpit/types.js').CockpitSnapshot | null
  /** Rewind: return the current message list (for listing rewind points). */
  getMessages(): OaiMessage[]
  /**
   * Outcome of the boot-time LLM history restore (sidecar restart recovery).
   * Lets the session layer warn when the event log shows a prior conversation
   * but the model context came back empty (corrupt/unreadable session file) —
   * otherwise the user silently talks to a model that remembers nothing.
   * Optional so lightweight test doubles need not implement it.
   */
  getHistoryRestore?(): { restored: number; error?: string }
  /** Rewind: replace the message list (truncate to a prior point). */
  replaceMessages(msgs: OaiMessage[]): void
  /** Rewind: like replaceMessages but also resets turnCount/filesRead/filesModified etc. */
  rewindToMessages(msgs: OaiMessage[]): void
  /** Precise rewind: the session's per-edit FileHistory (write_file/edit_file
   *  backups keyed by tool_use id). Absent on lightweight doubles / when no
   *  history is wired. */
  getFileHistory?(): import('../agent/file-history.js').FileHistory | undefined
  /**
   * Reset the prompt engine's delta appendix baseline after any history rewrite
   * (compaction, rewind, /compact). Optional so lightweight test doubles need
   * not implement it; production agents (AgentLoop) delegate to promptEngine.
   */
  resetAppendixBaseline?(): void
  /**
   * PlusMenu (domain) — pin a star domain (or null to disable). Mirrors
   * AgentLoop.setSessionDomain. Optional for lightweight test doubles.
   */
  setSessionDomain?(domain: ActiveStarDomain | null): void
  /** PlusMenu (domain) — reset to Auto (next run auto-detects from input). */
  resetSessionDomain?(): void
  /** Restore a persisted Auto resolution while retaining drift observation. */
  restoreAutoResolvedDomain?(domain: ActiveStarDomain): void
  /** PlusMenu (domain) — read the current selection (Auto when undefined). */
  getSessionDomain?(): ActiveStarDomain | null | undefined
  /**
   * PlusMenu (model) — rebuild this session's agent on a new model, preserving
   * the conversation (same SessionContext) and shared stores. Returns the
   * resolved model id, or null when the model id is unknown / unauthorized.
   * Optional for lightweight test doubles.
   */
  switchModel?(modelId: string): string | null
  /**
   * PlusMenu (skills) — set the per-session disabled skill set. Filters the
   * discovery block so disabled skills are hidden from the model. Optional for
   * lightweight test doubles.
   */
  setDisabledSkills?(names: Set<string>): void
  /** Estimated token count for the current conversation (including prefix overhead). */
  getEstimatedTokens?(): number
  /** Model context window size (max tokens). */
  getContextWindow?(): number
  /**
   * P0-2: 返回本会话 TodoStore 的当前清单。plan_task 成功后发 todo_state SSE 用。
   * 多会话隔离——每个 session 独立的 TodoStore。Optional 以兼容 lightweight test doubles。
   */
  getTodos?(): Array<{ id: string; content: string; status: string }>
  /**
   * Wave L: 进程退出时释放 session 级资源（典型场景：sidecar runServe.close
   * → shutdownAll）。具体实现负责调 coordinator.shutdown 等清 timer/in-flight
   * worker。与 abort() 严格分离——abort 中止当前 turn 但保留 agent 可继续运行，
   * shutdown 是终结性操作。Optional 以兼容 lightweight test doubles。
   */
  shutdown?(): void | boolean | Promise<void | boolean>
  /**
   * I1: 直接召集议事会评审一个 artifact 中的 council-plan-json 草案。
   * 由桌面 CouncilSurface 调用；实际实现持有 coordinator 与 artifactStore。
   * Optional 以兼容 lightweight test doubles。
   */
  conveneCouncil?(input: {
    artifactId: string
    objective?: string
    seats?: { authority: string; charter?: string }[]
    rounds?: number
  }): Promise<{ planMarkdown: string; artifactId: string }>
  /**
   * User-dispatched background subagent. Runs a worker in its own isolated
   * sub-session via the coordinator with an INDEPENDENT abort signal (so the
   * main turn's abort / model switch does not kill it), streaming progress via
   * the supplied onActivity callback. Does NOT touch the main SessionContext /
   * prefix cache. Optional so lightweight test doubles need not implement it.
   */
  delegateWorker?(
    input: DelegateWorkerInput,
    opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
  ): Promise<void>
}

/**
 * Builds the agent for a session. Receives the manager's own session id so the
 * agent's stores (artifacts/session-persist) align with the session — enabling
 * future artifact recovery across restarts. The optional approvalMode overrides
 * the global config autonomy level for this session (S).
 */
export type AgentFactory = (
  cwd?: string,
  sessionId?: string,
  approvalMode?: ApprovalMode,
  /**
   * Preferred model for the initial build (prefix-cache affinity). A session
   * rebuilt after rehydrate must come back on the model its history was
   * accumulated on — building on the default model and cross-switching later
   * rebuilds the entire prefix cache. Factories may ignore it (test doubles)
   * or fall back to the default when the id no longer resolves.
   */
  modelId?: string,
  /**
   * Per-session 工具白名单（蒸馏回放等自动化场景）。有值时 LLM 的工具列表
   * 收窄到这个集合（经 gateToolDefinitions coreOverride 通路）。缺省 =
   * 默认全量（行为不变）。工厂实现可忽略（test doubles）。
   */
  allowedTools?: string[],
) => ManagedAgent | Promise<ManagedAgent>

/**
 * Per-session goal handles, resolved lazily by serve-agent's SessionStores.
 * The manager needs both the RuntimeRefs.goalTrackerRef (read by tool closures)
 * and the sessionDir (for save/restore/delete of goal state) to wire goal mode.
 */
export interface GoalHandles {
  /** The RuntimeRefs.goalTrackerRef — same object the update_goal and
   *  deliver_task tool closures close over. Mutating .current here keeps the
   *  tools in sync with the agent's own tracker field. */
  goalTrackerRef: { current: import('../agent/goal-tracker.js').GoalTracker | null }
  /** Directory where goal state is persisted (<sessionDir>/<sessionId>.goal.json). */
  sessionDir: string
  /** Configured cheap-worker profile for success-criteria extraction, if any. */
  cheapProfile?: { provider: string; model: string }
  /** All provider configs (for buildCheapClient). undefined when not resolvable. */
  allProviders?: Record<string, unknown>
}

/** Read-only view of a goal tracker's state. Returned by goal endpoints / SSE. */
export interface GoalSnapshot {
  goalId: string
  goal: string
  status: 'active' | 'paused' | 'blocked' | 'complete'
  iteration: number
  maxIterations: number
  wallClockElapsedMs: number
  wallClockBudgetMs?: number
  terminalReason?: string
  successCriteria: string[]
  /** Last completion-judge verdict (null until the first judge run). Shape
   *  mirrors StoredGoalJudgeVerdict from goal-tracker (kept as a structural
   *  type here to avoid a static import — the field is pass-through only). */
  lastVerdict?: {
    overall: 'verified' | 'rejected' | 'inconclusive'
    criteriaMet: number
    criteriaUnmet: number
    criteriaTotal: number
    summary: string
  }
}

export interface CreateSessionInput {
  cwd?: string
  title?: string
  prompt?: string
  /** 新建即携带的图片附件（dataUrl 数组）——首轮 run 经 run(id, prompt, images)
   *  进 persistImages + agent.run，与会话内 /prompt 粘图同管线。 */
  images?: string[]
  /** P1 — 显式指定关联的 Mission id。不传则按 title 自动 getOrCreate。 */
  missionId?: string
  approvalMode?: ApprovalMode
  /** Override the model for this session (takes priority over project/global defaults). */
  model?: string
  /** Override the star domain for this session (takes priority over project/global defaults). */
  domain?: string
  /** Welcome-composer reasoning effort — applied to the agent on first build. */
  reasoningEffort?: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto'
  /** Welcome-composer plan mode — mirrors POST /sessions/:id/plan-mode for first-run sessions. */
  planMode?: PlanModeState
  /** Welcome-composer ask mode — mirrors POST /sessions/:id/ask-mode for first-run sessions. */
  askMode?: AskModeState
  /** Create an isolated git worktree for this session (parallel work without conflict). */
  isolatedWorktree?: boolean
  /**
   * 无人值守运行（付费版 v1 · T2，auto-proceed 定时任务）：审批请求不挂起等人，
   * 立即拒绝并 fail-closed 中止本次运行（中止原因入事件流 + 走查工件）。
   */
  unattended?: boolean
  /**
   * Per-session 工具白名单（蒸馏回放等自动化场景）。有值时 LLM 的工具列表
   * 收窄到这个集合。缺省 / undefined = 默认全量（行为不变）。
   */
  allowedTools?: string[]
  /**
   * P1b（安全）：客户端是否具备计划倒计时自动批准 UI。
   * 仅 desktop/TUI 设置 true；vscode-extension 不设置（默认 false）→ sidecar
   * 不武装 goal 模式倒计时定时器（fail-closed：无可见性即不自动批准）。
   */
  planAutoApproveUi?: boolean
}

/** Persisted snapshot of a session: a record + its full event log. */
export interface PersistedSession {
  record: SessionRecord
  events: SessionEvent[]
}

/** One archived session's on-disk footprint, for the storage cleanup UI. */
export interface SessionStorageEntry {
  id: string
  title?: string
  status: SessionStatus
  updatedAt: number
  bytes: number
}

/** Aggregate disk-usage report for the desktop session store. */
export interface StorageReport {
  totalBytes: number
  sessionCount: number
  archivedCount: number
  /** Bytes reclaimable by purging all archived sessions. */
  archivedBytes: number
  /** Archived sessions, oldest first (the natural cleanup order). */
  archived: SessionStorageEntry[]
}

/**
 * 尾部读的回传形状：`events` 已按内存环容量截断，其余字段承载被截头部里
 * 仍然需要的信息，让调用方不必为了它们索取全量。
 */
export interface EventsTail {
  /** 尾部 maxEvents 条（日志更短时即全部）。 */
  events: SessionEvent[]
  /** 磁盘日志最早 seq（空日志为 0）。 */
  diskFirstSeq: number
  /** 磁盘日志最大 seq（空日志为 0）。 */
  lastSeq: number
  /** 全量日志出现过的 artifact id——去重集不完整会让旧 artifact 被重新公告。 */
  artifactIds: string[]
  /** 全量事件数（用于区分空日志与「有日志但全是坏行」）。 */
  total: number
}

/**
 * Durable backing store for sessions (N1). Records are snapshotted; events are
 * append-only. Implementations must tolerate a corrupt trailing event line
 * (partial write) on load — never throw, just drop it.
 */
export interface SessionPersistenceAdapter {
  saveRecord(record: SessionRecord): void
  appendEvent(sessionId: string, event: SessionEvent): void
  /** Flush buffered writes to disk (batched adapters). Optional — no-op if absent. */
  flushSync?(): void
  loadAll(): PersistedSession[]
  /**
   * Lazy-boot support (optional). `loadRecords` reads ONLY the lightweight
   * index.json snapshot per session — never the (potentially huge) event log —
   * so rehydrate is O(sessions) instead of O(total events ever). `loadEvents`
   * reads a single session's full log on demand (first open). Adapters that omit
   * both fall back to the eager `loadAll()` path (fine for tiny in-memory test
   * stores). The file-backed store implements both.
   */
  loadRecords?(): SessionRecord[]
  loadEvents?(sessionId: string): SessionEvent[]
  /**
   * Return the maximum valid sequence already durable for one session. This
   * is the allocation high-water mark; `SessionRecord.lastSeq` is only a
   * snapshot and may lag the append-only event log after an abrupt exit.
   */
  loadEventHighWater?(sessionId: string): number
  /**
   * Async event-log read for the reconnect-replay path (optional). Adapters
   * that implement it should do a non-blocking file read and keep JSON parsing
   * off the main thread (worker / chunked) — a large log parsed inline starves
   * SSE keepalives and turns one reconnect into a storm. Falls back to
   * `loadEvents` when absent.
   */
  loadEventsAsync?(sessionId: string): Promise<SessionEvent[]>
  /**
   * 首开会话的尾部读（optional）。语义同 loadEventsAsync，但只回传内存环留得下
   * 的 maxEvents 条——parse 在 worker 里不占主线程，跨线程搬运却与条数成正比，
   * 而调用方拿到全量后本来就要丢掉环外的部分。缺失时退回 loadEventsAsync。
   *
   * 被截头部里仍需带出的两样：`diskFirstSeq`（前端判断有无更早历史）与
   * `artifactIds`（全量去重集，缺了会让旧 artifact 重放时被重新公告）。
   */
  loadEventsTailAsync?(sessionId: string, maxEvents: number): Promise<EventsTail>
  /**
   * 稀疏索引区间读（optional，冷通道分页加速）：返回 seq < before 的尾部
   * 窗口（至少 minCount 条，或到日志开头）。实现方只读覆盖窗口的字节区间，
   * 大日志分页不整本进内存；缺失时 getHistoryPage 退化为 loadEventsAsync
   * 全量读。`atLogStart` = 窗口起点即日志开头；`firstSeq` = 磁盘最早 seq。
   */
  loadEventsBefore?(sessionId: string, before: number, minCount: number): Promise<{
    events: SessionEvent[]
    atLogStart: boolean
    firstSeq: number
  }>
  /**
   * Storage-management support (optional). `sizeReport`/`sizeOf` report on-disk
   * byte usage via stat() only (never reading contents); `deleteSession`
   * irreversibly removes a session's files. Used by the manual cleanup UI.
   */
  sizeReport?(): Map<string, number>
  sizeOf?(sessionId: string): number
  deleteSession?(sessionId: string): void
  /**
   * Persist a user-attached image as a standalone file so the event log only
   * carries a small reference id (not the base64). Optional — adapters that
   * predate vision attachments may omit it. `base64` is the raw payload (no
   * data: prefix). Returns nothing; the caller already owns `imgId`.
   */
  saveImage?(sessionId: string, imgId: string, base64: string, mime: string): void
  /** Read back a persisted image by id. Returns undefined if missing. */
  readImage?(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined
}

export interface RuntimeSessionManagerOptions {
  createAgent: AgentFactory
  defaultCwd?: string
  now?: () => number
  idGenerator?: () => string
  /** Cap on retained events per session (ring buffer). Default 5000. */
  maxEvents?: number
  /**
   * Cap on how many sessions keep their event log resident at once. Lazy-loaded
   * sessions beyond this (LRU, and only ones with no live agent / not running /
   * unwatched) have their logs dropped back to disk, bounding memory regardless
   * of how much history accumulates. Default 16.
   */
  maxLoadedSessions?: number
  /** Auto-resolve a pending intervention after this many ms. 0 = never. Default 0. */
  approvalTimeoutMs?: number
  /** C2 刹车 — watchdog 停滞续跑前的可取消倒计时窗口（ms）。Default 5000. */
  watchdogContinueDelayMs?: number
  /** Goal 模式计划提交后的倒计时自动批准窗口（ms）——仅 goal 激活时武装，
   *  窗口内用户任何参与即取消。0 = 关闭（纯手动审批）。Default 150000（2.5min，
   *  serve.ts 以 RIVET_GOAL_PLAN_AUTO_APPROVE_MS 覆盖）。 */
  goalPlanAutoApproveMs?: number
  /** sidecar 启动时的全局审批档（ctx.config.agent.approval）。PUT
   *  /config/approval 的广播回调经 applyGlobalApprovalMode 实时更新；会话级
   *  override（session.approvalMode）恒优先。供 skip 感知门（如计划提交
   *  自动批准）解析会话生效档位。 */
  globalApprovalMode?: ApprovalMode
  /** Optional durable store. When set, sessions survive sidecar restarts. */
  persistence?: SessionPersistenceAdapter
  /**
   * R1 — late-bound accessor for the shared cross-session registry. A getter
   * (not a value) because the registry's SQLite backend resolves async after the
   * server starts. Returns undefined when concurrency features are disabled.
   */
  getSessionRegistry?: () => SessionRegistry | undefined
  /**
   * Goal mode — late-bound accessor for the per-session goal handles (the
   * RuntimeRefs.goalTrackerRef that update_goal / deliver_task tool closures
   * read, plus the session dir for goal state persistence). A getter (not a
   * value) because the handles live in serve-agent's SessionStores, which are
   * built lazily per session and invisible to this generic manager. Returns
   * undefined for sessions without a sidecar-backed store (test doubles). When
   * absent, the goal methods on this manager degrade to "feature unavailable".
   */
  resolveGoalHandles?: (sessionId: string) => GoalHandles | undefined
  /** PlusMenu (review) — 会话级审查门 refs 迟绑定访问（与 resolveGoalHandles 同
   *  模式：refs 活在 serve-agent 的 SessionStores 里，通用 manager 不可见）。
   *  无 agent 构建时返回 undefined——override 仍会在 applySelections 时重放。 */
  resolveReviewGateRef?: (sessionId: string) => { current: 'auto' | 'off' } | undefined
  /** PlusMenu (review) — 配置默认档（review.skipAuto 派生），session 无 override
   *  且 refs 未建时的 GET 兜底。 */
  defaultReviewGate?: 'auto' | 'off'
  /**
   * PlusMenu (model) — enumerate selectable models across all configured
   * providers. Injected by serve.ts (which owns the provider config). Absent in
   * tests → the model picker returns an empty list.
   */
  listModels?: () => ModelOption[]
  /**
   * PlusMenu (model) — the default model id new sessions start on. Used for the
   * initial record.model and the picker's `current` flag.
   */
  defaultModelId?: string
  /** PlusMenu (domain) — the default domain key new sessions start on. */
  defaultDomain?: string
  /**
   * Fallback model for one-click resume when the session's original model is
   * no longer available (user-configured, off by default). Resume is strictly
   * model-affine — without this option an unavailable original model makes
   * resume fail closed (open-a-new-session guidance) instead of silently
   * running the history on the default model and rebuilding the prefix cache.
   */
  resumeFallbackModel?: string
  /**
   * Phase 3 #9 — release a built agent after this long of session inactivity
   * (0 disables). The agent is the heavy half of a session (AgentLoop, tool
   * registry, prompt engine, coordinator); once released the session also
   * becomes eligible for the event-log LRU. The next prompt rebuilds the agent
   * with history restored from disk — same recovery path as a sidecar restart.
   * Default 30 minutes.
   */
  idleAgentTtlMs?: number
  /**
   * P1 任务身份化 — Mission 存储。注入（而非默认实例化）是有意的：
   * 未接线时 Mission 关联整体跳过，现有测试带 title 建会话不会写真实
   * `~/.rivet/missions/`。serve.ts 构造真实实例并同时接给 mission routes。
   */
  missionStore?: MissionStore
  /** Injectable timer surface for deterministic tool-result coalescing tests. */
  toolResultScheduler?: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  /** Injectable plan timer surface for deterministic lifecycle tests. */
  planEventScheduler?: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  /** Injectable async plan listing for deterministic lifecycle tests. */
  listPlans?: typeof storeListPlans
}

type InterventionKind = 'approval'

interface PendingIntervention {
  requestId: string
  kind: InterventionKind
  resolve: (value: ApprovalResult | boolean) => void
  timer?: ReturnType<typeof setTimeout>
  /** Tool identity of the gated call — lets answerIntervention apply
   *  tool-specific "remember" semantics (e.g. computer_use per-app grants). */
  toolName?: string
  /** Original (unredacted) tool input for remember handling. */
  toolInput?: Record<string, unknown>
}

/** E4 — pending client tool-landing delegation (mirrors PendingIntervention). */
interface PendingDelegation {
  requestId: string
  kind: DelegateKind
  resolve: (value: ClientDelegateResult | null) => void
  timer?: ReturnType<typeof setTimeout>
}

interface DelegateCapabilitySlot {
  clientId: string
  kinds: Set<DelegateKind>
  expiresAt: number
}

interface ActiveRunSettlement {
  settled: boolean
  claimsReleased: boolean
  promise: Promise<void>
  resolve: () => void
  /** Abort reconciliation state; kept on the exact run token for idempotence. */
  staleSweep?: {
    expectedGeneration: number
    attempts: number
    scheduled: boolean
    finishedGeneration?: number
  }
}

/** Phase 2 — queue lane 条目状态：queued → steered / retracted / merged。 */
export type QueueLaneStatus = 'queued' | 'steered' | 'retracted' | 'merged'

/**
 * Phase 2 — queue lane 条目：busy 期间经 POST /sessions/:id/queue 排队的跟进
 * 消息。FIFO、无意图分类。终态三选一：下次 prompt 归并（merged）、被
 * steer { laneId } 升级进 steer buffer 立即注入（steered）、被撤回（retracted）。
 */
export interface QueueLaneEntry {
  id: string
  text: string
  status: QueueLaneStatus
  ts: number
}

// Coordinator abort salvage currently waits up to five seconds. Reconcile with
// a small margin, but never keep the process alive or emit a guessed result.
const ABORT_RECONCILE_RETRY_DELAY_MS = 50
const ABORT_RECONCILE_MAX_RETRIES = 120

interface InternalSession {
  record: SessionRecord
  /** Lazily built on first run; null for rehydrated/idle sessions. */
  agent: ManagedAgent | null
  /** S — per-session autonomy override threaded into the agent on build. */
  approvalMode?: ApprovalMode
  /** Per-session reasoning effort override. Applied to the agent on build and live-mutated mid-session. */
  reasoningEffort?: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto'
  events: SessionEvent[]
  /**
   * Whether `events` holds the full on-disk log. False for a rehydrated session
   * whose log hasn't been read yet (lazy boot) or one whose log was evicted to
   * bound memory — ensureEvents() (re)loads from disk on first access.
   */
  eventsLoaded: boolean
  /** In-flight async log load — concurrent async opens share it (no double read). */
  eventsLoadPromise?: Promise<void>
  /**
   * 磁盘日志最早 seq（冷热双通道）：内存环截尾后 events[0].seq 会漂移，
   * 但磁盘头部仍在——replay_window 元事件靠它告诉前端"还有更早的历史"。
   * 新建会话恒为 1；rehydrate/懒加载在 adoptLoadedEvents 里从全量读回填。
   */
  diskFirstSeq?: number
  seq: number
  running: boolean
  activeRunSettlement?: ActiveRunSettlement
  /** Increments when durability ownership is permanently revoked. */
  lifecycleGeneration: number
  /** Permanent-delete tombstone retained by queued callback closures. */
  tombstoned?: boolean
  pending: Map<string, PendingIntervention>
  /** E4 — in-flight client landing delegations (keyed by requestId). */
  pendingDelegations: Map<string, PendingDelegation>
  /** E4 — latest registered client capabilities (later registrant wins). */
  delegateCapabilities?: DelegateCapabilitySlot
  listeners: Set<(e: SessionEvent) => void>
  knownArtifacts: Set<string>
  /** T3 — mid-run user guidance, drained into the agent at the next tool boundary. */
  steer: SteerBuffer
  /** Phase 2 — queue lane：busy 期间排队的跟进消息（下次 prompt 归并 / steer 升级 / 撤回）。 */
  queueLane: QueueLaneEntry[]
  /**
   * /handoff 登记的归档任务（桌面端 POST /sessions/:id/handoff）：交接 run 收尾时
   * 把项目内 .rivet/HANDOFF.md 拷贝归档到会话目录 <id>.handoff.md——
   * loadPrevHandoff 注入管线认的位置（与 TUI pendingHandoffCopy 同语义）。
   */
  pendingHandoff?: { src: string; dest: string; sinceMs: number }
  /**
   * Background job registry (bash run_in_background + `job` tool). Server-owned so
   * it survives agent rebuilds (switchModel) and its lifecycle events can be
   * forwarded to SSE. Lazily created on first ensureAgent, injected into the agent
   * via setJobs, terminated on session close. */
  jobs?: import('../tools/job-store.js').SessionJobs
  /**
   * Lazily built read-only view over the on-disk artifact log for sessions
   * without a live agent (rehydrated/idle). Lets the desktop still read artifact
   * bodies after a sidecar restart, since the agent's ArtifactStore persists
   * both the index and raw files keyed by sessionId.
   */
  rehydratedArtifacts?: ArtifactStore
  /**
   * PlusMenu (domain) — live star-domain selection. Tri-state mirrors
   * AgentLoop.getSessionDomain: undefined=Auto, null=no-persona (env kill switch
   * only), object=pinned. Applied
   * to the agent on ensureAgent (so lazy build is consistent) and after a model
   * rebuild (so the selection survives switchModel).
   */
  domainState: ActiveStarDomain | null | undefined
  /** PlusMenu (skills) — per-session disabled skill names (in-memory). */
  disabledSkills: Set<string>
  /** PlusMenu (review) — 会话级审查门覆盖。undefined = 跟随配置默认
   *  （refs.reviewGateRef 由 review.skipAuto 初始化）；用户经
   *  POST /sessions/:id/review-gate 设置后成为权威值，agent 重建时
   *  由 applySelections 重放到新 refs。 */
  reviewGateOverride?: 'auto' | 'off'
  /**
   * Skills that failed to load from .rivet/skills at session create (e.g. a
   * malformed Claude SKILL.md with no/broken frontmatter). Surfaced to the UI so
   * an installed-but-unparseable skill is visible instead of silently dropped.
   */
  skillLoadErrors: string[]
  /**
   * User-dispatched background worker abort controllers, keyed by workerId.
   * Independent from the main turn's signal so a user-launched subagent is NOT
   * killed by aborting the main conversation. Lazily created on first dispatch.
   */
  backgroundAborts?: Map<string, AbortController>
  /**
   * First-seen timestamps per workOrderId, for delegation elapsed reporting.
   * Shared by the run-time callback path and the idle user-dispatch path so both
   * report consistent elapsed. Lazily created.
   */
  delegationStartedAt?: Map<string, number>
  /** Watchdog stall 恢复状态机（与 TUI 共享实现），随 session 生命周期。 */
  watchdogPolicy?: WatchdogRecoveryPolicy
  /** 最近一次 onAbort 携带的 reason（watchdog 家族判定用）。每次 run 起跑清空。 */
  lastAbortReason?: string
  /** onAbort 时刻是否有审批挂起——必须在此捕获，run().finally 的 rejectAllPending 会清掉 pending map。 */
  abortWhileApprovalPending?: boolean
  /** 最近一次审批被拒的时刻（this.now() 读数），驱动 grace 窗口抑制。 */
  lastApprovalDeniedAt?: number
  /** 标记下一次 run 是 watchdog 自动续跑（跳过 recordUserSubmit，与 TUI 的
   *  onSubmitCallback 直呼路径对齐——自动续跑不得重置 consecutive）。 */
  watchdogAutoResubmit?: boolean
  /** 用户在 watchdog stall→setImmediate 续跑窗口内 abort → 置 true 抑制续跑。
   *  abort() 对已停会话是空操作（status 已 aborted），不加此标记则窄窗口内
   *  自动续跑会盖掉用户刚表达的「停」。run() 起跑时清。 */
  watchdogRecoveryCancelled?: boolean
  /** C2 刹车 — watchdog 续跑倒计时定时器。窗口内用户 abort / 新 prompt 取消。 */
  watchdogContinueTimer?: NodeJS.Timeout
  /** Goal 计划倒计时自动批准 — 定时器与目标 slug。窗口内用户任何参与
   * （approve/reject/edit/prompt/steer/abort/显式取消）即取消。 */
  planAutoApproveTimer?: NodeJS.Timeout
  planAutoApproveSlug?: string
  /** plan_draft 节流 — 最近一次发射时刻（this.now() 读数）。 */
  planDraftLastEmit?: number
  /** plan_draft 节流 — 尾沿定时器，保证窗口内最后一次写盘总能落一发事件。 */
  planDraftTimer?: unknown
  planDraftTimerGeneration?: number
  /** 无人值守运行：审批请求 fail-closed 中止（付费版 v1 · T2）。 */
  unattended?: boolean
  /** P1b：客户端是否具备 plan 自动批准倒计时 UI。默认 false = fail-closed。 */
  planAutoApproveUi?: boolean
  /** 无人值守中止原因（首个被拦截的审批），随 done/summary 上报。 */
  unattendedHaltReason?: string
  /** 无人值守中止时缺授权的 app 名（结构化，供「补授权→重跑」修复闭环）。 */
  unattendedHaltApp?: string
  /** 流式 delta 合并缓冲（Wave 2）——见 bufferDelta()。 */
  deltaBuf?: { type: 'text_delta' | 'thinking_delta'; text: string }
  /** delta 合并窗口定时器。 */
  deltaTimer?: NodeJS.Timeout
  /** 当前 delta run 是否已发出首个事件（首 token 立即落，后续走窗口）。 */
  deltaRunActive?: boolean
  /** Contiguous streaming tool_result run; terminal results are never buffered. */
  toolResultStream?: { id: string; name: string; buffered: string; active: boolean }
  toolResultTimer?: unknown
  /** Reject streaming callbacks from an archived/deleted agent closure. */
  toolResultClosed?: boolean
}

/** Tools that spawn worker agents — surfaced as delegation-tree nodes (N3). */
const DELEGATION_TOOLS = new Set(['delegate_task', 'delegate_batch', 'team_orchestrate', 'council_convene', 'galaxy'])

/** 审批拒绝后的 watchdog 续跑抑制窗口——与 TuiApp.APPROVAL_STALL_GRACE_MS 对齐：
 *  拒绝后立刻 stall 的自动 continue 只会重发同一个被拒调用（deny→continue→deny 环）。 */
const WATCHDOG_APPROVAL_GRACE_MS = 5_000

/** Cap on concurrent user-dispatched background workers per session (guards the
 *  shared coordinator from being swamped). */
const MAX_USER_BACKGROUND_WORKERS = 4

/** plan_draft 事件节流窗口——agent 增量写草稿可能一轮多次落盘；250ms
 *  兼顾「起草中」亚秒刷新与 burst 合并。事件持久化仅 metadata；SSE live 帧可带正文。 */
const PLAN_DRAFT_THROTTLE_MS = 250

/** plan_draft SSE 携带正文上限——超限只发失效信号，桌面回退 GET /plans。 */
const PLAN_DRAFT_LIVE_CONTENT_MAX = 200_000

/** Delta 合并窗口（Wave 2）——provider 逐 token 回调，每个 token 独立
 *  JSON.stringify + SSE write 太贵。窗口内的连续同类型 delta 合并成一条
 *  规范事件（单 seq，持久化/重放语义不变）。40ms ≈ 前端 10Hz 渲染节流的
 *  1/2.5，肉眼无感。 */
const DELTA_COALESCE_MS = 40

/** 合并缓冲上限——超过即刻 flush，避免慢消费者场景下单事件过大。 */
const DELTA_COALESCE_MAX_CHARS = 2_048
const TOOL_RESULT_COALESCE_MS = 40
const TOOL_RESULT_COALESCE_BYTES = 2_048

function takeUtf8Prefix(text: string, maxBytes: number): { head: string; tail: string } {
  let bytes = 0
  let end = 0
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point)
    if (bytes + pointBytes > maxBytes) break
    bytes += pointBytes
    end += point.length
  }
  return { head: text.slice(0, end), tail: text.slice(end) }
}


/** Result of a user-dispatch request — lets the route map a precise status code. */
export type DelegateResult =
  | { ok: true; workerId: string }
  | { ok: false; reason: 'not_found' | 'invalid' | 'unsupported' | 'limit' }

/** Result of a one-click resume — `switched` means a different model took
 *  over (UI must disclose that the prefix cache will be rebuilt). `degraded`
 *  marks the no-configured-fallback path: the run continues on the default
 *  model with an explicit warning instead of fail-closing the session. */
export type ResumeRunResult =
  | { ok: true; model: string; switched: boolean; degraded?: boolean; warning?: string }
  | { ok: false; code: 'not_found' | 'busy' | 'model_unavailable'; error: string }

/** Injected user prompt for a resumed run — the model context was restored
 *  from disk, so a short continuation instruction rides the existing history
 *  (appended at the tail → prefix-cache friendly). */
export const RESUME_PROMPT =
  '[续跑] 上一轮执行被进程重启打断。请基于已有上下文继续完成中断前的任务；若中断点不明确，先回顾最近的工具输出与待办清单再继续。'

/**
 * Parent-node objective for a delegation tool call. Prefer a top-level
 * objective/prompt; for delegate_batch fall back to summarizing tasks[].
 * Exported for unit tests.
 */
export function extractObjective(input: Record<string, unknown>): string {
  for (const key of ['objective', 'prompt', 'description', 'goal']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 200)
  }
  // delegate_batch: tasks: [{ objective, ... }, ...]
  const tasks = input.tasks
  if (Array.isArray(tasks) && tasks.length > 0) {
    const parts: string[] = []
    for (const t of tasks.slice(0, 3)) {
      if (t && typeof t === 'object' && typeof (t as { objective?: unknown }).objective === 'string') {
        const o = String((t as { objective: string }).objective).trim()
        if (o) parts.push(o.slice(0, 80))
      }
    }
    if (parts.length > 0) {
      const more = tasks.length > parts.length ? ` (+${tasks.length - parts.length} more)` : ''
      return `${parts.join(' · ')}${more}`.slice(0, 200)
    }
  }
  return ''
}

/**
 * N3 组头的 `并行委派 × N` 计数：delegate_batch 从 input.tasks 读批大小，
 * 其余派发工具（单发/议事/团队/星河）不携带——workerIdentity 只在
 * taskCount > 0 时渲染 `× N`。Exported for unit tests.
 */
export function delegationTaskCount(name: string, input: Record<string, unknown>): number | undefined {
  if (name !== 'delegate_batch') return undefined
  const tasks = input.tasks
  return Array.isArray(tasks) && tasks.length > 0 ? tasks.length : undefined
}

/**
 * Scan an event log for approvals that were requested but never resolved —
 * i.e. the run was interrupted (sidecar restart) while blocked on them.
 * Used by rehydrate() to close them out honestly instead of leaving a
 * dangling approval card in the replayed timeline.
 */
function findOrphanedApprovals(events: SessionEvent[]): Array<{ requestId: string; toolName: string }> {
  const open = new Map<string, string>()
  for (const e of events) {
    const id = typeof e.data.requestId === 'string' ? e.data.requestId : ''
    if (!id) continue
    if (e.type === 'approval_required') {
      open.set(id, typeof e.data.toolName === 'string' ? e.data.toolName : '')
    } else if (e.type === 'approval_resolved') {
      open.delete(id)
    }
  }
  return [...open.entries()].map(([requestId, toolName]) => ({ requestId, toolName }))
}

/** T2 — todo item as surfaced to the desktop (subset of the tool's schema). */
interface TodoStateItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * T2 — parse a `todo` write tool input into structured items.
 *
 * We read the per-call input rather than the global TodoStore singleton on
 * purpose: the store is shared across all sidecar sessions, so its snapshot is
 * not session-correct, whereas the tool input belongs to this session's call.
 * Returns null for non-write actions or malformed payloads.
 */
function extractTodoState(input: Record<string, unknown>): TodoStateItem[] | null {
  if (input.action !== 'write') return null
  const raw = input.todos
  if (!Array.isArray(raw)) return null
  const items: TodoStateItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const content = typeof e.content === 'string' ? e.content : ''
    const status = e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending'
    if (!id || !content) continue
    items.push({ id, content, status })
  }
  return items
}

/**
 * 内存环截尾（M1 修复）：保留尾部窗口，但 delegation 事件豁免——stale 对账
 * （sweepStaleDelegationNodes）与回放依赖它们完整；被截尾的早期 running
 * 节点对账不可见，回放会永久卡「运行中」。delegation 事件量级小（每 worker
 * 2-4 条），豁免增长可控。
 */
function trimEventRing(events: SessionEvent[], maxEvents: number): SessionEvent[] {
  if (events.length <= maxEvents) return events
  const overflow = events.length - maxEvents
  const kept: SessionEvent[] = []
  let dropped = 0
  for (const e of events) {
    if (dropped < overflow && e.type !== 'delegation') {
      dropped++
      continue
    }
    kept.push(e)
  }
  return kept
}

export class RuntimeSessionManager {
  private readonly sessions = new Map<string, InternalSession>()
  /** In-flight lazy agent builds (per session id) — ensureAgent is not
   *  concurrency-safe on its own: two callers seeing agent=null would each run
   *  createAgent, and the later-resolving build could overwrite the winner.
   *  Serializes builds; entries removed when the shared promise settles. */
  private readonly agentBuilds = new Map<string, Promise<ManagedAgent>>()
  private readonly createAgent: AgentFactory
  private readonly defaultCwd: string
  private readonly now: () => number
  private readonly idGenerator: () => string
  private readonly maxEvents: number
  private readonly maxLoadedSessions: number
  /** LRU of session ids whose event log is currently resident (oldest first). */
  private readonly loadedOrder: string[] = []
  private readonly approvalTimeoutMs: number
  private readonly watchdogContinueDelayMs: number
  private readonly goalPlanAutoApproveMs: number
  /** 当前全局审批档（构造取快照；applyGlobalApprovalMode 实时更新）。 */
  private globalApprovalMode?: ApprovalMode
  private readonly persistence?: SessionPersistenceAdapter
  private readonly getRegistry?: () => SessionRegistry | undefined
  private readonly listModelsFn?: () => ModelOption[]
  private readonly defaultModelId?: string
  private readonly defaultDomain?: string
  private readonly resumeFallbackModel?: string
  private readonly idleAgentTtlMs: number
  /** Goal mode — late-bound per-session goal handles (refs + sessionDir). */
  private readonly resolveGoalHandles?: (sessionId: string) => GoalHandles | undefined
  /** Registered by serve.ts: drops the per-session stores entry when the
   *  session is permanently released/deleted (memory bound). Late-bound so
   *  this module stays free of the heavy serve-agent import. */
  private storesForgetter: ((sessionId: string) => void) | null = null
  /** PlusMenu (review) — late-bound per-session review-gate ref accessor. */
  private readonly resolveReviewGateRef?: (sessionId: string) => { current: 'auto' | 'off' } | undefined
  /** PlusMenu (review) — config-derived default when no override and no refs. */
  private readonly defaultReviewGate: 'auto' | 'off'
  private readonly toolResultScheduler: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  private readonly planEventScheduler: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  private readonly loadPlans: typeof storeListPlans
  /** P1 任务身份化 — 可选 Mission 存储（未注入时 Mission 关联整体跳过）。 */
  private readonly missionStore?: MissionStore
  private idleSweepTimer?: ReturnType<typeof setInterval>
  /** Per-session coordinator refs for worker steer/kill (set by main.ts after agent build). */
  private readonly coordinatorBySession = new Map<string, () => import('../agent/coordinator.js').DelegationCoordinator | undefined>()

  constructor(opts: RuntimeSessionManagerOptions) {
    this.createAgent = opts.createAgent
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.now = opts.now ?? Date.now
    this.idGenerator = opts.idGenerator ?? (() => randomId())
    // RIVET_MAX_EVENTS：内存环容量旋钮（dev 调试/特殊部署）。环只约束
    // 常驻内存与尾部回放窗口——被截头部经 getHistoryPage 从磁盘分页可达。
    const envMaxEvents = Number(process.env.RIVET_MAX_EVENTS)
    this.maxEvents = opts.maxEvents
      ?? (Number.isFinite(envMaxEvents) && envMaxEvents >= 100 ? Math.floor(envMaxEvents) : 5000)
    this.maxLoadedSessions = opts.maxLoadedSessions ?? 16
    // 审批等待超时：0（默认）= 永不超时——审批卡持久化可回放，无限等优于长
    // 自主任务被误拒；部署侧（无人值守/CI）可用 RIVET_APPROVAL_TIMEOUT_MS
    // 给一个 fail-closed 上限，超时按拒绝收口而不是永久挂起。
    const envApprovalTimeout = Number(process.env.RIVET_APPROVAL_TIMEOUT_MS)
    this.approvalTimeoutMs = opts.approvalTimeoutMs
      ?? (Number.isFinite(envApprovalTimeout) && envApprovalTimeout >= 0 ? envApprovalTimeout : 0)
    this.watchdogContinueDelayMs = opts.watchdogContinueDelayMs ?? 5_000
    this.goalPlanAutoApproveMs = opts.goalPlanAutoApproveMs ?? 150_000
    this.globalApprovalMode = opts.globalApprovalMode
    this.persistence = opts.persistence
    this.getRegistry = opts.getSessionRegistry
    this.listModelsFn = opts.listModels
    this.defaultModelId = opts.defaultModelId
    this.resumeFallbackModel = opts.resumeFallbackModel
    this.idleAgentTtlMs = opts.idleAgentTtlMs ?? 30 * 60_000
    this.resolveGoalHandles = opts.resolveGoalHandles
    this.resolveReviewGateRef = opts.resolveReviewGateRef
    this.defaultReviewGate = opts.defaultReviewGate ?? 'auto'
    this.toolResultScheduler = opts.toolResultScheduler ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.planEventScheduler = opts.planEventScheduler ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.loadPlans = opts.listPlans ?? storeListPlans
    this.missionStore = opts.missionStore
    if (this.idleAgentTtlMs > 0) {
      // Sweep once a minute; unref so the timer never keeps the process alive.
      this.idleSweepTimer = setInterval(() => this.sweepIdleAgents(), 60_000)
      this.idleSweepTimer.unref?.()
    }
    if (this.persistence) this.rehydrate()
  }

  /**
   * Phase 3 #9 — release built agents of long-idle sessions so a day-long
   * sidecar doesn't accumulate one live AgentLoop per conversation ever opened.
   * Conservative gates: never touches a session that is running, holds pending
   * approvals, has user background workers or running jobs. Rebuild on the next
   * prompt goes through ensureAgent → history restore, the same path a sidecar
   * restart uses (prefix cache is content-addressed, so byte-identical history
   * still hits).
   */
  sweepIdleAgents(): void {
    if (this.idleAgentTtlMs <= 0) return
    const now = this.now()
    for (const s of this.sessions.values()) {
      if (!s.agent || s.running) continue
      if (s.pending.size > 0) continue
      if (s.backgroundAborts && s.backgroundAborts.size > 0) continue
      if (s.jobs && s.jobs.list().some((j) => j.status === 'running')) continue
      if (now - s.record.updatedAt < this.idleAgentTtlMs) continue
      this.releaseAgent(s)
    }
    // Agent-free sessions are now eligible for the event-log LRU too.
    this.evictLoadedBeyondCap()
  }

  /** Drop the session's in-memory stores entry (best-effort). */
  setStoresForgetter(fn: (sessionId: string) => void): void {
    this.storesForgetter = fn
  }

  private forgetStores(sessionId: string): void {
    try { this.storesForgetter?.(sessionId) } catch { /* best-effort */ }
  }

  /** Shut down and drop a session's built agent (timers, coordinator, in-flight
   *  worker handles). The lightweight record/events stay; ensureAgent rebuilds
   *  on demand. Caller guarantees the session is not running. */
  private releaseAgent(s: InternalSession): void {
    let shutdownResult: void | boolean | Promise<void | boolean> | undefined
    try { shutdownResult = s.agent?.shutdown?.() } catch { /* best-effort */ }
    s.agent = null
    // A built agent may own claims even when the session has gone idle.  Wait
    // for async coordinator cleanup before releasing them; otherwise a worker
    // that ignored abort could race a new session during idle eviction.
    if (shutdownResult && typeof (shutdownResult as Promise<void>).then === 'function') {
      void Promise.resolve(shutdownResult).then(
        (settled) => { if (settled !== false) this.releaseClaimsIfIdle(s) },
        () => undefined,
      )
    } else if (shutdownResult !== false) {
      this.releaseClaimsIfIdle(s)
    }
    // Stores (goalTrackerRef / reviewGateRef / sessionDir) are rebuilt by the
    // next buildManagedAgent — drop them now so idle-swept sessions don't pin
    // full oaiMessages in memory forever.
    this.forgetStores(s.record.id)
  }

  /** Release claims only after the session has no active run settlement. */
  private releaseClaimsIfIdle(s: InternalSession): void {
    if (s.running || s.activeRunSettlement) return
    try { this.getRegistry?.()?.releaseAllClaims(s.record.id) } catch { /* best-effort */ }
  }

  /**
   * Phase 3 #9 — drop a session's heavy in-memory state entirely (agent, event
   * ring, background jobs). Used by the archive path: an archived session is
   * closed, so its jobs are terminated (mirrors hardDelete) and its log is
   * evicted; everything reloads lazily from disk if the session is reopened.
   */
  private unloadSession(s: InternalSession): void {
    if (s.running) return
    this.releaseAgent(s)
    try { s.jobs?.killAll() } catch { /* best-effort */ }
    s.jobs = undefined
    // Never drop unflushed coalesced deltas — they'd be lost from the replay.
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    s.events = []
    s.knownArtifacts = new Set()
    s.eventsLoaded = false
    const i = this.loadedOrder.indexOf(s.record.id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
  }

  /**
   * Restore sessions from the persistence store on boot. Honest semantics: the
   * old agent run is gone, so any session that was 'running' is restored as
   * 'aborted' (interrupted by restart) and is view-only until a fresh run is
   * started in the same cwd. events.jsonl is the source of truth for seq.
   */
  private rehydrate(): void {
    const p = this.persistence!
    // Lazy boot: read only the lightweight index.json records — NOT the event
    // logs — so a sidecar restart is O(sessions) instead of O(total events ever).
    // With dozens of long sessions the eager path read+parsed tens of MB of
    // events.jsonl synchronously on every launch (slow start + unbounded RAM);
    // here each session starts with an empty log that ensureEvents() fills on
    // first open. Falls back to eager loadAll() for adapters without lazy support.
    if (typeof p.loadRecords === 'function' && typeof p.loadEvents === 'function') {
      let records: SessionRecord[]
      try { records = p.loadRecords() } catch { return }
      for (const rawRecord of records) {
        const rec = sanitizeSessionDomain(rawRecord)
        const wasRunning = rec.status === 'running'
        const session: InternalSession = {
          record: {
            ...rec,
            status: wasRunning ? 'aborted' : rec.status,
            lastSeq: rec.lastSeq,
            pendingApprovals: 0,
          },
          agent: null,
          events: [],
          eventsLoaded: false,
          seq: rec.lastSeq,
          running: false,
          lifecycleGeneration: 0,
          pending: new Map(),
          pendingDelegations: new Map(),
          listeners: new Set(),
          knownArtifacts: new Set(),
          steer: new SteerBuffer(),
          queueLane: [],
          domainState: resolveDomainState(rec.domain ?? 'auto')?.state,
          disabledSkills: new Set(),
          skillLoadErrors: [],
          reasoningEffort: rec.reasoningEffort as import('../agent/auto-reasoning.js').ReasoningEffort | 'auto' | undefined,
          planAutoApproveUi: rec.planAutoApproveUi === true,
          // 档位回读（2026-09-05 跨盘审批链修复）：顶层 approvalMode 是
          // ensureAgent 构建代理时消费的字段——漏掉它，sidecar 重启后所有会话
          // 的 per-session 档位静默丢失，agent 退回启动快照的全局档（默认
          // auto-safe），而 UI 按 record.approvalMode 显示「完全读写」。用户
          // 看到的是「全盘读写不生效 + 跨盘写永远等不到审批」。
          approvalMode: rec.approvalMode,
        }
        this.sessions.set(session.record.id, session)
        if (wasRunning) {
          // If the run died while blocked on approvals, close them out honestly:
          // read this ONE session's log (bounded: only crashed-with-pending
          // sessions pay it — the pendingApprovals>0 gate keeps lazy boot lazy),
          // find approval_required events with no matching approval_resolved,
          // and append 'sidecar-restart' resolutions so the replayed timeline
          // shows WHAT was pending instead of a dangling, unanswerable card.
          let markerEvents: SessionEvent[] | undefined
          let orphans: Array<{ requestId: string; toolName: string }> = []
          if (rec.pendingApprovals > 0) {
            try {
              markerEvents = p.loadEvents!(rec.id)
              orphans = findOrphanedApprovals(markerEvents)
            } catch { /* high-water fallback below remains authoritative */ }
          }
          // `lastSeq` is a record snapshot and can lag events.jsonl while a
          // long delegation is still running. Allocate recovery markers above
          // the durable log high-water, otherwise replay cursors can discard
          // the restart reason as a duplicate or backwards sequence.
          let durableHighWater: number
          try {
            if (markerEvents) {
              durableHighWater = markerEvents.reduce((max, event) => Math.max(max, event.seq), 0)
            } else if (p.loadEventHighWater) {
              durableHighWater = p.loadEventHighWater(rec.id)
            } else {
              markerEvents = p.loadEvents!(rec.id)
              durableHighWater = markerEvents.reduce((max, event) => Math.max(max, event.seq), 0)
            }
          } catch {
            // Do not append sequence-bearing markers from an untrusted stale
            // snapshot. The in-memory session remains aborted; a later open
            // can retry recovery after the storage read becomes available.
            continue
          }
          session.seq = Math.max(session.seq, durableHighWater)
          session.record.lastSeq = session.seq
          // Persist the markers straight to disk WITHOUT keeping the log
          // resident. They re-appear when ensureEvents() reads it on first open.
          const appendMarker = (type: SessionEventType, data: Record<string, unknown>) => {
            const marker: SessionEvent = { seq: ++session.seq, ts: this.now(), type, data }
            session.record.lastSeq = session.seq
            session.record.updatedAt = marker.ts
            try { p.appendEvent(session.record.id, marker) } catch { /* best-effort */ }
          }
          for (const o of orphans) {
            appendMarker('approval_resolved', { requestId: o.requestId, decision: 'sidecar-restart', toolName: o.toolName })
          }
          appendMarker('status', {
            status: 'aborted',
            reason: 'sidecar-restart',
            ...(orphans.length ? { interruptedApprovals: orphans } : {}),
          })
          // One-click resume entry (Phase 3). Carries the model/domain the run
          // was on — resume is strictly affine to both (prefix-cache), enforced
          // server-side by resumeRun().
          appendMarker('resume_offer', {
            model: rec.model ?? null,
            domain: rec.domain ?? 'auto',
          })
          this.persistRecord(session)
        }
      }
      return
    }

    // Eager fallback (in-memory / legacy adapters with only loadAll()).
    let restored: PersistedSession[]
    try {
      restored = p.loadAll()
    } catch {
      return
    }
    for (const rawPersisted of restored) {
      const ps = {
        ...rawPersisted,
        record: sanitizeSessionDomain(rawPersisted.record),
      }
      const events = ps.events.slice().sort((a, b) => a.seq - b.seq)
      const maxSeq = events.length ? events[events.length - 1]!.seq : ps.record.lastSeq
      const wasRunning = ps.record.status === 'running'
      const session: InternalSession = {
        record: {
          ...ps.record,
          status: wasRunning ? 'aborted' : ps.record.status,
          lastSeq: maxSeq,
          pendingApprovals: 0,
        },
        agent: null,
        // 内存环上限与懒加载路径一致：只保留尾部 maxEvents 进内存。
        events: events.length > this.maxEvents ? trimEventRing(events, this.maxEvents) : events,
        diskFirstSeq: events[0]?.seq,
        eventsLoaded: true,
        seq: maxSeq,
        running: false,
        lifecycleGeneration: 0,
        pending: new Map(),
        pendingDelegations: new Map(),
        listeners: new Set(),
        knownArtifacts: new Set(
          events.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)),
        ),
        steer: new SteerBuffer(),
        queueLane: [],
        // Restore the live domain selection from the persisted key so a rebuilt
        // agent re-applies it. Skills are in-memory only → start clean.
        domainState: resolveDomainState(ps.record.domain ?? 'auto')?.state,
        disabledSkills: new Set(),
        skillLoadErrors: [],
        reasoningEffort: ps.record.reasoningEffort as import('../agent/auto-reasoning.js').ReasoningEffort | 'auto' | undefined,
        planAutoApproveUi: ps.record.planAutoApproveUi === true,
      }
      this.sessions.set(session.record.id, session)
      if (wasRunning) {
        // Close out approvals the crash left dangling (see lazy path above) —
        // here the full log is already in memory, so scan it directly.
        const orphans = findOrphanedApprovals(events)
        for (const o of orphans) {
          this.append(session, 'approval_resolved', { requestId: o.requestId, decision: 'sidecar-restart', toolName: o.toolName })
        }
        // Record an honest marker so the viewer sees the interruption.
        this.append(session, 'status', {
          status: 'aborted',
          reason: 'sidecar-restart',
          ...(orphans.length ? { interruptedApprovals: orphans } : {}),
        })
        // One-click resume entry (Phase 3) — see the lazy path above.
        this.append(session, 'resume_offer', {
          model: ps.record.model ?? null,
          domain: ps.record.domain ?? 'auto',
        })
        this.persistRecord(session)
      }
    }
  }

  /**
   * Lazy-load a rehydrated/evicted session's event log on first access, then keep
   * at most `maxLoadedSessions` logs resident (LRU). Idempotent. All code paths
   * that read or append to `session.events` must funnel through here first so the
   * in-memory log is the complete on-disk log (not an empty lazy placeholder).
   */
  private ensureEvents(session: InternalSession): void {
    if (!session.eventsLoaded) {
      const loader = this.persistence?.loadEvents
      let loadError: string | undefined
      if (loader) {
        let evs: SessionEvent[]
        try {
          evs = loader.call(this.persistence, session.record.id)
        } catch (err) {
          // Do NOT silently replay an empty history — record the failure so it
          // surfaces as a visible error event below (a viewer that reconnects
          // into a blank timeline otherwise has no clue the log read failed).
          evs = []
          loadError = redactText((err as Error)?.message ?? String(err))
        }
        this.adoptLoadedEvents(session, evs)
      }
      session.eventsLoaded = true
      if (loadError !== undefined) {
        this.append(session, 'error', {
          error: `event log could not be read — history replay is incomplete (${loadError})`,
        })
      }
      // 首开兜底对账：sidecar 重启 / abort 吞事件留下的「运行中」死节点在此
      // 补终态——用户打开会话即自愈（仅空闲会话；running 的由 run 收尾对账）。
      this.sweepStaleDelegationNodes(session, 'caller_aborted')
    }
    this.touchLoaded(session)
    this.evictLoadedBeyondCap()
  }

  /** Fold a freshly-read on-disk log into the session (shared by the sync and
   *  async load paths). Caller still owns the eventsLoaded flag. */
  private adoptLoadedEvents(session: InternalSession, evs: SessionEvent[]): void {
    evs.sort((a, b) => a.seq - b.seq)
    // knownArtifacts 在截断前从全量构建——即使 artifact 事件落在被截掉的
    // 头部，去重集仍然完整（防止重放时重新公告旧 artifact）。
    session.knownArtifacts = new Set(
      evs.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)),
    )
    // 截断前记录磁盘最早 seq——replay_window 据此告知前端头部是否被环截掉。
    if (evs.length > 0) session.diskFirstSeq = evs[0]!.seq
    const maxSeq = evs.length ? evs[evs.length - 1]!.seq : session.record.lastSeq
    session.seq = Math.max(session.seq, maxSeq)
    // 内存环上限对懒加载路径同样生效：极长会话（磁盘日志 ≫ maxEvents）只
    // 保留尾部进内存——与活跃会话超过环容量后的行为一致（append 已截尾），
    // 客户端 since=0 重放本来就只拿得到环内尾部。磁盘 events.jsonl 不动，
    // 仍是完整历史的 source of truth。
    session.events = evs.length > this.maxEvents ? trimEventRing(evs, this.maxEvents) : evs
  }

  /** adoptLoadedEvents 的尾部版：截断已在读取侧完成，被截头部的信息由
   *  diskFirstSeq / artifactIds 带出，语义与全量路径逐字对齐。 */
  private adoptLoadedTail(session: InternalSession, tail: EventsTail): void {
    session.knownArtifacts = new Set(tail.artifactIds)
    if (tail.total > 0) session.diskFirstSeq = tail.diskFirstSeq
    const maxSeq = tail.total > 0 ? tail.lastSeq : session.record.lastSeq
    session.seq = Math.max(session.seq, maxSeq)
    // 兜底（M1）：tail 实现返回超限普通事件时再压一次；delegation 两处都豁免。
    session.events = trimEventRing(tail.events, this.maxEvents)
  }

  /**
   * Async twin of ensureEvents for the reconnect-replay entry points. Uses the
   * adapter's non-blocking `loadEventsAsync` when available (async file read +
   * off-thread parse) so a multi-MB log doesn't stall SSE keepalives.
   * Guards:
   *  - concurrent async opens share one in-flight load (no double read);
   *  - if a sync ensureEvents() wins the race while we awaited, the stale disk
   *    snapshot is discarded — the sync path may already have appended fresh
   *    events that a blind overwrite would drop.
   */
  private async ensureEventsAsync(session: InternalSession): Promise<void> {
    if (!session.eventsLoaded) {
      // 尾部读优先：只搬环内那部分过线程边界，代价与日志长度解耦。
      const tailLoader = this.persistence?.loadEventsTailAsync
      const asyncLoader = this.persistence?.loadEventsAsync
      if (!tailLoader && !asyncLoader) {
        this.ensureEvents(session)
        return
      }
      if (!session.eventsLoadPromise) {
        session.eventsLoadPromise = (async () => {
          let tail: Awaited<ReturnType<NonNullable<typeof tailLoader>>> | undefined
          let evs: SessionEvent[] = []
          let loadError: string | undefined
          try {
            if (tailLoader) {
              tail = await tailLoader.call(this.persistence, session.record.id, this.maxEvents)
            } else {
              evs = await asyncLoader!.call(this.persistence, session.record.id)
            }
          } catch (err) {
            tail = undefined
            evs = []
            loadError = redactText((err as Error)?.message ?? String(err))
          }
          if (session.eventsLoaded) return // sync load won the race — keep it
          if (tail) this.adoptLoadedTail(session, tail)
          else this.adoptLoadedEvents(session, evs)
          session.eventsLoaded = true
          if (loadError !== undefined) {
            this.append(session, 'error', {
              error: `event log could not be read — history replay is incomplete (${loadError})`,
            })
          }
          // 与 ensureEvents 同步路径相同的首开兜底对账。
          this.sweepStaleDelegationNodes(session, 'caller_aborted')
        })().finally(() => {
          session.eventsLoadPromise = undefined
        })
      }
      await session.eventsLoadPromise
    }
    this.touchLoaded(session)
    this.evictLoadedBeyondCap()
  }

  /** Async twin of getEvents — reconnect/replay entry point for HTTP routes. */
  async getEventsAsync(id: string, since = 0): Promise<{ events: SessionEvent[]; lastSeq: number } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    await this.ensureEventsAsync(s)
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    const events = s.events.filter((e) => e.seq > since)
    return { events, lastSeq: s.seq }
  }

  /**
   * 回放窗口元数据（冷热双通道）。/stream 在回放最前发出 replay_window
   * 合成事件：diskFirstSeq < floorSeq ⇔ 内存环截掉了头部，前端据此显示
   * 「加载更早的历史」入口。须在 getEventsAsync 之后调用（events 已加载）。
   */
  getReplayWindow(id: string): { floorSeq: number; diskFirstSeq: number; diskLastSeq: number } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const floorSeq = s.events[0]?.seq ?? s.seq + 1
    return { floorSeq, diskFirstSeq: s.diskFirstSeq ?? floorSeq, diskLastSeq: s.seq }
  }

  /**
   * 冷通道历史分页：绕过内存环直读磁盘日志（复用 loadEventsAsync 的
   * off-thread parse），返回 seq < before 的最后 ~limit 条，并向前扩展到
   * 最近的 user 事件对齐 turn 边界——前端独立 fold 一页再前插的正确性
   * 前提（见桌面探针 history-page-fold.test.ts）。纯读，不写环不写盘；
   * 磁盘 events.jsonl 是完整历史的唯一 source of truth。
   *
   * seq 允许有洞（损坏行被持久化层丢弃）——分页只依赖单调性。
   */
  async getHistoryPage(id: string, before: number, limit: number): Promise<{
    events: SessionEvent[]
    /** 磁盘日志最早 seq——events[0].seq 到达它即无更早页。 */
    firstSeq: number
    lastSeq: number
  } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const p = this.persistence
    // 快路径（Phase 2）：稀疏索引字节区间读——大日志分页不整本进内存。
    // turn 对齐可能需要比 limit 更早的事件（页首向前扩到最近 user 事件），
    // 窗口不够对齐时按 4 倍扩窗重试；扩窗到顶仍不成 → 全量路径兜底。
    if (p?.loadEventsBefore) {
      try {
        // +500：预留一个索引桶的对齐余量，常规 turn 尺寸（~100-200 事件）
        // 下首次取窗即可完成 user 对齐，不用二次往返。
        let want = Math.max(1, limit) + 500
        for (let attempt = 0; attempt < 4; attempt++) {
          const win = await p.loadEventsBefore.call(p, id, before, want)
          const head = win.events
          let start = Math.max(0, head.length - Math.max(1, limit))
          while (start > 0 && head[start]!.type !== 'user') start--
          const aligned = start > 0 || win.atLogStart || head[0]?.type === 'user'
          if (aligned) {
            return { events: head.slice(start), firstSeq: win.firstSeq, lastSeq: s.seq }
          }
          want *= 4
        }
      } catch { /* 索引路径失败 → 全量兜底 */ }
    }
    let all: SessionEvent[]
    if (p?.loadEventsAsync) {
      try { all = await p.loadEventsAsync.call(p, id) } catch { all = [] }
    } else if (p?.loadEvents) {
      try { all = p.loadEvents.call(p, id) } catch { all = [] }
    } else {
      // ephemeral 模式（无持久化）：内存环即全量历史。
      all = s.events
    }
    const firstSeq = all[0]?.seq ?? 0
    const head = all.filter((e) => e.seq < before)
    let start = Math.max(0, head.length - Math.max(1, limit))
    // turn 边界对齐：页首必须是 user 事件（无则扩到日志开头）。对齐只向前
    // 扩展，保证与上一页无缝衔接（下一次 before = 本页 events[0].seq）。
    while (start > 0 && head[start]!.type !== 'user') start--
    return { events: head.slice(start), firstSeq, lastSeq: s.seq }
  }

  /**
   * 全历史事件读取（磁盘直读优先，Phase 2）——供 insights / getWorkerLog /
   * listRewindPoints 等需要越过内存环截尾语义的消费者使用。这些消费者按
   * 类型过滤全流（稀疏索引帮不上忙），直接走 loadEventsAsync 的 off-thread
   * parse。ephemeral（无持久化）与磁盘读失败降级为环内容（可用性优先）。
   */
  async getAllEventsAsync(id: string): Promise<{ events: SessionEvent[]; lastSeq: number } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // 先冲掉 manager 级合并缓冲（delta/tool_result），保证磁盘含全部已 append。
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    const p = this.persistence
    if (p?.loadEventsAsync) {
      try {
        return { events: await p.loadEventsAsync.call(p, id), lastSeq: s.seq }
      } catch { /* fall back to ring */ }
    } else if (p?.loadEvents) {
      try {
        return { events: p.loadEvents.call(p, id), lastSeq: s.seq }
      } catch { /* fall back to ring */ }
    }
    return this.getEventsAsync(id, 0)
  }

  /**
   * 失败钻取(W2):单个 worker 的完整日志——活动流(会话 delegation 事件)
   * + 终态结果(loadPersistedResult)+ 转录尾部(loadWorkerSession,
   * 与 CLI worker-detail 同源 ~/.rivet/subagents/<orderId>.session.jsonl)。
   * 返回 undefined = 会话不存在;三段数据均可独立为空(worker 无存档时)。
   * `full` 模式(桌面「查看完整转录」):不截尾部 50 条,单条正文上限放宽,
   * 工具调用帧带参数摘要(toolInput)。默认模式保持轻载荷。
   * rounds:稳定 id 复用时的逐轮归档索引(L1),result 始终是最新一轮。
   */
  async getWorkerLog(id: string, workerId: string, opts?: { full?: boolean }): Promise<{
    activity: string[]
    result: ReturnType<typeof loadPersistedResult>
    rounds: PersistedResultRound[]
    transcript: { role: string; text: string; toolName?: string; toolInput?: string }[]
    savedAt: number | null
    /** true = 默认模式下转录尾部有被截断的更早消息(可用 full=1 拉全量)。 */
    truncated: boolean
  } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const full = opts?.full === true
    // 活动日志:会话事件流中该 worker 的 progressLine / 文本增量 / 状态迁移。
    // 全历史读取(Phase 2):磁盘直读越过内存环截尾,早于环底的 worker 活动可见。
    const { events } = (await this.getAllEventsAsync(id)) ?? { events: [] as SessionEvent[] }
    const activity: string[] = []
    for (const e of events) {
      if (e.type !== 'delegation') continue
      if (String(e.data.workOrderId ?? '') !== workerId) continue
      const line = e.data.progressLine
        ?? (e.data.eventKind === 'text' ? e.data.eventDetail : undefined)
        ?? (e.data.status != null ? `status: ${String(e.data.status)}` : undefined)
      if (typeof line === 'string' && line) activity.push(line.slice(0, 300))
    }
    const result = loadPersistedResult(workerId)
    // 运行中优先读内存活转录（coordinator per-order 注册）——saveWorkerSession
    // 只在终态落盘，没有这条通道运行中的转录永远是空/陈旧的上一轮存档。
    const liveMessages = this.coordinatorBySession.get(id)?.()?.getLiveWorkerMessages(workerId)
    const record = liveMessages && liveMessages.length > 0 ? null : loadWorkerSession(workerId)
    const messages = liveMessages && liveMessages.length > 0 ? liveMessages : (record?.messages ?? [])
    const keep = full ? messages : messages.slice(-50)
    const textCap = full ? 4000 : 800
    const transcript = keep.map((m: OaiMessage) => ({
      role: m.role,
      // 纯工具调用轮的 assistant.content 为 null——oaiMessageText 此时运行期为 null,必须兜底
      text: (oaiMessageText(m) ?? '').slice(0, textCap),
      toolName: isAssistantWithTools(m) ? m.tool_calls[0]?.function.name : undefined,
      toolInput: isAssistantWithTools(m) ? summarizeToolCallArgs(m.tool_calls[0]) : undefined,
    }))
    return {
      activity: full ? activity : activity.slice(-50),
      result,
      rounds: listPersistedResultRounds(workerId),
      transcript,
      savedAt: record?.savedAt ?? null,
      truncated: !full && messages.length > 50,
    }
  }

  /** Mark a session's log as most-recently-used in the LRU. */
  private touchLoaded(session: InternalSession): void {
    if (!session.eventsLoaded) return
    const id = session.record.id
    const i = this.loadedOrder.indexOf(id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
    this.loadedOrder.push(id)
  }

  /**
   * Drop event logs of idle LRU sessions to bound resident memory. Never unloads
   * a session that's live (agent built or running) or being watched (SSE
   * listeners) — its in-memory log is the source of truth for in-flight appends
   * and replay; those reload cleanly from disk once idle.
   */
  private evictLoadedBeyondCap(): void {
    let i = 0
    while (i < this.loadedOrder.length && this.loadedOrder.length > this.maxLoadedSessions) {
      const id = this.loadedOrder[i]!
      const s = this.sessions.get(id)
      if (!s || s.agent || s.running || s.listeners.size > 0) { i++; continue }
      s.events = []
      s.knownArtifacts = new Set()
      s.eventsLoaded = false
      this.loadedOrder.splice(i, 1)
    }
  }

  /** Lightweight counts for GET /health. */
  stats(): { sessionCount: number; runningCount: number } {
    let runningCount = 0
    for (const s of this.sessions.values()) if (s.running) runningCount++
    return { sessionCount: this.sessions.size, runningCount }
  }

  /**
   * Disk-usage report for the storage cleanup UI. Sizes come from the
   * persistence adapter's stat()-only scan (no event-log reads), so this is
   * cheap to call even with a large history. Archived sessions are the
   * reclaimable set and are returned oldest-first.
   */
  storageReport(): StorageReport {
    const sizes = this.persistence?.sizeReport?.() ?? new Map<string, number>()
    let totalBytes = 0
    let archivedBytes = 0
    const archived: SessionStorageEntry[] = []
    for (const s of this.sessions.values()) {
      const bytes = sizes.get(s.record.id) ?? 0
      totalBytes += bytes
      if (s.record.archived === true) {
        archivedBytes += bytes
        archived.push({
          id: s.record.id,
          title: s.record.title,
          status: s.record.status,
          updatedAt: s.record.updatedAt,
          bytes,
        })
      }
    }
    archived.sort((a, b) => a.updatedAt - b.updatedAt)
    return {
      totalBytes,
      sessionCount: this.sessions.size,
      archivedCount: archived.length,
      archivedBytes,
      archived,
    }
  }

  /**
   * Irreversibly delete ONE archived session's files. Guarded: refuses unless
   * the session is archived. An archived run may still be settling after its
   * abort request; hard delete tombstones durability while finalization retains
   * only the in-memory busy/resource cleanup path.
   */
  deleteSession(id: string): { ok: boolean; freedBytes: number } {
    const s = this.sessions.get(id)
    if (!s || s.record.archived !== true) return { ok: false, freedBytes: 0 }
    const freedBytes = this.persistence?.sizeOf?.(id) ?? 0
    return { ok: this.hardDelete(id), freedBytes }
  }

  /**
   * Bulk-purge archived sessions. `ids` restricts to a specific set; otherwise
   * all archived qualify. `olderThanMs` further keeps only sessions untouched
   * for at least that long (relative to updatedAt). Never touches active or
   * running sessions. Returns the count and total bytes reclaimed.
   */
  purgeArchived(opts: { ids?: string[]; olderThanMs?: number } = {}): {
    deleted: number
    freedBytes: number
    ids: string[]
  } {
    const now = this.now()
    const idFilter = opts.ids ? new Set(opts.ids) : null
    const sizes = this.persistence?.sizeReport?.() ?? new Map<string, number>()
    const targets: string[] = []
    for (const s of this.sessions.values()) {
      if (s.record.archived !== true || s.running) continue
      if (idFilter && !idFilter.has(s.record.id)) continue
      if (opts.olderThanMs != null && now - s.record.updatedAt < opts.olderThanMs) continue
      targets.push(s.record.id)
    }
    let freedBytes = 0
    const deleted: string[] = []
    for (const id of targets) {
      if (this.hardDelete(id)) {
        freedBytes += sizes.get(id) ?? 0
        deleted.push(id)
      }
    }
    return { deleted: deleted.length, freedBytes, ids: deleted }
  }

  /**
   * Remove a session from memory + disk + registry. Internal: callers enforce
   * the archived/idle policy. Idempotent (missing id → false).
   */
  private hardDelete(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.tombstoned = true
    s.lifecycleGeneration++
    s.toolResultClosed = true
    this.disposeDeletedSessionState(s)
    try { s.agent?.shutdown?.() } catch { /* best-effort */ }
    try { s.jobs?.killAll() } catch { /* best-effort */ }
    if (s.activeRunSettlement) {
      this.releaseRunClaims(id, s.activeRunSettlement)
    } else {
      try { this.getRegistry?.()?.releaseAllClaims(id) } catch { /* best-effort */ }
    }
    this.sessions.delete(id)
    const i = this.loadedOrder.indexOf(id)
    if (i !== -1) this.loadedOrder.splice(i, 1)
    try { this.persistence?.deleteSession?.(id) } catch { /* best-effort */ }
    // Permanently destroyed — never rebuilds, so drop stores unconditionally.
    this.forgetStores(id)
    return true
  }

  private disposeDeletedSessionState(session: InternalSession): void {
    if (session.deltaTimer) clearTimeout(session.deltaTimer)
    session.deltaTimer = undefined
    session.deltaBuf = undefined
    session.deltaRunActive = false
    this.cancelPlanDraftTimer(session)
    session.planDraftLastEmit = undefined
    if (session.watchdogContinueTimer) clearTimeout(session.watchdogContinueTimer)
    session.watchdogContinueTimer = undefined
    session.watchdogAutoResubmit = false
    session.watchdogRecoveryCancelled = true
    if (session.planAutoApproveTimer) clearTimeout(session.planAutoApproveTimer)
    session.planAutoApproveTimer = undefined
    session.planAutoApproveSlug = undefined
    this.cancelToolResultBuf(session)
    for (const pending of session.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve({ approved: false })
    }
    session.pending.clear()
    session.record.pendingApprovals = 0
  }

  private ownsSessionDurability(session: InternalSession): boolean {
    return !session.tombstoned && this.sessions.get(session.record.id) === session
  }

  private ownsSessionLifecycle(session: InternalSession, generation: number): boolean {
    return this.ownsSessionDurability(session) && session.lifecycleGeneration === generation
  }

  private releaseRunClaims(id: string, settlement: ActiveRunSettlement): void {
    if (settlement.claimsReleased) return
    settlement.claimsReleased = true
    try { this.getRegistry?.()?.releaseAllClaims(id) } catch { /* non-fatal */ }
  }

  private canReconcileAbortedRun(
    session: InternalSession,
    expectedGeneration: number,
    settlement?: ActiveRunSettlement,
    requireIdle = false,
  ): boolean {
    if (this.sessions.get(session.record.id) !== session) return false
    if (session.tombstoned || session.record.archived) return false
    if (session.record.status !== 'aborted') return false
    if (session.lifecycleGeneration !== expectedGeneration) return false
    if (settlement && session.activeRunSettlement && session.activeRunSettlement !== settlement) return false
    if (requireIdle && session.running) return false
    return true
  }

  private hasLiveCoordinatorDelegation(session: InternalSession): boolean {
    const latest = new Map<string, { workerId: string; status: string }>()
    for (const ev of session.events) {
      if (ev.type !== 'delegation') continue
      const workerId = typeof ev.data.workerId === 'string' ? ev.data.workerId : undefined
      const status = typeof ev.data.status === 'string' ? ev.data.status : undefined
      if (!workerId || !status) continue
      const attemptId = typeof ev.data.attemptId === 'string' ? ev.data.attemptId : undefined
      const dispatchId = typeof ev.data.dispatchId === 'string' ? ev.data.dispatchId : undefined
      const key = attemptId ?? (dispatchId ? `${dispatchId}:${workerId}` : workerId)
      latest.set(key, { workerId, status })
    }
    for (const { workerId, status } of latest.values()) {
      if (status !== 'running' || session.backgroundAborts?.has(workerId)) continue
      try {
        if (this.isWorkerRunning(session.record.id, workerId)) return true
      } catch {
        // Unknown ground truth must not be converted into a fabricated failure.
        return true
      }
    }
    return false
  }

  private scheduleAbortStaleDelegationSweep(
    session: InternalSession,
    settlement: ActiveRunSettlement,
    expectedGeneration: number,
  ): void {
    const state = settlement.staleSweep ?? (settlement.staleSweep = {
      expectedGeneration,
      attempts: 0,
      scheduled: false,
    })
    if (state.expectedGeneration !== expectedGeneration) {
      state.expectedGeneration = expectedGeneration
      state.attempts = 0
      state.finishedGeneration = undefined
    }
    if (state.scheduled || state.finishedGeneration === expectedGeneration) return
    state.scheduled = true
    void settlement.promise.then(() => {
      setImmediate(() => this.runAbortStaleDelegationSweep(session, settlement))
    })
  }

  private runAbortStaleDelegationSweep(
    session: InternalSession,
    settlement: ActiveRunSettlement,
  ): void {
    const state = settlement.staleSweep
    if (!state?.scheduled) return
    const expectedGeneration = state.expectedGeneration
    const finish = () => {
      state.scheduled = false
      state.finishedGeneration = state.expectedGeneration
    }
    const retry = () => {
      if (state.attempts >= ABORT_RECONCILE_MAX_RETRIES) {
        // Stop after a bounded window without fabricating a terminal event when
        // coordinator liveness never becomes authoritative.
        finish()
        return
      }
      state.attempts++
      const timer = setTimeout(
        () => this.runAbortStaleDelegationSweep(session, settlement),
        ABORT_RECONCILE_RETRY_DELAY_MS,
      )
      timer.unref?.()
    }

    if (!settlement.settled
      || !this.canReconcileAbortedRun(session, expectedGeneration, settlement, true)) {
      finish()
      return
    }
    if (this.hasLiveCoordinatorDelegation(session)) {
      retry()
      return
    }
    try {
      this.sweepStaleDelegationNodes(session, 'caller_aborted')
    } catch {
      retry()
      return
    }
    // Re-check after the sweep so a liveness transition cannot end the chain
    // between the pre-check and the sweep's own ground-truth read.
    if (this.hasLiveCoordinatorDelegation(session)) {
      retry()
      return
    }
    finish()
  }

  private cancelPlanDraftTimer(session: InternalSession): void {
    if (session.planDraftTimer !== undefined) {
      this.planEventScheduler.clearTimeout(session.planDraftTimer)
      session.planDraftTimer = undefined
    }
    session.planDraftTimerGeneration = undefined
  }

  /**
   * Count running sessions sharing a working directory (VSW §6 adaptive policy).
   * `runningCount` alone is global and would misjudge sessions in different
   * projects as concurrent (反证表). Paths are resolved before comparison so
   * relative/absolute forms of the same cwd match. `excludeSessionId` drops the
   * caller's own session, yielding "other concurrent sessions on this cwd".
   */
  sameCwdRunningCount(cwd: string, excludeSessionId?: string): number {
    const target = resolve(cwd)
    let count = 0
    for (const s of this.sessions.values()) {
      if (!s.running) continue
      if (excludeSessionId && s.record.id === excludeSessionId) continue
      if (resolve(s.record.cwd) === target) count++
    }
    return count
  }

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = this.idGenerator()
    let cwd = input.cwd ?? this.defaultCwd
    let worktreeBranch: string | undefined
    let worktreePath: string | undefined
    let baselineHead: string | undefined

    if (input.isolatedWorktree) {
      try {
        const wt = createWorktree(cwd, id)
        worktreeBranch = wt.branch
        worktreePath = wt.path
        cwd = wt.path
        // Diff baseline for the Changes tab: task delta stays visible even
        // after the agent commits mid-task.
        baselineHead = revParseHead(wt.path)
      } catch {
        // Worktree creation failed — fall back to shared cwd silently.
      }
    }

    const ts = this.now()

    // Per-project defaults: load .rivet-config.json from the session cwd so
    // agent.defaultDomain and provider.default override the global startup
    // values. Explicit input.model/domain take top priority (user chose in the
    // new-session dialog); then project config; then the global default.
    let sessionModel = this.defaultModelId
    let sessionDomain = this.defaultDomain ?? 'qiming'
    try {
      const projectConfig = loadConfig({ cwd })
      // loadConfig 合并全局+项目层：取新鲜值（含 'auto'），设置页运行期改
      // agent.defaultDomain 后新会话即生效，不用重启 sidecar；启动快照仅作
      // config 加载失败时的回退。
      const projectDomain = projectConfig.agent?.defaultDomain
      if (projectDomain) sessionDomain = projectDomain
      const projectProvider = projectConfig.provider.providers[projectConfig.provider.default]
      if (projectProvider?.models[0]?.id) sessionModel = projectProvider.models[0].id
    } catch { /* project config load failure is non-fatal — fall back to global defaults */ }
    if (input.model) sessionModel = input.model
    if (input.domain) sessionDomain = input.domain

    const session: InternalSession = {
      record: {
        id,
        status: 'idle',
        createdAt: ts,
        updatedAt: ts,
        cwd,
        title: input.title,
        lastSeq: 0,
        pendingApprovals: 0,
        approvalMode: input.approvalMode,
        model: sessionModel,
        domain: sessionDomain,
        worktreeBranch,
        worktreePath,
        baselineHead,
        ...(input.planMode ? { planMode: input.planMode } : {}),
        ...(input.askMode ? { askMode: input.askMode } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        // P1b：随 record 持久化，sidecar 重启/rehydrate 后由恢复路径读回——
        // 否则重启后静默失去倒计时自动批准（fail-closed 但前后不一致）。
        ...(input.planAutoApproveUi === true ? { planAutoApproveUi: true } : {}),
        ...(input.allowedTools !== undefined ? { allowedTools: [...input.allowedTools] } : {}),
      },
      agent: null,
      approvalMode: input.approvalMode,
      reasoningEffort: input.reasoningEffort,
      events: [],
      // 新会话首个事件 seq=1；live 截尾（append splice）后 events[0] 会漂移，
      // 此值保持 1 使 replay_window 仍能暴露"头部在磁盘"。
      diskFirstSeq: 1,
      eventsLoaded: true,
      seq: 0,
      running: false,
      lifecycleGeneration: 0,
      pending: new Map(),
      pendingDelegations: new Map(),
      listeners: new Set(),
      knownArtifacts: new Set(),
      steer: new SteerBuffer(),
      queueLane: [],
      domainState: sessionDomain && sessionDomain !== 'auto'
        ? resolveDomainState(sessionDomain)?.state
        : undefined,
      disabledSkills: new Set(),
      skillLoadErrors: [],
      unattended: input.unattended === true,
      planAutoApproveUi: input.planAutoApproveUi === true,
    }
    // P1 — Mission 关联（显式路径）。projectId 用原项目根（input.cwd），
    // 不用 worktree 变异后的 cwd——worktree 路径是临时的，projectId 会漂移。
    // Best-effort：Mission 存储故障不阻断会话创建。
    if (this.missionStore) {
      try {
        const projectCwd = input.cwd ?? this.defaultCwd
        if (input.missionId) {
          session.record.missionId = input.missionId
          this.missionStore.addSession(input.missionId, id)
        } else if (input.title && input.title.trim()) {
          const mission = this.missionStore.getOrCreate(projectCwd, input.title)
          session.record.missionId = mission.id
          this.missionStore.addSession(mission.id, id)
        }
      } catch { /* non-fatal — 会话照常创建，桌面端回退 title/shortId */ }
    }
    this.sessions.set(id, session)
    this.touchLoaded(session)
    this.persistRecord(session)
    // 立即加载技能到共享 registry：技能列表查询（/skills）发生在用户发首条消息之前，
    // 而 agent 是懒创建的（ensureAgent 在 run() 时才建）——若把 loadProjectSkills 只留
    // 在 agent 创建路径（buildSessionStores），新会话的技能面板会显示空（0/0）直到首次
    // 对话。这里在创建会话时即加载，幂等（registry 用 Map.set 覆盖）。
    // importFromClaude 的文件复制由后续 agent 创建时的 buildSessionStores 补全（幂等）。
    // 捕获 loadErrors：坏 frontmatter 的技能不再静默消失，UI 会显示原因。
    try { session.skillLoadErrors = loadProjectSkills(cwd).errors } catch { /* non-fatal: 技能加载失败不阻断会话 */ }
    // R1 — announce the session to the shared registry so its file claims are
    // attributed and reaped on crash. Best-effort: registry may be disabled.
    try { this.getRegistry?.()?.register(id, cwd, 'standalone') } catch { /* non-fatal */ }
    if (input.prompt && input.prompt.trim()) {
      this.run(id, input.prompt, input.images)
    }
    return { ...session.record }
  }

  /** Start an agent run on an idle session. Returns false if missing or busy. */
  run(id: string, prompt: string, images?: string[]): boolean {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    const wasAutoResubmit = session.watchdogAutoResubmit === true
    session.watchdogAutoResubmit = false
    session.watchdogRecoveryCancelled = false
    // C2 — 任何新 run（用户 prompt 或倒计时自身触发的 continue）都终结待续跑窗口。
    if (session.watchdogContinueTimer) {
      clearTimeout(session.watchdogContinueTimer)
      session.watchdogContinueTimer = undefined
    }
    // 用户新发 prompt = 对计划审批的参与——取消倒计时自动批准
    this.cancelPlanAutoApprove(session, 'new-prompt')
    session.lastAbortReason = undefined
    session.abortWhileApprovalPending = false
    session.unattendedHaltReason = undefined
    session.unattendedHaltApp = undefined
    // 结构化 halt 标记随新 run 清除（record 会随后续 persist 落盘）。
    if (session.record.unattendedHalt) session.record.unattendedHalt = undefined
    session.watchdogPolicy ??= new WatchdogRecoveryPolicy()
    // 用户主动提交恢复续跑预算；自动续跑注入的 'continue' 不算（与 TUI 的
    // onSubmitCallback 直呼路径一致，否则 consecutive cap 形同虚设）。
    if (!wasAutoResubmit) session.watchdogPolicy.recordUserSubmit()
    // Materialize the on-disk log before appending — otherwise a reconnecting
    // viewer (since=0) would replay only this run's events, not the history.
    this.ensureEvents(session)
    // Mark running before ensureAgent (may await dynamic serve-agent import) so a
    // second run() cannot race in while the module is still loading. User/status
    // events are appended only after the agent exists — warnIfHistoryLost must
    // see the pre-prompt event log, not this turn's user echo.
    session.running = true
    session.toolResultClosed = false
    // Phase 1.1 — 上轮 run 收尾后没赶上工具边界的 steer 残留不再清除（旧语义
    // 在此 steer.clear() 静默丢弃，UI 回声卡片还在 →「显示已发、模型从未收到」）：
    // 与 queue lane 里仍 queued 的条目一起按序拼到新 prompt 前面（对齐 TUI
    // idle 提交语义，app.ts getPendingEntries+clear 归并）。幂等/竞态安全：
    // 只发生在新 run 发起前（此刻 running 刚置位、同步块内无交错）；run 进行
    // 期间的 steer 不受影响，仍走 mid-turn 注入（onSteerDrain）。
    prompt = this.mergeQueuedIntoPrompt(session, prompt)
    session.record.status = 'running'
    session.record.error = undefined
    // R1 — keep the registry heartbeat fresh while this session is active.
    try { this.getRegistry?.()?.heartbeat(id) } catch { /* non-fatal */ }
    this.touch(session)

    const runGeneration = session.lifecycleGeneration
    let resolveRunSettlement!: () => void
    const runSettlementPromise = new Promise<void>((resolve) => {
      resolveRunSettlement = resolve
    })
    const runSettlement: ActiveRunSettlement = {
      settled: false,
      claimsReleased: false,
      promise: runSettlementPromise,
      resolve: resolveRunSettlement,
    }
    session.activeRunSettlement = runSettlement
    const ownsDurability = (): boolean => this.ownsSessionLifecycle(session, runGeneration)

    const startWithAgent = (agent: ManagedAgent) => {
      // Abort/archive raced a dynamic serve-agent import — never start a turn.
      if (!ownsDurability() || session.record.status === 'aborted') {
        if (!runSettlement.settled) {
          runSettlement.settled = true
          if (session.activeRunSettlement === runSettlement) {
            session.activeRunSettlement = undefined
            session.running = false
          }
          this.releaseRunClaims(id, runSettlement)
          try { agent.abort() } catch { /* best-effort */ }
          runSettlement.resolve()
        }
        return
      }
      // Persist each attached image as a standalone file and echo only small
      // reference ids into the event log — NOT the base64. This keeps events.jsonl
      // (and its full replay/restore) tiny while the model still receives the data
      // URLs inline via agent.run below.
      const imageIds = this.persistImages(id, images)
      // Snapshot "first user message" BEFORE appending — the auto-title hook
      // below needs to know whether this run is the conversation opener.
      const wasFirstUser = !session.events.some((e) => e.type === 'user')
      this.append(session, 'user', {
        text: prompt,
        ...(images?.length
          ? { imageCount: images.length, ...(imageIds.length ? { imageIds } : {}) }
          : {}),
      })
      this.append(session, 'status', { status: 'running' })
      // P2-B: emit a goal_state baseline snapshot on the first user message so
      // MissionProjector + GoalBar can cold-start from the event stream instead
      // of relying on HTTP polling. No goalId/tracker yet — just an active empty
      // goal that moves the projector phase from 'draft' to 'executing'.
      if (wasFirstUser) {
        this.append(session, 'goal_state', this.baselineGoalSnapshot() as unknown as Record<string, unknown>)
      }
      this.persistRecord(session)
      // Auto-generate a session title from the first user message when none is
      // set. Fire-and-forget — extraction never blocks the main run, and the
      // hook double-checks `!record.title` after the await so a user who sets a
      // title manually during the ~1s extraction window is never overwritten.
      if (wasFirstUser && !session.record.title) {
        void this.maybeAutoTitle(id, prompt)
      }
      this.bindPlanModeChange(session, agent, runGeneration)
      const callbacks = this.buildCallbacks(session)
      void agent
        .run(prompt, callbacks, images)
        .then(() => {
          if (!ownsDurability()) return
          if (session.record.status === 'running') {
            session.record.status = 'completed'
          }
        })
        .catch((err: unknown) => {
          if (!ownsDurability()) return
          if (session.record.status === 'running') {
            session.record.status = 'failed'
            session.record.error = redactText((err as Error)?.message ?? String(err))
            this.append(session, 'error', { error: session.record.error })
          }
        })
        .finally(() => {
          if (runSettlement.settled) return
          runSettlement.settled = true
          try {
            if (session.activeRunSettlement === runSettlement) {
              session.activeRunSettlement = undefined
              session.running = false
            }
            this.releaseRunClaims(id, runSettlement)
            if (session.record.status === 'aborted') {
              this.scheduleAbortStaleDelegationSweep(
                session,
                runSettlement,
                session.lifecycleGeneration,
              )
            }
            if (!ownsDurability()) {
              // abort 升代使本 run 失去 durability 走早退——会话仍归本 manager 时
              // 补 lane flush（打断后排队/立即发的消息不落下）；真移交由新所有者负责。
              if (this.ownsSessionDurability(session)) this.scheduleQueueLaneFlush(session)
              if (this.ownsSessionDurability(session) && session.record.archived) {
                this.unloadSession(session)
              }
              return
            }
            this.rejectAllPending(session, session.record.status === 'aborted' ? 'aborted' : 'stale')
            this.touch(session)
            this.scanArtifacts(session)
            this.settleHandoffArchive(session)
            this.append(session, 'done', { status: session.record.status })
            // run 收尾 done 已落盘（append 内 touchActivity 无条件置 idle:false）——
            // 此后会话进入等待态（等用户下一条输入/harness 续轮），补 markIdle 收口：
            // 交付后静默等待不被 stall-observer 误报；新 run 的首个事件 append 即自动解除。
            markIdle(session.record.id)
            this.persistRecord(session)
            // Fast-path reconciliation; abort-specific delayed cleanup is
            // handled by the settlement-aware retry chain.
            const sweepReason = session.record.status === 'aborted' ? 'caller_aborted' : 'unknown'
            setImmediate(() => {
              if (this.sessions.get(id) !== session) return
              try {
                this.sweepStaleDelegationNodes(session, sweepReason)
              } catch {
                // Reconciliation is best-effort and must not surface as an
                // uncaught task after the parent run has already settled.
              }
            })
            this.maybeWatchdogAutoContinue(session)
            this.scheduleQueueLaneFlush(session)
            if (session.record.archived) this.unloadSession(session)
          } finally {
            runSettlement.resolve()
          }
        })
    }

    const failEnsure = (err: unknown) => {
      if (ownsDurability() && session.record.status === 'running') {
        session.record.status = 'failed'
        session.record.error = redactText((err as Error)?.message ?? String(err))
        this.append(session, 'error', { error: session.record.error })
      }
      if (!runSettlement.settled) {
        runSettlement.settled = true
        if (session.activeRunSettlement === runSettlement) {
          session.activeRunSettlement = undefined
          session.running = false
        }
        this.releaseRunClaims(id, runSettlement)
        if (session.record.status === 'aborted') {
          this.scheduleAbortStaleDelegationSweep(
            session,
            runSettlement,
            session.lifecycleGeneration,
          )
        }
        if (ownsDurability()) {
          this.append(session, 'done', { status: session.record.status })
          // 同正常收尾：done 落盘后会话进等待态，补 markIdle（失败/中止 run 后
          // 同样等待用户下一步，不属于 stall）。
          markIdle(session.record.id)
          this.persistRecord(session)
        }
        runSettlement.resolve()
      }
    }

    try {
      const agentOrPromise = this.ensureAgent(session)
      if (agentOrPromise && typeof (agentOrPromise as Promise<ManagedAgent>).then === 'function') {
        void (agentOrPromise as Promise<ManagedAgent>).then(startWithAgent, failEnsure)
      } else {
        startWithAgent(agentOrPromise as ManagedAgent)
      }
    } catch (err) {
      failEnsure(err)
    }
    return true
  }

  /**
   * /handoff（桌面端入口）：登记归档任务后发起交接 run——agent 把交接文档写到
   * 项目内 .rivet/HANDOFF.md（工作区内免审批），run 收尾时 settleHandoffArchive
   * 拷贝归档到会话目录 <id>.handoff.md（loadPrevHandoff 注入管线认的位置，
   * 与 TUI pendingHandoffCopy 同语义）。会话不存在/运行中返回 false（路由 409）。
   */
  requestHandoff(id: string, note?: string): { ok: boolean; error?: string } {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.running) return { ok: false, error: 'Session is already running' }
    const src = join(session.record.cwd, '.rivet', 'HANDOFF.md')
    const dest = join(getSessionDir(session.record.cwd), `${session.record.id}.handoff.md`)
    session.pendingHandoff = { src, dest, sinceMs: Date.now() }
    if (!this.run(id, buildHandoffPrompt(src, note))) {
      session.pendingHandoff = undefined
      return { ok: false, error: 'Session is already running' }
    }
    return { ok: true }
  }

  /**
   * run 收尾时的 handoff 归档：交接 run 产出项目内文档后拷贝到会话目录
   * <id>.handoff.md 并补一条 system 事件（新会话于是自动注入交接内容）。
   * best-effort——拷贝失败不阻断 done 事件。
   */
  private settleHandoffArchive(session: InternalSession): void {
    const pending = session.pendingHandoff
    if (!pending) return
    session.pendingHandoff = undefined
    try {
      // 「文档晚于登记写入」的判定带容差：mtimeMs 是亚毫秒精度、sinceMs 是
      // Date.now() 整数毫秒，ext4 等文件系统时间戳还有粒度量化——严格 > 会在
      // 毫秒边界偶发翻转（2026-09-03 CI 三次实证：mtime 262.618 < sinceMs 263，
      // 交接 run 收尾静默跳过归档）。2s 容差不改「陈旧文档跳过」语义
      // （陈旧指上一任务遗留的小时级旧文档），只消除边界抖动。
      if (existsSync(pending.src) && statSync(pending.src).mtimeMs >= pending.sinceMs - 2_000) {
        // dest 父目录在真实 agent 路径下由 SessionPersist 构造创建；但 best-effort
        // 不依赖那个时序（懒构建/异常会话里可能尚无目录）。
        mkdirSync(dirname(pending.dest), { recursive: true })
        copyFileSync(pending.src, pending.dest)
        handoffRecoveries(session.record.cwd, session.record.id)
        this.append(session, 'handoff_archived', {
          text: `✦ 交接文档已写入 ${pending.src} 并归档 ${pending.dest}——新会话将自动注入交接内容。`,
          src: pending.src,
          dest: pending.dest,
        })
      }
    } catch { /* best-effort：归档失败不阻断会话收尾 */ }
  }

  /**
   * One-click resume for a run interrupted by a sidecar restart (resume_offer).
   *
   * Cache-affinity contract: the resumed run should stay on the model and star
   * domain the session was on before the restart — the prefix cache lives per
   * model. Behavior ladder:
   *  - original model available → resume on it (domain restored via
   *    ensureAgent → applySelections from the persisted record.domain);
   *  - original model unavailable AND `resumeFallbackModel` is configured and
   *    available → resume on the fallback with an explicit model_switched
   *    event (`switched: true` in the result lets the UI say "cache will be
   *    rebuilt");
   *  - otherwise degrade to the default model with an explicit warning
   *    (`degraded: true`) instead of fail-closing — the 2026-09-08 report
   *    found the old fail-closed error rendered as a dead-end while a normal
   *    message on the same model would have resumed just fine.
   */
  async resumeRun(id: string): Promise<ResumeRunResult> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'not_found', error: 'Session not found' }
    if (session.running) return { ok: false, code: 'busy', error: 'Session is already running' }
    const original = session.record.model
    const available = this.listModelsFn?.()
    // No injected model source (tests / minimal setups): trust the record —
    // there is nothing to validate against, and the factory resolves it.
    //
    // Session records persist models as `provider:modelId` (switchModel writes
    // that form to disambiguate providers sharing a wire id). Availability
    // must parse the prefix — a bare id/alias comparison against
    // "deepseek:deepseek-v4-flash" was the 2026-09-08 false-negative that
    // made one-click resume claim the current model was gone.
    const isAvailable = (m: string | undefined): m is string => {
      if (!m) return false
      if (!available) return true
      const colon = m.indexOf(':')
      const pinnedProvider = colon > 0 ? m.slice(0, colon) : undefined
      const modelRef = pinnedProvider ? m.slice(colon + 1) : m
      if (!modelRef) return false
      return available.some((o) => {
        if (pinnedProvider && o.provider !== pinnedProvider) return false
        return o.id === modelRef || o.alias === modelRef || o.id === m || o.alias === m
      })
    }
    let target = original
    let switched = false
    let degraded = false
    let warning: string | undefined
    if (!isAvailable(original)) {
      const fallback = this.resumeFallbackModel
      if (isAvailable(fallback)) {
        target = fallback
        switched = true
      } else {
        // 2026-09-08 fix: no configured fallback is a warning-degrade path,
        // not a dead end. Continue on the default model and disclose the
        // prefix-cache rebuild. Only fail when there is no default at all.
        const fallbackLabel = fallback
          ? `（续跑兜底 ${fallback} 也不可用）`
          : '（未配置 agent.resumeFallbackModel）'
        const defaultModel = this.defaultModelId
        if (!isAvailable(defaultModel)) {
          return {
            ok: false,
            code: 'model_unavailable',
            error: original
              ? `原模型 ${original} 当前不可用${fallbackLabel}，且默认模型也不可用——请开新会话继续`
              : '会话未记录原模型，且默认模型不可用——请开新会话继续',
          }
        }
        target = defaultModel
        switched = true
        degraded = true
        warning = `原模型 ${original ?? '(未记录)'} 当前不可用${fallbackLabel}，已按默认模型 ${defaultModel} 降级续跑，前缀缓存将全量重建`
      }
    }
    if (switched) {
      if (session.agent) {
        // Live agent on the wrong model — hot-swap it (emits model_switched).
        if (!(await this.switchModel(id, target!))) {
          return { ok: false, code: 'model_unavailable', error: `目标模型 ${target} 切换失败——请开新会话继续` }
        }
      } else {
        // Agent not built yet: point the record at the fallback/default so
        // ensureAgent builds on it directly, and leave an audit event.
        this.ensureEvents(session)
        session.record.model = target
        this.append(session, 'model_switched', {
          modelId: target,
          reason: degraded ? 'resume-degraded-default' : 'resume-fallback',
          from: original ?? null,
        })
        this.persistRecord(session)
      }
    }
    const started = this.run(id, RESUME_PROMPT)
    if (!started) return { ok: false, code: 'busy', error: 'Session is already running' }
    return {
      ok: true,
      model: session.record.model ?? target ?? '',
      switched,
      ...(degraded ? { degraded, warning } : {}),
    }
  }

  /**
   * User-dispatched background subagent. Unlike run(), this does NOT set
   * session.running — the worker runs in its own isolated sub-session with an
   * independent abort signal, so it coexists with the main turn and is not
   * killed by aborting the main conversation. Progress streams through the same
   * 'delegation' SSE channel (origin:'user') the viewer panel already consumes.
   */
  async delegate(id: string, input: DelegateWorkerInput): Promise<DelegateResult> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, reason: 'not_found' }
    const objective = input.objective?.trim()
    if (!objective) return { ok: false, reason: 'invalid' }
    const agent = await this.ensureAgentAsync(session)
    if (typeof agent.delegateWorker !== 'function') return { ok: false, reason: 'unsupported' }
    const aborts = session.backgroundAborts ?? (session.backgroundAborts = new Map())
    if (aborts.size >= MAX_USER_BACKGROUND_WORKERS) return { ok: false, reason: 'limit' }
    // Materialize the on-disk log so a reconnecting viewer replays this node.
    this.ensureEvents(session)
    const workerId = `user:${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    aborts.set(workerId, controller)
    this.touch(session)
    // Seed the panel with a running node immediately (before the worker spins up).
    this.emitDelegationActivity(session, {
      workOrderId: workerId,
      objective,
      profile: input.profile,
      authority: input.authority,
      status: 'running',
      origin: 'user',
    })
    void agent
      .delegateWorker(
        { ...input, objective },
        {
          workerId,
          signal: controller.signal,
          onActivity: (a) => this.emitDelegationActivity(session, { ...a, origin: 'user' }),
        },
      )
      .catch((err: unknown) => {
        this.emitDelegationActivity(session, {
          workOrderId: workerId,
          status: 'failed',
          summary: redactText((err as Error)?.message ?? String(err)),
          origin: 'user',
        })
      })
      .finally(() => {
        aborts.delete(workerId)
        this.touch(session)
      })
    return { ok: true, workerId }
  }

  /** Cancel a user-dispatched background worker. Returns false if unknown. */
  cancelDelegate(id: string, workerId: string): boolean {
    const controller = this.sessions.get(id)?.backgroundAborts?.get(workerId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private ensureAgent(session: InternalSession): ManagedAgent | Promise<ManagedAgent> {
    if (session.agent) return session.agent
    const inflight = this.agentBuilds.get(session.record.id)
    if (inflight) return inflight
    this.ensureJobs(session)
    // Model affinity: a rehydrated session must come back on the model its
    // record carries (prefix-cache lives per model) — not the default model.
    // 档位：per-session override（含 rehydrate 回读，见下方 approvalMode）优先；
    // 无 override 时用 serve 传入的快照档——PUT /config/approval 的广播回调
    // 会就地更新该快照并对存活 agent 广播（2026-09-05 跨盘审批链修复）。
    const created = this.createAgent(
      session.record.cwd,
      session.record.id,
      session.approvalMode,
      session.record.model,
      session.record.allowedTools,
    )
    const finish = (agent: ManagedAgent): ManagedAgent => {
      session.agent = agent
      this.applySelections(session)
      this.warnIfHistoryLost(session)
      return agent
    }
    // Production serve factory returns a Promise (dynamic serve-agent import).
    // Test doubles return a ManagedAgent synchronously — keep that path sync so
    // existing tests don't need a microtask flush after every run().
    if (created && typeof (created as Promise<ManagedAgent>).then === 'function') {
      // Serialize concurrent lazy builds (rewind-points GET + run() can race on
      // a rehydrated session): share one in-flight promise; drop the entry only
      // when THIS build settles (reference guard so a newer build's slot is not
      // removed by an older settle).
      const pending = (created as Promise<ManagedAgent>).then(finish)
      this.agentBuilds.set(session.record.id, pending)
      // 锁清理不随构建成败。用双参 then 而非 finally：pending 的 rejection 由
      // 调用方（listRewindPoints/run 的 try-catch）处理，但 finally 派生的新
      // promise 会继承 rejection 且无人 await——void 掉即成 unhandled
      // rejection（eperm-filter 全局 handler 打 stderr 噪声，构建失败路径）。
      const clearSlot = () => {
        if (this.agentBuilds.get(session.record.id) === pending) this.agentBuilds.delete(session.record.id)
      }
      void pending.then(clearSlot, clearSlot)
      return pending
    }
    return finish(created as ManagedAgent)
  }

  private async ensureAgentAsync(session: InternalSession): Promise<ManagedAgent> {
    return await this.ensureAgent(session)
  }

  /** Ensure a session has a live agent (lazy build restoring disk history).
   *  Public surface for rewind/edit routes that need message indices on
   *  rehydrated sessions (issue #63). Returns false when the session is
   *  missing or the build fails (cwd removed / config invalid). */
  async ensureSessionAgent(id: string): Promise<boolean> {
    const s = this.sessions.get(id)
    if (!s) return false
    try {
      await this.ensureAgentAsync(s)
      return true
    } catch {
      return false
    }
  }

  /**
   * Surface the "UI has history, model has none" divergence. A rehydrated
   * session replays its full event log to the viewer, but the model context is
   * restored separately from the session .jsonl — if that read failed or came
   * back empty while the event log clearly holds a prior conversation, warn in
   * the timeline instead of letting the user talk to an amnesiac model.
   * Best-effort: only fires when prior events are resident (run() calls
   * ensureEvents first, so the main prompt path always has them).
   */
  private warnIfHistoryLost(session: InternalSession): void {
    const info = session.agent?.getHistoryRestore?.()
    if (!info) return
    if (!info.error && info.restored > 0) return
    const hadConversation = session.events.some((e) => e.type === 'user')
    if (!hadConversation) return
    this.append(session, 'phase', {
      phase: info.error
        ? `⚠️ 历史上下文恢复失败（${redactText(info.error)}）——模型不记得此前的对话，界面历史仅供查看`
        : '⚠️ 历史上下文为空——会话记录文件缺失或已损坏，模型不记得此前的对话，界面历史仅供查看',
      historyRestore: { restored: info.restored, ...(info.error ? { error: redactText(info.error) } : {}) },
    })
  }

  /** Lazily create the server-owned background job registry for a session and
   *  wire its lifecycle events into the SSE stream. Idempotent. */
  private ensureJobs(session: InternalSession): SessionJobs {
    if (!session.jobs) {
      const jobs = new SessionJobs(join(session.record.cwd, '.rivet', 'artifacts', 'jobs'), source => touchActivity(session.record.id, source))
      jobs.on('event', (ev: JobEvent) => {
        this.append(session, 'job', {
          id: ev.job.id,
          command: ev.job.command,
          status: ev.job.status,
          exitCode: ev.job.exitCode,
          startedAt: ev.job.startedAt,
          endedAt: ev.job.endedAt,
          lastLine: ev.job.lastLine,
          pid: ev.job.pid,
          kind: ev.kind,
          ...(ev.chunk ? { chunk: ev.chunk } : {}),
        })
      })
      session.jobs = jobs
    }
    return session.jobs
  }

  /**
   * Re-apply the session's PlusMenu selections (star domain, disabled skills) to
   * its live agent. Idempotent — called both after a lazy build (ensureAgent)
   * and after a model rebuild (switchModel) so the selections survive a fresh
   * AgentLoop. A domainState of undefined means an explicit session Auto and
   * must be replayed: a fresh AgentLoop otherwise mistakes it for "unselected"
   * and re-applies its persistent defaultDomain.
   */
  private applySelections(session: InternalSession): void {
    const agent = session.agent
    if (!agent) return
    // Bind the server-owned job registry so background jobs + their SSE events
    // survive agent rebuilds (switchModel builds a fresh AgentLoop).
    try {
      if (session.jobs) agent.setJobs?.(session.jobs)
    } catch { /* non-fatal */ }
    try {
      if (session.domainState === null) agent.setSessionDomain?.(null)
      else if (session.domainState !== undefined) agent.setSessionDomain?.(session.domainState)
      else if (session.record.domain === 'auto') {
        if (session.record.resolvedDomain) {
          const restored = resolveDomainState(session.record.resolvedDomain.key)
          if (restored?.state) {
            if (agent.restoreAutoResolvedDomain) agent.restoreAutoResolvedDomain(restored.state)
            else agent.setSessionDomain?.(restored.state)
          } else {
            agent.resetSessionDomain?.()
          }
        } else {
          agent.resetSessionDomain?.()
        }
      }
    } catch { /* non-fatal */ }
    try {
      if (session.disabledSkills.size > 0) agent.setDisabledSkills?.(new Set(session.disabledSkills))
    } catch { /* non-fatal */ }
    try {
      if (session.reasoningEffort !== undefined) agent.setReasoningEffort?.(session.reasoningEffort)
    } catch { /* non-fatal */ }
    // 审查门 override 重放：switchModel 重建后 refs 是全新对象（回退到配置默认），
    // 用户显式设置的 auto/off 必须重新写入，否则 Off 静默失效。
    try {
      if (session.reviewGateOverride !== undefined) {
        const ref = this.resolveReviewGateRef?.(session.record.id)
        if (ref) ref.current = session.reviewGateOverride
      }
    } catch { /* non-fatal */ }
    this.bindPlanModeChange(session, agent, session.lifecycleGeneration)
    this.bindAskModeChange(session, agent, session.lifecycleGeneration)
    // Plan mode 是 AgentLoop 的内存态，record.planMode 是持久态。agent 重建
    // （懒构建恢复会话 / switchModel）会丢内存态：工具门禁失效、
    // getActivePlanFilePath 变 null → 桌面「起草中」实时视图断流。record 说
    // planning 时补一次 enterPlanMode（新开草稿文件），恢复两条通道。
    // onPlanModeChange 的同态守卫保证不会重复发 plan_mode SSE。
    if (session.record.planMode === 'planning') {
      try { agent.enterPlanMode?.() } catch { /* non-fatal */ }
    } else if (session.record.askMode === 'asking') {
      try { agent.enterAskMode?.() } catch { /* non-fatal */ }
    }
  }

  private bindPlanModeChange(
    session: InternalSession,
    agent: ManagedAgent,
    lifecycleGeneration: number,
  ): void {
    // AgentLoop owns this callback property, so rebind it for every run. A
    // closure retained by an older run must not mutate a restored/new run.
    agent.onPlanModeChange = (state: PlanModeState) => {
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      if (session.record.planMode === state) return
      session.record.planMode = state
      // Mutual exclusion: enter plan clears ask on the wire record.
      if (state === 'planning' && session.record.askMode === 'asking') {
        session.record.askMode = 'off'
        this.append(session, 'ask_mode', { state: 'off' })
      }
      this.touch(session)
      this.append(session, 'plan_mode', { state })
      this.persistRecord(session)
    }
  }

  private bindAskModeChange(
    session: InternalSession,
    agent: ManagedAgent,
    lifecycleGeneration: number,
  ): void {
    agent.onAskModeChange = (state: AskModeState) => {
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      if (session.record.askMode === state) return
      session.record.askMode = state
      // Mutual exclusion: enter ask clears plan on the wire record.
      if (state === 'asking' && session.record.planMode === 'planning') {
        session.record.planMode = 'off'
        this.append(session, 'plan_mode', { state: 'off' })
      }
      this.touch(session)
      this.append(session, 'ask_mode', { state })
      this.persistRecord(session)
    }
  }

  // ── PlusMenu: star domain ─────────────────────────────────────

  /**
   * PlusMenu — list the domain picker entries for this session (Auto /
   * built-in + custom domains) with the session's current selection flagged.
   * Returns undefined when the session is missing.
   */
  listDomains(id: string): DomainPickerEntry[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return buildDomainPickerEntries(session.domainState)
  }

  /**
   * PlusMenu — set the session's star domain by selection key (auto | off |
   * <domainId>). Updates the stored selection (applied on lazy build), live-
   * mutates an already-built agent, persists the key, and emits domain_changed.
   * Returns false when the session is missing/running or the key is unknown.
   */
  setDomain(id: string, key: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.running) return false
    const resolved = resolveDomainState(key)
    if (!resolved) return false
    delete session.record.resolvedDomain
    session.domainState = resolved.state
    session.record.domain = resolved.key
    try {
      if (resolved.state === undefined) session.agent?.resetSessionDomain?.()
      else session.agent?.setSessionDomain?.(resolved.state)
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'domain_changed', { key: resolved.key, name: resolved.label })
    this.persistRecord(session)
    return true
  }

  // ── PlusMenu: model ───────────────────────────────────────────

  /**
   * PlusMenu — list selectable models for this session, flagging the current
   * one. Returns undefined when the session is missing. Empty when no provider
   * model source was injected (tests).
   */
  listModels(id: string): ModelEntry[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const current = session.record.model
    const all = this.listModelsFn?.() ?? []
    return all.map((m) => {
      const ref = `${m.provider}:${m.id}`
      const currentFlag = !!current && (
        current === ref
        || current === `${m.provider}:${m.alias}`
        || current === m.id
        || current === m.alias
      )
      return { ...m, current: currentFlag }
    })
  }

  /**
   * PlusMenu — hot-switch the session's model, preserving conversation history.
   * Refuses while the session is running (caller must abort first), rebuilds the
   * agent on the new model (same SessionContext), re-applies domain/skill
   * selections, persists record.model, and emits model_switched. Returns false
   * when the session is missing/running or the model id is unknown.
   */
  async switchModel(id: string, modelId: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session || session.running) return false
    const agent = await this.ensureAgentAsync(session)
    let resolved: string | null
    try {
      resolved = agent.switchModel?.(modelId) ?? null
    } catch {
      return false
    }
    if (!resolved) return false
    // The rebuild produced a fresh AgentLoop — re-bind per-session selections.
    this.applySelections(session)
    session.record.model = resolved
    this.touch(session)
    this.append(session, 'model_switched', { modelId: resolved })
    this.persistRecord(session)
    return true
  }

  // ── PlusMenu: review gate ─────────────────────────────────────

  /**
   * PlusMenu (review) — 当前审查门模式。优先级：用户 override > live refs
   * （配置初始化 + 可能已被翻转）> 配置默认。refs 未建（agent 未构建）时
   * 由 override / defaultReviewGate 兜底。会话不存在返回 undefined。
   */
  getReviewGate(id: string): 'auto' | 'off' | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return session.reviewGateOverride
      ?? this.resolveReviewGateRef?.(id)?.current
      ?? this.defaultReviewGate
  }

  /**
   * PlusMenu (review) — 设置会话审查门。写 override（权威）并现写 live refs
   * （refs 未建时仅记 override，applySelections 在 agent 构建后重放）。
   * 会话不存在返回 false。
   */
  setReviewGate(id: string, mode: 'auto' | 'off'): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.reviewGateOverride = mode
    try {
      const ref = this.resolveReviewGateRef?.(id)
      if (ref) ref.current = mode
    } catch { /* non-fatal — override persists and replays on next build */ }
    return true
  }

  // ── PlusMenu: skills ──────────────────────────────────────────

  /**
   * PlusMenu — list every loaded skill with its per-session enablement status.
   * Returns undefined when the session is missing.
   */
  listSkills(id: string): SkillStatus[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return skillRegistry.list().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source ?? (s.builtIn ? 'builtin' : 'rivet'),
      enabled: !session.disabledSkills.has(s.name),
      // Editable when there's a backing file on disk (built-ins have none;
      // plugin skills point at the plugin dir, which the editor could open
      // but we keep read-only for safety — users edit via the plugin's own flow).
      editable: !!s.bodyPath && s.source !== 'builtin' && s.source !== 'plugin',
    }))
  }

  /**
   * Skills that failed to load from .rivet/skills for this session (malformed
   * frontmatter, etc.). Surfaced by GET /skills so an installed-but-unparseable
   * skill is visible rather than silently missing. Returns undefined when the
   * session is missing.
   */
  getSkillLoadErrors(id: string): string[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    // 合并 createSession 的即时加载与 agent 创建路径的导入结果（见 skill-load-errors.ts）
    return [...session.skillLoadErrors, ...getSkillLoadErrorsForSession(id)]
  }

  /**
   * PlusMenu — enable/disable a skill for this session. Updates the disabled
   * set, live-applies it to an already-built agent's discovery filter, and emits
   * skills_changed. Returns false when the session is missing.
   */
  setSkillEnabled(id: string, name: string, enabled: boolean): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (enabled) session.disabledSkills.delete(name)
    else session.disabledSkills.add(name)
    try { session.agent?.setDisabledSkills?.(new Set(session.disabledSkills)) } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'skills_changed', { name, enabled })
    return true
  }

  /**
   * Skills install — list skills discoverable under .claude/skills that can be
   * copied into this session's project .rivet/skills. Read-only; returns
   * undefined when the session is missing.
   */
  listInstallableSkills(id: string): InstallableSkill[] | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return listInstallableSkills(session.record.cwd)
  }

  /**
   * Skills install — count skills already installed under .rivet/skills. Drives
   * the soft install cap in UIs. Returns undefined when the session is missing.
   */
  installedSkillCount(id: string): number | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return countInstalledSkills(session.record.cwd)
  }

  /**
   * Skills install — copy the named skills from .claude/skills into the project
   * .rivet/skills (idempotent; already-present ones are skipped). Intentionally
   * does NOT hot-load into the live registry or emit skills_changed: changing
   * the available-skill set mid-session shatters the prefix cache. The copied
   * skills take effect on the next session. Returns undefined when missing.
   */
  installSkills(id: string, names: string[]): { copied: string[]; skipped: string[]; errors: string[] } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return importSkillsIntoRivet(session.record.cwd, names)
  }

  /**
   * Skills CRUD — read the full SKILL.md text for the editor. Returns null for
   * built-in / plugin skills (no editable backing file) so the UI can show a
   * read-only notice. Returns undefined when the session is missing.
   */
  readSkillContent(id: string, name: string): string | null | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return readSkillContent(name, session.record.cwd)
  }

  /**
   * Skills CRUD — write (create or overwrite) a skill. `scope: 'global'`
   * writes to ~/.rivet/skills (reusable across projects); 'project' writes to
   * <cwd>/.rivet/skills. Throws on malformed frontmatter (route layer → 400).
   * Same no-hot-load contract as install: the change takes effect next session.
   * Returns undefined when the session is missing.
   */
  writeSkill(id: string, name: string, content: string, scope: 'project' | 'global'): { path: string } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return writeSkill(name, content, session.record.cwd, scope)
  }

  /**
   * Skills CRUD — uninstall a project-scoped skill (delete from .rivet/skills).
   * Returns { removed: false } for built-in / plugin / global skills so the UI
   * can show "cannot remove from here". Does NOT hot-load or emit
   * skills_changed — same contract as install. Returns undefined when the
   * session is missing.
   */
  uninstallSkill(id: string, name: string): { removed: boolean; wasDir: boolean } | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    return uninstallSkill(name, session.record.cwd)
  }

  /**
   * S — set the per-session autonomy level. Updates the stored override (so it
   * applies when the agent is first built) AND live-mutates an already-built
   * agent (so a mid-session toggle takes effect on the next tool, no rebuild).
   * Returns false when the session is missing. Persists the new mode onto the
   * record so reconnecting viewers see the current level.
   */
  setApprovalMode(id: string, mode: ApprovalMode): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.approvalMode = mode
    session.record.approvalMode = mode
    try { session.agent?.setApprovalMode?.(mode) } catch { /* non-fatal */ }
    this.touch(session)
    this.persistRecord(session)
    return true
  }

  /**
   * 全局档位变更的实时广播（2026-09-05 跨盘审批链修复）。PUT /config/approval
   * 只写磁盘时，已构建的 agent 永远拿着 sidecar 启动快照档位——UI 显示新档、
   * agent 按旧档询问。对**没有 per-session override** 的存活 agent 实时套用
   * 新档（有 override 的会话尊重用户会话级选择；尚未构建的 agent 由
   * ensureAgent 的磁盘新鲜值兜底）。沙箱 env 联动由 PUT 路由侧统一处理，
   * 此处不重复。返回实际套用的会话数（遥测/测试用）。
   */
  applyGlobalApprovalMode(mode: ApprovalMode): number {
    this.globalApprovalMode = mode
    let applied = 0
    for (const session of this.sessions.values()) {
      if (session.approvalMode) continue
      if (!session.agent) continue
      try {
        session.agent.setApprovalMode?.(mode)
        applied++
      } catch { /* non-fatal — 单会话失败不阻塞广播 */ }
    }
    try { applySandboxPolicyForApprovalMode(mode) } catch { /* non-fatal */ }
    return applied
  }

  /**
   * Set the per-session reasoning effort level. Stores the override (so it
   * applies when the agent is first built) AND live-mutates an already-built
   * agent (so a mid-session change takes effect on the next turn). Returns false
   * when the session is missing. Persists the new level onto the record so
   * reconnecting viewers see the current level.
   */
  setReasoningEffort(id: string, effort: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto'): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.reasoningEffort = effort
    session.record.reasoningEffort = effort
    try { session.agent?.setReasoningEffort?.(effort) } catch { /* non-fatal */ }
    this.touch(session)
    this.persistRecord(session)
    return true
  }

  // ── Goal mode (autonomous cross-turn goal pursuit) ──────────────────
  // Mirrors the CLI/headless goal flow (main.ts:357-416). The tracker drives
  // cross-turn continuation via GoalContinuationController (assembled in
  // loop-factory); update_goal / deliver_task tools read refs.goalTrackerRef,
  // so both the agent field AND refs.current MUST stay in sync.
  /**
   * Create + attach a goal tracker. Resolves success criteria asynchronously
   * (fail-open — defaults to a generic template). Returns the initial state, or
   * null when the session has no goal handles wired (test doubles / legacy
   * sidecar) or the session is missing.
   */
  async setGoal(id: string, opts: {
    goal: string
    maxIterations: number
    contextWindow: number
    wallClockMs?: number
    successCriteria?: string[]
    maxJudgeRuns?: number
  }): Promise<GoalSnapshot | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    if (!handles) return null
    const { GoalTracker } = await import('../agent/goal-tracker.js')
    const { saveGoalState } = await import('../agent/goal-persist.js')
    const tracker = new GoalTracker({
      goal: opts.goal,
      maxIterations: opts.maxIterations,
      contextWindow: opts.contextWindow,
      ...(opts.wallClockMs !== undefined ? { wallClockMs: opts.wallClockMs } : {}),
      ...(opts.successCriteria ? { successCriteria: opts.successCriteria } : {}),
      ...(opts.maxJudgeRuns !== undefined ? { maxJudgeRuns: opts.maxJudgeRuns } : {}),
    })
    // Sync BOTH the agent field (drives GoalContinuationController) AND the refs
    // slot (read by update_goal / deliver_task tool closures). Out of sync →
    // tools see null while continuation runs, or vice versa.
    try { session.agent?.setGoalTracker?.(tracker) } catch { /* non-fatal */ }
    handles.goalTrackerRef.current = tracker
    try { saveGoalState(handles.sessionDir, id, tracker) } catch { /* non-fatal */ }
    this.append(session, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    // Async criteria extraction (fail-open). Mirrors main.ts:392-414.
    void this.extractCriteria(id, opts.goal, tracker)
    return this.snapshotGoal(tracker)
  }

  /** Pause / resume — mutate tracker state, persist, emit. */
  pauseGoal(id: string, reason?: string): GoalSnapshot | null {
    return this.mutateGoal(id, (t) => { t.pause(reason ?? 'user', 'user') })
  }
  resumeGoal(id: string): GoalSnapshot | null {
    return this.mutateGoal(id, (t) => { t.resume('user') })
  }
  /**
   * Cancel is terminal — also clear the agent tracker + refs + persisted
   * state so a subsequent setGoal starts clean (aligns slash-commands.ts:1107).
   *
   * Returns a Promise — the caller MUST await it before issuing setGoal on the
   * same session. The persisted-state deletion is awaited here (not fire-and-
   * forget) so a rapid cancel→setGoal sequence cannot race: without awaiting,
   * the dynamic-import delay + FS buffering could let the delete land AFTER a
   * new setGoal's saveGoalState, wiping the new goal's state file.
   */
  async cancelGoal(id: string): Promise<GoalSnapshot | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    const tracker = handles?.goalTrackerRef.current ?? session.agent?.getGoalTracker?.() ?? null
    if (!tracker) return null
    tracker.cancel()
    try { session.agent?.setGoalTracker?.(null) } catch { /* non-fatal */ }
    if (handles) {
      handles.goalTrackerRef.current = null
      // Await the delete so a subsequent setGoal's save cannot be clobbered.
      try {
        const { deleteGoalState } = await import('../agent/goal-persist.js')
        deleteGoalState(handles.sessionDir, id)
      } catch { /* non-fatal — file may not exist */ }
    }
    this.append(session, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    return this.snapshotGoal(tracker)
  }

  /** Read-only snapshot for the GET endpoint / SSE events. */
  getGoalState(id: string): GoalSnapshot | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    const tracker = handles?.goalTrackerRef.current ?? session.agent?.getGoalTracker?.() ?? null
    return tracker ? this.snapshotGoal(tracker) : null
  }

  private mutateGoal(id: string, fn: (t: import('../agent/goal-tracker.js').GoalTracker) => void): GoalSnapshot | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const handles = this.resolveGoalHandles?.(id)
    const tracker = handles?.goalTrackerRef.current ?? session.agent?.getGoalTracker?.() ?? null
    if (!tracker) return null
    try { fn(tracker) } catch { return null }
    if (handles) {
      import('../agent/goal-persist.js').then(({ saveGoalState }) => {
        try { saveGoalState(handles.sessionDir, id, tracker) } catch { /* non-fatal */ }
      }).catch(() => {})
    }
    this.append(session, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    return this.snapshotGoal(tracker)
  }

  private snapshotGoal(t: import('../agent/goal-tracker.js').GoalTracker): GoalSnapshot {
    const terminalReason = t.getTerminalReason()
    return {
      goalId: t.getGoalId(),
      goal: t.getGoal(),
      status: t.getStatus(),
      iteration: t.getIteration(),
      maxIterations: t.getMaxIterations(),
      wallClockElapsedMs: t.getWallClockElapsedMs(),
      ...(t.getWallClockBudgetMs() !== undefined ? { wallClockBudgetMs: t.getWallClockBudgetMs() } : {}),
      ...(terminalReason ? { terminalReason } : {}),
      successCriteria: t.getSuccessCriteria(),
      ...(t.getLastVerdict() ? { lastVerdict: t.getLastVerdict()! } : {}),
    }
  }

  /**
   * P2-B: Baseline goal_state snapshot emitted on the first user message.
   * No GoalTracker exists yet — this is a synthetic active-empty goal that
   * lets MissionProjector transition from 'draft' to 'executing' phase.
   * Subsequent setGoal/extractCriteria calls will emit richer goal_state events.
   */
  private baselineGoalSnapshot(): GoalSnapshot {
    return {
      goalId: '',
      goal: '',
      status: 'active',
      iteration: 0,
      maxIterations: 0,
      wallClockElapsedMs: 0,
      successCriteria: [],
    }
  }

  private async extractCriteria(id: string, goal: string, tracker: import('../agent/goal-tracker.js').GoalTracker): Promise<void> {
    const handles = this.resolveGoalHandles?.(id)
    if (!handles) return
    try {
      const { extractGoalCriteria, completionFromClient, buildCheapClient } = await import('../agent/goal-criteria.js')
      const session = this.sessions.get(id)
      // Prefer dedicated cheap client (mirrors main.ts:396-406); fall back to
      // the session's own client when no cheap profile is configured.
      let completion: Parameters<typeof extractGoalCriteria>[1] | null = null
      if (handles.cheapProfile && handles.allProviders) {
        const cheap = buildCheapClient(handles.cheapProfile, handles.allProviders as Parameters<typeof buildCheapClient>[1], id)
        if (cheap) completion = completionFromClient(cheap.client, cheap.model)
      }
      if (!completion) return // no cheap client → leave generic criteria default
      const criteria = await extractGoalCriteria(goal, completion)
      tracker.setSuccessCriteria(criteria)
      const s = this.sessions.get(id)
      if (s) this.append(s, 'goal_state', this.snapshotGoal(tracker) as unknown as Record<string, unknown>)
    } catch {
      // non-fatal — tracker keeps its generic default criteria
    }
  }

  /**
   * Auto-generate a session title from the first user message via the cheap
   * model profile (mirrors extractCriteria's side-path pattern). Fail-open:
   * any error or missing config leaves the title unset, the UI falls back to
   * sessionId.slice(0, 8). Double-checks `!record.title` after the await so a
   * user who set a title manually during extraction is never overwritten.
   */
  private async maybeAutoTitle(id: string, firstMessage: string): Promise<void> {
    const handles = this.resolveGoalHandles?.(id)
    if (!handles) return
    try {
      const { extractSessionTitle } = await import('../agent/title-extract.js')
      const { completionFromClient, buildCheapClient } = await import('../agent/goal-criteria.js')
      if (!handles.allProviders) return
      const providers = handles.allProviders as Parameters<typeof buildCheapClient>[1]
      // 先试 cheap profile（默认 minimax）；没配 key 时回退到任一已配 key 的主 provider。
      // 大多数用户只配了主模型（DeepSeek/GLM 等），不会专门配 minimax——此前 cheap 失败
      // 就静默 return，标题永远空，侧边栏显示 ID 截断。标题生成 token 消耗极小（<=256），
      // 用主 provider 做这个 cheap 任务完全可接受。
      let cheap = handles.cheapProfile
        ? buildCheapClient(handles.cheapProfile, providers, id)
        : null
      if (!cheap) {
        // 回退：遍历所有已配 provider，找第一个能构建 client 的。标题生成对模型能力
        // 要求极低，任意已配 provider + 它的第一个 model 即可。
        for (const [providerName, prov] of Object.entries(providers)) {
          const models = (prov as { models?: Array<{ id?: string; alias?: string }> })?.models
          const firstModel = models?.[0]?.id ?? models?.[0]?.alias
          if (!firstModel) continue
          cheap = buildCheapClient({ provider: providerName, model: firstModel }, providers, id)
          if (cheap) break
        }
      }
      if (!cheap) return // 确实一个 key 都没配——leave title unset
      const title = await extractSessionTitle(
        firstMessage,
        completionFromClient(cheap.client, cheap.model, 256),
      )
      const s = this.sessions.get(id)
      if (s && title && !s.record.title) {
        this.setTitle(id, title)
        this.attachImplicitMission(s, title)
      }
    } catch {
      // non-fatal — title stays unset, UI keeps sessionId-slice fallback
    }
  }

  /**
   * rev2 — 隐式 Mission：主流路径（sendPrompt 无标题）在 maybeAutoTitle
   * 起标题成功时获得 Mission。恒新建不去重（自动标题撞名 ≠ 同一任务）。
   * 双检 !record.missionId：显式路径已关联的不重复创建。
   * 注：worktree 会话的 record.cwd 是 worktree 路径，projectId 会偏离项目
   * 根——该组合（无标题 + isolatedWorktree）极少见，P1 接受。
   */
  private attachImplicitMission(s: InternalSession, title: string): void {
    if (!this.missionStore || s.record.missionId) return
    try {
      const mission = this.missionStore.create(s.record.cwd, title)
      this.missionStore.addSession(mission.id, s.record.id)
      s.record.missionId = mission.id
      this.persistRecord(s)
    } catch { /* non-fatal — 标题已写入，仅 Mission 关联缺席 */ }
  }

  /**
   * Plan mode — toggle the session between read-only planning and normal
   * execution. Building the agent eagerly here (ensureAgent) so the toggle binds
   * to the same instance a later run() reuses. Emits a `plan_mode` event so the
   * desktop can flip its mode chip / open the plan column. Returns false when the
   * session is missing.
   */
  async setPlanMode(id: string, state: PlanModeState): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    const agent = await this.ensureAgentAsync(session)
    session.record.planMode = state
    // Mutual exclusion with Ask on the wire record.
    if (state === 'planning' && session.record.askMode === 'asking') {
      session.record.askMode = 'off'
      this.append(session, 'ask_mode', { state: 'off' })
    }
    try {
      if (state === 'planning') agent.enterPlanMode?.()
      else agent.exitPlanMode?.()
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'plan_mode', { state })
    this.persistRecord(session)
    return true
  }

  /**
   * Ask mode — toggle the session between pure read-only Q&A and normal
   * execution. Mutually exclusive with Plan Mode. Emits `ask_mode` (and clears
   * plan_mode when entering). Returns false when the session is missing.
   */
  async setAskMode(id: string, state: AskModeState): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    const agent = await this.ensureAgentAsync(session)
    session.record.askMode = state
    if (state === 'asking' && session.record.planMode === 'planning') {
      session.record.planMode = 'off'
      this.append(session, 'plan_mode', { state: 'off' })
    }
    try {
      if (state === 'asking') agent.enterAskMode?.()
      else agent.exitAskMode?.()
    } catch { /* non-fatal */ }
    this.touch(session)
    this.append(session, 'ask_mode', { state })
    this.persistRecord(session)
    return true
  }

  /** List this session's plans (newest first). null when the session is gone. */
  async listPlans(id: string): Promise<PlanDocument[] | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    try {
      return await storeListPlans(session.record.cwd)
    } catch {
      return []
    }
  }

  /**
   * Active plan-mode draft — the working document the agent writes while
   * planning. Drafts are NOT submitted plans (listPlans filters them); the
   * desktop renders this as a live "起草中" view instead. Returns `undefined`
   * when the session is missing, `null` when it exists but is not planning
   * or has no readable draft. Title is the draft's H1, null while empty.
   */
  async readPlanDraft(id: string): Promise<PlanDraft | null | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    if (session.record.planMode !== 'planning') return null
    const path = session.agent?.getActivePlanFilePath?.() ?? null
    if (!path) return null
    try {
      const content = await readFile(join(session.record.cwd, path), 'utf-8')
      const h1 = content.match(/^#\s+(.+)$/m)
      return { path, title: h1 ? h1[1]!.trim() : null, content }
    } catch {
      return null
    }
  }

  /**
   * Read a single plan's full content. Returns `undefined` when the session is
   * missing and `null` when the session exists but the plan does not — letting
   * the route distinguish 404 reasons.
   */
  async readPlan(id: string, slug: string): Promise<PlanDocument | null | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    try {
      return await storeReadPlan(session.record.cwd, slug)
    } catch {
      return null
    }
  }

  /**
   * Edit a submitted plan's markdown before approval (desktop plan editing —
   * Cursor 3.0 parity: review → tweak the document → Build). Only `submitted`
   * plans are editable; approved/executed are historical records and rejected
   * are archived. Emits `plan_submitted` so viewers re-fetch the body.
   */
  async updatePlan(id: string, slug: string, content: string): Promise<PlanUpdateOutcome> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'session-missing', reason: 'Session not found' }
    // 编辑计划 = 用户参与——取消倒计时自动批准
    this.cancelPlanAutoApprove(session, 'edited')
    const trimmed = content.trim()
    if (!trimmed) return { ok: false, code: 'empty-content', reason: 'Plan content must not be empty' }
    const existing = await storeReadPlan(session.record.cwd, slug)
    if (!existing) return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
    if (existing.status !== 'submitted') {
      return { ok: false, code: 'not-editable', reason: `Only submitted plans can be edited (status: ${existing.status})` }
    }
    // Options: honour a frontmatter block the editor kept/changed; fall back to
    // the recorded ones so a body-only edit never silently drops the choices.
    const options = parsePlanOptions(content) ?? existing.options
    try {
      await storeWritePlan(session.record.cwd, slug, content, options)
    } catch {
      return { ok: false, code: 'plan-not-found', reason: `Failed to write plan "${slug}"` }
    }
    const updated = await storeReadPlan(session.record.cwd, slug)
    this.touch(session)
    this.append(session, 'plan_submitted', {
      slug,
      title: updated?.title ?? existing.title,
      status: 'submitted',
    })
    this.persistRecord(session)
    return { ok: true }
  }

  /**
   * Build (approve) a plan: run the shared approval guards (content validation +
   * anchor-drift recheck), mark it approved on disk, release plan mode, then
   * inject the wave-execution kickoff as the next turn. Returns a structured
   * failure so the route can surface WHY approval was refused (the old boolean
   * collapsed "session running" / "empty plan" / "bad option" into one 409).
   */
  async approvePlan(id: string, slug: string, selectedApproach?: string): Promise<PlanApprovalOutcome> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, code: 'session-missing', reason: 'Session not found' }
    // 用户手动批准 = 参与——取消倒计时自动批准（自动批准定时器自身走清空后的
    // 调用路径，此处为 no-op）。
    this.cancelPlanAutoApprove(session, 'approved')
    if (session.running) {
      return { ok: false, code: 'session-running', reason: 'Session is running — wait for the current turn to finish before Build' }
    }
    // Validate the selected approach BEFORE mutating the plan file — approving
    // first would leave the file marked APPROVED even when the option is bogus.
    let resolvedApproach: string | undefined
    if (selectedApproach?.trim()) {
      const pending = await storeReadPlan(session.record.cwd, slug)
      if (!pending) return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
      if (pending.options && pending.options.length > 0) {
        resolvedApproach = resolvePlanOptionLabel(pending.options, selectedApproach)
        if (!resolvedApproach) {
          return { ok: false, code: 'bad-approach', reason: `Unknown selectedApproach "${selectedApproach}"` }
        }
      } else {
        // No recorded options — pass the user's text through as-is.
        resolvedApproach = selectedApproach.trim()
      }
    }
    // Shared approval kernel (same closed loop as TUI /plan-approve): empty/
    // placeholder plans hard-fail, anchor drift is rechecked and injected into
    // the kickoff, and the kickoff drives wave-by-wave execution through the
    // review gates (plan_task/team_orchestrate + plan_close).
    let result: PlanApprovalResult
    try {
      result = await approvePlanWithGuards(session.record.cwd, slug, resolvedApproach)
    } catch {
      return { ok: false, code: 'plan-not-found', reason: `Plan not found: "${slug}"` }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === 'invalid-content' ? 'invalid-content' : 'plan-not-found',
        reason: result.reason,
      }
    }
    const { approved, kickoff } = result
    const agent = await this.ensureAgentAsync(session)
    try {
      agent.setActivePlan?.({
        slug,
        title: approved.title,
        selectedApproach: resolvedApproach,
      })
    } catch { /* non-fatal */ }
    try { agent.exitPlanMode?.() } catch (err) {
      debugLog('approvePlan: agent.exitPlanMode() failed — plan mode may not have exited', err instanceof Error ? err.message : String(err))
    }
    // agent.onPlanModeChange 可能已镜像 record 并发过 plan_mode —— 条件补发防重复，
    // 同时兜底不支持回调的轻量 double。
    if (session.record.planMode !== 'off') {
      session.record.planMode = 'off'
      this.append(session, 'plan_mode', { state: 'off' })
    }
    // 批准终态也要发 plan_submitted——mission-projector 的 approved 离场转移与
    // 各端审批卡清除都消费它（此前只有 reject/edit 路径发，approved 不可达）。
    this.append(session, 'plan_submitted', { slug, title: approved.title, status: 'approved' })
    this.touch(session)
    this.persistRecord(session)
    this.run(id, kickoff)
    return { ok: true }
  }

  /**
   * Reject a plan with optional feedback. Keeps the plan on disk (marked
   * rejected) and re-enters plan mode. Revision feedback routing depends on
   * session state: idle → kick a revision turn immediately; running → queue
   * through the steer buffer (injected at the next tool boundary), so mid-run
   * feedback is never silently dropped. Emits `plan_submitted` to refresh
   * viewers.
   */
  async rejectPlan(id: string, slug: string, comment?: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    // 驳回 = 用户参与——取消倒计时自动批准
    this.cancelPlanAutoApprove(session, 'rejected')
    let rejected: PlanDocument | null
    try {
      rejected = await storeRejectPlan(session.record.cwd, slug)
    } catch {
      return false
    }
    if (!rejected) return false
    const agent = await this.ensureAgentAsync(session)
    try {
      agent.enterPlanMode?.({ planFilePath: `.rivet/plans/${slug}.md` })
    } catch { /* non-fatal */ }
    // 同 approvePlan：enterPlanMode 的 onPlanModeChange 回调可能已发过 plan_mode。
    if (session.record.planMode !== 'planning') {
      session.record.planMode = 'planning'
      this.append(session, 'plan_mode', { state: 'planning' })
    }
    this.append(session, 'plan_submitted', { slug, title: rejected.title, status: 'rejected' })
    this.touch(session)
    this.persistRecord(session)
    const note = comment?.trim()
    if (note) {
      const revisionPrompt = `User rejected the plan. Feedback:\n\n${note}\n\nRevise the plan in \`.rivet/plans/${slug}.md\`, then call plan action=submit again.`
      if (session.running) {
        // Mid-run rejection: the feedback rides the steer buffer (next tool
        // boundary) instead of being dropped — the old code only handled idle.
        session.steer.push(revisionPrompt)
        this.append(session, 'steer_queued', { text: redactText(revisionPrompt) })
      } else {
        this.run(id, revisionPrompt)
      }
    }
    return true
  }

  /**
   * T3 — queue mid-run user guidance. Unlike run(), this does NOT start a turn:
   * the text is buffered and injected at the next tool boundary (onSteerDrain).
   * Only meaningful while running — an idle session has no turn to steer.
   *
   * Phase 2 — input 也可为 { laneId }：把 queue lane 里仍 queued 的条目升级为
   * steer（置 steered + 入 steer buffer），立即参与本轮 mid-turn 注入，不再等
   * 下次 prompt 归并。升级路径 echo queue_status（queue_pending 卡片的状态
   * 迁移），不再重复 echo steer_queued——queue 卡片已是它的回声。
   *
   * Returns:
   *  - 'queued'         guidance accepted into the running session's buffer
   *  - 'idle'           session exists but is not running (caller should use /prompt)
   *  - 'not_found'      no such session
   *  - 'lane_not_found' laneId 不在该会话的 queue lane 里
   *  - 'lane_not_queued' 条目存在但已非 queued（steered/retracted/merged）
   */
  steer(
    id: string,
    input: string | { laneId: string },
  ): 'queued' | 'idle' | 'not_found' | 'lane_not_found' | 'lane_not_queued' {
    const session = this.sessions.get(id)
    if (!session) return 'not_found'
    if (!session.running) return 'idle'
    let text: string
    let laneEntry: QueueLaneEntry | undefined
    if (typeof input === 'string') {
      text = input
    } else {
      laneEntry = session.queueLane.find((e) => e.id === input.laneId)
      if (!laneEntry) return 'lane_not_found'
      if (laneEntry.status !== 'queued') return 'lane_not_queued'
      text = laneEntry.text
      laneEntry.status = 'steered'
    }
    // 插话 = 用户参与——取消倒计时自动批准
    this.cancelPlanAutoApprove(session, 'steer')
    session.steer.push(text)
    if (laneEntry) {
      this.append(session, 'queue_status', { laneId: laneEntry.id, status: 'steered' })
    } else {
      // Echo into the event log so the thread reflects the queued guidance and
      // reconnecting viewers see it (append-only, like the user turn echo).
      this.append(session, 'steer_queued', { text: redactText(text) })
    }
    this.touch(session)
    return 'queued'
  }

  /**
   * Phase 2 — queue lane：busy 期间排队一条跟进消息，等下次 prompt 时归并进
   * 消息前部（mergeQueuedIntoPrompt），或经 steer { laneId } 升级立即注入、
   * retractQueued 撤回。与 steer 同门槛（仅 running）；与 steer 的区别是
   * 不进本轮 mid-turn 注入。
   */
  queue(id: string, text: string): { laneId: string } | 'idle' | 'not_found' {
    const session = this.sessions.get(id)
    if (!session) return 'not_found'
    if (!session.running) return 'idle'
    // 排队跟进同样是用户参与——取消倒计时自动批准（与 steer 对齐）。
    this.cancelPlanAutoApprove(session, 'queue')
    const entry: QueueLaneEntry = {
      id: `q${randomId()}`,
      text,
      status: 'queued',
      ts: this.now(),
    }
    session.queueLane.push(entry)
    this.append(session, 'queue_pending', { laneId: entry.id, text: redactText(text) })
    this.touch(session)
    return { laneId: entry.id }
  }

  /**
   * Phase 2 — 撤回一条仍 queued 的 queue lane 条目（置 retracted + echo
   * queue_status）。已 steered/merged/retracted 的条目返回 'lane_not_queued'。
   */
  retractQueued(
    id: string,
    laneId: string,
  ): 'retracted' | 'not_found' | 'lane_not_found' | 'lane_not_queued' {
    const session = this.sessions.get(id)
    if (!session) return 'not_found'
    const entry = session.queueLane.find((e) => e.id === laneId)
    if (!entry) return 'lane_not_found'
    if (entry.status !== 'queued') return 'lane_not_queued'
    entry.status = 'retracted'
    this.append(session, 'queue_status', { laneId: entry.id, status: 'retracted' })
    this.touch(session)
    return 'retracted'
  }

  /**
   * Phase 1.1/2 — 新 run 发起前的归并：把上轮遗留的 steer 残留（run 收尾后没
   * 赶上工具边界的排队指导）与 queue lane 中仍 queued 的条目拼到新 prompt
   * 前面，'\n\n' 分隔。仅 steer 残留时直接拼接（原始文本，不套 [User guidance]
   * 头——对齐 TUI app.ts idle 提交语义）；有 lane 条目时 lane 部分单独成节、
   * 带小节头。lane 条目全部置 merged 并逐条 echo queue_status——UI 回声卡片
   * 据此闭环，不再「显示已发、模型从未收到」。buffer/lane 均空时原样返回
   * （不动 prompt、不写事件）。
   */
  private mergeQueuedIntoPrompt(session: InternalSession, prompt: string): string {
    const steerEntries = session.steer.getPendingEntries()
    const laneQueued = session.queueLane.filter((e) => e.status === 'queued')
    if (steerEntries.length === 0 && laneQueued.length === 0) return prompt
    session.steer.clear()
    const sections: string[] = steerEntries.map((e) => e.text)
    if (laneQueued.length > 0) {
      sections.push(`${QUEUE_LANE_MERGE_HEADER}\n${laneQueued.map((e) => e.text).join('\n\n')}`)
      for (const entry of laneQueued) {
        entry.status = 'merged'
        this.append(session, 'queue_status', { laneId: entry.id, status: 'merged' })
      }
    }
    return `${sections.join('\n\n')}\n\n${prompt}`
  }

  /** 注册 session 的 coordinator 引用（main.ts 在 agent 构建后调用）。 */
  setCoordinatorRef(sessionId: string, ref: () => import('../agent/coordinator.js').DelegationCoordinator | undefined): void {
    this.coordinatorBySession.set(sessionId, ref)
  }

  /** 注销 session 的 coordinator 引用（session 关闭时调用）。 */
  clearCoordinatorRef(sessionId: string): void {
    this.coordinatorBySession.delete(sessionId)
  }

  /**
   * 向指定 session 的某个在跑 worker 投递 steer 消息。
   * 返回 null = session/coordinator 不存在；false = worker 不在跑；true = 已入队。
   */
  steerWorker(sessionId: string, workerId: string, text: string): true | false | null {
    const getCoordinator = this.coordinatorBySession.get(sessionId)
    if (!getCoordinator) return null
    const coordinator = getCoordinator()
    if (!coordinator) return null
    return coordinator.steerWorker(workerId, text)
  }

  /**
   * 终止指定 session 的某个在跑 worker（双轨：先 backgroundAborts，再 orderControllers）。
   * 返回 null = session 不存在；false = worker 不在跑/未找到；true = 已终止。
   */
  killWorker(sessionId: string, workerId: string): true | false | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    // 轨 1：用户派发的后台 worker（backgroundAborts）
    const bgAbort = session.backgroundAborts?.get(workerId)
    if (bgAbort) {
      try { bgAbort.abort() } catch { /* already aborted */ }
      session.backgroundAborts?.delete(workerId)
      return true
    }
    // 轨 2：agent 委派的 worker（orderControllers，通过 coordinator）
    const getCoordinator = this.coordinatorBySession.get(sessionId)
    if (!getCoordinator) return false
    const coordinator = getCoordinator()
    if (!coordinator) return false
    return coordinator.killWorker(workerId)
  }

  /** 检查指定 session 的某个 worker 是否在跑。 */
  isWorkerRunning(sessionId: string, workerId: string): boolean {
    const getCoordinator = this.coordinatorBySession.get(sessionId)
    if (!getCoordinator) return false
    const coordinator = getCoordinator()
    if (!coordinator) return false
    return coordinator.isWorkerRunning(workerId)
  }

  /**
   * 兜底对账：事件日志里仍标 running 的 delegation 节点，若地面真值
   * （backgroundAborts / coordinator.orderControllers）判定其已不在跑，
   * 补发终态事件闭环。worker 真实死亡与终态事件落盘本是两条路径——
   * abort 时工具层补发的终态会被 onDelegationActivity 的 lifecycleGeneration
   * 门禁吞掉，sidecar 重启时 rehydrate 也不补 delegation 终态——没有本对账，
   * 子代理面板回放后永远显示「运行中」，kill 只能拿到 409。
   * 只在会话空闲时调用（running 中的会话由 run 收尾统一对账）。
   */
  private sweepStaleDelegationNodes(session: InternalSession, failureReason: string): void {
    if (session.running) return
    const latest = new Map<string, {
      workerId: string
      status: string
      attemptId?: string
      dispatchId?: string
      parentAttemptId?: string
    }>()
    const firstTs = new Map<string, number>()
    for (const ev of session.events) {
      if (ev.type !== 'delegation') continue
      const workerId = typeof ev.data.workerId === 'string' ? ev.data.workerId : undefined
      const status = typeof ev.data.status === 'string' ? ev.data.status : undefined
      if (!workerId || !status) continue
      const attemptId = typeof ev.data.attemptId === 'string' ? ev.data.attemptId : undefined
      const dispatchId = typeof ev.data.dispatchId === 'string' ? ev.data.dispatchId : undefined
      const parentAttemptId = typeof ev.data.parentAttemptId === 'string' ? ev.data.parentAttemptId : undefined
      const key = attemptId ?? (dispatchId ? `${dispatchId}:${workerId}` : workerId)
      if (!firstTs.has(key)) firstTs.set(key, ev.ts)
      latest.set(key, { workerId, status, attemptId, dispatchId, parentAttemptId })
    }
    for (const [key, current] of latest) {
      const { workerId, status, attemptId, dispatchId, parentAttemptId } = current
      if (status !== 'running') continue
      if (session.backgroundAborts?.has(workerId)) continue
      if (this.isWorkerRunning(session.record.id, workerId)) continue
      // 让补发的终态事件带上真实的存活时长（否则 elapsedMs 会从 0 起算）。
      const startedMap = session.delegationStartedAt ?? (session.delegationStartedAt = new Map())
      const ts = firstTs.get(key)
      if (ts !== undefined && !startedMap.has(key)) startedMap.set(key, ts)
      this.emitDelegationActivity(session, {
        workOrderId: workerId,
        attemptId,
        dispatchId,
        parentAttemptId,
        status: 'failed',
        failureReason,
      })
    }
  }

  /**
   * N2 — artifact feedback re-injection. Turns a human comment on an artifact
   * into a structured next-turn prompt so the agent revises in-context. Only
   * valid on an idle session (a finished turn); returns false while running.
   *
   * `lines` carries diff line-level review comments (file + old/new line +
   * comment), surfaced as a `[LINE-LEVEL REVIEW]` block so the agent can locate
   * each remark at an exact file:line anchor. Artifacts-level `comment` and
   * `lines` are both optional but at least one must be non-empty.
   */
  feedback(
    id: string,
    artifactId: string,
    comment: string,
    lines?: ReadonlyArray<{ file: string; oldLine?: number; newLine?: number; comment: string }>,
  ): boolean {
    const s = this.sessions.get(id)
    if (!s || s.running) return false
    this.ensureEvents(s)
    const meta = [...s.events].reverse().find(
      (e) => e.type === 'artifact' && e.data.id === artifactId,
    )
    const target = meta ? String(meta.data.target ?? '') : ''
    const parts: string[] = [`[ARTIFACT FEEDBACK]`]
    parts.push(`Artifact: ${artifactId}${target ? ` (${target})` : ''}`)
    if (comment.trim()) {
      parts.push(`Comment: ${comment}`)
    }
    // 行级评论：每条带 <file>:<line> 锚点，让 agent 精确定位
    const lineRemarks = lines?.filter((l) => l.comment.trim()) ?? []
    if (lineRemarks.length > 0) {
      const rendered = lineRemarks
        .map((l) => {
          const lineRef = l.newLine ?? l.oldLine
          const loc = lineRef != null ? `${l.file}:${lineRef}` : l.file
          return `${loc} — ${l.comment.trim()}`
        })
        .join('\n')
      parts.push(`[LINE-LEVEL REVIEW]\n${rendered}`)
    }
    const prompt = `${parts.join('\n')}\n\nPlease revise your work to address this feedback.`
    return this.run(id, prompt)
  }

  /**
   * Start a run and resolve when it reaches a terminal state (N3 — used by the
   * runtime pool so scheduled tasks can report a summary). Returns immediately
   * with a failed result if the session is missing or already busy.
   */
  runAndWait(
    id: string,
    prompt: string,
  ): Promise<{ status: SessionStatus; summary: string; changedFiles: string[]; haltedApp?: string }> {
    const s = this.sessions.get(id)
    if (!s || s.running) {
      return Promise.resolve({ status: 'failed', summary: 'session missing or busy', changedFiles: [] })
    }
    if (!this.run(id, prompt)) {
      return Promise.resolve({ status: 'failed', summary: 'failed to start', changedFiles: [] })
    }
    // run() installs this token synchronously before invoking AgentLoop.run().
    // Capture it now so a later run can never satisfy this waiter.
    const settlement = s.activeRunSettlement
    if (!settlement) {
      return Promise.resolve({ status: 'failed', summary: 'run settlement unavailable', changedFiles: [] })
    }
    return settlement.promise.then(() => ({
      status: s.record.status,
      summary: this.buildRunSummary(s),
      changedFiles: this.collectChangedFiles(s),
      // 无人值守中止时缺授权的 app（结构化透传给 TaskRecord 修复闭环）。
      ...(s.unattendedHaltApp ? { haltedApp: s.unattendedHaltApp } : {}),
    }))
  }

  private buildRunSummary(session: InternalSession): string {
    // 无人值守 fail-closed 中止：原因优先于末段 assistant 文本（可行动性更高）。
    if (session.unattendedHaltReason) {
      return `[unattended halt] ${session.unattendedHaltReason}`
    }
    // Last assistant text run is the closest thing to a result summary.
    for (let i = session.events.length - 1; i >= 0; i--) {
      const e = session.events[i]!
      if (e.type === 'text_delta') {
        const text = String(e.data.text ?? '').trim()
        if (text) return text.slice(0, 500)
      }
    }
    return `status=${session.record.status}`
  }

  private collectChangedFiles(session: InternalSession): string[] {
    const files = new Set<string>()
    for (const e of session.events) {
      if (e.type !== 'tool_use') continue
      const name = String(e.data.name ?? '')
      if (name !== 'edit_file' && name !== 'write_file' && name !== 'apply_patch') continue
      const input = e.data.input as Record<string, unknown> | undefined
      const path = input && typeof input.path === 'string' ? input.path : null
      if (path) files.add(path)
    }
    return [...files]
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()]
      .filter((s) => !s.record.archived)
      .map((s) => this.enrichRecord(s))
  }

  listAllSessions(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => this.enrichRecord(s))
  }

  /** Enrich a session record with live context usage when the agent is awake. */
  private enrichRecord(s: InternalSession): SessionRecord {
    const record = { ...s.record }
    if (s.agent) {
      try { record.contextTokens = s.agent.getEstimatedTokens?.() } catch { /* non-fatal */ }
      try { record.contextWindow = s.agent.getContextWindow?.() } catch { /* non-fatal */ }
      // Prefer the user's explicit effort selection (including 'auto') over the
      // agent's current concrete level, so the desktop chip reflects the mode
      // the user actually set.
      try { record.reasoningEffort = s.reasoningEffort ?? s.agent.getReasoningEffort?.() } catch { /* non-fatal */ }
    }
    const persona = resolveDomainPersona(record.domain)
    record.domainGlyph = persona.glyph
    record.domainAccent = persona.accent
    return record
  }

  getSession(id: string): SessionRecord | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return this.enrichRecord(s)
  }

  /**
   * I1: expose the live ManagedAgent for a session so surfaces like
   * CouncilSurface can call agent-specific methods (conveneCouncil). Returns
   * undefined when the session is missing or has no built agent yet.
   */
  getAgentForSession(id: string): ManagedAgent | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.agent ?? undefined
  }

  /**
   * I4: append a `hook_result` event for user-defined .rivet/hooks.json scripts.
   * Retains only the latest 50 hook_result events so diagnostic noise does not
   * evict user messages from the main ring buffer.
   */
  emitHookResult(
    id: string,
    results: HookResult[],
    meta: { event: HookEvent; turn?: number; toolName?: string; error?: string },
  ): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.append(s, 'hook_result', {
      event: meta.event,
      turn: meta.turn,
      toolName: meta.toolName,
      error: meta.error,
      results,
    })
    this.trimHookResults(s)
  }

  private trimHookResults(session: InternalSession): void {
    const hookEvents = session.events.filter((e) => e.type === 'hook_result')
    if (hookEvents.length <= 50) return
    const toDrop = hookEvents.length - 50
    const dropped = new Set(hookEvents.slice(0, toDrop))
    session.events = session.events.filter((e) => !dropped.has(e))
  }

  getEvents(id: string, since = 0): { events: SessionEvent[]; lastSeq: number } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // Reconnect/replay entry point — lazy-load the log from disk on first open.
    this.ensureEvents(s)
    // Poll/replay must see the freshest text — drain the delta window first.
    this.flushDeltaBuf(s)
    this.flushToolResultBuf(s)
    const events = s.events.filter((e) => e.seq > since)
    return { events, lastSeq: s.seq }
  }

  /** Live event subscription for SSE. Unsubscribing never aborts the run. */
  /**
   * Subscribe to live events. Optional `clientId` ties this SSE connection to
   * E4 delegate capabilities: on teardown, capabilities registered under the
   * same clientId are cleared and in-flight delegations fail-back (null).
   */
  subscribe(
    id: string,
    listener: (e: SessionEvent) => void,
    opts?: { clientId?: string },
  ): (() => void) | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    s.listeners.add(listener)
    const clientId = opts?.clientId?.trim() || undefined
    return () => {
      s.listeners.delete(listener)
      if (clientId) this.clearDelegateCapabilities(id, clientId)
    }
  }

  abort(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const wasRunning = s.running
    const settlement = s.activeRunSettlement
    // Is there actually anything to stop? Must be sampled before the timers
    // below are cleared. rehydrate() loads EVERY persisted session into memory,
    // so abortAll() (sidecar shutdown + the global POST /abort) walks all of
    // them — without this gate each pass appended a `status: aborted` marker to
    // and re-touched updatedAt on hundreds of long-finished sessions, flattening
    // the recency order every list in the UI sorts by.
    const abortable =
      wasRunning ||
      s.record.status === 'running' ||
      s.pending.size > 0 ||
      s.pendingDelegations.size > 0 ||
      s.watchdogContinueTimer !== undefined ||
      s.planAutoApproveTimer !== undefined
    if (s.record.status === 'running') {
      s.record.status = 'aborted'
    }
    if (wasRunning) {
      s.lifecycleGeneration++
      this.cancelPlanDraftTimer(s)
      s.planDraftLastEmit = undefined
    }
    const expectedGeneration = s.lifecycleGeneration
    // 窄窗口竞态修复：watchdog stall 后 finally → setImmediate 续跑之间，用户
    // abort 对已停会话是空操作。设此标记让 setImmediate 守卫放弃续跑。
    s.watchdogRecoveryCancelled = true
    // C2 — 取消进行中的续跑倒计时（用户点了「取消」或 Esc）。
    if (s.watchdogContinueTimer) {
      clearTimeout(s.watchdogContinueTimer)
      s.watchdogContinueTimer = undefined
      this.append(s, 'watchdog_recovery', { cancelled: true })
    }
    // abort = 用户参与——取消倒计时自动批准
    this.cancelPlanAutoApprove(s, 'aborted')
    if (settlement) {
      this.scheduleAbortStaleDelegationSweep(s, settlement, expectedGeneration)
    }
    s.agent?.abort()
    this.rejectAllPending(s, 'aborted')
    // 兜底对账：abort 升代后 run finally 失去 durability 早退，worker 终态
    // 事件又恰被回调门禁吞掉（见 sweepStaleDelegationNodes）——在此补发。
    // Keep the one-tick fast path; delayed coordinator cleanup is handled by
    // the exact-settlement retry chain above.
    setImmediate(() => {
      if (!this.canReconcileAbortedRun(s, expectedGeneration, settlement)) return
      try {
        this.sweepStaleDelegationNodes(s, 'caller_aborted')
      } catch {
        // The settlement-aware chain owns retries; an observational sweep must
        // never turn an injected liveness-reader failure into an uncaught task.
      }
    })
    // Idle sessions keep their timestamps and their log stays clean. The
    // in-memory suppression flag above still applies — a stall recovery waiting
    // on setImmediate is cancelled either way, it just no longer re-stamps a
    // session whose status is already 'aborted'. Returns true regardless: the
    // route reads false as "no such session" (404).
    if (abortable) {
      this.touch(s)
      this.append(s, 'status', { status: 'aborted' })
      this.persistRecord(s)
    }
    return true
  }

  abortAll(): void {
    for (const id of this.sessions.keys()) this.abort(id)
  }

  /**
   * Wave L: 进程退出路径（runServe.close）触发——为每个 session 调
   * agent.shutdown() 释放 coordinator/timer/in-flight worker 句柄。与
   * abortAll() 分离：abortAll 仅中止当前 turn，shutdownAll 是终结性操作。
   * best-effort：任一 session shutdown 抛错不影响其他。
   */
  shutdownAll(): Promise<void> {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = undefined
    }
    const pending: Promise<void>[] = []
    for (const s of this.sessions.values()) {
      let shutdownResult: void | boolean | Promise<void | boolean> | undefined
      try {
        shutdownResult = s.agent?.shutdown?.()
      } catch { /* best-effort */ }
      const releaseIdleClaims = (settled?: void | boolean) => {
        if (settled !== false) this.releaseClaimsIfIdle(s)
      }
      if (shutdownResult && typeof (shutdownResult as Promise<void>).then === 'function') {
        pending.push(Promise.resolve(shutdownResult).then(releaseIdleClaims, () => undefined))
      } else if (shutdownResult !== false) {
        releaseIdleClaims()
      }
      try { s.jobs?.killAll() } catch { /* best-effort */ }
      // Drain any coalescing delta window so the tail is never lost on exit.
      try { this.flushDeltaBuf(s) } catch { /* best-effort */ }
      try { this.flushToolResultBuf(s) } catch { /* best-effort */ }
    }
    // Flush any buffered events to disk before exit.
    this.persistence?.flushSync?.()
    return pending.length > 0 ? Promise.all(pending).then(() => undefined) : Promise.resolve()
  }

  /**
   * Archive (soft-close) a session: abort if running, mark `archived=true`, and
   * persist. The session is excluded from listSessions() but its data survives on
   * disk (events.jsonl / artifacts) — rehydrate still restores it as archived.
   * Returns false when the session is missing or already archived.
   */
  archiveSession(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.record.archived) return false
    const wasRunning = s.running
    // Stop any in-flight run first (mirrors abort's cleanup).
    if (s.running) {
      s.record.status = 'aborted'
      s.lifecycleGeneration++
      this.cancelPlanDraftTimer(s)
      s.planDraftLastEmit = undefined
      s.agent?.abort()
      this.rejectAllPending(s, 'aborted')
    }
    s.record.archived = true
    // Clean up isolated worktree on archive. Guard against data loss: if the
    // worktree has uncommitted changes, checkpoint-commit them first; if the
    // branch carries commits not merged into the main workspace, keep the
    // branch (only the worktree directory is removed) so work stays landable.
    let branchKept = false
    if (s.record.worktreePath) {
      try {
        const work = hasUnlandedWork(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch)
        if (work.dirty) {
          // worktree remove --force discards uncommitted changes — snapshot them.
          commitAll(s.record.worktreePath, 'rivet: archive checkpoint', { noVerify: true })
        }
        const after = work.dirty || work.unmergedCommits > 0
          ? hasUnlandedWork(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch)
          : work
        // Squash merge-back leaves branch commits unreachable from main —
        // the landedHead marker proves they were landed. A branch head that
        // hasn't moved past the last merge-back is safe to delete.
        const landed = Boolean(s.record.landedHead)
          && revParseHead(s.record.worktreePath) === s.record.landedHead
        branchKept = Boolean(s.record.worktreeBranch) && after.unmergedCommits > 0 && !landed
        removeWorktree(this.defaultCwd, s.record.worktreePath, s.record.worktreeBranch, { keepBranch: branchKept })
      } catch { /* non-fatal */ }
    }
    this.touch(s)
    this.append(s, 'status', branchKept
      ? { status: 'archived', branchKept: true, worktreeBranch: s.record.worktreeBranch }
      : { status: 'archived' })
    s.toolResultClosed = true
    this.cancelToolResultBuf(s)
    this.persistRecord(s)
    // Phase 3 #9 — an archived session must not keep its heavy state resident.
    // If a run was just aborted above, its promise is still settling; run()'s
    // finally does the unload once the agent has actually let go.
    if (!wasRunning) this.unloadSession(s)
    return true
  }

  /**
   * Unarchive (restore) a previously archived session. Returns it to the active
   * list and resets status to idle. Returns false when missing or not archived.
   */
  unarchiveSession(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.record.archived) return false
    s.record.archived = false
    s.toolResultClosed = false
    s.record.status = 'idle'
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /**
   * Rename a session. Updates the record title and persists it.
   * Returns false when the session is missing.
   */
  setTitle(id: string, title: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.record.title = title.trim()
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /** List git worktrees for a given cwd (defaults to the manager's default cwd). */
  getWorktrees(cwd?: string): WorktreeEntry[] {
    return listWorktrees(cwd ?? this.defaultCwd)
  }

  /** ASCII branch/merge graph for a given cwd (defaults to the manager's default cwd). */
  async getGitGraph(cwd?: string, maxCount?: number): Promise<string> {
    return getGitGraph(cwd ?? this.defaultCwd, maxCount)
  }

  /** P4 补线 — real local branches for a project cwd (welcome branch picker). */
  async getGitBranches(cwd?: string): Promise<ReturnType<typeof listGitBranches>> {
    return listGitBranches(cwd ?? this.defaultCwd)
  }

  /** Working-tree changes relative to HEAD for the desktop "changes" tab. */
  async getWorkingTreeFiles(cwd?: string, includeIgnored = false): Promise<{ files: WorkingTreeFile[]; isRepo: boolean }> {
    return getWorkingTreeFiles(cwd ?? this.defaultCwd, 'HEAD', includeIgnored)
  }

  /** Unified diff of a single file relative to HEAD (on-demand). */
  async getFileDiff(path: string, cwd?: string): Promise<string> {
    return getFileDiff(cwd ?? this.defaultCwd, path)
  }

  /**
   * Resolve the git context of a session: worktree cwd for isolated worktree
   * sessions, otherwise the session's own cwd (the project directory), falling
   * back to the shared default cwd only as a last resort. The diff baseline is
   * the recorded creation HEAD for worktree sessions, plain HEAD otherwise.
   */
  private sessionGitContext(id: string): { cwd: string; baseRef: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cwd = s.record.worktreePath ?? s.record.cwd ?? this.defaultCwd
    const baseRef = s.record.baselineHead ?? 'HEAD'
    return { cwd, baseRef }
  }

  /** Session-scoped working-tree changes (worktree cwd + task baseline). */
  async getSessionWorkingTree(id: string, includeIgnored = false): Promise<{ files: WorkingTreeFile[]; isRepo: boolean } | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    const result = await getWorkingTreeFiles(ctx.cwd, ctx.baseRef, includeIgnored)
    // The worktree owner marker is infrastructure, not user work — hide it.
    return { ...result, files: result.files.filter(f => f.path !== '.vsw-owner.json') }
  }

  /** Session-scoped single-file diff (worktree cwd + task baseline). */
  async getSessionFileDiff(id: string, path: string): Promise<string | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    return getFileDiff(ctx.cwd, path, ctx.baseRef)
  }

  /**
   * Full file content at the session's task baseline — the left pane of an
   * editor client's native two-pane diff (VS Code extension changes view).
   */
  async getSessionFileAtBase(id: string, path: string): Promise<{ exists: boolean; content: string } | null> {
    const ctx = this.sessionGitContext(id)
    if (!ctx) return null
    return getFileAtBase(ctx.cwd, path, ctx.baseRef)
  }

  // ── Change landing (desktop Changes tab: Commit / Merge back / Create PR) ──

  /**
   * Stage and commit everything in the session's cwd (worktree for isolated
   * sessions, shared cwd otherwise). Server-direct path of the dual-channel
   * design — the "let the agent commit" path goes through a normal prompt.
   */
  commitSessionChanges(id: string, message?: string): { ok: boolean; sha?: string; nothingToCommit?: boolean; error?: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cwd = s.record.worktreePath ?? this.defaultCwd
    const fallback = `rivet: ${s.record.title?.trim() || `session ${id.slice(0, 8)}`} changes`
    const result = commitAll(cwd, message?.trim() || fallback)
    if (result.ok && result.sha) {
      this.append(s, 'landing', { action: 'commit', sha: result.sha })
      this.touch(s)
    }
    return result
  }

  /**
   * Squash-merge the session's worktree branch into the main workspace's
   * current branch. Uncommitted worktree changes are committed first so the
   * squash captures the full task delta. Fail-closed on dirty main workspace
   * or conflicts (rolled back, conflict files reported).
   */
  mergeSessionBack(id: string): { ok: boolean; sha?: string; nothingToMerge?: boolean; conflictFiles?: string[]; error?: string } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    if (!s.record.worktreeBranch || !s.record.worktreePath) {
      return { ok: false, error: 'not a worktree session — nothing to merge back' }
    }
    // Sweep uncommitted work into the branch first (squash flattens it anyway).
    const checkpoint = commitAll(s.record.worktreePath, 'rivet: pre-merge checkpoint', { noVerify: true })
    if (!checkpoint.ok) return { ok: false, error: `failed to checkpoint worktree: ${checkpoint.error}` }
    const title = s.record.title?.trim() || 'session changes'
    const result = squashMergeBranch(this.defaultCwd, s.record.worktreeBranch, `${title} (rivet session ${id.slice(0, 8)})`)
    if (result.ok) {
      // Squash merges leave the branch commits unreachable from main, so
      // rev-list alone can't prove "landed". Record the branch head at merge
      // time — archive deletes the branch when it hasn't moved past this.
      s.record.landedHead = revParseHead(s.record.worktreePath)
      if (result.sha) this.append(s, 'landing', { action: 'merge_back', sha: result.sha, branch: s.record.worktreeBranch })
      this.touch(s)
      this.persistRecord(s)
    }
    return result
  }

  /**
   * Push the session's worktree branch and open a PR via `gh pr create`.
   * Uncommitted changes are checkpoint-committed first.
   */
  async createSessionPr(id: string, title?: string, body?: string): Promise<{ ok: boolean; url?: string; error?: string } | null> {
    const s = this.sessions.get(id)
    if (!s) return null
    if (!s.record.worktreeBranch || !s.record.worktreePath) {
      return { ok: false, error: 'not a worktree session — create PRs from an isolated worktree session' }
    }
    const checkpoint = commitAll(s.record.worktreePath, 'rivet: pre-PR checkpoint', { noVerify: true })
    if (!checkpoint.ok) return { ok: false, error: `failed to checkpoint worktree: ${checkpoint.error}` }
    const pushed = pushBranch(s.record.worktreePath, s.record.worktreeBranch)
    if (!pushed.ok) return { ok: false, error: `git push failed: ${pushed.error}` }
    const result = await createPr(s.record.worktreePath, {
      title: title?.trim() || s.record.title?.trim(),
      body: body?.trim() || `Created from Rivet session ${id.slice(0, 8)}.`,
    })
    if (result.ok && result.url) {
      this.append(s, 'landing', { action: 'pr_created', url: result.url, branch: s.record.worktreeBranch })
      this.touch(s)
    }
    return result
  }

  /** Expose defaultCwd for routes that need the repo root (e.g. gh CLI). */
  getDefaultCwd(): string {
    return this.defaultCwd
  }

  /**
   * Mount an EXTENDED-layer tool onto the session's agent (workflow auto-mount).
   * Returns the mount status, or undefined if the session/agent lacks enableTool
   * (lightweight doubles). No-op if gating is off (tool already visible).
   */
  async enableTool(id: string, name: string): Promise<{ status: string; cacheImpact: string } | undefined> {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const agent = await this.ensureAgentAsync(session)
    return agent.enableTool?.(name)
  }

  /**
   * Hot-inject MCP (or other late-discovered) tools into every session that
   * already has a live ManagedAgent. Sessions without an agent yet will pick
   * tools up at ensureAgent → buildSessionStores via getAllTools(). Idempotent:
   * ToolRegistry.register is Map.set overwrite.
   */
  injectMcpTools(tools: Tool[]): void {
    if (!tools.length) return
    for (const s of this.sessions.values()) {
      if (!s.agent || s.record.archived) continue
      try {
        s.agent.registerExternalTools?.(tools)
      } catch {
        /* best-effort per session — one failure must not block others */
      }
    }
  }

  // ── E4 client tool delegation ──────────────────────────────────────────

  /**
   * Register (or heartbeat) client landing capabilities. Later registrant
   * replaces the prior slot. Returns false when the session is missing.
   */
  registerDelegateCapabilities(
    id: string,
    clientId: string,
    kinds: DelegateKind[],
  ): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const cid = clientId.trim()
    if (!cid) return false
    const valid = kinds.filter(isDelegateKind)
    s.delegateCapabilities = {
      clientId: cid,
      kinds: new Set(valid),
      expiresAt: this.now() + DELEGATE_CAPABILITY_TTL_MS,
    }
    return true
  }

  /**
   * Clear capabilities for a clientId (SSE teardown). Also fail-backs any
   * in-flight PendingDelegation with null so tool-pipeline resumes locally.
   * If clientId is omitted, clears whatever slot is present.
   */
  clearDelegateCapabilities(id: string, clientId?: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const slot = s.delegateCapabilities
    if (!slot) return false
    if (clientId && slot.clientId !== clientId) return false
    s.delegateCapabilities = undefined
    // Fail-back in-flight landings — client is gone.
    for (const [rid, pend] of [...s.pendingDelegations]) {
      s.pendingDelegations.delete(rid)
      if (pend.timer) clearTimeout(pend.timer)
      pend.resolve(null)
    }
    return true
  }

  /** Whether the session currently has a live capability for `kind`. */
  hasDelegateCapability(id: string, kind: DelegateKind): boolean {
    const s = this.sessions.get(id)
    if (!s?.delegateCapabilities) return false
    const slot = s.delegateCapabilities
    if (slot.expiresAt <= this.now()) {
      s.delegateCapabilities = undefined
      return false
    }
    return slot.kinds.has(kind)
  }

  /**
   * Resolve a pending delegation with a client result. Returns false if the
   * request is gone (already timed out / fail-backed).
   */
  answerDelegation(id: string, requestId: string, result: ClientDelegateResult): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const pend = s.pendingDelegations.get(requestId)
    if (!pend) return false
    s.pendingDelegations.delete(requestId)
    if (pend.timer) clearTimeout(pend.timer)
    pend.resolve({
      content: typeof result.content === 'string' ? result.content : '',
      isError: result.isError === true,
      uiContent: typeof result.uiContent === 'string' ? result.uiContent : undefined,
      status: result.status === 'rejected' ? 'rejected' : result.status === 'ok' ? 'ok' : undefined,
    })
    return true
  }

  /**
   * Hang a landing step for the client. Returns null immediately when no live
   * capability matches (tool-pipeline fails back to local). Otherwise emits
   * `tool_delegate` and waits for answerDelegation / timeout→null.
   */
  private requestToolDelegate(
    session: InternalSession,
    lifecycleGeneration: number,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<ClientDelegateResult | null> {
    if (!isDelegateKind(kind)) return Promise.resolve(null)
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) {
      return Promise.resolve(null)
    }
    const slot = session.delegateCapabilities
    if (!slot || slot.expiresAt <= this.now() || !slot.kinds.has(kind)) {
      if (slot && slot.expiresAt <= this.now()) session.delegateCapabilities = undefined
      return Promise.resolve(null)
    }
    const timeoutMs = DELEGATE_TIMEOUT_MS[kind]
    const requestId = randomId()
    const deadlineMs = this.now() + timeoutMs
    return new Promise<ClientDelegateResult | null>((resolve) => {
      const pend: PendingDelegation = {
        requestId,
        kind,
        resolve,
        timer: setTimeout(() => {
          if (!session.pendingDelegations.delete(requestId)) return
          // Timeout → null (fail-back). NOT an error — agent never sees it.
          resolve(null)
        }, timeoutMs),
      }
      if (typeof pend.timer?.unref === 'function') pend.timer.unref()
      session.pendingDelegations.set(requestId, pend)
      this.append(session, 'tool_delegate', {
        requestId,
        kind,
        payload: payload as unknown as DelegatePayload,
        deadlineMs,
      })
    })
  }

  /**
   * Resolve a pending approval. Returns false if the request is gone.
   * An optional `editedInput` lets the human tweak the tool input
   * (e.g. per-hunk edit picks) before it runs — flows through ApprovalResult.
   * (Intent is now a non-blocking timeline note and has no pending state.)
   */
  /**
   * Label an approval that would widen the write/read boundary to a directory
   * outside the workspace, so the UI can offer "remember this directory". Absent
   * for every other approval — the checkbox must not appear where remembering
   * has no meaning.
   */
  private pathGrantHint(
    cwd: string,
    name: string,
    input: Record<string, unknown>,
  ): { dir: string; mode: 'read' | 'write' } | undefined {
    if (name === 'request_path_access') {
      const p = typeof input.path === 'string' ? input.path.trim() : ''
      return p ? { dir: p, mode: input.mode === 'write' ? 'write' : 'read' } : undefined
    }
    const need = outOfWorkspaceFilePaths(cwd, name, input)
    const first = need?.paths[0]
    return need && first ? { dir: dirname(first), mode: need.mode } : undefined
  }

  answerIntervention(
    id: string,
    requestId: string,
    decision: string,
    editedInput?: Record<string, unknown>,
    remember?: boolean,
  ): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    const pend = s.pending.get(requestId)
    if (!pend) return false
    s.pending.delete(requestId)
    if (pend.timer) clearTimeout(pend.timer)

    const approved = decision === 'approve' || decision === 'approved'
    const result: ApprovalResult = { approved }
    if (approved && editedInput && typeof editedInput === 'object') {
      result.editedInput = editedInput
    }
    // Out-of-workspace path approvals read this to persist the directory grant
    // per-workspace. Computer Use keeps its own grant store (below) — the two
    // remember semantics are independent, so both consume the same flag.
    if (approved && remember === true) result.remember = true
    pend.resolve(result)
    if (!approved) s.lastApprovalDeniedAt = this.now()
    // Computer Use "always allow": approve + remember records a machine-level
    // per-app grant so future actions on this app skip the prompt entirely
    // (the tool's requiresApproval consults the same grant store).
    let rememberedApp: string | undefined
    if (approved && remember === true && pend.toolName === 'computer_use') {
      const app = pend.toolInput?.app
      if (typeof app === 'string' && app.trim()) {
        try {
          grantComputerUseApp(app.trim())
          rememberedApp = app.trim()
        } catch { /* grant persistence is best-effort — approval still resolves */ }
      }
    }
    this.recountApprovals(s)
    this.append(s, 'approval_resolved', {
      requestId,
      decision: approved ? 'approve' : 'reject',
      edited: !!result.editedInput,
      ...(rememberedApp ? { rememberedApp } : {}),
    })
    this.touch(s)
    this.persistRecord(s)
    return true
  }

  /** List background jobs for a session. undefined = session missing. */
  listJobs(id: string): import('../tools/job-store.js').JobSnapshot[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.jobs?.list() ?? []
  }

  /** Full captured output of a background job. undefined = session/job missing. */
  getJobLogs(id: string, jobId: string): string | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return s.jobs?.logs(jobId) ?? undefined
  }

  /** Terminate a background job. Returns false when session/job is missing. */
  killJob(id: string, jobId: string): boolean {
    const s = this.sessions.get(id)
    if (!s || !s.jobs) return false
    return s.jobs.kill(jobId)
  }

  listArtifacts(id: string): Artifact[] | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    // Rehydrated/idle sessions have no live agent — read the artifact log
    // straight off disk (index + raw files survive a sidecar restart).
    if (!s.agent) return this.rehydratedArtifactStore(s).list()
    return s.agent.listArtifacts()
  }

  readArtifact(id: string, artifactId: string): Promise<string | null> | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) return this.rehydratedArtifactStore(s).readRaw(artifactId)
    return s.agent.readArtifact(artifactId)
  }

  /**
   * Build (once) a read-only ArtifactStore over the session's persisted
   * artifact directory. Mirrors the layout the live AgentLoop writes:
   * `<cwd>/.rivet/artifacts/<sessionId>`. Construction is cheap and never
   * throws on a missing directory (loadIndex no-ops), so an idle session with
   * no artifacts simply yields an empty list.
   */
  private rehydratedArtifactStore(s: InternalSession): ArtifactStore {
    if (!s.rehydratedArtifacts) {
      const artifactDir = join(s.record.cwd, '.rivet', 'artifacts')
      s.rehydratedArtifacts = new ArtifactStore(artifactDir, s.record.id)
    }
    return s.rehydratedArtifacts
  }

  /**
   * List user messages that can be rewound to. Each entry has the message
   * index (for use with rewind()), the text content, and the event timestamp
   * (derived from the session event log, since OaiMessage has no ts field).
   * Sessions without a live agent (rehydrated after sidecar restart) get one
   * lazily built — issue #63: the desktop's edit-save ("保存并重发") resolves
   * rewind points from this list, and an empty list made every edit fail on
   * history sessions. Build failure (cwd removed / config invalid) degrades to
   * the old empty list — the client toasts the resolve error.
   */
  async listRewindPoints(id: string): Promise<{ index: number; content: string; timestamp: number; seq?: number }[] | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (!s.agent) {
      try { await this.ensureAgentAsync(s) } catch { return [] }
    }
    const agent = s.agent
    if (!agent) return []
    const msgs = agent.getMessages()
    // Collect user events (seq + ts + text) so we can map each user message to
    // both its submission time AND the seq of its originating `user` event. The
    // seq lets the UI anchor previews/forks on the exact `u-${seq}` block the
    // rewind reducer will cut at — same anchor rewind() emits as anchorSeq.
    // 全历史读取(Phase 2):磁盘直读越过内存环截尾——早于环底的 user 事件也能
    // 拿到 seq/ts 锚点,不再退化为 timestamp=0 + 客户端文本启发。
    const { events } = (await this.getAllEventsAsync(id)) ?? { events: [] as SessionEvent[] }
    const userEvents: { seq: number; ts: number; text: string }[] = []
    for (const e of events) {
      if (e.type === 'user') {
        userEvents.push({ seq: e.seq, ts: e.ts, text: String((e.data as { text?: unknown }).text ?? '') })
      }
    }
    const entries: { index: number; content: string; timestamp: number; seq?: number }[] = []
    // 只产出能对上 `user` 事件的条目（配对规则见 buildUserAnchors）：hook 注入
    // 的独立 user 消息没有事件，用户消息里追加的注入段靠剥离后缀救回。混入
    // 无锚点的条目会把桌面端的「序数降级」顶偏——points 与 blocks 的 user 块
    // 同序是那条降级路径的前提，破掉它编辑重发就切到错误的消息索引
    // （issue #63 残留：用户点「保存并重发」后消息错位/丢失）。
    // content 用事件原文：前端 blocks 里的 user 文本就是事件文本，两者逐字节
    // 相等，rewind 事件的 prompt 回退匹配才认得出来。
    for (const [index, anchor] of buildUserAnchors(msgs, userEvents)) {
      entries.push({ index, content: anchor.text, timestamp: anchor.ts, seq: anchor.seq })
    }
    return entries
  }

  /**
   * `user` 事件列表（seq/ts/原文），rewind 锚点解析用。内存环被截尾（首事件
   * seq > 1）时改读磁盘全量——长会话的早期 user 事件不在环里，只按环配对会
   * 让 anchorSeq 静默缺失（前端退到文本回退，prompt 也只能靠剥离注入兜底）。
   * rewind 是低频人工操作，同步读一次的代价可接受；读失败退回环。
   */
  private userEventListFor(s: InternalSession): { seq: number; ts: number; text: string }[] {
    const ringTrimmed = s.events.length > 0 && s.events[0]!.seq > 1
    let src: SessionEvent[] = s.events
    const p = this.persistence
    if (ringTrimmed && p?.loadEvents) {
      try {
        src = p.loadEvents.call(p, s.record.id)
      } catch {
        src = s.events
      }
    }
    return src
      .filter((e) => e.type === 'user')
      .map((e) => ({ seq: e.seq, ts: e.ts, text: String((e.data as { text?: unknown }).text ?? '') }))
  }

  /**
   * Rewind a session to a prior message index. Truncates the agent's message
   * list, appends a `rewind` event to the event log (append-only — old events
   * are NOT deleted, so reconnecting clients can see the rewind marker), and
   * optionally rolls back files via the existing checkpoint system.
   *
   * Safety: rejects if session is `running` (caller must abort first).
   */
  rewind(id: string, messageIndex: number, options?: { rollbackFiles?: boolean }): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.running) return false
    if (!s.agent) return false
    this.ensureEvents(s)

    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return false

    const target = msgs[messageIndex]!
    const rawPrompt = typeof target.content === 'string' ? target.content : ''

    // Resolve a duplicate-proof UI anchor with the same pairing the desktop
    // resolves its rewind points with (buildUserAnchors): the seq of the `user`
    // event that produced this rewound message. 旧的序数取法（第 N 条 user 消息
    // → 第 N 个 user 事件）在 hook 注入独立 user 消息时会整体偏移，全等文本
    // 匹配又会因注入追加必然落空——两条都会让 anchorSeq 缺失。
    // prompt 同步换成事件原文：桌面端 event-reducer 在没有 anchorSeq 时按
    // prompt 文本回退匹配 blocks，含注入的 content 匹配不上 → 界面不截断
    // （用户看到的正是「保存并重发没反应」，issue #63 残留）。
    const anchor = buildUserAnchors(msgs, this.userEventListFor(s)).get(messageIndex)
    const prompt = anchor?.text ?? stripInjectedSuffix(rawPrompt)
    const anchorSeq = anchor?.seq

    // Truncate messages to the selected point (full derived-state reset).
    s.agent.rewindToMessages(msgs.slice(0, messageIndex))
    s.agent.resetAppendixBaseline?.()

    // Update session status: rewind returns the session to idle so the user
    // can send a new prompt. Previous status (completed/failed) is stale.
    s.record.status = 'idle'
    s.record.error = undefined

    // Append rewind event (append-only — viewers see the marker).
    this.append(s, 'rewind', {
      messageIndex,
      prompt,
      ...(anchorSeq !== undefined ? { anchorSeq } : {}),
      timestamp: this.now(),
    })

    // Optional file rollback via existing checkpoint system.
    if (options?.rollbackFiles) {
      void this.rollbackFiles(s)
    }

    return true
  }

  /** Best-effort file rollback for rewind. Surfaces result via event log. */
  private async rollbackFiles(session: InternalSession): Promise<void> {
    try {
      const { getRollbackPreview, rollbackToCheckpoint, makeOwnershipGuard } = await import('../agent/checkpoint.js')
      const registry = this.getRegistry?.()
      const guard = registry
        ? makeOwnershipGuard(registry, session.record.id, session.record.cwd)
        : undefined
      const preview = await getRollbackPreview(session.record.cwd, session.record.id, guard)
      if (preview) {
        await rollbackToCheckpoint(session.record.cwd, preview.confirmationToken, session.record.id, guard)
      }
    } catch {
      // checkpoint rollback is best-effort; rewind still succeeds on messages
    }
  }

  /**
   * Preview the files a precise (per-message) code rewind would touch. Returns
   * `available: false` when the session has no live agent / FileHistory or no
   * tracked edits after the boundary — the caller can then fall back to the
   * coarse checkpoint rollback (which also covers bash-driven changes).
   */
  previewFilesPrecise(
    id: string,
    messageIndex: number,
  ): { available: boolean; files: { path: string; action: 'restore' | 'delete' | 'unreadable' }[] } | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    const fh = s.agent?.getFileHistory?.()
    if (!s.agent || !fh) return { available: false, files: [] }
    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return { available: false, files: [] }
    const ids = collectPostBoundaryEditIds(msgs, messageIndex)
    const files = fh.getBoundaryFiles(ids)
    return { available: files.length > 0, files }
  }

  /**
   * Precise (per-message) code rewind: restore every agent-edited file to its
   * content as of the selected message; delete files created after it. Does NOT
   * truncate the conversation (that's the separate rewind() path). Rejects while
   * running (unsafe to restore files under an active writer).
   */
  async rewindFilesPrecise(
    id: string,
    messageIndex: number,
  ): Promise<{ success: boolean; filesChanged: string[] } | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (s.running) return { success: false, filesChanged: [] }
    const fh = s.agent?.getFileHistory?.()
    if (!s.agent || !fh) return { success: false, filesChanged: [] }
    const msgs = s.agent.getMessages()
    if (messageIndex < 0 || messageIndex >= msgs.length) return { success: false, filesChanged: [] }
    const ids = collectPostBoundaryEditIds(msgs, messageIndex)
    const filesChanged = await fh.rewindToBoundary(ids)
    return { success: true, filesChanged }
  }

  // ── internals ─────────────────────────────────────────────────

  /**
   * T4 — emit a structured per-worker delegation update to the subagent panel.
   * Extracted from buildCallbacks so the idle user-dispatch path (delegate())
   * can reuse the exact same mapping/elapsed logic. Extra fields beyond the
   * core status: `summary` (terminal digest for the "汇入主会话" adopt button),
   * `origin` ('user' marks a user-dispatched worker), plus the live-activity
   * passthrough (toolUseCount/tokenCount/eventKind/eventDetail) and terminal
   * `failureReason` so the desktop panel can render counters + failure labels.
   */
  private emitDelegationActivity(
    session: InternalSession,
    a: {
      workOrderId: string
      parentToolId?: string
      dispatchId?: string
      attemptId?: string
      parentAttemptId?: string
      /** 嵌套委派的父 worker order id（顶层委派缺省）。 */
      parentWorkerId?: string
      profile?: string
      authority?: string
      /** Why this authority was chosen (from DelegationActivity.authorityReason). */
      authorityReason?: string
      objective?: string
      status: string
      progressLine?: string
      toolUseCount?: number
      tokenCount?: number
      eventKind?: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'turn' | 'retry' | 'lifecycle'
      eventDetail?: string
      failureReason?: string
      model?: string
      provider?: string
      usage?: DelegationActivity['usage']
      artifactId?: string
      changedFiles?: string[]
      summary?: string
      origin?: 'user' | 'agent'
      contract?: DelegationActivity['contract']
      findingsCount?: number
      topFinding?: string
      verificationBrief?: DelegationActivity['verificationBrief']
      evidenceStatus?: string
    },
  ): void {
    const startedMap = session.delegationStartedAt ?? (session.delegationStartedAt = new Map())
    const attemptKey = a.attemptId ?? (a.dispatchId ? `${a.dispatchId}:${a.workOrderId}` : a.workOrderId)
    let started = startedMap.get(attemptKey)
    if (started === undefined) {
      started = this.now()
      startedMap.set(attemptKey, started)
    }
    this.append(session, 'delegation', {
      workerId: a.workOrderId,
      parentId: a.parentToolId,
      dispatchId: a.dispatchId,
      attemptId: a.attemptId,
      parentAttemptId: a.parentAttemptId,
      // 嵌套委派的真实父 worker（parentId 是工具调用 id，只够挂到工具卡下；
      // 层级树渲染要靠这个字段）。
      parentWorkerId: a.parentWorkerId,
      profile: a.profile,
      // authority 与命中理由一并透传（此前 authority 接收后未转发，桌面端拿不到）；
      // 桌面舰队面板显示 worker 星域/理由时直接可用。
      authority: a.authority,
      authorityReason: a.authorityReason,
      objective: a.objective,
      status: a.status,
      phase: a.status === 'running' ? 'running' : a.status,
      progressLine: a.progressLine ? redactText(a.progressLine) : undefined,
      elapsedMs: this.now() - started,
      toolUseCount: a.toolUseCount,
      tokenCount: a.tokenCount,
      eventKind: a.eventKind,
      eventDetail: a.eventDetail ? redactText(a.eventDetail) : undefined,
      failureReason: a.failureReason,
      model: a.model,
      provider: a.provider,
      usage: a.usage,
      artifactId: a.artifactId,
      changedFiles: a.changedFiles,
      summary: a.summary ? redactText(a.summary) : undefined,
      origin: a.origin,
      // 契约投影 + 终态证据摘要（Phase 1 字段；完整 findings 走 getWorkerLog pull）。
      contract: a.contract,
      findingsCount: a.findingsCount,
      topFinding: a.topFinding ? redactText(a.topFinding) : undefined,
      verificationBrief: a.verificationBrief,
      evidenceStatus: a.evidenceStatus,
    })
    if (a.status !== 'running') startedMap.delete(attemptKey)
  }

  private buildCallbacks(session: InternalSession): AgentCallbacks {
    const lifecycleGeneration = session.lifecycleGeneration
    const isActive = (): boolean => this.ownsSessionLifecycle(session, lifecycleGeneration)
    // plan 工具 action=submit 的 toolId 登记（onToolUse 写入 / onToolResult 消费）。
    // 携带 slug+title（onPlanSubmitted 同款 slugify 推导）：emitPlanSubmitted 直接
    // 用确定 slug 发卡，不再从磁盘 plans[0] 顶替——多会话共享 cwd 时 plans[0]
    // 可能是别会话的更新计划，审批卡因此发错/丢失（2026-07-25 修复）。
    const planSubmitToolIds = new Map<string, { slug: string; title: string }>()
    return {
      onDomainResolved: (resolved) => {
        if (!isActive()) return
        const knownDomain = starDomainRegistry.get(resolved.key)
        const eventPayload: ResolvedDomainRecord = {
          key: redactText(resolved.key),
          name: truncateUtf16Safe(redactText(resolved.name), 160),
          matchedKeywords: resolved.matchedKeywords
            .slice(0, 3)
            .map((keyword) => truncateUtf16Safe(redactText(keyword), 80)),
          reason: resolved.reason,
        }
        if (session.record.domain === 'auto' && knownDomain) {
          session.record.resolvedDomain = {
            ...eventPayload,
            key: knownDomain.id,
            name: eventPayload.name || knownDomain.name,
          }
        }
        this.append(session, 'domain_resolved', { ...eventPayload })
        this.persistRecord(session)
      },
      onDomainDrift: (drift) => {
        if (!isActive()) return
        this.append(session, 'domain_drift', {
          currentId: redactText(drift.currentId),
          currentName: truncateUtf16Safe(redactText(drift.currentName), 160),
          recommendedId: redactText(drift.recommendedId),
          recommendedName: truncateUtf16Safe(redactText(drift.recommendedName), 160),
          matchedKeywords: drift.matchedKeywords
            .slice(0, 4)
            .map((keyword) => truncateUtf16Safe(redactText(keyword), 80)),
        })
      },
      onTextDelta: (text) => {
        if (!isActive()) return
        this.flushToolResultBuf(session)
        session.toolResultStream = undefined
        this.bufferDelta(session, 'text_delta', text)
      },
      onThinkingDelta: (thinking) => {
        if (!isActive()) return
        this.flushToolResultBuf(session)
        session.toolResultStream = undefined
        this.bufferDelta(session, 'thinking_delta', thinking)
      },
      onToolUse: (toolId, name, input) => {
        if (!isActive()) return
        this.append(session, 'tool_use', { id: toolId, name, input: redactValue(input) })
        // plan 工具 action=submit 的调用登记——onToolResult 没有 input，靠这里的
        // toolId 集合在结果回调里精确识别"提交成功"，避免 plan 其它 action
        //（enter_mode/close/list）误发 plan_submitted。title 一并登记：submit 的
        // slug = slugify(title)（src/tools/plan.ts 同款推导），供 emitPlanSubmitted
        // 发确定 slug 的卡。省略 plan 字段从草稿提交时 title 仍必填，推导恒成立。
        if (name === 'plan' && (input as { action?: string } | null)?.action === 'submit') {
          const title = (input as { title?: unknown } | null)?.title
          if (typeof title === 'string' && title.trim()) {
            planSubmitToolIds.set(toolId, { slug: slugify(title), title: title.trim() })
          } else {
            planSubmitToolIds.set(toolId, { slug: '', title: '' })
          }
        }
        // N3: surface delegation as a tree node, derived from the tool stream
        // (no core-loop rewrite — stays inside the server layer).
        if (DELEGATION_TOOLS.has(name)) {
          this.append(session, 'delegation', {
            workerId: toolId,
            toolName: name,
            taskCount: delegationTaskCount(name, input),
            objective: extractObjective(input),
            profile: typeof input.profile === 'string' ? input.profile : undefined,
            status: 'running',
          })
        }
        // T2: surface the active task list as structured state for the desktop
        // checklist (Codex-style active todo / Antigravity Task Plan).
        if (name === 'todo') {
          const items = extractTodoState(input)
          if (items) this.append(session, 'todo_state', { items })
        }
        // 结构化提问卡片：ask_user_question 的 input 直接携带全部问题/选项，
        // 在 tool_use 时机发 user_question SSE（工具本身只回占位符 + endTurn）。
        // 答案不走新 API —— 桌面卡片把选择组装成普通用户消息回传。
        if (name === 'ask_user_question') {
          const questions = parseAskUserQuestions(input)
          if (questions.length > 0) {
            this.append(session, 'user_question', {
              toolUseId: toolId,
              questions: questions.map(q => ({
                id: q.id,
                prompt: redactText(q.prompt),
                options: q.options.map(o => redactText(o)),
                allowMultiple: q.allowMultiple,
              })),
            })
          }
        }
      },
      onToolResult: (toolId, name, result, isError, _rawPath, uiContent) => {
        // Agent callbacks can already be queued when archive/delete closes the
        // session. Reject both stream and terminal callbacks before watchdog,
        // persistence, delegation, plan, or artifact side effects.
        if (!isActive() || session.toolResultClosed) return
        // 终态才计进度单元；isError === undefined 是流式 chunk（TUI 侧同款过滤，
        // 否则单次长输出工具就能伪装稀疏 stall）。
        if (isError !== undefined) session.watchdogPolicy?.recordToolResult()
        const eventData = {
          id: toolId,
          name,
          isError: !!isError,
          result: isError === undefined
            ? redactText(result)
            : truncateUtf16Safe(redactText(result), 2000),
          // uiContent is the display override (e.g. ask_user_question renders the
          // question + numbered options here, not the model-facing placeholder).
          // Team panel frames encode rich structured data — raise the cap to 8K
          // so multi-task wave DAGs aren't truncated before the desktop decodes them.
          ...(uiContent
            ? { uiContent: truncateUtf16Safe(redactText(uiContent), containsRegisteredFrame(uiContent) ? 8000 : 2000) }
            : {}),
        }
        if (isError === undefined) {
          this.bufferToolResult(session, toolId, name, eventData.result)
          return
        }
        this.flushToolResultBuf(session)
        session.toolResultStream = undefined
        this.append(session, 'tool_result', eventData)
        if (DELEGATION_TOOLS.has(name)) {
          this.append(session, 'delegation', {
            workerId: toolId,
            status: isError ? 'failed' : 'completed',
          })
        }
        // Plan mode — a successful `plan action=submit` wrote a new .rivet/plans/*.md.
        // Surface it as an event so the desktop's plan column refreshes live.
        // （2026-07-24 断链修复：旧检查匹配已废弃的工具名 plan_submit，合并后的
        // 工具名为 plan、靠 onToolUse 登记的 toolId 精确识别 submit action。）
        const submittedPlan = planSubmitToolIds.get(toolId)
        planSubmitToolIds.delete(toolId)
        if (!isError && submittedPlan) {
          void this.emitPlanSubmitted(session, lifecycleGeneration, submittedPlan)
        }
        // Plan mode — while planning, write_file/edit_file can only touch the
        // active draft (checkPlanMode gates every other path), so a successful
        // final write means the draft grew. Emit a throttled invalidation
        // signal — this replaces the desktop's 2s draft polling as the primary
        // liveness channel (polling stays as a degraded fallback).
        if (
          isError === false
          && session.record.planMode === 'planning'
          && (name === 'write_file' || name === 'edit_file')
        ) {
          this.schedulePlanDraftEvent(session, lifecycleGeneration)
        }
        // P0-2: plan_task 成功写入了 todos → 发 todo_state 让桌面 TodoDock 刷新
        if (name === 'plan_task' && isError === false) {
          const items = session.agent?.getTodos?.()
          if (items && items.length > 0) this.append(session, 'todo_state', { items })
        }
        this.scanArtifacts(session)
      },
      onTurnComplete: (usage, turnNumber, isFinal, evidenceSummary, continuationReason) => {
        if (!isActive()) return
        session.watchdogPolicy?.recordTurnComplete()
        this.append(session, 'turn_complete', {
          usage,
          turnNumber,
          isFinal: !!isFinal,
          ...(isFinal && evidenceSummary ? { evidence: evidenceSummary } : {}),
          ...(typeof continuationReason === 'string' && continuationReason ? { continuationReason } : {}),
        })
      },
      onError: (err) => {
        if (!isActive()) return
        this.append(session, 'error', { error: redactText(err.message) })
      },
      onAbort: (reason) => {
        if (!isActive()) return
        session.lastAbortReason = reason
        // 在 finally 的 rejectAllPending 清场之前捕获审批挂起态。
        session.abortWhileApprovalPending =
          [...session.pending.values()].some((p) => p.kind === 'approval')
        if (session.record.status === 'running') session.record.status = 'aborted'
      },
      onCheckpoint: (hash) => {
        if (!isActive()) return
        this.append(session, 'checkpoint', { hash })
      },
      onPhaseChange: (phase, detail) => {
        if (!isActive()) return
        session.record.currentPhase = phase
        this.append(session, 'phase', { phase, ...detail })
      },
      // R5 — structured course-correction → its own event so the desktop can
      // render a "改道" card inline (selective externalization of star-domain).
      onDecisionShift: (shift: DecisionShift) => {
        if (!isActive()) return
        this.append(session, 'decision_shift', {
          source: shift.source,
          domain: shift.domain,
          reason: redactText(shift.reason),
          methods: (shift.methods ?? []).map((m) => redactText(m)),
          severity: shift.severity ?? 'info',
        })
      },
      onApprovalRequired: (toolId, name, input) =>
        this.requestApproval(session, lifecycleGeneration, toolId, name, input),
      // E4 — client landing delegation (mirrors onApprovalRequired injection).
      onToolDelegate: (kind, payload) =>
        this.requestToolDelegate(session, lifecycleGeneration, kind, payload),
      onIntentNote: (intent) => {
        if (!isActive()) return
        this.emitIntentNote(session, intent)
      },
      // T3 — drain mid-run user guidance at the tool boundary (the agent appends
      // it to the last tool_result; see tool-execution.ts). The buffer is fed by
      // POST /sessions/:id/steer while the session is running.
      // Phase 1.3 — 送达可观测：drain 出非空内容时写 steer_delivered（count 为
      // 本次 drain 条数），UI 据此把回声卡片标记为「模型已收」。drain 返回值
      // 不带条数——先按 pending 计数（无 maxPriority 的 drain 必清空全部
      // pending，计数即本次条数）。仍仅在 isActive() 时 drain，语义不变。
      onSteerDrain: () => {
        if (!isActive()) return null
        const count = session.steer.getPendingEntries().length
        const drained = session.steer.drain()
        if (drained !== null && count > 0) {
          this.append(session, 'steer_delivered', { count })
        }
        return drained
      },
      // C3 — 自治档检查点：cruise 暂停（paused=true，桌面渲染确认卡片）；
      // unleashed 无此回调（无刹车无播报）。digest 为进度摘要。
      onAutonomyCheckpoint: (info) => {
        if (!isActive()) return
        this.append(session, 'autonomy_checkpoint', {
          turns: info.turns,
          digest: info.digest,
          paused: info.paused,
        })
      },
      // T4 — structured per-worker delegation status/progress → subagent panel.
      // Keyed by workOrderId (distinct from the spawning tool id, which is the
      // delegation-tree parent). Emitted alongside the existing text stream.
      onDelegationActivity: (a) => {
        if (!isActive()) return
        this.emitDelegationActivity(session, a)
      },
    }
  }

  private requestApproval(
    session: InternalSession,
    lifecycleGeneration: number,
    toolId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ApprovalResult> {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) {
      return Promise.resolve({ approved: false })
    }
    // 无人值守（auto-proceed 定时任务）：审批请求不挂起等人 — fail-closed。
    // 立即拒绝该工具调用，把中止原因写进事件流，并中止本次运行（绝不静默
    // 跳过、也不无限期等待）。走查工件经 agent 侧 postTool 记录同一拒绝。
    if (session.unattended) {
      const requestId = toolId || randomId()
      const appName = typeof input.app === 'string' && input.app ? input.app : undefined
      const app = appName ? ` (app: ${appName})` : ''
      const reason = `unattended run blocked on approval: ${name}${app}`
      session.unattendedHaltReason ??= reason
      // 结构化留存缺授权的 app 名：修复闭环（补授权 → 一键重跑）不用解析文本。
      if (session.unattendedHaltApp === undefined && appName) session.unattendedHaltApp = appName
      // record.error 让会话列表/桌面通知不用扒事件流就能拿到中止原因。
      session.record.error ??= reason
      // 结构化标记：让侧栏/Inbox 不解析 error 文本就能识别"无人值守停机"
      // 并区别于一般失败（Wave 4 halt 可见化的数据源）。
      session.record.unattendedHalt ??= { reason, ...(appName ? { app: appName } : {}) }
      this.append(session, 'approval_required', { requestId, toolName: name, input: redactValue(input) })
      this.append(session, 'approval_resolved', { requestId, decision: 'unattended_blocked' })
      this.append(session, 'unattended_halt', { requestId, toolName: name, reason })
      session.lastApprovalDeniedAt = this.now()
      this.persistRecord(session)
      // 拒绝先返回（让 agent 收到 deny 的 tool_result 并被走查记录），下一拍中止运行。
      setImmediate(() => {
        if (this.ownsSessionLifecycle(session, lifecycleGeneration)) {
          this.abort(session.record.id)
        }
      })
      return Promise.resolve({ approved: false })
    }
    return new Promise<ApprovalResult>((resolve) => {
      const requestId = toolId || randomId()
      const pend: PendingIntervention = {
        requestId,
        kind: 'approval',
        resolve: resolve as (v: ApprovalResult | boolean) => void,
        toolName: name,
        toolInput: input,
      }
      if (this.approvalTimeoutMs > 0) {
        pend.timer = setTimeout(() => {
          if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) {
            session.pending.delete(requestId)
            resolve({ approved: false })
            return
          }
          if (session.pending.delete(requestId)) {
            resolve({ approved: false })
            session.lastApprovalDeniedAt = this.now()
            this.recountApprovals(session)
            this.append(session, 'approval_resolved', { requestId, decision: 'timeout' })
            this.persistRecord(session)
          }
        }, this.approvalTimeoutMs)
      }
      session.pending.set(requestId, pend)
      this.recountApprovals(session)
      const pathGrant = this.pathGrantHint(session.record.cwd, name, input)
      this.append(session, 'approval_required', {
        requestId,
        toolName: name,
        input: redactValue(input),
        ...(pathGrant ? { pathGrant } : {}),
      })
      // Persist the pendingApprovals count NOW — if the sidecar dies while
      // blocked on this approval, rehydrate() uses the on-disk count as the
      // gate for scanning the log and closing the approval out honestly.
      this.persistRecord(session)
    })
  }

  /**
   * Goal 模式计划倒计时自动批准（2026-07-24，C2 watchdog 刹车同构）。
   * 计划提交待批时若 goal 激活：发 plan_auto_approve_pending（含 deadlineMs）并
   * 开可取消定时器——goal 是用户显式选择的自治场景，被不可见的审批门卡死与
   * 自治初衷相悖；非 goal 会话不武装（approval 是质量门，保持纯手动审批）。
   * 窗口内用户任何参与（approve/reject/edit/prompt/steer/abort/显式路由）即取消。
   */
  private maybeArmPlanAutoApprove(session: InternalSession, slug: string): void {
    // 完全读写档（skip）：审批零打扰承诺——计划提交即自动批准，不等 goal、
    // 不等倒计时（plan.ts 的「请在此等待」对 skip 会话是 0 秒）。生效档位：
    // 会话级 override 优先，否则全局档（构造快照 + PUT 广播实时更新）。
    const liveSkip = (session.approvalMode ?? this.globalApprovalMode) === 'dangerously-skip-permissions'
    const delayMs = liveSkip ? 0 : this.goalPlanAutoApproveMs
    // 注意：goalPlanAutoApproveMs 的 0 = 关闭（纯手动）；skip 档的 0 = 立即批准。
    // 两者共用 delayMs 但语义不同——关闭守卫只对 goal 路径生效。
    if (!liveSkip && delayMs <= 0) return
    if (!liveSkip) {
      if (!this.isGoalActive(session)) return
      // P1b fail-closed：客户端无自动批准倒计时 UI 时不武装定时器
      if (!session.planAutoApproveUi) return
    }
    this.cancelPlanAutoApprove(session, 'superseded')
    const deadlineMs = this.now() + delayMs
    session.planAutoApproveSlug = slug
    this.append(session, 'plan_auto_approve_pending', { slug, deadlineMs, delayMs })
    const timer = setTimeout(() => {
      session.planAutoApproveTimer = undefined
      session.planAutoApproveSlug = undefined
      if (!this.ownsSessionDurability(session)) return
      // 触发前复核守卫：期间用户可能已驱动新 run / 归档 / 取消 goal
      //（skip 档下 goal 无关，不参与复核）。
      if (session.running || session.record.archived) return
      if (!liveSkip && !this.isGoalActive(session)) return
      void this.approvePlan(session.record.id, slug).then((outcome) => {
        if (!outcome.ok) {
          this.append(session, 'plan_auto_approve_cancelled', { slug, reason: outcome.reason })
        }
      })
    }, delayMs)
    timer.unref?.()
    session.planAutoApproveTimer = timer
  }

  /** 取消倒计时自动批准（有 slug 才发事件——避免对未武装会话发空 cancel）。 */
  private cancelPlanAutoApprove(session: InternalSession, reason: string): void {
    const slug = session.planAutoApproveSlug
    if (session.planAutoApproveTimer) clearTimeout(session.planAutoApproveTimer)
    session.planAutoApproveTimer = undefined
    session.planAutoApproveSlug = undefined
    if (slug) this.append(session, 'plan_auto_approve_cancelled', { slug, reason })
  }

  /** 显式取消路由（桌面「查看计划」按钮）：用户对计划表现出参与即停止自动批准。 */
  cancelPlanAutoApproveForUser(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.cancelPlanAutoApprove(session, 'user')
    return true
  }

  private isGoalActive(session: InternalSession): boolean {
    const tracker = this.resolveGoalHandles?.(session.record.id)?.goalTrackerRef.current
      ?? session.agent?.getGoalTracker?.()
      ?? null
    return tracker?.isActive() === true
  }

  /**
   * run 收尾后的 queue lane flush（2026-09-11，方案 A）。
   *
   * lane 唯一消费点是下次 run 入口的归并——「下次 prompt 时归并」假设用户总会
   * 再发一条；打断/不再发言场景下条目永躺 lane（死信）。收尾后主动开新一轮消费，
   * 排队语义回到「本轮结束后执行」。
   * 让位：watchdog stall（lastAbortReason 前缀）跳过——其续跑自身归并 lane，抢跑
   * 会让 watchdog 见 running 放弃；已有新 run/已归档/会话已替换同样跳过。
   * merged 标记与 queue_status echo 走 mergeQueuedIntoPrompt 同一路径。
   */
  private scheduleQueueLaneFlush(session: InternalSession): void {
    if (session.lastAbortReason?.startsWith('watchdog')) return
    setImmediate(() => {
      try {
        if (this.sessions.get(session.record.id) !== session) return
        if (session.record.archived) return
        if (session.running || session.activeRunSettlement) return
        if (session.record.status === 'running') return
        if (!session.queueLane.some((e) => e.status === 'queued')) return
        // 传空 prompt 取归并文本；run 入口会再 merge 一次（lane 已空，no-op）。
        const merged = this.mergeQueuedIntoPrompt(session, '').trimEnd()
        if (!merged) return
        this.run(session.record.id, merged)
      } catch {
        // best-effort：flush 失败不回滚已 merged 的 lane（文本已 echo 在流中、
        // 用户可见），也不向收尾路径抛错。
      }
    })
  }

  /**
   * Watchdog stall 自动恢复（桌面端对齐 TUI v3）：run settle 后判定是否注入
   * 'continue'。必须经 setImmediate 延迟——给排队中的用户 HTTP 动作（run/archive）
   * 让路，执行前复核会话仍处 aborted 且无人抢跑（TUI「让位守卫」的桌面对应物）。
   *
   * C2 刹车：决定续跑后不再立即重发——先追加带 pendingAutoContinue+delayMs 的
   * watchdog_recovery 事件（桌面渲染倒计时卡片），倒计时结束复核守卫再续跑。
   * 窗口内用户 abort（置 watchdogRecoveryCancelled）或发新 prompt（run() 清
   * 定时器）都能取消——「Loop 续跑刹不住」的修复点。
   */
  private maybeWatchdogAutoContinue(session: InternalSession): void {
    const reason = session.lastAbortReason
    if (!reason?.startsWith('watchdog')) return
    const policy = session.watchdogPolicy
    if (!policy) return
    const suppressed = session.abortWhileApprovalPending === true
      || (session.lastApprovalDeniedAt != null
          && this.now() - session.lastApprovalDeniedAt < WATCHDOG_APPROVAL_GRACE_MS)
    setImmediate(() => {
      if (!this.ownsSessionDurability(session)) return
      // 让位守卫：用户已重新驱动（running）、状态被改（非 aborted）、已归档，
      // 或用户在窄窗口内 abort 过 → 放弃续跑。
      if (session.running || session.record.status !== 'aborted' || session.record.archived) return
      if (session.watchdogRecoveryCancelled) return
      const decision = policy.onStall({ suppressed })
      const delayMs = this.watchdogContinueDelayMs
      this.append(session, 'watchdog_recovery', {
        reason,
        autoContinue: decision.autoContinue,
        ...(decision.stopReason ? { stopReason: decision.stopReason } : {}),
        ...(decision.autoContinue ? { dense: decision.dense === true, pendingAutoContinue: true, delayMs } : {}),
        ...policy.snapshot(),
      })
      if (!decision.autoContinue) return
      const timer = setTimeout(() => {
        session.watchdogContinueTimer = undefined
        if (!this.ownsSessionDurability(session)) return
        // 倒计时后复核同一组守卫——期间用户可能已 abort / 提交新 prompt / 归档。
        if (session.running || session.record.status !== 'aborted' || session.record.archived) return
        if (session.watchdogRecoveryCancelled) return
        session.watchdogAutoResubmit = true
        if (!this.run(session.record.id, 'continue')) session.watchdogAutoResubmit = false
      }, delayMs)
      timer.unref?.()
      session.watchdogContinueTimer = timer
    })
  }

  /**
   * Non-blocking direction note: append a passive timeline event and return.
   * The agent never waits — there is no pending Promise/timer. The user steers
   * by typing (POST /sessions/:id/steer) if they want to change direction.
   */
  private emitIntentNote(session: InternalSession, intent: IntentPreview): void {
    const copy = describeIntentNote(intent)
    this.append(session, 'intent_note', {
      summary: intent.summary,
      confidence: intent.confidence,
      warnings: intent.warnings ?? [],
      title: copy.title,
      reasons: copy.reasons,
      action: copy.action,
      steerHint: copy.steerHint,
    })
  }

  private rejectAllPending(session: InternalSession, reason: string): void {
    if (session.pending.size > 0) session.lastApprovalDeniedAt = this.now()
    for (const [requestId, pend] of session.pending) {
      if (pend.timer) clearTimeout(pend.timer)
      pend.resolve({ approved: false })
      this.append(session, 'approval_resolved', { requestId, decision: reason })
    }
    session.pending.clear()
    this.recountApprovals(session)
  }

  private recountApprovals(session: InternalSession): void {
    let count = 0
    for (const p of session.pending.values()) if (p.kind === 'approval') count++
    session.record.pendingApprovals = count
  }

  /**
   * After a plan_submit tool result, emit a `plan_submitted` event for the plan
   * that was JUST submitted. The slug comes from the onToolUse registration
   * (slugify(title), same derivation as the submit tool) — never `plans[0]`:
   * with several sessions sharing one cwd, the newest plan on disk may belong
   * to another session (or be an older APPROVED one), which used to send the
   * wrong card or no card at all (desktop clears non-submitted cards), leaving
   * the model waiting on an approval the user never sees. The known slug is
   * verified against disk (status/title authoritative); plans[0] stays only as
   * a fallback when registration had no usable title. Async/best-effort: the
   * tool already persisted the file, so a read failure here only delays the
   * live refresh, not the data.
   */
  private async emitPlanSubmitted(
    session: InternalSession,
    lifecycleGeneration: number,
    known?: { slug: string; title: string },
  ): Promise<void> {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
    try {
      const plans = await this.loadPlans(session.record.cwd)
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      const knownHit = known?.slug ? plans.find((p) => p.slug === known.slug) : undefined
      if (known?.slug && !knownHit) {
        // 登记的 slug 未落盘（极端：写入被外部撤销）——按成功提交的事实发卡，
        // 标题用登记值，状态按 submitted（与工具回执一致）。
        this.append(session, 'plan_submitted', { slug: known.slug, title: known.title, status: 'submitted' })
        this.maybeArmPlanAutoApprove(session, known.slug)
        return
      }
      const target = knownHit ?? plans[0]
      if (target) {
        this.append(session, 'plan_submitted', {
          slug: target.slug,
          title: target.title,
          status: target.status,
        })
        // goal 激活时武装倒计时自动批准（非 goal 会话纯手动审批）
        if (target.status === 'submitted') this.maybeArmPlanAutoApprove(session, target.slug)
      }
    } catch {
      // non-fatal — the desktop can still poll GET /plans
    }
  }

  /**
   * Throttled `plan_draft` scheduler. Leading edge fires immediately; writes
   * inside the window arm ONE trailing timer so the final write of a burst
   * always lands an event (a plain leading-edge throttle would leave the
   * desktop stale until its fallback poll).
   */
  private schedulePlanDraftEvent(session: InternalSession, lifecycleGeneration: number): void {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
    if (
      session.planDraftTimer !== undefined
      && session.planDraftTimerGeneration !== lifecycleGeneration
    ) {
      this.cancelPlanDraftTimer(session)
    }
    const now = this.now()
    const elapsed = now - (session.planDraftLastEmit ?? 0)
    if (elapsed >= PLAN_DRAFT_THROTTLE_MS) {
      session.planDraftLastEmit = now
      void this.emitPlanDraft(session, lifecycleGeneration)
      return
    }
    if (session.planDraftTimer !== undefined) return
    const timer = this.planEventScheduler.setTimeout(() => {
      if (session.planDraftTimer !== timer) return
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      session.planDraftTimer = undefined
      session.planDraftTimerGeneration = undefined
      session.planDraftLastEmit = this.now()
      void this.emitPlanDraft(session, lifecycleGeneration)
    }, PLAN_DRAFT_THROTTLE_MS - elapsed)
    session.planDraftTimer = timer
    session.planDraftTimerGeneration = lifecycleGeneration
    const unrefTimer = timer as { unref?: () => void }
    unrefTimer?.unref?.()
  }

  /**
   * Emit the `plan_draft` signal. Persistence / in-memory ring store metadata
   * only (path/title/size) so events.jsonl stays small. Connected SSE listeners
   * receive the same seq with `content` attached when the draft is under
   * PLAN_DRAFT_LIVE_CONTENT_MAX — desktop PlanPanel can paint without GET.
   */
  private async emitPlanDraft(session: InternalSession, lifecycleGeneration: number): Promise<void> {
    if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
    if (session.record.planMode !== 'planning') return
    try {
      const draft = await this.readPlanDraft(session.record.id)
      if (!this.ownsSessionLifecycle(session, lifecycleGeneration)) return
      if (!draft) return
      const meta: Record<string, unknown> = {
        path: draft.path,
        title: draft.title,
        size: draft.content.length,
      }
      const live: Record<string, unknown> =
        draft.content.length <= PLAN_DRAFT_LIVE_CONTENT_MAX
          ? { ...meta, content: draft.content }
          : meta
      this.append(session, 'plan_draft', live, { persistData: meta })
    } catch {
      // non-fatal — the desktop's fallback poll still refreshes the draft
    }
  }

  private scanArtifacts(session: InternalSession): void {
    if (!session.agent) return
    let list: Artifact[]
    try {
      list = session.agent.listArtifacts()
    } catch {
      return
    }
    for (const art of list) {
      if (session.knownArtifacts.has(art.id)) continue
      session.knownArtifacts.add(art.id)
      this.append(session, 'artifact', {
        id: art.id,
        tool: art.tool,
        target: art.target,
        summary: art.summary,
        charCount: art.charCount,
        lineCount: art.lineCount,
      })
    }
  }

  /**
   * Delta 合并（Wave 2）：provider 逐 token 回调 → 窗口内合并成一条规范事件。
   * 首个 delta（每个 run 起始 / 非 delta 事件之后）立即落，保首 token 延迟；
   * 后续进入 40ms / 2KB 窗口。类型切换（text↔thinking）先 flush 保序。
   * 合并后的事件是唯一事件——单 seq、同一条持久化 + fan-out 路径，重放语义不变。
   */
  private bufferDelta(session: InternalSession, type: 'text_delta' | 'thinking_delta', text: string): void {
    if (!text || !this.ownsSessionDurability(session)) return
    if (session.deltaBuf && session.deltaBuf.type !== type) {
      this.flushDeltaBuf(session)
      session.deltaRunActive = false
    }
    if (!session.deltaRunActive) {
      session.deltaRunActive = true
      this.appendRaw(session, type, { text })
      return
    }
    if (session.deltaBuf) session.deltaBuf.text += text
    else session.deltaBuf = { type, text }
    if (session.deltaBuf.text.length >= DELTA_COALESCE_MAX_CHARS) {
      this.flushDeltaBuf(session)
      return
    }
    if (!session.deltaTimer) {
      session.deltaTimer = setTimeout(() => {
        session.deltaTimer = undefined
        this.flushDeltaBuf(session)
      }, DELTA_COALESCE_MS)
      session.deltaTimer.unref?.()
    }
  }

  /** 把残留的 delta 缓冲落成事件。幂等；空缓冲为 no-op。 */
  private flushDeltaBuf(session: InternalSession): void {
    if (session.deltaTimer) {
      clearTimeout(session.deltaTimer)
      session.deltaTimer = undefined
    }
    const buf = session.deltaBuf
    if (!buf) return
    session.deltaBuf = undefined
    this.appendRaw(session, buf.type, { text: buf.text })
  }

  /**
   * Coalesce contiguous streaming tool_result callbacks. A tool-id switch is an
   * ordering boundary: flush the prior tool before exposing the new one.
   */
  private bufferToolResult(session: InternalSession, id: string, name: string, result: string): void {
    if (!result || session.toolResultClosed) return
    this.flushDeltaBuf(session)
    session.deltaRunActive = false
    const current = session.toolResultStream
    if (current && (current.id !== id || current.name !== name)) {
      this.flushToolResultBuf(session)
      session.toolResultStream = undefined
    }
    const stream = session.toolResultStream ?? (session.toolResultStream = {
      id,
      name,
      buffered: '',
      active: false,
    })
    if (!stream.active) {
      stream.active = true
      const first = takeUtf8Prefix(result, TOOL_RESULT_COALESCE_BYTES)
      // partial: true 标记流式进度 chunk（区别于终态 result）。SSE 层 isError
      // 恒为布尔，事件流必须自描述，否则客户端把每个 chunk 当独立结果渲染
      //（delegate_batch 十几行重复工具行的成因）。终态 append 不带此字段。
      this.appendRaw(session, 'tool_result', { id, name, isError: false, partial: true, result: first.head })
      stream.buffered = first.tail
    } else {
      stream.buffered += result
    }
    while (Buffer.byteLength(stream.buffered) >= TOOL_RESULT_COALESCE_BYTES) {
      const chunk = takeUtf8Prefix(stream.buffered, TOOL_RESULT_COALESCE_BYTES)
      stream.buffered = chunk.tail
      this.appendRaw(session, 'tool_result', {
        id: stream.id,
        name: stream.name,
        isError: false,
        partial: true,
        result: chunk.head,
      })
    }
    if (stream.buffered && session.toolResultTimer === undefined) {
      const sessionId = session.record.id
      session.toolResultTimer = this.toolResultScheduler.setTimeout(() => {
        session.toolResultTimer = undefined
        if (session.toolResultClosed || this.sessions.get(sessionId) !== session) {
          session.toolResultStream = undefined
          return
        }
        this.flushToolResultBuf(session)
      }, TOOL_RESULT_COALESCE_MS)
      const timer = session.toolResultTimer as { unref?: () => void }
      timer?.unref?.()
    }
  }

  private flushToolResultBuf(session: InternalSession): void {
    if (session.toolResultTimer !== undefined) {
      this.toolResultScheduler.clearTimeout(session.toolResultTimer)
      session.toolResultTimer = undefined
    }
    const stream = session.toolResultStream
    if (!stream?.buffered) return
    const result = stream.buffered
    stream.buffered = ''
    this.appendRaw(session, 'tool_result', {
      id: stream.id,
      name: stream.name,
      isError: false,
      partial: true,
      result,
    })
  }

  private cancelToolResultBuf(session: InternalSession): void {
    if (session.toolResultTimer !== undefined) {
      this.toolResultScheduler.clearTimeout(session.toolResultTimer)
      session.toolResultTimer = undefined
    }
    session.toolResultStream = undefined
  }

  /**
   * 统一事件入口。非 delta 事件先冲掉 delta 缓冲再落自身，保证事件顺序——
   * abort（收尾 append status，L abort()）、turn 完成、错误路径全部自动覆盖，
   * 无需在各中断触发点单独挂钩子。
   *
   * `opts.persistData` — when set, the in-memory ring + events.jsonl store this
   * payload while SSE listeners receive `data` (e.g. plan_draft live content).
   */
  private append(
    session: InternalSession,
    type: SessionEventType,
    data: Record<string, unknown>,
    opts?: { persistData?: Record<string, unknown> },
  ): void {
    if (!this.ownsSessionDurability(session)) return
    // 无进展哨兵打点（stall-observer）：事件落盘 = 回合进展。回合死锁时
    // jsonl 停止写入 → 此 touch 停止 → 观察器 90s 后告警并指认最后事件。
    touchActivity(session.record.id, `evt:${type}`)
    if (type !== 'tool_result') {
      this.flushToolResultBuf(session)
      session.toolResultStream = undefined
    }
    if (type !== 'text_delta' && type !== 'thinking_delta') {
      this.flushDeltaBuf(session)
      session.deltaRunActive = false
    }
    this.appendRaw(session, type, data, opts)
  }

  private appendRaw(
    session: InternalSession,
    type: SessionEventType,
    liveData: Record<string, unknown>,
    opts?: { persistData?: Record<string, unknown> },
  ): void {
    if (!this.ownsSessionDurability(session)) return
    const persistData = opts?.persistData ?? liveData
    const stored: SessionEvent = { seq: ++session.seq, ts: this.now(), type, data: persistData }
    session.events.push(stored)
    if (session.events.length > this.maxEvents) {
      session.events = trimEventRing(session.events, this.maxEvents)
    }
    session.record.lastSeq = session.seq
    session.record.updatedAt = stored.ts
    if (this.persistence) {
      try {
        this.persistence.appendEvent(session.record.id, stored)
      } catch {
        // persistence failure must not break the live event log
      }
    }
    const forListeners: SessionEvent =
      persistData === liveData ? stored : { ...stored, data: liveData }
    for (const listener of session.listeners) {
      try {
        listener(forListeners)
      } catch {
        // a misbehaving viewer must not break the event log
      }
    }
  }

  private persistRecord(session: InternalSession): void {
    if (!this.persistence || !this.ownsSessionDurability(session)) return
    try {
      this.persistence.saveRecord({ ...session.record })
    } catch {
      // non-fatal — events.jsonl is the source of truth for replay
    }
  }

  /**
   * Decode user-attached image data URLs and persist each as a file, returning
   * the generated ids. Best-effort: a malformed URL or persistence gap is
   * skipped (the model still gets the inline image; only its thumbnail is lost).
   */
  private persistImages(sessionId: string, images?: string[]): string[] {
    if (!images?.length || !this.persistence?.saveImage) return []
    const ids: string[] = []
    for (const url of images) {
      const parsed = parseImageDataUrl(url)
      if (!parsed) continue
      const imgId = randomId()
      try {
        this.persistence.saveImage(sessionId, imgId, parsed.base64, parsed.mime)
        ids.push(imgId)
      } catch {
        // non-fatal — skip this thumbnail, keep the rest
      }
    }
    return ids
  }

  /** Read a persisted user image (for the GET image route). */
  readImage(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined {
    return this.persistence?.readImage?.(sessionId, imgId)
  }

  private touch(session: InternalSession): void {
    session.record.updatedAt = this.now()
  }
}

function randomId(): string {
  // CSPRNG：会话/请求 id 可见于路由路径——时间戳+Math.random（≈41 位熵）
  // 可预测，若未来任一路由把「知道 id」当授权即成漏洞。长度与旧格式相近，
  // 保留日期前缀便于人工排查。
  return new Date().toISOString().slice(0, 10).replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 12)
}

/** Phase 2 — queue lane 条目归并进新 prompt 时 lane 部分的小节头。 */
const QUEUE_LANE_MERGE_HEADER = '[排队跟进 — 上轮运行期间排队，请一并处理]'

/** Parse a `data:image/<mime>;base64,<payload>` URL. Returns null if malformed. */
function parseImageDataUrl(url: string): { mime: string; base64: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url)
  if (!m) return null
  return { mime: m[1]!.toLowerCase(), base64: m[2]! }
}

/**
 * Normalize persisted domain selection and optional Auto-resolution metadata.
 * Unknown/deleted selections fail open to Auto; malformed or stale resolutions
 * are removed so the next run can route normally.
 */
function sanitizeSessionDomain(record: SessionRecord): SessionRecord {
  const raw = record as Omit<SessionRecord, 'domain' | 'resolvedDomain'> & {
    domain?: unknown
    resolvedDomain?: unknown
  }
  const rawDomain = typeof raw.domain === 'string' ? raw.domain : 'auto'
  const selection = resolveDomainState(rawDomain)
  const normalizedDomain = selection?.key ?? 'auto'
  const { domain: _domain, resolvedDomain: _resolvedDomain, ...rest } = record
  const base: SessionRecord = { ...rest, domain: normalizedDomain }

  // Resolution metadata is meaningful only for a canonical persisted Auto
  // selection. Unknown/deleted domains and legacy aliases fail open and must
  // reroute instead of inheriting a stale resolution.
  if (raw.domain !== 'auto' || normalizedDomain !== 'auto') return base
  const resolvedDomain = sanitizeResolvedDomainRecord(raw.resolvedDomain)
  return resolvedDomain ? { ...base, resolvedDomain } : base
}

function sanitizeResolvedDomainRecord(value: unknown): ResolvedDomainRecord | undefined {
  if (typeof value === 'string') {
    const definition = starDomainRegistry.get(value)
    if (!definition) return undefined
    return {
      key: definition.id,
      name: truncateUtf16Safe(definition.name, 160),
      matchedKeywords: [],
      reason: 'fallback',
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.key !== 'string'
    || candidate.key.length === 0
    || candidate.key.length > 128
  ) return undefined
  const definition = starDomainRegistry.get(candidate.key)
  if (!definition) return undefined
  const name = typeof candidate.name === 'string' && candidate.name.trim()
    ? truncateUtf16Safe(redactText(candidate.name), 160)
    : truncateUtf16Safe(definition.name, 160)
  const matchedKeywords = Array.isArray(candidate.matchedKeywords)
    ? candidate.matchedKeywords
        .filter((keyword): keyword is string => typeof keyword === 'string')
        .slice(0, 3)
        .map((keyword) => truncateUtf16Safe(redactText(keyword), 80))
    : []
  return {
    key: definition.id,
    name,
    matchedKeywords,
    reason: candidate.reason === 'keyword' ? 'keyword' : 'fallback',
  }
}

/**
 * Resolve a star-domain selection KEY into the live tri-state + canonical key +
 * display label. Mirrors AgentLoop.getSessionDomain semantics:
 *  - 'auto' → state undefined (per-message auto-detect)
 *  - 'off'  → legacy alias, resolves to auto (state undefined)
 *  - <id>   → the ActiveStarDomain, when the id is a known domain
 * Returns null for an unknown key so callers can 400/return false.
 */
function resolveDomainState(
  key: string,
): { state: ActiveStarDomain | null | undefined; key: string; label: string } | null {
  if (key === 'auto') return { state: undefined, key: 'auto', label: 'Auto' }
  // Legacy: the 'off' selection was removed. Old persisted sessions with
  // domain:'off' resolve to Auto instead of breaking (state undefined, not null).
  if (key === 'off') return { state: undefined, key: 'auto', label: 'Auto' }
  const d = starDomainRegistry.get(key)
  if (!d) return null
  return {
    state: { id: d.id as StarDomainId, name: d.name, volatileBlock: d.volatileBlock, motto: d.motto, courageThreshold: d.courageThreshold },
    key: d.id,
    label: d.name,
  }
}

function resolveDomainPersona(key: string | undefined): { glyph: string; accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim' } {
  // 'off' removed; treat legacy value as Auto for persona rendering.
  if (key === 'auto' || key === 'off' || key === undefined) return { glyph: '⚙', accent: 'primary' }
  const d = starDomainRegistry.get(key)
  if (!d) return { glyph: '⚙', accent: 'primary' }
  return { glyph: d.uiPersona.glyph, accent: d.uiPersona.accent }
}
