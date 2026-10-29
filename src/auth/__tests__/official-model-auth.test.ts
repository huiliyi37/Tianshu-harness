import { createServer } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountDeviceFingerprint } from '../account-device.js'
import { accountStore, checkDeviceOnce, saveAccountToken, saveAccountIdentity, saveAccountProfile, revokeAccountSession } from '../account.js'

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
test('late account metadata cannot overwrite logout and a different or same-token new login', () => {
  const home = mkdtempSync(join(tmpdir(), 'official-account-cas-'))
  try {
    const store = accountStore(home)
    for (const nextToken of ['account-B', 'account-A']) {
      store.save({ accessToken: 'account-A', expiresAt: Date.now() + 3600000 })
      const old = store.load()!
      store.clear()
      store.save({ accessToken: nextToken, expiresAt: Date.now() + 3600000 })
      saveAccountIdentity(store, old, { stellarId: 'OLD', primaryDomain: 'FU', title: 'old' })
      saveAccountProfile(store, old, { avatarUrl: 'https://old.invalid/a', founding: null, fetchedAt: 1 })
      assert.equal(store.load()?.accessToken, nextToken)
      assert.equal(store.load()?.identity, undefined)
      assert.equal(store.load()?.profile, undefined)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('damaged encryption envelope cannot become a plaintext account', () => {
  const home = mkdtempSync(join(tmpdir(), 'official-account-cipher-'))
  try {
    writeFileSync(join(home, 'account.json'), JSON.stringify({ v: 1, s: 'broken', d: 'bad', accessToken: 'injected', expiresAt: 42 }))
    assert.equal(accountStore(home).load(), null)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

}


const owners = {
  A: { subject: '11111111-1111-4111-8111-111111111111', sid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  B: { subject: '22222222-2222-4222-8222-222222222222', sid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
}
const device = 'fixture-device-12345'
export const fixtureConfiguration = { gatewayOrigin: 'https://gateway.invalid', gatewayOrigins: ['https://gateway.invalid'], checkoutOrigins: ['https://pay.invalid'] }
const rates = { input: { money: { currency: 'CNY', amount: '2' }, perTokens: 1000000 }, output: { money: { currency: 'CNY', amount: '8' }, perTokens: 1000000 }, cacheRead: { money: { currency: 'CNY', amount: '0.04' }, perTokens: 1000000 } }
export const fixtureCatalog = { revision: 'catalog-1', models: [{ id: 'fixture-model', displayName: 'Fixture', provider: 'Fixture', status: 'available', contextWindow: 32000, maxOutputTokens: 4000, capabilities: { tools: true, vision: null, websocket: false }, bindings: [{ id: 'chat-1', modelId: 'fixture-model', operation: 'chat', protocol: 'openai', origin: 'https://gateway.invalid', path: '/v1/chat/completions', stream: true, capabilities: { tools: true }, requiredHeaders: { 'content-type': 'application/json' }, thinkingPolicy: '', pricingRevision: 'price-1' }], costStatus: 'unavailable' }] }
export const quota = (amount: string) => ({ unit: 'quota', amount, conversionRevision: 'conversion-1' })
export const fixtureSummary = () => ({version:2,mode:'package',revision:'a'.repeat(64),membership:{tier:'none',status:'inactive',expiresAt:null},subscription:{subscriptionId:null,currentCycle:null,paidFutureCycles:[],nextProductId:null,nextProductRevision:null,renewalMode:'manual',cancelAtPeriodEnd:false,revision:'s1'},quotaBar:{percent:null,state:'unavailable'}})

const accountProxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const
const accountEnvironmentKeys = ['RIVET_ACCOUNT_API', 'RIVET_ACCOUNT_ANON_KEY', 'RIVET_NO_SYSTEM_PROXY', ...accountProxyKeys] as const
let accountEnvironmentLease: { users: number; previous: Map<typeof accountEnvironmentKeys[number], string | undefined> } | undefined

function acquireAccountEnvironment() {
  const lease = accountEnvironmentLease ?? { users: 0, previous: new Map(accountEnvironmentKeys.map(key => [key, process.env[key]])) }
  accountEnvironmentLease = lease
  lease.users += 1
  process.env.RIVET_ACCOUNT_API = 'https://account-fixture.invalid'
  process.env.RIVET_ACCOUNT_ANON_KEY = 'synthetic-official-auth-anon'
  process.env.RIVET_NO_SYSTEM_PROXY = '1'
  for (const key of accountProxyKeys) delete process.env[key]
  let released = false
  return () => {
    if (released) return
    released = true
    lease.users -= 1
    if (lease.users !== 0) return
    for (const [key, value] of lease.previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    accountEnvironmentLease = undefined
  }
}

export async function officialFixture() {
  const home = mkdtempSync(join(tmpdir(), 'official-broker-http-'))
  let setupComplete = false
  let cleanupServer = () => {}
  try {
  const signingSecret = randomUUID()
  const requests: Array<{ path: string; body: Record<string, unknown>; authorization: string; originalUrl?: string }> = []
  const grants = new Map<string, { owner: keyof typeof owners; requestId: string }>()
  const cancelled = new Set<string>()
  let bootstrapCalls = 0, rotations = 0
  const ended: Array<{ sid: string; deleted: boolean }> = []
  const loginCounts = new Map<string, number>()
  let lastPoll: Awaited<ReturnType<typeof checkDeviceOnce>> | undefined
  let beforeReply: ((path: string, body: Record<string, unknown>) => Promise<void>) | undefined
  let override: ((path: string, body: Record<string, unknown>, data: unknown) => { status?: number; data?: unknown; error?: unknown } | undefined) | undefined
  const tokens = new Map<string, { owner: keyof typeof owners; type: string; sid: string }>()
  const current = new Map<string, string>()
  const token = (owner: keyof typeof owners, type: string, sid = owners[owner].sid) => {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: owners[owner].subject, session_id: sid, role: 'authenticated', type, exp: Math.floor(Date.now() / 1000) + 3600, nonce: randomUUID() })).toString('base64url')
    const signature = createHmac('sha256', signingSecret).update(`${head}.${payload}`).digest('base64url')
    const value = `${head}.${payload}.${signature}`
    tokens.set(value, { owner, type, sid }); current.set(`${sid}/${type}`, value)
    return value
  }
  const validate = (value: string, expected: string, requireCurrent = true) => {
    const parts = value.split('.')
    assert.equal(parts[2], createHmac('sha256', signingSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url'), 'synthetic trusted server verifies signature')
    const found = tokens.get(value)
    assert.equal(found?.type, expected)
    if (requireCurrent) assert.equal(current.get(`${found!.sid}/${expected}`), value, 'device current hash fence')
    return found!
  }
  const server = createServer(async (req, res) => {
    try {
      // Reject foreign credentials before collecting even one request-body byte.
      const path = req.url!, authorization = req.headers.authorization ?? ''
      const bearer = authorization.replace(/^Bearer /, '')
      if (path.endsWith('/tui-auth-check') || path.endsWith('/tui-auth-end')) {
        assert.equal(req.headers.apikey, process.env.RIVET_ACCOUNT_ANON_KEY)
        assert.ok(process.env.RIVET_ACCOUNT_ANON_KEY?.startsWith('synthetic-'))
      } else if (path.endsWith('/catalog') || path.endsWith('/model-quote')) assert.ok(grants.has(bearer))
      else validate(bearer, path.endsWith('/tui-auth-refresh') ? 'refresh' : 'access')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
      requests.push({ path, body, authorization })
      let data: unknown, requestId = typeof body.requestId === 'string' ? body.requestId : 'catalog-read'
      if (path.endsWith('/tui-auth-check')) {
        const owner = body.deviceCode as keyof typeof owners
        const count = loginCounts.get(owner) ?? 0; loginCounts.set(owner, count + 1)
        const sid = count ? randomUUID() : owners[owner].sid
        data = { status: 'approved', accessToken: token(owner, 'access', sid), refreshToken: token(owner, 'refresh', sid), expiresIn: 3600 }
      } else if (path.endsWith('/tui-auth-refresh')) {
        const source = validate(bearer, 'refresh'); rotations++
        data = { accessToken: token(source.owner, 'access', source.sid), refreshToken: token(source.owner, 'refresh', source.sid), expiresIn: 3600 }
      } else if (path.endsWith('/tui-auth-end')) {
        const source = validate(String(body.accessToken), 'access', false)
        const deleted = current.get(`${source.sid}/access`) === body.accessToken
        if (deleted) { current.delete(`${source.sid}/access`); current.delete(`${source.sid}/refresh`) }
        ended.push({ sid: source.sid, deleted }); data = { ok: true }
      } else if (path.endsWith('/tui-model-bootstrap')) {
        const source = validate(bearer, 'access'), owner = source.owner; bootstrapCalls++
        assert.deepEqual(Object.keys(body).sort(), body.transport === 'direct' ? ['deviceId', 'requestId', 'transport'] : ['deviceId', 'requestId']); assert.equal(body.deviceId, device)
        const credential = `sk-fixture-${requestId}`
        grants.set(credential, { owner, requestId })
        data = body.transport === 'direct'
          ? { credential: `sk-synthetic-direct-${owner}`, subject: owners[owner].subject, accountSessionId: source.sid, expiresAt: new Date(Date.now() + 300000).toISOString(), catalogRevision: 'catalog-1', bindingId: 'chat-1', modelId: 'fixture-model', protocol: 'openai', origin: 'https://supplier.invalid', path: '/v1/chat/completions' }
          : { credential, subject: owners[owner].subject, accountSessionId: source.sid, generation: bootstrapCalls, expiresAt: new Date(Date.now() + 300000).toISOString(), catalogRevision: 'catalog-1' }
      } else if (path.endsWith('/tui-model-bootstrap-cancel')) {
        const owner = validate(bearer, 'access').owner
        assert.deepEqual(Object.keys(body), ['requestId']); cancelled.add(`${owner}/${requestId}`); data = { queued: true }
      } else if (path.endsWith('/tui-model-account')) {
        const owner = validate(bearer, 'access').owner
        assert.deepEqual(Object.keys(body).sort(), ['input', 'op', 'requestId', 'version']);assert.equal(body.version,2)
        data = body.op === 'view.get' ? fixtureSummary() : body.op === 'catalog.list' ? fixtureCatalog : { revision: 'products-1', items: [] }
      } else if (path.endsWith('/catalog')) {
        assert.ok(grants.has(bearer)); data = fixtureCatalog
      } else if (path.endsWith('/model-quote')) {
        assert.ok(grants.has(bearer)); assert.deepEqual(Object.keys(body).sort(), ['bindingId', 'catalogRevision', 'pricingRevision', 'requestId'])
        assert.equal(body.bindingId, 'chat-1'); assert.equal(body.catalogRevision, 'catalog-1'); assert.equal(body.pricingRevision, 'price-1')
        data = { quoteId: randomUUID(), modelId: 'fixture-model', bindingId: 'chat-1', pricingRevision: 'price-1', calendarRevision: 'calendar-1', tier: 'standard', period: 'fixed', timezone: 'Asia/Shanghai', asOf: new Date().toISOString(), validUntil: new Date(Date.now() + 30000).toISOString(), kind: 'opaque', costStatus:'unavailable' }
      } else throw Error('unexpected endpoint')
      await beforeReply?.(path, body)
      const changed = override?.(path, body, data)
      res.writeHead(changed?.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(path.includes('/tui-auth-') ? changed?.data ?? data : { version: path.includes('/customer/') || path.endsWith('/tui-model-account') ? 2 : 1, requestId, ...(changed?.error ? { error: changed.error } : { data: changed?.data ?? data }) }))
    } catch { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: 1, requestId: '', error: { code: 'auth_required', message: 'auth_required', retryable: false } })) }
  })
  cleanupServer = () => { server.closeAllConnections(); if (server.listening) server.close() }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address() as { port: number }
  const endpoint = `http://127.0.0.1:${address.port}`
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input)); urls.push(u.href)
    assert.equal(u.protocol, 'https:'); assert.equal(init?.redirect, 'error')
    return fetch(endpoint + u.pathname, init)
  }
  accountDeviceFingerprint(home, device)
  const install = async (owner: keyof typeof owners) => {
    const store = accountStore(home)
    const intent = store.beginLogin(device)
    const poll = await checkDeviceOnce(owner, { fetchImpl }); lastPoll = poll
    return saveAccountToken(store, poll, { intent, deviceId: device })
  }
  const broker = async (configuration: import('../official-model-auth.js').OfficialConfiguration = fixtureConfiguration) => (await import('../official-model-auth.js')).createOfficialModelBroker({ home, configuration, fetchImpl })
  const releaseEnvironment = acquireAccountEnvironment()
  setupComplete = true
  return { home, endpoint, fetchImpl, broker, install, requests, urls, cancelled, grants, ended, get lastPoll() { return lastPoll! }, get bootstrapCalls() { return bootstrapCalls }, get rotations() { return rotations }, setBeforeReply(fn: typeof beforeReply) { beforeReply = fn }, setOverride(fn: typeof override) { override = fn }, async close() {
    try { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    finally {
      releaseEnvironment()
      rmSync(home, { recursive: true, force: true })
    }
  } }
  } finally {
    if (!setupComplete) {
      cleanupServer()
      rmSync(home, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('official_refresh_is_singleflight_and_cross_process_safe: twenty calls share one real HTTP grant', async () => {
    const f = await officialFixture()
    try {
      await f.install('A'); const broker = await f.broker(); const identity = broker.captureOfficialIdentity()!
      const credentials = await Promise.all(Array.from({ length: 20 }, () => broker.getOfficialCredential(identity)))
      assert.equal(f.bootstrapCalls, 1); assert.equal(new Set(credentials.map(c => c.credential)).size, 1)
      const quote = await broker.getOfficialPriceQuote(identity, { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' })
      assert.ok(quote.quoteId); assert.equal(quote.kind, 'opaque'); assert.equal(quote.rates, undefined)
      const status = await broker.syncOfficialAccess(identity)
      assert.equal(status.customerView?.mode, 'package'); assert.equal(Object.hasOwn(status, 'balance'), false)
      assert.equal(JSON.stringify(status).includes(credentials[0]!.credential), false)
      assert.equal(JSON.stringify(await broker.getOfficialCatalog(identity, 'agent')).includes(quote.quoteId), false)
    } finally { await f.close() }
  })

  test('late_bootstrap_does_not_overwrite_new_account and cancels only original source receipt', async () => {
    const f = await officialFixture()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    try {
      await f.install('A'); const broker = await f.broker(); const old = broker.captureOfficialIdentity()!
      f.setBeforeReply(async path => { if (path.endsWith('/tui-model-bootstrap')) { entered(); await barrier } })
      const pending = broker.getOfficialCredential(old); const rejected = assert.rejects(pending, /account_changed/)
      await waiting; accountStore(f.home).clear(); await f.install('B'); release(); await rejected
      assert.equal(broker.captureOfficialIdentity()?.subject, owners.B.subject)
      assert.equal(f.cancelled.size, 1); assert.ok([...f.cancelled][0]!.startsWith('A/'))
      assert.equal(f.requests.some(r => r.path.endsWith('/tui-auth-end')), false)
    } finally { release?.(); await f.close() }
  })

  test('Fix1 stale catalog quote preserves gateway HTTP409 and rejects unsupported status combinations', async () => {
    const f = await officialFixture()
    try {
      const installed = await f.install('A'), b = await f.broker(), identity = b.captureOfficialIdentity()!
      await b.getOfficialCatalog(identity, 'agent')
      const input = { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }
      // The caller and cached catalog still agree on rev1, while the producer has rev2.
      const currentRevision = 'catalog-2'
      f.setOverride((path, body) => path.endsWith('/model-quote') && body.catalogRevision !== currentRevision ? { status: 409, error: { code: 'catalog_unavailable', retryable: false, message: 'sk-private-revision' } } : undefined)
      await assert.rejects(b.getOfficialPriceQuote(identity, input), error => {
        assert.equal((error as any).status, 409); assert.equal((error as any).code, 'catalog_unavailable')
        assert.deepEqual((error as any).publicError(), { code: 'catalog_unavailable', message: 'catalog_unavailable', retryable: false }); return true
      })
      assert.equal(f.requests.filter(r => r.path.endsWith('/model-quote')).length, 1)
      assert.equal(f.requests.filter(r => r.path.endsWith('/catalog')).length, 1)
      for (const [status, code, expected] of [[403, 'credential_revoked', 'credential_revoked'], [403, 'model_unavailable', 'model_unavailable'], [503, 'catalog_unavailable', 'catalog_unavailable'], [401, 'credential_revoked', 'service_error'], [418, 'catalog_unavailable', 'service_error'], [200, 'pricing_changed', 'service_error']] as const) {
        f.setOverride(path => path.endsWith('/model-quote') ? { status, error: { code, retryable: false, message: 'raw-secret' } } : undefined)
        await assert.rejects(b.getOfficialPriceQuote(identity, input), error => { assert.equal((error as any).code, expected); assert.equal((error as any).status, expected === 'service_error' ? 503 : status); return true })
      }
      f.setOverride(path => path.endsWith('/model-quote') ? { status: 201 } : undefined)
      await assert.rejects(b.getOfficialPriceQuote(identity, input), /service_error/)
      assert.equal(accountStore(f.home).load()?.accessToken, installed.accessToken)
      assert.equal(f.ended.length, 0); assert.equal(f.cancelled.size, 0)
    } finally { await f.close() }
  })

  test('Fix1 bootstrap validates the W1 transport error mapping independently of account and gateway', async () => {
    const f = await officialFixture()
    try {
      const installed = await f.install('A'), b = await f.broker(), identity = b.captureOfficialIdentity()!
      for (const [status, code, retryable, expected] of [[401, 'account_changed', false, 'account_changed'], [503, 'service_error', true, 'service_error'], [400, 'invalid_request', false, 'invalid_request'], [409, 'account_changed', false, 'service_error'], [200, 'auth_required', false, 'service_error']] as const) {
        f.setOverride(path => path.endsWith('/tui-model-bootstrap') ? { status, error: { code, retryable, message: 'sk-private-bootstrap' } } : undefined)
        await assert.rejects(b.getOfficialCredential(identity), error => {
          assert.equal((error as any).code, expected); assert.equal((error as any).status, expected === 'service_error' ? 503 : status)
          assert.equal(String(error).includes('sk-private'), false); return true
        })
      }
      assert.equal(accountStore(f.home).load()?.accessToken, installed.accessToken)
    } finally { await f.close() }
  })

  test('real quote HTTP preserves pricing errors and discards aborted and switched-account results', async () => {
    const f = await officialFixture()
    try {
      await f.install('A'); const b = await f.broker(); const identity = b.captureOfficialIdentity()!
      await b.getOfficialCatalog(identity, 'agent')
      f.setOverride(path => path.endsWith('/model-quote') ? { status: 409, error: { code: 'pricing_changed', message: 'sk-untrusted-diagnostic', retryable: false } } : undefined)
      await assert.rejects(b.getOfficialPriceQuote(identity, { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }), error => (error as {code: string}).code === 'pricing_changed' && !String(error).includes('sk-untrusted'))
      f.setOverride(undefined)
      const controller = new AbortController(); controller.abort()
      await assert.rejects(b.getOfficialPriceQuote(identity, { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }, controller.signal))
      f.setBeforeReply(async path => { if (path.endsWith('/model-quote')) await f.install('B') })
      await assert.rejects(b.getOfficialPriceQuote(identity, { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }), /account_changed/)
    } finally { await f.close() }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('account refresh installs one new token while preserving concurrent profile data', async () => {
    const f = await officialFixture()
    try {
      const original = await f.install('A')
      f.setBeforeReply(async path => { if (path.endsWith('/tui-auth-refresh')) saveAccountProfile(accountStore(f.home), original, { avatarUrl: 'https://fixture.invalid/current', founding: null, fetchedAt: Date.now() }) })
      const { refreshAccountSession } = await import('../refresh.js')
      const replies = await Promise.all(Array.from({ length: 20 }, () => refreshAccountSession(accountStore(f.home), original, { fetchImpl: f.fetchImpl })))
      assert.equal(f.rotations, 1)
      assert.equal(accountStore(f.home).load()?.profile?.avatarUrl, 'https://fixture.invalid/current')
      assert.notEqual(replies[0]!.token?.accessToken, original.accessToken)
      assert.equal(replies.every(value => value.token?.accessToken === accountStore(f.home).load()?.accessToken), true)
    } finally { await f.close() }
  })
}

async function startChild(home: string, endpoint: string, mode: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'child', home, endpoint, mode], { env: { ...process.env, RIVET_TOKEN_STORE: 'local-key', RIVET_HOME: home, RIVET_DESKTOP_DIR: home }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let diagnostic = ''
  child.stderr!.on('data', chunk => { diagnostic += String(chunk) })
  let ready!: () => void, done!: (value: any) => void
  const readiness = new Promise<void>(resolve => { ready = resolve })
  const result = new Promise<any>(resolve => { done = resolve })
  child.on('message', (value: any) => { if (value.ready) ready(); else done(value) })
  const closed = new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(Error(`child exit ${code}: ${diagnostic}`))))
  await Promise.race([readiness, closed.then(() => { throw Error('child never ready') })])
  return { pid: child.pid, start() { child.send({ start: true }) }, async result() { const value = await result; await closed; return value }, async stop() { if (child.connected) child.send({ stop: true }); await closed } }
}
if (process.argv[2] === 'child') {
  const [, , , home, endpoint, mode] = process.argv
  const store = accountStore(home!)
  const fetchImpl: typeof fetch = (input, init) => fetch(endpoint + new URL(String(input)).pathname, init)
  const b = (await import('../official-model-auth.js')).createOfficialModelBroker({ home: home!, fetchImpl, configuration: fixtureConfiguration })
  const identity = b.captureOfficialIdentity(), original = store.load()!
  const command = await new Promise<any>(resolve => { process.once('message', resolve); process.send!({ ready: true }) })
  if (!command.stop) {
    try {
      if (mode === 'refresh') {
        const value = await (await import('../refresh.js')).refreshAccountSession(store, original, { fetchImpl })
        process.send!({ code: value.code, token: value.token?.accessToken, generation: store.readAccountState()?.generation })
      } else { const value = await b.getOfficialCredential(identity!); process.send!({ credential: value.credential, identity }) }
    } catch (error) { process.send!({ error: (error as Error).message }) }
  }
  process.disconnect!()
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('two isolated Node processes share bootstrap and refresh; late refresh cannot overwrite B or same-subject relogin', async () => {
    const f = await officialFixture()
    try {
      await f.install('A')
      for (const mode of ['bootstrap', 'refresh']) {
        const left = await startChild(f.home, f.endpoint, mode), right = await startChild(f.home, f.endpoint, mode)
        assert.notEqual(left.pid, right.pid); assert.notEqual(left.pid, process.pid)
        left.start(); right.start()
        const [a, b] = await Promise.all([left.result(), right.result()])
        assert.equal(a.error, undefined); assert.equal(b.error, undefined)
        assert.equal(mode === 'bootstrap' ? a.credential : a.token, mode === 'bootstrap' ? b.credential : b.token)
      }
      assert.equal(f.bootstrapCalls, 1); assert.equal(f.rotations, 1)
      for (const next of ['B', 'A'] as const) {
        await f.install('A')
        let entered!: () => void, release!: () => void
        const waiting = new Promise<void>(r => { entered = r }), barrier = new Promise<void>(r => { release = r })
        f.setBeforeReply(async path => { if (path.endsWith('/tui-auth-refresh')) { entered(); await barrier } })
        const child = await startChild(f.home, f.endpoint, 'refresh'); child.start(); await waiting
        accountStore(f.home).clearAccount(); const installed = await f.install(next)
        release(); const result = await child.result()
        assert.equal(result.code, 'account_changed'); assert.equal(result.token, installed.accessToken)
        assert.equal(accountStore(f.home).load()?.accessToken, installed.accessToken)
        f.setBeforeReply(undefined)
      }
    } finally { await f.close() }
  })

  test('expired bootstrap lease gets a distinct receipt; late original cleanup preserves replacement grant', async () => {
    const f = await officialFixture()
    let release!: () => void
    try {
      await f.install('A'); const b1 = await f.broker(), b2 = await f.broker()
      let entered!: () => void
      const waiting = new Promise<void>(r => { entered = r }), barrier = new Promise<void>(r => { release = r })
      let first = true
      f.setBeforeReply(async path => { if (path.endsWith('/tui-model-bootstrap') && first) { first = false; entered(); await barrier } })
      const old = b1.getOfficialCredential(b1.captureOfficialIdentity()!)
      const rejected = assert.rejects(old, /account_changed/)
      await waiting
      // Emulate a paused holder's elapsed lease; no production clock/config bypass.
      const { readFileSync } = await import('node:fs')
      const { decodeSecret, encodeSecret, createSecretCipher } = await import('../secure-store.js')
      accountStore(f.home).withAccountLock(() => {
        const path = join(f.home, 'official-access.json'), cipher = createSecretCipher(f.home)
        const state = JSON.parse(decodeSecret(cipher, readFileSync(path, 'utf8'))!)
        state.lease.deadline = Date.now() - 1
        writeFileSync(path, encodeSecret(cipher, JSON.stringify(state)))
      })
      const identity = b2.captureOfficialIdentity()!, newer = await b2.getOfficialCredential(identity)
      release(); await rejected
      assert.equal(f.bootstrapCalls, 2)
      const ids = f.requests.filter(r => r.path.endsWith('/tui-model-bootstrap')).map(r => r.body.requestId)
      assert.notEqual(ids[0], ids[1]); assert.deepEqual([...f.cancelled], [`A/${ids[0]}`])
      assert.equal((await b2.getOfficialCredential(identity)).credential, newer.credential)
    } finally { release?.(); await f.close() }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('official cache rejects corruption/plaintext/backend downgrade; OS calls are stubbed before access', async () => {
    const f = await officialFixture()
    const fs = await import('node:fs'), cp = (await import('node:child_process')).default
    const { syncBuiltinESMExports } = await import('node:module')
    const { __resetSecretCipherCache } = await import('../secure-store.js')
    const backend = process.env.RIVET_TOKEN_STORE, originalExec = cp.execFileSync
    const warnings: string[] = [], originalWarn = console.warn
    try {
      console.warn = (...args) => { warnings.push(args.join(' ')) }
      await f.install('A'); let b = await f.broker(); let identity = b.captureOfficialIdentity()!
      const grant = await b.getOfficialCredential(identity)
      const path = join(f.home, 'official-access.json'), encrypted = fs.readFileSync(path, 'utf8')
      const { resolveSecretBackend } = await import('../secure-store.js')
      const nativeBackend = resolveSecretBackend()
      assert.notEqual(nativeBackend, 'plaintext', 'official cache never falls back to plaintext')
      assert.equal(encrypted.includes(grant.credential), false); assert.equal(JSON.parse(encrypted).b, nativeBackend)
      const foreignBackend = nativeBackend === 'local-key' ? 'dpapi' : 'local-key'
      for (const raw of [JSON.stringify({ credential: grant.credential }), JSON.stringify({ ...JSON.parse(encrypted), v: 2 }), JSON.stringify({ ...JSON.parse(encrypted), d: 'broken' }), JSON.stringify({ ...JSON.parse(encrypted), b: foreignBackend })]) {
        fs.writeFileSync(path, raw); assert.equal(b.getOfficialStatus().status, 'unavailable')
      }
      cp.execFileSync = ((cmd: string, ...rest: unknown[]) => { if (cmd === 'security') throw Error('fixture vault locked'); return originalExec(cmd, ...rest as []) }) as typeof cp.execFileSync; syncBuiltinESMExports()
      process.env.RIVET_TOKEN_STORE = 'keychain'; __resetSecretCipherCache()
      b = await f.broker(); identity = b.captureOfficialIdentity()!
      assert.ok(identity, 'generic account backend migration remains readable')
      await assert.rejects(b.getOfficialCredential(identity), /service_error/)
      assert.equal(f.bootstrapCalls, 1, 'OS sealing fails before bootstrap')
      // A keychain envelope cannot be reinterpreted as an account when the vault is locked.
      const accountPath = join(f.home, 'account.json'), accountRaw = fs.readFileSync(accountPath, 'utf8')
      fs.writeFileSync(accountPath, JSON.stringify({ ...JSON.parse(accountRaw), b: 'keychain' }))
      assert.equal(accountStore(f.home).load(), null)
      fs.writeFileSync(accountPath, accountRaw)
      process.env.RIVET_TOKEN_STORE = 'plaintext'; __resetSecretCipherCache()
      b = await f.broker(); await assert.rejects(b.getOfficialCredential(b.captureOfficialIdentity()!), /service_error/)
      assert.equal(warnings.join(' ').includes(grant.credential), false)
    } finally { cp.execFileSync = originalExec; syncBuiltinESMExports(); console.warn = originalWarn; if (backend === undefined) delete process.env.RIVET_TOKEN_STORE; else process.env.RIVET_TOKEN_STORE = backend; __resetSecretCipherCache(); await f.close() }
  })

  test('identity/device/SID/expiry fences, legacy upgrade, and offline cache isolation', async () => {
    const f = await officialFixture()
    const { readFileSync, existsSync } = await import('node:fs')
    try {
      const installed = await f.install('A'), b = await f.broker(), identity = b.captureOfficialIdentity()!
      await assert.rejects(b.getOfficialCredential({ ...identity }), /account_changed/)
      for (const changes of [{ subject: owners.B.subject }, { accountSessionId: owners.B.sid }, { expiresAt: new Date(Date.now() - 1000).toISOString() }, { expiresAt: new Date(Date.now() + 660000).toISOString() }]) {
        f.setOverride((path, _body, data) => path.endsWith('/tui-model-bootstrap') ? { data: { ...(data as object), ...changes } } : undefined)
        await assert.rejects(b.getOfficialCredential(identity), /account_changed/)
      }
      f.setOverride(undefined)
      // Local short access-JWT expiry does not cap a server-validated managed grant.
      accountStore(f.home).transaction(state => { state.token!.expiresAt = Date.now() + 65000; return { value: undefined, write: true } })
      const grant = await b.getOfficialCredential(identity)
      assert.ok(Date.parse(grant.expiresAt) > accountStore(f.home).load()!.expiresAt)
      await b.getOfficialCatalog(identity, 'agent')
      f.setOverride(path => path.endsWith('/catalog') ? { status: 503, error: { code: 'service_error', retryable: true } } : undefined)
      await assert.rejects(b.getOfficialCatalog(identity, 'agent'), /service_error/)
      accountDeviceFingerprint(f.home, 'different-device-12345'); assert.equal(b.captureOfficialIdentity(), null)
      await assert.rejects(b.getOfficialCredential(identity), /account_changed/)
      accountDeviceFingerprint(f.home, device)
      accountStore(f.home).clearAccount(); assert.equal(existsSync(join(f.home, 'official-access.json')), false)
      assert.equal(accountStore(f.home).load(), null); assert.equal(b.captureOfficialIdentity(), null)
      await f.install('B'); await assert.rejects(b.getOfficialCatalog(identity, 'agent'), /account_changed/)
      const fresh = b.captureOfficialIdentity()!; await assert.rejects(b.getOfficialCatalog(fresh, 'agent'), /service_error/)
      // Legacy data is still readable and upgrades on next write, but cannot self-attest source.
      writeFileSync(join(f.home, 'account.json'), JSON.stringify(installed))
      assert.ok(accountStore(f.home).load()); assert.equal(b.captureOfficialIdentity(), null)
      const store = accountStore(f.home), token = store.load()!
      saveAccountIdentity(store, token, { stellarId: 'legacy', primaryDomain: 'FU', title: 'legacy' })
      assert.equal(JSON.parse(readFileSync(store.filePath, 'utf8')).s, 'aes-256-gcm')
      assert.equal(b.captureOfficialIdentity(), null)
    } finally { await f.close() }
  })

  test('dead lock recovery, live-owner bounded failure, uncertain refresh never retries old token, and durable category merge', async () => {
    const f = await officialFixture()
    const { mkdirSync, readdirSync, rmSync } = await import('node:fs'), { hostname } = await import('node:os')
    try {
      const token = await f.install('A'), store = accountStore(f.home), lock = `${store.filePath}.lock`
      mkdirSync(lock); writeFileSync(join(lock, `${randomUUID()}.json`), JSON.stringify({ pid: 2147483647, host: hostname(), deadline: Date.now() - 1 }))
      saveAccountIdentity(store, token, { stellarId: 'current', primaryDomain: 'FU', title: 'current' })
      saveAccountProfile(store, token, { avatarUrl: null, founding: null, fetchedAt: Date.now() })
      assert.equal(store.load()?.identity?.stellarId, 'current'); assert.ok(store.load()?.profile)
      assert.equal(readdirSync(f.home).some(name => name.endsWith('.tmp') || name.includes('.lock')), false)
      mkdirSync(lock); writeFileSync(join(lock, `${randomUUID()}.json`), JSON.stringify({ pid: process.pid, host: hostname(), deadline: Date.now() - 1 }))
      const start = Date.now(); assert.throws(() => store.patchAccount(token, t => t), /account_store_unavailable/)
      assert.ok(Date.now() - start < 3000); rmSync(lock, { recursive: true })
      store.transaction(state => { state.refresh = { id: randomUUID(), pid: 2147483647, deadline: Date.now() - 1, fingerprint: 'uncertain' }; return { value: undefined, write: true } })
      const refreshed = await (await import('../refresh.js')).refreshAccountSession(store, store.load()!, { fetchImpl: f.fetchImpl })
      assert.equal(refreshed.code, 'auth_required'); assert.equal(f.rotations, 0); assert.equal(store.load()?.identity?.stellarId, 'current')
    } finally { await f.close() }
  })

  test('catalog accepts only current producer operation paths and conservative capabilities', async () => {
    const { parseOfficialCatalog, catalogForPurpose } = await import('../../models/official-catalog.js')
    const valid = () => structuredClone(fixtureCatalog)
    for (const mutate of [
      (c: any) => { c.models[0].bindings[0].origin = 'https://evil.invalid' },
      (c: any) => { c.models[0].bindings[0].path = '/v1/chat/completions?key=x' },
      (c: any) => { c.models[0].bindings[0].requiredHeaders = { Authorization: 'sk-secret' } },
      (c: any) => { c.models[0].bindings[0].requiredHeaders = { accept: 'a', Accept: 'b' } },
      (c: any) => { c.models[0].bindings[0].requiredHeaders = { accept: 'a\r\nb' } },
      (c: any) => { c.models[0].bindings[0].modelId = 'other' },
      (c: any) => { c.models.push(c.models[0]) },
      (c: any) => { c.models[0].prices = [] },
    ]) { const c = valid(); mutate(c); assert.throws(() => parseOfficialCatalog(c, fixtureConfiguration.gatewayOrigins)) }
    const unknown = valid(); unknown.models[0]!.capabilities.tools = false
    const parsed = parseOfficialCatalog(unknown, fixtureConfiguration.gatewayOrigins)
    assert.equal(catalogForPurpose(parsed, 'agent').models.length, 0)
    assert.equal(catalogForPurpose(parsed, 'vision').models.length, 0)
    assert.equal(catalogForPurpose(parsed, 'title').models.length, 1)
    assert.equal(catalogForPurpose(parsed, 'embedding').models.length, 0)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('clear official access fences a pending grant and account metadata logout returns no stale credential', async () => {
    const f = await officialFixture()
    let release!: () => void
    try {
      const token = await f.install('A'), b = await f.broker(), identity = b.captureOfficialIdentity()!
      let entered!: () => void
      const waiting = new Promise<void>(r => { entered = r }), barrier = new Promise<void>(r => { release = r })
      f.setBeforeReply(async path => { if (path.endsWith('/tui-model-bootstrap')) { entered(); await barrier } })
      const pending = assert.rejects(b.getOfficialCredential(identity), /account_changed/)
      await waiting; await b.clearOfficialAccess(identity); release(); await pending
      assert.equal(f.cancelled.size, 1); assert.equal(b.getOfficialStatus().status, 'unavailable')
      assert.equal(accountStore(f.home).load()?.accessToken, token.accessToken)
      accountStore(f.home).clearAccount()
      assert.throws(() => saveAccountIdentity(accountStore(f.home), token, { stellarId: 'old', primaryDomain: 'FU', title: 'old' }), /account_changed/)
      assert.equal(accountStore(f.home).load(), null)
    } finally { release?.(); await f.close() }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('explicit logout compensates actual rotated current hash; same SID cannot install during network but B can', async () => {
    const f = await officialFixture()
    let releaseRefresh!: () => void, releaseEnd!: () => void
    try {
      const original = await f.install('A'), oldPoll = f.lastPoll, store = accountStore(f.home)
      let enteredRefresh!: () => void, enteredEnd!: () => void
      const refreshEntered = new Promise<void>(r => { enteredRefresh = r }), refreshBarrier = new Promise<void>(r => { releaseRefresh = r })
      const endEntered = new Promise<void>(r => { enteredEnd = r }), endBarrier = new Promise<void>(r => { releaseEnd = r })
      f.setBeforeReply(async (path, body) => {
        if (path.endsWith('/tui-auth-refresh')) { enteredRefresh(); await refreshBarrier }
        if (path.endsWith('/tui-auth-end') && body.accessToken !== original.accessToken) { enteredEnd(); await endBarrier }
      })
      const pending = (await import('../refresh.js')).refreshAccountSession(store, original, { fetchImpl: f.fetchImpl })
      await refreshEntered
      const loggedOut = store.clearAccount()!
      assert.equal(await revokeAccountSession(loggedOut.accessToken, { fetchImpl: f.fetchImpl }), true)
      assert.deepEqual(f.ended.map(e => e.deleted), [false], 'HTTP200 for old token deleted zero rows after server rotation')
      releaseRefresh()
      await Promise.race([endEntered, pending.then(() => { throw Error('missing explicit logout compensation') })])
      const intent = store.beginLogin(device)
      assert.throws(() => saveAccountToken(store, oldPoll, { intent, deviceId: device }), /account_changed/)
      const next = await f.install('B'); releaseEnd(); await pending
      assert.deepEqual(f.ended.map(e => e.deleted), [false, true])
      assert.equal(store.load()?.accessToken, next.accessToken)
      assert.equal((await f.broker()).captureOfficialIdentity()?.subject, owners.B.subject)
    } finally { releaseRefresh?.(); releaseEnd?.(); await f.close() }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('known logout refuses mismatched source compensation and ordinary CAS loss never revokes', async () => {
    for (const explicit of [true, false]) {
      const f = await officialFixture()
      let release!: () => void
      try {
        const original = await f.install('A'), store = accountStore(f.home)
        let entered!: () => void
        const waiting = new Promise<void>(r => { entered = r }), barrier = new Promise<void>(r => { release = r })
        f.setBeforeReply(async path => { if (path.endsWith('/tui-auth-refresh')) { entered(); await barrier } })
        const pending = (await import('../refresh.js')).refreshAccountSession(store, original, { fetchImpl: f.fetchImpl })
        await waiting
        if (explicit) store.clearAccount()
        const next = await f.install('B')
        if (explicit) f.setOverride(path => path.endsWith('/tui-auth-refresh') ? { data: { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresIn: 3600 } } : undefined)
        release(); assert.equal((await pending).code, 'account_changed')
        assert.equal(f.ended.length, 0); assert.equal(store.load()?.accessToken, next.accessToken)
      } finally { release?.(); await f.close() }
    }
  })

  test('unknown legacy logout fences its bounded compensation; only fresh device poll can recover failed intent', async () => {
    const f = await officialFixture()
    let release!: (value: boolean) => void
    try {
      const real = await f.install('A'), store = accountStore(f.home)
      store.save({ accessToken: 'legacy-access', refreshToken: 'legacy-refresh', expiresAt: 1 })
      let finish!: (value: any) => void, entered!: () => void
      const waiting = new Promise<void>(r => { entered = r })
      const pending = (await import('../refresh.js')).refreshAccountSession(store, store.load()!, { renew: () => new Promise(r => { finish = r }), revoke: () => new Promise(r => { release = r; entered() }) })
      store.clearAccount(); finish({ code: 'ok', poll: { status: 'approved', accessToken: 'legacy-late', refreshToken: 'legacy-late-refresh' } })
      await waiting
      assert.throws(() => store.save({ accessToken: 'new-opaque', expiresAt: 1 }), /account_changed/)
      await assert.rejects(f.install('B'), /account_changed/)
      release(false); await pending
      assert.equal(store.readAccountState()?.logoutIntents?.at(-1)?.status, 'uncertain')
      const { refreshAccountToken } = await import('../account.js')
      const renewed = (await refreshAccountToken(real.refreshToken!, { fetchImpl: f.fetchImpl }))!
      assert.throws(() => saveAccountToken(store, renewed, { intent: store.beginLogin(device), deviceId: device }), /account_changed/, 'trusted refresh is not a fresh-device login')
      const fresh = await f.install('B')
      assert.equal(store.load()?.accessToken, fresh.accessToken)
      assert.equal(store.readAccountState()?.logoutIntents?.at(-1)?.status, 'abandoned')
    } finally { release?.(false); await f.close() }
  })

  test('unknown legacy compensation skips any newly active account', async () => {
    const f = await officialFixture()
    try {
      const store = accountStore(f.home); store.save({ accessToken: 'legacy', refreshToken: 'legacy-r', expiresAt: 1 })
      let finish!: (value: any) => void, revoked = 0
      const pending = (await import('../refresh.js')).refreshAccountSession(store, store.load()!, { renew: () => new Promise(r => { finish = r }), revoke: async () => { revoked++; return true } })
      store.clearAccount(); const next = await f.install('B')
      finish({ code: 'ok', poll: { status: 'approved', accessToken: 'late', refreshToken: 'late-r' } }); await pending
      assert.equal(revoked, 0); assert.equal(store.load()?.accessToken, next.accessToken)
    } finally { await f.close() }
  })

  test('sidecar logout reports pending when original auth-end HTTP200 deleted zero rows', async () => {
    const f = await officialFixture()
    let release!: () => void
    try {
      const account = await import('../account.js'), { buildAccountRoutes } = await import('../../server/account-routes.js')
      await f.install('A'); const store = accountStore(f.home)
      store.transaction(state => { state.token!.expiresAt = 1; return { value: undefined, write: true } })
      let entered!: () => void
      const waiting = new Promise<void>(r => { entered = r }), barrier = new Promise<void>(r => { release = r })
      f.setBeforeReply(async path => { if (path.endsWith('/tui-auth-refresh')) { entered(); await barrier } })
      const routes = buildAccountRoutes({ apiToken: 'local', rivetHome: f.home, account: { ...account,
        refreshAccountTokenWithStatus: credential => account.refreshAccountTokenWithStatus(credential, { fetchImpl: f.fetchImpl }),
        revokeAccountSession: credential => account.revokeAccountSession(credential, { fetchImpl: f.fetchImpl }),
        activateAccountLicense: async () => ({ code: 'auth_required' }),
      } })
      const headers = { authorization: 'Bearer local' }
      const pending = routes['POST /account/identity/refresh']!({}, {}, headers)
      await waiting
      const loggedOut = await routes['POST /account/logout']!({}, {}, headers)
      assert.equal((loggedOut.body as {remoteRevoked: boolean}).remoteRevoked, false)
      assert.deepEqual(f.ended.map(e => e.deleted), [false])
      const repeated = await routes['POST /account/logout']!({}, {}, headers)
      assert.equal((repeated.body as {remoteRevoked: boolean}).remoteRevoked, false, 'durable pending intent survives a repeated logout')
      release(); await pending
      assert.deepEqual(f.ended.map(e => e.deleted), [false, true]); assert.equal(store.load(), null)
    } finally { release?.(); await f.close() }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== 'child') {
  test('official source epoch distinguishes unavailable, logout, grant clear and new owner without secrets', async () => {
    const f = await officialFixture()
    try {
      const { createOfficialModelBroker } = await import('../official-model-auth.js')
      const broker = createOfficialModelBroker({ home: f.home, configuration: { ...fixtureConfiguration, portalOrigin: null }, fetchImpl: f.fetchImpl })
      assert.equal(broker.getOfficialStatus().sourceEpoch, null)
      await f.install('A')
      const a = broker.getOfficialStatus()
      assert.match(a.sourceEpoch!, /^[a-f0-9]{64}$/)
      assert.equal(broker.getOfficialStatus().sourceEpoch, a.sourceEpoch)
      await broker.clearOfficialAccess(broker.captureOfficialIdentity()!)
      assert.notEqual(broker.getOfficialStatus().sourceEpoch, a.sourceEpoch)
      accountStore(f.home).clear()
      const logout = broker.getOfficialStatus()
      assert.equal(logout.identity, null)
      assert.match(logout.sourceEpoch!, /^[a-f0-9]{64}$/)
      await f.install('B')
      assert.notEqual(broker.getOfficialStatus().sourceEpoch, logout.sourceEpoch)
      assert.deepEqual(broker.getOfficialStatus().portalLinks, { wallet: null, usage: null })
    } finally { await f.close() }
  })
}
