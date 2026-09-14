import { describe, it } from 'node:test'
import assert from 'node:assert'
import { resolveFallbackModel } from '../create-agent-config.js'
import type { ProviderConfig } from '../../config/schema.js'

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'deepseek-native', prefixCompletion: true },
    thinking: 'enabled',
    maxTokens: 384_000,
    models: [],
    unsupported: [],
    ...overrides,
  } as ProviderConfig
}

describe('resolveFallbackModel', () => {
  it('downgrades strong fallbackModel to cheap when allowProFallback is false', () => {
    const fp = makeProvider({
      fallbackModel: 'deepseek-v4-pro',
      allowProFallback: false,
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'strong' },
        { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'cheap' },
      ],
    })
    assert.equal(resolveFallbackModel(fp).id, 'deepseek-v4-flash')
  })

  it('allows strong fallbackModel when allowProFallback is true', () => {
    const fp = makeProvider({
      fallbackModel: 'deepseek-v4-pro',
      allowProFallback: true,
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'strong' },
        { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'cheap' },
      ],
    })
    assert.equal(resolveFallbackModel(fp).id, 'deepseek-v4-pro')
  })

  it('prefers cheap tier when no fallbackModel is configured', () => {
    const fp = makeProvider({
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'strong' },
        { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'cheap' },
      ],
    })
    assert.equal(resolveFallbackModel(fp).id, 'deepseek-v4-flash')
  })

  it('falls back to balanced tier when no cheap model is available', () => {
    const fp = makeProvider({
      models: [
        { id: 'strong-model', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'strong' },
        { id: 'balanced-model', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'balanced' },
      ],
    })
    assert.equal(resolveFallbackModel(fp).id, 'balanced-model')
  })

  it('returns the only model when all models are strong and pro fallback is disabled', () => {
    const fp = makeProvider({
      models: [
        { id: 'only-strong', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'strong' },
      ],
    })
    assert.equal(resolveFallbackModel(fp).id, 'only-strong')
  })

  it('uses explicit model.tier over name-based inference', () => {
    const fp = makeProvider({
      fallbackModel: 'custom-flash',
      models: [
        { id: 'custom-flash', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'strong' },
        { id: 'custom-mini', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'cheap' },
      ],
    })
    // Name would infer cheap, but explicit tier says strong → downgrade to custom-mini
    assert.equal(resolveFallbackModel(fp).id, 'custom-mini')
  })

  it('短名引用不再命中（alias 废弃）——按 fallback 档解析', () => {
    const fp = makeProvider({
      fallbackModel: 'v4-pro',
      allowProFallback: false,
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'strong' },
        { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'cheap' },
      ],
    })
    assert.equal(resolveFallbackModel(fp).id, 'deepseek-v4-flash')
  })
})
