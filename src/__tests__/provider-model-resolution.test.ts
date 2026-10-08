import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderForModel, type ModelResolutionContext } from '../bootstrap/model-resolution.js'
import { contractModels } from '../config/contract-models.js'
import { providerSchema } from '../config/schema.js'
import type { Config, ProviderConfig } from '../config/schema.js'

const card = (id: string, contextWindow = 128_000) => ({ id, contextWindow, maxTokens: 8_000 })
const provider = (name: string, extra: Partial<ProviderConfig> = {}) => providerSchema.parse({ name, baseUrl: 'https://gateway.example.test/v1', models: [card('shared')], ...extra })
function context(providers: Record<string, ProviderConfig>, active: ProviderConfig): ModelResolutionContext {
  return { config: { provider: { providers } } as Config, provider: active, apiKey: 'fixture-cached-old-key' }
}

describe('provider and key ownership in CLI model switching', () => {
  it('prefers the active provider for a shared unqualified model ID', () => {
    const first = provider('first', { apiKey: 'fixture-first' })
    const second = provider('second', { apiKey: 'fixture-second' })
    const hit = resolveProviderForModel(context({ first, second }, second), 'shared')
    assert.ok(hit && !('error' in hit))
    assert.equal(hit.providerName, 'second')
    assert.equal(hit.apiKey, 'fixture-second')
  })

  it('missing active credentials returns an error instead of switching suppliers', () => {
    const first = provider('first', { apiKey: 'fixture-first' })
    const second = provider('second', { apiKeyEnv: '__TIANSHU_UNSET_RESOLUTION_KEY__' })
    const hit = resolveProviderForModel(context({ first, second }, second), 'shared')
    assert.ok(hit && 'error' in hit)
    assert.match(hit.error, /second/)
  })

  it('explicit secondary key controls both credentials and model metadata', () => {
    const relay = provider('relay', { apiKey: 'fixture-legacy-primary', keys: [
      { id: 'default', apiKey: 'fixture-primary', models: [card('shared', 128_000)] },
      { id: 'secondary', apiKey: 'fixture-secondary', models: [card('shared', 256_000)] },
    ] })
    const cfg = context({ relay }, relay)
    const hit = resolveProviderForModel(cfg, 'relay:secondary:shared')
    assert.ok(hit && !('error' in hit))
    assert.equal(hit.apiKey, 'fixture-secondary')
    assert.equal(hit.contextWindow, 256_000)
    assert.equal(contractModels(hit.provider)[0]!.contextWindow, 256_000)
    assert.deepEqual(hit.provider.keys!.map(k => k.id), ['secondary'])
    assert.equal(relay.keys!.length, 2, 'the persisted provider view is untouched')
    const reselection = resolveProviderForModel({ ...cfg, provider: hit.provider, apiKey: hit.apiKey }, 'shared', 'relay')
    assert.ok(reselection && !('error' in reselection))
    assert.equal(reselection.apiKey, 'fixture-secondary')
  })

  it('a missing pinned key does not fall back to the default credential', () => {
    const relay = provider('relay', { apiKey: 'fixture-primary', keys: [
      { id: 'default', apiKey: 'fixture-primary', models: [card('shared')] },
      { id: 'secondary', apiKeyEnv: '__TIANSHU_UNSET_RESOLUTION_KEY__', models: [card('shared')] },
    ] })
    const hit = resolveProviderForModel(context({ relay }, relay), 'relay:secondary:shared')
    assert.ok(hit && 'error' in hit)
  })

  it('explicit target provider preserves a wire ID that resembles another provider prefix', () => {
    const deepseek = provider('deepseek', { apiKey: 'fixture-other' })
    const relay = provider('relay', { apiKey: 'fixture-relay', models: [card('deepseek:org/model:edition')] })
    const hit = resolveProviderForModel(context({ deepseek, relay }, deepseek), 'deepseek:org/model:edition', 'relay')
    assert.ok(hit && !('error' in hit))
    assert.equal(hit.providerName, 'relay')
    assert.equal(hit.modelId, 'deepseek:org/model:edition')
  })

  it('keyless local models resolve without borrowing a cached API key', () => {
    const local = provider('ollama', { baseUrl: 'http://127.0.0.1:11434/v1', models: [card('qwen3:32b')] })
    const hit = resolveProviderForModel(context({ ollama: local }, local), 'qwen3:32b', 'ollama')
    assert.ok(hit && !('error' in hit))
    assert.equal(hit.apiKey, '')
    assert.equal(hit.modelId, 'qwen3:32b')
  })
})
