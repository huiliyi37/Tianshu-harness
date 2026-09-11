/**
 * Structured Retry Engine — uses the error classifier to decide retry strategy.
 *
 * Provides jittered exponential backoff, abort-aware delays, and a
 * generic `withStructuredRetry` wrapper for any async operation.
 */

import { classifyApiError } from './error-classifier.js'
import type { ClassifiedError } from './error-classifier.js'

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
  return delayMs + Math.random() * delayMs * 0.5
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

export interface RetryOptions {
  /** Upper bound on total retry attempts (default: 5). */
  maxTotalRetries?: number
  /** Upper bound on total elapsed time in ms across all attempts (default: no limit).
   *  When exceeded, the current attempt is abandoned and an error is thrown.
   *  Prevents retry loops from running for tens of minutes on unresponsive providers. */
  maxTotalDurationMs?: number
  /**
   * Called before each retry with diagnostic info. Return `false` to veto the
   * pending retry: the original error is rethrown immediately (no backoff) when
   * the caller can prove the retry cannot succeed — e.g. an `image_strip`
   * recovery whose request carries no image part to remove. A `void` return
   * leaves the normal retry schedule untouched.
   */
  onRetry?: (info: RetryInfo) => void | false
}

export interface RetryInfo {
  /** 1-based attempt number (1 = first retry, not the initial call). */
  attempt: number
  /** Classified error that triggered this retry. */
  classified: ClassifiedError
  /** Delay in ms before the next attempt. */
  nextDelayMs: number
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
  const maxTotal = options?.maxTotalRetries ?? 5
  const maxDuration = options?.maxTotalDurationMs
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

      // The effective ceiling is the lower of the error's maxRetries and
      // the caller's global maxTotalRetries.
      const effectiveMax = Math.min(classified.maxRetries, maxTotal)

      // +1 because `attempt` starts at 0 (the initial call is attempt 0,
      // first retry is attempt 1, etc.)
      if (attempt + 1 > effectiveMax) {
        throw err
      }

      // Compute delay: prefer classifier-provided delay when present,
      // otherwise fall back to jittered exponential backoff.
      const nextDelayMs =
        classified.retryDelayMs > 0
          ? applyDelayJitter(classified.retryDelayMs)
          : jitteredBackoff(attempt + 1)

      // Notify caller. A `false` return vetoes this retry: the caller proved it
      // cannot help (e.g. image_strip with no image part to remove), so rethrow
      // the original error at once instead of sleeping into a doomed attempt.
      const veto = options?.onRetry?.({
        attempt: attempt + 1,
        classified,
        nextDelayMs,
      })
      if (veto === false) {
        throw err
      }

      // Wait (abort-aware)
      await abortableDelay(nextDelayMs, signal)
    }
  }
}
