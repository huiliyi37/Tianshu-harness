import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOfficialModelBroker, getOfficialGatewayOrigin, type OfficialConfiguration } from '../official-model-auth.js'
import { createSecretCipher, decodeSecret } from '../secure-store.js'
import { fixtureCatalog, officialFixture } from './official-model-auth.test.js'

const origin = 'https://tianshuharness.com'
const environmentKeys = ['RIVET_OFFICIAL_GATEWAY_ORIGIN', 'RIVET_OFFICIAL_GATEWAY_ORIGINS', 'RIVET_OFFICIAL_PORTAL_ORIGIN'] as const

async function shippingFixture(run: (fixture: Awaited<ReturnType<typeof officialFixture>>) => Promise<void>) {
  const previous = environmentKeys.map(name => process.env[name])
  for (const name of environmentKeys) delete process.env[name]
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    await run(fixture)
  } finally {
    for (const [index, name] of environmentKeys.entries()) {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    }
    await fixture.close()
  }
}

test('shipping defaults authorize exactly the production HTTPS gateway and portal without launcher overrides', async () => {
  await shippingFixture(async fixture => {
    const catalog = structuredClone(fixtureCatalog)
    catalog.models[0]!.bindings[0]!.origin = origin
    fixture.setOverride(path => path.endsWith('/catalog') ? { data: catalog } : undefined)
    const broker = createOfficialModelBroker({ home: fixture.home, fetchImpl: fixture.fetchImpl })
    assert.equal(getOfficialGatewayOrigin(), origin)
    const identity = broker.captureOfficialIdentity()!
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models[0]!.bindings[0]!.origin, origin)
    assert.deepEqual(fixture.urls.filter(url => url.endsWith('/catalog')), [`${origin}/api/official/v2/customer/catalog`])
    assert.deepEqual(broker.getOfficialStatus().portalLinks, {
      wallet: `${origin}/space/models?tab=wallet`, usage: `${origin}/space/models?tab=usage`,
    })
    const raw = readFileSync(join(fixture.home, 'official-access.json'), 'utf8')
    const cached = JSON.parse(decodeSecret(createSecretCipher(fixture.home, 'local-key'), raw)!)
    assert.equal(cached.configuration, createHash('sha256').update(JSON.stringify([origin, [origin]])).digest('hex'))
    fixture.setOverride(path => path.endsWith('/catalog') ? { data: fixtureCatalog } : undefined)
    await assert.rejects(broker.getOfficialCatalog(identity, 'agent'), /service_error|catalog_unavailable/)
  })
})

test('explicit invalid or mismatched gateway configuration cannot fall back to shipping defaults', async () => {
  await shippingFixture(async fixture => {
    process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = origin
    const invalid: OfficialConfiguration[] = [
      { gatewayOrigin: '' },
      { gatewayOrigin: null as unknown as string },
      { gatewayOrigin: 'http://tianshuharness.com' },
      { gatewayOrigin: `${origin}/api` },
      { gatewayOrigin: origin, gatewayOrigins: ['https://operator.invalid'] },
      { gatewayOrigin: origin, gatewayOrigins: [origin, origin] },
      { gatewayOrigin: origin, gatewayOrigins: null as unknown as readonly string[] },
    ]
    const requests = fixture.requests.length
    for (const configuration of invalid) {
      assert.throws(() => getOfficialGatewayOrigin(configuration), /service_error/)
      const broker = createOfficialModelBroker({ home: fixture.home, configuration, fetchImpl: fixture.fetchImpl })
      await assert.rejects(broker.getOfficialCredential(broker.captureOfficialIdentity()!), /service_error/)
      assert.equal(fixture.requests.length, requests, 'invalid configuration must fail before sending credentials')
    }
    for (const value of ['', 'http://tianshuharness.com', `${origin}/api`]) {
      process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = value
      assert.throws(() => getOfficialGatewayOrigin(), /service_error/)
      const broker = createOfficialModelBroker({ home: fixture.home, fetchImpl: fixture.fetchImpl })
      await assert.rejects(broker.getOfficialCredential(broker.captureOfficialIdentity()!), /service_error/)
    }
    process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = origin
    for (const value of ['', 'not-json', 'null', '[]', JSON.stringify(['https://operator.invalid'])]) {
      process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS = value
      assert.throws(() => getOfficialGatewayOrigin())
      const broker = createOfficialModelBroker({ home: fixture.home, fetchImpl: fixture.fetchImpl })
      await assert.rejects(broker.getOfficialCredential(broker.captureOfficialIdentity()!), /service_error/)
    }
    assert.equal(fixture.requests.length, requests)
  })
})

test('valid operator overrides remain exact and an invalid portal never falls back to production', async () => {
  await shippingFixture(async fixture => {
    const gateway = 'https://operator.invalid'
    process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = gateway
    process.env.RIVET_OFFICIAL_PORTAL_ORIGIN = 'https://portal.operator.invalid'
    assert.equal(getOfficialGatewayOrigin(), gateway)
    const catalog = structuredClone(fixtureCatalog)
    catalog.models[0]!.bindings[0]!.origin = gateway
    fixture.setOverride(path => path.endsWith('/catalog') ? { data: catalog } : undefined)
    const broker = createOfficialModelBroker({ home: fixture.home, fetchImpl: fixture.fetchImpl })
    await broker.getOfficialCatalog(broker.captureOfficialIdentity()!, 'agent')
    assert.equal(fixture.urls.filter(url => url.endsWith('/catalog'))[0], `${gateway}/api/official/v2/customer/catalog`)
    assert.equal(broker.getOfficialStatus().portalLinks.wallet, 'https://portal.operator.invalid/space/models?tab=wallet')
    for (const value of ['', 'http://portal.operator.invalid', 'https://portal.operator.invalid/path', 'https://user:password@portal.operator.invalid']) {
      process.env.RIVET_OFFICIAL_PORTAL_ORIGIN = value
      assert.deepEqual(broker.getOfficialStatus().portalLinks, { wallet: null, usage: null })
    }
  })
})

test('portal links can be explicitly disabled independently of the shipping gateway', async () => {
  await shippingFixture(async fixture => {
    process.env.RIVET_OFFICIAL_PORTAL_ORIGIN = origin
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: { gatewayOrigin: origin, portalOrigin: null }, fetchImpl: fixture.fetchImpl })
    assert.deepEqual(broker.getOfficialStatus().portalLinks, { wallet: null, usage: null })
  })
})
