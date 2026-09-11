import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RETRY_BACKOFF,
  resolveBackoff,
  isRateLimitEnabled,
} from '../retry-policy.js'
import {
  acquireProviderSlot,
  resetRateLimiterRegistry,
} from '../rate-limiter.js'

// ---------------------------------------------------------------------------
// resolveBackoff — partial config fills with historical defaults
// ---------------------------------------------------------------------------

describe('resolveBackoff', () => {
  it('fills every field with the built-in defaults when no config is given', () => {
    const resolved = resolveBackoff(undefined)
    assert.equal(resolved.baseDelayMs, DEFAULT_RETRY_BACKOFF.baseDelayMs)
    assert.equal(resolved.maxDelayMs, DEFAULT_RETRY_BACKOFF.maxDelayMs)
    assert.equal(resolved.jitterRatio, DEFAULT_RETRY_BACKOFF.jitterRatio)
  })

  it('keeps user values and fills only the missing fields', () => {
    const resolved = resolveBackoff({ baseDelayMs: 250, jitterRatio: 0 })
    assert.equal(resolved.baseDelayMs, 250)
    assert.equal(resolved.maxDelayMs, DEFAULT_RETRY_BACKOFF.maxDelayMs)
    assert.equal(resolved.jitterRatio, 0, 'explicit 0 must not be treated as absent')
  })

  it('treats 0 as a legal value, not a missing one (no `||` bug)', () => {
    const resolved = resolveBackoff({ baseDelayMs: 0, maxDelayMs: 0 })
    assert.equal(resolved.baseDelayMs, 0)
    assert.equal(resolved.maxDelayMs, 0)
  })
})

// ---------------------------------------------------------------------------
// isRateLimitEnabled
// ---------------------------------------------------------------------------

describe('isRateLimitEnabled', () => {
  it('is false when config is absent', () => {
    assert.equal(isRateLimitEnabled(undefined), false)
  })

  it('is false when requestsPerSecond is absent or not positive', () => {
    assert.equal(isRateLimitEnabled({}), false)
    assert.equal(isRateLimitEnabled({ requestsPerSecond: 0 }), false)
    assert.equal(isRateLimitEnabled({ requestsPerSecond: -1 }), false)
  })

  it('is true when requestsPerSecond is positive', () => {
    assert.equal(isRateLimitEnabled({ requestsPerSecond: 10 }), true)
  })
})

// ---------------------------------------------------------------------------
// acquireProviderSlot — pacing, FIFO order, off-by-default
// ---------------------------------------------------------------------------

describe('acquireProviderSlot', () => {
  it('is a no-op when the limiter is disabled', async () => {
    resetRateLimiterRegistry()
    const t0 = Date.now()
    await Promise.all([1, 2, 3, 4].map(() => acquireProviderSlot('prov', undefined)))
    assert.ok(Date.now() - t0 < 100, 'disabled limiter must not pace')
  })

  it('paces acquisitions to the configured rate (loose timing bounds)', async () => {
    resetRateLimiterRegistry()
    // 20 req/s, burst 1 → one token every 50ms after the first.
    const t0 = Date.now()
    await Promise.all([1, 2, 3, 4].map(() => acquireProviderSlot('prov', { requestsPerSecond: 20, burst: 1 })))
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= 120, `expected >= ~150ms for 4 slots at 20/s, got ${elapsed}ms`)
    assert.ok(elapsed < 1500, `expected bounded pacing, got ${elapsed}ms`)
  })

  it('releases one waiter per token period (FIFO order preserved)', async () => {
    resetRateLimiterRegistry()
    const order: number[] = []
    const acquire = async (i: number): Promise<void> => {
      await acquireProviderSlot('fifo', { requestsPerSecond: 20, burst: 1 })
      order.push(i)
    }
    await Promise.all([1, 2, 3].map(i => acquire(i)))
    assert.deepEqual(order, [1, 2, 3], 'acquisitions must resolve in call order')
  })

  it('shares one bucket across callers with the same key', async () => {
    resetRateLimiterRegistry()
    // Two independent callers, same provider key → the bucket is shared, so the
    // second caller waits for the first one's token rather than starting fresh.
    const t0 = Date.now()
    const a = acquireProviderSlot('shared', { requestsPerSecond: 20, burst: 1 })
    const b = acquireProviderSlot('shared', { requestsPerSecond: 20, burst: 1 })
    await Promise.all([a, b])
    assert.ok(Date.now() - t0 >= 40, 'second caller must wait for the shared bucket')
  })

  it('resets cleanly between tests', async () => {
    resetRateLimiterRegistry()
    await acquireProviderSlot('prov', { requestsPerSecond: 100 })
    resetRateLimiterRegistry()
    const t0 = Date.now()
    await acquireProviderSlot('prov', { requestsPerSecond: 100 })
    assert.ok(Date.now() - t0 < 100, 'a fresh bucket must not inherit debt from a previous run')
  })
})
