import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureConfiguration, officialFixture } from './official-model-auth.test.js'
import { createOfficialModelBroker } from '../official-model-auth.js'

test('official portal links use only the explicitly configured HTTPS origin and preserve wallet and usage routes', async () => {
  const previous = process.env.RIVET_OFFICIAL_PORTAL_ORIGIN
  const fixture = await officialFixture()
  try {
    const broker = await fixture.broker()
    delete process.env.RIVET_OFFICIAL_PORTAL_ORIGIN
    const disabled = createOfficialModelBroker({ home: fixture.home, configuration: { ...fixtureConfiguration, portalOrigin: null }, fetchImpl: fixture.fetchImpl })
    assert.deepEqual(disabled.getOfficialStatus().portalLinks, { wallet: null, usage: null })
    process.env.RIVET_OFFICIAL_PORTAL_ORIGIN = 'https://tianshuharness.com'
    assert.deepEqual(broker.getOfficialStatus().portalLinks, {
      wallet: 'https://tianshuharness.com/space/models?tab=wallet',
      usage: 'https://tianshuharness.com/space/models?tab=usage',
    })
    for (const origin of ['http://tianshuharness.com', 'https://tianshuharness.com/space/models', 'https://tianshuharness.com?token=not-a-real-token', 'https://user:password@tianshuharness.com']) {
      process.env.RIVET_OFFICIAL_PORTAL_ORIGIN = origin
      assert.deepEqual(broker.getOfficialStatus().portalLinks, { wallet: null, usage: null })
    }
  } finally {
    if (previous === undefined) delete process.env.RIVET_OFFICIAL_PORTAL_ORIGIN
    else process.env.RIVET_OFFICIAL_PORTAL_ORIGIN = previous
    await fixture.close()
  }
})
