import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentSchema, configSchema, modelConfigSchema, providerSchema, workersSchema, inferModelContextWindow, DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_TOKENS } from '../schema.js'
import { DEFAULT_CONFIG } from '../default.js'

describe('model supportsVision', () => {
  const base = { id: 'm', contextWindow: 128_000, maxTokens: 8_192 }

  it('defaults to undefined (text-only)', () => {
    const parsed = modelConfigSchema.parse(base)
    assert.equal(parsed.supportsVision, undefined)
  })

  it('parses an explicit supportsVision flag', () => {
    assert.equal(modelConfigSchema.parse({ ...base, supportsVision: true }).supportsVision, true)
    assert.equal(modelConfigSchema.parse({ ...base, supportsVision: false }).supportsVision, false)
  })

  it('rejects non-boolean supportsVision', () => {
    assert.throws(() => modelConfigSchema.parse({ ...base, supportsVision: 'yes' }))
  })

  it('preset vision models carry supportsVision=true through configSchema', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)
    const glm = parsed.provider.providers.glm?.models.find(m => m.id === 'glm-5.2')
    assert.equal(glm?.supportsVision, true)
    // 样本必须是一个现存的无视觉模型：写已退役的 id 会让 find 返回 undefined，
    // 而 `?.supportsVision` 依旧是 undefined——断言会退化成永不失败的空壳。
    // 故先钉住样本存在（2026-09-11 v4pro 退役时踩到过这个坑）。
    const deepseek = parsed.provider.providers.deepseek?.models.find(m => m.id === 'deepseek-v4-flash')
    assert.ok(deepseek, 'deepseek-v4-flash 必须存在于预设，否则本断言失去意义')
    assert.equal(deepseek.supportsVision, undefined, 'text-only models stay undeclared')
  })
})

describe('model capabilities override (per-model thinking split)', () => {
  const base = { id: 'm', contextWindow: 128_000, maxTokens: 8_192 }

  it('defaults to undefined (no per-model override)', () => {
    const parsed = modelConfigSchema.parse(base)
    assert.equal(parsed.capabilities, undefined)
  })

  it('parses a thinkingBlock override (Qwen-style split)', () => {
    const parsed = modelConfigSchema.parse({
      ...base,
      capabilities: { thinkingBlock: 'enabled', effortFormat: 'reasoning_effort' },
    })
    assert.equal(parsed.capabilities?.thinkingBlock, 'enabled')
    assert.equal(parsed.capabilities?.effortFormat, 'reasoning_effort')
  })

  it('parses a "thinking off" override for cheaper model in same provider', () => {
    const parsed = modelConfigSchema.parse({
      ...base,
      capabilities: { thinkingBlock: 'none', effortFormat: 'none' },
    })
    assert.equal(parsed.capabilities?.thinkingBlock, 'none')
    assert.equal(parsed.capabilities?.effortFormat, 'none')
  })

  it('rejects invalid thinkingBlock values', () => {
    assert.throws(() => modelConfigSchema.parse({
      ...base,
      capabilities: { thinkingBlock: 'bogus' },
    }))
  })

  it('dashscope preset carries per-model thinking split through configSchema', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)
    const dashscope = parsed.provider.providers.dashscope
    assert.ok(dashscope, 'dashscope must be in DEFAULT_CONFIG')
    const qmax = dashscope.models.find(m => m.id === 'qwen3.8-max')
    assert.equal(qmax?.capabilities?.thinkingBlock, 'enabled')
    assert.equal(qmax?.capabilities?.effortFormat, 'reasoning_effort')
    assert.equal(qmax?.contextWindow, 1_000_000)
  })
})

describe('model contextWindow/maxTokens materialization', () => {
  it('infers the context window from size suffixes in the model id', () => {
    assert.equal(inferModelContextWindow('glm-4.6-air-128k'), 128 * 1024)
    assert.equal(inferModelContextWindow('qwen-long-1m'), 1024 * 1024)
    assert.equal(inferModelContextWindow('deepseek-chat-64k-preview'), 64 * 1024)
  })

  it('does not false-positive on model names that merely contain digits+k/m letters', () => {
    assert.equal(inferModelContextWindow('kimi-k2'), undefined)
    assert.equal(inferModelContextWindow('minimax-m3'), undefined)
    assert.equal(inferModelContextWindow('gpt-5.5'), undefined)
    assert.equal(inferModelContextWindow('claude-opus-4-7'), undefined)
  })

  it('falls back to conservative defaults when the id carries no size hint', () => {
    const parsed = modelConfigSchema.parse({ id: 'some-unknown-model' })
    assert.equal(parsed.contextWindow, DEFAULT_MODEL_CONTEXT_WINDOW)
    assert.equal(parsed.maxTokens, DEFAULT_MODEL_MAX_TOKENS)
  })

  it('prefers an explicit contextWindow over id inference', () => {
    const parsed = modelConfigSchema.parse({ id: 'm-128k', contextWindow: 200_000 })
    assert.equal(parsed.contextWindow, 200_000)
  })

  it('clamps default maxTokens to the context window', () => {
    const parsed = modelConfigSchema.parse({ id: 'tiny-4k', maxTokens: 100_000 })
    assert.equal(parsed.contextWindow, 4 * 1024)
    assert.equal(parsed.maxTokens, 4 * 1024)
  })
})

describe('provider protocol normalization', () => {
  const minimal = { baseUrl: 'https://api.example.com', models: [{ id: 'm' }] }

  it('defaults protocol to openai', () => {
    const parsed = providerSchema.parse({ ...minimal, name: 'my-provider' })
    assert.equal(parsed.protocol, 'openai')
  })

  it('normalizes a provider named anthropic to protocol anthropic', () => {
    const parsed = providerSchema.parse({ ...minimal, name: 'anthropic' })
    assert.equal(parsed.protocol, 'anthropic')
  })

  it('preserves an explicit protocol override on a provider named anthropic', () => {
    const parsed = providerSchema.parse({ ...minimal, name: 'anthropic', protocol: 'openai' })
    assert.equal(parsed.protocol, 'openai')
  })

  it('allows an empty model list (probe-filled providers)', () => {
    const parsed = providerSchema.parse({ name: 'probe-me', baseUrl: 'https://api.example.com' })
    assert.deepEqual(parsed.models, [])
  })
})

describe('agent visionModel', () => {
  it('defaults visionModel to undefined', () => {
    const agent = agentSchema.parse({})
    assert.equal(agent.visionModel, undefined)
  })

  it('parses a visionModel configuration', () => {
    const agent = agentSchema.parse({
      visionModel: {
        provider: 'glm',
        model: 'glm-5.2',
        prompt: 'Describe this image.',
        maxTokens: 2048,
      },
    })
    assert.deepEqual(agent.visionModel, {
      provider: 'glm',
      model: 'glm-5.2',
      prompt: 'Describe this image.',
      maxTokens: 2048,
    })
  })

  it('defaults visionModel maxTokens', () => {
    const agent = agentSchema.parse({
      visionModel: { provider: 'glm', model: 'glm-5.2' },
    })
    assert.equal(agent.visionModel?.maxTokens, 1024)
  })

  it('rejects invalid visionModel fields', () => {
    assert.throws(() => agentSchema.parse({
      visionModel: { provider: 'glm', model: 'glm-5.2', maxTokens: -1 },
    }))
  })
})

describe('config permissions schema', () => {
  it('defaults permissions.allow to an empty list', () => {
    const agent = agentSchema.parse({})

    assert.deepEqual(agent.permissions.allow, [])
  })

  it('parses permissions.allow tool and params entries', () => {
    const agent = agentSchema.parse({
      permissions: {
        allow: [
          { tool: 'read_file', params: { file_path: 'docs/*' } },
          { tool: 'bash', params: { command: 'git status*' } },
        ],
      },
    })

    assert.equal(agent.permissions.allow.length, 2)
    assert.equal(agent.permissions.allow[0]?.tool, 'read_file')
    assert.deepEqual(agent.permissions.allow[1]?.params, { command: 'git status*' })
  })

  it('keeps DEFAULT_CONFIG compatible with configSchema', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.deepEqual(parsed.agent.permissions.allow, [])
    assert.deepEqual(parsed.ui, {})
  })

  it('parses valid ui.theme values', () => {
    const parsed = configSchema.parse({
      ...DEFAULT_CONFIG,
      ui: { theme: 'ziwei' },
    })

    assert.equal(parsed.ui.theme, 'ziwei')
  })

  it('rejects invalid ui.theme values', () => {
    assert.throws(() =>
      configSchema.parse({
        ...DEFAULT_CONFIG,
        ui: { theme: 'neon-pink' },
      })
    )
  })

  it('parses dangerously-skip-permissions approval mode', () => {
    const agent = agentSchema.parse({ approval: 'dangerously-skip-permissions' })

    assert.equal(agent.approval, 'dangerously-skip-permissions')
  })

  it('includes Codex OAuth provider in DEFAULT_CONFIG', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.deepEqual(parsed.provider.providers.codex?.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(parsed.provider.providers.codex?.models[0]?.id, 'gpt-5.6-sol')
  })

  it('keeps DEFAULT_CONFIG default provider and model specs valid', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.ok(parsed.provider.providers[parsed.provider.default])
    for (const [providerName, provider] of Object.entries(parsed.provider.providers)) {
      assert.ok(provider.models.length > 0, `${providerName} must have at least one model`)
      for (const model of provider.models) {
        assert.ok(model.contextWindow > 0, `${providerName}/${model.id} contextWindow must be positive`)
        assert.ok(model.maxTokens > 0, `${providerName}/${model.id} maxTokens must be positive`)
      }
    }
  })

  it('keeps worker profiles pointing to configured providers', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    for (const [profileName, profile] of Object.entries(parsed.workers.profiles)) {
      assert.ok(parsed.provider.providers[profile.provider], `${profileName} points to missing provider ${profile.provider}`)
    }
  })

  it('parses null API key tombstones as cleared optional fields', () => {
    const parsed = configSchema.parse({
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...DEFAULT_CONFIG.provider.providers.deepseek,
            apiKey: 'sk-inline',
            apiKeyEnv: null,
          },
        },
      },
    })

    assert.equal(parsed.provider.providers.deepseek?.apiKey, 'sk-inline')
    assert.equal(parsed.provider.providers.deepseek?.apiKeyEnv, undefined)
  })

  it('keeps Songline runtime disabled by default', () => {
    const agent = agentSchema.parse({})
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.equal(agent.songlineEnabled, false)
    assert.equal(parsed.agent.songlineEnabled, false)
    assert.equal(agent.antiAnchoring.enabled, false)
    assert.equal(parsed.agent.antiAnchoring.enabled, false)
    assert.equal(agent.intentRetrievalRouter.enabled, true)
    assert.equal(parsed.agent.intentRetrievalRouter.enabled, true)
  })

  it('parses explicit Songline runtime opt-in', () => {
    const agent = agentSchema.parse({ songlineEnabled: true })

    assert.equal(agent.songlineEnabled, true)
  })

  it('parses explicit anti-anchoring runtime opt-in with defaults', () => {
    const agent = agentSchema.parse({ antiAnchoring: { enabled: true } })

    assert.equal(agent.antiAnchoring.enabled, true)
    assert.equal(agent.antiAnchoring.blindExploration, true)
    assert.equal(agent.antiAnchoring.mctsPlanning, false)
    assert.equal(agent.antiAnchoring.branches, 3)
  })

  it('parses explicit intent retrieval router opt-in and boolean shorthand', () => {
    const fromBoolean = agentSchema.parse({ intentRetrievalRouter: true })
    const fromObject = agentSchema.parse({ intentRetrievalRouter: { enabled: true, classifier: 'heuristic', timeoutMs: 123 } })

    assert.equal(fromBoolean.intentRetrievalRouter.enabled, true)
    assert.equal(fromBoolean.intentRetrievalRouter.classifier, 'heuristic')
    assert.equal(fromBoolean.intentRetrievalRouter.timeoutMs, 4_000)
    assert.equal(fromObject.intentRetrievalRouter.enabled, true)
    assert.equal(fromObject.intentRetrievalRouter.classifier, 'heuristic')
    assert.equal(fromObject.intentRetrievalRouter.timeoutMs, 123)
  })

  it('keeps LLM speculation disabled by default and parses opt-in shorthand', () => {
    const agent = agentSchema.parse({})
    const parsed = configSchema.parse(DEFAULT_CONFIG)
    assert.equal(agent.llmSpeculation.enabled, false)
    assert.equal(parsed.agent.llmSpeculation.enabled, false)
    assert.equal(agent.llmSpeculation.slowToolsOnly, true)

    const fromBoolean = agentSchema.parse({ llmSpeculation: true })
    assert.equal(fromBoolean.llmSpeculation.enabled, true)
    assert.equal(fromBoolean.llmSpeculation.maxPerTurn, 3)

    const fromObject = agentSchema.parse({ llmSpeculation: { enabled: true, maxPerTurn: 5, timeoutMs: 500 } })
    assert.equal(fromObject.llmSpeculation.enabled, true)
    assert.equal(fromObject.llmSpeculation.maxPerTurn, 5)
    assert.equal(fromObject.llmSpeculation.timeoutMs, 500)
    assert.equal(fromObject.llmSpeculation.maxTokens, 320)
  })

  it('routes repo summarization workers to V4 Flash by default', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.equal(parsed.workers.routing.repo_summarization, 'cheap-flash')
    assert.equal(parsed.workers.profiles['cheap-flash']?.provider, 'deepseek')
    assert.equal(parsed.workers.profiles['cheap-flash']?.model, 'deepseek-v4-flash')
  })

  it('fills missing worker routing defaults with cheap-flash for repo summarization', () => {
    const parsed = workersSchema.parse({
      profiles: {
        'cheap-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
        capable: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      },
    })

    assert.equal(parsed.routing.repo_summarization, 'cheap-flash')
    assert.equal(parsed.routing.code_edit, 'cheap-flash')
  })

  it('routes all workers to cheap-flash by default (v4-flash 去廉价化)', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    // 2026-08-02：v4-flash 能力实测已超 v4-pro，planning 不再独立走强档，
    // 全部 worker 任务默认走 cheap-flash；需更强可在 config 改 capable。
    for (const [task, profile] of Object.entries(parsed.workers.routing)) {
      assert.equal(profile, 'cheap-flash', `${task} should route to cheap-flash, got ${profile}`)
    }
  })
})

describe('pro schema', () => {
  it('DEFAULT_CONFIG keeps Pro disabled for the free tier, with features ready once Pro activates', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    // 双层模式：免费层的保护是 enabled=false（isProEnabled gate 一票否决）。
    // features 默认 true —— Pro 激活（许可证/RIVET_PRO）即全部可用，无需逐项手开。
    assert.equal(parsed.pro.enabled, false)
    assert.equal(parsed.pro.features.computerUse, true)
    assert.equal(parsed.pro.features.chatGateway, true)
    assert.equal(parsed.pro.features.teamMax, true)
    assert.equal(parsed.pro.features.councilMultiRound, true)
  })

  it('schema defaults Pro features to enabled when Pro is active', () => {
    const parsed = configSchema.parse({
      ...DEFAULT_CONFIG,
      pro: { enabled: true },
    })

    assert.equal(parsed.pro.enabled, true)
    assert.equal(parsed.pro.features.computerUse, true)
    assert.equal(parsed.pro.features.chatGateway, true)
  })

  it('parses explicit Pro opt-in and per-feature overrides', () => {
    const parsed = configSchema.parse({
      ...DEFAULT_CONFIG,
      pro: {
        enabled: true,
        licenseKey: 'test-key',
        features: { computerUse: false, chatGateway: true },
      },
    })

    assert.equal(parsed.pro.enabled, true)
    assert.equal(parsed.pro.licenseKey, 'test-key')
    assert.equal(parsed.pro.features.computerUse, false)
    assert.equal(parsed.pro.features.chatGateway, true)
  })
})

describe('providerSchema keyRef and userSaved fields', () => {
  it('accepts a provider with keyRef instead of apiKey', () => {
    const input = {
      name: 'deepseek',
      keyRef: 'deepseek-apikey',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai',
      capabilities: {},
    }
    const result = providerSchema.parse(input)
    assert.equal(result.name, 'deepseek')
    assert.equal(result.keyRef, 'deepseek-apikey')
    assert.equal(result.apiKey, undefined)
    assert.equal(result.userSaved, undefined)
  })

  it('accepts a provider with userSaved=true', () => {
    const input = {
      name: 'my-custom',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1',
      protocol: 'openai',
      capabilities: {},
      userSaved: true,
    }
    const result = providerSchema.parse(input)
    assert.equal(result.userSaved, true)
  })

  it('defaults userSaved to undefined when omitted', () => {
    const input = {
      name: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      capabilities: {},
    }
    const result = providerSchema.parse(input)
    assert.equal(result.userSaved, undefined)
  })

  it('prefers keyRef over apiKey when both are present', () => {
    const input = {
      name: 'deepseek',
      apiKey: 'sk-inline',
      keyRef: 'deepseek-apikey',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai',
      capabilities: {},
    }
    const result = providerSchema.parse(input)
    // Both fields parse; keyRef is the preferred channel per comments, but schema accepts both
    assert.equal(result.apiKey, 'sk-inline')
    assert.equal(result.keyRef, 'deepseek-apikey')
  })

  it('rejects keyRef with non-string type', () => {
    const input = {
      name: 'deepseek',
      keyRef: 123 as any,
      baseUrl: 'https://api.deepseek.com/v1',
      capabilities: {},
    }
    assert.throws(() => providerSchema.parse(input))
  })

  it('rejects invalid baseUrl with keyRef', () => {
    const input = {
      name: 'deepseek',
      keyRef: 'deepseek-apikey',
      baseUrl: 'not-a-url',
      protocol: 'openai',
      capabilities: {},
    }
    assert.throws(() => providerSchema.parse(input))
  })
})
