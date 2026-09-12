import { createProviderClient, resolveApiKey } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { createAuthProvider } from '../auth/registry.js'
import { PromptEngine } from '../prompt/engine.js'
import type { FrozenSnapshotData } from '../prompt/frozen-snapshot.js'
import { detectModelFamily } from '../prompt/static.js'
import { createVolatileSnapshot } from '../prompt/volatile-snapshot.js'
import { resolvePromptBlocks, invalidatePromptBlocks } from '../prompt/block-policy.js'
import { FallbackStreamClient } from '../api/fallback-client.js'
import type { AgentConfig } from './loop-types.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolDefinition } from '../api/types.js'
import type { ProviderConfig, Config, ModelConfig, ProviderCapabilitiesConfig } from '../config/schema.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { IntentRetrievalRouterConfigInput } from './intent-retrieval-router.js'
import type { LlmSpeculationConfigInput } from './llm-speculation.js'
import type { AuthProvider } from '../auth/types.js'
import type { PermissionConfig } from './permissions.js'
import { getProviderProfile } from '../api/provider-profile.js'
import { resolveCompactionEconomics } from '../compact/compaction-profile.js'
import { gateToolDefinitions } from './tool-tiers.js'
import { applyDescriptionMode } from '../tools/description-compact.js'
import { inferModelTierFromName, type ModelTier } from './model-tier-policy.js'
import { isRuntimeLeanForDomain } from '../config/runtime-lean.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'

export interface ModelSpec {
  id: string
  maxTokens: number
  contextWindow: number
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  /** Model accepts image inputs (multimodal user messages). Gates the
   *  tool-boundary vision channel (computer_use screenshots). */
  supportsVision?: boolean
  /** Per-model capability overrides (e.g. Qwen3-max supports thinking, Qwen-plus does not). */
  capabilities?: ProviderCapabilitiesConfig
}

export interface AgentConfigInput {
  apiKey: string
  model: ModelSpec
  cwd: string
  compact: CompactionConfig
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  /** All configured providers — needed for resolving fallback chain. */
  allProviders?: Record<string, ProviderConfig>
  sessionMemoryBlock?: string
  approvalMode?: 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'
  songlineEnabled?: boolean
  constellationEnabled?: boolean
  companionPresenceEnabled?: boolean
  dreamEnabled?: boolean
  runtimeLean?: boolean
  securityGuidance?: boolean
  hearthObserveEnabled?: boolean
  antiAnchoring?: AntiAnchoringConfig
  intentRetrievalRouter?: IntentRetrievalRouterConfigInput
  llmSpeculation?: LlmSpeculationConfigInput
  autoDelegateEnabled?: boolean
  autoReasoning?: boolean
  crossSessionEnabled?: boolean
  /** Session Auto keyword routing; default true（auto 池内匹配，未命中回退天权）. */
  domainKeywordRouting?: boolean
  /** 默认星域（qiming | … | auto）。未作会话选择时非 auto 默认首次钉定；
   * 默认或会话选择为 Auto 时走关键词路由。 */
  defaultDomain?: string
  goalJudge?: { enabled?: boolean; maxRuns?: number; browser?: boolean }
  auth?: AuthProvider
  habituationThreshold?: number
  /** Optional permission config — allowlists, bash command prefixes, etc. */
  permissions?: PermissionConfig
  /** 主控工具门控。缺省 undefined → 全量（不门控）。 */
  toolGating?: {
    enabled: boolean
    coreOverride?: readonly string[]
    extraCore?: readonly string[]
    domainTier?: readonly string[]
    disabledTools?: readonly string[]
  }
  /** Optional vision bridge configuration (parsed from config.agent.visionModel). */
  visionModel?: {
    provider: string
    model: string
    prompt?: string
    maxTokens: number
    /** Optional backup vision model — failover when the primary errors. */
    fallback?: { provider: string; model: string }
  }
  /** Opt-in (config.agent.visionAutoBridge): allow auto-picking a vision bridge
   *  when `visionModel` is unset. Off ⇒ a candidate is only named, never used. */
  visionAutoBridge?: boolean
  /** /cd: previous PromptEngine whose frozen snapshots the new one inherits.
   *  resume 场景传盘存 FrozenSnapshotData（<id>.frozen.json），同语义。 */
  inheritFrozenFrom?: PromptEngine | FrozenSnapshotData
  /** 资源压力状态行回调（见 AgentConfig.onStatusLine）。 */
  onStatusLine?: (text: string | null) => void
  /** Per-session 工具白名单（蒸馏回放等自动化场景）。 */
  allowedTools?: string[]
  /** 会话冻结的 wire 变换上下文（spark truncate N 等）。由会话装配层
   *  （bootstrap.createAgentRuntime）从 meta 读回或按注册默认冻结后传入；
   *  流向 client（wire 截断）与锚点提取两个消费点，保证同一会话 N 恒定。 */
  wireContext?: import('../api/pro-registry.js').WireTransformContext
  /** CLI 侧 meridian 接线（2026-09-06）：serve 路径早已接线，CLI tool-pipeline 的
   *  meridianIndexer 恒 undefined → 写工具收尾走 importGraph fallback（每会话首个
   *  写工具全量扫仓 ~750ms/5k 文件）。透传后走持久 SQLite 增量图。 */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
}

export interface MainAgentConfigInputParams {
  apiKey: string
  model: ModelSpec
  cwd: string
  config: Pick<Config, 'agent' | 'compact' | 'runtime'>
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  allProviders?: Record<string, ProviderConfig>
  sessionMemoryBlock?: string
  auth?: AuthProvider
  habituationThreshold?: number
  permissions?: PermissionConfig
  /** /cd: previous PromptEngine whose frozen snapshots the new one inherits.
   *  resume 场景传盘存 FrozenSnapshotData（<id>.frozen.json），同语义。 */
  inheritFrozenFrom?: PromptEngine | FrozenSnapshotData
  /** 资源压力状态行回调（见 AgentConfig.onStatusLine）。 */
  onStatusLine?: (text: string | null) => void
  /** Per-session 工具白名单（蒸馏回放等自动化场景）。 */
  allowedTools?: string[]
  /** 会话冻结的 wire 变换上下文（见 AgentConfigInput.wireContext）。 */
  wireContext?: import('../api/pro-registry.js').WireTransformContext
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
}

export function createMainAgentConfigInput(params: MainAgentConfigInputParams): AgentConfigInput {
  return {
    apiKey: params.apiKey,
    model: params.model,
    cwd: params.cwd,
    compact: params.config.compact,
    sessionId: params.sessionId,
    toolDefinitions: params.toolDefinitions,
    provider: params.provider,
    allProviders: params.allProviders,
    sessionMemoryBlock: params.sessionMemoryBlock,
    approvalMode: params.config.agent.approval as 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions',
    songlineEnabled: params.config.agent.songlineEnabled,
    constellationEnabled: params.config.agent.constellationEnabled,
    companionPresenceEnabled: params.config.agent.companionPresenceEnabled,
    dreamEnabled: params.config.agent.dreamEnabled,
    // 域级 lean 覆盖：defaultDomain 钉定某域且 runtime.domains[域].lean 配置时
    // 用域值（如 taiyi 域默认 lean）；env 主开关恒优先。auto 域回退全局。
    runtimeLean: isRuntimeLeanForDomain(params.config.agent.defaultDomain, params.config.runtime, params.cwd),
    securityGuidance: params.config.agent.securityGuidance,
    hearthObserveEnabled: params.config.agent.hearthObserveEnabled,
    crossSessionEnabled: params.config.agent.crossSessionEnabled,
    antiAnchoring: params.config.agent.antiAnchoring,
    intentRetrievalRouter: params.config.agent.intentRetrievalRouter,
    llmSpeculation: params.config.agent.llmSpeculation,
    autoDelegateEnabled: params.config.agent.autoDelegateEnabled,
    autoReasoning: params.config.agent.autoReasoning,
    domainKeywordRouting: params.config.agent.domainKeywordRouting,
    defaultDomain: params.config.agent.defaultDomain,
    goalJudge: params.config.agent.goal?.judge,
    // 视觉桥接配置：这条线曾长期断裂（builder 从不透传 → buildVisionClient 恒返回
    // undefined → 桥接从不触发 → "配了却报图片未发送"）。visionModel 必须从 config
    // 流到 input，桥接才建得起来。见 buildVisionClient / loop.ts 桥接点。
    visionModel: params.config.agent.visionModel,
    visionAutoBridge: params.config.agent.visionAutoBridge,
    auth: params.auth,
    habituationThreshold: params.habituationThreshold,
    permissions: params.config.agent.permissions as PermissionConfig,
    inheritFrozenFrom: params.inheritFrozenFrom,
    onStatusLine: params.onStatusLine,
    allowedTools: params.allowedTools,
    wireContext: params.wireContext,
    meridianIndexer: params.meridianIndexer,
    toolGating: params.config.agent.toolGating
      ? {
          enabled: params.config.agent.toolGating.enabled,
          // Per-session 白名单（蒸馏回放）优先于 config coreOverride——让 LLM
          // 只看到白名单工具，收窄自动化任务的能力边界。
          coreOverride: params.allowedTools ?? params.config.agent.toolGating.coreTools,
          extraCore: params.config.agent.toolGating.extraCore,
          disabledTools: params.config.agent.toolGating.disabledTools,
        }
      : params.allowedTools
        ? { enabled: true, coreOverride: params.allowedTools }
        : undefined,
 }
}

export function createAgentConfig(input: AgentConfigInput): Pick<
  AgentConfig,
  'client' | 'promptEngine' | 'contextWindow' | 'compact' | 'cwd' | 'blockPolicy' | 'providerProfile' | 'providerName' | 'compactionProfile' | 'primaryClient' | 'compactClient' | 'sessionId' | 'approvalMode' | 'autoReasoning' | 'reasoningFloor' | 'turnLevelThinking' | 'songlineEnabled' | 'constellationEnabled' | 'companionPresenceEnabled' | 'dreamEnabled' | 'runtimeLean' | 'securityGuidance' | 'hearthObserveEnabled' | 'crossSessionEnabled' | 'antiAnchoring' | 'intentRetrievalRouter' | 'llmSpeculation' | 'autoDelegateEnabled' | 'domainKeywordRouting' | 'defaultDomain' | 'goalJudge' | 'allProviders' | 'permissions' | 'toolGating' | 'prefixCacheStrategy' | 'supportsVision' | 'visionClient' | 'visionModelPrompt' | 'visionModelMaxTokens' | 'visionBridge' | 'onStatusLine' | 'wireContext' | 'meridianIndexer'
> {
  const { model, apiKey, cwd, provider } = input
  const capabilities = resolveCapabilities(provider.name, provider.capabilities, model.capabilities)
  const thinkingBudget = model.reasoningEffort === 'max'
    ? 64000
    : Math.min(16000, Math.floor(model.contextWindow * 0.02))

  const primaryClient = createProviderClient(provider, capabilities, {
    apiKey,
    model: model.id,
    reasoningEffort: model.reasoningEffort,
    maxTokens: model.maxTokens,
    thinkingBudget,
    auth: input.auth,
    sessionId: input.sessionId,
    wireContext: input.wireContext,
  })

  const client = buildFallbackChain(primaryClient, provider, model, input)

  // Optional dedicated compaction client (compact.provider + compact.model).
  // Routes summarization to a cheap model on its own server-side cache so it
  // neither spends the main model's tokens nor evicts its hot prefix. Silent
  // fallback to primaryClient when unconfigured/invalid (mirrors review/council).
  const compactClient = buildCompactClient(input)

  // Optional vision bridge client (agent.visionModel.provider + model).
  // When the primary model is not multimodal, this client describes user images
  // so the primary model still receives their content as text. 主模型自己就能看图
  // 时不建桥——建了也永不使用（loop.ts 的桥接点要求 !supportsVision），只会白建一个
  // client 并在启动时报一行不实的「已启用识图桥」。
  const primarySupportsVision = model.supportsVision ?? false
  const visionBridge = primarySupportsVision ? undefined : buildVisionClient(input)

  const modelPricing = provider.models.find(m => m.id === model.id || m.alias === model.id)?.pricing

  // 复盘修复（2026-07-25）：每次创建 agent 前丢弃进程级 memo——长驻 sidecar
  // 同进程多会话时，改完配置开新会话必须吃到新档位（文档承诺）。活会话不受
  // 影响：解析结果快照进 AgentConfig.blockPolicy，loop 内消费点只读快照。
  invalidatePromptBlocks()
  const blockPolicy = resolvePromptBlocks(cwd)

  // 工具门控：构造期与 updateTools() 共用同一过滤（gateToolDefinitions），
  // 确保 MCP/LSP 异步注册后调用 updateTools 不会把 EXTENDED 工具整个还原。
  // 描述档位也走同一入口——两处不一致会让描述回弹、翻转前缀字节。
  const gatedTools = input.toolGating
    ? gateToolDefinitions(input.toolDefinitions, {
        enabled: input.toolGating.enabled,
        coreOverride: input.toolGating.coreOverride,
        extraCore: input.toolGating.extraCore,
        domainTier: input.toolGating.domainTier,
        disabledTools: input.toolGating.disabledTools,
        toolDescriptions: blockPolicy.toolDescriptions,
      })
    : applyDescriptionMode(input.toolDefinitions, blockPolicy.toolDescriptions)

  const promptEngine = new PromptEngine({
    model: model.id,
    maxTokens: model.maxTokens,
    staticCtx: { tools: gatedTools, modelFamily: detectModelFamily(model.id) },
    approvalMode: input.approvalMode,
    volatileCtx: createVolatileSnapshot({
      cwd,
      sessionMemoryBlock: input.sessionMemoryBlock,
      // 会话启动期解析一次并冻结——中途改配置不生效（改前缀 = 全量重建）。
      blockPolicy,
   }),
    habituationThreshold: input.habituationThreshold ?? 5,
    prefixCache: capabilities.prefixCacheStrategy,
    appendixDelta: process.env['RIVET_APPENDIX_DELTA'] !== '0',
    inheritFrozenFrom: input.inheritFrozenFrom,
 })

  return {
    client,
    promptEngine,
    contextWindow: model.contextWindow,
    compact: input.compact,
    cwd: input.cwd,
    blockPolicy,
    providerProfile: getProviderProfile(provider.name, model.contextWindow),
    providerName: provider.name,
    wireContext: input.wireContext,
    // CLI meridian 接线（2026-09-06）：透传持久 SQLite 增量图——消除写工具收尾
    // importGraph fallback 每会话全量扫仓（~750ms/5k 文件）。
    meridianIndexer: input.meridianIndexer ?? null,
    // Model-aware compaction economics: billing from provider identity
    // (oauth/baseUrl hints for custom providers), cache kind from the provider
    // profile with the aggregator escape hatch (deepseek-native capability +
    // known model family), pricing from the model's config entry.
    compactionProfile: resolveCompactionEconomics({
      providerName: provider.name,
      modelId: model.id,
      contextWindow: model.contextWindow,
      ...(provider.auth?.type !== undefined ? { authType: provider.auth.type } : {}),
      baseUrl: provider.baseUrl,
      prefixCacheStrategy: capabilities.prefixCacheStrategy,
      ...(modelPricing ? { pricing: modelPricing } : {}),
    }),
    primaryClient: primaryClient,
    compactClient,
    sessionId: input.sessionId,
    approvalMode: input.approvalMode,
    songlineEnabled: input.songlineEnabled,
    constellationEnabled: input.constellationEnabled,
    companionPresenceEnabled: input.companionPresenceEnabled,
    dreamEnabled: input.dreamEnabled,
    runtimeLean: input.runtimeLean,
    securityGuidance: input.securityGuidance,
    hearthObserveEnabled: input.hearthObserveEnabled,
    crossSessionEnabled: input.crossSessionEnabled,
    antiAnchoring: input.antiAnchoring,
    intentRetrievalRouter: input.intentRetrievalRouter,
    llmSpeculation: input.llmSpeculation,
    autoDelegateEnabled: input.autoDelegateEnabled,
    domainKeywordRouting: input.domainKeywordRouting ?? true,
    defaultDomain: input.defaultDomain ?? 'qiming',
    goalJudge: input.goalJudge,
    allProviders: input.allProviders,
    autoReasoning: input.autoReasoning ?? true,
    reasoningFloor: model.reasoningEffort,
    // GLM turn-level thinking: disable thinking on tool execution turns
    // to prevent reasoning_content accumulation and context window stalls.
    turnLevelThinking: provider.name === 'glm',
    permissions: input.permissions,
    toolGating: input.toolGating,
    prefixCacheStrategy: capabilities.prefixCacheStrategy,
    // Per-model vision capability — switchModel rebuilds the agent, so this
    // value always tracks the active model (no live getter needed).
    supportsVision: model.supportsVision ?? false,
    visionClient: visionBridge?.client,
    visionModelPrompt: visionBridge?.prompt,
    visionModelMaxTokens: visionBridge?.maxTokens,
    visionBridge: deriveVisionBridgeStatus(model.supportsVision ?? false, visionBridge, input),
    onStatusLine: input.onStatusLine,
 }
}

/** 派生识图桥真实状态供 UI 显示——不再让 UI 只凭 config 有没有 visionModel 键去猜。 */
function deriveVisionBridgeStatus(
  primarySupportsVision: boolean,
  bridge: VisionBridgeBuild | undefined,
  input: AgentConfigInput,
): AgentConfig['visionBridge'] {
  if (primarySupportsVision) {
    // source 必须与「桥接生效」可区分：桌面端只把 'native' 渲染成「原生支持」，
    // 其余 active 状态一律显示「识图桥已生效」——沿用 'none' 会让用户看到一句
    // 不实的状态（配了视觉主模型却被告知桥在工作）。2026-09-12 核实。
    return { active: true, source: 'native', detail: '主模型原生支持识图，无需桥接' }
  }
  if (bridge) {
    return {
      active: true,
      source: bridge.source,
      detail: bridge.source === 'auto'
        ? `自动选用 ${bridge.ref}`
        : bridge.source === 'same-provider'
          ? `与主模型同一 provider，自动启用 ${bridge.ref}`
          : bridge.ref,
    }
  }
  if (input.visionModel) {
    return {
      active: false,
      source: 'none',
      detail: `已配置 ${input.visionModel.provider}/${input.visionModel.model} 但桥接起不来（缺 key/模型不存在）`,
    }
  }
  // 未配置：如果仓里确实有声明视觉能力的模型，点名它并告诉用户怎么启用——不替
  // 用户决定把图片发出去（自动桥是 opt-in，见 agent.visionAutoBridge）。
  const candidate = firstVisionCandidateRef(input)
  const detail = candidate
    ? input.visionAutoBridge
      ? `未配置 agent.visionModel，自动选桥已开但 ${candidate} 等候选都起不来（缺 key/未登录）`
      : `未配置 agent.visionModel；检测到可用视觉模型 ${candidate}，在 /config → 识图模型 选定它，`
        + '或设 agent.visionAutoBridge=true 让它自动选（会把图片发给该 provider）'
    : '未配置 agent.visionModel，且没有声明视觉能力的模型可用'
  return { active: false, source: 'none', detail }
}

/** 第一个声明了视觉能力的模型（仅看声明，不试凭据）——给未启用时的提示点名用。 */
function firstVisionCandidateRef(input: AgentConfigInput): string | undefined {
  for (const prov of visionCandidates(input)) return `${prov.prov.name}/${prov.spec.id}`
  return undefined
}

export function resolveFallbackModel(fp: ProviderConfig): ModelConfig {
  const tierOf = (m: ModelConfig): ModelTier => {
    if (m.tier) return m.tier
    return inferModelTierFromName(m.id) ?? 'balanced'
  }

  const preferred = fp.fallbackModel
    ? fp.models.find(m => m.id === fp.fallbackModel || m.alias === fp.fallbackModel)
    : undefined

  const allowProFallback = fp.allowProFallback ?? false

  // 1. preferred is cheap → use it
  if (preferred && tierOf(preferred) === 'cheap') return preferred

  // 2. preferred is strong and pro fallback explicitly allowed → use it
  if (preferred && tierOf(preferred) === 'strong' && allowProFallback) return preferred

  // 3. preferred is strong but pro fallback forbidden → downgrade to cheap
  if (preferred && tierOf(preferred) === 'strong' && !allowProFallback) {
    const cheap = fp.models.find(m => tierOf(m) === 'cheap')
    if (cheap) {
      console.warn(`[fallback] ${preferred.id} is strong tier and allowProFallback=false; downgrading to ${cheap.id}`)
      return cheap
    }
  }

  // 4. no preferred or not allowed → prefer cheap, then balanced, then strong
  const candidates = [
    ...fp.models.filter(m => tierOf(m) === 'cheap'),
    ...fp.models.filter(m => tierOf(m) === 'balanced'),
    ...(!allowProFallback ? [] : fp.models.filter(m => tierOf(m) === 'strong')),
  ]
  if (candidates.length > 0) return candidates[0]!

  // 5. legacy fallback: if pro is forbidden and no cheap/balanced exists, still
  //    need a model to avoid breaking the chain — fall back to the first model.
  return fp.models[0]!
}

function buildFallbackChain(
  primary: import('../api/stream-client.js').StreamClient,
  provider: ProviderConfig,
  model: ModelSpec,
  input: AgentConfigInput,
): import('../api/stream-client.js').StreamClient {
  const fallbackNames = provider.fallback
  if (!fallbackNames?.length || !input.allProviders) return primary

  const entries = fallbackNames
    .filter(name => name !== provider.name && input.allProviders![name])
    .map(name => ({
      name,
      create: () => {
        const fp = input.allProviders![name]!
        // Resolve a fallback model that is safe by default: cheap tier only,
        // unless the user explicitly opts in via allowProFallback.
        const fModel = resolveFallbackModel(fp)
        const fCaps = resolveCapabilities(fp.name, fp.capabilities, fModel.capabilities)
        // Resolve fallback API key — fail loudly instead of silently returning
        // primary so the user knows their fallback provider is misconfigured.
        let fApiKey: string
        try {
          fApiKey = resolveApiKey(fp)
        } catch {
          throw new Error(
            `Fallback provider "${name}" has no API key configured. ` +
            `Set ${fp.apiKeyEnv ?? `<PROVIDER>_API_KEY`} env var or inline apiKey in config.`
          )
        }
        return createProviderClient(fp, fCaps, {
          apiKey: fApiKey,
          model: fModel.id,
          maxTokens: fModel.maxTokens,
          reasoningEffort: model.reasoningEffort,
          sessionId: input.sessionId,
        })
      },
    }))

  if (entries.length === 0) return primary
  return new FallbackStreamClient(primary, provider.name, entries)
}

/**
 * Resolve which provider hosts the compact model.
 * When `compact.provider` is unset, infer from the primary provider or
 * allProviders so the schema default `model: deepseek-v4-flash` actually
 * builds a cheap dedicated client (previously inert without provider).
 */
export function resolveCompactProviderName(input: {
  compact: { provider?: string; model?: string }
  provider: ProviderConfig
  allProviders?: Record<string, ProviderConfig>
}): string | undefined {
  if (input.compact.provider) return input.compact.provider
  const model = input.compact.model
  if (!model) return undefined
  const hasModel = (prov: ProviderConfig) =>
    prov.models.some(m => m.id === model || m.alias === model)
  if (hasModel(input.provider)) return input.provider.name
  for (const [name, prov] of Object.entries(input.allProviders ?? {})) {
    if (hasModel(prov)) return name
  }
  return undefined
}

/**
 * Build the dedicated compaction StreamClient from compact.provider+model.
 * Returns undefined (→ caller falls back to primaryClient) when:
 *  - model not set, or no resolvable provider
 *  - provider unknown, or model not in its model list
 *  - credentials missing (apiKey empty / oauth not authenticated)
 * This matches the silent-fallback contract of review/council routing: a
 * misconfigured compact route degrades to the primary model, never errors.
 */
function buildCompactClient(
  input: AgentConfigInput,
): import('../api/stream-client.js').StreamClient | undefined {
  const compactModel = input.compact.model
  const compactProvider = resolveCompactProviderName(input)
  if (!compactProvider || !compactModel) return undefined
  const prov = input.allProviders?.[compactProvider] ?? (
    input.provider.name === compactProvider ? input.provider : undefined
  )
  if (!prov) return undefined
  const spec = prov.models.find(m => m.id === compactModel || m.alias === compactModel)
  if (!spec) return undefined

  let apiKey = ''
  let auth: AuthProvider | undefined
  try {
    if (prov.auth?.type === 'oauth') {
      auth = prov.name === input.provider.name ? input.auth : createAuthProvider(prov.auth, process.env)
      if (!auth?.isAuthenticated()) return undefined
    } else {
      apiKey = resolveApiKey(prov)
      if (!apiKey) return undefined
    }
  } catch {
    return undefined
  }

  const caps = resolveCapabilities(prov.name, prov.capabilities, spec.capabilities)
  // A dedicated compact client always runs the generous char budget (up to ~16K
  // chars at 1M). maxTokens only caps output (billed per generated token), so a
  // high ceiling is cost-neutral but prevents truncating a generous CJK summary
  // mid-sentence — 16K chars is ~10K tokens for Chinese, far above a 4K cap.
  const maxTokens = Math.min(16_384, spec.maxTokens)
  return createProviderClient(prov, caps, {
    apiKey,
    model: spec.id,
    reasoningEffort: spec.reasoningEffort,
    maxTokens,
    auth,
    sessionId: input.sessionId,
  })
}

/**
 * 已报过的桥失效原因——这个函数每次建 agent 都跑（每会话 + 每次 switchModel 重建），
 * 不去重会把同一条配置错误刷满日志。
 */
const warnedVisionBridge = new Set<string>()

/** 配了桥但用不上时点名原因。「没配」和「配了但起不来」表现完全相同（图照样被丢），
 *  沉默降级会让人以为配置生效了——这类不可见失败前面刚在截图路径上咬过一次。 */
function warnVisionBridge(key: string, reason: string): undefined {
  if (!warnedVisionBridge.has(key)) {
    warnedVisionBridge.add(key)
    console.warn(`[vision] 识图桥未启用：${reason}（图片仍会被丢弃）`)
  }
  return undefined
}

interface VisionBridgeBuild {
  client: import('../api/stream-client.js').StreamClient
  prompt?: string
  maxTokens: number
  /** configured=用户显式指定；auto=未配但自动选了个可用视觉模型。 */
  source: 'configured' | 'auto' | 'same-provider'
  /** 选中的 provider/model，供 UI 显示。 */
  ref: string
}

/**
 * Try to build a vision StreamClient from one (provider, modelSpec) pair.
 * Returns the client or an error reason string (never throws).
 */
function tryBuildVisionClientFrom(
  input: AgentConfigInput,
  prov: ProviderConfig,
  spec: ModelConfig,
  requestedMaxTokens: number,
): { client: import('../api/stream-client.js').StreamClient; maxTokens: number } | { error: string } {
  let apiKey = ''
  let auth: AuthProvider | undefined
  try {
    if (prov.auth?.type === 'oauth') {
      auth = prov.name === input.provider.name ? input.auth : createAuthProvider(prov.auth, process.env)
      if (!auth?.isAuthenticated()) return { error: `${prov.name} 未完成 OAuth 登录——运行 /login（或 rivet config login ${prov.name}）完成浏览器授权` }
    } else {
      apiKey = resolveApiKey(prov)
      // keyless 端点 resolveApiKey 返回空串是正常态（ollama 等本地端点无 key），非缺失
      if (!apiKey && !isKeylessProviderEntry(prov.name, prov)) return { error: `${prov.name} 的 API key 为空` }
    }
  } catch {
    // resolveApiKey 拿不到 key 就抛。最常见的成因不是"没有 key"而是"key 只存在环境变量里，
    // 而这个进程没继承到它"——GUI/Dock 启动的桌面端拿不到 shell profile 里的变量，
    // 且 config.env 那套解析只作用于命令执行，不改 process.env。
    return {
      error: `取不到 ${prov.name} 的 API key（${prov.apiKeyEnv ?? `${prov.name.toUpperCase()}_API_KEY`} 未传入本进程？`
        + '改用 Settings → Providers 把 key 存进配置，就不依赖启动方式了）',
    }
  }
  const caps = resolveCapabilities(prov.name, prov.capabilities, spec.capabilities)
  const maxTokens = Math.min(requestedMaxTokens, spec.maxTokens)
  const client = createProviderClient(prov, caps, {
    apiKey,
    model: spec.id,
    // 桥是工具化描述调用，中等强度推理是纯粹的预算浪费，且在 OCR 结构化 prompt
    // 下会失控：deepseek-flash 实测 reasoning 1717 字符烧光 1024 maxTokens、
    // finish=length、content 为零——「配 4.1-flash 多模态也不行」的根因。压到
    // low（同请求实测 reasoning 1717→290、content 正常返回）；非推理模型
    // （reasoningEffort 未设）不发该参数，行为不变。
    reasoningEffort: spec.reasoningEffort ? 'low' : undefined,
    maxTokens,
    auth,
    sessionId: input.sessionId,
  })
  return { client, maxTokens }
}

/**
 * Vision-capable models across all configured providers, best candidate first:
 * same provider as the primary > minimax > glm > others. Declaration-only (no
 * credential probing, no client construction) so callers that just want to *name*
 * a candidate don't pay for one.
 *
 * `sameProviderOnly` 只保留与主模型同一 provider 的候选——图片不出该 provider
 * 边界，是「默认允许自动桥」成立的前提（见 buildVisionClient）。
 */
function visionCandidates(
  input: AgentConfigInput,
  opts?: { sameProviderOnly?: boolean },
): Array<{ prov: ProviderConfig; spec: ModelConfig }> {
  const providers = input.allProviders
  if (!providers) return []
  // zhipu-vision (glm-4v-flash, 免费) 排末位 —— 有付费视觉模型时优先用付费的
  // （质量更高），它作为"用户没配其他视觉模型时的免费兜底"。
  const PRIORITY = [input.provider.name, 'minimax', 'glm', 'zhipu-vision']
  const rank = (name: string): number => {
    const i = PRIORITY.indexOf(name)
    return i === -1 ? PRIORITY.length + 1 : i
  }
  const candidates: Array<{ prov: ProviderConfig; spec: ModelConfig }> = []
  for (const prov of Object.values(providers)) {
    if (opts?.sameProviderOnly && prov.name !== input.provider.name) continue
    for (const spec of prov.models) {
      if (spec.supportsVision) candidates.push({ prov, spec })
    }
  }
  return candidates.sort((a, b) => rank(a.prov.name) - rank(b.prov.name))
}

/**
 * Auto-select a vision bridge. 两条调用路径：
 * - 同 provider（`sameProviderOnly`，未配 visionModel 时的默认路径）——图片不出该
 *   provider 边界，无需 opt-in；
 * - 任意 provider——仅 `agent.visionAutoBridge=true` 可达（跨 provider 是成本与隐私决定）。
 * Picks the first vision-capable model that has usable credentials.
 * Returns undefined when nothing is available (图片照旧被丢弃，提示在别处补）。
 */
function autoSelectVisionBridge(
  input: AgentConfigInput,
  opts?: { sameProviderOnly?: boolean },
): VisionBridgeBuild | undefined {
  for (const { prov, spec } of visionCandidates(input, opts)) {
    const built = tryBuildVisionClientFrom(input, prov, spec, 1024)
    if ('client' in built) {
      const ref = `${prov.name}/${spec.id}`
      console.warn(
        opts?.sameProviderOnly
          ? `[vision] 自动选用识图桥：${ref}（与主模型同一 provider，图片不出该 provider 边界）`
          : `[vision] 自动选用识图桥：${ref}（agent.visionAutoBridge=true；图片将发送给该 provider）`,
      )
      return {
        client: built.client, prompt: undefined, maxTokens: built.maxTokens,
        source: opts?.sameProviderOnly ? 'same-provider' : 'auto', ref,
      }
    }
    // 有 key 问题的候选跳过，继续找下一个——自动路径不刷 warn（显式路径才点名）。
  }
  return undefined
}

/**
 * Build the dedicated vision bridge StreamClient. 只在主模型 text-only 时调用。
 * 1) 显式 agent.visionModel 优先——配了就用它，起不来则点名原因（不静默降级）。
 * 2) 未显式配置 → 仅当 `agent.visionAutoBridge=true` 才自动选一个可用视觉模型。
 *    默认关：自动桥会把用户的图片发给一个用户从未为此选择过的 provider，那是成本
 *    与隐私决定，不该由默认值替用户做。关着时候选会被点名（见 deriveVisionBridgeStatus）。
 * 返回 undefined 表示无桥可用（主模型照旧看不到图）。
 */
function buildVisionClient(input: AgentConfigInput): VisionBridgeBuild | undefined {
  const vm = input.visionModel
  if (!vm) {
    if (input.visionAutoBridge) return autoSelectVisionBridge(input)
    // 同 provider 的视觉档默认可用：主模型每轮都在向该 provider 发送完整对话，图片
    // 发给同一方不引入新的数据流向或计费主体——跨 provider 自动桥的隐私顾虑在这个
    // 窄条件下不成立。跨 provider 仍严格 opt-in（默认关的理由见本函数 doc）。
    return autoSelectVisionBridge(input, { sameProviderOnly: true })
  }
  const ref = `${vm.provider}/${vm.model}`
  const prov = input.allProviders?.[vm.provider]
  if (!prov) return warnVisionBridge(`prov:${ref}`, `provider "${vm.provider}" 不在已配置的 provider 列表里`)
  const spec = prov.models.find(m => m.id === vm.model || m.alias === vm.model)
  if (!spec) return warnVisionBridge(`model:${ref}`, `provider "${vm.provider}" 下没有模型 "${vm.model}"`)
  // 不拦：手改配置可以指一个非视觉模型，那时桥能连上但描述必然是瞎猜。
  if (!spec.supportsVision) {
    warnVisionBridge(`novision:${ref}`, `${ref} 未声明视觉能力，描述结果不可信——桌面端 Settings → Integrations 的下拉只列声明了视觉能力的模型`)
  }

  const built = tryBuildVisionClientFrom(input, prov, spec, vm.maxTokens)
  if ('error' in built) return warnVisionBridge(`key:${ref}`, built.error)

  // 主/备双桥：备桥可解析时，用 FallbackStreamClient 包一层——主视觉模型 5xx/超时
  // 自动切备。备桥起不来（缺 key/模型不存在）不致命，仅点名，降级为单桥。
  let client = built.client
  let refLabel = ref
  const fb = vm.fallback
  if (fb) {
    const fbRef = `${fb.provider}/${fb.model}`
    const fbProv = input.allProviders?.[fb.provider]
    const fbSpec = fbProv?.models.find(m => m.id === fb.model || m.alias === fb.model)
    if (!fbProv || !fbSpec) {
      warnVisionBridge(`fbmodel:${fbRef}`, `备用识图模型 ${fbRef} 不存在，降级为单桥`)
    } else {
      const fbBuilt = tryBuildVisionClientFrom(input, fbProv, fbSpec, vm.maxTokens)
      if ('error' in fbBuilt) {
        warnVisionBridge(`fbkey:${fbRef}`, `备用识图桥 ${fbRef} 起不来：${fbBuilt.error}，降级为单桥`)
      } else {
        client = new FallbackStreamClient(built.client, ref, [{ name: fbRef, create: () => fbBuilt.client }])
        refLabel = `${ref} → ${fbRef}`
      }
    }
  }
  return { client, prompt: vm.prompt, maxTokens: built.maxTokens, source: 'configured', ref: refLabel }
}
