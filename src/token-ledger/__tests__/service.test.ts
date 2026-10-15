/**
 * TokenLedgerService 测试：同步编排（refresh→digest 判重→推送→回执）、
 * 配置/env 解析、autoSync 开关。fetch 注入打桩，不出网。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema, type Config } from '../../config/schema.js'
import { TokenLedgerService } from '../service.js'
import type { FetchLike } from '../forum-sync.js'

const T0 = Date.parse('2026-10-10T10:00:00')
const tmpRoots: string[] = []

after(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeConfig(tokenLedger?: Record<string, unknown>): Config {
  return configSchema.parse({
    provider: { default: 'deepseek', providers: {} },
    ...(tokenLedger ? { tokenLedger } : {}),
  })
}

function setup(name: string, tokenLedger?: Record<string, unknown>) {
  const base = mkdtempSync(join(tmpdir(), `token-ledger-svc-${name}-`))
  tmpRoots.push(base)
  const sessionsRoot = join(base, 'sessions')
  const logDir = join(sessionsRoot, 'proj', 'sess-1')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'cache-log.jsonl')
  writeFileSync(logFile, JSON.stringify({
    t: T0, turn: 1, model: 'deepseek-flash', provider: 'deepseek',
    input: 1000, cacheRead: 800, cacheCreate: 0, output: 100,
  }) + '\n')
  return {
    logFile,
    makeService: (over: { fetchImpl?: FetchLike } = {}) => new TokenLedgerService(makeConfig(tokenLedger), {
      statePath: join(base, 'ledger.json'),
      sessionsRoot,
      now: () => T0 + 86_400_000,
      ...over,
    }),
  }
}

function okFetch(calls: Array<{ body?: string }>): FetchLike {
  return async (_url, init) => {
    calls.push({ body: init?.body })
    return { status: 200, text: async () => '{"ok":true,"stale":false}' }
  }
}

test('未配置 endpoint：syncNow 跳过 no_endpoint，refresh 仍执行', async () => {
  const fx = setup('no-endpoint')
  const svc = fx.makeService()
  const outcome = await svc.syncNow()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.skipped, 'no_endpoint')
  assert.equal(outcome.newRows, 1) // 本地台账照常被折叠
  assert.equal(svc.status().totals.requests, 1)
})

test('推送成功：载荷上达、回执落盘、pending 翻转', async () => {
  const fx = setup('push-ok', { forum: { endpoint: 'https://forum.example.com/api/token-usage', apiKey: 'k' } })
  const calls: Array<{ body?: string }> = []
  const svc = fx.makeService({ fetchImpl: okFetch(calls) })

  const outcome = await svc.syncNow()
  assert.equal(outcome.ok, true)
  assert.equal(outcome.newRows, 1)
  assert.equal(calls.length, 1)

  const body = JSON.parse(calls[0]!.body ?? '{}')
  assert.equal(body.version, 2)
  assert.equal(body.totals.requests, 1)
  assert.equal(body.days[0].date, '2026-10-10')

  const status = svc.status()
  assert.equal(status.pending, false)
  assert.equal(status.endpointConfigured, true)
  assert.ok(status.lastPushAt)
  assert.equal(status.lastPushResult?.ok, true)
})

test('无变更不重复推送；新增行后再次推送', async () => {
  const fx = setup('dedupe-push', { forum: { endpoint: 'https://forum.example.com/x', apiKey: 'fixture' } })
  const calls: Array<{ body?: string }> = []
  const svc = fx.makeService({ fetchImpl: okFetch(calls) })

  await svc.syncNow()
  assert.equal(calls.length, 1)

  const again = await svc.syncNow()
  assert.equal(again.skipped, 'unchanged')
  assert.equal(calls.length, 1)

  appendFileSync(fx.logFile, JSON.stringify({
    t: T0, turn: 2, model: 'deepseek-flash', provider: 'deepseek',
    input: 500, cacheRead: 0, cacheCreate: 0, output: 50,
  }) + '\n')
  const third = await svc.syncNow()
  assert.equal(third.ok, true)
  assert.equal(third.skipped, undefined)
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1]!.body ?? '{}').totals.requests, 2)
})

test('推送失败：不钉摘要、pending 保持、下次重推（幂等累计快照）', async () => {
  const fx = setup('push-fail', { forum: { endpoint: 'https://forum.example.com/x', apiKey: 'fixture' } })
  let failing = true
  const fetchImpl: FetchLike = async () => ({
    status: failing ? 500 : 200,
    text: async () => '{"ok":true,"stale":false}',
  })
  const svc = fx.makeService({ fetchImpl })

  // 客户端自带一次重试，整趟（含重试）持续 500 才算本趟失败
  const first = await svc.syncNow()
  assert.equal(first.ok, false)
  assert.equal(svc.status().pending, true)
  assert.equal(svc.status().lastPushResult?.ok, false)

  failing = false
  const second = await svc.syncNow()
  assert.equal(second.ok, true)
  assert.equal(svc.status().pending, false)
})

test('RIVET_FORUM_API env 覆盖 config endpoint', async () => {
  const prev = process.env.RIVET_FORUM_API
  process.env.RIVET_FORUM_API = 'https://env-forum.example.com/push'
  try {
    const fx = setup('env-override', { forum: { apiKey: 'fixture' } })
    const seen: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url)
      return { status: 200, text: async () => '{"ok":true,"stale":false}' }
    }
    const svc = fx.makeService({ fetchImpl })
    const outcome = await svc.syncNow()
    assert.equal(outcome.ok, true)
    assert.deepEqual(seen, ['https://env-forum.example.com/push'])
  } finally {
    if (prev === undefined) delete process.env.RIVET_FORUM_API
    else process.env.RIVET_FORUM_API = prev
  }
})

test('enabled=false：refresh 与 syncNow 都短路', async () => {
  const fx = setup('disabled', { enabled: false, forum: { endpoint: 'https://x.example.com' } })
  const svc = fx.makeService()
  const refresh = await svc.refresh()
  assert.equal(refresh.newRows, 0)
  const outcome = await svc.syncNow()
  assert.deepEqual(outcome, { ok: false, skipped: 'disabled' })
  assert.equal(svc.status().totals.requests, 0)
})

test('startAutoSync：缺 endpoint 或 autoSync!=true 不启动；齐全才启动', async () => {
  const noEndpoint = setup('auto-1').makeService()
  assert.equal(noEndpoint.startAutoSync(), false)

  const noAuto = setup('auto-2', { forum: { endpoint: 'https://x.example.com' } }).makeService()
  assert.equal(noAuto.startAutoSync(), false)

  const full = setup('auto-3', { forum: { endpoint: 'https://x.example.com', apiKey: 'fixture', autoSync: true, intervalMinutes: 60 } }).makeService()
  assert.equal(full.startAutoSync(), true)
  assert.equal(full.status().autoSync, true)
  assert.equal(full.startAutoSync(), false) // 幂等：已启动不重复建定时器
  full.stopAutoSync()
  assert.equal(full.status().autoSync, false)
})

test('shutdownFlush：autoSync 运行时推最后一趟并停止计时器', async () => {
  const fx = setup('flush', { forum: { endpoint: 'https://x.example.com', apiKey: 'fixture', autoSync: true, intervalMinutes: 60 } })
  const calls: Array<{ body?: string }> = []
  const svc = fx.makeService({ fetchImpl: okFetch(calls) })
  svc.startAutoSync()
  await svc.shutdownFlush(30_000)
  assert.equal(calls.length, 1)
  assert.equal(svc.status().autoSync, false)
})


test('usage added during upload remains pending until the next snapshot', async () => {
  const fx = setup('upload-race', { forum: { endpoint: 'https://forum.example.com/x', apiKey: 'fixture' } })
  let svc: TokenLedgerService
  let uploadedInput = 0
  svc = fx.makeService({ fetchImpl: async (_url, init) => {
    uploadedInput = JSON.parse(init?.body ?? '{}').totals.input
    appendFileSync(fx.logFile, JSON.stringify({ t: T0, turn: 2, model: 'deepseek-flash', input: 500, output: 50 }) + '\n')
    await svc.refresh()
    return { status: 200, text: async () => '{"ok":true,"stale":false}' }
  } })
  assert.equal((await svc.syncNow()).ok, true)
  assert.equal(uploadedInput, 1000)
  assert.equal(svc.status().totals.input, 1500)
  assert.equal(svc.status().pending, true)
})

test('key rotation resends the same device cumulative history once', async () => {
  const fx = setup('rotation', { forum: { endpoint: 'https://forum.example.com/x', apiKey: 'fixture-old' } })
  const calls: Array<{ body?: string }> = []
  const svc = fx.makeService({ fetchImpl: okFetch(calls) })
  await svc.syncNow()
  const device = svc.status().deviceId
  svc.reconfigure(makeConfig({ forum: { endpoint: 'https://forum.example.com/x', apiKey: 'fixture-new' } }))
  assert.equal(svc.status().pending, true)
  assert.equal((await svc.syncNow()).ok, true)
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1]!.body ?? '{}').deviceId, device)
  assert.equal(JSON.parse(calls[1]!.body ?? '{}').totals.input, 1000)
  assert.equal((await svc.syncNow()).skipped, 'unchanged')
})

test('shutdown without upload opt-in still persists local consumption', async () => {
  const fx = setup('local-exit', { forum: { apiKey: 'fixture-only-sync-key', autoSync: false } })
  const calls: Array<{ body?: string }> = []
  await fx.makeService({ fetchImpl: okFetch(calls) }).shutdownFlush(30_000)
  assert.equal(calls.length, 0, 'a saved key alone must never upload on exit')
  const reopened = fx.makeService()
  assert.equal(reopened.status().totals.input, 1000)
})


test('shutdown deadline aborts a stalled upload without waiting for its response', async () => {
  const fx = setup('shutdown-abort', { forum: { endpoint: 'https://forum.example.com/x', apiKey: 'fixture', autoSync: true } })
  let entered!: () => void
  const fetching = new Promise<void>(resolve => { entered = resolve })
  let aborted = false
  const svc = fx.makeService({ fetchImpl: async (_url, init) => {
    entered()
    await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      aborted = true
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true }))
    return { status: 200, text: async () => '{"ok":true,"stale":false}' }
  } })
  svc.startAutoSync()
  const syncing = svc.syncNow()
  await fetching
  const start = Date.now()
  await svc.shutdownFlush(25)
  assert.equal(aborted, true)
  assert.ok(Date.now() - start < 1000)
  assert.equal((await syncing).ok, false)
  assert.equal(svc.status().pending, true)
  assert.equal(svc.status().autoSync, false)
})


test('disconnect cancels the in-flight credential before any retry', async () => {
  const fx = setup('disconnect-in-flight', { forum: { endpoint: 'https://forum.example.com/x', apiKey: 'fixture' } })
  let entered!: () => void
  const fetching = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  let signal: AbortSignal | undefined
  let svc: TokenLedgerService
  svc = fx.makeService({ fetchImpl: async (_url, init) => {
    calls++
    signal = init?.signal
    entered()
    await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    return { status: 500, text: async () => '{}' }
  } })
  const pending = svc.syncNow()
  await fetching
  svc.reconfigure(makeConfig({ forum: { endpoint: 'https://forum.example.com/x', autoSync: false } }))
  assert.equal(signal?.aborted, true)
  assert.equal((await pending).ok, false)
  assert.equal(calls, 1)
  assert.equal(svc.status().pending, true)
})


test('personal sync key alone uses the formal default endpoint', async () => {
  const fx = setup('formal-default', { forum: { apiKey: 'fixture-key' } })
  const urls: string[] = []
  const svc = fx.makeService({ fetchImpl: async url => { urls.push(url); return { status: 200, text: async () => '{"ok":true,"stale":false}' } } })
  assert.equal((await svc.syncNow()).ok, true)
  assert.deepEqual(urls, ['https://tianshuharness.com/token/v1/token-usage'])
})

test('immediate sync after key rotation waits for the cancelled generation and uploads with the new key', async () => {
  const fx = setup('rotation-in-flight', { forum: { apiKey: 'fixture-old' } })
  let entered!: () => void
  const fetching = new Promise<void>(resolve => { entered = resolve })
  const keys: string[] = []
  const svc = fx.makeService({ fetchImpl: async (_url, init) => {
    keys.push(init?.headers?.Authorization ?? '')
    if (keys.length === 1) {
      entered()
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    }
    return { status: 200, text: async () => '{"ok":true,"stale":false}' }
  } })
  const old = svc.syncNow()
  await fetching
  svc.reconfigure(makeConfig({ forum: { apiKey: 'fixture-new' } }))
  const results = await Promise.all([svc.syncNow(), svc.syncNow()])
  assert.equal((await old).ok, false)
  assert.ok(results.every(result => result.ok))
  assert.deepEqual(keys, ['Bearer fixture-old', 'Bearer fixture-new'])
  assert.equal(svc.status().pending, false)
})

test('shutdown deadline also cancels a rotated sync queued behind delayed receipt persistence', async () => {
  const fx = setup('queued-shutdown', { forum: { apiKey: 'fixture-old', autoSync: true } })
  let entered!: () => void, persisting!: () => void, release!: () => void
  const fetching = new Promise<void>(resolve => { entered = resolve })
  const receiptStarted = new Promise<void>(resolve => { persisting = resolve })
  const receiptGate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const svc = fx.makeService({ fetchImpl: async (_url, init) => {
    calls++
    if (calls === 1) {
      entered()
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    }
    return { status: 200, text: async () => '{"ok":true,"stale":false}' }
  } })
  const store = (svc as unknown as { store: { markPushed: (...args: unknown[]) => Promise<void> } }).store
  const mark = store.markPushed.bind(store)
  store.markPushed = async (...args) => { persisting(); await receiptGate; await mark(...args) }
  svc.startAutoSync()
  const old = svc.syncNow()
  await fetching
  svc.reconfigure(makeConfig({ forum: { apiKey: 'fixture-new', autoSync: true } }))
  await receiptStarted
  const queued = svc.syncNow()
  await svc.shutdownFlush(20)
  release()
  await old
  assert.equal((await queued).ok, false)
  assert.equal(calls, 1)
  assert.equal(svc.status().pending, true)
  assert.equal(svc.status().autoSync, false)
})


test('shutdown with automatic upload disabled still aborts a stalled manual sync at its deadline', async () => {
  let entered!: () => void
  const fetching = new Promise<void>(resolve => { entered = resolve })
  let signal: AbortSignal | undefined
  let calls = 0
  const svc = new TokenLedgerService(makeConfig({ forum: { apiKey: 'fixture-manual-key', autoSync: false } }), {
    fetchImpl: async (_url, init) => {
      calls++
      signal = init?.signal
      entered()
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      return { status: 200, text: async () => '{"ok":true,"stale":false}' }
    },
  })
  const totals = { requests: 1, input: 1000, output: 100, cacheRead: 0, cacheCreate: 0, cost: 0 }
  // Persistence is isolated so its timing cannot accidentally trigger the deadline branch.
  ;(svc as unknown as { store: unknown }).store = {
    refresh: async () => ({ newRows: 0, scannedFiles: 0 }),
    digest: () => 'fixture-digest',
    prepareSyncBatch: async () => ({digest:'fixture-digest',nextPage:0,pageCount:1}),
    nextSyncPage: async () => ({ index:0, snapshot: {
      version: 1, deviceId: 'fixture-device', deviceName: 'fixture-device', sentAt: new Date(T0).toISOString(), totals,
      days: [{ date: '2026-10-10', model: 'fixture-model', ...totals }],
    } }),
    markPushed: async () => {},
  }
  const manual = svc.syncNow()
  await fetching
  try {
    const start = Date.now()
    await svc.shutdownFlush(25)
    assert.equal(signal?.aborted, true)
    assert.ok(Date.now() - start < 1000)
    assert.equal((await manual).ok, false)
    assert.equal(calls, 1)
  } finally {
    // Ensure the RED run also settles its intentionally stalled fetch.
    ;(svc as unknown as { syncAbort?: AbortController }).syncAbort?.abort()
    await manual
  }
})


test('shutdown invalidates an existing rotated sync queue before its active sync settles early', async () => {
  let entered!: () => void, persisted!: () => void, release!: () => void
  const fetching = new Promise<void>(resolve => { entered = resolve })
  const receiptStarted = new Promise<void>(resolve => { persisted = resolve })
  const receiptGate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const svc = new TokenLedgerService(makeConfig({ forum: { apiKey: 'fixture-old', autoSync: false } }), {
    fetchImpl: async (_url, init) => {
      calls++
      if (calls === 1) {
        entered()
        await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      }
      return { status: 200, text: async () => '{"ok":true,"stale":false}' }
    },
  })
  const totals = { requests: 1, input: 1000, output: 100, cacheRead: 0, cacheCreate: 0, cost: 0 }
  ;(svc as unknown as { store: unknown }).store = {
    refresh: async () => ({ newRows: 0, scannedFiles: 0 }),
    digest: () => 'fixture-digest',
    prepareSyncBatch: async () => ({digest:'fixture-digest',nextPage:0,pageCount:1}),
    nextSyncPage: async () => ({ index:0, snapshot: {
      version: 1, deviceId: 'fixture-device', deviceName: 'fixture-device', sentAt: new Date(T0).toISOString(), totals,
      days: [{ date: '2026-10-10', model: 'fixture-model', ...totals }],
    } }),
    markPushed: async () => { if (calls === 1) { persisted(); await receiptGate } },
  }
  const old = svc.syncNow()
  await fetching
  svc.reconfigure(makeConfig({ forum: { apiKey: 'fixture-new', autoSync: false } }))
  await receiptStarted
  const queued = svc.syncNow()
  const shutdown = svc.shutdownFlush(1000)
  release()
  await shutdown
  await old
  assert.equal((await queued).ok, false)
  assert.equal(calls, 1)
})
