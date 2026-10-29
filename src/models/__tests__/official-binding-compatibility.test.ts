import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema, type Config } from '../../config/schema.js'
import { resolveModelBinding, sessionProviderKey, snapshotSessionBinding } from '../../model/model-binding.js'
import { prepareModelRuntime, prepareRuntimeContext, type ModelRuntimeDeps } from '../model-runtime.js'
import { catalogSchema, type OfficialIdentityRef } from '../official-contract.js'

async function preparedBinding(providerKey = 'managed-fixture') {
  const provider = providerSchema.parse({ name: 'managed-fixture', auth: { type: 'tianshu-account' }, models: [{ id: 'fixture-model', managed: { bindingId: 'fixture-binding' } }] })
  const identity: OfficialIdentityRef = { subject: '11111111-1111-4111-8111-111111111111', accountSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: 'fixture-device', generation: 1, incarnation: 'fixture-incarnation' }
  const catalog = catalogSchema.parse({ revision: 'fixture-catalog', models: [{
    id: 'fixture-model', displayName: 'Fixture', provider: provider.name, status: 'available', contextWindow: 32000, maxOutputTokens: 4000,
    capabilities: { tools: true }, costStatus: 'unavailable', bindings: [{
      id: 'fixture-binding', modelId: 'fixture-model', operation: 'chat', protocol: 'openai', origin: 'https://gateway.invalid',
      path: '/v1/chat/completions', stream: true, capabilities: { tools: true }, requiredHeaders: null, thinkingPolicy: '', pricingRevision: 'fixture-price',
    }],
  }] })
  const deps: ModelRuntimeDeps = {
    captureIdentity: () => identity,
    getCatalog: async () => catalog,
    getCredential: async () => ({ credential: 'synthetic-response-only', subject: identity.subject, accountSessionId: identity.accountSessionId, generation: 1, expiresAt: '2099-01-01T00:00:00Z', catalogRevision: catalog.revision }),
    getQuote: async () => { throw new Error('metadata binding must not acquire inference authority') },
    now: Date.now,
  }
  const prepared = await prepareModelRuntime({ config: { provider: { providers: { [providerKey]: provider } } } as unknown as Config, provider, apiKey: '', modelId: 'fixture-model', targetProvider: providerKey, purpose: 'agent' }, deps)
  return { provider, prepared, deps }
}

test('the current worker binding accepts real prepared managed authority without a static credential', async () => {
  const { provider, prepared } = await preparedBinding()
  const reference = snapshotSessionBinding(prepared.provider, prepared.modelId, '')
  const binding = resolveModelBinding({ [prepared.providerName]: prepared.provider }, reference)
  assert.equal(binding.provider, prepared.provider)
  assert.equal(binding.spec, prepared.model)
  assert.equal(binding.apiKey, '')
  assert.equal(binding.auth, undefined)
  assert.throws(() => resolveModelBinding({ [prepared.providerName]: structuredClone(prepared.provider) }, reference))
  const persisted = { [prepared.providerName]: provider }
  assert.throws(() => resolveModelBinding(persisted, reference))
  assert.equal(resolveModelBinding(persisted, reference, undefined, prepared.provider).provider, prepared.provider)
  assert.throws(() => resolveModelBinding(persisted, reference, undefined, structuredClone(prepared.provider)))
  for (const changed of [
    { ...provider, models: [] },
    { ...provider, baseUrl: 'https://untrusted.invalid' },
    { ...provider, models: [{ ...provider.models[0]!, managed: { bindingId: 'reassigned-binding' } }] },
  ]) assert.throws(() => resolveModelBinding({ [prepared.providerName]: changed }, reference, undefined, prepared.provider))
  assert.throws(() => resolveModelBinding(persisted, { ...reference, keyId: 'injected-key' }, undefined, prepared.provider))
  assert.throws(() => resolveModelBinding(persisted, { ...reference, baseUrl: 'https://untrusted.invalid' }, undefined, prepared.provider))
})

test('managed binding preserves the latest stored provider key even when its display name differs', async () => {
  const providerKey = 'stored-managed-alias'
  const { provider, prepared } = await preparedBinding(providerKey)
  const persisted = { [providerKey]: provider }
  assert.equal(sessionProviderKey(persisted, prepared.provider), providerKey)
  const reference = snapshotSessionBinding(prepared.provider, prepared.modelId, '', providerKey)
  assert.equal(reference.provider, providerKey)
  assert.equal(resolveModelBinding(persisted, reference, undefined, prepared.provider).provider, prepared.provider)
  assert.throws(() => sessionProviderKey(persisted, structuredClone(prepared.provider)))
  assert.throws(() => sessionProviderKey({ ...persisted, duplicate: provider }, prepared.provider), /provider_deleted/)
})

test('managed provider identity accepts the sealed public routing projection without treating its endpoint as authority', async () => {
  const providerKey = 'projected-managed-alias'
  const { provider, deps } = await preparedBinding(providerKey)
  const context = await prepareRuntimeContext({ config: { provider: { providers: { [providerKey]: provider } } } as unknown as Config, provider, apiKey: '' }, 'fixture-model', 'agent', deps)
  const projection = context.config.provider.providers[providerKey]!
  assert.notEqual(projection, context.provider)
  assert.equal(sessionProviderKey(context.config.provider.providers, projection), providerKey)
  assert.throws(() => sessionProviderKey(context.config.provider.providers, structuredClone(projection)))
})
