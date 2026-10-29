import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { officialFixture, fixtureConfiguration } from './official-model-auth.test.js'
import { createOfficialDirectAccess } from '../official-direct-access.js'
import { OfficialError, type OfficialIdentityRef } from '../../models/official-contract.js'
import { accountStore } from '../account.js'

const configuration = { ...fixtureConfiguration, directAccess: true, supplierOrigins: ['https://supplier.invalid'] }
const isChanged = (error: unknown) => error instanceof Error && error.message === 'account_changed'

test('direct access is opt-in, singleflight and memory-only; ordinary control credentials stay separate', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const legacy = await fixture.broker({ ...fixtureConfiguration, directAccess: false }), broker = await fixture.broker(configuration)
    assert.equal(typeof broker.getOfficialDirectAccess, 'function')
    assert.equal(await legacy.getOfficialDirectAccess(legacy.captureOfficialIdentity()!), null)
    assert.equal(fixture.bootstrapCalls, 0)
    const identity = broker.captureOfficialIdentity()!
    const grants = await Promise.all(Array.from({ length: 10 }, () => broker.getOfficialDirectAccess(identity)))
    assert.equal(fixture.bootstrapCalls, 1)
    assert.ok(grants.every(grant => grant?.credential === 'sk-synthetic-direct-A'))
    assert.equal(grants[0]?.origin, 'https://supplier.invalid')
    assert.ok(!JSON.stringify(broker.getOfficialStatus()).includes('sk-synthetic-direct'))
    const control = await broker.getOfficialCredential(identity)
    assert.notEqual(control.credential, grants[0]?.credential)
    for (const file of readdirSync(fixture.home, { withFileTypes: true })) if (file.isFile()) assert.ok(!readFileSync(join(fixture.home, file.name), 'utf8').includes('sk-synthetic-direct'), file.name)
    const restarted = await fixture.broker(configuration)
    await restarted.getOfficialDirectAccess(restarted.captureOfficialIdentity()!)
    assert.equal(fixture.bootstrapCalls, 3, 'a new process-local broker must exchange again, never read a stored supplier key')
  } finally { await fixture.close() }
})

test('logout fences an in-flight direct exchange without changing the supplier credential of another device', async () => {
  const fixture = await officialFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await fixture.install('A'); const broker = await fixture.broker(configuration), identity = broker.captureOfficialIdentity()!
    assert.equal(typeof broker.getOfficialDirectAccess, 'function')
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    fixture.setBeforeReply(async (_path, body) => { if (body.transport === 'direct') { started(); await held } })
    const request = broker.getOfficialDirectAccess(identity)
    const denied = assert.rejects(request, isChanged)
    await waiting; await broker.clearOfficialAccess(identity); release(); await denied
    fixture.setBeforeReply(undefined)
    const otherDevice = await fixture.broker(configuration)
    const grant = await otherDevice.getOfficialDirectAccess(otherDevice.captureOfficialIdentity()!)
    assert.equal(grant?.credential, 'sk-synthetic-direct-A')
    assert.equal(fixture.ended.length, 0)
    assert.ok(fixture.requests.every(request => !request.path.includes('/api/token/')))
  } finally { release(); await fixture.close() }
})

test('a late A exchange cannot install a key or clear the new B account', async () => {
  const fixture = await officialFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await fixture.install('A'); const broker = await fixture.broker(configuration), identity = broker.captureOfficialIdentity()!
    assert.equal(typeof broker.getOfficialDirectAccess, 'function')
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    fixture.setBeforeReply(async (_path, body) => { if (body.transport === 'direct') { started(); await held } })
    const denied = assert.rejects(broker.getOfficialDirectAccess(identity), isChanged)
    await waiting; await fixture.install('B'); fixture.setBeforeReply(undefined)
    const current = broker.captureOfficialIdentity()!
    const next = await broker.getOfficialDirectAccess(current)
    release(); await denied
    assert.equal(next?.credential, 'sk-synthetic-direct-B')
    assert.equal((await broker.getOfficialDirectAccess(current))?.credential, next?.credential)
  } finally { release(); await fixture.close() }
})

test('direct grants reject foreign owners, routes, redirects and expired or excessive leases without exposing diagnostics', async () => {
  for (const change of [
    { subject: '22222222-2222-4222-8222-222222222222' }, { accountSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { origin: 'https://foreign.invalid' }, { origin: 'https://supplier.invalid/other' }, { path: '/v1/other' },
    { protocol: 'anthropic' }, { expiresAt: new Date(1).toISOString() }, { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    { serviceRole: 'synthetic-hidden' },
  ]) {
    const fixture = await officialFixture()
    try {
      await fixture.install('A'); const broker = await fixture.broker(configuration)
      assert.equal(typeof broker.getOfficialDirectAccess, 'function')
      fixture.setOverride((_path, body, data) => body.transport === 'direct' ? { data: { ...(data as object), ...change } } : undefined)
      await assert.rejects(broker.getOfficialDirectAccess(broker.captureOfficialIdentity()!), error => error instanceof Error && ['service_error', 'account_changed'].includes(error.message))
      assert.ok(!JSON.stringify(broker.getOfficialStatus()).includes('synthetic-hidden'))
    } finally { await fixture.close() }
  }
})

test('direct lease renews independently of sending and preserves a valid lease through a transient control outage', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let now = Date.now(), calls = 0, epoch = 0
  const identity: OfficialIdentityRef = { subject: '11111111-1111-4111-8111-111111111111', accountSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: 'synthetic-device', generation: 1, incarnation: 'synthetic-incarnation' }
  const grant = () => ({ credential: 'sk-synthetic-memory-only', subject: identity.subject, accountSessionId: identity.accountSessionId, expiresAt: new Date(now + 600000).toISOString(), catalogRevision: 'catalog-1', bindingId: 'chat-1', modelId: 'fixture-model', protocol: 'openai', origin: 'https://supplier.invalid', path: '/v1/chat/completions' })
  let fail = false
  const broker = createOfficialDirectAccess({ enabled: () => true, origins: () => ['https://supplier.invalid'], epoch: () => epoch, now: () => now, exchange: async () => { calls++; if (fail) throw new OfficialError('service_error'); return grant() } })
  try {
    const original = await broker.get(identity)
    assert.equal(calls, 1)
    now += 570000; context.mock.timers.tick(570000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls, 2, 'renewal must happen without view.get, a user submission or a balance refresh')
    const renewed = broker.peek(identity)
    assert.ok(Date.parse(renewed!.expiresAt) > Date.parse(original!.expiresAt))
    fail = true; now += 570000; context.mock.timers.tick(570000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls, 3)
    assert.equal(broker.peek(identity), renewed, 'transient control errors cannot erase an unexpired usable lease')
    const before = calls
    for (const read of [1, 2, 3]) { assert.equal(broker.peek(identity), renewed, String(read)); assert.equal(calls, before) }
    epoch++; assert.equal(broker.peek(identity), null)
    context.mock.timers.tick(600000); await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls, before, 'local logout cancels this process lease, not the supplier key')
  } finally { broker.clear() }
})

test('clearing the local account immediately clears its direct capability without logging out another device', async () => {
  const first = await officialFixture(), second = await officialFixture()
  try {
    await first.install('A'); await second.install('A')
    const broker = await first.broker(configuration), other = await second.broker(configuration)
    const identity = broker.captureOfficialIdentity()!, otherIdentity = other.captureOfficialIdentity()!
    await broker.getOfficialDirectAccess(identity); await other.getOfficialDirectAccess(otherIdentity)
    const signal = broker.getOfficialDirectSignal(identity), otherSignal = other.getOfficialDirectSignal(otherIdentity)
    assert.equal(signal.aborted, false)
    accountStore(first.home).clear()
    assert.equal(signal.aborted, true, 'account tombstone must cancel the native direct owner synchronously')
    assert.equal(otherSignal.aborted, false)
    assert.equal((await other.getOfficialDirectAccess(otherIdentity))?.credential, 'sk-synthetic-direct-A')
    assert.equal(first.ended.length + second.ended.length, 0)
  } finally { await first.close(); await second.close() }
})

test('authoritative direct renewal denials abort the active owner without affecting a replacement account', async () => {
  const identity: OfficialIdentityRef = { subject: '11111111-1111-4111-8111-111111111111', accountSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: 'synthetic-device', generation: 1, incarnation: 'synthetic-incarnation' }
  for (const code of ['auth_required', 'account_changed', 'credential_revoked', 'reauth_required'] as const) {
    let now = Date.now(), denied = false
    const access = createOfficialDirectAccess({ enabled: () => true, origins: () => ['https://supplier.invalid'], epoch: () => 0, now: () => now, exchange: async () => {
      if (denied) throw new OfficialError(code)
      return { credential: 'sk-synthetic-authority', subject: identity.subject, accountSessionId: identity.accountSessionId, expiresAt: new Date(now + 300000).toISOString(), catalogRevision: 'catalog-1', bindingId: 'chat-1', modelId: 'fixture-model', protocol: 'openai', origin: 'https://supplier.invalid', path: '/v1/chat/completions' }
    } })
    try {
      await access.get(identity)
      const signal = access.signal(identity)
      denied = true; now += 280000
      await access.get(identity); await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(access.peek(identity), null, code)
      assert.equal(signal.aborted, true, code)
    } finally { access.clear() }
  }
  let now = Date.now(), epoch = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let denyOld = false, arrived!: () => void
  const waiting = new Promise<void>(resolve => { arrived = resolve })
  const next = { ...identity, subject: '22222222-2222-4222-8222-222222222222', generation: 2 }
  const access = createOfficialDirectAccess({ enabled: () => true, origins: () => ['https://supplier.invalid'], epoch: () => epoch, now: () => now, exchange: async current => {
    if (denyOld && current.subject === identity.subject) { arrived(); await held; throw new OfficialError('credential_revoked') }
    return { credential: 'sk-synthetic-' + current.generation, subject: current.subject, accountSessionId: current.accountSessionId, expiresAt: new Date(now + 300000).toISOString(), catalogRevision: 'catalog-1', bindingId: 'chat-1', modelId: 'fixture-model', protocol: 'openai', origin: 'https://supplier.invalid', path: '/v1/chat/completions' }
  } })
  try {
    await access.get(identity); denyOld = true; now += 280000
    await access.get(identity); await waiting
    epoch++; await access.get(next)
    const nextSignal = access.signal(next)
    release(); await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(nextSignal.aborted, false)
    assert.equal(access.peek(next)?.credential, 'sk-synthetic-2')
  } finally { release(); access.clear() }
})

test('a valid direct lease and startup catalog survive a transient expired control credential without a send-path lookup', async context => {
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const fixture = await officialFixture()
  try {
    await fixture.install('A'); const broker = await fixture.broker(configuration), identity = broker.captureOfficialIdentity()!
    fixture.setOverride((path, body, data) => {
      if (path.endsWith('/catalog')) {
        const catalog = structuredClone(data) as { models: Array<{ bindings: Array<{ billingMode?: string }> }> }
        catalog.models[0]!.bindings[0]!.billingMode = 'server'
        return { data: catalog }
      }
      if (path.endsWith('/tui-model-bootstrap') && body.transport !== 'direct') return { data: { ...(data as object), expiresAt: new Date(now + 10000).toISOString() } }
      return undefined
    })
    const grant = await broker.getOfficialDirectAccess(identity)
    const initial = await broker.getOfficialCatalog(identity, 'agent')
    now += 15000
    const count = fixture.requests.length
    fixture.setOverride((_path, body) => body.transport === undefined ? { status: 503, error: { code: 'service_error', message: 'service_error', retryable: true } } : undefined)
    assert.equal(broker.getOfficialStatus().status, 'ready')
    assert.equal(broker.getOfficialStatus().expiresAt, grant?.expiresAt)
    assert.deepEqual(await broker.getOfficialCatalog(identity, 'agent'), initial)
    assert.equal(fixture.requests.length, count)
    accountStore(fixture.home).clear()
    assert.equal(broker.getOfficialStatus().status, 'unauthenticated')
  } finally { await fixture.close() }
})

test('confirmed supplier refusal discards only this local lease and selects renewed funded capacity in the background', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const identity: OfficialIdentityRef = { subject: '11111111-1111-4111-8111-111111111111', accountSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: 'synthetic-device', generation: 1, incarnation: 'synthetic-incarnation' }
  let calls = 0
  const access = createOfficialDirectAccess({ enabled: () => true, origins: () => ['https://supplier.invalid'], epoch: () => 0, now: Date.now, exchange: async () => ({ credential: `sk-synthetic-funding-${++calls}`, subject: identity.subject, accountSessionId: identity.accountSessionId, expiresAt: new Date(Date.now() + 600000).toISOString(), catalogRevision: 'catalog-1', bindingId: 'chat-1', modelId: 'fixture-model', protocol: 'openai', origin: 'https://supplier.invalid', path: '/v1/chat/completions' }) })
  try {
    const original = await access.get(identity), signal = access.signal(identity)
    access.invalidate(identity)
    assert.equal(access.peek(identity), null)
    assert.equal(signal.aborted, true)
    assert.equal(calls, 1, 'refusal handling must not block on the control plane or replay inference')
    context.mock.timers.tick(1000); await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls, 2)
    assert.notEqual(access.peek(identity)?.credential, original?.credential)
    assert.equal(access.signal(identity).aborted, false)
  } finally { access.clear() }
})

test('default native transport follows the authenticated server offer without carrying A access into B or overriding a local opt-out', async () => {
  const fixture = await officialFixture()
  const automatic = { ...fixtureConfiguration, supplierOrigins: ['https://supplier.invalid'] }
  try {
    await fixture.install('A'); const broker = await fixture.broker(automatic), identity = broker.captureOfficialIdentity()!
    fixture.setOverride((path, body, data) => path.endsWith('/tui-model-bootstrap') && body.transport !== 'direct' ? { data: { ...(data as object), directAvailable: true } } : undefined)
    assert.equal((await broker.getOfficialDirectAccess(identity))?.credential, 'sk-synthetic-direct-A')
    const optedOut = await fixture.broker({ ...automatic, directAccess: false })
    const optOutIdentity = optedOut.captureOfficialIdentity()!
    await optedOut.getOfficialCredential(optOutIdentity)
    assert.equal(await optedOut.getOfficialDirectAccess(optOutIdentity), null)
    fixture.setOverride((path, body, data) => path.endsWith('/tui-model-bootstrap') && body.transport !== 'direct' ? { data: { ...(data as object), directAvailable: false } } : undefined)
    await fixture.install('B')
    const next = broker.captureOfficialIdentity()!
    assert.equal(await broker.getOfficialDirectAccess(next), null)
    await broker.getOfficialCredential(next)
    assert.equal(await broker.getOfficialDirectAccess(next), null)
    assert.equal(fixture.requests.filter(request => request.body.transport === 'direct').length, 1)
  } finally { await fixture.close() }
})

test('AUTO startup negotiates a persisted legacy offer once while explicit opt-out and unsupported servers stay compatible', async () => {
  for (const advertised of [true, false, undefined]) {
    const fixture = await officialFixture()
    try {
      await fixture.install('A')
      const old = await fixture.broker({ ...fixtureConfiguration, directAccess: false })
      assert.equal((await old.getOfficialCredential(old.captureOfficialIdentity()!)).directAvailable, undefined)
      fixture.setOverride((path, body, data) => path.endsWith('/tui-model-bootstrap') && body.transport !== 'direct' && advertised !== undefined ? { data: { ...(data as object), directAvailable: advertised } } : undefined)
      const automatic = { ...fixtureConfiguration, supplierOrigins: ['https://supplier.invalid'] }
      const optedOut = await fixture.broker({ ...automatic, directAccess: false })
      const before = fixture.bootstrapCalls
      assert.equal(await optedOut.getOfficialDirectAccess(optedOut.captureOfficialIdentity()!), null)
      assert.equal(fixture.bootstrapCalls, before)
      const broker = await fixture.broker(automatic), identity = broker.captureOfficialIdentity()!
      await broker.account(identity, { version: 2, op: 'view.get', input: {}, requestId: 'synthetic-startup-view' })
      await broker.syncOfficialAccess(identity)
      const direct = await broker.getOfficialDirectAccess(identity)
      assert.equal(direct !== null, advertised === true)
      const afterStartup = fixture.bootstrapCalls
      assert.equal(afterStartup - before, advertised === true ? 2 : 1)
      for (let read = 0; read < 3; read++) await broker.getOfficialDirectAccess(identity)
      assert.equal(fixture.bootstrapCalls, afterStartup, 'a legacy server does not cause repeated capability negotiation')
    } finally { await fixture.close() }
  }
})
