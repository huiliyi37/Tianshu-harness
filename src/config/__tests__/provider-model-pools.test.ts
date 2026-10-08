import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerProvider, setupProvider, upsertProviderModel, addModel, removeModel, listModels, loadConfig } from '../manager.js'
import { addProviderKey } from '../provider-key-store.js'
import { contractModels } from '../contract-models.js'

describe('generic provider model writes use authoritative key pools', () => {
  let dir = ''
  let previousPath: string | undefined
  const model = (id: string) => ({ id, contextWindow: 128_000, maxTokens: 8_000 })
  const provider = () => loadConfig().provider.providers['test-relay']!

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tianshu-provider-model-pools-'))
    previousPath = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    registerProvider({ providerName: 'test-relay', baseUrl: 'https://relay.example.test/v1', apiKeyEnv: 'TIANSHU_TEST_POOL_KEY', models: [model('vendor:old')] })
    provider() // Materialize the external pool as normal CLI startup does before /connect.
  })

  afterEach(() => {
    if (previousPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = previousPath
    rmSync(dir, { recursive: true, force: true })
  })

  it('the /connect add-model write appears in the picker after reloading', () => {
    upsertProviderModel('test-relay', model('org/new-model:latest'))
    assert.deepEqual(contractModels(provider()).map(m => m.id), ['vendor:old', 'org/new-model:latest'])
    assert.deepEqual(listModels('test-relay').map(m => m.id), ['vendor:old', 'org/new-model:latest'])
  })

  it('CLI add-model and list-models share the same pool, including key-only models', () => {
    addProviderKey('test-relay', { apiKey: 'test-secondary-key', models: [model('secondary/model')] })
    addModel('test-relay', model('org/added:model'))
    assert.deepEqual(listModels('test-relay').map(m => m.id), ['vendor:old', 'org/added:model', 'secondary/model'])
  })

  it('editing a key-only model keeps its credential owner and unsent metadata', () => {
    const secondary = addProviderKey('test-relay', { apiKey: 'test-secondary-key', models: [{ ...model('org/key-only'), supportsVision: true, pricing: { input: 2, output: 4 } }] })
    upsertProviderModel('test-relay', { ...model('org/key-only'), contextWindow: 200_000 })
    const p = provider()
    assert.equal(p.keys!.find(k => k.id === 'default')!.models.some(m => m.id === 'org/key-only'), false)
    const edited = p.keys!.find(k => k.id === secondary.id)!.models[0]!
    assert.equal(edited.contextWindow, 200_000)
    assert.equal(edited.supportsVision, true)
    assert.deepEqual(edited.pricing, { input: 2, output: 4 })
    assert.equal(p.keys!.find(k => k.id === secondary.id)!.keyRef, `test-relay:${secondary.id}`)
  })

  it('provider-wide deletion removes a visible ID from all keys and survives reload', () => {
    addProviderKey('test-relay', { apiKey: 'test-secondary-key', models: [model('vendor:old'), model('secondary/model')] })
    removeModel('test-relay', 'vendor:old')
    assert.deepEqual(contractModels(provider()).map(m => m.id), ['secondary/model'])
    assert.equal(provider().keys!.some(k => k.models.some(m => m.id === 'vendor:old')), false)
    assert.throws(() => removeModel('test-relay', 'secondary/model'), /Cannot remove the last model/)
  })

  it('force-registering a custom relay replaces its old pool instead of resurrecting it', () => {
    registerProvider({ providerName: 'test-relay', baseUrl: 'https://replacement.example.test/v1', apiKeyEnv: 'TIANSHU_TEST_NEW_KEY', protocol: 'openai-responses', models: [model('new-only')], force: true })
    const p = provider()
    assert.deepEqual(contractModels(p).map(m => m.id), ['new-only'])
    assert.equal(p.keys![0]!.apiKeyEnv, 'TIANSHU_TEST_NEW_KEY')
    assert.equal(p.protocol, 'openai-responses')
  })

  it('a DeepSeek preset repointed to a relay preserves that gateway model ID', () => {
    setupProvider({ providerName: 'deepseek', preset: 'deepseek', baseUrl: 'https://relay.example.test/v1', apiKeyEnv: 'TIANSHU_TEST_REPOINTED_KEY', models: [model('deepseek-v4-flash')] })
    const p = loadConfig().provider.providers.deepseek!
    assert.deepEqual(contractModels(p).map(m => m.id), ['deepseek-v4-flash'])
  })
})
