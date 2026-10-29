import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildOfficialModelRoutes, buildOfficialModelRoutesFor } from '../official-model-routes.js'
import { startServer } from '../index.js'
import { officialFixture, fixtureConfiguration, fixtureCatalog } from '../../auth/__tests__/official-model-auth.test.js'

test('F5 catalog HTTP projection retains priceSchedule and rejects malformed metadata', async () => {
  const f = await officialFixture()
  const routes = buildOfficialModelRoutes({ home: f.home, apiToken: 'local-fixture', fetchImpl: f.fetchImpl, configuration: fixtureConfiguration })
  const schedule = { period: 'peak', timezone: 'Asia/Shanghai', calendarRevision: 'calendar-f4', asOf: '2026-10-14T01:00:00Z', validUntil: '2026-10-14T04:00:00Z', nextTransition: '2026-10-14T04:00:00Z' }
  const priced = (priceSchedule: unknown) => ({ ...fixtureCatalog, models: [{ ...fixtureCatalog.models[0], costStatus: 'available', prices: [{ kind: 'per-request', period: 'fixed', pricingRevision: 'price-1', rates: null, perRequest: { currency: 'CNY', amount: '1' } }], priceSchedule }] })
  try {
    await f.install('A'); await routes['POST /official-model/sync']!({}, {}, { authorization: 'Bearer local-fixture' })
    for (const value of [schedule, { ...schedule, nextTransition: null }, null, undefined]) {
      f.setOverride(path => path.endsWith('/catalog') ? { data: priced(value ?? null) } : undefined)
      const reply = await routes['GET /official-model/catalog']!(undefined, { purpose: 'agent' }, { authorization: 'Bearer local-fixture' })
      assert.equal(reply.status, 200); assert.deepEqual((reply.body as any).data.models[0].priceSchedule ?? null, value ?? null)
    }
    for (const change of [{ period: 'fixed' }, { timezone: 'UTC' }, { calendarRevision: '' }, { calendarRevision: 'x'.repeat(257) }, { nextTransition: 'not-a-date' }, { asOf: '2026-10-14T05:00:00Z' }, { nextTransition: '2026-10-14T03:00:00Z' }]) {
      f.setOverride(path => path.endsWith('/catalog') || path.endsWith('/tui-model-account') ? { data: priced({ ...schedule, ...change }) } : undefined)
      assert.equal((await routes['POST /official-model/customer']!({ version: 2, op: 'catalog.list', input: {}, requestId: 'invalid-schedule' }, {}, { authorization: 'Bearer local-fixture' })).status, 503)
      const retained = await routes['GET /official-model/catalog']!(undefined, { purpose: 'agent' }, { authorization: 'Bearer local-fixture' })
      assert.equal(retained.status, 503, 'failed refresh cannot recover stale monetary catalog data')
    }
    assert.equal((await routes['POST /official-model/customer']!({ version: 2, op: 'catalog.list', input: { priceSchedule: schedule }, requestId: 'schedule-spoof' }, {}, { authorization: 'Bearer local-fixture' })).status, 400)
    assert.equal(f.requests.filter(r => r.path.endsWith('/model-quote')).length, 0, 'catalog metadata does not obtain any anonymous or authenticated quote')
  } finally { await f.close() }
})

test('official_sidecar_is_bearer_protected_and_secret_free through actual HTTP router', async () => {
  const f = await officialFixture()
  const routes = buildOfficialModelRoutes({ home: f.home, apiToken: 'local-fixture', fetchImpl: f.fetchImpl, configuration: fixtureConfiguration })
  const server = await startServer(0, routes, 'local-fixture')
  const url = `http://127.0.0.1:${server.port}`
  const request = (path: string, body?: unknown, auth = 'local-fixture') => fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    assert.equal((await request('/official-model/status', undefined, 'wrong')).status, 401)
    assert.equal((await buildOfficialModelRoutes({ home: f.home })['GET /official-model/status']!(undefined, {}, { authorization: 'Bearer local-fixture' })).status, 401)
    await f.install('A')
    const sync = await request('/official-model/sync', {}); assert.equal(sync.status, 200); assert.equal(sync.headers.get('cache-control'), 'no-store')
    const replies = [await sync.json()]
    for (const path of ['/official-model/status', '/official-model/catalog?purpose=agent']) { const res = await request(path); assert.equal(res.status, 200); replies.push(await res.json()) }
    const summary = await request('/official-model/customer', { version: 2, op: 'view.get', input: {}, requestId: 'caller-receipt' }); assert.equal(summary.status, 200)
    replies.push(await summary.json())
    for (const secret of [...f.grants.keys(), ...f.requests.map(r => r.authorization.slice(7)).filter(Boolean)]) assert.equal(JSON.stringify(replies).includes(secret), false)
    assert.equal((await request('/official-model/customer', { version: 2, op: 'view.get', input: {}, requestId: 'r', credential: 'override' })).status, 400)
    assert.equal((await request('/official-model/catalog?purpose=unknown')).status, 400)
    assert.equal((await request('/official-model/status?identity=B')).status, 400)
    assert.equal((await request('/official-model/sync', { origin: 'https://evil.invalid' })).status, 400)
    f.setOverride(path => path.endsWith('/tui-model-account') ? { status: 429, error: { code: 'rate_limited', message: 'sk-raw-secret', retryable: true, retryAfterSeconds: 8, scope: 'account' } } : undefined)
    const rate = await request('/official-model/customer', { version: 2, op: 'view.get', input: {}, requestId: 'rate-1' })
    assert.equal(rate.status, 429); assert.equal(rate.headers.get('retry-after'), '8'); assert.equal(JSON.stringify(await rate.json()).includes('sk-raw-secret'), false)
    f.setOverride(path => path.endsWith('/tui-model-account') ? { status: 503, error: { code: 'service_error', message: 'raw-private', retryable: true } } : undefined)
    assert.equal((await request('/official-model/customer', { version: 2, op: 'view.get', input: {}, requestId: 'service-1' })).status, 503)
    assert.equal((await request('/official-model/status')).status, 200)
    const builder = buildOfficialModelRoutesFor('local-fixture', {})
    assert.deepEqual(Object.keys(builder), Object.keys(routes))
  } finally { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})

test('all fourteen account operations project explicit nested DTOs and preserve caller receipts over real HTTP', async () => {
  const f = await officialFixture()
  const { fixtureSummary, fixtureCatalog } = await import('../../auth/__tests__/official-model-auth.test.js')
  const money = { currency: 'CNY', amount: '10' }, time = new Date().toISOString()
  const product = { productId: 'p', productRevision: 'p1', kind: 'refill', name: 'Refill', membershipTier: null, price: money, refundPolicyRevision: 'r1', refundPolicyText: 'terms', available: true }
  const quote = { quoteId: 'q', productId: 'p', productRevision: 'p1', amount: money, refundPolicyRevision: 'r1', refundPolicyText: 'terms', validUntil: time, paymentMethods: ['fixture'], cycleStartsAt: null, cycleEndsAt: null, issuanceAt: null }
  const order = { orderId: 'o', productId: 'p', productRevision: 'p1', status: 'pending', amount: money, refundPolicyRevision: 'r1', refundPolicyText: null, checkoutUrl: 'https://pay.invalid/checkout?id=o', expiresAt: time, cycleStartsAt: null, cycleEndsAt: null, issuanceAt: null, paidAt: null }
  const refund = { refundId: 'r', orderId: 'o', status: 'pending', amount: money, refundPolicyRevision: 'r1', requestedAt: time, completedAt: null }
  const cases: Array<[string, Record<string, unknown>, unknown]> = [
    ['view.get', {}, fixtureSummary()], ['catalog.list', {}, fixtureCatalog], ['products.list', {}, { revision: 'p1', items: [product] }],
    ['subscription.get', {}, fixtureSummary().subscription], ['usage.list', { cursor: 'a-1', limit: 10 }, { status: 'unavailable', items: [], nextCursor: null }],
    ['billing.list', {}, { items: [{ orderId: 'o', status: 'paid', money, refunds: [refund] }], nextCursor: null }],
    ['quote.get', { productId: 'p', productRevision: 'p1' }, quote], ['order.create', { quoteId: 'q' }, order], ['order.get', { orderId: 'o' }, order],
    ['quote.get', { productId: 'p', productRevision: 'p1' }, quote],
    ['subscription.change', { subscriptionId: 's', productId: 'p', productRevision: 'p1', expectedRevision: 's1' }, fixtureSummary().subscription],
    ['subscription.cancel', { subscriptionId: 's', expectedRevision: 's1' }, fixtureSummary().subscription],
    ['refund.request', { orderId: 'o', reason: 'unused' }, refund], ['refund.get', { refundId: 'r' }, refund],
  ]
  const contaminate = (value: unknown): unknown => Array.isArray(value) ? value.map(contaminate) : value && typeof value === 'object' ? { ...Object.fromEntries(Object.entries(value).map(([key, v]) => [key, contaminate(v)])), credential: 'sk-injected-private', supplierSecret: 'private' } : value
  const routes = buildOfficialModelRoutes({ home: f.home, apiToken: 'local', fetchImpl: f.fetchImpl, configuration: fixtureConfiguration })
  const call = (body: unknown) => routes['POST /official-model/customer']!(body, {}, { authorization: 'Bearer local' })
  try {
    await f.install('A')
    for (const [op, input, data] of cases) {
      f.setOverride(path => path.endsWith('/tui-model-account') ? { data } : undefined)
      const reply = await call({ version: 2, op, input, requestId: `receipt-${op}` })
      assert.equal(reply.status, 200, op)
      assert.equal((reply.body as any).requestId, `receipt-${op}`)
      assert.equal(JSON.stringify(reply.body).includes('sk-injected-private'), false)
      assert.equal(JSON.stringify(reply.body).includes('supplierSecret'), false)
      assert.equal(f.requests.at(-1)?.body.requestId, `receipt-${op}`)
      f.setOverride(path => path.endsWith('/tui-model-account') ? { data: contaminate(data) } : undefined)
      assert.equal((await call({ version: 2, op, input, requestId: `closed-${op}` })).status, 503)
      assert.equal((await call({ version: 2, op, input: { ...input, userId: 'other' }, requestId: 'bad' })).status, 400)
    }
    f.setOverride(() => ({ data: { ...order, checkoutUrl: 'https://evil.invalid/pay' } }))
    assert.equal((await call({ version: 2, op: 'order.get', input: { orderId: 'o' }, requestId: 'bad-checkout' })).status, 503)
    f.setOverride(() => ({ data: { ...fixtureSummary(), membership: { ...fixtureSummary().membership, subject: 'other' } } }))
    assert.equal((await call({ version: 2, op: 'view.get', input: {}, requestId: 'bad-owner' })).status, 503)
  } finally { await f.close() }
})

test('F5 order projection preserves frozen text and accepts null or legacy absence', async () => {
  const f = await officialFixture()
  const time = new Date().toISOString()
  const base = { orderId: 'o', productId: 'refill-small', productRevision: '1', status: 'paid', amount: { currency: 'CNY', amount: '29' }, refundPolicyRevision: 'old-rule', checkoutUrl: null, expiresAt: time, cycleStartsAt: null, cycleEndsAt: null, issuanceAt: time, paidAt: time }
  const routes = buildOfficialModelRoutes({ home: f.home, apiToken: 'local', fetchImpl: f.fetchImpl, configuration: fixtureConfiguration })
  try {
    await f.install('A')
    for (const text of ['Frozen historical rule', 'x'.repeat(8192), null, undefined]) {
      f.setOverride(path => path.endsWith('/tui-model-account') ? { data: { ...base, refundPolicyText: text ?? null } } : undefined)
      const reply = await routes['POST /official-model/customer']!({ version: 2, op: 'order.get', input: { orderId: 'o' }, requestId: 'f5-policy' }, {}, { authorization: 'Bearer local' })
      assert.equal(reply.status, 200)
      assert.equal((reply.body as any).data.refundPolicyText, text ?? null)
    }
    f.setOverride(path => path.endsWith('/tui-model-account') ? { data: { ...base, refundPolicyRevision: '', refundPolicyText: null } } : undefined)
    const legacy = await routes['POST /official-model/customer']!({ version: 2, op: 'order.get', input: { orderId: 'o' }, requestId: 'f5-legacy-policy' }, {}, { authorization: 'Bearer local' })
    assert.equal(legacy.status, 200, 'unknown frozen revision stays unknown rather than rejecting the complete legacy receipt')
    assert.equal((legacy.body as any).data.refundPolicyText, null)
  } finally { await f.close() }
})


test('Fix1 stale device start waiting for cancellation cannot replace or revoke the latest pending poll', async () => {
  const f = await officialFixture()
  const account = await import('../../auth/account.js')
  const { buildAccountRoutes } = await import('../account-routes.js')
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
  const cancelling = deferred(), releaseCancel = deferred(), polling = deferred(), releasePoll = deferred()
  const started: string[] = [], revoked: string[] = []
  let approvedToken = ''
  const routes = buildAccountRoutes({ rivetHome: f.home, apiToken: 'local', account: {
    ...account, activateAccountLicense: async () => { throw Error('unused') }, fetchAccountSnapshot: undefined,
    fetchStellarIdentity: async () => null, fetchAccountProfileSnapshot: async () => null, fetchAccountProfile: async () => null,
    requestDeviceCode: async ({ deviceName }) => { started.push(deviceName!); return { deviceCode: deviceName!, userCode: 'fixture', verifyUrl: 'https://fixture.invalid', expiresIn: 300, pollInterval: 5 } },
    cancelDeviceCode: async code => { if (code === 'X') { cancelling.resolve(); await releaseCancel.promise }; return true },
    checkDeviceOnce: async code => { assert.equal(code, 'B'); polling.resolve(); await releasePoll.promise; const result = await account.checkDeviceOnce('B', { fetchImpl: f.fetchImpl }); approvedToken = result.accessToken!; return result },
    revokeAccountSession: async token => { revoked.push(token); return true },
  } })
  const call = (path: string, body: unknown) => routes[`POST /account/${path}`]!(body, {}, { authorization: 'Bearer local' })
  let older: ReturnType<typeof call> | undefined, latest: ReturnType<typeof call> | undefined
  try {
    assert.equal((await call('device', { deviceName: 'X', deviceFingerprint: 'fixture-device-X' })).status, 200)
    older = call('device', { deviceName: 'A', deviceFingerprint: 'fixture-device-A' }); await cancelling.promise
    assert.equal((await call('device', { deviceName: 'B', deviceFingerprint: 'fixture-device-B' })).status, 200)
    const intent = account.accountStore(f.home).readAccountState()!.login
    latest = call('poll', { deviceCode: 'B' }); await polling.promise
    releaseCancel.resolve(); assert.equal((await older).status, 409)
    releasePoll.resolve(); const result = await latest
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { status: 'approved' })
    assert.equal(account.accountStore(f.home).load()?.accessToken, approvedToken)
    assert.deepEqual(revoked, [])
    assert.deepEqual(started, ['X', 'B'])
    assert.equal(readFileSync(`${f.home}/.account-device-id`, 'utf8'), 'fixture-device-B')
    assert.equal(account.accountStore(f.home).readAccountState()!.source?.deviceId, intent!.deviceId)
  } finally {
    releaseCancel.resolve(); releasePoll.resolve(); await Promise.allSettled([older, latest])
    await new Promise<void>(resolve => setImmediate(resolve)); await f.close()
  }
})

test('Fix1 producer account HTTP statuses are validated and projected without raw errors', async () => {
  const f = await officialFixture()
  const routes = buildOfficialModelRoutes({ home: f.home, apiToken: 'local', fetchImpl: f.fetchImpl, configuration: fixtureConfiguration })
  try {
    const installed = await f.install('A')
    const cases: Array<[number, string, number, string, boolean]> = [
      [401, 'account_changed', 401, 'account_changed', false], [503, 'model_unavailable', 503, 'model_unavailable', false],
      [400, 'capability_unknown', 400, 'capability_unknown', false], [409, 'flow_not_approved', 409, 'flow_not_approved', false],
      [401, 'credential_revoked', 401, 'credential_revoked', false], [503, 'catalog_unavailable', 503, 'catalog_unavailable', false],
      [400, 'payment_unavailable', 400, 'payment_unavailable', false], [503, 'payment_unavailable', 503, 'payment_unavailable', true],
      [409, 'account_changed', 503, 'service_error', false], [403, 'credential_revoked', 503, 'service_error', false],
      [418, 'catalog_unavailable', 503, 'service_error', false], [200, 'flow_not_approved', 503, 'service_error', false],
      [400, 'raw-unknown-secret', 503, 'service_error', false], [503, 'payment_unavailable', 503, 'service_error', false],
    ]
    for (const [status, code, expectedStatus, expectedCode, retryable] of cases) {
      f.setOverride(path => path.endsWith('/tui-model-account') ? { status, error: { code, retryable, message: 'sk-private-upstream', credential: installed.accessToken, status: 418 } } : undefined)
      const reply = await routes['POST /official-model/customer']!({ version: 2, op: 'view.get', input: {}, requestId: 'original-receipt' }, {}, { authorization: 'Bearer local' })
      assert.equal(reply.status, expectedStatus, `${status}/${code}`)
      assert.deepEqual((reply.body as any).error, { code: expectedCode, message: expectedCode, retryable: expectedCode === 'service_error' ? true : retryable })
      assert.equal((reply.body as any).requestId, 'original-receipt')
      assert.equal(JSON.stringify(reply.body).includes(installed.accessToken), false)
    }
    f.setOverride(path => path.endsWith('/tui-model-account') ? { status: 409 } : undefined)
    const malformed = await routes['POST /official-model/customer']!({ version: 2, op: 'view.get', input: {}, requestId: 'success-on-conflict' }, {}, { authorization: 'Bearer local' })
    assert.equal(malformed.status, 503); assert.equal((malformed.body as any).error.code, 'service_error')
    const { accountStore } = await import('../../auth/account.js')
    assert.equal(accountStore(f.home).load()?.accessToken, installed.accessToken)
    assert.equal(f.requests.filter(r => r.path.endsWith('/tui-model-account')).length, cases.length + 1)
  } finally { await f.close() }
})


test('display quote is authenticated, closed and never authorizes inference', async () => {
  const f = await officialFixture()
  const server = await startServer(0, buildOfficialModelRoutes({ home: f.home, apiToken: 'local-fixture', fetchImpl: f.fetchImpl, configuration: fixtureConfiguration }), 'local-fixture')
  const request = (body: unknown, auth = 'local-fixture') => fetch(`http://127.0.0.1:${server.port}/official-model/quote`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    await f.install('A')
    const input = { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }
    assert.equal((await request(input, 'wrong')).status, 401)
    const response = await request(input)
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { data: { bindingId: string } }).data.bindingId, 'chat-1')
    const count = f.requests.length
    for (const extra of ['owner', 'grant', 'sourceEpoch', 'quoteId']) assert.equal((await request({ ...input, [extra]: 'untrusted' })).status, 400)
    assert.equal(f.requests.length, count)
    assert.equal(f.requests.some(r => r.path.includes('completions')), false)
  } finally { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})

test('display quote refuses a late previous owner and aborts disconnected transport', async () => {
  const f = await officialFixture()
  const server = await startServer(0, buildOfficialModelRoutes({ home: f.home, apiToken: 'local-fixture', fetchImpl: f.fetchImpl, configuration: fixtureConfiguration }), 'local-fixture')
  let release = () => {}
  try {
    await f.install('A')
    for (const disconnect of [false, true]) {
      let arrived!: () => void
      const pending = new Promise<void>(resolve => { arrived = resolve })
      const blocked = new Promise<void>(resolve => { release = resolve })
      f.setBeforeReply(async path => { if (path.endsWith('/model-quote')) { arrived(); await blocked } })
      const controller = new AbortController()
      const result = fetch(`http://127.0.0.1:${server.port}/official-model/quote`, { method: 'POST', headers: { authorization: 'Bearer local-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }), signal: controller.signal })
      await pending
      if (disconnect) {
        const rejected = assert.rejects(result, error => error instanceof Error && error.name === 'AbortError')
        controller.abort(); await rejected
      } else {
        await f.install('B'); release()
        const response = await result
        assert.equal(response.status, 409)
        assert.equal((await response.json() as { error: { code: string } }).error.code, 'account_changed')
      }
      release(); await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(f.requests.filter(r => !/tui-auth-check|tui-model-bootstrap|\/catalog|\/model-quote/.test(r.path)).length, 0)
  } finally { release(); server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})
