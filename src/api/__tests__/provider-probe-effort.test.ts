import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { probeProvider, aliasTableWithProbeInfos } from '../provider-probe.js'
import { resolveEffortChoices, normalizeReasoningEffort, resolveCapabilities, resolveWireEffort } from '../provider.js'
import type { ModelAliasEntry } from '../model-aliases.js'

describe('per-model effort metadata from /models', () => {
  it('keeps advertised levels and defaults from the models response', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => String(input).endsWith('/models')
      ? Response.json({ data: [{ id: 'test-model', effort: { supported_levels: ['high', 'max'], default_level: 'high' } }] })
      : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    try {
      const report = await probeProvider({ baseUrl: 'https://models.example.test/v1', apiKey: 'test-key', vision: false })
      assert.equal(report.modelsOk, true)
      assert.deepEqual(report.modelInfos?.['test-model']?.effortLevels, ['high', 'max'])
      assert.equal(report.modelInfos?.['test-model']?.defaultEffort, 'high')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refreshes known model effort metadata without losing preset pricing or tuned limits', () => {
    const base: ModelAliasEntry[] = [{ canonicalId: 'deepseek-flash', aliases: ['flash'], metadata: {
      contextWindow: 1_000_000, maxTokens: 256_000, pricing: { input: 1, output: 4 }, reasoningEffort: 'max',
    } }]
    const table = aliasTableWithProbeInfos({ 'deepseek-flash': { effortLevels: ['high'], defaultEffort: 'high', maxOutputTokens: 393_216 } }, base)
    const metadata = table[0]!.metadata
    assert.deepEqual(metadata.capabilities?.effortLevels, ['high'])
    assert.equal(metadata.reasoningEffort, 'high')
    assert.deepEqual(metadata.pricing, base[0]!.metadata.pricing)
    assert.equal(metadata.maxTokens, 256_000)
    assert.equal(base[0]!.metadata.reasoningEffort, 'max', 'probe enrichment does not mutate the preset table')
    assert.deepEqual(resolveEffortChoices('deepseek', {}, metadata.capabilities).map(c => c.id), ['off', 'high'])
    const caps = resolveCapabilities('deepseek', undefined, metadata.capabilities)
    assert.equal(normalizeReasoningEffort('max', caps), 'high')
    assert.equal(resolveWireEffort('max', caps.effortCap), 'high', 'automatic decisions must also obey the advertised levels on the wire')
  })

  it('lets an unknown model declare an effort channel and its available levels', () => {
    const table = aliasTableWithProbeInfos({ 'new-model': { effortLevels: ['low', 'high'], defaultEffort: 'low' } }, [])
    assert.equal(table[0]!.metadata.reasoningEffort, 'low')
    assert.deepEqual(resolveEffortChoices('custom', {}, table[0]!.metadata.capabilities).map(c => c.id), ['low', 'high'])
  })
})
