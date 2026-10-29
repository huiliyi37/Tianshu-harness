import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogForPurpose } from '../official-catalog.js'
import type { Catalog } from '../official-contract.js'

function officialModel(id: string): Catalog['models'][number] {
  return {
    id, displayName: id, provider: 'DeepSeek', status: 'available',
    contextWindow: 100000, maxOutputTokens: 512, capabilities: { tools: true },
    costStatus: 'unavailable',
    bindings: [{ id: `binding-${id}`, modelId: id, protocol: 'openai', operation: 'chat',
      origin: 'https://gateway.invalid', path: '/v1/chat/completions', stream: true,
      capabilities: { tools: true }, requiredHeaders: {}, thinkingPolicy: '', pricingRevision: 'fixture-price' }],
  }
}

test('official model ordering follows the published backend catalog rather than a hardcoded model preference', () => {
  const catalog: Catalog = { revision: 'fixture', models: [officialModel('deepseek-flash'), officialModel('other-model'), officialModel('deepseek-v4.1-flash')] }
  const original = structuredClone(catalog)
  const result = catalogForPurpose(catalog, 'agent')
  assert.deepEqual(result.models.map(model => model.id), ['deepseek-flash', 'other-model', 'deepseek-v4.1-flash'])
  assert.equal(result.revision, catalog.revision)
  assert.deepEqual(result.models[0]?.bindings, original.models[0]?.bindings)
  assert.deepEqual(catalog, original)
  const updated = { ...catalog, revision: 'updated', models: [...catalog.models].reverse() }
  assert.deepEqual(catalogForPurpose(updated, 'agent').models.map(model => model.id), ['deepseek-v4.1-flash', 'other-model', 'deepseek-flash'])
})

test('a missing official default never creates a model or changes existing order', () => {
  const catalog: Catalog = { revision: 'fixture', models: [officialModel('other-model'), officialModel('deepseek-flash')] }
  assert.deepEqual(catalogForPurpose(catalog, 'agent').models.map(model => model.id), ['other-model', 'deepseek-flash'])
  assert.deepEqual(catalogForPurpose({ revision: 'empty', models: [] }, 'agent').models, [])
})

test('the preferred official model still requires verified availability and the requested capabilities', () => {
  for (const change of [{ status: 'unavailable' as const }, { status: 'unverified' as const }, { capabilities: { tools: false } }]) {
    const preferred = { ...officialModel('deepseek-v4.1-flash'), ...change }
    const catalog: Catalog = { revision: 'fixture', models: [officialModel('deepseek-flash'), preferred] }
    assert.deepEqual(catalogForPurpose(catalog, 'agent').models.map(model => model.id), ['deepseek-flash'])
  }
  const catalog: Catalog = { revision: 'fixture', models: [officialModel('deepseek-v4.1-flash')] }
  assert.deepEqual(catalogForPurpose(catalog, 'vision').models, [])
  assert.deepEqual(catalogForPurpose(catalog, 'image-generation').models, [])
  assert.deepEqual(catalogForPurpose(catalog, 'embedding').models, [])
})
