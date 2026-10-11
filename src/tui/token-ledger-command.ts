import type { BootstrapContext } from '../bootstrap.js'
import type { Config } from '../config/schema.js'
import { readTokenLedgerSettings, updateTokenLedgerSettings } from '../token-ledger/settings.js'
import type { TokenLedgerStatus } from '../token-ledger/service.js'
import type { TuiApp } from './engine/app.js'

export interface LedgerCommandOptions {
  connect?: (save: (key: string) => void) => void
  updateSettings?: (patch: unknown) => Config
  canCommit?: () => boolean
}

const CONNECT_HINT = 'Configure the sync key in the VS Code secure settings or native TUI /token-ledger connect. Do not enter keys in plain text commands.'
const USAGE = '/token-ledger [status|sync|auto on|auto off|connect|disconnect] (alias /usage)'

function formatStatus(status: TokenLedgerStatus, config: Config): string {
  const { totals, lastPushResult: receipt } = status
  const settings = readTokenLedgerSettings(config)
  const number = (value: number) => value.toLocaleString('en-US')
  const code = receipt?.code && /^[a-zA-Z0-9_-]{1,64}$/.test(receipt.code) && !receipt.code.startsWith('tsu_') ? receipt.code : undefined
  return [
    'Token ledger (local cumulative usage)',
    `Total tokens: ${number(totals.input + totals.output)} (input + output)`,
    `Input: ${number(totals.input)} · Output: ${number(totals.output)}`,
    `Cache read: ${number(totals.cacheRead)} (included in input; not added again)`,
    `Estimated pricing value: ${totals.cost.toFixed(6)} (model pricing units may differ; not a unified bill)`,
    `Local recording: ${status.enabled ? 'on' : 'off'} · Sync key: ${settings.forum.apiKeyConfigured ? 'configured' : 'not configured'}`,
    `Automatic upload: ${settings.forum.autoSync ? `on (${settings.forum.intervalMinutes} min)` : 'off (local only; manual sync available)'}`,
    `Pending: ${status.pending ? 'yes' : 'no'} · Last confirmed: ${status.lastPushAt ?? 'never'}`,
    receipt ? `Last sync: ${receipt.ok ? 'confirmed' : 'failed'}${receipt.status ? ` · HTTP ${receipt.status}` : ''}${code ? ` · ${code}` : ''}` : 'Last sync: none',
    USAGE,
  ].join('\n')
}

export async function handleTokenLedgerCommand(
  ctx: BootstrapContext, parts: string[], say: (text: string) => void, options: LedgerCommandOptions = {},
): Promise<boolean> {
  const canCommit = options.canCommit ?? (() => true)
  const update = (patch: unknown) => {
    if (!canCommit()) return
    const next = (options.updateSettings ?? updateTokenLedgerSettings)(patch)
    ctx.config = next
    ctx.tokenLedger?.reconfigure(next)
  }
  const [action = 'status', argument, ...extra] = parts.slice(1)
  if (action === 'connect') {
    if (argument || extra.length || !options.connect) say(CONNECT_HINT)
    else options.connect(key => { update({ forum: { apiKey: key, autoSync: false } }) })
    return true
  }
  if (!canCommit()) return true
  try {
    if (action === 'disconnect' && !argument) {
      update({ forum: { apiKey: '', autoSync: false } })
      say('Token ledger disconnected. Saved sync key removed; automatic upload is off.')
      return true
    }
    if (action === 'auto' && ['on', 'off'].includes(argument ?? '') && !extra.length) {
      if (argument === 'on' && !readTokenLedgerSettings(ctx.config).forum.apiKeyConfigured) { say(CONNECT_HINT); return true }
      update({ forum: { autoSync: argument === 'on', intervalMinutes: 30 } })
      say(argument === 'on' ? 'Automatic Token ledger upload enabled every 30 min.' : 'Automatic Token ledger upload disabled. Local recording continues.')
      return true
    }
    if (!['status', 'sync'].includes(action) || argument) { say(USAGE); return true }
    const service = ctx.tokenLedger
    if (!service) { say('Token ledger is unavailable or local recording is disabled.'); return true }
    if (action === 'sync') {
      if (!readTokenLedgerSettings(ctx.config).forum.apiKeyConfigured) { await service.refresh(); if (canCommit()) say(CONNECT_HINT); return true }
      const result = await service.syncNow()
      if (!canCommit()) return true
      say(result.ok ? result.skipped === 'unchanged' ? 'Token ledger is already confirmed; no changes to upload.' : 'Token ledger sync confirmed.' : 'Token ledger sync failed or skipped; local usage remains pending.')
    } else await service.refresh()
    if (canCommit()) say(formatStatus(service.status(), ctx.config))
  } catch { if (canCommit()) say('Token ledger operation failed. Local records are preserved; check settings and retry.') }
  return true
}

export function registerTokenLedgerCommands(app: TuiApp, ctx: BootstrapContext, options: LedgerCommandOptions = {}): void {
  app.registerSlashCommand({
    name: '/token-ledger', aliases: ['/usage'], immediate: true,
    description: 'Local Token usage, manual sync and opt-in automatic upload',
    handler: ({ trimmed }) => handleTokenLedgerCommand(ctx, trimmed.split(/\s+/), text => app.commitStatic(text), {
      ...options, connect: save => app.startTokenLedgerConnect(save),
    }),
  })
}
