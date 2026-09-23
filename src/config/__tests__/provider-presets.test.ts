import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema, modelConfigSchema } from '../schema.js'
import { PROVIDER_PRESETS, cloneProviderPreset, providerPresetKeys } from '../provider-presets.js'
import { resolveCapabilities, resolveEffortSupported } from '../../api/provider.js'
import { MODEL_ALIAS_TABLE } from '../../api/model-aliases.js'
import { DEFAULT_CONFIG } from '../default.js'
import { migratePresetModelBackfill } from '../preset-model-backfill.js'

describe('provider presets', () => {
  it('contains required built-in provider modes', () => {
    assert.deepEqual([...providerPresetKeys].sort(), ['ccswitch', 'codex', 'dashscope', 'deepseek', 'glm', 'grok', 'kimi', 'longcat', 'mimo', 'mimo-api', 'minimax', 'ollama', 'openai', 'opencode-go', 'opencode-go-anthropic', 'openrouter', 'relay', 'siliconflow', 'stepfun', 'volc', 'zhipu-vision'].sort())
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

  it('codex preset uses OAuth and gpt-5.6-sol', () => {
    const codex = cloneProviderPreset('codex')
    assert.deepEqual(codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(codex.capabilities.cacheControl, true)
    assert.equal(codex.models[0]?.id, 'gpt-5.6-sol')
  })

  it('deepseek v4-pro 已恢复（官方 2026-09-13 改口径：继续服务不下线）+ flash 档 reasoningEffort', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const v4pro = deepseek.models.find(m => m.id === 'deepseek-v4-pro')
    assert.ok(v4pro, 'V4-Pro 条目在（官方改口径，撤销 ea8d9c92c 退役）')
    assert.equal(v4pro.tier, 'strong')
    assert.equal(deepseek.models.find(m => m.id === 'deepseek-v4-flash')?.reasoningEffort, 'medium')
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

  it('deepseek strong 档双卡并存（v4-pro + deepseek-flash）+ 默认档指向 v4-flash', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const next = deepseek.models.find(m => m.id === 'deepseek-flash')
    assert.ok(next, 'deepseek-flash 必须在 deepseek 预设模型列表')
    assert.equal(next.contextWindow, 1_000_000)
    assert.equal(next.maxTokens, 384_000)
    assert.equal(next.supportsVision, true, '原生多模态声明视觉')
    assert.deepEqual(next.pricing, { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 })
    assert.equal(next.reasoningEffort, 'medium')
    // 2026-09-13：v4-pro 官方改口径继续服务（撤销退役）后，deepseek 有两个 strong 档——
    // v4-pro（3/6 价、纯文本推理）与 deepseek-flash（1/2 价、视觉多模态）。瑶光门席位
    // 按 tier 解析时池内两卡都合法，成本差由席位自身预算约束；本卡保持 'strong'——
    // 否则纯文本强档只剩 v4-pro 一张 3/6 价卡，cheap 回退线失效。
    assert.equal(next.tier, 'strong')
    const strongTiers = deepseek.models.filter(m => m.tier === 'strong').map(m => m.id)
    assert.deepEqual(strongTiers, ['deepseek-v4-pro', 'deepseek-flash'], '两个 strong 档并存')
    assert.equal(PROVIDER_PRESETS.deepseek.defaultModelId, 'deepseek-v4-flash', '默认档指向 v4-flash')
    assert.equal(deepseek.models[0]?.id, 'deepseek-v4-flash', '首模型（无 defaultModel 时的启动兜底）为 v4-flash——条目顺序复原')
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

  // PR-4 收口：DeepSeek 默认档从旗舰（v4-pro）改为快速档（v4-flash），预设表内也把
  // flash 提到首位。钉住预设内容本身——先前只有 TUI 的 connect-flow 用字面量间接钉着，
  // 那条改为「跟随预设」的派生断言后，内容层面需要在这里接住（内容归属 config）。
  it('deepseek 预设默认档为 v4-flash，且默认档必在模型列表内并排首位', () => {
    assert.equal(PROVIDER_PRESETS.deepseek.defaultModelId, 'deepseek-v4-flash')
    const ids = PROVIDER_PRESETS.deepseek.provider.models.map(m => m.id)
    assert.ok(ids.includes(PROVIDER_PRESETS.deepseek.defaultModelId), 'defaultModelId 必须在预设模型列表内')
    assert.equal(ids[0], 'deepseek-v4-flash', '默认档排首位（连接向导按此顺序展示可勾选模型）')
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
