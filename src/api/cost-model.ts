/**
 * Provider cost model — how a provider bills, independent of its cache type.
 *
 * Two orthogonal axes drive compaction policy:
 *   - cache type (exact-prefix / none …) → governs cache *correctness/latency*
 *     (breaking an exact-prefix cache forces an expensive re-prefill).
 *   - cost model (this file) → governs whether tokens cost *money*.
 *
 * They are NOT the same. DeepSeek is per-token AND exact-prefix, so its cache
 * deferral saves real money. GLM/MiMo are exact-prefix but billed by a flat
 * coding-plan / token-plan subscription — their cache still matters for
 * re-prefill latency, but NOT for cost. Codex/Claude are OAuth subscriptions
 * with no persistent prefix cache at all.
 *
 * Used by the turn-0 quality-compaction path: subscription providers may compact
 * more eagerly for a leaner context (cost is flat), while per-token exact-prefix
 * providers keep deferring to protect paid cache.
 */

export type CostModel = 'per-token' | 'subscription'

/** Providers billed by a flat subscription / coding-plan (tokens are not metered). */
const SUBSCRIPTION_PROVIDERS = new Set<string>([
  'glm', // 智谱 coding plan (open.bigmodel.cn/api/coding/...)
  'mimo', // Xiaomi MiMo token-plan (token-plan-cn.xiaomimimo.com)
  'codex', // ChatGPT subscription via OAuth
  'claude', // Claude Max/Pro via OAuth
])

/** Providers billed per API token (cache hits save real money). */
const PER_TOKEN_PROVIDERS = new Set<string>([
  'deepseek',
  'mimo-api', // Xiaomi pay-per-use API (api.xiaomimimo.com)
  'minimax',
  'openai',
  'anthropic',
  'google',
  'qwen',
  'kimi',
  'vllm',
  'opencode-go',
  'siliconflow', // aggregator — per-token
  'dashscope', // 阿里通义千问 — per-token
  'stepfun', // 阶跃星辰 StepFun — per-token（官方开放平台按量计费，非订阅制）
  'openrouter', // aggregator — per-token
  'relay', // self-hosted one-api/new-api relay — per-token (default assumption)
])

export interface CostModelHints {
  /** Auth type from the provider config; 'oauth' implies a subscription. */
  authType?: string
  /** Provider baseUrl; coding-plan / token-plan endpoints imply a subscription. */
  baseUrl?: string
}

/**
 * Classify how a provider bills. Falls back to baseUrl / auth hints for custom
 * providers not in the known sets, defaulting to 'per-token' (the conservative
 * choice: never relax cost-driven cache protection for an unknown provider).
 */
export function classifyCostModel(providerName: string | undefined, hints: CostModelHints = {}): CostModel {
  const name = (providerName ?? '').trim().toLowerCase()
  if (SUBSCRIPTION_PROVIDERS.has(name)) return 'subscription'
  if (PER_TOKEN_PROVIDERS.has(name)) return 'per-token'

  // Unknown / custom provider — infer from config hints.
  if (hints.authType === 'oauth') return 'subscription'
  if (hints.baseUrl) {
    const url = hints.baseUrl.toLowerCase()
    if (url.includes('/coding/') || url.includes('token-plan')) return 'subscription'
  }
  return 'per-token'
}

/** True when the provider does NOT bill per API token (flat subscription / coding-plan). */
export function isCostInsensitiveProvider(providerName: string | undefined, hints: CostModelHints = {}): boolean {
  return classifyCostModel(providerName, hints) === 'subscription'
}
