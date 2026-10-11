import type { SidecarClient } from '../sidecar/client.js'
import type { TokenLedgerSettingsPatch, TokenLedgerSnapshot, TokenLedgerTotals } from '../sidecar/token-ledger.js'

export type TokenLedgerInboundMsg =
  | { type: 'getTokenLedger' | 'setTokenLedgerKey' | 'clearTokenLedgerKey' | 'syncTokenLedger'; requestId: number }
  | { type: 'saveTokenLedgerSettings'; requestId: number; enabled?: boolean; deviceName?: string; forum?: { endpoint?: string; autoSync?: boolean; intervalMinutes?: number } }

interface LedgerBridgeDeps {
  getClient: () => Promise<SidecarClient>
  active: () => boolean
  post: (message: Record<string, unknown>) => void
  promptKey: () => Promise<string | undefined>
}

function safeTotals(totals: TokenLedgerTotals): TokenLedgerTotals {
  return { requests: totals.requests, input: totals.input, output: totals.output,
    cacheRead: totals.cacheRead, cacheCreate: totals.cacheCreate, cost: totals.cost }
}

/** Pick fields explicitly: even an older/misbehaving sidecar cannot return a key or raw error to the webview. */
async function readSnapshot(client: SidecarClient): Promise<TokenLedgerSnapshot> {
  const [summary, status, settings] = await Promise.all([
    client.getTokenLedgerSummary(30), client.getTokenLedgerStatus(), client.getTokenLedgerSettings(),
  ])
  const receipt = status.lastPushResult
  return {
    summary: {
      enabled: summary.enabled, deviceId: summary.deviceId, deviceName: summary.deviceName,
      windowDays: summary.windowDays, totals: safeTotals(summary.totals), allTime: safeTotals(summary.allTime),
      days: summary.days.map(row => ({ ...safeTotals(row), date: row.date, model: row.model, provider: row.provider })), pending: summary.pending, lastPushAt: summary.lastPushAt,
    },
    status: {
      enabled: status.enabled, endpointConfigured: status.endpointConfigured,
      autoSync: status.autoSync, autoSyncConfigured: status.autoSyncConfigured,
      deviceId: status.deviceId, deviceName: status.deviceName, totals: safeTotals(status.totals),
      pending: status.pending, lastPushAt: status.lastPushAt,
      lastPushResult: receipt ? { ok: receipt.ok, status: receipt.status, code: receipt.code, at: receipt.at } : undefined,
    },
    settings: {
      enabled: settings.enabled, deviceName: settings.deviceName,
      forum: { endpoint: settings.forum.endpoint, apiKeyConfigured: settings.forum.apiKeyConfigured,
        autoSync: settings.forum.autoSync, intervalMinutes: settings.forum.intervalMinutes },
    },
  }
}

function safeFailure(error: unknown): { message: string; unavailable?: boolean } {
  const status = (error as { status?: number })?.status
    ?? Number(/→ (\d{3})/.exec((error as Error)?.message ?? '')?.[1])
  if (status === 404) return { message: '当前内核暂不支持 Token 账本，请升级内核。', unavailable: true }
  if (status === 401) return { message: '内核连接鉴权失败，请重新打开座舱。' }
  if (status === 400) return { message: '设置无效或同步尚未配置，请检查端点、密钥与间隔。' }
  return { message: '账本操作失败，请检查网络或同步设置后重试。' }
}

export async function handleTokenLedgerMessage(msg: TokenLedgerInboundMsg, deps: LedgerBridgeDeps): Promise<void> {
  const result = (fields: Record<string, unknown>) => {
    if (deps.active()) deps.post({ type: 'tokenLedgerResult', requestId: msg.requestId, ...fields })
  }
  try {
    const client = await deps.getClient()
    if (!deps.active()) return
    let message: string | undefined
    if (msg.type === 'setTokenLedgerKey') {
      let key = await deps.promptKey()
      if (!deps.active()) { key = undefined; return }
      if (key === undefined) { result({ ok: true, cancelled: true, message: '已取消，原密钥保留。' }); return }
      if (!key.trim()) { key = undefined; result({ ok: false, message: '同步密钥不能为空。' }); return }
      try { await client.setTokenLedgerSettings({ forum: { apiKey: key.trim() } }) }
      finally { key = undefined }
      message = '同步密钥已保存。'
    } else if (msg.type === 'clearTokenLedgerKey') {
      await client.setTokenLedgerSettings({ forum: { apiKey: '' } })
      message = '已清除配置中的同步密钥。'
    } else if (msg.type === 'saveTokenLedgerSettings') {
      const patch: TokenLedgerSettingsPatch = {}
      if (typeof msg.enabled === 'boolean') patch.enabled = msg.enabled
      if (typeof msg.deviceName === 'string') patch.deviceName = msg.deviceName
      if (msg.forum) {
        patch.forum = {}
        if (typeof msg.forum.endpoint === 'string') patch.forum.endpoint = msg.forum.endpoint
        if (typeof msg.forum.autoSync === 'boolean') patch.forum.autoSync = msg.forum.autoSync
        if (typeof msg.forum.intervalMinutes === 'number') patch.forum.intervalMinutes = msg.forum.intervalMinutes
      }
      await client.setTokenLedgerSettings(patch)
      message = '账本设置已保存。'
    } else if (msg.type === 'syncTokenLedger') {
      const outcome = await client.syncTokenLedger()
      if (!outcome.ok) { result({ ok: false, message: '同步失败，请检查同步设置后重试。' }); return }
      message = outcome.skipped === 'unchanged' ? '已同步，无新数据。' : '同步成功。'
    }
    const snapshot = await readSnapshot(client)
    if (deps.active()) deps.post({ type: 'tokenLedger', requestId: msg.requestId, ...snapshot })
    if (msg.type !== 'getTokenLedger') result({ ok: true, message })
  } catch (error) {
    // A failed push still records its attempt; refresh it without exposing the transport error.
    if (msg.type === 'syncTokenLedger' && deps.active()) {
      try {
        const snapshot = await readSnapshot(await deps.getClient())
        if (deps.active()) deps.post({ type: 'tokenLedger', requestId: msg.requestId, ...snapshot })
      } catch { /* Preserve the controlled failure below. */ }
    }
    result({ ok: false, ...safeFailure(error) })
  }
}
