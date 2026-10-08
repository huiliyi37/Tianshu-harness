/**
 * Desktop ↔ sidecar wire protocol — the SINGLE definition of the session
 * contract shared by both sides.
 *
 * - The sidecar (src/server/session-manager.ts and friends) re-exports these
 *   types, so all server code keeps importing from session-manager as before.
 * - The desktop re-exports them from desktop/src/runtime/types.ts via a
 *   relative TYPE-ONLY import, giving the frontend compile-time drift
 *   protection (previously the two sides were kept in sync by comment
 *   convention only).
 *
 * HARD CONSTRAINT: this module must stay a dependency-free LEAF (no imports,
 * not even type imports). The desktop's typecheck follows every import in its
 * graph — one careless `import type` from an agent/server module here would
 * drag half the runtime into the frontend's type graph.
 */

/**
 * Wire protocol version — bump on BREAKING changes to this contract
 * (removing/renaming events or fields, changing payload semantics).
 * Additive changes (new optional fields, new event types the client can
 * ignore) do NOT bump. The sidecar reports it in GET /health
 * (`protocolVersion`); the desktop compares against its own compiled-in
 * value and shows a mismatch warning instead of failing silently.
 */
export const PROTOCOL_VERSION = 1

/**
 * 运行时能力表 —— `GET /health` 的 `capabilities` 字段（issue #266 的环境面）。
 *
 * 为什么不是「版本号 ≥ x」：桌面端与 sidecar 是**可分开升级**的两个实体（Windows
 * 分头打包、updater 撤包、远程 sidecar 都会让两边错配），而版本阈值要靠前端硬编码
 * 「哪个版本引入了哪个接口」——猜错的症状就是「点了没反应」。改成运行时**自报**它
 * 能处理什么：前端只问能力，不问版本。
 *
 * 加性字段：新增能力**不** bump PROTOCOL_VERSION；老运行时缺 `capabilities` 时，
 * 前端回退到版本比较（见 desktop/src/lib/runtime-capabilities.ts 的
 * SCHEDULE_PATCH_MIN_VERSION）。本文件同时被桌面端 type-only 引用，两侧不会漂移。
 */
export interface RuntimeCapabilities {
  /** `PATCH /schedule/:id` —— 自动化定义的原地更新（#236 起，见 3.24.0）。 */
  requestLookup?: boolean
  schedulePatch: boolean
}

/** 本构建实际具备的能力：加能力 = 这里加一行 `true`。 */
export const RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  schedulePatch: true,
  requestLookup: true,
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'

/**
 * S — autonomy level. Canonical wire definition; the agent runtime re-exports
 * it from src/agent/loop-types.ts.
 */
export interface ApprovalRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  pathGrant?: { dir: string; mode: 'read' | 'write' }
}

/** Current, live interventions; lastSeq fences older approval replay. */
export interface ApprovalSnapshot {
  approvals: ApprovalRequest[]
  lastSeq: number
}

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

/**
 * Plan mode — read-only planning vs normal execution. Canonical wire
 * definition; the runtime re-exports it from src/agent/plan-mode.ts.
 */
export type PlanModeState = 'off' | 'planning'

/**
 * Ask mode — read-only Q&A (Cursor Ask). Canonical wire definition;
 * the runtime re-exports it from src/agent/ask-mode.ts.
 */
export type AskModeState = 'off' | 'asking'

// `turn_complete` data 的可选 additive 字段：
//  · `continuationReason`（中间 turn 之后系统注入提醒并自动续轮的原因，如
//    'obligation-verification'）。desktop 用它区分「给用户的消息」与
//    「给系统提醒的自检回复」；旧 sidecar 不携带时行为不变。
//  · `aborted: true`（2026-09-23）——中断 / 看门狗中止收尾的**补发**快照。
//    被打断的 run 走不到 natural-finish，其 usage 只能由 onAbort 路径补一条
//    isFinal=false 的累计快照；否则桌面端输入框的缓存命中率永远停在上一个
//    跑完的 run 上（实测有会话 29 条 turn_complete 全是 isFinal=false）。
//  · `contextTokens: number`（2026-09-23）——本轮结束时的上下文实时占用
//    （getEstimatedTokens = getRealOccupancy，与会话记录 enrichment 同源）。
//    记录侧只在下拉/push 时现算，长 run 中途环形图百分比最多落后 30s；带上
//    它之后桌面端百分比与缓存计数同频。旧客户端忽略该字段。
//  · `stopReason: 'max_tokens'`（2026-10-05）——本轮流式因输出 token 上限被截断
//    （finish_reason 'length' 归一而来）时携带；桌面/TUI 据此渲染「发『继续』可续」
//    提醒（dsh 式，截断内容保留在历史里，不自动续写）。正常 end_turn 不携带。
export type SessionEventType =
  | 'context_budget'
  | 'user'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'turn_complete'
  | 'phase'
  // Zen Mode（禅模式）相位镜像：data: { phase:'zen'|'full', reason?, armed,
  // zenTurns }。run 开始与每次晋升各发一次。桌面端已订阅（2026-09-14 接入）：
  // 实时事件在 desktop/src/state/event-reducer.ts 折叠为相位徽章，重连由 /stream
  // 建连补发（见 SessionRecord.zenPhaseMirror）；TUI 徽章另走 zenBadgeProvider
  // 回调，不经过此事件。
  | 'zen_phase'
  | 'checkpoint'
  | 'approval_required'
  | 'approval_resolved'
  | 'approval_snapshot'
  // E4 — client tool delegation (apply_edit / terminal_exec). data: ToolDelegateEventData.
  | 'tool_delegate'
  | 'intent_note'
  | 'delegation'
  | 'artifact'
  | 'status'
  // data: { error, scope?, kind?, guidance? }。guidance（2026-10-05 additive）=
  // errorRecoveryGuidance 的「下一步」中文指引——此前只有 TUI 渲染，桌面 error 块
  // 只有类别标签 + 原文；AbortError（用户动作）不携带。
  | 'error'
  | 'decision_shift'
  | 'rewind'
  // P1-1 — 桌面端会话分叉：子会话时间线插一条「从 X 分叉而来」标记，
  // data: { forkedFromId, forkedFromTurnSeq?, anchorPrompt, destination }。
  // 只写子会话日志，源会话事件流保持不动（append-only 语义与 rewind 一致）。
  | 'fork'
  // T2 — structured active task list (mirrors the `todo` tool's write payload).
  | 'todo_state'
  // T3 — mid-run user guidance accepted into the steer buffer.
  | 'steer_queued'
  // Phase 1.3 — steer 内容在工具边界实际注入模型的送达回执。data: { count }，
  // count 为本次 drain 的条数。UI 据此把回声卡片标记为「模型已收」。
  | 'steer_delivered'
  // Phase 2 queue lane — busy 期间排队跟进消息：入队 echo（data: { laneId, text }）
  // 与状态迁移（data: { laneId, status: 'steered'|'retracted'|'merged' }）。
  | 'queue_pending'
  | 'queue_status'
  // Plan mode — state toggle (off|planning) + a plan was submitted to disk.
  | 'plan_mode'
  | 'plan_submitted'
  // Goal 模式计划倒计时自动批准 — 武装（含 deadlineMs）/ 取消（含 reason）。
  | 'plan_auto_approve_pending'
  | 'plan_auto_approve_cancelled'
  // Ask mode — read-only Q&A toggle (off|asking); mutually exclusive with plan_mode.
  | 'ask_mode'
  // Plan mode — the agent grew the active draft (throttled invalidation signal;
  // metadata only, the desktop re-fetches the body via GET /plans).
  | 'plan_draft'
  // Structured ask_user_question payload → desktop question card (Cursor-style).
  | 'user_question'
  // PlusMenu — per-session model / star-domain / skill selection changes.
  | 'model_switched'
  | 'domain_changed'
  | 'domain_resolved'
  | 'domain_usage'
  | 'domain_drift'
  | 'skills_changed'
  // I4 — user-defined .rivet/hooks.json script results.
  | 'hook_result'
  // Background jobs (bash run_in_background) — started / output / exit.
  | 'job'
  | 'done'
  // Watchdog stall auto-recovery (桌面端对齐 TUI v3) — 续跑决策可观测。
  | 'watchdog_recovery'
  // Change landing — commit / squash merge-back / PR created from the Changes tab.
  | 'landing'
  // C3 自治档检查点 — run 在 N 轮后暂停等待用户确认（continue 恢复）。
  | 'autonomy_checkpoint'
  // 付费版 v1 · T2 — 无人值守运行被审批门禁 fail-closed 中止。
  | 'unattended_halt'
  // Phase 3 可靠性 — sidecar 重启打断了在途 run，向 UI 提供一键续跑入口。
  // data: { model: string|null, domain: string } — 续跑必须沿用原模型/星域
  // （前缀缓存亲和）；模型不可用时由 POST /resume fail-closed。
  | 'resume_offer'
  | 'recovery_status'
  // 阶段 2 恢复 — 模型请求中断后本轮重试（按尝试替换）。data: { attempt,
  // maxAttempts, replaceAttempt: true, category?, message?, nextDelayMs? }。
  // 桌面端据此丢弃失败尝试的未完成 partial（否则与重试输出重复），只留一条
  // 「未完成/重试」标记；category/nextDelayMs（2026-10-05 additive）让重试块
  // 说清「为什么断、等多久」；旧版 UI 忽略即可。
  | 'retry'
  // /handoff 归档完成 — 交接 run 收尾时项目内 .rivet/HANDOFF.md 已拷贝归档到
  // 会话目录 <id>.handoff.md（loadPrevHandoff 注入管线认的位置）。
  // data: { text: string, src: string, dest: string }。旧版 UI 忽略即可。
  | 'handoff_archived'
  // Goal 上下文接力（goal-rollover.ts）— 交接发起 / 新会话已接棒 / 中止原因。
  // data: GoalRolloverView。旧版 UI 忽略即可。
  | 'goal_rollover'
  // Goal mode — autonomous cross-turn goal tracker state change (created /
  // paused / resumed / cancelled / criteria-extracted / verdict-updated).
  // data: GoalSnapshot (see session-manager). The desktop GoalBar polls or
  // consumes this via SSE to render 🎯 goal + iteration + controls.
  | 'goal_state'
  // 冷热双通道（会话历史回放持久化）— /stream 回放最前发出的合成元事件，
  // 不落盘、不入内存环、seq 恒为 0。data: { floorSeq, diskFirstSeq,
  // diskLastSeq } — diskFirstSeq < floorSeq 时前端显示「加载更早的历史」，
  // 经 GET /events?before= 分页直读磁盘回填被内存环截掉的头部。
  | 'replay_window'
  // 后台任务建连快照 — /stream 回放最前发出的合成事件（同 replay_window：
  // 不落盘、不入内存环、seq 恒为 0）。data: { jobs: JobSnapshot[] }，内容为
  // 服务端注册表当前仍 running 的任务全集。内存环截尾会丢掉长寿 job 的
  // started 事件、sidecar 重启后注册表更是全空——前端据此 upsert 并摘除
  // 本地仍 running 但服务端已消失的任务（重启悬挂对账）。
  | 'job_snapshot'
  | 'delegation_snapshot'

export interface SessionEvent {
  runId?: string
  attemptId?: string
  seq: number
  ts: number
  type: SessionEventType
  data: Record<string, unknown>
}

export interface ResolvedDomainRecord {
  key: string
  name: string
  matchedKeywords: string[]
  reason: 'keyword' | 'fallback'
}

/**
 * Zen Mode（禅模式）相位镜像——SessionRecord 与 `zen_phase` 事件的共用形状。
 * 'zen' = 主控工具面收窄到读面（读专注开局）；'full' = 全量工具面。
 *
 * reason 刻意用宽 string 而非窄联合：本文件是零依赖 leaf，不引 agent 层的
 * ZenPromoteReason；未知值由消费端兜底，加新晋升通道不必改协议。
 *
 * 用 type 而非 interface（本文件其余契约都是 interface）：只有 type alias 与匿名
 * 对象类型带隐式 index signature，interface 没有——写成 interface 就赋不进
 * `append(session, type, data: Record<string, unknown>)`，也无法直接当
 * Record 传给归一函数。
 */
export type ZenPhaseMirror = {
  phase: 'zen' | 'full'
  /** 晋升原因（'tool' | 'timeout' | 'triage' | 'user'）；arm（进入禅）时缺省。 */
  reason?: string
  /** 本会话是否 arm 过（含已晋升）；false = 禅未启用或未进入。 */
  armed: boolean
  /** 禅相位内已消耗的用户 turn 数（步长预算口径）。 */
  zenTurns: number
}

export interface ContextBudgetSnapshot {
  requestId: string
  revision: number
  sampledAt: number
  model: string
  windowTokens: number
  inputBudget: number
  inputTokens: number
  outputReserve: number
  safetyMargin: number
  imageTokens: number
  reasoningTokens: number
  toolTokens: number
  bodyBytes?: number
  measuredInputTokens?: number
  generatedTokens?: number
  source: 'estimate' | 'measured'
  state: 'ready' | 'warning' | 'compacting' | 'blocked'
}

export interface GoalRolloverView {
  id: string
  from: string
  to?: string
  phase: 'handoff' | 'ready' | 'prepared' | 'starting' | 'complete' | 'paused' | 'cancelled'
  generation: number
  maxSessions: number
  error?: string
}

export interface SessionRecord {
  workspaceRoots?: string[]
  goalRollover?: GoalRolloverView
  goalInputs?: { imageIds: string[]; documents: Array<{ id: string; name: string; bytes: number; mime: string }> }
  contextBudget?: ContextBudgetSnapshot
  persistenceState?: 'saved' | 'failed'
  durableWatermark?: number
  runId?: string
  attemptId?: string
  id: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  cwd: string
  /**
   * 工作目录的来源（issue #147）：'explicit' 用户选的目录 | 'config-default'
   * 配置的默认工作区 | 'scratch' 临时会话隔离目录 | 'runtime-default' sidecar
   * 的兜底 cwd。桌面端据此明示「这个会话的工作目录是谁定的」。
   *
   * 与 src/server/workspace.ts 的 WorkspaceSource 同构而非 import——本模块是
   * 零依赖叶子（见文件头 HARD CONSTRAINT）。两侧一致性由 session-manager 的
   * 赋值处做编译期校验（record.workspaceSource = resolveWorkspace(...).source）。
   * 旧索引文件缺该字段 → undefined（桌面端按「未标注」渲染）。
   */
  workspaceSource?: 'explicit' | 'config-default' | 'scratch' | 'runtime-default'
  title?: string
  titleSource?: 'manual' | 'generated' | 'fallback'
  titleGenerationState?: 'pending' | 'failed' | 'complete'
  titleGenerationAttempts?: number
  /** Original human input, capped for the title side path; never expanded attachment text. */
  titleInput?: string
  currentPhase?: string
  /**
   * 禅相位镜像——**建连补发**用。`zen_phase` 事件只在 run 起点 arm 与每次晋升
   * 时发，长会话里它早已滑出 /stream 的回放窗口，而重连是从 `?since=` 续读的：
   * 不补发则「切走再切回」的客户端徽章必然丢失（等下一次 run 才回来）。
   * 与 currentPhase 无关——后者是执行阶段（thinking/tool），本字段是工具面宽窄。
   * 随 record 落 index.json，sidecar 重启后经 rehydrate 的 `...rec` 自动恢复。
   */
  zenPhaseMirror?: ZenPhaseMirror
  lastSeq: number
  error?: string
  /**
   * Wave 4 — 无人值守 fail-closed 中止的结构化标记。区别于一般 error：
   * 会话在等一个人类决定（授权/接管），侧栏与 Inbox 据此渲染 halted
   * 徽标/决策卡。新 run 启动时清除。
   */
  unattendedHalt?: { reason: string; app?: string }
  pendingApprovals: number
  /** Queue entries are cancelled explicitly after restart; payloads stay in memory. */
  pendingQueueLaneIds?: string[]
  /**
   * S — per-session autonomy level. Overrides the global config approval mode
   * so one session can run unattended (dangerously-skip-permissions) while
   * another stays supervised. Absent → the agent uses the global config default.
   */
  approvalMode?: ApprovalMode
  /**
   * Plan mode — when 'planning', the agent is restricted to read-only tools and
   * is expected to call plan_submit to produce a reviewable plan. Absent/'off' →
   * normal execution. Mirrors AgentLoop.planModeState.
   */
  planMode?: PlanModeState
  /**
   * Ask mode — when 'asking', the agent is restricted to pure read-only Q&A
   * tools (no write/execute/plan/delegate). Mutually exclusive with planMode.
   * Absent/'off' → normal execution. Mirrors AgentLoop.askModeState.
   */
  askMode?: AskModeState
  /**
   * P1b（安全）— 创建会话的客户端是否具备 plan 倒计时自动批准 UI。持久化使
   * sidecar 重启后行为一致；缺省 = false（fail-closed：无可见性即不自动批准）。
   */
  planAutoApproveUi?: boolean
  /**
   * PlusMenu — current provider model id for this session (the resolved model
   * id, not an alias). Absent → the global default. Surfaced in the model picker
   * and persisted so a reconnecting viewer sees the live model.
   */
  model?: string
  /**
   * PlusMenu — star-domain selection KEY ('auto' | <domainId>; legacy 'off'
   * persists but resolves to auto). Stored
   * as the round-trippable key (not a display name) so rehydrate can restore the
   * live ActiveStarDomain. Absent → 'auto'.
   */
  domain?: string
  /**
   * First resolved Auto domain display payload. This is restoration-only
   * metadata: `domain` remains `auto`, and this value never enters prompts,
   * messages, or frozen snapshots. Unknown ids are discarded during rehydrate.
   */
  resolvedDomain?: ResolvedDomainRecord
  /**
   * Per-session 工具白名单（蒸馏回放等自动化场景）。有值时 LLM 的工具列表
   * 收窄到这个集合（经 gateToolDefinitions 的 coreOverride 通路）。缺省 /
   * undefined = 默认全量工具集（行为不变）。空数组 = 空白名单。
   */
  allowedTools?: string[]
  /** Visual glyph for the current star-domain selection (for UI badges). */
  domainGlyph?: string
  /** Semantic accent color key for the current star-domain selection. */
  domainAccent?: string
  /** Estimated token count for the current conversation. Absent → session is idle/rehydrated. */
  contextTokens?: number
  /** Model context window size (max tokens). Absent → session is idle/rehydrated. */
  contextWindow?: number
  /** Current reasoning effort level (off/low/medium/high/max). Absent → model default. */
  reasoningEffort?: string
  /** Archived (closed) sessions are excluded from listSessions() and hidden in the desktop sidebar. */
  archived?: boolean
  /** Git worktree branch name — set when the session was created with isolated worktree. */
  worktreeBranch?: string
  /** Worktree path on disk (for cleanup on archive/close). */
  worktreePath?: string
  /** Checkout from which this session's isolated worktree was created. */
  worktreeOriginCwd?: string
  /** HEAD commit at session creation — diff baseline for the Changes tab (worktree sessions). */
  baselineHead?: string
  /** Worktree branch head at the last successful merge-back. Squash merges
   *  leave the branch commits unreachable from main, so rev-list can't tell
   *  "landed" — this marker lets archive safely delete a landed branch. */
  landedHead?: string
  /** P1 任务身份化 — 关联的 Mission id。创建 session 时按 title 自动
   *  getOrCreate（显式路径）或 maybeAutoTitle 起标题成功时隐式创建。
   *  absent → 旧 session / 未接线，桌面端回退 session.title || shortId。 */
  missionId?: string
  /**
   * P1-1 会话分叉血缘（回流自 `origin/tianshu-alpha-3.14`，桌面端 ForkDialog 与
   * 时间线「从 X 分叉」用）。`forkedFromId` 指向源会话；`forkedFromTurnSeq` 是
   * 切点 seq（messageIndex fork = 锚点 `user` 事件的 seq；header fork = 源会话
   * 最新事件的 seq，即整段复制；源无任何事件时缺省）；`forkTitleNumber` 是
   * Codex 式标题序号（首个 fork 恒为 2，`Foo (2)`）；`forkSource` 记录锚点类型。
   */
  forkedFromId?: string
  forkedFromTurnSeq?: number
  forkTitleNumber?: number
  forkSource?: 'header' | 'message'
}

/**
 * P1-1 — fork 落点（回流自 `origin/tianshu-alpha-3.14`）：
 * - `local`：沿用源会话 cwd（共享工作区，默认）
 * - `same-worktree`：复用源会话的隔离 worktree（源不是 worktree 会话则失败）
 * - `new-worktree`：新建隔离 worktree（`createWorktree`），分支随新会话 id
 */
export type ForkDestination = 'local' | 'same-worktree' | 'new-worktree'

/** Live plan-mode draft surfaced to the desktop — a growing working document,
 *  not a submitted plan. Title is the draft's H1 (null while still empty). */
export interface PlanDraft {
  path: string
  title: string | null
  content: string
}

export interface DomainUsageResponse {
  days: 7 | 30
  totalRuns: number
  domains: Array<{ key: string; count: number; lastUsedAt: number }>
  coverage: { partial: boolean; missingRuns: number; unreadableSessions: number; firstRecordedAt: number | null }
}
export interface FeaturedRepository { url: string; title: string; description: string }
export interface ProfileOverview {
  profileKey: string
  login: { totalMs: number; trackedSince: number | null }
  tokens: { total: number; peak: number; activeDays: number; scannedFiles: number } | null
  repositories: FeaturedRepository[]
}
export type ProviderUsageStatus = 'ok' | 'unconfigured' | 'unsupported' | 'error'
export type ProviderUsageError = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'invalid-response' | 'unavailable'
export type ProviderQuotaPeriod = '5h' | '7d' | 'monthly' | 'monthly-code' | 'tools' | 'quota'

/** Account usage is an official snapshot, independent of session token accounting. */
export interface ProviderUsageAccount {
  provider: string
  providerLabel: string
  keyId: string
  keyLabel?: string
  kind: 'balance' | 'subscription' | 'unsupported'
  status: ProviderUsageStatus
  error?: ProviderUsageError
  updatedAt?: string
  retryAt?: string
  available?: boolean
  balances: { currency: string; total: string; toppedUp?: string; granted?: string }[]
  quotas: { id: string; period: ProviderQuotaPeriod; remainingPercent: number; resetAt?: string }[]
}

export interface ProviderUsageSnapshot {
  available: boolean
  defaultAccount: { provider: string; keyId: string } | null
  accounts: ProviderUsageAccount[]
}
