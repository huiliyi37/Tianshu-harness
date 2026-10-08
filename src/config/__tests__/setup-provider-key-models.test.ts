import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setupProvider } from '../manager.js'
import { contractModels } from '../contract-models.js'
import { addProviderKey } from '../provider-key-store.js'
import { readSecret } from '../secrets-store.js'

describe('setupProvider with key pools: reconnect selection and model sync', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-setup-keys-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    delete process.env.TEST_CUSTOM_KEY_ENV
    rmSync(dir, { recursive: true, force: true })
  })

  it('reconnect selection replaces default key models and syncs top-level snapshot', () => {
    // 1. Initial setup with pro-only model
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-init',
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    const initialProv = loadConfig().provider.providers.deepseek!
    assert.ok(initialProv.keys && initialProv.keys.length > 0, 'provider should have keys pool')
    assert.deepEqual(
      contractModels(initialProv).map(m => m.id),
      ['deepseek-v4-pro'],
    )

    // 2. Reconnect with new selection [flash, pro]
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-reconnect',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 },
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    const reloaded = loadConfig().provider.providers.deepseek!
    const effectiveModelIds = contractModels(reloaded).map(m => m.id)

    // Contract models (consumed by CLI /model) must reflect new selection
    assert.deepEqual(effectiveModelIds, ['deepseek-flash', 'deepseek-v4-pro'])

    // Top-level models snapshot must also stay synchronized
    assert.deepEqual(
      reloaded.models.map(m => m.id),
      ['deepseek-flash', 'deepseek-v4-pro'],
    )
  })

  it('metadata append (modelsMode: append) merges into default key and top-level models', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-append-init',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    setupProvider({
      providerName: 'deepseek',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
      modelsMode: 'append',
    })

    const prov = loadConfig().provider.providers.deepseek!
    const models = contractModels(prov)
    assert.equal(models.length, 2)
    const flash = models.find(m => m.id === 'deepseek-flash')!
    assert.equal(flash.contextWindow, 1_000_000)
    assert.equal(flash.maxTokens, 128_000)
    assert.ok(models.some(m => m.id === 'deepseek-v4-pro'))

    // Top-level snapshot matches default key
    assert.deepEqual(prov.models.map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('preserves other key pools when setupProvider updates default key models', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-primary',
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    // Add a secondary key to the pool
    addProviderKey('deepseek', {
      label: 'secondary',
      apiKey: 'sk-secondary',
      models: [
        { id: 'deepseek-custom-secondary', contextWindow: 64_000, maxTokens: 4_096 },
      ],
    })

    // Reconnect primary/default key with new models
    setupProvider({
      providerName: 'deepseek',
      models: [
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 },
      ],
    })

    const prov = loadConfig().provider.providers.deepseek!
    assert.equal(prov.keys?.length, 2, 'both keys must be preserved')

    const defaultKey = prov.keys?.find(k => k.id === 'default') ?? prov.keys?.[0]
    const secondaryKey = prov.keys?.find(k => k.label === 'secondary')

    assert.deepEqual(defaultKey?.models.map(m => m.id), ['deepseek-flash'])
    assert.deepEqual(secondaryKey?.models.map(m => m.id), ['deepseek-custom-secondary'])

    // contractModels returns union of both keys
    const poolIds = contractModels(prov).map(m => m.id)
    assert.deepEqual(poolIds, ['deepseek-flash', 'deepseek-custom-secondary'])
  })

  it('synchronizes apiKey and apiKeyEnv to default key while preserving other keys', () => {
    setupProvider({
      providerName: 'deepseek',
      preset: 'deepseek',
      apiKey: 'sk-init-cred',
      models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 64_000 }],
    })

    addProviderKey('deepseek', {
      label: 'secondary-env',
      apiKey: 'sk-secondary-keep',
      models: [{ id: 'secondary-model', contextWindow: 64_000, maxTokens: 4_096 }],
    })

    // Update with new inline apiKey
    setupProvider({
      providerName: 'deepseek',
      apiKey: 'sk-updated-cred',
    })

    let prov = loadConfig().provider.providers.deepseek!
    const defaultKey = prov.keys?.find(k => k.id === 'default') ?? prov.keys?.[0]
    const secondaryKey = prov.keys?.find(k => k.label === 'secondary-env')

    assert.equal(prov.keyRef, 'deepseek')
    assert.equal(defaultKey?.keyRef, 'deepseek')
    assert.equal(readSecret(defaultKey?.keyRef!), 'sk-updated-cred')
    assert.equal(readSecret(secondaryKey?.keyRef!), 'sk-secondary-keep')

    // Update with apiKeyEnv
    process.env.TEST_CUSTOM_KEY_ENV = 'sk-from-env'
    setupProvider({
      providerName: 'deepseek',
      apiKeyEnv: 'TEST_CUSTOM_KEY_ENV',
    })

    prov = loadConfig().provider.providers.deepseek!
    const defaultKeyEnv = prov.keys?.find(k => k.id === 'default') ?? prov.keys?.[0]
    assert.equal(prov.apiKeyEnv, 'TEST_CUSTOM_KEY_ENV')
    assert.equal(defaultKeyEnv?.apiKeyEnv, 'TEST_CUSTOM_KEY_ENV')
    assert.equal(defaultKeyEnv?.keyRef, undefined)

    // Secondary key remains untouched
    const secondaryKeyStill = prov.keys?.find(k => k.label === 'secondary-env')
    assert.equal(readSecret(secondaryKeyStill?.keyRef!), 'sk-secondary-keep')
  })
})
