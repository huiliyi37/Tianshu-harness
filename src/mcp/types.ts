export type McpTransportType = 'stdio' | 'streamableHttp' | 'sse-legacy'

export interface McpConnectionState {
  serverId: string
  /** awaiting-approval / denied：连接级审批门（issue #215）在 spawn 之前拦下时的状态。
   *  定义与判定在 src/mcp/server-approval.ts，消费端（TUI/REST/桌面端）据此分支。 */
  status: 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error' | 'awaiting-approval' | 'denied'
  transport?: McpTransportType
  toolCount: number
  error?: string
  /** Actionable hint from failure-classifier (shown in UI). */
  errorHint?: string
  lastConnectedAt?: number
  lastErrorClass?: string
  lastErrorAt?: number
}
