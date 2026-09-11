/**
 * Retry Policy — runtime view of the user-facing retry knobs.
 *
 * `retry-engine.ts` owns the retry *loop*; `error-classifier.ts` owns the
 * built-in per-category defaults. This module is the seam between them and the
 * user's `config.json` (`provider.providers.<name>.retry`): it re-exports the
 * config-schema types under names the engine can use and provides the pure
 * resolvers that turn a partial user policy into concrete delay parameters.
 *
 * Design notes:
 * - Everything is optional. An absent field (or an absent `retry` block) must
 *   reproduce the pre-existing behavior exactly — no silent behavior change for
 *   users who never touch this config.
 * - `maxTotalRetries` is a hard global *ceiling*; per-category overrides raise a
 *   category's own budget but are still clamped by the ceiling (see
 *   `withStructuredRetry`). That preserves the historical
 *   `min(classified.maxRetries, maxTotalRetries)` semantics while fixing the
 *   trap where raising the provider-level `maxRetries` alone did nothing for
 *   429 — the classifier's own cap of 5 won the `Math.min`.
 * - The types are *derived* from `src/config/schema.ts` rather than redeclared
 *   so the zod schema and the runtime contract cannot drift.
 */

import type { ErrorCategory } from './error-classifier.js'
import type { RetryPolicyConfig } from '../config/schema.js'

export type { RetryPolicyConfig }

/** Shape of the jittered exponential backoff. */
export type RetryBackoffConfig = NonNullable<RetryPolicyConfig['backoff']>
/** Opt-in client-side rate limit (token bucket) for one provider. */
export type RetryRateLimitConfig = NonNullable<RetryPolicyConfig['rateLimit']>
/** Per-category retry budget override. */
export type RetryCategoryOverride = NonNullable<NonNullable<RetryPolicyConfig['overrides']>[ErrorCategory]>

// ---------------------------------------------------------------------------
// Built-in defaults (must match the historical hardcoded values)
// ---------------------------------------------------------------------------

/** Historical defaults of `jitteredBackoff()`. Do not change without a
 *  migration note — every session that never sets `retry` depends on these. */
export const DEFAULT_RETRY_BACKOFF = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterRatio: 0.5,
} as const

export interface ResolvedBackoff {
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

/**
 * Fill in missing backoff fields with the built-in defaults.
 *
 * `??` (not `||`) everywhere: `jitterRatio: 0` and `baseDelayMs: 0` are legal,
 * meaningful values (disable jitter / retry immediately) that a truthy check
 * would silently drop — the same class of bug called out in
 * `applyAdvancedConfig()`.
 */
export function resolveBackoff(backoff?: RetryBackoffConfig): ResolvedBackoff {
  return {
    baseDelayMs: backoff?.baseDelayMs ?? DEFAULT_RETRY_BACKOFF.baseDelayMs,
    maxDelayMs: backoff?.maxDelayMs ?? DEFAULT_RETRY_BACKOFF.maxDelayMs,
    jitterRatio: backoff?.jitterRatio ?? DEFAULT_RETRY_BACKOFF.jitterRatio,
  }
}

/** True when the user asked for a client-side rate limit. */
export function isRateLimitEnabled(
  config?: RetryRateLimitConfig,
): config is RetryRateLimitConfig & { requestsPerSecond: number } {
  return typeof config?.requestsPerSecond === 'number' && config.requestsPerSecond > 0
}
