import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { cloneProviderPreset } from '../provider-presets.js'
import { contractModels } from '../contract-models.js'
import { providerKeysPath, writeProviderKeysFile } from '../provider-keys-store.js'

describe('DeepSeek retirement in the authoritative key pool', () => {
  let dir = ''
  let previousConfigPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-deepseek-key-retirement-'))
    previousConfigPath = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify({
      provider: { providers: { deepseek: { ...cloneProviderPreset('deepseek'), userSaved: true } } },
    }))
  })

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = previousConfigPath
    rmSync(dir, { recursive: true, force: true })
  })

  it('repairs external pools before CLI enumeration and persists the repair', () => {
    writeProviderKeysFile({ version: 1, providers: {
      deepseek: [
        { id: 'default', models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 256_000 }] },
        { id: 'flash', label: 'Flash key', models: [{ id: 'deepseek-v4-flash', contextWindow: 500_000, maxTokens: 32_000 }] },
      ],
      relay: [{ id: 'default', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, maxTokens: 8_000 }] }],
    } })

    const providers = loadConfig().provider.providers
    const flash = contractModels(providers.deepseek!).find(m => m.id === 'deepseek-flash')
    assert.ok(flash, 'the selector must see the current model from the external key pool')
    assert.equal(contractModels(providers.deepseek!).some(m => m.id === 'deepseek-v4-flash'), false)
    assert.equal(flash.contextWindow, 500_000)
    assert.equal(flash.maxTokens, 32_000)
    assert.equal(flash.supportsVision, true, 'injected model cards need preset capability backfill')
    assert.ok(flash.pricing)
    assert.equal(providers.deepseek!.keys![1]!.label, 'Flash key')
    assert.equal(contractModels(providers.relay!)[0]!.id, 'deepseek-v4-flash', 'gateway model names remain unchanged')

    const repairedFile = readFileSync(providerKeysPath(), 'utf8')
    loadConfig()
    assert.equal(readFileSync(providerKeysPath(), 'utf8'), repairedFile, 'the migration is idempotent')
    assert.equal(JSON.parse(repairedFile).providers.deepseek[1].models[0].id, 'deepseek-flash')
  })

  it('redirects a key whose only model is the retired vision experiment', () => {
    writeProviderKeysFile({ version: 1, providers: { deepseek: [{
      id: 'default',
      models: [{ id: 'deepseek-v4-flash-vision-exp', contextWindow: 400_000, maxTokens: 16_000 }],
    }] } })
    const models = contractModels(loadConfig().provider.providers.deepseek!)
    assert.deepEqual(models.map(m => m.id), ['deepseek-flash'])
    assert.equal(models[0]!.contextWindow, 400_000)
    assert.equal(models[0]!.supportsVision, true)
  })

  it('keeps an existing current model instead of duplicating retired aliases', () => {
    writeProviderKeysFile({ version: 1, providers: { deepseek: [{ id: 'default', models: [
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 256_000 },
      { id: 'deepseek-v4-flash-vision-exp', contextWindow: 1_000_000, maxTokens: 256_000 },
      { id: 'deepseek-flash', contextWindow: 200_000, maxTokens: 8_000, supportsVision: false },
    ] }] } })
    const models = contractModels(loadConfig().provider.providers.deepseek!)
    assert.deepEqual(models.map(m => m.id), ['deepseek-flash'])
    assert.equal(models[0]!.contextWindow, 200_000)
    assert.equal(models[0]!.supportsVision, false, 'explicit user capability overrides survive backfill')
  })
})
