import type { Usage } from './types.js'
import type { ProviderCapabilitiesConfig } from '../config/schema.js'

/**
 * Describes what a provider supports and how to adapt requests/responses.
 * Each provider (DeepSeek, OpenAI, Anthropic, etc.) provides one of these
 * so the shared ApiClient can handle differences without hardcoded branching.
 */
export interface ProviderCapabilities {
  /** Whether thinking mode (extended reasoning) is supported */
  supportsThinking: boolean
  /** What type of thinking block to send in the request body.
   *  'enabled' = {thinking:{type:'enabled'}} (DeepSeek, GLM, MiMo, Claude)
   *  'adaptive' = {thinking:{type:'adaptive'}} (MiniMax)
   *  'none' = no thinking block; use reasoning_effort param instead (OpenAI, Codex, Kimi) */
  thinkingBlockType: 'enabled' | 'adaptive' | 'none'
  /** Whether the provider separates reasoning into a `reasoning_content` field (MiniMax) */
  reasoningSplit?: boolean
  /** Which field name carries the thinking budget inside the thinking block (Claude: 'budget_tokens') */
  thinkingBudgetField?: 'budget_tokens'
  /** Per-provider effort ceiling — values above this cap are clamped (Codex: max→xhigh, Kimi: max→high) */
  effortCap?: Record<string, string>
  /** DeepSeek preserved-thinking wire protocol: assistant tool-call turns must echo
   *  `reasoning_content`, and the Chinese-thinking system suffix applies. Declared by
   *  providers whose wire format is DeepSeek-derived (DeepSeek, MiMo; pro spark via
   *  its own preset) — NOT by every provider that merely shares the deepseek-native
   *  prefix-cache strategy (GLM/longcat/siliconflow have independent reasoning). */
  preservedThinkingProtocol?: boolean
  /** Whether cache_control blocks are respected by the provider */
  supportsCacheControl: boolean
  /** Top-level request parameters to strip before sending */
  stripParams: string[]
  /** Whether the provider has a known bug where tool JSON appears in text content */
  hasToolJsonInContentBug: boolean
  /** How to format effort / reasoning control in requests */
  effortFormat: 'reasoning_effort' | 'output_config' | 'none'
  /** Optional: normalise raw usage fields into the standard Usage shape */
  mapUsage?: (raw: Record<string, unknown>) => Partial<Usage>
  /**
   * Prefix cache strategy for this provider.
   * - 'deepseek-native': DeepSeek's transparent exact-prefix caching (no cache_control needed)
   * - 'anthropic-cache-control': Anthropic-style explicit cache_control breakpoints
   * - 'none': No prefix caching; skip cache fingerprinting
   */
  prefixCacheStrategy: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  /** Whether the provider supports `response_format: {type:'json_object'}` to force
   *  JSON output. Used by worker sessions to eliminate free-text parse failures
   *  (DeepSeek/GLM/OpenAI-compatible support this; some providers reject it). */
  supportsResponseFormat: boolean
}

/**
 * Map DeepSeek usage fields (both native and Anthropic-compatible formats)
 * into the standard Usage shape.
 */
export function mapDeepSeekUsage(raw: Record<string, unknown>): Usage {
  return {
    // Support both DeepSeek native format and Anthropic compatibility format
    input_tokens: (raw.prompt_tokens ?? raw.input_tokens ?? 0) as number,
    output_tokens: (raw.completion_tokens ?? raw.output_tokens ?? 0) as number,
    cache_read_input_tokens: (raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? (raw.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0) as number,
    cache_creation_input_tokens: (raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? 0) as number,
  }
}

export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: true,
  thinkingBlockType: 'enabled',
  preservedThinkingProtocol: true,
  supportsCacheControl: false,
  stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
  hasToolJsonInContentBug: true,
  effortFormat: 'reasoning_effort',
  prefixCacheStrategy: 'deepseek-native',
  supportsResponseFormat: true,
  mapUsage: mapDeepSeekUsage,
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: false,
  thinkingBlockType: 'none',
  supportsCacheControl: true,
  stripParams: [],
  hasToolJsonInContentBug: false,
  effortFormat: 'none',
  prefixCacheStrategy: 'none',
  supportsResponseFormat: false,
}

/**
 * Well-known provider defaults.
 * New providers can be added here without code changes elsewhere.
 * Config-level capabilities override these defaults.
 */
export const WELL_KNOWN_DEFAULTS: Record<string, ProviderCapabilities> = {
  deepseek: DEEPSEEK_CAPABILITIES,
  kimi: {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    // 无 effortCap：官方 Kimi Code 文档（kimi-code/models.html）——k3 / k3-256k
    // 的 reasoning_effort 支持 low|high|max，第三方工具传 max 即映射到 max。
    // 旧值 {max:'high'} 会把用户显式选的 max 静默降成 high，K3 旗舰的 max 档
    // 永远发不出去。K2.7 Code（kimi-for-coding）是 Thinking:ON、无档位。
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
  glm: {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    // GLM-5.2 has implicit exact-prefix caching (no cache_control breakpoints),
    // reported via usage.prompt_tokens_details.cached_tokens — same model as DeepSeek.
    prefixCacheStrategy: 'deepseek-native',
    supportsResponseFormat: true,
    mapUsage: mapDeepSeekUsage,
  },
  minimax: {
    supportsThinking: true,
    thinkingBlockType: 'adaptive',
    reasoningSplit: true,
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
  mimo: {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    preservedThinkingProtocol: true,
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
  'mimo-api': {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'deepseek-native',
    supportsResponseFormat: false,
  },
  'opencode-go': {
    supportsThinking: false,
    thinkingBlockType: 'none',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
  openai: {
    supportsThinking: true,
    thinkingBlockType: 'none',
    supportsCacheControl: true,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: true,
  },
  codex: {
    supportsThinking: true,
    thinkingBlockType: 'none',
    effortCap: { max: 'xhigh' },
    supportsCacheControl: true,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: true,
  },
  claude: {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    thinkingBudgetField: 'budget_tokens',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
  // LongCat official docs support ONLY model/messages/stream/max_tokens/
  // temperature/top_p — no response_format (json-mode repair unusable, worker
  // repair must run as plain-text re-ask) and no cache_control breakpoints
  // (server-side implicit prefix caching, hits free). Explicit entry so
  // behavior doesn't ride on the DEFAULT_CAPABILITIES fallback
  // (session 2c1186f5 scout postmortem).
  longcat: {
    supportsThinking: false,
    thinkingBlockType: 'none',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'deepseek-native',
    supportsResponseFormat: false,
    mapUsage: mapDeepSeekUsage,
  },
  ccswitch: {
    // cc-switch 是 OpenAI 兼容代理，入口层透传 reasoning_effort；
    // 其 Rectifier 翻译层会将 OpenAI 格式转为 Claude/DeepSeek 等上游原生格式。
    // 后端模型不认识 reasoning_effort 时按 OpenAI 兼容约定静默忽略（降级）。
    supportsThinking: true,
    thinkingBlockType: 'none',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
  // ── Aggregator / relay providers ─────────────────────────────────────────
  // SiliconFlow aggregator (硅基流动). Default model in preset is DeepSeek-proxied
  // → toolJsonBug:true set in preset overrides. Server-side implicit prefix caching
  // on DeepSeek-V4 / GLM-5.2 (charges for cached input) → deepseek-native strategy
  // to preserve cache-aware compaction.
  siliconflow: {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'deepseek-native',
    supportsResponseFormat: false,
    mapUsage: mapDeepSeekUsage,
  },
  // DashScope (阿里通义千问官方 OpenAI 兼容端点). Qwen3-max supports thinking
  // block; Qwen-plus/turbo do not — per-model override via `models[].capabilities`.
  // DashScope OpenAI-compatible endpoint does not accept cache_control breakpoints
  // (that's Anthropic protocol); cache profile is 'explicit-breakpoint' only via
  // the legacy PROFILES['qwen'] entry kept for back-compat.
  dashscope: {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: true,
  },
  // OpenRouter international aggregator. thinking block passthrough is unstable
  // across the model fleet → thinkingBlockType:'none', rely on reasoning_effort
  // passthrough only. Users can override per-model via `models[].capabilities`.
  openrouter: {
    supportsThinking: true,
    thinkingBlockType: 'none',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
  // one-api / new-api self-hosted relay (generic template, not activated by
  // default to avoid overlap with ccswitch). Same shape as ccswitch — relay
  // entry point passes reasoning_effort through, upstream Rectifier translates.
  relay: {
    supportsThinking: true,
    thinkingBlockType: 'none',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  },
}

/**
 * Apply a single layer of `ProviderCapabilitiesConfig` overrides onto a base
 * `ProviderCapabilities` in place. Undefined fields in `overrides` are treated
 * as "not declared" and fall through to the base (which is typically
 * `WELL_KNOWN_DEFAULTS[name]` or the output of a prior layer).
 *
 * Also derives `supportsThinking` from the user-declared thinking fields:
 *   - thinkingBlock ∈ {'enabled','adaptive'} or effortFormat ∈ {'reasoning_effort','output_config'}
 *     → supportsThinking = true
 *   - thinkingBlock === 'none' AND effortFormat === 'none'
 *     → supportsThinking = false
 *   - otherwise: keep base value (no signal either way)
 */
function applyOverrides(
  base: ProviderCapabilities,
  overrides?: ProviderCapabilitiesConfig,
): ProviderCapabilities {
  if (!overrides) return base

  // Legacy fields
  if (overrides.cacheControl !== undefined) base.supportsCacheControl = overrides.cacheControl
  // PR#38 审查阻断 4：空数组与「未声明」同义（恢复旧模型语义）。PR 曾把 []
  // 改为「显式清空」——但旧模型里 [] 一直是「无意见」的占位（预设/快照里全
  // 是 []，旧判定 length>0 才生效），新语义会让 WELL_KNOWN 剥离清单对存量
  // 配置与内置预设静默失效（top_k/cache_control 等重新进请求）。strip-nothing
  // 在旧模型本就无法表达，恢复 length>0 判定无回归；要显式清空请删除该键
  // 并显式列出要保留的对立面（无此通道，与旧模型一致）。
  if (overrides.stripParams !== undefined && overrides.stripParams.length > 0) base.stripParams = overrides.stripParams
  if (overrides.toolJsonBug !== undefined) base.hasToolJsonInContentBug = overrides.toolJsonBug
  if (overrides.prefixCache !== undefined) base.prefixCacheStrategy = overrides.prefixCache

  // Thinking fields — direct assignment; 'none' is a valid explicit value.
  if (overrides.thinkingBlock !== undefined) base.thinkingBlockType = overrides.thinkingBlock
  if (overrides.effortFormat !== undefined) base.effortFormat = overrides.effortFormat
  if (overrides.effortCap !== undefined) base.effortCap = { ...overrides.effortCap }
  if (overrides.reasoningSplit !== undefined) base.reasoningSplit = overrides.reasoningSplit
  if (overrides.thinkingBudgetField !== undefined) base.thinkingBudgetField = overrides.thinkingBudgetField
  if (overrides.preservedThinkingProtocol !== undefined) base.preservedThinkingProtocol = overrides.preservedThinkingProtocol

  // Derive supportsThinking from declared thinking capability.
  const declaresThinking =
    overrides.thinkingBlock === 'enabled' || overrides.thinkingBlock === 'adaptive'
    || overrides.effortFormat === 'reasoning_effort' || overrides.effortFormat === 'output_config'
  const declaresNoThinking =
    overrides.thinkingBlock === 'none' && overrides.effortFormat === 'none'
  if (declaresThinking) base.supportsThinking = true
  else if (declaresNoThinking) base.supportsThinking = false

  return base
}

/**
 * Resolve capabilities for a provider by name, merged with optional
 * config-level and model-level overrides.
 *
 * Merge order (later wins):
 *   1. `WELL_KNOWN_DEFAULTS[providerName]` (or `DEFAULT_CAPABILITIES` for unknown providers)
 *   2. `providerOverrides` (from `provider.capabilities` in user config / preset)
 *   3. `modelOverrides` (from `provider.models[i].capabilities`)
 *
 * All override fields are optional: an omitted field falls through to the
 * prior layer. An explicit value (including `'none'` / `false`) wins.
 * 例外：`stripParams: []` 与未声明同义（空数组不覆盖前层——见 applyOverrides
 * 阻断 4 注释；`'none'`/`false` 仍是有效显式值）。
 */
export function resolveCapabilities(
  providerName: string,
  providerOverrides?: ProviderCapabilitiesConfig,
  modelOverrides?: ProviderCapabilitiesConfig,
): ProviderCapabilities {
  // Shallow copy, not structuredClone: entries may carry a mapUsage function.
  // Safe — applyOverrides only assigns top-level fields (effortCap gets a new object).
  const base: ProviderCapabilities = {
    ...(WELL_KNOWN_DEFAULTS[providerName] ?? DEFAULT_CAPABILITIES),
  }

  applyOverrides(base, providerOverrides)
  applyOverrides(base, modelOverrides)

  return base
}
