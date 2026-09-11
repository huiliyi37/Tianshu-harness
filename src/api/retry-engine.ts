/**
 * Structured Retry Engine — uses the error classifier to decide retry strategy.
 *
 * Provides jittered exponential backoff, abort-aware delays, and a
 * generic `withStructuredRetry` wrapper for any async operation.
 */

import { classifyApiError } from './error-classifier.js'
import type { ClassifiedError, ErrorCategory } from './error-classifier.js'

// ---------------------------------------------------------------------------
// Jittered exponential backoff
// ---------------------------------------------------------------------------

/**
 * Compute a delay with full jitter on top of exponential backoff.
 *
 * Formula:
 *   base = min(baseDelay * 2^(attempt-1), maxDelay)
 *   jitter = random(0, jitterRatio * base)
 *   result = base + jitter
 */
export function jitteredBackoff(
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30_000,
  jitterRatio: number = 0.5,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, maxDelayMs)
  const jitter = Math.random() * jitterRatio * capped
  return capped + jitter
}

// ---------------------------------------------------------------------------
// Abort-aware delay
// ---------------------------------------------------------------------------

/**
 * Return a promise that resolves after `ms` milliseconds.
 * Rejects immediately with `AbortError` if the signal is already aborted
 * or becomes aborted while waiting.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout>

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
    }

    timer = setTimeout(() => {
      settled = true
      cleanup()
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function applyDelayJitter(delayMs: number): number {
  return delayWithJitter(delayMs, LEGACY_JITTER_RATIO)
}

/** 历史抖动比例——未配置时的默认，保持既有行为（+0~50%）。 */
const LEGACY_JITTER_RATIO = 0.5
const DEFAULT_BACKOFF_BASE_MS = 1000
const DEFAULT_BACKOFF_MAX_MS = 30_000

function delayWithJitter(delayMs: number, jitterRatio: number): number {
  return delayMs + Math.random() * jitterRatio * delayMs
}

// ---------------------------------------------------------------------------
// Retry types
// ---------------------------------------------------------------------------

/**
 * Terminal budget-exhaustion error thrown by `withStructuredRetry` when the
 * `maxTotalDurationMs` budget is spent. Distinct class (not just a message
 * pattern) so the engine's own catch can recognize it before the classifier —
 * its message matches no classifier pattern and would otherwise be judged
 * unknown/retryable, spinning one more backoff delay and drifting the
 * user-facing "across N attempt(s)" count (2026-08-09 911s 挂死事故遗留).
 */
export class RetryBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryBudgetExhaustedError'
  }
}

/** Exponential-backoff shape (config: provider.providers.<name>.retry.backoff). */
export interface RetryBackoffConfig {
  /** Backoff base (ms) — used when the category has no delay of its own. */
  baseDelayMs?: number
  /** Per-wait ceiling (ms). Default 30000. */
  maxDelayMs?: number
  /** Jitter ratio (0–2): wait = capped + random() × ratio × capped. Default 0.5. */
  jitterRatio?: number
}

/** Per-category retry overrides (config: retry.overrides.<category>). */
export interface RetryCategoryOverride {
  /** Retry ceiling for this category. Explicit values are no longer clamped
   *  down by the classifier default (an explicit maxTotalRetries still caps). */
  maxRetries?: number
  /** Wait base for this category (ms) — the exponential start when backoff is set. */
  retryDelayMs?: number
}

/** Optional retry policy carried from provider config. Absent = legacy behavior. */
export interface RetryPolicy {
  /** Setting this switches every retryable category onto a configurable
   *  exponential curve; leaving it out keeps the historical fixed-delay path. */
  backoff?: RetryBackoffConfig
  overrides?: Partial<Record<ErrorCategory, RetryCategoryOverride>>
}

export interface RetryOptions {
  /** Upper bound on total retry attempts. undefined = per-category classifier
   *  default (explicit values are NOT clamped down by this bound's default). */
  maxTotalRetries?: number
  /** Upper bound on total elapsed time in ms across all attempts (default: no limit).
   *  When exceeded, the current attempt is abandoned and an error is thrown.
   *  Prevents retry loops from running for tens of minutes on unresponsive providers. */
  maxTotalDurationMs?: number
  /** Retry policy from provider config (backoff curve + per-category overrides). */
  policy?: RetryPolicy
  /** Called before each retry with diagnostic info. */
  onRetry?: (info: RetryInfo) => void
}

export interface RetryInfo {
  /** 1-based attempt number (1 = first retry, not the initial call). */
  attempt: number
  /** Classified error that triggered this retry. */
  classified: ClassifiedError
  /** Delay in ms before the next attempt. */
  nextDelayMs: number
}

/**
 * Delay before the next attempt. Three regimes, checked in order:
 *
 *  1. Server named the wait (Retry-After) → fixed delay + jitter, never
 *     exponentiated — the server decides, not the curve.
 *  2. No backoff configured → historical behavior, unchanged: category fixed
 *     delay + 50% jitter, or jittered exponential when the category carries
 *     no delay of its own (retryDelayMs 0).
 *  3. backoff configured → unified exponential curve for every retryable
 *     category, based on the override/category delay (falling back to
 *     backoff.baseDelayMs when the category has none), capped by maxDelayMs.
 */
function computeNextDelay(
  attempt: number,
  classified: ClassifiedError,
  override: RetryCategoryOverride | undefined,
  backoff: RetryBackoffConfig | undefined,
): number {
  const categoryDelay = classified.retryDelayMs
  if (classified.retryDelayFromServer && categoryDelay > 0) {
    return delayWithJitter(categoryDelay, backoff?.jitterRatio ?? LEGACY_JITTER_RATIO)
  }
  if (!backoff) {
    return categoryDelay > 0 ? applyDelayJitter(categoryDelay) : jitteredBackoff(attempt)
  }
  const base = override?.retryDelayMs
    ?? (categoryDelay > 0 ? categoryDelay : (backoff.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS))
  return jitteredBackoff(attempt, base, backoff.maxDelayMs ?? DEFAULT_BACKOFF_MAX_MS, backoff.jitterRatio ?? LEGACY_JITTER_RATIO)
}

// ---------------------------------------------------------------------------
// Core retry loop
// ---------------------------------------------------------------------------

/**
 * Execute `fn` with structured retry based on classified errors.
 *
 * - Calls `fn()` once, then retries up to `min(classified.maxRetries, maxTotalRetries)` times.
 * - If the classifier says `!retryable`, the error is re-thrown immediately.
 * - Delay uses `classified.retryDelayMs` when > 0, otherwise falls back to `jitteredBackoff`.
 * - Respects `AbortSignal` — rejects with `AbortError` if aborted during a delay.
 */
export async function withStructuredRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  options?: RetryOptions,
): Promise<T> {
  // undefined = 未显式配置：重试上限由各 category 的分类器默认值决定。不注入
  // 隐式 5——全部可重试类别的默认值本就 ≤5，故默认行为不变，而显式配置不再被夹。
  const maxTotal = options?.maxTotalRetries
  const maxDuration = options?.maxTotalDurationMs
  const policy = options?.policy
  const startTime = maxDuration ? Date.now() : 0

  // attempt is 1-based and counts *retries* (not the initial call)
  for (let attempt = 0; ; attempt++) {
    try {
      // Check abort before attempting the call
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      // Check global duration budget
      if (maxDuration && Date.now() - startTime > maxDuration) {
        throw new RetryBudgetExhaustedError(
          `Retry budget exhausted: total retry time exceeded ${Math.round(maxDuration / 1000)}s ` +
          `across ${attempt} attempt(s). Provider may be unavailable — try again later or switch provider.`,
        )
      }

      return await fn()
    } catch (err: unknown) {
      // Engine-internal sentinel: budget exhaustion is terminal — rethrow
      // before classification. Feeding it to classifyApiError would judge it
      // unknown/retryable (its message matches no pattern) and burn one more
      // backoff delay while incrementing the attempt count in the message.
      if (err instanceof RetryBudgetExhaustedError) {
        throw err
      }

      const classified = classifyApiError(err)

      // Non-retryable → propagate immediately
      if (!classified.retryable) {
        throw err
      }

      // Retry ceiling — explicit user config wins, classifier is the fallback:
      //   1. overrides[category].maxRetries → 该类别显式值（仍受显式 maxTotalRetries 夹取）
      //   2. 显式 maxTotalRetries → 直接生效（抬升分类器默认，消除「调了不生效」）
      //   3. 两者都无 → 分类器默认（历史行为）
      // stripImages 类别带一次性语义（只 strip 一次）：显式全局值只允许收紧。
      const override = policy?.overrides?.[classified.category]
      let effectiveMax: number
      if (override?.maxRetries !== undefined) {
        effectiveMax = maxTotal !== undefined ? Math.min(override.maxRetries, maxTotal) : override.maxRetries
      } else if (maxTotal !== undefined) {
        effectiveMax = classified.stripImages === true ? Math.min(classified.maxRetries, maxTotal) : maxTotal
      } else {
        effectiveMax = classified.maxRetries
      }

      // +1 because `attempt` starts at 0 (the initial call is attempt 0,
      // first retry is attempt 1, etc.)
      if (attempt + 1 > effectiveMax) {
        throw err
      }

      // Delay decision — server instruction > configured curve > legacy path.
      const nextDelayMs = computeNextDelay(attempt + 1, classified, override, policy?.backoff)

      // Notify caller
      options?.onRetry?.({
        attempt: attempt + 1,
        classified,
        nextDelayMs,
      })

      // Budget guard（核验补漏）: the budget is only checked at the top of each
      // attempt, so a wait longer than the remaining budget would sleep to
      // completion first — a server Retry-After of 30min hangs 30min despite a
      // 10s maxTotalDurationMs. The next top-of-loop check is certain to fail
      // in that case, so predict it and terminate before waiting.
      if (maxDuration) {
        const elapsed = Date.now() - startTime
        if (elapsed + nextDelayMs > maxDuration) {
          throw new RetryBudgetExhaustedError(
            `Retry budget exhausted: total retry time would exceed ${Math.round(maxDuration / 1000)}s ` +
            `across ${attempt + 1} attempt(s) (next wait ${Math.round(nextDelayMs / 1000)}s > ` +
            `remaining ${Math.round((maxDuration - elapsed) / 1000)}s). ` +
            `Provider may be unavailable — try again later or switch provider.`,
          )
        }
      }

      // Wait (abort-aware)
      await abortableDelay(nextDelayMs, signal)
    }
  }
}
