/** Safe Token ledger DTOs shared by the host bridge and the settings card. */
export interface TokenLedgerTotals {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
}
export interface TokenLedgerRecord extends TokenLedgerTotals { date: string; model: string; provider?: string }
export interface TokenLedgerSummary {
  enabled: boolean
  deviceId: string
  deviceName: string
  windowDays: number
  totals: TokenLedgerTotals
  allTime: TokenLedgerTotals
  days: TokenLedgerRecord[]
  pending: boolean
  lastPushAt?: string
}
export interface TokenLedgerReceipt { ok: boolean; status?: number; code?: string; at?: string }
export interface TokenLedgerStatus {
  enabled: boolean
  endpointConfigured: boolean
  /** Whether the current sidecar timer is running. */
  autoSync: boolean
  autoSyncConfigured?: boolean
  deviceId: string
  deviceName: string
  totals: TokenLedgerTotals
  pending: boolean
  lastPushAt?: string
  lastPushResult?: TokenLedgerReceipt
}
export interface TokenLedgerSettings {
  enabled: boolean
  deviceName: string
  forum: { endpoint: string; apiKeyConfigured: boolean; autoSync: boolean; intervalMinutes: number }
}
export interface TokenLedgerSettingsPatch {
  enabled?: boolean
  deviceName?: string
  forum?: { endpoint?: string; apiKey?: string; autoSync?: boolean; intervalMinutes?: number }
}
export interface TokenLedgerSyncOutcome {
  ok: boolean
  skipped?: 'disabled' | 'no_endpoint' | 'no_key' | 'unchanged'
  push?: { ok: boolean; status?: number; code?: string }
}
export interface TokenLedgerSnapshot { summary: TokenLedgerSummary; status: TokenLedgerStatus; settings: TokenLedgerSettings }
