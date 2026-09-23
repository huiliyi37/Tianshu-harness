import type { Usage } from './types.js'
import type { ProviderCapabilitiesConfig, ProviderProtocol } from '../config/schema.js'

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
    // 推理透传：上游不认 thinking 块（默认就返回 reasoning_content），但接受
    // reasoning_effort——low/medium/high/max/xhigh 实测全部 200。曾配成
    // effortFormat 'none'，而 openai-client 的两个分支都以 effortFormat !== 'none'
    // 为写入前提（openai-client.ts:518-548），于是用户的档位选择被静默吞掉。
    // 透传后是否按档位调节由上游决定；天枢的职责是别把它丢掉。
    supportsThinking: true,
    thinkingBlockType: 'none',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
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
  grok: {
    // xAI grok-4.6：只有 reasoning_effort（low|medium|high(默认)|xhigh），无 thinking 块；
    // 官方明确「推理不可关闭」——内部 off 只能映射到最低档 low（直接发 off 会被拒），
    // max 映射到 xAI 的 xhigh。presence/frequency penalty 与 stop 在推理模型上被拒。
    supportsThinking: true,
    thinkingBlockType: 'none',
    effortCap: { off: 'low', max: 'xhigh' },
    supportsCacheControl: false,
    stripParams: ['frequency_penalty', 'presence_penalty', 'stop', 'top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    // 服务端自动 exact-prefix 缓存；x-grok-conv-id 走 wire（provider-catalog），
    // 与 deepseek-native 的「无需客户端断点」语义一致。
    prefixCacheStrategy: 'deepseek-native',
    supportsResponseFormat: false,
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
  // StepFun（阶跃星辰）官方 OpenAI 兼容端点。官方只提供 reasoning_effort 三档
  // （low/medium/high），没有 thinking block 形态 → 'none'（与 grok/openai 同款）。
  // 提示缓存是服务端隐式 exact-prefix（官方文档：缓存命中 0.35 元 / 1M tokens），
  // 无需客户端断点 → 'deepseek-native'（与 GLM/LongCat/硅基流动同款策略）。
  stepfun: {
    supportsThinking: true,
    thinkingBlockType: 'none',
    // 官方文档明示只有 low/medium/high——项目的 max 降到官方最高档、off 降到最低档。
    // 不设映射的后果与 kimi 条目记过的教训同型：向上游发它不认识的档位（或反过来的
    // 静默降档）会让用户显式选的推理强度落不了地。
    effortCap: { max: 'high', off: 'low' },
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'deepseek-native',
    supportsResponseFormat: true, // 官方支持 JSON Mode 与 JSON Schema
    // 刻意不设 preservedThinkingProtocol：StepFun 不是 DeepSeek 系线协议，套用
    // reasoning_content 回显与中文思考后缀是错配（该字段的语义见上方类型注释）。
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

/**
 * 会话内「推理档位」调档能否真正上线——桌面 EffortMenu / TUI 模型选择器共用判据。
 *
 * 不同协议路径不同：
 *   - openai：OpenAIClient 只在 thinking 分支且 `effortFormat !== 'none'` 时写
 *     `reasoning_effort`（见 openai-client 的 body 构建）。
 *   - openai-responses：ResponsesClient 直接写 `reasoning.effort`，不受 effortFormat 门控。
 *   - anthropic：档位在**建客户端时**换算成 `thinking.budget_tokens`；运行时
 *     setReasoningEffort 是空实现——会话内调档不生效。
 * 未声明 capabilities 的自定义 provider 走 DEFAULT_CAPABILITIES（effortFormat 'none'），
 * 档位会被静默丢弃：消费端必须据此禁用调档，而不是给「设置成功」的假反馈。
 */
export function resolveEffortSupported(
  providerName: string,
  provider: {
    protocol?: ProviderProtocol
    thinking?: 'enabled' | 'disabled'
    capabilities?: ProviderCapabilitiesConfig
  },
  modelCapabilities?: ProviderCapabilitiesConfig,
): boolean {
  if (provider.protocol === 'openai-responses') return true
  if (provider.protocol === 'anthropic') return false
  if (provider.thinking === 'disabled') return false
  return resolveCapabilities(providerName, provider.capabilities, modelCapabilities).effortFormat !== 'none'
}

/**
 * 内部档位 → 线上档位。返回 `undefined` = **不写该字段**。
 *
 * `off` 是**内部**档位（auto-reasoning 对琐碎轮降档；也可由用户显式选），它不是
 * 任何 OpenAI 协议端点的合法枚举值：原样发出会被网关按枚举校验拒收
 * `invalid_request_error: unknown variant 'off', expected one of
 * none|minimal|low|medium|high|xhigh|ultra|max`（issue #258，opencode 网关）。
 *
 * 两种正确表达，按优先级：
 *   1. provider 声明了 `effortCap`（如 `{ off: 'none' }` / `{ off: 'low' }`）→ 用声明值。
 *      这是 provider 自己给出的「该端点认识什么」的事实，优先于任何推断。
 *   2. 未声明 → **省略字段**。省略 = 不额外要求推理强度，是所有网关都接受的最保守
 *      表达；硬编码 `'none'` 会在只认 low|medium|high 的端点上再吃一次 400。
 *
 * `'off'` 自身永远不作为返回值——它就是本函数存在的理由。
 */
export function resolveWireEffort(
  effort: string | undefined,
  effortCap?: Record<string, string>,
): string | undefined {
  if (!effort) return undefined
  const mapped = effortCap?.[effort]
  if (mapped) return mapped
  return effort === 'off' ? undefined : effort
}
