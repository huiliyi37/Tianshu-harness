/**
 * Process-wide per-provider rate limiting (issue #75, opt-in).
 *
 * One bucket per provider key, shared by every client instance in this process —
 * concurrent workers/subagents hitting the same cheap provider get shaped
 * together. Not configured = zero overhead (callers get undefined). Cross-process
 * limits are out of scope: worker processes keep their own buckets.
 */
import { abortableDelay } from './retry-engine.js'

export interface RateLimitConfig {
  requestsPerSecond: number
  /** Burst allowance (requests that may pass back-to-back). Default: ceil(rps). */
  burst?: number
}

/**
 * Slot-reservation rate shaper. Each acquire reserves the next slot on a steady
 * timeline; a bucket of `burst` slots lets the first N calls through immediately
 * and then holds the 1/rps cadence. Reserving (rather than check-then-wait) keeps
 * concurrent callers from waking together and overshooting the configured rate.
 */
export class TokenBucket {
  private readonly intervalMs: number
  private readonly burst: number
  private nextSlotAt: number

  constructor(config: RateLimitConfig) {
    this.intervalMs = 1000 / config.requestsPerSecond
    this.burst = config.burst ?? Math.max(1, Math.ceil(config.requestsPerSecond))
    // Walk the timeline back (burst - 1) slots so the opening burst is immediate.
    this.nextSlotAt = Date.now() - (this.burst - 1) * this.intervalMs
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const now = Date.now()
    const earliest = now - (this.burst - 1) * this.intervalMs
    const slot = Math.max(earliest, this.nextSlotAt)
    this.nextSlotAt = slot + this.intervalMs
    const waitMs = Math.ceil(slot - now)
    if (waitMs <= 0) return
    await abortableDelay(waitMs, signal)
  }
}

interface RegisteredLimiter {
  fingerprint: string
  limiter: TokenBucket
}

const registry = new Map<string, RegisteredLimiter>()

/**
 * The process-wide bucket for `providerKey`, rebuilt when the config fingerprint
 * changes. Returns undefined when rate limiting is not configured.
 */
export function getProviderRateLimiter(providerKey: string, config?: RateLimitConfig): TokenBucket | undefined {
  if (!config || !(config.requestsPerSecond > 0)) return undefined
  const fingerprint = `${config.requestsPerSecond}:${config.burst ?? ''}`
  const existing = registry.get(providerKey)
  if (existing && existing.fingerprint === fingerprint) return existing.limiter
  const limiter = new TokenBucket(config)
  registry.set(providerKey, { fingerprint, limiter })
  return limiter
}

/** 测试专用：清空进程内注册表（防止跨用例共享桶）。 */
export function resetRateLimiterRegistry(): void {
  registry.clear()
}

/** 发请求前过桶的便捷入口——未配置 rateLimit 时零开销直接返回。 */
export async function acquireRateLimitSlot(
  providerKey: string,
  config: RateLimitConfig | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const limiter = getProviderRateLimiter(providerKey, config)
  if (limiter) await limiter.acquire(signal)
}
