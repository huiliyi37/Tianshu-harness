import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema } from '../../config/schema.js'
import { findModelPricing } from '../../utils/pricing.js'
import { findUsagePricing } from '../../utils/deepseek-pricing.js'
import { prepareModelRuntime } from '../model-runtime.js'
import { catalogSchema, type OfficialIdentityRef } from '../official-contract.js'
import type { Config } from '../../config/schema.js'
import { aggregateUsageRows } from '../../cache/usage-aggregator.js'

test('unknown managed costs remain unavailable rather than a fabricated free total', () => {
  const now = Date.now()
  const aggregate = aggregateUsageRows([{ t: now, model: 'managed', provider: 'owned', input: 100, output: 10, cacheRead: 20, cacheCreate: 0, sidePath: false }], { now, days: 1, resolvePricing: () => undefined })
  assert.equal(aggregate.totals.input, 100)
  assert.equal(aggregate.totals.cost, null)
  assert.equal(aggregate.totals.savings, null)
  assert.equal(aggregate.models[0]?.cost, null)
  const priced = aggregateUsageRows([{ t: now, model: 'byok', input: 1000000, output: 0, cacheRead: 0, cacheCreate: 0, sidePath: false }], { now, days: 1, resolvePricing: () => ({ input: 2 }) })
  assert.equal(priced.totals.cost, 2)
})

test('actual prepared managed model does not publish stale local money or a free badge', async () => {
  const provider = providerSchema.parse({ name: 'owned', auth: { type: 'tianshu-account' }, models: [{ id: 'model', managed: { bindingId: 'binding' }, contextWindow: 32000, maxTokens: 4000, pricing: { input: 2, output: 8, free: true } }] })
  const catalog = catalogSchema.parse({ revision: '1', models: [{ id: 'model', displayName: 'Model', provider: 'owned', status: 'available', contextWindow: 32000, maxOutputTokens: 4000, capabilities: { tools: true }, costStatus: 'unavailable', bindings: [{ id: 'binding', modelId: 'model', operation: 'chat', protocol: 'openai', origin: 'https://gateway.invalid', path: '/v1/chat/completions', stream: true, capabilities: { tools: true }, requiredHeaders: null, thinkingPolicy: '', pricingRevision: '1' }] }] })
  const identity: OfficialIdentityRef = { subject: 'owned-subject', accountSessionId: 'owned-session', deviceId: 'owned-device', generation: 1, incarnation: 'owned-incarnation' }
  const runtime = await prepareModelRuntime({ config: { provider: { default: 'owned', providers: { owned: provider } } } as unknown as Config, provider, apiKey: '', purpose: 'agent', modelId: 'model' }, { captureIdentity: () => identity, getCatalog: async () => catalog, getCredential: async () => ({ credential: 'synthetic-only', subject: identity.subject, accountSessionId: identity.accountSessionId, generation: 1, expiresAt: '2099-01-01T00:00:00Z', catalogRevision: '1' }), getQuote: async () => { throw Error('not requested') }, now: Date.now })
  assert.equal(runtime.model.pricing, undefined)
  assert.equal(runtime.provider.models[0]?.pricing, undefined)
  assert.equal(runtime.model.contextWindow, 32000)
})

test('opaque managed models cannot inherit configured free or DeepSeek preset money rates', () => {
  const provider = providerSchema.parse({ name: 'owned', baseUrl: 'https://api.deepseek.com', protocol: 'openai', models: [{ id: 'deepseek-v4-flash', contextWindow: 32000, maxTokens: 4000, pricing: { input: 2, output: 8, free: true } }] })
  provider.auth = { type: 'tianshu-account' }
  assert.equal(findModelPricing({ owned: provider }, 'owned', 'deepseek-v4-flash'), undefined)
  assert.equal(findUsagePricing({ owned: provider }, 'owned', 'deepseek-v4-flash', Date.now()), undefined)
  const byok = { ...provider, auth: undefined }
  assert.equal(findModelPricing({ byok }, 'byok', 'deepseek-v4-flash')?.input, 2)
  assert.ok(findUsagePricing({ byok }, 'byok', 'deepseek-v4-flash', Date.now())?.input)
})
