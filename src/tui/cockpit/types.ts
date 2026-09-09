import type { PhysarumShadowStats } from '../../repo/physarum-shadow-stats.js'

export type Panel = 'summary' | 'trace' | 'verify' | 'context' | 'safety' | 'model' | 'mcp' | 'advisory'

export const PANELS: Panel[] = ['summary', 'trace', 'verify', 'context', 'safety', 'model', 'mcp', 'advisory']

export const PANEL_LABELS: Record<Panel, string> = {
  summary: 'Summary',
  trace: 'Trace',
  verify: 'Verify',
  context: 'Context',
  safety: 'Safety',
  model: 'Model',
  mcp: 'MCP',
  advisory: 'Advisory',
}

export interface CockpitContextLayerView {
  id: string
  label: string
  stability: string
  channel: string
  fingerprint: string
  digest: string
  tokenEstimate: number
}

export interface CockpitRiskView {
  level: 'none' | 'low' | 'medium' | 'high'
  reasons: string[]
  suggestedAction: string
}

export interface CockpitVerificationRunView {
  command: string
  status: 'passed' | 'failed' | 'blocked'
  scope: string
  target?: string
}

export interface CockpitVerificationState {
  deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
  runs: CockpitVerificationRunView[]
}

export type PanelStatus = 'ok' | 'warn' | 'error' | 'idle'

export interface CockpitSnapshot {
  intent: string | null
  blockingReason: string | null
  nextAction: string | null
  safety: {
    doomLoopLevel: 'none' | 'warn' | 'blocked'
    riskLevel: 'none' | 'low' | 'medium' | 'high'
    riskReasons: string[]
    suggestedAction: string
    recentFingerprints: number
  }
  verification: {
    filesRead: number
    filesModified: number
    runs: Array<{ tool: string; status: string; summary: string }>
    deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
    impactedFiles: number
    impactedTests: number
  }
  trace: {
    events: Array<{
      id: string
      turn: number
      kind: string
      name: string
      status: string
      durationMs?: number
      summary?: string
    }>
    totalEvents: number
  }
  context: {
    estimatedTokens: number
    maxTokens: number
    rounds: number
    compactionState: string
    brokenRounds: number
    layers: CockpitContextLayerView[]
    claimCounts: import('../../context/promotion.js').ClaimStatusCounts
  } | null
  model: {
    name: string
    cacheHitRate: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
    perTurnHitRate: number | null
    recentTurnHitRate: number | null
    prewarmHits: number
    prewarmMisses: number
    prewarmHitRate: number
    physarumShadow: PhysarumShadowStats
    /** ShadowQueue 投机预读四源 enqueued/hits（tool-pattern/physarum-file/combined/llm）。 */
    speculation: import('../../agent/shadow-queue.js').ShadowQueueSourceStats | null
    cacheDiagnostic: string | null
    reasoningEffort: string
    /** Active star-domain label: pinned domain name, `Auto(天枢)` for auto
     *  (keyword fallback), or `关闭(环境)` when STAR_SOUL kill switch is on. */
    starDomain: string
  }
  mcp: {
    servers: Array<{
      serverId: string
      status: string
      toolCount: number
      lastErrorClass?: string
    }>
    totalTools: number
    connectedServers: number
  }
  /** Advisory 面板 — 提醒系统可观测性（账本累计 / 静音 / 挂起 / per-key 效能）。 */
  advisory: {
    /** 会话累计（guardianActivity 口径） */
    rendered: number
    dropped: number
    adopted: number
    ignored: number
    heldOut: number
    /** 静音中的 key（习惯化 + 负 lift） */
    silenced: Array<{ key: string; remaining: number; reason: 'habituation' | 'lift' }>
    /** 挂起观察中的条目数（observe 状态机） */
    pendingWatch: number
    /** per-key 效能 Top 行（delivered 降序,截 8） */
    keys: Array<{
      key: string
      delivered: number
      adopted: number
      ignored: number
      ignoredStreak: number
      adoptionRate: number | null
      lift: number | null
    }>
    /** status 通道最近条目（dark cockpit 单感官通道,不进 prompt） */
    statusNotices: string[]
  }
  panelStatuses: Record<Panel, PanelStatus>
}
