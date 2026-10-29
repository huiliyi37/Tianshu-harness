import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialRuntimeFixture } from '../../__tests__/helpers/official-runtime-fixture.js'
import { prepareModelRuntime } from '../model-runtime.js'
import { resolveModelBinding, snapshotSessionBinding } from '../../model/model-binding.js'

test('latest worker binding preserves prepared official authority without resolving a static key', async () => {
  const fixture = await createOfficialRuntimeFixture()
  try {
    const prepared = await prepareModelRuntime(fixture.input, fixture.deps)
    const reference = snapshotSessionBinding(prepared.provider, prepared.modelId, '')
    const bound = resolveModelBinding({ [prepared.providerName]: prepared.provider }, reference)
    assert.equal(bound.provider, prepared.provider)
    assert.equal(bound.spec, prepared.model)
    assert.equal(bound.apiKey, '')
    assert.equal(bound.auth, undefined)
    assert.equal(fixture.readCounters().nativeRequests, 0)
    const persisted = { [prepared.providerName]: fixture.input.provider }
    assert.throws(() => resolveModelBinding(persisted, reference))
    const owned = resolveModelBinding(persisted, reference, undefined, prepared.provider)
    assert.equal(owned.provider, prepared.provider)
    assert.equal(owned.spec, prepared.model)
    assert.throws(() => resolveModelBinding(persisted, reference, undefined, structuredClone(prepared.provider)))
    assert.throws(() => resolveModelBinding({ [prepared.providerName]: { ...fixture.input.provider, models: [] } }, reference, undefined, prepared.provider))
    assert.throws(() => resolveModelBinding({ [prepared.providerName]: { ...fixture.input.provider, baseUrl: 'https://untrusted.invalid' } }, reference, undefined, prepared.provider))
    assert.throws(() => resolveModelBinding({ [prepared.providerName]: { ...fixture.input.provider, models: [{ ...fixture.input.provider.models[0]!, managed: { bindingId: 'reassigned-binding' } }] } }, reference, undefined, prepared.provider))
    assert.throws(() => resolveModelBinding({ [prepared.providerName]: structuredClone(prepared.provider) }, reference))
    assert.throws(() => resolveModelBinding({ [prepared.providerName]: prepared.provider }, { ...reference, baseUrl: 'https://untrusted.invalid' }))
    assert.throws(() => resolveModelBinding({ [prepared.providerName]: prepared.provider }, { ...reference, keyId: 'injected-key' }))
  } finally {
    await fixture.close()
  }
})
