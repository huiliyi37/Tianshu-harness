import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BACKFILLED_MODEL_FIELDS,
  backfillModelFromPreset,
  backfillProviderFromPreset,
  backfillPresetModelFields,
} from '../preset-model-backfill.js'
import { cloneProviderPreset, findPresetModel } from '../provider-presets.js'
import { loadConfig, setApiKey } from '../manager.js'
import type { Config, ModelConfig, ProviderConfig } from '../schema.js'

describe('backfillModelFromPreset', () => {
  it('refills a capability field the stored snapshot is missing', () => {
    // The shape observed in production: a MiniMax-M3 entry carrying exactly the
    // four fields the desktop edit form submits, with supportsVision gone.
    const stale: ModelConfig = { id: 'MiniMax-M3', contextWindow: 1_000_000, maxTokens: 131072 }
    const fixed = backfillModelFromPreset('minimax', stale)
    assert.equal(fixed.supportsVision, true)
    assert.equal(fixed.tier, 'strong')
    assert.ok(fixed.pricing, 'pricing comes back too')
  })

  it('refills description on snapshots that predate the field (61224f45 存量断链)', () => {
    // description 数据链路落地前的存量快照没有该字段；不回填的话存量用户的
    // ModelPicker 永远看不到「擅长场景」（审查 61224f45 逮出的 HIGH）。
    const stale: ModelConfig = { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000 }
    const fixed = backfillModelFromPreset('deepseek', stale)
    assert.equal(fixed.description, '快速档：能力对标旗舰，成本更低')
  })

  it('leaves a user-customized description alone', () => {
    const stored: ModelConfig = { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, description: '我自己的备注' }
    const out = backfillModelFromPreset('deepseek', stored)
    assert.equal(out.description, '我自己的备注', '用户写过的 description 不被 preset 覆盖')
  })

  it('leaves user-set values alone, including deliberate falsey ones', () => {
    const stored: ModelConfig = {
      id: 'MiniMax-M3',
      contextWindow: 1_000_000,
      maxTokens: 64000,
      supportsVision: false,
      tier: 'cheap',
      pricing: { input: 99 },
      description: '用户自己的描述',
    }
    const out = backfillModelFromPreset('minimax', stored)
    assert.equal(out, stored, 'nothing to fill — same object back')
    assert.equal(out.supportsVision, false)
    assert.equal(out.tier, 'cheap')
    assert.equal(out.description, '用户自己的描述')
  })

  it('never rewrites naming or request-tuning fields', () => {
    const preset = findPresetModel('minimax', 'MiniMax-M3')!
    const stored: ModelConfig = { id: 'MiniMax-M3', contextWindow: 1_000, maxTokens: 500 }
    const out = backfillModelFromPreset('minimax', stored)
    assert.equal((out as Record<string, unknown>).alias, undefined, 'alias 已废弃——backfill 输出不再携带')
    assert.equal(out.contextWindow, 1_000, 'tuned windows are not reset to the preset')
    assert.equal(out.maxTokens, 500)
    assert.notEqual(preset.contextWindow, 1_000, 'guard: the preset really does differ here')
    assert.equal(out.reasoningEffort, undefined, 'not in the allowlist')
  })

  it('no longer matches a legacy alias stored as an id (alias 体系废弃)', () => {
    // 旧语义：配置把短名（minimax-m3）当 id 存，backfill 也会按预设 alias 兜底匹配。
    // 2026-09 alias 废弃后 findPresetModel 只按 id 匹配——短名存量应视为未知模型，
    // 不回填也不 graft 预设元数据（存量自愈由 migrateStripModelAlias 负责，但那
    // 只剥字段、不改名）。本用例钉住「不做 alias 兜底」。
    const byLegacyAliasId = backfillModelFromPreset('minimax', { id: 'minimax-m3', contextWindow: 1_000_000, maxTokens: 64000 })
    assert.equal(byLegacyAliasId.supportsVision, undefined)
  })

  it('does not let a colliding user alias pull in another model metadata', () => {
    // Stored id is unknown to the preset; only the alias looks like a real
    // model. Matching on that alias would graft the wrong model's fields on.
    const stored: ModelConfig = { id: 'house-model', contextWindow: 8_000, maxTokens: 1_000 }
    assert.equal(backfillModelFromPreset('minimax', stored), stored)
  })

  it('is a no-op for unknown providers and unknown models', () => {
    const known: ModelConfig = { id: 'MiniMax-M3', contextWindow: 1_000, maxTokens: 500 }
    assert.equal(backfillModelFromPreset('custom-endpoint', known), known, 'no preset for this provider')
    const unknown: ModelConfig = { id: 'nope', contextWindow: 1_000, maxTokens: 500 }
    assert.equal(backfillModelFromPreset('minimax', unknown), unknown, 'no preset entry for this id')
  })

  it('deep-copies filled values so the preset cannot be mutated through a config', () => {
    const fixed = backfillModelFromPreset('minimax', { id: 'MiniMax-M3', contextWindow: 1_000_000, maxTokens: 64000 })
    fixed.pricing!.input = -1
    assert.notEqual(findPresetModel('minimax', 'MiniMax-M3')!.pricing!.input, -1)
  })

  it('only touches fields on the allowlist', () => {
    assert.deepEqual([...BACKFILLED_MODEL_FIELDS], ['supportsVision', 'tier', 'pricing', 'reasoningEffort', 'description'])
  })
})

describe('backfillProviderFromPreset', () => {
  it('repairs each stale model and keeps the rest of the provider identical', () => {
    const provider: ProviderConfig = {
      ...cloneProviderPreset('minimax'),
      apiKey: 'sk-user',
      models: [
        { id: 'MiniMax-M3', contextWindow: 1_000_000, maxTokens: 64000 },
        { id: 'house-model', contextWindow: 8_000, maxTokens: 1_000 },
      ],
    }
    const out = backfillProviderFromPreset('minimax', provider)
    assert.equal(out.apiKey, 'sk-user')
    assert.equal(out.models[0]?.supportsVision, true)
    assert.equal(out.models[1]?.supportsVision, undefined, 'unknown models stay untouched')
    assert.equal(out.models.length, 2, 'preset-only models are never injected')
  })

  it('returns the same object when nothing needs filling', () => {
    const provider = cloneProviderPreset('minimax')
    assert.equal(backfillProviderFromPreset('minimax', provider), provider)
  })
})

describe('backfillPresetModelFields', () => {
  it('returns the same config object when there is nothing to repair', () => {
    const config = { provider: { default: 'minimax', providers: { minimax: cloneProviderPreset('minimax') } } } as unknown as Config
    assert.equal(backfillPresetModelFields(config), config)
  })

  it('does not mutate the input config', () => {
    const stale: ModelConfig = { id: 'MiniMax-M3', contextWindow: 1_000_000, maxTokens: 64000 }
    const providers = { minimax: { ...cloneProviderPreset('minimax'), models: [stale] } }
    const config = { provider: { default: 'minimax', providers } } as unknown as Config
    const out = backfillPresetModelFields(config)
    assert.notEqual(out, config)
    assert.equal(providers.minimax.models[0]!.supportsVision, undefined, 'original untouched')
    assert.equal(out.provider.providers.minimax!.models[0]?.supportsVision, true)
  })
})

describe('loadConfig integration', () => {
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-backfill-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  // The exact production failure: a config written before the preset declared
  // supportsVision. The vision bridge refused the model, images were dropped,
  // and nothing said why.
  it('repairs a stale on-disk snapshot at load time', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'minimax',
        providers: {
          minimax: {
            ...cloneProviderPreset('minimax'),
            apiKey: 'sk-test',
            models: [{ id: 'MiniMax-M3', contextWindow: 1_000_000, maxTokens: 131072 }],
          },
        },
      },
    }))
    const model = loadConfig().provider.providers.minimax!.models.find(m => m.id === 'MiniMax-M3')!
    assert.equal(model.supportsVision, true)
    assert.equal(model.maxTokens, 131072, 'the user tuned value is preserved')
  })

  it('heals the file itself on the next write', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'minimax',
        providers: {
          minimax: {
            ...cloneProviderPreset('minimax'),
            models: [{ id: 'MiniMax-M3', contextWindow: 1_000_000, maxTokens: 64000 }],
          },
        },
      },
    }))
    setApiKey('minimax', 'sk-new')
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      provider: { providers: Record<string, { models: ModelConfig[] }> }
    }
    assert.equal(onDisk.provider.providers.minimax!.models[0]?.supportsVision, true)
  })

  it('migrates v4-flash reasoningEffort high→max and persists', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            // 模拟存量快照：v4-flash 还是旧的 'high'
            models: [
              { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEffort: 'max' },
              { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEffort: 'high' },
            ],
          },
        },
      },
    }))
    const models = loadConfig().provider.providers.deepseek!.models
    const flash = models.find(m => m.id === 'deepseek-v4-flash')!
    assert.equal(flash.reasoningEffort, 'max', 'high migrated to max')
    // 幂等：再 load 一次不报错、值稳定
    const flash2 = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'deepseek-v4-flash')!
    assert.equal(flash2.reasoningEffort, 'max')
  })
})
