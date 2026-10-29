import { test } from 'node:test'
import assert from 'node:assert/strict'
import { officialFixture, fixtureCatalog, fixtureConfiguration } from './official-model-auth.test.js'
import { accountStore } from '../account.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const serverCatalog = { ...fixtureCatalog, models: fixtureCatalog.models.map(model => ({ ...model, bindings: model.bindings.map(binding => ({ ...binding, billingMode: 'server' })) })) }

for (const [label, initial] of [
  ['empty', { ...serverCatalog, models: [] }],
  ['unavailable without bindings', { ...serverCatalog, models: serverCatalog.models.map(model => ({ ...model, status: 'unavailable', bindings: [] })) }],
  ['available without bindings', { ...serverCatalog, models: serverCatalog.models.map(model => ({ ...model, bindings: [] })) }],
  ['unavailable with server bindings', { ...serverCatalog, models: serverCatalog.models.map(model => ({ ...model, status: 'unavailable' })) }],
] as const) {
  test('startup catalog recovers from ' + label + ' and then caches executable server bindings', async () => {
    const fixture = await officialFixture()
    try {
      await fixture.install('A')
      const broker = await fixture.broker(), identity = broker.captureOfficialIdentity()!
      let recovered = false
      fixture.setOverride(path => path.endsWith('/catalog') ? { data: recovered ? serverCatalog : initial } : undefined)
      assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models.length, 0)
      recovered = true
      const available = await broker.getOfficialCatalog(identity, 'agent')
      assert.equal(available.models.length, 1)
      assert.equal(available.models[0]!.bindings[0]!.billingMode, 'server')
      assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 2)
      assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models.length, 1)
      assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 2)
      assert.equal(fixture.requests.filter(request => request.path.endsWith('/model-quote') || request.path.includes('/chat/completions')).length, 0)
    } finally { await fixture.close() }
  })
}

test('failed startup catalog read permits recovery and successful server catalog is read once', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker(), identity = broker.captureOfficialIdentity()!
    fixture.setOverride(path => path.endsWith('/catalog') ? { status: 503, error: { code: 'catalog_unavailable', retryable: false } } : undefined)
    await assert.rejects(broker.getOfficialCatalog(identity, 'agent'), /catalog_unavailable/)
    fixture.setOverride(path => path.endsWith('/catalog') ? { data: serverCatalog } : undefined)
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models.length, 1)
    await broker.getOfficialCatalog(identity, 'agent')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 2)
  } finally { await fixture.close() }
})

test('successful server startup catalog is isolated by configuration, official epoch and identity', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const configuration = structuredClone(fixtureConfiguration)
    const broker = (await import('../official-model-auth.js')).createOfficialModelBroker({ home: fixture.home, configuration, fetchImpl: fixture.fetchImpl })
    const identity = broker.captureOfficialIdentity()!
    fixture.setOverride(path => path.endsWith('/catalog') ? { data: serverCatalog } : undefined)
    const first = await broker.getOfficialCatalog(identity, 'agent')
    first.models[0]!.bindings.length = 0
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models[0]!.bindings.length, 1)
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 1)
    configuration.gatewayOrigins.push('https://second-gateway.invalid')
    await broker.getOfficialCatalog(identity, 'agent')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 2)
    await broker.clearOfficialAccess(identity)
    await assert.rejects(broker.getOfficialCatalog(identity, 'agent'), /account_changed/)
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 2)
    await broker.getOfficialCatalog(broker.captureOfficialIdentity()!, 'agent')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 3)
    accountStore(fixture.home).clear()
    await fixture.install('B')
    await assert.rejects(broker.getOfficialCatalog(identity, 'agent'), /account_changed/)
    await broker.getOfficialCatalog(broker.captureOfficialIdentity()!, 'agent')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 4)
  } finally { await fixture.close() }
})

test('read-only catalogs do not durably rewrite credential material and current quotes use the latest observed revision', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker(), identity = broker.captureOfficialIdentity()!
    await broker.getOfficialCredential(identity)
    const before = readFileSync(join(fixture.home, 'official-access.json'), 'utf8')
    await broker.getOfficialCatalog(identity, 'agent')
    assert.equal(readFileSync(join(fixture.home, 'official-access.json'), 'utf8'), before, 'a catalog read must not fsync and re-encrypt the durable credential store')
    fixture.setOverride((path, _body, data) => path.endsWith('/catalog') ? { data: { ...(data as object), revision: 'observed-2' } } : undefined)
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).revision, 'observed-2')
    assert.equal(broker.getOfficialStatus().catalogRevision, 'observed-2')
    await assert.rejects(broker.getOfficialPriceQuote(identity, { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }), /pricing_changed/)
    assert.equal(readFileSync(join(fixture.home, 'official-access.json'), 'utf8'), before)
  } finally { await fixture.close() }
})

test('catalog fanout shares concurrent reads but later reads and explicit sync still require the network', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker()
    const identity = broker.captureOfficialIdentity()!
    const copies = await Promise.all(Array.from({ length: 8 }, () => broker.getOfficialCatalog(identity, 'agent')))
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 1)
    copies[0]!.models[0]!.displayName = 'caller mutation'
    assert.ok(copies.slice(1).every(copy => copy.models[0]!.displayName === 'Fixture'))
    await broker.getOfficialCatalog(identity, 'agent')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 2)
    fixture.setOverride((path, _body, data) => path.endsWith('/catalog') ? { data: { ...(data as object), revision: 'catalog-2' } } : undefined)
    await broker.syncOfficialAccess(identity)
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).revision, 'catalog-2')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 4)
    accountStore(fixture.home).clear()
    await assert.rejects(broker.getOfficialCatalog(identity, 'agent'), /account_changed/)
    await fixture.install('B')
    const next = broker.captureOfficialIdentity()!
    assert.equal((await broker.getOfficialCatalog(next, 'agent')).revision, 'catalog-2')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 5)
  } finally { await fixture.close() }
})

test('concurrent first catalog reads share one request without sharing caller cancellation', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker()
    const identity = broker.captureOfficialIdentity()!
    await broker.getOfficialCredential(identity)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    fixture.setBeforeReply(async path => { if (path.endsWith('/catalog')) { entered(); await held } })
    const controller = new AbortController()
    const cancelled = broker.getOfficialCatalog(identity, 'agent', controller.signal)
    const rejected = assert.rejects(cancelled)
    await started
    const continued = broker.getOfficialCatalog(identity, 'agent')
    controller.abort()
    release()
    await rejected
    assert.equal((await continued).revision, 'catalog-1')
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/catalog')).length, 1)
  } finally { await fixture.close() }
})

test('a quote exhausted in transit is reacquired once without replaying inference or accepting short authority', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker(), identity = broker.captureOfficialIdentity()!
    await broker.getOfficialCatalog(identity, 'agent')
    let quotes = 0
    fixture.setOverride((path, _body, data) => path.endsWith('/model-quote') && ++quotes === 1 ? { data: { ...(data as object), validUntil: new Date(Date.now() + 2000).toISOString() } } : undefined)
    const quote = await broker.getOfficialPriceQuote(identity, { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' })
    assert.ok(Date.parse(quote.validUntil) - Date.now() > 5000)
    assert.equal(quotes, 2)
    const requests = fixture.requests.filter(request => request.path.endsWith('/model-quote'))
    assert.notEqual((requests[0]!.body as { requestId: string }).requestId, (requests[1]!.body as { requestId: string }).requestId)
    quotes = 0
    fixture.setOverride((path, _body, data) => {
      if (!path.endsWith('/model-quote')) return undefined
      quotes++
      return { data: { ...(data as object), validUntil: new Date(Date.now() + 2000).toISOString() } }
    })
    await assert.rejects(broker.getOfficialPriceQuote(identity, { bindingId: 'chat-1', catalogRevision: 'catalog-1', pricingRevision: 'price-1' }), /pricing_changed/)
    assert.equal(quotes, 2, 'unusable authority must stop after one bounded read retry')
    assert.equal(fixture.requests.filter(request => request.path.includes('/chat/completions')).length, 0)
  } finally { await fixture.close() }
})
