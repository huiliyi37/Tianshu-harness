import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentConfig, createMainAgentConfigInput, type AgentConfigInput } from '../agent/create-agent-config.js'
import { normalizeIntentRetrievalRouterConfig } from '../agent/intent-retrieval-router.js'
import type { Config, ProviderConfig } from '../config/schema.js'

const testProvider: ProviderConfig = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  protocol: 'openai',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: true,
    prefixCache: 'deepseek-native',
    prefixCompletion: true,
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const testConfig = {
  agent: {
    approval: 'manual',
    unsandboxed: false,
    maxTurns: 50,
    mode: 'code',
    autoReasoning: false,
    defaultDomain: 'auto',
    domainKeywordRouting: true,
    verificationSnapshot: 'auto',
    songlineEnabled: true,
    constellationEnabled: false,
    companionPresenceEnabled: false,
    dreamEnabled: true,
    securityGuidance: true,
    scoutEvidenceFirewall: false,
    desktopTools: false,
    hearthObserveEnabled: false,
    crossSessionEnabled: true,
    antiAnchoring: { enabled: true, blindExploration: true, mctsPlanning: true, branches: 2, planningTurn: 1, projectionThreshold: 0.4, seedMaxTokens: 256, anchorBreakScout: { enabled: false, complexityThreshold: 0.5, minTurn: 3, scoutBudgetMs: 60_000, scoutMaxTokens: 2048 } },
    toolGating: { enabled: true, extraCore: [] },
    autoDelegateEnabled: false,
    maxDelegationDepth: 2,
    maxTeamParallel: 3,
    council: { seats: [] },
    checkpointEveryTurns: 25,
    intentRetrievalRouter: { enabled: true, classifier: 'heuristic', timeoutMs: 100, maxTokens: 128, temperature: 0 },
    llmSpeculation: { enabled: false, maxPerTurn: 3, maxTokens: 320, timeoutMs: 8_000, minProbability: 0.5, slowToolsOnly: true },
    teamSchedulerBanditEnabled: false,
    modelTierBanditEnabled: false,
    modelRoutingGatedEnabled: false,
    banditPromotion: { modelTier: 'shadow', teamScheduler: 'shadow', modelRouting: 'shadow', effort: 'shadow', killSwitch: false },
    permissions: { allow: [], deny: [], bash: { allowlist: [], denylist: [] }, additionalReadDirs: [], additionalWriteDirs: [] },
    review: { profiles: {}, skipAuto: false, skipAutoSpark: false, mechanicalFastPath: true },
    visionAutoBridge: false,
    goal: { judge: { enabled: true, maxRuns: 3, browser: false } },
    delivery: { autoCommit: true },
  },
  compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash', qualityCompact: { perTokenThreshold: 0.55, subscriptionThreshold: 0.45, subscriptionCeiling: 0.6 } },
  runtime: { lean: false },
} satisfies Pick<Config, 'agent' | 'compact' | 'runtime'>

describe('createAgentConfig', () => {
  const baseInput: AgentConfigInput = {
    apiKey: 'test-key',
    model: { id: 'deepseek-r1', maxTokens: 8192, contextWindow: 128000, reasoningEffort: undefined },
    cwd: '/tmp/test',
    compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash', qualityCompact: { perTokenThreshold: 0.55, subscriptionThreshold: 0.45, subscriptionCeiling: 0.6 } },
    sessionId: 'session-1',
    toolDefinitions: [],
    provider: testProvider,
  }

  it('creates client with correct model params', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.client)
    assert.ok(cfg.promptEngine)
    assert.equal(cfg.contextWindow, 128000)
    assert.equal(cfg.sessionId, 'session-1')
    assert.equal(cfg.providerProfile?.cacheType, 'exact-prefix')
    assert.equal(cfg.providerProfile?.contextWindow, 128000)
  })

  it('resolves a model-aware compactionProfile (task 5 assembly wiring)', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.compactionProfile)
    assert.equal(cfg.compactionProfile.billing, 'per-token')
    assert.equal(cfg.compactionProfile.cache, 'exact-prefix')
    assert.equal(cfg.compactionProfile.contextWindow, 128000)

    const withPricing = createAgentConfig({
      ...baseInput,
      provider: {
        ...testProvider,
        models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192, pricing: { cacheRead: 0.028, cacheWrite: 0.28 } }],
      },
    })
    assert.equal(withPricing.compactionProfile?.cacheReadPricePerMillion, 0.028)
    assert.equal(withPricing.compactionProfile?.cacheWritePricePerMillion, 0.28)
  })

  it('returns primaryClient as the main model client', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.primaryClient)
    // primaryClient is the same StreamClient used for main model calls
  })

  it('applies thinkingBudget based on reasoningEffort', () => {
    const maxCfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, reasoningEffort: 'max' },
    })
    assert.ok(maxCfg.client)
    // Non-max uses Math.min(16000, floor(contextWindow * 0.02))
    const normalCfg = createAgentConfig(baseInput)
    assert.ok(normalCfg.client)
  })

  it('passes approvalMode through', () => {
    const cfg = createAgentConfig({ ...baseInput, approvalMode: 'dangerously-skip-permissions' })
    assert.equal(cfg.approvalMode, 'dangerously-skip-permissions')
  })

  it('defaults autoReasoning to true', () => {
    const cfg = createAgentConfig(baseInput)
    assert.equal(cfg.autoReasoning, true)
  })

  it('uses configured model reasoningEffort as the auto-reasoning floor', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, reasoningEffort: 'high' },
    })
    assert.equal(cfg.reasoningFloor, 'high')
  })

  it('passes songlineEnabled through when explicitly enabled', () => {
    const cfg = createAgentConfig({ ...baseInput, songlineEnabled: true })

    assert.equal(cfg.songlineEnabled, true)
  })

  it('builds main AgentConfig input from layered config including songlineEnabled', () => {
    const input = createMainAgentConfigInput({
      apiKey: 'test-key',
      model: baseInput.model,
      cwd: '/tmp/test',
      config: testConfig,
      sessionId: 'session-1',
      toolDefinitions: [],
      provider: testProvider,
      sessionMemoryBlock: 'memory block text',
    })

    assert.equal(input.compact, testConfig.compact)
    assert.equal(input.approvalMode, 'manual')
    assert.equal(input.songlineEnabled, true)
    assert.equal(input.antiAnchoring?.enabled, true)
    assert.equal(input.antiAnchoring?.branches, 2)
    const inputRouter = normalizeIntentRetrievalRouterConfig(input.intentRetrievalRouter)
    assert.equal(inputRouter.enabled, true)
    assert.equal(inputRouter.classifier, 'heuristic')

    const cfg = createAgentConfig(input)
    const cfgRouter = normalizeIntentRetrievalRouterConfig(cfg.intentRetrievalRouter)
    assert.equal(cfg.songlineEnabled, true)
    assert.equal(cfg.antiAnchoring?.enabled, true)
    assert.equal(cfgRouter.enabled, true)
  })

  it('passes sessionMemoryBlock to promptEngine', () => {
    const cfg = createAgentConfig({ ...baseInput, sessionMemoryBlock: 'memory block text' })
    assert.ok(cfg.promptEngine)
  })

  // 视觉桥接接线回归：createMainAgentConfigInput 曾长期漏传 config.agent.visionModel，
  // 导致 buildVisionClient 恒返回 undefined、桥接从不触发（"配了却报图片未发送"）。
  // 这两条测试钉住 config → input → visionClient 这条线。
  it('wires config.agent.visionModel through createMainAgentConfigInput', () => {
    const input = createMainAgentConfigInput({
      apiKey: 'test-key',
      model: baseInput.model,
      cwd: '/tmp/test',
      config: {
        ...testConfig,
        agent: { ...testConfig.agent, visionModel: { provider: 'vprov', model: 'v-cap', maxTokens: 1024 } },
      } as Pick<Config, 'agent' | 'compact' | 'runtime'>,
      sessionId: 'session-1',
      toolDefinitions: [],
      provider: testProvider,
    })
    assert.deepEqual(input.visionModel, { provider: 'vprov', model: 'v-cap', maxTokens: 1024 })
  })

  it('builds a visionClient when a text-only primary has a configured vision bridge', () => {
    const visionProvider: ProviderConfig = {
      ...testProvider,
      name: 'vprov',
      apiKey: 'vision-key',
      models: [{ id: 'v-cap', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      // primary model is text-only (no supportsVision)
      allProviders: { deepseek: testProvider, vprov: visionProvider },
      visionModel: { provider: 'vprov', model: 'v-cap', maxTokens: 1024 },
    })
    assert.equal(cfg.supportsVision, false)
    assert.ok(cfg.visionClient, 'visionClient must be built from the configured bridge')
    assert.equal(cfg.visionModelMaxTokens, 1024)
    assert.equal(cfg.visionBridge?.source, 'configured')
    assert.equal(cfg.visionBridge?.active, true)
  })

  it('clamps the vision bridge reasoning effort to low — 推理档视觉模型按配置档推理会烧光 maxTokens 预算返回空描述', () => {
    // deepseek-flash 类推理视觉模型（spec.reasoningEffort='medium'）在 OCR 结构化
    // prompt 下 reasoning 达 1700+ 字符，1024 maxTokens 被推理吃光、finish=length、
    // content 为零（「配 4.1-flash 也不行」根因）。桥客户端必须压到 'low'。
    const reasoningVision: ProviderConfig = {
      ...testProvider,
      name: 'vprov',
      apiKey: 'vision-key',
      models: [{ id: 'v-cap', contextWindow: 128000, maxTokens: 8192, supportsVision: true, reasoningEffort: 'medium' }],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: testProvider, vprov: reasoningVision },
      visionModel: { provider: 'vprov', model: 'v-cap', maxTokens: 1024 },
    })
    assert.ok(cfg.visionClient)
    assert.equal((cfg.visionClient as unknown as { config: { reasoningEffort?: string } }).config.reasoningEffort, 'low')

    // 非推理模型（未设 reasoningEffort）不受影响——客户端拿到 undefined，行为不变。
    const plainVision: ProviderConfig = {
      ...testProvider,
      name: 'vprov2',
      apiKey: 'vision-key',
      models: [{ id: 'v-plain', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const cfg2 = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: testProvider, vprov2: plainVision },
      visionModel: { provider: 'vprov2', model: 'v-plain', maxTokens: 1024 },
    })
    assert.ok(cfg2.visionClient)
    assert.equal((cfg2.visionClient as unknown as { config: { reasoningEffort?: string } }).config.reasoningEffort, undefined)
  })

  it('wraps primary+backup vision models when a fallback is configured', () => {
    const vprov: ProviderConfig = {
      ...testProvider, name: 'vprov', apiKey: 'k1',
      models: [{ id: 'v-cap', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const vprov2: ProviderConfig = {
      ...testProvider, name: 'vprov2', apiKey: 'k2',
      models: [{ id: 'v-cap2', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: testProvider, vprov, vprov2 },
      visionModel: { provider: 'vprov', model: 'v-cap', maxTokens: 1024, fallback: { provider: 'vprov2', model: 'v-cap2' } },
    })
    assert.ok(cfg.visionClient, 'dual bridge still yields a client')
    assert.match(cfg.visionBridge?.detail ?? '', /vprov2\/v-cap2/, 'detail names the backup bridge')
  })

  // 自动选桥是 opt-in（2026-07-30 评审）：它会把用户的图片发给一个用户从未为此
  // 选择过的 provider——成本与隐私决定不能由默认值代做。关着时只点名候选。
  const minimaxProvider: ProviderConfig = {
    ...testProvider, name: 'minimax', apiKey: 'k',
    models: [{ id: 'MiniMax-M3', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
  }

  it('does NOT auto-select a vision bridge without the opt-in', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: testProvider, minimax: minimaxProvider },
      // no visionModel, no visionAutoBridge
    })
    assert.equal(cfg.visionClient, undefined, '默认不得静默把图片发给未选中的 provider')
    assert.equal(cfg.visionBridge?.active, false)
    assert.match(cfg.visionBridge?.detail ?? '', /minimax\/MiniMax-M3/, '候选必须被点名')
    assert.match(cfg.visionBridge?.detail ?? '', /visionAutoBridge/, '必须告诉用户怎么启用')
  })

  // 同 provider 自动挂载（2026-09-12）：用户的主模型每轮都在向该 provider 发送完整
  // 对话，图片发给同一方不引入新的数据流向或计费主体——跨 provider 自动桥的隐私顾虑
  // 在这个窄条件下不成立，故默认允许。跨 provider 仍严格 opt-in（上一条用例守这条界）。
  it('auto-mounts a same-provider vision bridge without the opt-in', () => {
    const sameProviderVision: ProviderConfig = {
      ...testProvider,
      apiKey: 'k',
      models: [
        { id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 },
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 384_000, supportsVision: true },
      ],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: sameProviderVision },
      // 关键：不配 visionModel，也不开 visionAutoBridge
    })
    assert.ok(cfg.visionClient, '同 provider 有视觉档时应自动建桥')
    assert.equal(cfg.visionBridge?.active, true)
    assert.equal(cfg.visionBridge?.source, 'same-provider', '必须与跨 provider 的 auto 可区分')
    assert.match(cfg.visionBridge?.detail ?? '', /deepseek\/deepseek-flash/)
  })

  it('prefers a same-provider vision model over a third-party one', () => {
    const sameProviderVision: ProviderConfig = {
      ...testProvider,
      apiKey: 'k',
      models: [
        { id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 },
        { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 384_000, supportsVision: true },
      ],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: sameProviderVision, minimax: minimaxProvider },
    })
    assert.ok(cfg.visionClient, '同 provider 有候选时应建桥，而不是退而用第三方')
    assert.match(cfg.visionBridge?.detail ?? '', /deepseek\/deepseek-flash/, '选中的必须是同 provider 档')
  })

  it('auto-selects a vision bridge once visionAutoBridge is on', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: testProvider, minimax: minimaxProvider },
      visionAutoBridge: true,
    })
    assert.ok(cfg.visionClient, 'opt-in 后自动选桥应建出 client')
    assert.equal(cfg.visionBridge?.source, 'auto')
  })

  it('names no candidate when nothing declares vision support', () => {
    const cfg = createAgentConfig({ ...baseInput, allProviders: { deepseek: testProvider } })
    assert.equal(cfg.visionClient, undefined)
    assert.match(cfg.visionBridge?.detail ?? '', /没有声明视觉能力的模型/)
  })

  it('infers compact provider so default flash model builds a dedicated client', async () => {
    const { resolveCompactProviderName } = await import('../agent/create-agent-config.js')
    const deepseekWithFlash: ProviderConfig = {
      ...testProvider,
      models: [
        { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000 },
        { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000 },
      ],
    }
    assert.equal(
      resolveCompactProviderName({
        compact: { model: 'deepseek-v4-flash' },
        provider: deepseekWithFlash,
        allProviders: { deepseek: deepseekWithFlash },
      }),
      'deepseek',
    )
    assert.equal(
      resolveCompactProviderName({
        compact: { model: 'deepseek-v4-flash', provider: 'deepseek' },
        provider: deepseekWithFlash,
      }),
      'deepseek',
    )
    assert.equal(
      resolveCompactProviderName({
        compact: { model: 'missing-model' },
        provider: deepseekWithFlash,
      }),
      undefined,
    )
  })

  // 主控自己能看图时不建桥：建了也永不使用（loop.ts 桥接点要求 !supportsVision），
  // 只会白建一个 client 并在启动时报一行不实的「已启用识图桥」。
  it('skips the bridge entirely when the primary model is multimodal', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, supportsVision: true },
      allProviders: { deepseek: testProvider, minimax: minimaxProvider },
      visionAutoBridge: true,
    })
    assert.equal(cfg.supportsVision, true)
    assert.equal(cfg.visionClient, undefined, '多模态主控不该白建桥 client')
    assert.equal(cfg.visionBridge?.active, true)
    // source 是 UI 选文案的依据：前端只认 'native' 判「原生支持」，其余一律渲染
    // 「识图桥已生效」。原生走 'none' 会让用户看到一句不实的状态（2026-09-12 核实）。
    assert.equal(cfg.visionBridge?.source, 'native', '原生支持必须与桥接生效可区分')
    assert.match(cfg.visionBridge?.detail ?? '', /原生支持识图/)
  })
})
