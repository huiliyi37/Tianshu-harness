import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema } from '../schema.js'
import { PROVIDER_PRESETS, cloneProviderPreset, providerPresetKeys } from '../provider-presets.js'
import { DEFAULT_CONFIG } from '../default.js'
import { migratePresetModelBackfill } from '../preset-model-backfill.js'

describe('provider presets', () => {
  it('contains required built-in provider modes', () => {
    assert.deepEqual([...providerPresetKeys].sort(), ['ccswitch', 'codex', 'dashscope', 'deepseek', 'glm', 'kimi', 'longcat', 'mimo', 'mimo-api', 'minimax', 'ollama', 'openai', 'openrouter', 'relay', 'siliconflow', 'volc', 'zhipu-vision'].sort())
  })

  it('ollama is the only keyless preset (local, no auth)', () => {
    const keyless = providerPresetKeys.filter(k => PROVIDER_PRESETS[k].keyless)
    assert.deepEqual(keyless, ['ollama'])
    assert.equal(PROVIDER_PRESETS.ollama.provider.baseUrl, 'http://127.0.0.1:11434/v1')
  })

  // 「获取 API Key」直链覆盖：凡要 Key 的预设必须配官方 keyUrl，否则桌面端预设卡的
  // 「获取 API Key ↗」缺失——新用户不知道去哪拿 Key 是真实卡点（ZCode 对标）。
  // 豁免：codex 走 OAuth 无 Key 页；ccswitch/relay 是中转站，无官方控制台页可指。
  it('every key-requiring preset carries an official https keyUrl', () => {
    const exempt = new Set(['codex', 'ccswitch', 'relay'])
    for (const key of providerPresetKeys) {
      const preset = PROVIDER_PRESETS[key]
      if (preset.keyless || exempt.has(key)) continue
      assert.ok(
        typeof preset.keyUrl === 'string' && /^https:\/\//.test(preset.keyUrl),
        `${key} requires a key and must carry an https keyUrl (official console page)`,
      )
    }
  })

  it('every preset parses as ProviderConfig', () => {
    for (const key of providerPresetKeys) {
      const parsed = providerSchema.safeParse(PROVIDER_PRESETS[key].provider)
      assert.equal(parsed.success, true, `${key} should parse`)
    }
  })

  it('codex preset uses OAuth and gpt-5.6-sol', () => {
    const codex = cloneProviderPreset('codex')
    assert.deepEqual(codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(codex.capabilities.cacheControl, true)
    assert.equal(codex.models[0]?.id, 'gpt-5.6-sol')
  })

  it('deepseek cost defaults: pro=high effort, flash=medium effort', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const pro = deepseek.models.find(m => m.id === 'deepseek-v4-pro')
    const flash = deepseek.models.find(m => m.id === 'deepseek-v4-flash')
    assert.equal(pro?.reasoningEffort, 'high')
    assert.equal(flash?.reasoningEffort, 'medium')
  })

  it('deepseek-v4-flash-vision-exp: 1M 上下文 + 视觉 + 定价与 flash 同档', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const vision = deepseek.models.find(m => m.id === 'deepseek-v4-flash-vision-exp')
    assert.ok(vision, 'vision-exp 必须在 deepseek 预设模型列表')
    assert.equal(vision.contextWindow, 1_000_000)
    assert.equal(vision.maxTokens, 384_000)
    assert.equal(vision.supportsVision, true)
    assert.deepEqual(vision.pricing, { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 })
    assert.equal(vision.reasoningEffort, 'medium')
    assert.equal(vision.tier, 'cheap')
  })

  it('glm-5.3 / glm-5.3-flash：文本旗舰 + 原生多模态（flash 带 supportsVision）', () => {
    const glm = cloneProviderPreset('glm')
    const text = glm.models.find(m => m.id === 'glm-5.3')
    assert.ok(text, 'glm-5.3 必须在 glm 预设模型列表')
    assert.equal(text.contextWindow, 1_000_000)
    assert.equal(text.maxTokens, 131_072)
    assert.equal(text.supportsVision, undefined, '文本旗舰不声明视觉')
    assert.deepEqual(text.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'Coding Plan 订阅不按 token 计费')
    const flash = glm.models.find(m => m.id === 'glm-5.3-flash')
    assert.ok(flash, 'glm-5.3-flash 必须在 glm 预设模型列表')
    assert.equal(flash.supportsVision, true, '原生多模态声明视觉')
    assert.equal(flash.contextWindow, 1_000_000)
    assert.deepEqual(flash.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  // Kimi Code（会员订阅端点）与 CLI 内置 DEFAULT_CONFIG.kimi 必须同源。
  // 2026-09 之前预设走 Moonshot 开放平台（api.moonshot.cn + MOONSHOT_API_KEY + kimi-k3），
  // 与内置的 Kimi Code 配置（api.kimi.com/coding + KIMI_API_KEY + k3）两套并存：
  // 用户在预设卡填的开放平台 Key 拿不到内置模型，反之亦然。以官方 Kimi Code 文档为准
  // （https://www.kimi.com/coding/docs/：Base URL api.kimi.com/coding/v1、模型 id k3 系）。
  it('kimi 预设走 Kimi Code 订阅端点，模型为 k3 系', () => {
    const kimi = cloneProviderPreset('kimi')
    assert.equal(kimi.baseUrl, 'https://api.kimi.com/coding/v1')
    assert.equal(kimi.apiKeyEnv, 'KIMI_API_KEY')
    assert.equal(PROVIDER_PRESETS.kimi.defaultModelId, 'k3')
    assert.equal(PROVIDER_PRESETS.kimi.keyUrl, 'https://www.kimi.com/code/console', 'Key 在 Kimi Code 控制台创建，不是开放平台')
    const k3 = kimi.models.find(m => m.id === 'k3')
    assert.ok(k3, 'k3 必须在 kimi 预设模型列表')
    assert.equal(k3.contextWindow, 1_000_000)
    assert.equal(k3.maxTokens, 131_072)
    assert.equal(k3.reasoningEffort, 'max')
    assert.deepEqual(k3.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'Kimi Code 会员订阅不按 token 计费')
    const code = kimi.models.find(m => m.id === 'kimi-for-coding')
    assert.ok(code, 'kimi-for-coding 必须在 kimi 预设模型列表')
    // 官方 4 个模型 ID 里的 k3-256k：256K 上下文省额度版，k3（1M）消耗约为其两倍。
    const budget = kimi.models.find(m => m.id === 'k3-256k')
    assert.ok(budget, 'k3-256k 必须在 kimi 预设模型列表（官方 256K 省额度版）')
    assert.equal(budget.contextWindow, 262_144)
    assert.equal(budget.reasoningEffort, 'max')
    assert.deepEqual(budget.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('DEFAULT_CONFIG.kimi 与 kimi 预设同源（端点/apiKeyEnv/模型 id 序列）', () => {
    const builtin = DEFAULT_CONFIG.provider.providers.kimi
    assert.ok(builtin)
    const preset = PROVIDER_PRESETS.kimi.provider
    assert.equal(builtin.baseUrl, preset.baseUrl)
    assert.equal(builtin.apiKeyEnv, preset.apiKeyEnv)
    assert.deepEqual(builtin.models.map(m => m.id), preset.models.map(m => m.id))
  })
})

// ── migratePresetModelBackfill：预设新增模型回流进存量 provider 快照 ────────

describe('migratePresetModelBackfill', () => {
  it('缺 glm-5.3/glm-5.3-flash 的存量快照被补齐（幂等，已有条目不动）', () => {
    const raw = {
      provider: {
        providers: {
          glm: {
            name: 'glm',
            models: [{ id: 'glm-5.2', contextWindow: 1_000_000, maxTokens: 131072 }],
          },
        },
      },
    } as unknown as Record<string, unknown>
    const changed = migratePresetModelBackfill(raw)
    assert.equal(changed, true)
    const models = (raw as { provider: { providers: { glm: { models: Array<{ id: string; supportsVision?: boolean }> } } } }).provider.providers.glm.models
    assert.deepEqual(models.map(m => m.id), ['glm-5.2', 'glm-5.3', 'glm-5.3-flash'])
    assert.equal(models[2]?.supportsVision, true, 'glm-5.3-flash carries vision')
    // 幂等
    assert.equal(migratePresetModelBackfill(raw), false)
  })

  it('非预设 provider 与无 models 字段不触碰', () => {
    const raw = {
      provider: {
        providers: {
          custom: { name: 'custom', models: [{ id: 'x' }] },
          broken: { name: 'broken' },
        },
      },
    } as unknown as Record<string, unknown>
    assert.equal(migratePresetModelBackfill(raw), false)
  })

  it('userSaved 的 provider 尊重用户删减——不回填缺失的预设模型', () => {
    const raw = {
      provider: {
        providers: {
          // 用户删过模型的预设 provider（userSaved 由 removeModel/setupProvider 落盘）
          glm: {
            name: 'glm',
            userSaved: true,
            models: [{ id: 'glm-5.3', contextWindow: 1_000_000, maxTokens: 131072 }],
          },
        },
      },
    } as unknown as Record<string, unknown>
    assert.equal(migratePresetModelBackfill(raw), false)
    const models = (raw as { provider: { providers: { glm: { models: Array<{ id: string }> } } } }).provider.providers.glm.models
    assert.deepEqual(models.map(m => m.id), ['glm-5.3'])
  })
})
