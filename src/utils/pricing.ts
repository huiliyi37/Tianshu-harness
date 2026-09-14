import type { ModelConfig, ProviderConfig } from '../config/schema.js'
import type { Usage } from '../api/types.js'

export interface CostBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

const EMPTY_BREAKDOWN: CostBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
}

/**
 * Compute dollar cost from token usage and per-model pricing.
 * Prices are per 1M tokens (the conventional unit in model cards).
 * Returns zero breakdown when pricing is unavailable.
 */
export function computeUsageCost(
  usage: Partial<Usage> | undefined,
  pricing: ModelConfig['pricing'],
): CostBreakdown {
  if (!usage || !pricing) return { ...EMPTY_BREAKDOWN }

  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const reasoningTokens = usage.reasoning_tokens ?? 0

  // Usage.input_tokens is cache-INCLUSIVE (see api/types.ts): cache read and
  // cache write are both subsets. Bill each bucket exactly once — previously
  // cacheWrite tokens were billed twice (inside uncached input AND at the
  // cacheWrite rate), overstating DeepSeek miss cost 2x.
  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)

  const inputCost = (uncachedInputTokens / 1_000_000) * (pricing.input ?? 0)
  const outputCost = (outputTokens / 1_000_000) * (pricing.output ?? 0)
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.cacheRead ?? pricing.input ?? 0)
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cacheWrite ?? pricing.input ?? 0)
  const reasoningCost = reasoningTokens > 0
    ? (reasoningTokens / 1_000_000) * (pricing.reasoning ?? pricing.output ?? 0)
    : 0

  const round = (v: number) => Math.round(v * 1_000_000) / 1_000_000
  return {
    input: round(inputCost),
    output: round(outputCost),
    cacheRead: round(cacheReadCost),
    cacheWrite: round(cacheWriteCost),
    reasoning: round(reasoningCost),
    total: round(inputCost + outputCost + cacheReadCost + cacheWriteCost + reasoningCost),
  }
}

/** Format a dollar amount for display (e.g. "$0.0012"). */
export function formatCost(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.0001) return '<$0.0001'
  return `$${value.toFixed(4).replace(/\.?0+$/, '')}`
}

/** Format token count with k/M suffixes. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Look up pricing for a concrete provider + model id. */
export function findModelPricing(
  providers: Record<string, ProviderConfig>,
  providerName: string | undefined,
  modelId: string | undefined,
): ModelConfig['pricing'] {
  if (!providerName || !modelId) return undefined
  const provider = providers[providerName]
  if (!provider) return undefined
  return provider.models.find(m => m.id === modelId)?.pricing
}
