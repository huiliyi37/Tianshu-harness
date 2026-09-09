/**
 * Provider Catalog — the single source of truth for built-in provider knowledge.
 *
 * Consolidates what used to be scattered across three files:
 *   - PROVIDER_REGISTRY (labels/notes + a duplicated capability zod schema,
 *     was in provider-registry.ts — deleted; its copied schema had already
 *     drifted from the runtime capability fields)
 *   - wire miscellany (useMaxCompletionTokens / userAgent / thinking-stall
 *     defaults, was hardcoded on providerName in factory.ts)
 *   - capability references (entries point directly at WELL_KNOWN_DEFAULTS in
 *     provider.ts — the capability DATA stays there; this file never copies it,
 *     so drift is structurally impossible)
 * Cache profiles stay in provider-profile.ts (single-sourced there already);
 * the derived ProviderEntry view references them.
 *
 * Adding a provider = one WELL_KNOWN_DEFAULTS entry in provider.ts (or an
 * addCatalogEntry call from a pro module) + optional label/notes/wire here.
 * resolveCapabilities, the factory wire behavior, the conformance scorecard
 * and provider listings all read through this file.
 */

import { z } from 'zod'
import type { ProviderCapabilities } from './provider.js'
import { WELL_KNOWN_DEFAULTS } from './provider.js'
import { getProviderCacheDefaults } from './provider-profile.js'

// ─── Wire behavior ───────────────────────────────────────────

/** Per-provider wire quirks that are neither capabilities nor config. */
export interface ProviderWireConfig {
  /** Use max_completion_tokens instead of max_tokens (MiMo requires this per API docs). */
  useMaxCompletionTokens?: boolean
  /** Custom User-Agent for the upstream API. */
  userAgent?: string
  /**
   * Thinking-stall default (ms) for providers prone to stalling on pure
   * thinking phases. undefined = disabled (falls back to read timeout).
   * Semantics: chunk-idle window, not total duration — far below the 300s
   * read fallback, far above legitimate reasoning-delta gaps.
   * - glm 420s: GLM reasoning legitimately pauses for minutes.
   * - deepseek 120s: observed server-side "2 reasoning chars then silence"
   *   stalls; aborting early + retrying hits ~100% prefix cache (~12s recovery).
   */
  thinkingStallTimeoutMs?: number
}

// ─── Catalog entry ───────────────────────────────────────────

export interface CatalogEntry {
  /** Provider key used in config (e.g. 'deepseek', 'openai'). */
  key: string
  /** Human-readable label. */
  label: string
  /** Runtime capabilities — a live reference into WELL_KNOWN_DEFAULTS, never a copy. */
  capabilities: ProviderCapabilities
  /** Wire quirks consumed by the client factory. */
  wire?: ProviderWireConfig
  /** Known issues / integration notes (shown in listings and scorecards). */
  notes: string[]
}

// ─── Metadata (labels / wire / notes) ────────────────────────

interface CatalogMeta {
  label: string
  wire?: ProviderWireConfig
  notes: string[]
}

const CATALOG_META: Record<string, CatalogMeta> = {
  deepseek: {
    label: 'DeepSeek',
    wire: { thinkingStallTimeoutMs: 120_000 },
    notes: [
      'Exact-prefix cache: first 2 messages must remain stable for 99% hit rate',
      'Thinking block: {type: enabled} + reasoning_effort',
    ],
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    wire: { userAgent: 'KimiCLI/1.0' },
    notes: [
      'Thinking block: {type: enabled} + reasoning_effort',
      'K3 / K3-256K: reasoning_effort low|high|max (default high); K2.7 Code is Thinking:ON only',
      'No prefix cache support',
    ],
  },
  glm: {
    label: 'GLM (Zhipu)',
    wire: { thinkingStallTimeoutMs: 420_000 },
    notes: [
      'OpenAI-compatible protocol via /api/paas/v4',
      'Thinking block: {type: enabled} + reasoning_effort',
      'Implicit exact-prefix cache (cached_tokens in prompt_tokens_details), 1M context',
    ],
  },
  minimax: {
    label: 'MiniMax',
    wire: { useMaxCompletionTokens: true },
    notes: [
      'MiniMax-M3: 1M context, multimodal (image/video)',
      'Uses max_completion_tokens instead of max_tokens',
      'Thinking block: {type: adaptive} + reasoning_split',
      'No prefix cache support',
    ],
  },
  mimo: {
    label: 'Mimo',
    wire: { useMaxCompletionTokens: true },
    notes: [
      'Thinking block: {type: enabled}',
      'No thinking effort control',
      'No cache support',
    ],
  },
  'mimo-api': {
    label: 'MiMo API',
    wire: { useMaxCompletionTokens: true },
    notes: [
      'Pay-as-you-go MiMo API endpoint',
      'Thinking block: {type: enabled}',
      'Exact-prefix cache like DeepSeek',
    ],
  },
  'opencode-go': {
    label: 'OpenCode Go',
    notes: [
      'No thinking block (effort passthrough only)',
      'No thinking effort control',
      'No cache support',
    ],
  },
  openai: {
    label: 'OpenAI',
    notes: [
      'Partial-prefix cache with 128-token granularity',
      'Ephemeral cache (5 min TTL)',
    ],
  },
  codex: {
    label: 'Codex',
    notes: [
      'Uses Codex Responses API with OAuth authentication',
      'Partial-prefix cache profile is provided by provider-profile.ts',
    ],
  },
  claude: {
    label: 'Claude (Anthropic)',
    notes: [
      'Thinking block: {type: enabled} + budget_tokens',
      'Reasoning effort via reasoning_effort parameter',
    ],
  },
  longcat: {
    label: 'LongCat (Meituan)',
    notes: [
      'API supports only model/messages/stream/max_tokens/temperature/top_p — no response_format',
      'Implicit server-side exact-prefix cache, cache hits free (official pricing)',
      'JSON repair must run as plain-text re-ask (no json-mode)',
    ],
  },
  ccswitch: {
    label: 'CC Switch',
    notes: [
      `本地 OpenAI 兼容代理，默认 ${process.env.CC_SWITCH_PROXY_URL ?? 'http://127.0.0.1:8891/v1'}`,
      '认证使用 CC_SWITCH_PROXY_API_KEY 环境变量',
      '模型名透传——可用模型取决于 cc-switch 侧配置',
      '⚠️ 预设模型列表为种子，使用前确认模型名与 cc-switch 侧一致，否则会 4xx',
      '支持 reasoning_effort（OpenAI 格式），Rectifier 层翻译为上游原生推理格式',
    ],
  },
  siliconflow: {
    label: '硅基流动 (SiliconFlow)',
    notes: [
      '聚合站：多模型可选（DeepSeek / GLM / Kimi / Qwen）',
      'Thinking block: {type: enabled} + reasoning_effort（上游支持）',
      '服务端隐式 exact-prefix 缓存（DeepSeek-V4 / GLM-5.2 计 Cached Input 价）',
      '默认模型是 DeepSeek 代理 → 沿用 toolJsonBug 标记',
    ],
  },
  dashscope: {
    label: '通义千问 (DashScope)',
    notes: [
      '阿里 DashScope：Qwen 系列官方 OpenAI 兼容端点',
      'Thinking block: {type: enabled} + reasoning_effort（Qwen3-max 支持）',
      '模型能力分裂：Qwen-plus/turbo 不支持 thinking → 用 models[].capabilities override',
      '不支持 cache_control breakpoint（非 Anthropic 协议）',
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    notes: [
      '国际聚合：OpenAI / Claude / Gemini / 开源模型',
      'thinking block 透传不稳定 → thinkingBlockType=none，仅透传 reasoning_effort',
      '用户可按需在 models[].capabilities 里为特定模型开启 thinking',
    ],
  },
  relay: {
    label: '自建中转 (one-api / new-api)',
    notes: [
      '通用 OpenAI 兼容中转模板（one-api / new-api / litellm 等）',
      '默认 config 不激活——用户手动启用，避免和 ccswitch 体验重复',
      'baseUrl 走 RELAY_BASE_URL 环境变量；模型列表按需填写',
      '与 ccswitch 同模板：reasoning_effort 透传，Rectifier 翻译为上游原生格式',
    ],
  },
}

// ─── Catalog assembly ────────────────────────────────────────

function buildEntry(key: string): CatalogEntry {
  const meta = CATALOG_META[key]
  return {
    key,
    label: meta?.label ?? key,
    // Live reference — capability data lives in provider.ts WELL_KNOWN_DEFAULTS.
    capabilities: WELL_KNOWN_DEFAULTS[key]!,
    wire: meta?.wire,
    notes: meta?.notes ?? [],
  }
}

/** Canonical provider catalog: every WELL_KNOWN provider gets an entry. */
export const PROVIDER_CATALOG: Record<string, CatalogEntry> = Object.fromEntries(
  Object.keys(WELL_KNOWN_DEFAULTS).map(key => [key, buildEntry(key)]),
)

// ─── Lookup functions ────────────────────────────────────────

export function getCatalogEntry(key: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG[key]
}

export function listCatalogEntries(): CatalogEntry[] {
  return Object.values(PROVIDER_CATALOG)
}

export function isCatalogProvider(key: string): boolean {
  return key in PROVIDER_CATALOG
}

/**
 * Register or replace a catalog entry at runtime (pro-module providers such
 * as spark use this; open-source builds never call it). Capabilities must
 * already exist in WELL_KNOWN_DEFAULTS or be supplied here — they become the
 * resolveCapabilities base for this provider.
 */
export function addCatalogEntry(
  key: string,
  capabilities: ProviderCapabilities,
  meta?: { label?: string; wire?: ProviderWireConfig; notes?: string[] },
): CatalogEntry {
  WELL_KNOWN_DEFAULTS[key] = capabilities
  const entry: CatalogEntry = {
    key,
    label: meta?.label ?? key,
    capabilities,
    wire: meta?.wire,
    notes: meta?.notes ?? [],
  }
  PROVIDER_CATALOG[key] = entry
  return entry
}

// ─── Derived ProviderEntry view (conformance scorecard shape) ─

export const providerEntrySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  capabilities: z.object({
    supportsThinking: z.boolean(),
    thinkingBlockType: z.enum(['enabled', 'adaptive', 'none']),
    preservedThinkingProtocol: z.boolean().optional(),
    reasoningSplit: z.boolean().optional(),
    thinkingBudgetField: z.enum(['budget_tokens']).optional(),
    effortCap: z.record(z.string(), z.string()).optional(),
    supportsCacheControl: z.boolean(),
    stripParams: z.array(z.string()),
    hasToolJsonInContentBug: z.boolean(),
    effortFormat: z.enum(['reasoning_effort', 'output_config', 'none']),
    prefixCacheStrategy: z.enum(['deepseek-native', 'anthropic-cache-control', 'none']),
    supportsResponseFormat: z.boolean(),
  }),
  cacheProfile: z.object({
    cacheType: z.enum(['exact-prefix', 'explicit-breakpoint', 'partial-prefix', 'block-kv', 'none']),
    persistent: z.boolean(),
    minCacheTokens: z.number().int().nonnegative(),
    cacheGranularity: z.number().int().positive().optional(),
    ttlSeconds: z.number().int().positive().optional(),
  }),
  hasUsageMapping: z.boolean(),
  notes: z.array(z.string()).default([]),
})

export type ProviderEntry = z.infer<typeof providerEntrySchema>

/**
 * Materialize the scorecard-facing view for a catalog entry: capability
 * snapshot + cache profile (from provider-profile.ts) + usage-mapping flag.
 */
export function getProviderEntry(key: string): ProviderEntry | undefined {
  const entry = PROVIDER_CATALOG[key]
  if (!entry) return undefined
  const caps = entry.capabilities
  const profile = getProviderCacheDefaults(key)
  return {
    key,
    label: entry.label,
    capabilities: {
      supportsThinking: caps.supportsThinking,
      thinkingBlockType: caps.thinkingBlockType,
      preservedThinkingProtocol: caps.preservedThinkingProtocol,
      reasoningSplit: caps.reasoningSplit,
      thinkingBudgetField: caps.thinkingBudgetField,
      effortCap: caps.effortCap ? { ...caps.effortCap } : undefined,
      supportsCacheControl: caps.supportsCacheControl,
      stripParams: [...caps.stripParams],
      hasToolJsonInContentBug: caps.hasToolJsonInContentBug,
      effortFormat: caps.effortFormat,
      prefixCacheStrategy: caps.prefixCacheStrategy,
      supportsResponseFormat: caps.supportsResponseFormat,
    },
    cacheProfile: {
      cacheType: profile.cacheType,
      persistent: profile.persistent,
      minCacheTokens: profile.minCacheTokens,
      cacheGranularity: profile.cacheGranularity,
      ttlSeconds: profile.ttlSeconds,
    },
    hasUsageMapping: caps.mapUsage !== undefined,
    notes: [...entry.notes],
  }
}
