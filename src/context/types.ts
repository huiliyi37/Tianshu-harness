import type { Message } from '../api/types.js'
import type { OaiRound } from './rounds.js'

// ─── Health & Budget ──────────────────────────────────────────

export type ContextHealthLevel = 'healthy' | 'watch' | 'compact' | 'critical'

export type CompactionState = 'healthy' | 'warning' | 'compacting' | 'critical'

export interface ContextBudget {
  estimatedTokens: number
  maxTokens: number
  warningThreshold: number
  compactionState: CompactionState
}

// ─── API Round ────────────────────────────────────────────────

export type ApiInvariant = 'ok' | 'repaired' | 'broken'

export interface ApiRound {
  id: string
  startMessageIndex: number
  endMessageIndex: number
  turnNumber: number
  hasToolUse: boolean
  hasToolResult: boolean
  tokenEstimate: number
  compactableTokenEstimate: number
  apiInvariant: ApiInvariant
}

export interface ApiInvariantStatus {
  totalRounds: number
  okRounds: number
  repairedRounds: number
  brokenRounds: number
  orphanToolUse: string[]
  orphanToolResult: string[]
}

// ─── Context Ledger ───────────────────────────────────────────

export interface CompactedSpan {
  id: string
  strategy: 'micro' | 'session_memory' | 'reactive' | 'emergency'
  startRoundIndex: number
  endRoundIndex: number
  tokenBefore: number
  tokenAfter: number
  summaryPath?: string
  rawTranscriptPath: string
  createdAt: number
}

export interface ContextAnchor {
  kind: 'decision' | 'error' | 'user_preference' | 'user_constraint' | 'pending_task' | 'file' | 'verification'
  text: string
  sourceRoundIndex: number
  salience: number
}

export interface WorkingSetEntry {
  path: string
  status: 'read' | 'modified' | 'error' | 'pending'
  lastRoundIndex: number
}

export interface LedgerSessionMemoryState {
  path: string
  lastSummarizedRoundIndex: number
  lastUpdatedAt: number
  digest: string
  stale: boolean
  tokenEstimate: number
}

export interface ContextLedger {
  sessionId: string
  transcriptPath: string
  rounds: OaiRound[]
  anchors: ContextAnchor[]
  workingSet: WorkingSetEntry[]
  compactedSpans: CompactedSpan[]
  sessionMemory: LedgerSessionMemoryState | null
  tokenBudget: ContextBudget
  apiInvariantStatus: ApiInvariantStatus
}

// ─── Compact Tier & Policy ────────────────────────────────────

export type CompactTier = 0 | 1 | 2 | 3 | 4

export interface CompactDecision {
  tier: CompactTier
  reason: string
  shouldCompact: boolean
}

export interface CompactCircuitBreakerState {
  consecutiveFailures: number
  disabledUntilTurn?: number
}

// ─── Compact Event ────────────────────────────────────────────

export interface CompactEvent {
  turn: number
  tier: CompactTier
  reason: string
  beforeTokens: number
  afterTokens: number
  createdAt: number
}

// ─── Resume Preflight ─────────────────────────────────────────

export interface ResumePreflightReport {
  messageCount: number
  roundCount: number
  invariant: ApiInvariantStatus
  repaired: boolean
  syntheticResultsInserted: number
  orphanToolResultIds: string[]
  safe: boolean
  messages: Message[]
}

// ─── Microcompact ─────────────────────────────────────────────

export interface MicrocompactOptions {
  keepRecentRounds?: number
  minContentLength?: number
}

export interface MicrocompactResult {
  messages: Message[]
  compactedCount: number
  tokensSaved: number
  compactedRoundIds: string[]
}

// ─── Session Memory Sidecar ──────────────────────────────────────

export interface SessionMemoryEntry {
  id: string
  createdAt: number
  text: string
  source: 'manual' | 'compact' | 'resume'
}

export interface SessionMemoryState {
  sessionId: string
  entries: SessionMemoryEntry[]
}

export interface SessionMetadata {
  sessionId: string
  /** ISO timestamp when the session was first created */
  createdAt: number
  /** ISO timestamp of the last mutation (append/compact) */
  updatedAt: number
  compactEvents: CompactEvent[]
  lastLedger?: ContextLedger
  /** Primary model used for this session */
  model?: string
  /** Provider profile name (e.g. 'deepseek', 'openai') */
  provider?: string
  /** Running token usage aggregate */
  tokenUsage?: {
    prompt: number
    completion: number
    total: number
  }
  /** First user message — used as session title / summary */
  title?: string
  /** Session lifecycle status */
  status?: 'active' | 'completed' | 'archived'
  /** Worker 会话收尾时的失败归因（如 'timeout' / 'max_turns' / 'json_parse'）——
   *  事后无需翻 jsonl 即可从 meta 区分「正常完成 / 预算耗尽 / 解析失败」。
   *  正常完成写 undefined **清空**该字段：续跑各轮共用同一 meta，省略键会让上一轮
   *  的失败归因残留（updateMetadata 是合并语义）。 */
  failureReason?: string
  /** Worker 累计等模型首字节的毫秒数，与采样轮数配对——回答「墙钟是花在等模型还是
   *  在跑工具」。与 cache-log 的 ttftMs 同源，但不受 provider 是否返回缓存字段影响
   *  （worker 目录此前一直没有 cache-log，正是被那个条件挡住的）。 */
  waitingFirstByteMs?: number
  ttftSamples?: number
  /** Number of turns (user messages) processed */
  turnCount?: number
  /** Total tool calls executed */
  toolCallCount?: number
  /** Star-domain id for cross-session handoff routing (e.g. 'tianji', 'tanlang') */
  domain?: string
  /** Working directory this session was started in. Gates cross-cwd resume (R1). */
  cwd?: string
  /**
   * True when the previous run exited cleanly (vs crashed mid-flight). Set on
   * shutdown, reset to false on every live start. A clean-exit session is NOT
   * silently auto-resumed — only crash-interrupted sessions are (R1).
   */
  cleanExit?: boolean
  /** TUI side panel open state persisted across session resume. */
  sidePanelOpen?: boolean
  /**
   * Plan-mode state persisted across restarts. Runtime truth lives in
   * AgentLoop.planModeState (memory); this mirror lets resume re-enter
   * planning with the same draft file instead of silently dropping the mode.
   */
  planModeState?: 'off' | 'planning'
  /** Relative path of the active plan draft while planModeState === 'planning'. */
  activePlanFilePath?: string | null
  /** Ask Mode mirror — resume re-enters Ask when 'asking'. */
  askModeState?: 'off' | 'asking'
  /**
   * H4-D3：PAL 攻坚层快照（cases + evidence registry + completedWorkers）。
   * postTurn 有攻坚活动时写入；agent 创建（resume/模型切换重建）时恢复，
   * 避免案件/预算/已消费证据随进程重建归零。
   */
  palSnapshot?: import('../agent/problem-attack-loop.js').PalSnapshot
  /**
   * 最近一次 run 结束的结构化停止原因（2026-07-07 观测缺口修复）。
   * 此前 StopReason 只走 debugLog/遥测——不开 RIVET_DEBUG 时事后无法区分
   * "护栏熔断 / 用户中断 / 流错误 / 自然收尾"（会话 519216c0 取证时的盲区）。
   * 每次 run 结束时覆盖写入；t 为记录时刻 epoch ms。
   */
  lastStopReason?: {
    source: string
    turn: number
    voluntary: boolean
    detail?: string
    score?: number
    level?: number
    t: number
  }
  /**
   * Guardian（星域守护链路）活动摘要 — CCR 触发数、改道发射数（按 source 分）、
   * advisory 渲染/丢弃计数。排查"守护链路被静音"时一眼可见（Phase 0 观测）。
   */
  guardianActivity?: {
    ccr: number
    shifts: Record<string, number>
    advisoriesRendered: number
    advisoriesDropped: number
    /** P1a 核销闭环：expect 谓词判定的采纳/忽略累计（缺省 = 会话早于该功能） */
    advisoriesAdopted?: number
    advisoriesIgnored?: number
  }
  /**
   * 投机预读四源（tool-pattern/physarum-file/combined/llm）enqueued/hits 计数。
   * postSession 写入（有活动才写）——绕过 RIVET_DEBUG_TELEMETRY 门，
   * 为「llmSpeculation 是否默认开」提供跨会话命中率证据。
   */
  speculationStats?: Record<string, { enqueued: number; hits: number }>
  /**
   * 会话冻结的 wire 变换上下文（2026-08-07 spark T1）。首启时从 pro 注册的
   * 默认值（env 解析）冻结一次，此后 resume/跨端恒以本值回传 wire 截断与
   * 锚点提取——env 漂移不再打穿前缀缓存。非 spark 会话恒缺席（零字节差异）。
   * 结构镜像 api/pro-registry.ts 的 WireTransformContext（内联避免 context→api 引依赖）。
   */
  wireContext?: { truncateN?: { flash: number; pro: number } }
  /** 目标锚（spec 3c 动作 B 补强）：会话当前目标陈述，随用户实质指令更新，
   *  resume/跨端从 meta 恢复（与 wireContext 同一固化语义）。 */
  goalAnchor?: string
  /**
   * Tier 2 LLM speculation 引擎自身的调用计数（fired/parseFailures/errors）。
   * speculationStats.llm 只记 shadow-queue 侧的 enqueued/hits——没有本字段，
   * 「spec 到底发了几次 API 调用」无法从磁盘考证（2026-07-06 成本盲区修复）。
   */
  llmSpeculationEngine?: { fired: number; enqueued: number; parseFailures: number; errors: number }
  /**
   * Obligation final gate 遥测（evidence-driven reasoning loop Wave 3）：
   * auto-continue 触发/误触发/诚实受阻计数。误触发率（misfires/continued）
   * >20% 时优先怀疑 task kind 分类而非调低风险阈值。
   */
  obligationGate?: { continued: number; misfires: number; honestBlocked: number }
  /**
   * todo 退回计数（writes / regressedWrites / regressedItems）。postSession 写入
   * （有写入才写）——绕过 RIVET_DEBUG_TELEMETRY 门。`detectRegressions` 是本仓
   * 唯一直接观测「模型是否守得住自己任务状态」的结果侧探测器，此前触发只渲染进
   * 一条工具结果就丢了；落 meta 后才有跨会话的退回率基线可比。
   */
  todoRegressions?: {
    writes: number
    regressedWrites: number
    regressedItems: number
    /** v2 检测器：删除完成项只计退休、同项重现才计回归。缺省 = legacy v1
     *  （删除也算回归）——旧会话不与 v2 汇总混算。 */
    detectorVersion?: number
    /** 主动退休的已完成项数（删除完成项，非回归）。 */
    retiredCompletedItems?: number
  }
  /**
   * Theta 检查摘要（主控可靠性闭环 Wave 1）——一次一结果的 meta 落盘。
   * 每次真实尝试（通过 controller 全部 gate）完成时覆盖写入：
   * attempts/outcomes 是累计值，last* 是最后一次结果。timeoutOverrunMs > 0
   * 表示实际耗时超过预算（事件循环饥饿无法硬抢占，但超预算必须可见）。
   */
  thetaCheckSummary?: {
    /** 累计尝试次数（= thetaTelemetry.requestedCount）。 */
    attempts: number
    /** 各 outcome 累计（ok/type_errors/timeout/spawn_error/busy/backoff）。 */
    outcomes: Record<string, number>
    /** 最后一次尝试的 outcome。 */
    lastOutcome: string
    lastDurationMs: number | null
    /** busy/backoff 抑制累计。 */
    suppressedCount: number
    /** 连续真实超时（推进退避的那个计数）。 */
    consecutiveTimeouts: number
    /** 内层预算（ms，THETA_BUDGET_MS=15_000）。 */
    budgetMs: number
    /** lastDurationMs - budgetMs；>0 = 超预算（只有 timeout 才有意义）。 */
    timeoutOverrunMs?: number
  }
  /**
   * `decisions` 通道的 holdout 实验臂（`decisions-experiment.ts`）。与
   * `todoRegressions` 同时写入——没有臂标记，两组会话的退回率混在一起，
   * 度量就退化成一个无法归因的总体数字。
   */
  decisionsArm?: 'off' | 'treatment' | 'holdout'
}
