import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { test } from 'node:test'
import { Agent, errors, fetch as undiciFetch } from 'undici'
import { accountStore, refreshAccountTokenWithStatus } from '../account.js'
import { refreshAccountSession } from '../refresh.js'
import { createOfficialModelBroker } from '../official-model-auth.js'
import { fixtureConfiguration, officialFixture } from './official-model-auth.test.js'
import { createAccountFetch } from '../../server/account-network.js'

test('a real TLS connection timeout proves renewal was not sent', async () => {
  const fixture = await officialFixture()
  const sockets = new Set<Socket>()
  const received: Buffer[] = []
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('data', data => received.push(data))
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  const dispatcher = new Agent({ connectTimeout: 80 })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const result = await refreshAccountTokenWithStatus('fixture-unsent-refresh', {
      fetchImpl: async (_input, init) => await undiciFetch(`https://127.0.0.1:${port}/functions/v1/tui-auth-refresh`, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response,
    })
    assert.equal(result.code, 'network_error')
    assert.equal((result as typeof result & { requestNotSent?: boolean }).requestNotSent, true)
    assert.equal(Buffer.concat(received).includes(Buffer.from('fixture-unsent-refresh')), false)
    assert.equal(Buffer.concat(received).includes(Buffer.from('POST /functions/')), false)
  } finally {
    await dispatcher.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fixture.close()
  }
})

test('the production renewal transport reports a connection failure before the overall auth deadline', async () => {
  const fixture = await officialFixture()
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/functions/v1/tui-auth-refresh`
    const transport = createAccountFetch(() => ({ noProxy: '*' }))
    const result = await refreshAccountTokenWithStatus('fixture-unsent-refresh', { fetchImpl: (_input, init) => transport(endpoint, init) })
    assert.equal(result.code, 'network_error')
    assert.equal(result.requestNotSent, true)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fixture.close()
  }
})

test('proven unsent renewal survives rereading the store and recovers only after its cooldown', async context => {
  const fixture = await officialFixture()
  try {
    const original = await fixture.install('A')
    const store = accountStore(fixture.home)
    const before = store.readAccountState()!
    let attempts = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      attempts++
      if (attempts === 1) throw new TypeError('fetch failed', { cause: new errors.ConnectTimeoutError() })
      return fixture.fetchImpl(input, init)
    }
    const failed = await refreshAccountSession(store, original, { fetchImpl })
    assert.equal(failed.code, 'network_error')
    assert.equal(failed.retryAfterSeconds, 30)
    assert.equal(store.readAccountState()?.refresh?.uncertain, undefined)
    const deferred = await refreshAccountSession(accountStore(fixture.home), original, { fetchImpl })
    assert.equal(deferred.code, 'network_error')
    assert.equal(deferred.retryAfterSeconds, 30)
    assert.equal(attempts, 1)
    store.transaction(state => { state.refresh!.pid = 2147483647; return { value: undefined, write: true } })
    const later = Date.now() + 31000
    context.mock.method(Date, 'now', () => later)
    const recoveredReplies = await Promise.all(Array.from({ length: 20 }, () => refreshAccountSession(accountStore(fixture.home), original, { fetchImpl })))
    const recovered = recoveredReplies[0]!
    assert.equal(recovered.code, 'ok')
    assert.equal(recoveredReplies.every(reply => reply.code === 'ok' && reply.token?.accessToken === recovered.token?.accessToken), true)
    assert.notEqual(recovered.token?.accessToken, original.accessToken)
    assert.equal(fixture.rotations, 1)
    assert.equal(attempts, 2)
    assert.equal(store.readAccountState()?.refresh, undefined)
    assert.equal(store.readAccountState()?.generation, before.generation)
    assert.equal(store.readAccountState()?.officialEpoch, before.officialEpoch)
  } finally { await fixture.close() }
})

test('ambiguous, cancelled, forged and HTTP failures retain the no-replay fence', async () => {
  const failures = [
    new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
    new TypeError('fetch failed', { cause: new errors.HeadersTimeoutError() }),
    new TypeError('fetch failed', { cause: new errors.BodyTimeoutError() }),
    new DOMException('timeout', 'TimeoutError'),
    new DOMException('cancelled', 'AbortError'),
    new TypeError('fetch failed', { cause: { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' } }),
    new Response('{}', { status: 503 }),
    new Response('{}', { status: 200 }),
    new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('fetch failed', { cause: new errors.ConnectTimeoutError() })) } })),
  ]
  for (const failure of failures) {
    const fixture = await officialFixture()
    try {
      const original = await fixture.install('A')
      const store = accountStore(fixture.home)
      let attempts = 0
      const fetchImpl: typeof fetch = async () => {
        attempts++
        if (failure instanceof Response) return failure
        throw failure
      }
      const result = await refreshAccountSession(store, original, { fetchImpl })
      assert.notEqual(result.code, 'ok')
      assert.equal(store.readAccountState()?.refresh?.uncertain, true)
      const next = await refreshAccountSession(store, original, { fetchImpl })
      assert.equal(next.code, 'auth_required')
      assert.equal(attempts, 1)
      assert.equal(fixture.rotations, 0)
    } finally { await fixture.close() }
  }
})

test('an uncertain or malformed cooldown can never unlock an installed refresh credential', async () => {
  for (const variation of ['uncertain', 'fingerprint', 'future', 'invalid'] as const) {
    const fixture = await officialFixture()
    try {
      const original = await fixture.install('A')
      const store = accountStore(fixture.home)
      await refreshAccountSession(store, original, { fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new errors.ConnectTimeoutError() }) } })
      store.transaction(state => {
        if (variation === 'uncertain') state.refresh!.uncertain = true
        if (variation === 'fingerprint') state.refresh!.fingerprint = 'invalid-fingerprint'
        if (variation === 'future') state.refresh!.retryAfter = Date.now() + 60000
        if (variation === 'invalid') state.refresh!.retryAfter = -1
        return { value: undefined, write: true }
      })
      let attempts = 0
      const result = await refreshAccountSession(store, original, { fetchImpl: async () => { attempts++; return new Response('{}') } })
      assert.equal(result.code, 'auth_required')
      assert.equal(attempts, 0)
      assert.equal(store.readAccountState()?.refresh?.uncertain, true)
    } finally { await fixture.close() }
  }
})

test('an unsent failure cannot modify a newer login or undo logout', async () => {
  for (const operation of ['logout', 'login'] as const) {
    const fixture = await officialFixture()
    try {
      const original = await fixture.install('A')
      const store = accountStore(fixture.home)
      let release!: () => void
      const blocked = new Promise<void>(resolve => { release = resolve })
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const pending = refreshAccountSession(store, original, { fetchImpl: async () => {
        entered()
        await blocked
        throw new TypeError('fetch failed', { cause: new errors.ConnectTimeoutError() })
      } })
      await started
      if (operation === 'logout') store.clear()
      else await fixture.install('B')
      const expected = store.readAccountState()!
      release()
      assert.equal((await pending).code, 'account_changed')
      assert.deepEqual(store.readAccountState(), expected)
    } finally { await fixture.close() }
  }
})

test('official broker reports unsent renewal as temporary and recovers without changing identity', async context => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const store = accountStore(fixture.home)
    store.transaction(state => { state.token!.expiresAt = Date.now() + 30000; return { value: undefined, write: true } })
    let failures = 1
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: fixtureConfiguration, fetchImpl: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/tui-auth-refresh') && failures-- > 0) throw new TypeError('fetch failed', { cause: new errors.ConnectTimeoutError() })
      return fixture.fetchImpl(input, init)
    } })
    const identity = broker.captureOfficialIdentity()!
    await assert.rejects(broker.getOfficialCredential(identity), { code: 'service_error' })
    assert.deepEqual(broker.captureOfficialIdentity(), identity)
    const later = Date.now() + 31000
    context.mock.method(Date, 'now', () => later)
    assert.ok((await broker.getOfficialCredential(identity)).credential)
    assert.equal(fixture.rotations, 1)
    assert.equal(fixture.requests.filter(request => request.path === '/v1/chat/completions').length, 0)
  } finally { await fixture.close() }
})
