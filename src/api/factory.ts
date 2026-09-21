import { OpenAIClient } from './openai-client.js'
import { CodexClient } from './codex-client.js'
import { AnthropicClient } from './anthropic-client.js'
import { ResponsesClient } from './responses-client.js'
import { proRegistry } from './pro-registry.js'
import type { StreamClient } from './stream-client.js'
import type { ProviderCapabilities } from './provider.js'
import { getProviderProfile } from './provider-profile.js'
import { resolveProviderWire } from './provider-catalog.js'
import { normalizeBaseUrl } from './endpoint-map.js'
import type { ProviderConfig } from '../config/schema.js'
import { readSecret } from '../config/secrets-store.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'
import { contractModels } from '../config/contract-models.js'
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

/** 凭据槽位形状——provider 与 provider 下的单个 key 共用（PR-3 多 key）。
 *  `name` 恒为 provider 名：`<NAME>_API_KEY` 兜底与错误文案都按 provider 口径。 */
export interface CredentialSlots {
  name: string
  keyRef?: string
  apiKey?: string
  apiKeyEnv?: string
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
  const cred = { name: provider.name, keyRef: provider.keyRef, apiKey: provider.apiKey, apiKeyEnv: provider.apiKeyEnv }
  // 顺序保真：凭据链全部落空才判 keyless 豁免。预设 keyless（ollama）若用户显式
  // 配了 key（带鉴权的本地代理 / 远程端点），旧行为用该 key——豁免前置会静默丢弃
  // 它并发出无 Authorization 的请求。
  const resolved = tryResolveCredentialKey(cred)
  if (resolved !== undefined) return resolved
  // keyless 端点（ollama / 未配密钥材料的自定义 provider）免 key——返回空串，
  // 下游对本地端点本就不该带有效 Authorization。需 key 而没配的仍在下方抛错。
  if (isKeylessProviderEntry(provider.name, provider)) return ''
  throw new Error(
    `No API key configured for provider "${provider.name}". ` +
    `Set apiKey in config or the ${provider.apiKeyEnv ?? `${provider.name.toUpperCase()}_API_KEY`} environment variable.`
  )
}

/** 三槽解析的非抛出形态（provider 级与 key 级共用）：keyRef→apiKey→apiKeyEnv→
 *  `<NAME>_API_KEY` 全部落空返回 undefined，由调用方决定 keyless 豁免还是抛错。
 *  导出供「尽力而为」的消费方使用（provider-cli 的探测路径）——它们要的就是
 *  这个语义，此前各写一份平行实现，正是漂移的来源。 */
export function tryResolveCredentialKey(cred: CredentialSlots): string | undefined {
  const { name, keyRef, apiKey, apiKeyEnv } = cred
  if (keyRef) {
    const secret = readSecret(keyRef)
    if (secret) return secret
  }
  if (apiKey) return apiKey
  if (apiKeyEnv) {
    const env = process.env[apiKeyEnv]
    if (env) return env
  }
  const env = process.env[`${name.toUpperCase()}_API_KEY`]
  if (env) return env
  return undefined
}

/** key 级三槽解析（keys[].apiKey/apiKeyEnv/keyRef + provider 名做 env 回退名）。
 *  resolveApiKey(provider) 用完整 ProviderConfig；多 key 场景用本函数传单 key
 *  的三槽。逻辑同源（tryResolveCredentialKey），key 级不做 keyless 判定——那由
 *  provider 级入口负责。 */
export function resolveCredentialKey(cred: CredentialSlots): string {
  const resolved = tryResolveCredentialKey(cred)
  if (resolved !== undefined) return resolved
  const defaultEnvVar = `${cred.name.toUpperCase()}_API_KEY`
  throw new Error(
    `No API key configured for "${cred.name}". ` +
    `Set apiKey in config or the ${cred.apiKeyEnv ?? defaultEnvVar} environment variable.`
  )
}

/**
 * Create a streaming API client for the given provider.
 *
 * Dispatch order: pro-registry factory → Codex OAuth (Responses API) →
 * provider.protocol ('anthropic' → AnthropicClient,
 * 'openai-responses' → ResponsesClient, else OpenAI-compatible).
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

  // OpenAI Responses API for API-key endpoints (protocol 'openai-responses',
  // issue #239): /v1/responses with Bearer auth. Codex OAuth keeps its own
  // client above; the two converge in a later wave.
  if (provider.protocol === 'openai-responses') {
    return new ResponsesClient({
      // Same normalization as the OpenAI branch: users paste full request URLs
      // (`…/v1/responses`) or trailing slashes; without stripping, the send path
      // would append a second `/responses` (404).
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      apiKey: params.apiKey,
      model: params.model,
      maxTokens: params.maxTokens,
      auth: params.auth,
      reasoningEffort: params.reasoningEffort,
      effortCap: capabilities.effortCap,
      temperature: provider.temperature,
      thinking: provider.thinking as 'enabled' | 'disabled' | undefined,
      userAgent: wire?.userAgent,
      thinkingStallTimeoutMs: provider.thinkingStallTimeoutMs ?? wire?.thinkingStallTimeoutMs,
      firstByteTimeoutMs: provider.firstByteTimeoutMs,
      requestTimeoutMs: provider.requestTimeoutMs,
      maxRetries: provider.maxRetries,
      retry: provider.retry,
      proxy: provider.proxy,
      providerName: provider.name,
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
    // 用户在 Base URL 里粘贴 curl 全文（`…/v1/chat/completions`）或留个尾斜杠
    // 是常态。发送路径拼的是 `${baseUrl}/chat/completions`，不归一化就会出现
    // `…/chat/completions/chat/completions`（404）或 `…/v1//chat/completions`。
    // 探测路径早就用 normalizeBaseUrl 挡了这一手（endpoint-map.ts），发送路径
    // 漏了——症状于是固定为「连接测试通过、对话静默失败」。
    // 仅 OpenAI 分支适用：AnthropicClient 自己补 `/v1/messages`，对它剥尾巴会
    // 反造出 `/v1/v1/messages`——那是另一种错法，不在本处收口。
    baseUrl: normalizeBaseUrl(provider.baseUrl),
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
    providerProfile: getProviderProfile(provider.name, modelContextWindow(provider, params.model), provider.protocol),
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
  // 多 key：走 keys 池派生（contractModels）——顶层 models 是迁移快照，key 级增删
  // 不回写，直接读它可能取到已删除模型的窗口值或漏掉 key 里新加的模型。
  const pool = contractModels(provider)
  return (
    pool.find(model => model.id === modelId)?.contextWindow
    ?? pool[0]?.contextWindow
    ?? 128_000
  )
}
