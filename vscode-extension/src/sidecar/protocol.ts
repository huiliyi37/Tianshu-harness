/**
 * Sidecar 协议类型子集。
 *
 * ⚠ 事实源是 dev 仓 `src/server/protocol.ts`（Apache 2.0 开源侧）。本文件是
 * 插件消费所需的最小子集手工镜像——server 契约变更时同步更新（未知事件类型
 * 在消费端一律容错忽略，向后兼容）。不要在此文件添加 server 端没有的字段。
 */

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

/** SSE 事件类型——插件 P0 消费的子集；未列出的类型按透传处理。 */
export type KnownEventType =
  | 'user'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'turn_complete'
  | 'phase'
  | 'approval_required'
  | 'approval_resolved'
  | 'status'
  | 'error'
  | 'todo_state'
  | 'steer_queued'
  | 'plan_mode'
  | 'plan_submitted'
  | 'plan_draft'
  | 'user_question'
  | 'model_switched'
  | 'domain_changed'
  | 'resume_offer'
  | 'autonomy_checkpoint'
  | 'watchdog_recovery'
  | 'steer_delivered'
  | 'replay_window'
  | 'rewind'
  | 'ask_mode'
  | 'queue_pending'
  | 'queue_status'
  | 'done'
  | 'tool_delegate'

export interface SessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
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
  pendingApprovals: number
  approvalMode?: ApprovalMode
  archived?: boolean
  /** 上下文占用（enrichRecord 活填充，桌面端 header 进度条数据源；旧内核缺省）。 */
  contextTokens?: number
  contextWindow?: number
  /** 会话推理强度覆盖（enrichRecord；off|low|medium|high|max|auto）。 */
  reasoningEffort?: string
}

/** turn_complete SSE 事件的 usage 载荷 — dev 仓 src/api/types.ts::Usage 镜像。 */
export interface TurnUsage {
  /** cache-inclusive：input = 未命中 + cache_read + cache_creation。 */
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * GET /sessions/:id/cockpit 快照子集 — 与 TUI /cockpit、桌面端驾驶舱同一数据源
 * （buildCockpitSnapshot）。此处只镜像 webview 统计条消费的字段。
 */
export interface CockpitSnapshot {
  context: {
    estimatedTokens: number
    maxTokens: number
    rounds: number
    /** healthy | warning(>50%) | compacting(>80%) | critical(>95%)。 */
    compactionState: string
  } | null
  model: {
    name: string
    /** 0-1；cache_read / input_tokens（cache-inclusive 分母）。 */
    cacheHitRate: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    /** USD。 */
    cost: number
    recentTurnHitRate: number | null
    cacheDiagnostic: string | null
  }
}

export interface CreateSessionRequest {
  cwd: string
  title?: string
  prompt?: string
  approvalMode?: ApprovalMode
  model?: string
  domain?: string
  isolatedWorktree?: boolean
}

export interface ApprovalAnswer {
  decision: 'approve' | 'deny'
  editedInput?: Record<string, unknown>
  remember?: boolean
}

/** PlusMenu — GET /sessions/:id/models 条目。 */
export interface ModelEntry {
  id: string
  alias: string
  provider: string
  contextWindow?: number
  current: boolean
}

/** GET /sessions/:id/git/working-tree 条目 — 相对任务基线的单文件变更。 */
export interface WorkingTreeFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
}

/** PlusMenu — GET /sessions/:id/domains 条目（key: 'auto' | domainId）。 */
export interface DomainEntry {
  key: string
  name: string
  motto: string
  meta: string
  current: boolean
}

/** GET /config/providers — 已配置的 provider 条目。 */
export interface ProviderListItem {
  name: string
  label: string
  baseUrl?: string
  isDefault: boolean
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  authType?: 'oauth'
  oauthAuthenticated?: boolean
  keyless?: boolean
  keys?: {
    id: string
    keyStatus: ProviderListItem['keyStatus']
    models: ProviderListItem['models']
  }[]
  /** models 的 description/contextWindow/maxTokens 为 server contractModels 投影（config-routes）。 */
  models: {
    id: string
    alias?: string
    description?: string
    contextWindow?: number
    maxTokens?: number
    supportsVision?: boolean
  }[]
  isPreset: boolean
}

/** GET /config/providers — 尚未配置的预设候选。 */
export interface UnconfiguredPreset {
  key: string
  label: string
  defaultModelId: string
}

export interface ProviderConfigList {
  providers: ProviderListItem[]
  unconfigured: UnconfiguredPreset[]
}

/** POST /config/providers（预设 setup，一步带 key + 设默认）。 */
export interface SetupProviderRequest {
  providerName: string
  apiKey?: string
  baseUrl?: string
  makeDefault?: boolean
}

/** POST /config/providers/custom（OpenAI 兼容自定义端点）。 */
export interface SetupCustomProviderRequest {
  providerName: string
  baseUrl: string
  apiKey?: string
  makeDefault?: boolean
  model: { id: string; alias?: string }
}

/** GET /sessions/:id/rewind-points 条目 — 仅 user+string；seq 可能缺。 */
export interface RewindPoint {
  index: number
  content: string
  timestamp: number
  seq?: number
}

/** GET /sessions/:id/plans/:slug — plan mode 计划文档（server plan-store 镜像子集）。 */
export interface PlanDocument {
  slug: string
  title: string
  content: string
  status: 'submitted' | 'approved' | 'executed' | 'rejected'
  options?: { id: string; label: string }[]
  model?: string
}

export type { TokenLedgerTotals, TokenLedgerSummary, TokenLedgerStatus, TokenLedgerSettings, TokenLedgerSettingsPatch, TokenLedgerSyncOutcome, TokenLedgerSnapshot } from './token-ledger.js'
