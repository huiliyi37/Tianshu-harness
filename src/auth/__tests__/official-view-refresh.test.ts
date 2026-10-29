import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { officialFixture, fixtureSummary } from './official-model-auth.test.js'

test('an allowance refresh renews expired model access without a separate catalog poll or user login', async (context) => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker(), identity = broker.captureOfficialIdentity()!
    await broker.syncOfficialAccess(identity)
    assert.equal(fixture.bootstrapCalls, 1)
    const now = Date.now() + 300001
    context.mock.method(Date, 'now', () => now)
    assert.equal(broker.getOfficialStatus().status, 'expired')
    await broker.account(identity, { version: 2, requestId: randomUUID(), op: 'view.get', input: {} })
    assert.equal(fixture.bootstrapCalls, 2)
    assert.equal(broker.getOfficialStatus().status, 'ready')
    assert.ok(broker.getOfficialStatus().customerView)
    assert.equal(broker.captureOfficialIdentity()?.accountSessionId, identity.accountSessionId)
  } finally { await fixture.close() }
})

test('background customer refresh retains only unexpired same-source authority and retires it on failure', async (context) => {
  const fixture = await officialFixture()
  let release!: () => void
  let pending: Promise<unknown> | undefined
  try {
    await fixture.install('A')
    const broker = await fixture.broker(), identity = broker.captureOfficialIdentity()!
    await broker.syncOfficialAccess(identity)
    const expected = broker.getOfficialStatus().customerView
    assert.ok(expected)
    let now = performance.now()
    context.mock.method(performance, 'now', () => now)
    let entered!: () => void
    const entrance = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    fixture.setBeforeReply(async (path, body) => { if (path.endsWith('/tui-model-account') && body.op === 'view.get') { entered(); await barrier } })
    pending = broker.account(identity, { version: 2, requestId: randomUUID(), op: 'view.get', input: {} })
    await entrance
    assert.deepEqual(broker.getOfficialStatus().customerView, expected)
    now += 60000
    assert.equal(broker.getOfficialStatus().customerView, null)
    release(); await pending
    assert.deepEqual(broker.getOfficialStatus().customerView, expected)
    fixture.setBeforeReply(undefined)
    fixture.setOverride((path, body) => path.endsWith('/tui-model-account') && body.op === 'view.get' ? { status: 503, error: { code: 'service_error', retryable: true, message: 'synthetic unavailable' } } : undefined)
    await assert.rejects(broker.account(identity, { version: 2, requestId: randomUUID(), op: 'view.get', input: {} }))
    assert.equal(broker.getOfficialStatus().customerView, null)
  } finally { release?.(); await pending?.catch(() => {}); await fixture.close() }
})

for (const outcome of ['failure', 'success'] as const) test(`an older delayed customer response cannot overwrite a newer refresh ${outcome}`, async () => {
  const fixture = await officialFixture()
  let release!: () => void
  let pending: Promise<unknown> | undefined
  try {
    await fixture.install('A')
    const broker = await fixture.broker(), identity = broker.captureOfficialIdentity()!
    await broker.syncOfficialAccess(identity)
    const older = randomUUID(), newer = randomUUID()
    let entered!: () => void
    const entrance = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    fixture.setBeforeReply(async (_path, body) => { if (body.requestId === older) { entered(); await barrier } })
    pending = broker.account(identity, { version: 2, requestId: older, op: 'view.get', input: {} })
    await entrance
    fixture.setOverride((_path, body) => body.requestId === newer ? outcome === 'failure'
      ? { status: 503, error: { code: 'service_error', retryable: true, message: 'synthetic unavailable' } }
      : { data: { ...fixtureSummary(), revision: 'b'.repeat(64) } } : undefined)
    const refresh = broker.account(identity, { version: 2, requestId: newer, op: 'view.get', input: {} })
    if (outcome === 'failure') await assert.rejects(refresh)
    else await refresh
    assert.equal(broker.getOfficialStatus().customerView?.revision ?? null, outcome === 'failure' ? null : 'b'.repeat(64))
    release(); await pending
    assert.equal(broker.getOfficialStatus().customerView?.revision ?? null, outcome === 'failure' ? null : 'b'.repeat(64))
  } finally { release?.(); await pending?.catch(() => {}); await fixture.close() }
})
