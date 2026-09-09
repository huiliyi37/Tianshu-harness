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

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

/**
 * S — autonomy level. Canonical wire definition; the agent runtime re-exports
 * it from src/agent/loop-types.ts.
 */
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

// `turn_complete` data 的可选 additive 字段：`continuationReason`
// （中间 turn 之后系统注入提醒并自动续轮的原因，如
// 'obligation-verification'）。desktop 用它区分「给用户的消息」与
// 「给系统提醒的自检回复」；旧 sidecar 不携带时行为不变。
export type SessionEventType =
  | 'user'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'turn_complete'
  | 'phase'
  | 'checkpoint'
  | 'approval_required'
  | 'approval_resolved'
  // E4 — client tool delegation (apply_edit / terminal_exec). data: ToolDelegateEventData.
  | 'tool_delegate'
  | 'intent_note'
  | 'delegation'
  | 'artifact'
  | 'status'
  | 'error'
  | 'decision_shift'
  | 'rewind'
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
  // /handoff 归档完成 — 交接 run 收尾时项目内 .rivet/HANDOFF.md 已拷贝归档到
  // 会话目录 <id>.handoff.md（loadPrevHandoff 注入管线认的位置）。
  // data: { text: string, src: string, dest: string }。旧版 UI 忽略即可。
  | 'handoff_archived'
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

export interface SessionEvent {
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

export interface SessionRecord {
  id: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  cwd: string
  title?: string
  currentPhase?: string
  lastSeq: number
  error?: string
  /**
   * Wave 4 — 无人值守 fail-closed 中止的结构化标记。区别于一般 error：
   * 会话在等一个人类决定（授权/接管），侧栏与 Inbox 据此渲染 halted
   * 徽标/决策卡。新 run 启动时清除。
   */
  unattendedHalt?: { reason: string; app?: string }
  pendingApprovals: number
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
}

/** Live plan-mode draft surfaced to the desktop — a growing working document,
 *  not a submitted plan. Title is the draft's H1 (null while still empty). */
export interface PlanDraft {
  path: string
  title: string | null
  content: string
}
