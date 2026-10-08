import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadPlatformAuth, savePlatformAuth, clearPlatformAuth } from '../deepseek-platform-auth.js'
import { getDeepSeekUserSummary, getDeepSeekCostReport } from '../deepseek-platform-client.js'
import { defaultRivetHome, rivetHome } from '../../config/paths.js'
import { createRouter } from '../../server/index.js'
import { buildConfigRoutes } from '../../server/config-routes.js'
import { normalizeKeyUsage, normalizeWalletSummary, platformMonthRange } from '../deepseek-platform-normalize.js'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

const currentAmount = { series: [
  { model: 'test-model', buckets: [{ time: 1790812800, usage: { PROMPT_CACHE_HIT_TOKEN: 80, PROMPT_CACHE_MISS_TOKEN: 20, RESPONSE_TOKEN: 10, REQUEST: 1 } }] },
  { model: 'test-model', buckets: [{ time: 1790812800, usage: { PROMPT_CACHE_HIT_TOKEN: 8, PROMPT_CACHE_MISS_TOKEN: 2, RESPONSE_TOKEN: 1, REQUEST: 1 } }] },
] }
const currentCost = { data: [{ currency: 'CNY', series: [
  { model: 'test-model', buckets: [{ time: 1790812800, cost: '0.125' }] },
  { model: 'test-model', buckets: [{ time: 1790812800, cost: '0.025' }] },
] }] }

test('isolated auth route, reader and platform requests share storage and expose no credentials', async t => {
  const previousHome = process.env.RIVET_HOME
  const previousFetch = globalThis.fetch
  const home = mkdtempSync(join(tmpdir(), 'insights-auth-'))
  const modeProbe = join(home, 'permission-probe')
  writeFileSync(modeProbe, '', { mode: 0o600 })
  const supportsPosixModes = process.platform !== 'win32' && (statSync(modeProbe).mode & 0o777) === 0o600
  if (!supportsPosixModes) t.diagnostic('Filesystem does not enforce POSIX modes; auth storage assertions still run')
  const headers = { authorization: 'Bearer test-sidecar-auth' }
  try {
    const router = createRouter(buildConfigRoutes('test-sidecar-auth'))
    for (const directory of ['mac-custom', 'windows-custom', 'TianshuData/.rivet']) {
      process.env.RIVET_HOME = join(home, directory)
      assert.equal(rivetHome(), join(home, directory))
      assert.equal(loadPlatformAuth(), null)
      const saved = await router('POST', '/config/deepseek/auth', { token: 'fake-account-fixture', cookies: 'fixture=yes' }, headers)
      assert.equal(saved.status, 200)
      assert.deepEqual(loadPlatformAuth(), { token: 'fake-account-fixture', cookies: 'fixture=yes' })
      assert.deepEqual((await router('GET', '/config/deepseek/auth', {}, headers)).body, { loggedIn: true })
      if (supportsPosixModes) assert.equal(statSync(join(rivetHome(), 'deepseek-platform-auth.json')).mode & 0o777, 0o600)
      globalThis.fetch = async (_url, options) => {
        assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer fake-account-fixture')
        return new Response(JSON.stringify({ biz_code: 0, biz_data: { biz_code: 40003 } }))
      }
      assert.equal((await getDeepSeekUserSummary(undefined, undefined)).failure, 'unauthorized')
      assert.equal((await getDeepSeekCostReport(undefined, undefined, 10, 2026)).failure, 'unauthorized')
      assert.equal((await router('DELETE', '/config/deepseek/auth', {}, headers)).status, 200)
      assert.equal(loadPlatformAuth(), null)
    }
    assert.equal((await router('POST', '/config/deepseek/auth', { token: {} }, headers)).status, 400)
    assert.equal((await router('POST', '/config/deepseek/auth', { token: '   ' }, headers)).status, 400)
    assert.equal((await router('GET', '/config/deepseek/auth', {}, {})).status, 401)
  } finally {
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('default roots use macOS home and Windows LOCALAPPDATA', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const previous = process.env.LOCALAPPDATA
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    assert.equal(defaultRivetHome(), join(homedir(), '.rivet'))
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.LOCALAPPDATA = join(tmpdir(), 'fixture-localappdata')
    assert.equal(defaultRivetHome(), join(process.env.LOCALAPPDATA, '.rivet'))
    delete process.env.LOCALAPPDATA
    assert.equal(defaultRivetHome(), join(homedir(), 'AppData', 'Local', '.rivet'))
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
  }
})

test('fresh reader sees persisted login; deleting is idempotent', () => {
  const previous = process.env.RIVET_HOME
  const home = mkdtempSync(join(tmpdir(), 'insights-restart-'))
  try {
    process.env.RIVET_HOME = home
    savePlatformAuth('fake-account-fixture', '')
    assert.equal(loadPlatformAuth()?.token, 'fake-account-fixture')
    clearPlatformAuth()
    clearPlatformAuth()
    assert.equal(loadPlatformAuth(), null)
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('current wallet and per-key billing shapes normalize without inventing missing metrics', () => {
  const summary = normalizeWalletSummary({ normal_wallets: [{ currency: 'CNY', balance: '12.5' }], bonus_wallets: [{ currency: 'CNY', balance: '0.5' }] })
  assert.equal(summary.balance_info.total_balance, 13)
  assert.equal(summary.balance_info.topped_up_balance, 12.5)
  assert.equal(summary.balance_info.granted_balance, 0.5)
  assert.equal(summary.estimated_available_tokens, undefined)
  assert.equal(normalizeWalletSummary({ normal_wallets: [{ currency: 'CNY', balance: '12.5' }], bonus_wallets: [], total_available_token_estimation: '1250000' }).estimated_available_tokens, 1250000)
  assert.equal(summary.current_month_cost, undefined)
  const report = normalizeKeyUsage(currentAmount, currentCost, 8 * 3600)
  assert.equal(report.total.cost_in_cents, 15)
  assert.equal(report.total.total_tokens, 121)
  const entry = report.models[0]?.usage[0]
  assert.ok(entry)
  assert.equal(entry.request_count, 2)
  assert.equal(entry.date, '2026-10-01')
  assert.throws(() => normalizeKeyUsage(currentAmount, { data: [{ currency: 'USD', series: [] }] }, 0))
  assert.throws(() => normalizeWalletSummary({ normal_wallets: [{ currency: 'CNY', balance: 'unknown' }], bonus_wallets: [] }))
  const range = platformMonthRange(10, 2026)
  assert.equal(new Date((range.start + range.tz) * 1000).toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(new Date((range.end + range.tz) * 1000).toISOString(), '2026-10-31T23:59:59.000Z')
})

test('restoring ignored inner business errors makes the unauthorized oracle fail', async () => {
  const original = readFileSync(new URL('../deepseek-platform-client.ts', import.meta.url), 'utf8')
  const mutant = original.replace("if (typeof innerCode === 'number' && innerCode !== 0)", 'if (false)')
  assert.notEqual(mutant, original)
  const module = { exports: {} as { getDeepSeekUserSummary: typeof getDeepSeekUserSummary } }
  runInNewContext(transformSync(mutant, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports,
    require: (name: string) => {
      if (name.includes('platform-auth')) return { loadPlatformAuth: () => ({ token: 'fixture', cookies: '' }) }
      if (name.includes('fetch-timeout')) return { fetchWithTimeout: async () => new Response(JSON.stringify({ biz_code: 0, biz_data: { biz_code: 40003 } })) }
      return { normalizeWalletSummary, normalizeKeyUsage, platformMonthRange }
    },
  })
  const result = await module.exports.getDeepSeekUserSummary(undefined, undefined)
  assert.throws(() => assert.equal(result.failure, 'unauthorized'))
})

test('current data envelope works and a removed legacy endpoint falls back to per-key billing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'insights-current-'))
  const previousHome = process.env.RIVET_HOME, previousFetch = globalThis.fetch
  const urls: string[] = []
  try {
    process.env.RIVET_HOME = home
    savePlatformAuth('fake-account-fixture', '')
    globalThis.fetch = async url => {
      const path = new URL(String(url)).pathname
      urls.push(path)
      if (path === '/api/v0/usage/cost') return new Response('', { status: 404 })
      const payload = path.endsWith('/amount') ? currentAmount : path.endsWith('/cost') ? currentCost : { normal_wallets: [{ currency: 'CNY', balance: '12.5' }], bonus_wallets: [] }
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: payload } }))
    }
    assert.equal((await getDeepSeekUserSummary(undefined, undefined)).data?.balance_info.total_balance, 12.5)
    assert.equal((await getDeepSeekCostReport(undefined, undefined, 10, 2026)).data?.total.cost_in_cents, 15)
    assert.ok(urls.includes('/api/v0/usage/by_api_key/amount'))
    assert.ok(urls.includes('/api/v0/usage/by_api_key/cost'))
    globalThis.fetch = async url => {
      const path = new URL(String(url)).pathname
      if (path === '/api/v0/usage/cost') return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: {} } }))
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: path.endsWith('/amount') ? currentAmount : currentCost } }))
    }
    assert.equal((await getDeepSeekCostReport(undefined, undefined, 10, 2026)).data?.total.cost_in_cents, 15, 'HTTP 200 malformed legacy endpoint also falls back')
    globalThis.fetch = async () => new Response('', { status: 401 })
    urls.length = 0
    assert.equal((await getDeepSeekCostReport(undefined, undefined, 10, 2026)).failure, 'unauthorized')
  } finally {
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
