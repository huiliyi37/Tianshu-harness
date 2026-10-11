/**
 * /token-ledger 路由 —— token 消耗台账的查询与手动同步接口（论坛同步预留面）。
 *
 *  - GET  /token-ledger/summary?days=30  本地台账视图：窗口内明细 + 全量累计
 *  - GET  /token-ledger/status           台账/同步状态（deviceId、pending、上次推送回执）
 *  - POST /token-ledger/sync             立即同步一次到论坛端点（未配置返回 400）
 *
 * 桌面端/论坛调试页经此读取；数据层是 [TokenLedgerService](../token-ledger/service.ts)。
 * 与 cache-routes 同级，token 鉴权。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { loadConfig } from '../config/manager.js'
import { readTokenLedgerSettings, updateTokenLedgerSettings } from '../token-ledger/settings.js'
import type { Config } from '../config/schema.js'
import { dayKey } from '../cache/usage-aggregator.js'
import { TokenLedgerService, type TokenLedgerServiceDeps } from '../token-ledger/service.js'
import type { TokenDayModelRecord } from '../token-ledger/types.js'

const MAX_DAYS = 366

export interface TokenLedgerRoutesDeps {
  apiToken?: string
  settingsDeps?: { load?: () => Config; save?: (config: Config) => void }
  /** 测试注入；缺省在 builder 内懒建（serve 进程级单例，共享自动同步状态） */
  service?: TokenLedgerService
  /** 透传给懒建 service 的依赖（测试注入 fetch/路径/时钟） */
  serviceDeps?: TokenLedgerServiceDeps
}

function parseDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 30
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(MAX_DAYS, Math.ceil(n))
}

function windowedTotals(days: TokenDayModelRecord[]) {
  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 }
  for (const r of days) {
    totals.requests += r.requests
    totals.input += r.input
    totals.output += r.output
    totals.cacheRead += r.cacheRead
    totals.cacheCreate += r.cacheCreate
    totals.cost += r.cost
  }
  totals.cost = Math.round(totals.cost * 1_000_000) / 1_000_000
  return totals
}

export function buildTokenLedgerRoutes(deps: TokenLedgerRoutesDeps): Record<string, RouteHandler> {
  let service: TokenLedgerService | undefined = deps.service
  const getService = (): TokenLedgerService => {
    if (!service) service = new TokenLedgerService(loadConfig(), deps.serviceDeps)
    return service
  }
  const authorized = (body: unknown, headers?: Record<string, string>) =>
    isAuthorizedRequest({ body, headers }, deps.apiToken)

  return {
    'GET /token-ledger/settings': async (body, _params, headers) => {
      if (!authorized(body, headers)) return { status: 401, body: { error: 'Unauthorized' } }
      try { return { status: 200, body: readTokenLedgerSettings((deps.settingsDeps?.load ?? loadConfig)()) } }
      catch { return { status: 500, body: { error: 'Unable to read Token ledger settings' } } }
    },
    'PUT /token-ledger/settings': async (body, _params, headers) => {
      if (!authorized(body, headers)) return { status: 401, body: { error: 'Unauthorized' } }
      try {
        const config = updateTokenLedgerSettings(body, deps.settingsDeps)
        getService().reconfigure(config)
        return { status: 200, body: readTokenLedgerSettings(config) }
      } catch { return { status: 400, body: { error: 'Unable to save Token ledger settings. Check fields and sync key.' } } }
    },
    'GET /token-ledger/summary': async (body, params, headers) => {
      if (!authorized(body, headers)) return { status: 401, body: { error: 'Unauthorized' } }
      const days = parseDays(params?.days)
      if (days === null) return { status: 400, body: { error: 'days must be a positive number' } }

      const svc = getService()
      try {
        await svc.refresh()
        const status = svc.status()
        const start = new Date()
        start.setHours(0, 0, 0, 0)
        start.setDate(start.getDate() - days + 1)
        const since = dayKey(start.getTime())
        const windowDays = svc.records(since)
        return {
          status: 200,
          body: {
            enabled: status.enabled,
            deviceId: status.deviceId,
            deviceName: status.deviceName,
            windowDays: days,
            totals: windowedTotals(windowDays),
            allTime: status.totals,
            days: windowDays,
            pending: status.pending,
            lastPushAt: status.lastPushAt,
          },
        }
      } catch (err) {
        return { status: 500, body: { error: 'Token ledger operation failed; local data retained' } }
      }
    },

    'GET /token-ledger/status': async (body, _params, headers) => {
      if (!authorized(body, headers)) return { status: 401, body: { error: 'Unauthorized' } }
      const svc = getService()
      try {
        await svc.refresh()
        return { status: 200, body: svc.status() }
      } catch (err) {
        return { status: 500, body: { error: 'Token ledger operation failed; local data retained' } }
      }
    },

    'POST /token-ledger/sync': async (body, _params, headers) => {
      if (!authorized(body, headers)) return { status: 401, body: { error: 'Unauthorized' } }
      const svc = getService()
      try {
        const outcome = await svc.syncNow()
        if (outcome.skipped === 'disabled') {
          return { status: 400, body: { error: 'tokenLedger.enabled is false' } }
        }
        if (outcome.skipped === 'no_key') return { status: 400, body: { error: 'Configure your personal forum sync key first' } }
        if (outcome.skipped === 'no_endpoint') {
          return {
            status: 400,
            body: {
              error: 'forum endpoint not configured',
              hint: 'set tokenLedger.forum.endpoint (+ apiKey) in config.json, or RIVET_FORUM_API / RIVET_FORUM_TOKEN',
            },
          }
        }
        if (!outcome.ok) {
          return { status: 502, body: { error: 'forum push failed', push: outcome.push } }
        }
        return { status: 200, body: outcome }
      } catch (err) {
        return { status: 500, body: { error: 'Token ledger operation failed; local data retained' } }
      }
    },
  }
}
