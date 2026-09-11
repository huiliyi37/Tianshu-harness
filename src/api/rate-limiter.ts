/**
 * Client-side request rate limiter — opt-in token bucket, one bucket per
 * provider.
 *
 * Why this exists: retries only react to a 429 the server already sent. Under
 * concurrency (multiple subagents / a team wave), several workers can stampede
 * the same provider quota and every one of them eats a 429 plus its backoff,
 * which is strictly slower than pacing the requests in the first place. The
 * limiter lets a user declare "this provider tolerates N req/s" and paces
 * requests before they leave the process.
 *
 * Semantics:
 * - Off by default. `retry.rateLimit.requestsPerSecond` absent/<= 0 = no
 *   behavior change at all.
 * - Buckets are keyed by provider and stored in a module-level registry, so a
 *   freshly constructed client (the factory builds one per request) joins the
 *   bucket its siblings are already using instead of getting a private one.
 * - Acquisitions are FIFO-serialized: a caller that must wait holds the queue
 *   until it has consumed its token, so N simultaneous callers are released
 *   one per token period rather than all at once on the next refill.
 */

import { abortableDelay } from './retry-engine.js'
import { isRateLimitEnabled, type RetryRateLimitConfig } from './retry-policy.js'

class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  /** Tail of the FIFO acquisition chain (see `acquire`). */
  private tail: Promise<void> = Promise.resolve()

  constructor(
    /** Tokens added per millisecond. */
    private readonly ratePerMs: number,
    private readonly capacity: number,
    now: number,
  ) {
    this.tokens = capacity
    this.lastRefillMs = now
  }

  /** Add the tokens accrued since the last call, capped at `capacity`. */
  private refill(now: number): void {
    const elapsed = now - this.lastRefillMs
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs)
    this.lastRefillMs = now
  }

  /** Resolve once one token has been consumed (waiting if necessary). */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    // Chain onto the previous waiter. Holding the queue across the wait is the
    // point: it serializes token assignment and preserves call order.
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous

    try {
      this.refill(Date.now())
      if (this.tokens < 1) {
        const waitMs = Math.ceil((1 - this.tokens) / this.ratePerMs)
        await abortableDelay(waitMs, signal)
        this.refill(Date.now())
      }
      // Clamp rather than assert: Math.ceil on the wait can leave tokens a
      // hair below 1 after timer rounding, and a sub-millisecond overshoot is
      // not worth another sleep round.
      this.tokens = Math.max(0, this.tokens - 1)
    } finally {
      release()
    }
  }
}

interface RegisteredBucket {
  bucket: TokenBucket
  requestsPerSecond: number
  burst: number
}

const registry = new Map<string, RegisteredBucket>()

/**
 * Consume one request slot for `key`, waiting if the provider is at its
 * configured rate. No-op when the limiter is disabled.
 *
 * `key` should identify the quota being protected — the provider name (two
 * providers sharing one upstream quota is the user's call to make; we key by
 * provider so config stays local to the entry that declared it).
 */
export function acquireProviderSlot(
  key: string,
  config?: RetryRateLimitConfig,
  signal?: AbortSignal,
): Promise<void> {
  if (!isRateLimitEnabled(config)) return Promise.resolve()

  const requestsPerSecond = config.requestsPerSecond
  const burst = config.burst ?? Math.max(1, Math.ceil(requestsPerSecond))
  const existing = registry.get(key)

  // Rebuild on config change so an edited rate takes effect without a restart.
  if (
    !existing
    || existing.requestsPerSecond !== requestsPerSecond
    || existing.burst !== burst
  ) {
    const bucket = new TokenBucket(requestsPerSecond / 1000, burst, Date.now())
    registry.set(key, { bucket, requestsPerSecond, burst })
    return bucket.acquire(signal)
  }

  return existing.bucket.acquire(signal)
}

/** Drop all registry state. Test helper — keeps buckets from leaking across cases. */
export function resetRateLimiterRegistry(): void {
  registry.clear()
}
