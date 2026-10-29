import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema, modelConfigSchema } from '../schema.js'
import { PROVIDER_PRESETS, cloneProviderPreset, providerPresetKeys } from '../provider-presets.js'
import { resolveCapabilities, resolveEffortSupported } from '../../api/provider.js'
import { hasModelsListEndpoint } from '../../api/endpoint-map.js'
import { MODEL_ALIAS_TABLE } from '../../api/model-aliases.js'
import { DEFAULT_CONFIG } from '../default.js'
import { migratePresetModelBackfill } from '../preset-model-backfill.js'

describe('provider presets', () => {
  it('contains required built-in provider modes', () => {
    assert.deepEqual([...providerPresetKeys].sort(), ['agnes', 'ccswitch', 'codex', 'dashscope', 'deepseek', 'gemini', 'glm', 'grok', 'kimi', 'longcat', 'mimo', 'mimo-api', 'minimax', 'ollama', 'openai', 'opencode-go', 'opencode-go-anthropic', 'openrouter', 'relay', 'siliconflow', 'stepfun', 'volc', 'volc-plan', 'volc-plan-anthropic', 'zhipu-vision'].sort())
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

  // issue #105（收编自公开仓 PR #108，**仅采纳机制**）——模型弃用需要一个可声明的
  // 标记，供议事会/路由在命中时显式告警，而不是无提示地继续调用。
  //
  // 未采纳 PR 对 provider-presets 的改动：它给 deepseek-v4-pro 打了「2026-09-14 下线」，
  // 但官方 09-10 的下线公告已在 09-11 被撤销（「继续提供 API 调用，计费不变」），
  // 本仓 provider-presets.ts 的注释记的正是后者。前提不成立，故不打该标。
  it('模型配置接受 deprecated / deprecationNote 声明', () => {
    const parsed = modelConfigSchema.safeParse({
      id: 'some-model',
      deprecated: true,
      deprecationNote: '2026-xx-xx 下线；建议切到替代档',
    })
    assert.equal(parsed.success, true)
    assert.equal(parsed.data?.deprecated, true)
    assert.equal(parsed.data?.deprecationNote, '2026-xx-xx 下线；建议切到替代档')
  })

  it('grok 预设：grok-4.6 规格 + 推理档透传（off→low / max→xhigh）', () => {
    const grok = cloneProviderPreset('grok')
    assert.equal(grok.name, 'grok')
    assert.equal(grok.baseUrl, 'https://api.x.ai/v1')
    assert.equal(grok.apiKeyEnv, 'XAI_API_KEY')
    const model = grok.models.find(m => m.id === 'grok-4.6')
    assert.ok(model, 'grok-4.6 must be in the preset fleet')
    assert.equal(model.contextWindow, 500_000, '官方 500K 上下文')
    assert.equal(model.maxTokens, 128_000, 'max_completion_tokens 未设时官方默认 128k')
    assert.equal(model.supportsVision, true, '文本+图片输入')
    assert.equal(model.reasoningEffort, 'high', 'xAI reasoning_effort 默认 high')
    assert.deepEqual(model.pricing, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 })

    // 推理档透传：reasoning_effort 通道 + 词汇映射（xAI 无 off/max，且推理不可关闭）
    const caps = resolveCapabilities('grok', grok.capabilities, model.capabilities)
    assert.equal(caps.effortFormat, 'reasoning_effort')
    assert.deepEqual(caps.effortCap, { off: 'low', max: 'xhigh' })
    assert.equal(resolveEffortSupported('grok', grok), true, '桌面档位带必须放行（否则静默丢弃）')

    // 探测/批量导入链路：preset fleet 自动进别名表，grok-4.6 带 500K 元数据，短名 grok 可归一。
    const alias = MODEL_ALIAS_TABLE.find(e => e.canonicalId === 'grok-4.6')
    assert.ok(alias, 'grok-4.6 必须在别名表里（否则探测回填 128K 默认值）')
    assert.equal(alias.metadata.contextWindow, 500_000)
    assert.equal(alias.metadata.reasoningEffort, 'high')
    assert.ok(alias.aliases.includes('grok'), '短名 grok 应归一为 grok-4.6')
  })

  it('codex preset uses OAuth and gpt-6.1-sol', () => {
    const codex = cloneProviderPreset('codex')
    assert.deepEqual(codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(codex.capabilities.cacheControl, true)
    assert.equal(codex.models[0]?.id, 'gpt-6.1-sol')
    assert.ok(codex.models.some(m => m.id === 'gpt-5.6-sol'), '上代 5.6-sol 保留在列（codex 后端仍 200，2026-10-02 实测）')
  })

  it('deepseek v4-pro 已恢复（官方 2026-09-13 改口径：继续服务不下线）+ 4.1 Flash reasoningEffort', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const v4pro = deepseek.models.find(m => m.id === 'deepseek-v4-pro')
    assert.ok(v4pro, 'V4-Pro 条目在（官方改口径，撤销 ea8d9c92c 退役）')
    assert.equal(v4pro.tier, 'strong')
    assert.equal(deepseek.models.find(m => m.id === 'deepseek-flash')?.reasoningEffort, 'high', '4.1 Flash 默认 high（2026-10-05：max 过度推理，medium 不足以稳定落地 agent 任务）')
    assert.equal(deepseek.models.some(m => m.id === 'deepseek-v4-flash'), false, '官方已无 deepseek-v4-flash')
  })

  it('deepseek 已退役 v4-flash-vision-exp（官方已下线，请求由最新 Flash 承接）', () => {
    const deepseek = cloneProviderPreset('deepseek')
    assert.equal(
      deepseek.models.some(m => m.id === 'deepseek-v4-flash-vision-exp'), false,
      '视觉实验档条目已移除——它排在快照视觉档首位时会被同 provider 自动识图桥选中',
    )
    // 退役后 deepseek 下只剩一个视觉档，自动桥的落点是确定的
    assert.deepEqual(
      deepseek.models.filter(m => m.supportsVision).map(m => m.id),
      ['deepseek-flash'],
      'deepseek 预设里唯一的视觉档是 deepseek-flash',
    )
  })

  it('deepseek strong 档双卡并存（deepseek-flash + v4-pro）+ 默认档指向 4.1 Flash', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const next = deepseek.models.find(m => m.id === 'deepseek-flash')
    assert.ok(next, 'deepseek-flash 必须在 deepseek 预设模型列表')
    assert.equal(next.description, 'DeepSeek 4.1 Flash：1M 上下文 + 原生多模态（图像输入）')
    assert.equal(next.contextWindow, 1_000_000)
    assert.equal(next.maxTokens, 256_000, '默认请求输出 256K（对齐官方 harness 的 DEFAULT_MAX_TOKENS；能力上限另由 DEEPSEEK_MAX_OUTPUT 守）')
    assert.equal(next.supportsVision, true, '原生多模态声明视觉')
    assert.deepEqual(next.pricing, { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 })
    assert.equal(next.reasoningEffort, 'high', '4.1 Flash 默认 high（2026-10-05 产品决定）')
    // 官方 flash 档就是 deepseek-flash（DeepSeek-V4.1-Flash）。tier 保持 strong：
    // 瑶光门按 tier 取池，与 v4-pro 两张 strong 卡都合法，成本差由席位预算约束。
    assert.equal(next.tier, 'strong')
    const strongTiers = deepseek.models.filter(m => m.tier === 'strong').map(m => m.id)
    assert.deepEqual(strongTiers, ['deepseek-flash', 'deepseek-v4-pro'], '两个 strong 档并存')
    assert.equal(PROVIDER_PRESETS.deepseek.defaultModelId, 'deepseek-flash', '默认档指向实际模型名 deepseek-flash')
    assert.equal(deepseek.models[0]?.id, 'deepseek-flash', '首模型（无 defaultModel 时的启动兜底）为 deepseek-flash')
  })

  it('deepseek 预设始终留有 strong 卡（瑶光门落点不变量）', () => {
    // 兜住「删卡把 strong 档删空」这类改动：卡池空掉时 selectModelForTask 的
    // fallback 会静默降档，瑶光门声明的「不得低于 strong」失效且无任何留痕。
    const strong = cloneProviderPreset('deepseek').models.filter(m => m.tier === 'strong')
    assert.ok(strong.length > 0, 'DeepSeek 必须留有 strong 档落点')
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

  it('glm Coding Plan 档位映射：off→none、medium→high（官方 Coding Plan 口径）', () => {
    const glm = PROVIDER_PRESETS.glm
    assert.deepEqual(glm.provider.capabilities?.effortCap, { off: 'none', medium: 'high' })
    assert.equal(resolveEffortSupported('glm', glm.provider), true, '档位控件必须放行')
  })

  it('siliconflow：官方支持清单外的型号模型级关闭档位通道', () => {
    const sf = PROVIDER_PRESETS.siliconflow
    for (const id of ['moonshotai/Kimi-K2.7-Code', 'Qwen/Qwen3.6-27B']) {
      const model = sf.provider.models.find(m => m.id === id)!
      assert.deepEqual(model.capabilities, { effortFormat: 'none' }, `${id} 必须模型级关闭`)
      assert.equal(
        resolveEffortSupported('siliconflow', sf.provider, model.capabilities),
        false,
        `${id} 不在官方 reasoning_effort 支持清单内`,
      )
    }
    const flash = sf.provider.models.find(m => m.id === 'deepseek-ai/DeepSeek-V4-Flash')!
    assert.equal(resolveEffortSupported('siliconflow', sf.provider, flash.capabilities), true)
  })

  // Kimi Code（会员订阅端点）与 CLI 内置 DEFAULT_CONFIG.kimi 必须同源。
  // 2026-09 之前预设走 Moonshot 开放平台（api.moonshot.cn + MOONSHOT_API_KEY + kimi-k3），
  // 与内置的 Kimi Code 配置（api.kimi.com/coding + KIMI_API_KEY + k3）两套并存：
  // 用户在预设卡填的开放平台 Key 拿不到内置模型，反之亦然。以官方 Kimi Code 文档为准
  // （kimi.com/code/docs/kimi-code/models.html：Base URL api.kimi.com/coding/v1；
  // CLI/VS Code/桌面端/第三方工具请求均计入 Kimi 会员共享额度）。
  it('kimi 预设：Kimi Code 订阅额度标记 + 官方 4 个模型 ID', () => {
    const kimi = cloneProviderPreset('kimi')
    assert.equal(kimi.baseUrl, 'https://api.kimi.com/coding/v1')
    assert.equal(kimi.apiKeyEnv, 'KIMI_API_KEY')
    assert.equal(PROVIDER_PRESETS.kimi.defaultModelId, 'k3')
    assert.equal(PROVIDER_PRESETS.kimi.keyUrl, 'https://www.kimi.com/code/console', 'Key 在 Kimi Code 控制台创建，不是开放平台')
    // 订阅额度标记：label/description 明示「Kimi Code 会员订阅额度」
    assert.match(PROVIDER_PRESETS.kimi.label, /Kimi Code/)
    assert.match(PROVIDER_PRESETS.kimi.description, /Kimi Code 会员订阅额度/)
    assert.match(PROVIDER_PRESETS.kimi.description, /与 Kimi 会员共享/)
    assert.deepEqual(
      kimi.models.map(m => m.id),
      ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
      '官方模型页列 4 个模型 ID',
    )
    const k3 = kimi.models.find(m => m.id === 'k3')
    assert.ok(k3, 'k3 必须在 kimi 预设模型列表')
    assert.equal(k3.contextWindow, 1_048_576, '官方 1M（1048576；Moderato/Plus 档限 256K，Allegretto/Pro 解锁 1M）')
    assert.equal(k3.maxTokens, 131_072)
    assert.equal(k3.reasoningEffort, 'max')
    assert.equal(k3.supportsVision, true, '官方多模态：图片+视频输入（schema 只建模图片）')
    assert.equal(k3.supportsVideo, true, '官方多模态：视频输入声明')
    assert.deepEqual(k3.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'Kimi Code 会员订阅额度：不按 token 计费')
    // 官方 4 个模型 ID 里的 k3-256k：256K 上下文省额度版，k3（1M）消耗约为其两倍。
    const budget = kimi.models.find(m => m.id === 'k3-256k')
    assert.ok(budget, 'k3-256k 必须在 kimi 预设模型列表（官方 256K 省额度版）')
    assert.equal(budget.contextWindow, 262_144)
    assert.equal(budget.reasoningEffort, 'max')
    assert.equal(budget.supportsVision, true, '官方：仅图片输入（视频不支持）')
    assert.equal(budget.supportsVideo, undefined, '仅图片档不得声明视频输入')
    assert.deepEqual(budget.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('kimi-for-coding = K2.8 Preview（1M/默认 max）；highspeed = K2.7 Code（Thinking:ON 无档位）', () => {
    const kimi = PROVIDER_PRESETS.kimi.provider
    const code = kimi.models.find(m => m.id === 'kimi-for-coding')!
    assert.match(code.description ?? '', /K2\.8 Preview/, '官方 2026-09-11 起 kimi-for-coding 直接升级 K2.8 Preview')
    assert.equal(code.contextWindow, 1_048_576, 'K2.8 Preview 最高 1M 上下文')
    assert.equal(code.reasoningEffort, 'max', '官方默认思考档 max')
    assert.equal(code.supportsVision, true, '官方：图片+视频输入')
    assert.equal(code.supportsVideo, true, '官方：视频输入声明')
    assert.deepEqual(code.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

    const highspeed = kimi.models.find(m => m.id === 'kimi-for-coding-highspeed')!
    assert.ok(highspeed, '官方 4 个模型 ID 之一：高速版')
    assert.equal(highspeed.contextWindow, 262_144)
    assert.equal(highspeed.supportsVision, true, '官方：图片+视频输入')
    assert.equal(highspeed.supportsVideo, true, '官方：视频输入声明')
    assert.deepEqual(
      highspeed.capabilities,
      { effortFormat: 'none' },
      'Thinking:ON 无档位——模型级关闭档位通道，不发 reasoning_effort',
    )
    assert.equal(
      resolveEffortSupported('kimi', kimi, highspeed.capabilities),
      false,
      '档位控件对 highspeed 禁用',
    )
    assert.equal(resolveEffortSupported('kimi', kimi, code.capabilities), true, 'K2.8 的 low/high/max 档位放行')
  })

  it('MiniMax preset exposes the current fleet, global endpoint, and model-specific effort support', () => {
    const preset = PROVIDER_PRESETS.minimax
    const provider = preset.provider
    assert.equal(preset.defaultModelId, 'MiniMax-M3.1-Flash')
    assert.equal(provider.baseUrl, 'https://api.minimax.io/v1')
    assert.deepEqual(provider.models.map(model => model.id), ['MiniMax-M3.1-Flash', 'MiniMax-M3'])

    const flash = provider.models[0]!
    assert.equal(flash.contextWindow, 1_000_000)
    assert.equal(flash.reasoningEffort, 'max')
    assert.equal(flash.supportsVision, true)
    assert.equal(flash.supportsVideo, true)
    assert.deepEqual(flash.pricing, { input: 0.15, output: 0.6, cacheRead: 0.015 })
    assert.equal(resolveEffortSupported('minimax', provider, flash.capabilities), true)

    const m3 = provider.models[1]!
    assert.equal(m3.contextWindow, 1_000_000)
    assert.equal(m3.supportsVision, true)
    assert.equal(m3.supportsVideo, true)
    assert.deepEqual(m3.pricing, { input: 0.3, output: 1.2, cacheRead: 0.06 })
    assert.equal(resolveEffortSupported('minimax', provider, m3.capabilities), false)
  })

  it('official video input declarations remain available for current multimodal models', () => {
    const step = PROVIDER_PRESETS.stepfun.provider.models.find(m => m.id === 'step-5-preview')!
    assert.equal(step.supportsVision, true)
    assert.equal(step.supportsVideo, true, '官方：原生文本/图片/视频输入')
    const mm = PROVIDER_PRESETS.minimax.provider.models.find(m => m.id === 'MiniMax-M3')!
    assert.equal(mm.supportsVision, true)
    assert.equal(mm.supportsVideo, true, '官方多模态 Chat 输入：文本/图片/视频')
  })

  // 官方默认档是 DeepSeek 4.1 Flash，实际模型名 deepseek-flash，并排在列表首位。
  it('deepseek 预设默认档为 deepseek-flash，且默认档必在模型列表内并排首位', () => {
    assert.equal(PROVIDER_PRESETS.deepseek.defaultModelId, 'deepseek-flash')
    const ids = PROVIDER_PRESETS.deepseek.provider.models.map(m => m.id)
    assert.ok(ids.includes(PROVIDER_PRESETS.deepseek.defaultModelId), 'defaultModelId 必须在预设模型列表内')
    assert.equal(ids[0], 'deepseek-flash', '默认档排首位（连接向导按此顺序展示可勾选模型）')
    assert.equal(ids.includes('deepseek-v4-flash'), false)
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

describe('stepfun preset (阶跃星辰 StepFun)', () => {
  it('step-5-preview：1M 上下文 / 64k 输出 / 原生多模态 / 官方定价（元每 1M tokens）', () => {
    const stepfun = cloneProviderPreset('stepfun')
    assert.equal(stepfun.name, 'stepfun')
    assert.equal(stepfun.baseUrl, 'https://api.stepfun.com/v1')
    assert.equal(stepfun.apiKeyEnv, 'STEPFUN_API_KEY')
    assert.equal(stepfun.protocol, 'openai')
    const model = stepfun.models.find(m => m.id === 'step-5-preview')
    assert.ok(model, 'step-5-preview must be in the preset fleet')
    assert.equal(model.contextWindow, 1_000_000, '官方 1M tokens 上下文')
    assert.equal(model.maxTokens, 64_000, '官方最大输出 64k tokens')
    assert.equal(model.supportsVision, true, '原生支持文本 + 图片 + 视频输入')
    assert.equal(model.reasoningEffort, 'high', '旗舰默认高档')
    assert.equal(model.tier, 'strong')
    // 官方定价页（每 1M tokens）：输入 7 元 / 缓存命中 0.35 元 / 输出 20 元。
    // cacheWrite = 缓存未命中输入价（同 DeepSeek 条目的口径）。
    assert.deepEqual(model.pricing, { input: 7, output: 20, cacheRead: 0.35, cacheWrite: 7 })

    // 推理档：官方只有 low/medium/high —— 项目的 max 必须降到 high、off 降到 low，
    // 否则会向上游发它不认识的档位（Kimi 条目记过同款教训：静默降档也会误导用户）。
    const caps = resolveCapabilities('stepfun', stepfun.capabilities, model.capabilities)
    assert.equal(caps.effortFormat, 'reasoning_effort')
    assert.deepEqual(caps.effortCap, { max: 'high', off: 'low' })
  })

  it('fleet 只收规格完整的型号——未公布最大输出的型号不入预设（否则向导掉进模型补参）', () => {
    const stepfun = cloneProviderPreset('stepfun')
    assert.deepEqual(stepfun.models.map(m => m.id), ['step-5-preview'])
    // step-3.7-flash / step-3.5-flash 官方只公布了上下文与定价，没公布最大输出：
    // 省略 maxTokens 会让 /connect 向导判成「元数据不全」，把用户拖进「模型补参」
    // 表单（预设的价值正是免填）。这条守卫防止未来有人随手把它们加回来。
    for (const m of stepfun.models) {
      assert.ok(m.contextWindow !== undefined, `${m.id} 必须带上下文窗口`)
      assert.ok(m.maxTokens !== undefined, `${m.id} 必须带最大输出——否则触发向导补参步`)
    }
  })

  it('defaultModelId 是 fleet 成员；keyUrl 指向开放平台的接口密钥页', () => {
    const preset = PROVIDER_PRESETS.stepfun
    assert.equal(preset.defaultModelId, 'step-5-preview')
    assert.ok(
      preset.provider.models.some(m => m.id === preset.defaultModelId),
      '默认档必须在 fleet 里（否则首轮就发一个列表外的 id）',
    )
    assert.equal(preset.keyUrl, 'https://platform.stepfun.com/interface-key')
  })
})

// ── issue #272：火山方舟 Agent Plan（订阅制）第一方接入 ──────────────────────
// 官方文档（agent-plan-personal-get-started / other-tools / deepseek-harness）：
// OpenAI 兼容 Base URL = /api/plan/v3（chat + responses），Anthropic = /api/plan；
// 专属 Key 与按量/Coding Plan 互不通用；端点没有 GET /models（连接测试走补全）。
describe('volc-plan preset (火山方舟 Agent Plan, issue #272)', () => {
  const preset = PROVIDER_PRESETS['volc-plan']

  it('固定官方订阅端点与专属 Key 环境变量（不与按量 volc 混用）', () => {
    assert.equal(preset.provider.baseUrl, 'https://ark.cn-beijing.volces.com/api/plan/v3')
    assert.equal(preset.provider.protocol, 'openai')
    assert.equal(preset.provider.apiKeyEnv, 'ARK_PLAN_API_KEY')
    assert.notEqual(
      preset.provider.apiKeyEnv,
      PROVIDER_PRESETS.volc.provider.apiKeyEnv,
      'Agent Plan 专属 Key 与按量方舟 Key 互不通用，环境变量必须分开',
    )
    assert.ok(preset.keyUrl?.startsWith('https://console.volcengine.com/ark'), 'keyUrl 指向 Agent Plan 控制台')
  })

  it('默认 ark-code-latest 在 fleet 内，全部型号带完整 ctx/max 元数据与零单价', () => {
    assert.equal(preset.defaultModelId, 'ark-code-latest')
    const ids = preset.provider.models.map(m => m.id)
    assert.ok(ids.includes('ark-code-latest'))
    assert.ok(ids.includes('deepseek-v4-flash'), '官方文本生成标准档必须在 fleet 里')
    assert.ok(ids.includes('glm-5.3'))
    assert.ok(ids.includes('kimi-k3'))
    for (const m of preset.provider.models) {
      assert.ok(m.contextWindow !== undefined, `${m.id} 必须带上下文窗口（否则向导补参）`)
      assert.ok(m.maxTokens !== undefined, `${m.id} 必须带最大输出（否则向导补参）`)
      assert.deepEqual(
        m.pricing,
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        `${m.id} 走套餐 AFP 额度，单价必须清零`,
      )
    }
  })

  it('档位通道按官方 deep-thinking 表接入：7 档透传 + off→none + 未支持型号模型级关闭', () => {
    const caps = preset.provider.capabilities!
    assert.equal(caps.thinkingBlock, 'none', '只走 reasoning_effort，不发 thinking 块')
    assert.equal(caps.effortFormat, 'reasoning_effort')
    assert.deepEqual(caps.effortCap, { off: 'none' }, '内部 off 映射官方 none，永不直发')
    assert.equal(resolveEffortSupported('volc-plan', preset.provider), true, '桌面档位带必须放行')
    // 未列入方舟支持表的第三方型号：模型级 opt-out 必须压过 provider 级通道
    for (const id of ['kimi-k2.7-code', 'kimi-k3', 'kimi-k2.8-preview', 'minimax-m3']) {
      const model = preset.provider.models.find(m => m.id === id)!
      assert.deepEqual(model.capabilities, { effortFormat: 'none' }, `${id} 必须模型级关闭档位`)
      assert.equal(
        resolveEffortSupported('volc-plan', preset.provider, model.capabilities),
        false,
        `${id} 的档位控件不得放行（未验证支持）`,
      )
    }
    // 支持表内型号保持通道
    for (const id of ['ark-code-latest', 'deepseek-v4-pro', 'glm-5.3-flash', 'doubao-seed-evolving']) {
      const model = preset.provider.models.find(m => m.id === id)!
      assert.equal(
        resolveEffortSupported('volc-plan', preset.provider, model.capabilities),
        true,
        `${id} 在方舟支持表内，档位通道保持开启`,
      )
    }
  })

  it('volc 按量预设：通道在 doubao-seed-2.0-pro 模型级（探测异构型号不被误发）', () => {
    const volc = PROVIDER_PRESETS.volc
    assert.equal(volc.provider.capabilities?.effortFormat, undefined, 'provider 级不声明，保护探测来的异构型号')
    const pro = volc.provider.models.find(m => m.id === 'doubao-seed-2.0-pro')!
    assert.deepEqual(pro.capabilities, {
      thinkingBlock: 'none',
      effortFormat: 'reasoning_effort',
      effortCap: { off: 'none' },
    })
    assert.equal(resolveEffortSupported('volc', volc.provider, pro.capabilities), true)
    const flash = volc.provider.models.find(m => m.id === 'doubao-seed-2.0-flash')!
    assert.equal(flash.capabilities, undefined, '未验证型号不开通道')
    assert.equal(resolveEffortSupported('volc', volc.provider, flash.capabilities), false)
  })

  it('别名表吸收预设 fleet：ark-code-latest 回填 256K + 视觉', () => {
    const entry = MODEL_ALIAS_TABLE.find(e => e.canonicalId === 'ark-code-latest')
    assert.ok(entry, 'ark-code-latest 必须在别名表（探测/手填元数据回填来源）')
    assert.equal(entry.metadata.contextWindow, 256_000)
    assert.equal(entry.metadata.supportsVision, true)
  })

  it('Anthropic 兄弟预设：/api/plan + anthropic 协议，fleet/Key 与 OpenAI 面同源', () => {
    const anthropic = PROVIDER_PRESETS['volc-plan-anthropic']
    assert.equal(anthropic.provider.baseUrl, 'https://ark.cn-beijing.volces.com/api/plan')
    assert.equal(anthropic.provider.protocol, 'anthropic')
    assert.equal(anthropic.provider.apiKeyEnv, preset.provider.apiKeyEnv)
    assert.deepEqual(
      anthropic.provider.models.map(m => m.id),
      preset.provider.models.map(m => m.id),
      '两个协议端点共用同一份套餐 fleet',
    )
    // 端点同样没有 /models（探测跳过列表走 /v1/messages 补全）
    assert.equal(hasModelsListEndpoint('volc-plan-anthropic', anthropic.provider.baseUrl), false)
    // Messages 面的官方档位通道是 output_config.effort——声明后 UI 才放行
    // （resolveEffortSupported 对 anthropic 只认这一条通道）。
    assert.equal(anthropic.provider.capabilities?.effortFormat, 'output_config')
    assert.deepEqual(anthropic.provider.capabilities?.effortCap, { off: 'none' })
    assert.equal(resolveEffortSupported('volc-plan-anthropic', anthropic.provider), true)
  })
})

// ── issue #258：托管 DeepSeek 思考模型的网关必须声明完整协议能力 ──────────────
// 用户报的两条 400 都源自 opencode-go 预设只声明了「传输/缓存」能力，思考协议
// 三件套（effort 枚举映射 + 回传 reasoning_content）全靠用户手改 config.json。
describe('opencode-go preset declares the DeepSeek thinking protocol (issue #258)', () => {
  const caps = PROVIDER_PRESETS['opencode-go'].provider.capabilities!

  it('声明回传 reasoning_content（否则第二轮起被网关 400 拒收）', () => {
    assert.equal(caps.preservedThinkingProtocol, true)
    assert.equal(caps.thinkingBlock, 'enabled')
    assert.equal(PROVIDER_PRESETS['opencode-go'].provider.thinking, 'enabled',
      'preservedThinkingProtocol 生效的前置：provider.thinking 必须 enabled')
  })

  it('声明 reasoning_effort 通道与 off→none 映射（该网关枚举无 off）', () => {
    assert.equal(caps.effortFormat, 'reasoning_effort')
    assert.deepEqual(caps.effortCap, { off: 'none' })
  })

  it('解析后的能力对象端到端带上这些字段（applyOverrides 不得吞掉）', () => {
    const resolved = resolveCapabilities('opencode-go', caps)
    assert.equal(resolved.preservedThinkingProtocol, true)
    assert.equal(resolved.effortFormat, 'reasoning_effort')
    assert.deepEqual(resolved.effortCap, { off: 'none' })
    assert.equal(resolved.supportsThinking, true, 'thinkingBlock/effortFormat 声明应推导出 supportsThinking')
    assert.equal(
      resolveEffortSupported('opencode-go', PROVIDER_PRESETS['opencode-go'].provider),
      true,
      '桌面/TUI 档位菜单据此启用（此前该网关的档位是静默丢弃的）',
    )
  })
})

// ── Agnes AI（免费多模态：文本 + 生图）──────────────────────────────────────
// 官方文档（www.agnes-ai.com/zh-Hans/docs/*，2026-10-02 口径）：Base URL
// apihub.agnes-ai.com/v1（旧域名 api.agnes.ai 已停）；文本档 512K/65K + 图像
// URL 输入；免费档现价 $0（优惠期，以官方账单为准）；生图走 /v1/images/generations
// （size 必填，1K–4K 档位）。预设把免费资源做成开箱即用节点——用户注册拿 Key 即用。
describe('agnes preset (Agnes AI 免费档)', () => {
  it('固定官方端点与 Key 控制台；label/description 标注免费', () => {
    const preset = PROVIDER_PRESETS.agnes
    assert.equal(preset.provider.baseUrl, 'https://apihub.agnes-ai.com/v1')
    assert.equal(preset.provider.protocol, 'openai')
    assert.equal(preset.provider.apiKeyEnv, 'AGNES_API_KEY')
    assert.equal(preset.keyUrl, 'https://platform.agnes-ai.com/')
    assert.match(preset.label, /免费/, 'label 必须让用户看到免费标注')
    assert.match(preset.description, /免费/, 'description 同标注')
  })

  it('免费文本档（3.0-flash / 2.5-flash）：512K / 65K / 图像输入 / pricing 0 + free', () => {
    for (const id of ['agnes-3.0-flash', 'agnes-2.5-flash']) {
      const m = PROVIDER_PRESETS.agnes.provider.models.find(x => x.id === id)
      assert.ok(m, `${id} 必须在 fleet 里`)
      assert.equal(m.contextWindow, 512_000, '官网 512K')
      assert.equal(m.maxTokens, 65_536, '官网最大输出 65,536')
      assert.equal(m.supportsVision, true, '官方：文本 + 图像 URL 输入')
      assert.deepEqual(m.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, free: true }, '现价 $0 + free 标记')
    }
  })

  it('付费旗舰 2.5-pro：1M 上下文，按刊例价计费，不标 free', () => {
    const pro = PROVIDER_PRESETS.agnes.provider.models.find(m => m.id === 'agnes-2.5-pro')
    assert.ok(pro)
    assert.equal(pro.contextWindow, 1_000_000, '官网 1M')
    assert.equal(pro.maxTokens, 65_536)
    assert.equal(pro.supportsVision, true)
    assert.notEqual(pro.pricing?.free, true, '付费档不得标 free（免费徽章会说谎）')
    assert.equal(pro.pricing?.input, 0.45)
    assert.equal(pro.pricing?.output, 0.9)
    assert.equal(pro.pricing?.cacheRead, 0.045)
  })

  it('生图档：supportsImageGen + free；绝不标 supportsVision（防泄进识图桥候选池）', () => {
    const img = PROVIDER_PRESETS.agnes.provider.models.find(m => m.id === 'agnes-image-2.5-flash')
    assert.ok(img)
    assert.equal(img.supportsImageGen, true, '生图槽按此标记列出（desktop ImageGenModelSettings）')
    assert.notEqual(img.supportsVision, true, '生图（文→图）与视觉输入（图→文）方向相反，标记不可混用')
    assert.equal(img.pricing?.free, true, '官方：所有分辨率档位与输入参考图当前免费')
  })

  it('默认档首位 + 全模型 ctx/max 齐全（connect-flow 补参的硬前提）', () => {
    assert.equal(PROVIDER_PRESETS.agnes.defaultModelId, 'agnes-3.0-flash')
    const ids = PROVIDER_PRESETS.agnes.provider.models.map(m => m.id)
    assert.equal(ids[0], 'agnes-3.0-flash', '默认档排首位（向导按此顺序展示）')
    for (const m of PROVIDER_PRESETS.agnes.provider.models) {
      assert.ok(m.contextWindow !== undefined, `${m.id} 缺 ctx 会被向导拖进补参`)
      assert.ok(m.maxTokens !== undefined, `${m.id} 缺 max 会被向导拖进补参`)
    }
  })

  it('档位诚实：未声明 reasoning_effort 通道（官方走 chat_template_kwargs）', () => {
    assert.equal(
      resolveEffortSupported('agnes', PROVIDER_PRESETS.agnes.provider),
      false,
      '无通道 → 档位控件禁用（避免静默丢弃后仍报设置成功）',
    )
  })

  it('缓存：deepseek-native 策略 + mapUsage（cached_tokens 口径，与 GLM 同型）', () => {
    const caps = resolveCapabilities('agnes')
    assert.equal(caps.prefixCacheStrategy, 'deepseek-native', '官方定价页列输入缓存命中计费项')
    assert.ok(caps.mapUsage, 'agnes must expose a usage mapping to read cached_tokens')
    assert.equal(caps.effortFormat, 'none', '不发未验证的档位参数')
  })

  it('别名表吸收预设 fleet：agnes-3.0-flash 回填 512K + 图像输入 + free', () => {
    const entry = MODEL_ALIAS_TABLE.find(e => e.canonicalId === 'agnes-3.0-flash')
    assert.ok(entry, 'agnes-3.0-flash 必须在别名表（探测/回填的元数据来源）')
    assert.equal(entry.metadata.contextWindow, 512_000)
    assert.equal(entry.metadata.supportsVision, true)
    assert.equal(entry.metadata.pricing?.free, true, '免费标记随别名表元数据流转')
  })
})

// ── issue #339：Google Gemini 原生协议（收编公开仓 PR #340）──────────────────
// 兼容层（/v1beta/openai/）会丢 Gemini 3 要求回传的 thoughtSignature，多轮工具
// 第二轮 400——预设必须钉死 protocol: 'gemini'，prefixCache 不假装复用别家策略。
describe('gemini preset (Google Gemini 原生协议, issue #339)', () => {
  it('固定官方原生端点 / GEMINI_API_KEY / AI Studio keyUrl / protocol gemini', () => {
    const preset = PROVIDER_PRESETS.gemini
    assert.equal(preset.provider.baseUrl, 'https://generativelanguage.googleapis.com/v1beta')
    assert.equal(preset.provider.protocol, 'gemini')
    assert.equal(preset.provider.apiKeyEnv, 'GEMINI_API_KEY')
    assert.equal(preset.keyUrl, 'https://aistudio.google.com/apikey')
    assert.equal(preset.provider.capabilities?.prefixCache, 'none', '原生协议没有 explicit-breakpoint 缓存，不得假装复用')
  })

  it('默认档 gemini-3.8-flash 排 fleet 首位，全模型 ctx/max 齐全', () => {
    const preset = PROVIDER_PRESETS.gemini
    assert.equal(preset.defaultModelId, 'gemini-3.8-flash')
    const ids = preset.provider.models.map(m => m.id)
    assert.equal(ids[0], 'gemini-3.8-flash', '默认档排首位（向导按此顺序展示）')
    for (const m of preset.provider.models) {
      assert.ok(m.contextWindow !== undefined, `${m.id} 缺 ctx 会被向导拖进补参`)
      assert.ok(m.maxTokens !== undefined, `${m.id} 缺 max 会被向导拖进补参`)
    }
    assert.ok(preset.provider.models.some(m => m.tier === 'strong'), '必须留有 strong 档落点')
  })
})

// ── issue #386：MiMo V2.6 Flash / Pro 进 fleet ──────────────────────────────
// 官方模型列表（mimo.mi.com/docs/quick-start/summary/model，更新 2026-10-08）：
// mimo-v2.6-pro / mimo-v2.6-flash = 文本生成 + 全模态理解（图像输入）+ 深度思考 /
// 函数调用 / 结构化输出，1M 上下文 / 128K 输出；mimo-v2.5-pro、mimo-v2.5 将于
// 北京时间 2026-10-21 10:00 下线。两个预设（Token Plan 与按量 API）都覆盖 V2.6。
describe('mimo presets include V2.6 (issue #386)', () => {
  it('Token Plan 与按量 API 两个预设都收录 V2.6 Flash / Pro（1M / 128K / 图像输入）', () => {
    for (const key of ['mimo', 'mimo-api'] as const) {
      const preset = PROVIDER_PRESETS[key]
      for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
        const model = preset.provider.models.find(m => m.id === id)
        assert.ok(model, `${key} 预设必须收录 ${id}`)
        assert.equal(model.contextWindow, 1_000_000, `${id} 官方上下文 1M`)
        assert.equal(model.maxTokens, 128_000, `${id} 官方最大输出 128K`)
        assert.equal(model.supportsVision, true, `${id} 官方全模态：图像输入`)
        assert.ok(model.tier !== undefined, `${id} 需要 tier（worker 分池）`)
      }
      // V2.5 条目保留（存量用户仍在用），但在 10-21 前要被 V2.6 取代
      assert.ok(preset.provider.models.some(m => m.id === 'mimo-v2.6-pro'))
      assert.match(preset.description, /V2\.6/, '预设描述必须让用户看到 V2.6 已可选')
    }
  })

  it('官方定价（海外刊例价，USD/百万 tokens，2026-10-08）', () => {
    const pro = PROVIDER_PRESETS.mimo.provider.models.find(m => m.id === 'mimo-v2.6-pro')!
    assert.deepEqual(pro.pricing, { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0.435 })
    const flash = PROVIDER_PRESETS.mimo.provider.models.find(m => m.id === 'mimo-v2.6-flash')!
    assert.deepEqual(flash.pricing, { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 })
    assert.equal(pro.tier, 'strong')
    assert.equal(flash.tier, 'cheap')
  })

  it('全模态声明随 fleet 进别名表：探测拉到的 V2.6 命中 supportsVision（不再漏勾）', () => {
    for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
      const entry = MODEL_ALIAS_TABLE.find(e => e.canonicalId === id)
      assert.ok(entry, `${id} 必须在别名表（fleet 是其来源）`)
      assert.equal(entry.metadata.supportsVision, true)
      assert.equal(entry.metadata.contextWindow, 1_000_000)
      assert.equal(entry.metadata.maxTokens, 128_000)
    }
  })

  it('刻意不声明 reasoningSplit（MiMo 预设未声明该能力，带上会让 openai-client 注入 reasoning_split）', () => {
    for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
      for (const key of ['mimo', 'mimo-api'] as const) {
        const model = PROVIDER_PRESETS[key].provider.models.find(m => m.id === id)!
        assert.equal(model.capabilities?.reasoningSplit, undefined, `${key}/${id}`)
      }
    }
  })
})
