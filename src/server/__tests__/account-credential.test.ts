/**
 * issue #392：同一 provider 配多个 API Key 时，账户类查询（余额/摘要/成本）
 * 必须能按 keyId 区分。旧行为只读默认 provider 的顶层 apiKey/apiKeyEnv——
 * A′ 迁移形态（顶层全空、凭据在 keys[].keyRef → secrets.json）恒查不到，
 * 未迁移形态永远只查同一个账户。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter, type RouteHandler } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { writeSecret } from '../../config/secrets-store.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const DEEPSEEKBAL = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.5' }] }
const SUMMARY_PAYLOAD = {
  biz_code: 0,
  biz_data: {
    biz_code: 0,
    biz_data: {
      is_account_available: true, current_day_cost: 1, current_month_cost: 2, current_day_requests: 3,
      balance_info: { currency: 'CNY', total_balance: 42.5 },
    },
  },
}

/** 抓 Authorization 头的 fetch 桩：按 URL 分发余额/平台摘要的假响应。 */
function stubFetch(captured: Array<{ url: string; auth?: string }>) {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization']
    captured.push({ url: u, ...(auth ? { auth } : {}) })
    const payload = u.includes('/user/balance') ? DEEPSEEKBAL : SUMMARY_PAYLOAD
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

/** A′ 迁移形态：顶层三槽全空，两个 key 的凭据各自落在 secrets.json。 */
function writePooledConfig(home: string) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    provider: {
      default: 'deepseek',
      providers: {
        deepseek: {
          name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
          models: [{ id: 'deepseek-chat' }],
          keys: [
            { id: 'default', keyRef: 'deepseek:default', models: [] },
            { id: 'k2', keyRef: 'deepseek:k2', label: '备用', models: [] },
          ],
        },
      },
    },
  }, null, 2) + '\n')
}

describe('account queries are key-aware (issue #392)', () => {
  const prevHome = process.env.RIVET_HOME
  const prevFetch = globalThis.fetch
  const prevDeepseek = process.env.DEEPSEEK_API_KEY
  let home: string
  let routes: Record<string, RouteHandler>
  let captured: Array<{ url: string; auth?: string }>

  before(() => {
    delete process.env.DEEPSEEK_API_KEY
    home = mkdtempSync(join(tmpdir(), 'rivet-account-credential-'))
    writeFileSync(join(home, 'config.json'), '{}')
    process.env.RIVET_HOME = home
    writeSecret('deepseek:default', 'sk-main')
    writeSecret('deepseek:k2', 'sk-second')
    writeSecret('deepseek', 'sk-topref')
    routes = buildConfigRoutes(TOKEN)
  })
  beforeEach(() => {
    captured = []
    globalThis.fetch = stubFetch(captured)
  })
  afterEach(() => { globalThis.fetch = prevFetch })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevDeepseek
    rmSync(home, { recursive: true, force: true })
  })

  it('balance without keyId falls back to the pool default key when top-level slots are empty', async () => {
    writePooledConfig(home)
    const res = await routes['GET /config/balance']!({}, {}, AUTH, undefined)
    assert.equal(res.status, 200)
    const body = res.body as { balance: { balances: Array<{ totalBalance: string }> } | null }
    assert.ok(body.balance, 'A′-migrated providers must still yield the main key balance')
    assert.equal(body.balance!.balances[0]!.totalBalance, '42.5')
    assert.equal(captured[0]?.auth, 'Bearer sk-main')
  })

  it('balance with explicit keyId queries that key\'s own account', async () => {
    writePooledConfig(home)
    const res = await routes['GET /config/balance']!({}, { keyId: 'k2' }, AUTH, undefined)
    assert.equal(res.status, 200)
    const body = res.body as { balance: unknown; keyId?: string; label?: string }
    assert.ok(body.balance)
    assert.equal(captured[0]?.auth, 'Bearer sk-second')
    // 响应回显命中的 key（收编 PR #395）：调用方据此确认「哪个账户在回答」。
    assert.equal(body.keyId, 'k2')
    assert.equal(body.label, '备用')
  })

  it('default resolution echoes the pool default key identity too', async () => {
    writePooledConfig(home)
    const res = await routes['GET /config/balance']!({}, {}, AUTH, undefined)
    const body = res.body as { keyId?: string }
    assert.equal(body.keyId, 'default', '池回退命中时也要回显 keyId——客户端才能知道缺省视图是谁的账户')
  })

  it('unknown keyId fails closed with 400 instead of silently querying another account', async () => {
    writePooledConfig(home)
    const res = await routes['GET /config/balance']!({}, { keyId: 'ghost' }, AUTH, undefined)
    assert.equal(res.status, 400)
    assert.equal(captured.length, 0, 'no upstream request may leave with a wrong credential')
  })

  it('unknown explicit provider fails closed with 400', async () => {
    writePooledConfig(home)
    const res = await routes['GET /config/balance']!({}, { provider: 'ghost' }, AUTH, undefined)
    assert.equal(res.status, 400)
  })

  it('deepseek summary resolves the explicit keyId credential when platform login is absent', async () => {
    writePooledConfig(home)
    const res = await routes['GET /config/deepseek/summary']!({}, { keyId: 'k2' }, AUTH, undefined)
    assert.equal(res.status, 200)
    const body = res.body as { summary: { balance_info: { total_balance: number } } | null }
    assert.ok(body.summary, 'pooled key credential must reach the platform client')
    assert.equal(body.summary!.balance_info.total_balance, 42.5)
    assert.equal(captured[0]?.auth, 'Bearer sk-second')
  })

  it('legacy top-level apiKey keeps working untouched (no keys pool)', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: { deepseek: { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-legacy', models: [] } },
      },
    }, null, 2) + '\n')
    const res = await routes['GET /config/balance']!({}, {}, AUTH, undefined)
    assert.equal(res.status, 200)
    assert.ok((res.body as { balance: unknown }).balance)
    assert.equal(captured[0]?.auth, 'Bearer sk-legacy')
  })

  it('top-level keyRef form (promoted pool key) is honored by account queries', async () => {
    // 用独立 ref 名——上一个用例的 migrateInlineApiKeys 会占用 'deepseek' 顶层 ref。
    writeSecret('deepseek-promoted', 'sk-topref')
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: { deepseek: { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', keyRef: 'deepseek-promoted', models: [] } },
      },
    }, null, 2) + '\n')
    const res = await routes['GET /config/balance']!({}, {}, AUTH, undefined)
    assert.equal(res.status, 200)
    assert.ok((res.body as { balance: unknown }).balance, 'top-level keyRef must be read, not just apiKey/apiKeyEnv')
    assert.equal(captured[0]?.auth, 'Bearer sk-topref')
  })

  it('non-DeepSeek provider still yields balance: null (endpoint unsupported)', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: {
        default: 'other',
        providers: { other: { name: 'other', baseUrl: 'https://example.com/v1', apiKey: 'sk-x', models: [] } },
      },
    }, null, 2) + '\n')
    const res = await routes['GET /config/balance']!({}, {}, AUTH, undefined)
    assert.equal(res.status, 200)
    assert.equal((res.body as { balance: unknown }).balance, null)
    assert.equal(captured.length, 0)
  })
})
