import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { retryPolicySchema } from '../schema.js'

// ---------------------------------------------------------------------------
// provider.providers.<name>.retry — user-facing retry policy config surface
// ---------------------------------------------------------------------------

describe('retryPolicySchema', () => {
  it('parses a full policy', () => {
    const parsed = retryPolicySchema.parse({
      maxTotalRetries: 8,
      maxTotalDurationMs: 600_000,
      backoff: { baseDelayMs: 250, maxDelayMs: 30_000, jitterRatio: 0.3 },
      overrides: { rate_limit: { maxRetries: 8, retryDelayMs: 1000 } },
      rateLimit: { requestsPerSecond: 10, burst: 20 },
    })
    assert.equal(parsed.maxTotalRetries, 8)
    assert.equal(parsed.maxTotalDurationMs, 600_000)
    assert.equal(parsed.backoff?.jitterRatio, 0.3)
    assert.equal(parsed.overrides?.rate_limit?.maxRetries, 8)
    assert.equal(parsed.rateLimit?.requestsPerSecond, 10)
  })

  it('accepts an empty object — every field is optional', () => {
    const parsed = retryPolicySchema.parse({})
    assert.deepEqual(parsed, {})
  })

  it('rejects a typo\'d category key instead of silently ignoring it', () => {
    assert.throws(
      () => retryPolicySchema.parse({ overrides: { rate_limt: { maxRetries: 3 } } }),
      /Unrecognized key|rate_limt/,
    )
  })

  it('rejects out-of-range values', () => {
    assert.throws(() => retryPolicySchema.parse({ maxTotalRetries: 51 }))
    assert.throws(() => retryPolicySchema.parse({ maxTotalDurationMs: -1 }))
    assert.throws(() => retryPolicySchema.parse({ backoff: { jitterRatio: 6 } }))
    assert.throws(() => retryPolicySchema.parse({ rateLimit: { requestsPerSecond: 0 } }))
    assert.throws(() => retryPolicySchema.parse({ rateLimit: { burst: 0 } }))
  })

  it('accepts a zero budget (disables retries) and a zero jitter ratio', () => {
    const parsed = retryPolicySchema.parse({
      maxTotalRetries: 0,
      backoff: { jitterRatio: 0 },
    })
    assert.equal(parsed.maxTotalRetries, 0)
    assert.equal(parsed.backoff?.jitterRatio, 0)
  })
})
