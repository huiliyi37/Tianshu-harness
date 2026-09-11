import { OpenAIClient } from './openai-client.js'
import { CodexClient } from './codex-client.js'
import { AnthropicClient } from './anthropic-client.js'
import { proRegistry } from './pro-registry.js'
import type { StreamClient } from './stream-client.js'
import type { ProviderCapabilities } from './provider.js'
import { getProviderProfile } from './provider-profile.js'
import { resolveProviderWire } from './provider-catalog.js'
import type { ProviderConfig } from '../config/schema.js'
import { readSecret } from '../config/secrets-store.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'
import type { AuthProvider } from '../auth/types.js'
import { PROCESS_SESSION_ID } from './caller-identity.js'

/** Runtime parameters that vary per-model or per-call, not stored in config */
export interface RuntimeParams {
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinkingBudget?: number
  auth?: AuthProvider
  /** Stable session identifier for cache routing affinity */
  sessionId?: string
  /** Session-frozen wire-transform context (e.g. spark truncate N) — resolved
   *  once at session start from meta/defaults, byte-stable across resume. */
  wireContext?: import('./pro-registry.js').WireTransformContext
}

/**
 * Resolve the API key from config, falling back to environment variable.
 *
 * Fallback order:
 *   1. provider.keyRef (pointer into secrets.json — config.json holds no plaintext)
 *   2. provider.apiKey (legacy inline key in config)
 *   3. provider.apiKeyEnv (explicit env var name in config)
 *   4. Standard env var: `<PROVIDER_NAME_UPPER>_API_KEY` (e.g. DEEPSEEK_API_KEY)
 *
 * Step 4 handles the common case where a user has the standard env var set but
 * the provider config lost its apiKeyEnv reference (manual edits, migration,
 * or deleting/re-entering the key in the desktop UI).
 */
export function resolveApiKey(provider: ProviderConfig): string {
  if (provider.keyRef) {
    const secret = readSecret(provider.keyRef)
    if (secret) return secret
  }
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv) {
    const env = process.env[provider.apiKeyEnv]
    if (env) return env
  }
  const defaultEnvVar = `${provider.name.toUpperCase()}_API_KEY`
  const env = process.env[defaultEnvVar]
  if (env) return env
  // keyless 端点（ollama / 未配密钥材料的自定义 provider）免 key——返回空串，
  // 下游对本地端点本就不该带有效 Authorization。需 key 而没配的仍在下方抛错。
  if (isKeylessProviderEntry(provider.name, provider)) return ''
  throw new Error(
    `No API key configured for provider "${provider.name}". ` +
    `Set apiKey in config or the ${provider.apiKeyEnv ?? defaultEnvVar} environment variable.`
  )
}

/**
 * Create a streaming API client for the given provider.
 *
 * Dispatch order: pro-registry factory → Codex OAuth (Responses API) →
 * provider.protocol ('anthropic' → AnthropicClient, else OpenAI-compatible).
 */

export function createProviderClient(
  provider: ProviderConfig,
  capabilities: ProviderCapabilities,
  params: RuntimeParams,
): StreamClient {
  // Wire quirks for this endpoint: catalog entry rules + host-keyed rules.
  // Host lookup matters because OpenCode Go's Anthropic-protocol endpoint is
  // registered under `name: 'anthropic'` — a name-only lookup would miss its
  // mandatory session header and every request would 400 MissingSessionID.
  const wire = resolveProviderWire(provider.name, provider.baseUrl)
  // 空串/空白 sessionId 等同没传：否则 `??` 放行空值、客户端又用真值判断，
  // 结果是既不发头也不触发兜底——一个静默缺头请求。
  const explicitSessionId = params.sessionId?.trim() ? params.sessionId : undefined
  const sessionId = explicitSessionId ?? (wire?.sessionHeader ? PROCESS_SESSION_ID : undefined)

  // Pro 注册的 client 工厂优先（协议非 OpenAI/Anthropic 兼容时由 pro 模块提供）。
  // 开源构建注册表恒空 → 恒 miss → 走原路径，行为与现状完全一致。
  const proFactory = proRegistry.getClientFactory(provider.name)
  if (proFactory) return proFactory(provider, capabilities, params)

  // Codex OAuth uses the Responses API, not chat/completions
  if (provider.name === 'codex' && provider.auth?.type === 'oauth') {
    return new CodexClient({
      baseUrl: provider.baseUrl,
      model: params.model,
      maxTokens: params.maxTokens,
      auth: params.auth,
      maxRetries: provider.maxRetries,
      retry: provider.retry,
    })
  }

  // Anthropic native protocol — explicit cache_control breakpoints.
  // Dispatch is driven ONLY by provider.protocol (schema-normalized: a provider
  // named 'anthropic' defaults to protocol 'anthropic' unless explicitly
  // overridden). Names and capability heuristics are not consulted here —
  // e.g. Qwen via OpenCode Go speaks /v1/messages because ITS DESCRIPTOR says
  // protocol 'anthropic', while direct Qwen API (dashscope) says 'openai'.
  if (provider.protocol === 'anthropic') {
    const budgetMap: Record<string, number> = {
      max: params.maxTokens,
      high: Math.floor(params.maxTokens * 0.6),
      medium: Math.floor(params.maxTokens * 0.3),
      low: 8192,
    }
    const thinkingBudget = params.reasoningEffort
      ? (budgetMap[params.reasoningEffort] ?? Math.floor(params.maxTokens * 0.6))
      : undefined

    return new AnthropicClient({
      baseUrl: provider.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      maxTokens: params.maxTokens,
      thinkingBudget,
      requestTimeoutMs: provider.requestTimeoutMs,
      maxRetries: provider.maxRetries,
      retry: provider.retry,
      temperature: provider.temperature,
      proxy: provider.proxy,
      userAgent: wire?.userAgent,
      sessionId,
      sessionHeader: wire?.sessionHeader,
    })
  }

  return new OpenAIClient({
    baseUrl: provider.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    maxTokens: params.maxTokens,
    auth: params.auth,
    thinking: provider.thinking as 'enabled' | 'disabled' | undefined,
    thinkingStallTimeoutMs: provider.thinkingStallTimeoutMs ?? wire?.thinkingStallTimeoutMs,
    firstByteTimeoutMs: provider.firstByteTimeoutMs,
    // Advanced provider knobs and slow-thinking override are both runtime inputs.
    requestTimeoutMs: provider.requestTimeoutMs,
    maxRetries: provider.maxRetries,
    retry: provider.retry,
    temperature: provider.temperature,
    proxy: provider.proxy,
    slowThinking: provider.slowThinking,
    thinkingBlockType: capabilities.thinkingBlockType,
    reasoningSplit: capabilities.reasoningSplit,
    thinkingBudgetField: capabilities.thinkingBudgetField,
    effortCap: capabilities.effortCap,
    effortFormat: capabilities.effortFormat,
    reasoningEffort: params.reasoningEffort,
    sessionId,
    sessionHeader: wire?.sessionHeader,
    providerName: provider.name,
    // 401/403 报错里点名 key 的环境变量，用户知道去哪检查。
    apiKeyEnv: provider.apiKeyEnv,
    // Preserved-thinking protocol family: table-driven capability, not provider
    // name — the pro spark preset declares it via capabilities override, so no
    // pro provider name leaks into open-source wire code. Distinct from the
    // deepseek-native prefix-cache strategy (GLM/longcat share the cache
    // strategy but have independent reasoning — they must NOT get this).
    preservedThinkingProtocol: capabilities.preservedThinkingProtocol ?? false,
    providerProfile: getProviderProfile(provider.name, modelContextWindow(provider, params.model)),
    wireContext: params.wireContext,
    unsupported: provider.unsupported.length > 0
      ? provider.unsupported
      : capabilities.stripParams,
    prefixCompletion: provider.capabilities.prefixCompletion,
    useMaxCompletionTokens: wire?.useMaxCompletionTokens,
    userAgent: wire?.userAgent,
    usageCalibrationFactor: provider.usageCalibrationFactor,
    capabilities: { hasToolJsonInContentBug: capabilities.hasToolJsonInContentBug },
  })
}

function modelContextWindow(provider: ProviderConfig, modelId: string): number {
  // Fall back to the provider's first configured model rather than a fixed
  // small constant: schema requires contextWindow on every model, so the
  // 128K terminal fallback only applies to a provider with zero models.
  return (
    provider.models.find(model => model.id === modelId || model.alias === modelId)?.contextWindow
    ?? provider.models[0]?.contextWindow
    ?? 128_000
  )
}
