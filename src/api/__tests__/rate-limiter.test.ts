import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { TokenBucket, getProviderRateLimiter, resetRateLimiterRegistry } from '../rate-limiter.js'

// 时间敏感的断言一律大幅放宽（CI 抖动），只兜住「立即 / 被整形」这个定性差别。

describe('TokenBucket', () => {
  it('lets the initial burst through without waiting', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 20, burst: 3 }) // interval 50ms
    const started = Date.now()
    await bucket.acquire()
    await bucket.acquire()
    await bucket.acquire()
    const elapsed = Date.now() - started
    assert.ok(elapsed < 25, `burst of 3 should be immediate, took ${elapsed}ms`)
  })

  it('shapes the rate after the burst is spent', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 100, burst: 1 }) // interval 10ms
    const started = Date.now()
    await bucket.acquire()
    await bucket.acquire()
    await bucket.acquire()
    const elapsed = Date.now() - started
    // Two follow-up requests each wait ~10ms.
    assert.ok(elapsed >= 15, `expected ≥15ms of shaping, got ${elapsed}ms`)
    assert.ok(elapsed < 200, `expected <200ms, got ${elapsed}ms`)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 1 })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => bucket.acquire(controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })
})

describe('getProviderRateLimiter', () => {
  beforeEach(() => resetRateLimiterRegistry())

  it('returns undefined when no config is given (feature off by default)', () => {
    assert.equal(getProviderRateLimiter('p1'), undefined)
  })

  it('shares one bucket per provider key', () => {
    const a = getProviderRateLimiter('p1', { requestsPerSecond: 5 })
    const b = getProviderRateLimiter('p1', { requestsPerSecond: 5 })
    assert.ok(a !== undefined && b !== undefined)
    assert.equal(a, b, 'same key + same config must reuse the bucket (cross-instance sharing)')
  })

  it('rebuilds the bucket when the config fingerprint changes', () => {
    const a = getProviderRateLimiter('p1', { requestsPerSecond: 5 })
    const b = getProviderRateLimiter('p1', { requestsPerSecond: 9 })
    assert.ok(a !== undefined && b !== undefined)
    assert.notEqual(a, b)
  })

  it('keeps different providers isolated', () => {
    const a = getProviderRateLimiter('p1', { requestsPerSecond: 5 })
    const b = getProviderRateLimiter('p2', { requestsPerSecond: 5 })
    assert.ok(a !== undefined && b !== undefined)
    assert.notEqual(a, b)
  })
})
