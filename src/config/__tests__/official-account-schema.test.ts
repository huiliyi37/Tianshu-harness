import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerSchema } from '../schema.js'

test('official account configuration retains a published binding without a supplier credential', () => {
  const result = providerSchema.safeParse({
    name: 'tianshu-official',
    auth: { type: 'tianshu-account' },
    models: [{ id: 'deepseek-v4.1-flash', managed: { bindingId: 'synthetic-published-binding' } }],
  })
  assert.equal(result.success, true)
  if (!result.success) throw Error('official_account_schema_required')
  assert.equal(result.data.baseUrl, 'https://official.invalid')
  assert.equal(result.data.models[0]?.managed?.bindingId, 'synthetic-published-binding')
})

test('official account configuration cannot smuggle a supplier credential or endpoint', () => {
  for (const material of [
    { apiKey: 'synthetic' },
    { apiKeyEnv: 'SYNTHETIC_KEY' },
    { keyRef: 'synthetic' },
    { keys: [] },
    { baseUrl: 'https://supplier.example/v1' },
  ]) {
    const result = providerSchema.safeParse({ name: 'tianshu-official', auth: { type: 'tianshu-account' }, models: [], ...material })
    assert.equal(result.success, false)
  }
})
