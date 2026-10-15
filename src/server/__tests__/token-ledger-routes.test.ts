/**
 * /token-ledger 路由测试：鉴权、summary 窗口聚合、status、sync 的结果码映射。
 * service 实例注入（routes 不碰真实 loadConfig / 真实 ~/.rivet）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildTokenLedgerRoutes } from '../token-ledger-routes.js'
import { TokenLedgerService } from '../../token-ledger/service.js'
import type { FetchLike } from '../../token-ledger/forum-sync.js'
import { configSchema } from '../../config/schema.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

describe('/token-ledger routes', () => {
  let base: string
  let logFile: string
  const pushed: Array<{ url: string; body: Record<string, unknown> }> = []

  const fetchImpl: FetchLike = async (url, init) => {
    pushed.push({ url, body: JSON.parse(init?.body ?? '{}') })
    return { status: 200, text: async () => '{"ok":true,"stale":false}' }
  }

  const makeService = () => new TokenLedgerService(configSchema.parse({
    provider: { default: 'deepseek', providers: {} },
    tokenLedger: { forum: { endpoint: 'https://forum.example.com/api/token-usage', apiKey: 'k' } },
  }), {
    statePath: join(base, 'ledger.json'),
    sessionsRoot: join(base, 'sessions'),
    fetchImpl,
  })

  before(() => {
    base = mkdtempSync(join(tmpdir(), 'token-ledger-routes-'))
    const logDir = join(base, 'sessions', 'proj', 'sess-1')
    mkdirSync(logDir, { recursive: true })
    const now = Date.now()
    logFile = join(logDir, 'cache-log.jsonl')
    writeFileSync(logFile, [
      JSON.stringify({ t: now - 1000, turn: 1, model: 'deepseek-flash', provider: 'deepseek', input: 10_000, cacheRead: 9_000, cacheCreate: 100, output: 400 }),
      JSON.stringify({ event: 'side_path', kind: 'speculation', t: now - 2000, model: 'deepseek-flash', provider: 'deepseek', input: 2_000, cacheRead: 1_000, cacheCreate: 0, output: 50 }),
      JSON.stringify({ event: 'reclaim_decision', t: now - 3000, action: 'trim' }),
    ].join('\n') + '\n')
  })

  after(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const router = () => createRouter(buildTokenLedgerRoutes({ apiToken: TOKEN, service: makeService() }))

  it('未带 token：401', async () => {
    const res = await router()('GET', '/token-ledger/status', {}, {})
    assert.equal(res.status, 401)
  })

  it('GET /summary：窗口聚合 + 全量累计 + 计费行口径', async () => {
    const res = await router()('GET', '/token-ledger/summary', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as {
      enabled: boolean
      windowDays: number
      totals: { requests: number; input: number }
      allTime: { requests: number; input: number; output: number }
      days: Array<{ date: string; model: string }>
      pending: boolean
    }
    assert.equal(body.enabled, true)
    assert.equal(body.windowDays, 30)
    // 主行 + side_path = 2 个计费请求；reclaim_decision 不计
    assert.equal(body.totals.requests, 2)
    assert.equal(body.totals.input, 12_000)
    assert.deepEqual(body.allTime, body.allTime)
    assert.equal(body.allTime.output, 450)
    assert.equal(body.days.length, 1)
    assert.equal(body.days[0]!.model, 'deepseek-flash')
    assert.equal(body.pending, true) // 从未推送过
    assert.equal((res.body as {hourlyCoverage:{state:string}}).hourlyCoverage.state,'complete')
  })

  it('GET /summary?days=0 拒绝；days 夹上限', async () => {
    const bad = await router()('GET', '/token-ledger/summary?days=0', {}, AUTH)
    assert.equal(bad.status, 400)
    const capped = await router()('GET', '/token-ledger/summary?days=9999', {}, AUTH)
    assert.equal(capped.status, 200)
    assert.equal((capped.body as { windowDays: number }).windowDays, 366)
  })

  it('GET /status：deviceId / endpointConfigured / pending', async () => {
    const res = await router()('GET', '/token-ledger/status', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { deviceId: string; endpointConfigured: boolean; pending: boolean; totals: { requests: number } }
    assert.ok(body.deviceId)
    assert.equal(body.endpointConfigured, true)
    assert.equal(body.totals.requests, 2)
    assert.equal(body.pending, true)
  })

  it('POST /sync：成功推送快照并返回 outcome', async () => {
    const before1 = pushed.length
    const res = await router()('POST', '/token-ledger/sync', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; digest?: string }
    assert.equal(body.ok, true)
    assert.ok(body.digest)
    assert.equal(pushed.length, before1 + 1)
    const payload = pushed[pushed.length - 1]!
    assert.equal(payload.url, 'https://forum.example.com/api/token-usage')
    assert.equal((payload.body.totals as { requests: number }).requests, 2)
  })

  it('POST /sync：未配置 endpoint 时 400 带提示', async () => {
    const svc = new TokenLedgerService(configSchema.parse({ provider: { default: 'deepseek', providers: {} } }), {
      statePath: join(base, 'ledger-noconf.json'),
      sessionsRoot: join(base, 'sessions'),
    })
    const res = await createRouter(buildTokenLedgerRoutes({ apiToken: TOKEN, service: svc }))('POST', '/token-ledger/sync', {}, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { hint?: string }).hint ?? '', /tokenLedger\.forum\.endpoint/)
  })
})


describe('Token ledger settings routes', () => {
  it('requires authorization for reads and writes and never returns a key', async () => {
    let config = configSchema.parse({ provider: { default: 'deepseek', providers: {} }, tokenLedger: { forum: { apiKey: 'tsu_fixture_only', endpoint: 'https://tianshuharness.com/token/v1/token-usage' } } })
    const base = mkdtempSync(join(tmpdir(), 'ledger-settings-routes-'))
    try {
      const service = new TokenLedgerService(config, { statePath: join(base, 'ledger.json'), sessionsRoot: join(base, 'sessions') })
      const routes = buildTokenLedgerRoutes({ apiToken: TOKEN, service, settingsDeps: { load: () => structuredClone(config), save: next => { config = next } } })
      const router = createRouter(routes)
      assert.equal((await router('GET', '/token-ledger/settings', {}, {})).status, 401)
      assert.equal((await router('PUT', '/token-ledger/settings', { forum: { apiKey: '' } }, {})).status, 401)
      const read = await router('GET', '/token-ledger/settings', {}, AUTH)
      assert.equal(read.status, 200)
      assert.equal(JSON.stringify(read.body).includes('tsu_fixture_only'), false)
      const bad = await router('PUT', '/token-ledger/settings', { forum: { apiKey: 'candidate-secret', endpoint: 'bad' } }, AUTH)
      assert.equal(bad.status, 400)
      assert.equal(JSON.stringify(bad.body).includes('candidate-secret'), false)
      const write = await router('PUT', '/token-ledger/settings', { forum: { autoSync: true } }, AUTH)
      assert.equal(write.status, 200)
      assert.equal(service.status().autoSync, true)
      await router('PUT', '/token-ledger/settings', { forum: { apiKey: '' } }, AUTH)
      assert.equal(service.status().autoSync, false)
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
})


describe('Token ledger environment key precedence', () => {
  it('clearing a saved key stops automatic upload while reporting and retaining the environment override', async () => {
    const previous = process.env.RIVET_FORUM_TOKEN
    const base = mkdtempSync(join(tmpdir(), 'ledger-env-settings-routes-'))
    try {
      process.env.RIVET_FORUM_TOKEN = 'fixture-environment-key'
      let config = configSchema.parse({ provider: { default: 'deepseek', providers: {} }, tokenLedger: { forum: { apiKey: 'fixture-saved-key', autoSync: true } } })
      const keys: string[] = []
      const service = new TokenLedgerService(config, {
        statePath: join(base, 'ledger.json'), sessionsRoot: join(base, 'sessions'),
        fetchImpl: async (_url, init) => {
          keys.push(init?.headers?.Authorization ?? '')
          return { status: 200, text: async () => '{"ok":true,"stale":false}' }
        },
      })
      service.startAutoSync()
      const router = createRouter(buildTokenLedgerRoutes({ apiToken: TOKEN, service, settingsDeps: { load: () => structuredClone(config), save: next => { config = next } } }))
      const clear = await router('PUT', '/token-ledger/settings', { forum: { apiKey: '' } }, AUTH)
      assert.equal(clear.status, 200)
      const dto = clear.body as { forum: { autoSync: boolean; apiKeyConfigured: boolean; apiKeySource: string } }
      assert.equal(dto.forum.autoSync, false)
      assert.equal(dto.forum.apiKeyConfigured, true)
      assert.equal(dto.forum.apiKeySource, 'environment')
      assert.equal(JSON.stringify(dto).includes('fixture-environment-key'), false)
      assert.equal(service.status().autoSync, false)
      await router('PUT', '/token-ledger/settings', { forum: { apiKey: 'fixture-rotated-key' } }, AUTH)
      assert.equal((await service.syncNow()).ok, true)
      assert.deepEqual(keys, ['Bearer fixture-environment-key'])
      process.env.RIVET_FORUM_TOKEN = '   '
      const read = await router('GET', '/token-ledger/settings', {}, AUTH)
      assert.equal((read.body as { forum: { apiKeySource: string } }).forum.apiKeySource, 'none')
      assert.equal((await service.syncNow()).skipped, 'no_key')
      process.env.RIVET_FORUM_TOKEN = ''
      const fallback = await router('GET', '/token-ledger/settings', {}, AUTH)
      assert.equal((fallback.body as { forum: { apiKeySource: string } }).forum.apiKeySource, 'saved')
      assert.equal((await service.syncNow()).ok, true)
      assert.deepEqual(keys, ['Bearer fixture-environment-key', 'Bearer fixture-rotated-key'])
    } finally {
      if (previous === undefined) delete process.env.RIVET_FORUM_TOKEN
      else process.env.RIVET_FORUM_TOKEN = previous
      rmSync(base, { recursive: true, force: true })
    }
  })
})
