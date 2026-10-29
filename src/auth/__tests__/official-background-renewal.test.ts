import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createOfficialModelBroker } from '../official-model-auth.js'
import { accountStore } from '../account.js'
import { fixtureConfiguration, officialFixture } from './official-model-auth.test.js'

test('allowance observation renews before expiry while a valid foreground grant remains nonblocking', async context => {
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const fixture = await officialFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let renewal: Promise<unknown> | undefined
  try {
    await fixture.install('A')
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: fixtureConfiguration, fetchImpl: fixture.fetchImpl })
    const identity = broker.captureOfficialIdentity()!
    const read = () => broker.account(identity, { version: 2, op: 'view.get', input: {}, requestId: randomUUID() })
    await read()
    const original = await broker.getOfficialCredential(identity)
    now += 275000
    fixture.setBeforeReply(async path => { if (path.endsWith('/tui-model-bootstrap')) { entered(); await held } })
    renewal = read()
    void renewal.catch(() => {})
    assert.equal(await Promise.race([started.then(() => 'renewing'), renewal.then(() => 'finished')]), 'renewing')
    assert.equal(broker.getOfficialStatus().status, 'ready')
    assert.ok(broker.getOfficialStatus().customerView)
    let foregroundSettled = false
    const foreground = broker.getOfficialCredential(identity).then(value => { foregroundSettled = true; return value })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(foregroundSettled, true, 'a still-valid model request must not join background renewal')
    assert.equal((await foreground).credential, original.credential)
    release()
    await renewal
    assert.equal(fixture.bootstrapCalls, 2)
    assert.equal(broker.getOfficialStatus().status, 'ready')
    assert.ok(Date.parse(broker.getOfficialStatus().expiresAt!) > Date.parse(original.expiresAt))
    assert.equal(fixture.requests.some(request => request.path.endsWith('/catalog')), false)
    now += 301000
    assert.equal(broker.getOfficialStatus().status, 'expired')
    assert.equal(broker.getOfficialStatus().customerView, null)
  } finally { release(); await renewal?.catch(() => {}); await fixture.close() }
})

test('background allowance renewal cannot install authority after the original account logs out', async context => {
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const fixture = await officialFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let renewal: Promise<unknown> | undefined
  try {
    await fixture.install('A')
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: fixtureConfiguration, fetchImpl: fixture.fetchImpl })
    const identity = broker.captureOfficialIdentity()!
    const read = () => broker.account(identity, { version: 2, op: 'view.get', input: {}, requestId: randomUUID() })
    await read()
    now += 275000
    fixture.setBeforeReply(async path => { if (path.endsWith('/tui-model-bootstrap')) { entered(); await held } })
    renewal = read()
    void renewal.catch(() => {})
    assert.equal(await Promise.race([started.then(() => 'renewing'), renewal.then(() => 'finished', () => 'rejected')]), 'renewing')
    const rejected = assert.rejects(renewal, { code: 'account_changed' })
    accountStore(fixture.home).clear()
    release()
    await rejected
    assert.equal(broker.getOfficialStatus().identity, null)
    assert.equal(broker.getOfficialStatus().customerView, null)
  } finally { release(); await renewal?.catch(() => {}); await fixture.close() }
})

test('background renewal fences authoritative denial but preserves a valid grant after a transient failure', async context => {
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  for (const [status, code] of [[401, 'auth_required'], [401, 'account_changed'], [503, 'service_error']] as const) {
    const fixture = await officialFixture()
    try {
      await fixture.install('A')
      const broker = createOfficialModelBroker({ home: fixture.home, configuration: fixtureConfiguration, fetchImpl: fixture.fetchImpl })
      const identity = broker.captureOfficialIdentity()!
      const read = () => broker.account(identity, { version: 2, op: 'view.get', input: {}, requestId: randomUUID() })
      await read()
      const original = await broker.getOfficialCredential(identity)
      now += 275000
      fixture.setOverride(path => path.endsWith('/tui-model-bootstrap') ? { status, error: { code, message: code, retryable: status === 503 } } : undefined)
      await assert.rejects(read(), { code })
      if (status === 401) await assert.rejects(broker.getOfficialCredential(identity), { code: 'account_changed' })
      else assert.equal((await broker.getOfficialCredential(identity)).credential, original.credential)
      assert.equal(broker.getOfficialStatus().customerView, null)
    } finally { await fixture.close() }
  }
})

test('a late background renewal failure cannot erase the replacement account observation', async context => {
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const fixture = await officialFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let renewal: Promise<unknown> | undefined
  try {
    await fixture.install('A')
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: fixtureConfiguration, fetchImpl: fixture.fetchImpl })
    const original = broker.captureOfficialIdentity()!
    const read = (identity: typeof original) => broker.account(identity, { version: 2, op: 'view.get', input: {}, requestId: randomUUID() })
    await read(original)
    now += 275000
    let heldOnce = false
    fixture.setBeforeReply(async path => { if (path.endsWith('/tui-model-bootstrap') && !heldOnce) { heldOnce = true; entered(); await held } })
    renewal = read(original)
    void renewal.catch(() => {})
    assert.equal(await Promise.race([started.then(() => 'renewing'), renewal.then(() => 'finished', () => 'rejected')]), 'renewing')
    await fixture.install('B')
    const replacement = broker.captureOfficialIdentity()!
    await read(replacement)
    const observed = broker.getOfficialStatus().customerView
    assert.ok(observed)
    release()
    await assert.rejects(renewal, { code: 'account_changed' })
    assert.equal(broker.getOfficialStatus().identity?.subject, replacement.subject)
    assert.deepEqual(broker.getOfficialStatus().customerView, observed)
    assert.ok(await broker.getOfficialCredential(replacement))
  } finally { release(); await renewal?.catch(() => {}); await fixture.close() }
})

test('a local renewal lease timeout does not revoke the still-valid original grant', async context => {
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: fixtureConfiguration, fetchImpl: fixture.fetchImpl })
    const identity = broker.captureOfficialIdentity()!
    const read = () => broker.account(identity, { version: 2, op: 'view.get', input: {}, requestId: randomUUID() })
    await read()
    const original = await broker.getOfficialCredential(identity)
    now += 275000
    fixture.setBeforeReply(async path => { if (path.endsWith('/tui-model-bootstrap')) now += 16000 })
    await assert.rejects(read(), { code: 'account_changed', status: 409 })
    assert.equal(broker.getOfficialStatus().status, 'ready')
    assert.equal(broker.getOfficialStatus().customerView, null)
    assert.equal((await broker.getOfficialCredential(identity)).credential, original.credential)
    assert.equal(fixture.bootstrapCalls, 2)
  } finally { await fixture.close() }
})
