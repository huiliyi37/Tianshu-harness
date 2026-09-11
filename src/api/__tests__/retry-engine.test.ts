import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  jitteredBackoff,
  abortableDelay,
  withStructuredRetry,
  RetryBudgetExhaustedError,
} from '../retry-engine.js'
import type { RetryInfo } from '../retry-engine.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mimics the ApiError class from client.ts. */
class FakeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Create a function that fails N times then returns `value`. */
function flakyFactory<T>(value: T, failCount: number, status = 500): () => Promise<T> {
  let calls = 0
  return async () => {
    calls++
    if (calls <= failCount) {
      throw new FakeApiError(`Server error (${status})`, status)
    }
    return value
  }
}

/** Collects RetryInfo callbacks. */
function createCollector(): { infos: RetryInfo[]; onRetry: (info: RetryInfo) => void } {
  const infos: RetryInfo[] = []
  return {
    infos,
    onRetry: (info: RetryInfo) => infos.push(info),
  }
}

// setImmediate 未被 mock（只 mock setTimeout/Date），用它 flush 微任务 + delay promise 解析
const flush = () => new Promise<void>((r) => setImmediate(r))

// ---------------------------------------------------------------------------
// jitteredBackoff
// ---------------------------------------------------------------------------

describe('jitteredBackoff', () => {
  it('should increase monotonically across attempts', () => {
    const delays: number[] = []
    for (let i = 1; i <= 6; i++) {
      delays.push(jitteredBackoff(i, 1000, 60_000, 0))
    }
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i]! >= delays[i - 1]!, `delay[${i}] (${delays[i]}) < delay[${i - 1}] (${delays[i - 1]})`)
    }
  })

  it('should cap at maxDelayMs', () => {
    // With 0 jitter, the result should be exactly min(exponential, maxDelay)
    const result = jitteredBackoff(100, 1000, 5000, 0)
    assert.ok(result <= 5000, `expected <= 5000, got ${result}`)
  })

  it('should add jitter up to jitterRatio * base', () => {
    const base = 1000
    const maxDelay = 100_000
    // With full jitterRatio=1, the result can be up to 2x the exponential base
    const result = jitteredBackoff(1, base, maxDelay, 1)
    // attempt 1: exponential = 1000, capped = 1000, jitter in [0, 1000]
    // result in [1000, 2000]
    assert.ok(result >= base, `expected >= ${base}, got ${result}`)
    assert.ok(result <= base * 2, `expected <= ${base * 2}, got ${result}`)
  })
})

// ---------------------------------------------------------------------------
// abortableDelay
// ---------------------------------------------------------------------------

describe('abortableDelay', () => {
  it('should reject immediately if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => abortableDelay(1000, controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })

  it('should reject when signal aborts during delay', async () => {
    const controller = new AbortController()
    const promise = abortableDelay(10_000, controller.signal)
    // Abort shortly after starting
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(
      () => promise,
      (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// withStructuredRetry
// ---------------------------------------------------------------------------

describe('withStructuredRetry', () => {
  it('should return value on first successful call', async () => {
    const result = await withStructuredRetry(async () => 'ok')
    assert.equal(result, 'ok')
  })

  it('should retry 500 errors and eventually succeed', async () => {
    const fn = flakyFactory('recovered', 2)
    const result = await withStructuredRetry(fn, undefined, { maxTotalRetries: 5 })
    assert.equal(result, 'recovered')
  })

  it('should NOT retry 401 auth errors', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Unauthorized (401)', 401)
    }
    await assert.rejects(
      () => withStructuredRetry(fn),
      (err: unknown) => {
        assert.ok(err instanceof FakeApiError)
        assert.equal(calls, 1, 'should have called fn exactly once')
        return true
      },
    )
  })

  it('should retry 413 image_strip once, then fail', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Request too large (413)', 413)
    }
    await assert.rejects(
      () => withStructuredRetry(fn),
      (err: unknown) => {
        assert.ok(err instanceof FakeApiError)
        // 413 is now retryable (image_strip) with maxRetries=1, so 2 total calls
        assert.equal(calls, 2)
        return true
      },
    )
  })

  it('should respect maxTotalRetries limit', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    // Server error has maxRetries=3 in classifier; we set maxTotalRetries=1
    await assert.rejects(
      () => withStructuredRetry(fn, undefined, { maxTotalRetries: 1 }),
    )
    // 1 initial call + 1 retry = 2 total
    assert.equal(calls, 2, `expected 2 calls, got ${calls}`)
  })

  it('should respect AbortSignal', async () => {
    const controller = new AbortController()
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      if (calls === 1) {
        // Abort during first retry delay
        setTimeout(() => controller.abort(), 5)
      }
      throw new FakeApiError('Server error (500)', 500)
    }
    await assert.rejects(
      () => withStructuredRetry(fn, controller.signal, { maxTotalRetries: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })

  it('should call onRetry callback with classified info', async () => {
    const { infos, onRetry } = createCollector()
    const fn = flakyFactory('done', 2)
    const result = await withStructuredRetry(fn, undefined, {
      maxTotalRetries: 5,
      onRetry,
    })
    assert.equal(result, 'done')
    assert.equal(infos.length, 2, `expected 2 retries, got ${infos.length}`)
    assert.equal(infos[0]!.attempt, 1)
    assert.equal(infos[0]!.classified.category, 'server_error')
    assert.ok(infos[0]!.nextDelayMs > 0)
    assert.equal(infos[1]!.attempt, 2)
  })

  it('should succeed after multiple retries', async () => {
    // Server error has maxRetries=3; fail 3 times, succeed on 4th call
    const fn = flakyFactory('finally', 3)
    const { infos, onRetry } = createCollector()
    const result = await withStructuredRetry(fn, undefined, {
      maxTotalRetries: 5,
      onRetry,
    })
    assert.equal(result, 'finally')
    assert.equal(infos.length, 3)
  })

  it('should throw when retries are exhausted', async () => {
    // Server error maxRetries=3, set maxTotalRetries=2 so we exhaust first
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    await assert.rejects(
      () => withStructuredRetry(fn, undefined, { maxTotalRetries: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof FakeApiError)
        return true
      },
    )
    // 1 initial + 2 retries = 3
    assert.equal(calls, 3)
  })

  it('should enforce maxTotalDurationMs global timeout', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    // Set a very short global timeout (50ms) — the function will fail
    // immediately but the total elapsed time will exceed the budget quickly
    // because the retry delays accumulate.
    await assert.rejects(
      () => withStructuredRetry(fn, undefined, {
        maxTotalRetries: 100,
        maxTotalDurationMs: 50,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /Retry budget exhausted/)
        return true
      },
    )
    // Should have called fn at least once before giving up
    assert.ok(calls >= 1, `expected at least 1 call, got ${calls}`)
  })

  it('should succeed before maxTotalDurationMs expires', async () => {
    const fn = flakyFactory('ok', 1)
    // Generous budget — should succeed before timeout
    const result = await withStructuredRetry(fn, undefined, {
      maxTotalRetries: 5,
      maxTotalDurationMs: 30_000,
    })
    assert.equal(result, 'ok')
  })

  it('预算耗尽：错误立即冒泡，不再被 unknown/retryable 分类空转一拍', async () => {
    // 回归：2026-08-09 事故（deepseek-spark 911s 挂死）解剖遗留——预算错误文案
    // 不命中分类器任何模式 → fallback unknown/retryable → maxTotalRetries > 1 时
    // 预算错误自身再走两拍重试延迟，且 attempt 计数递增，用户文案从
    // "across 1 attempt(s)" 漂成 "across 2/3 attempt(s)"。
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      let calls = 0
      const { infos, onRetry } = createCollector()
      let err: Error | null = null
      const p = withStructuredRetry(
        async () => {
          calls++
          // 首次尝试即耗穿预算（911s），抛出可重试的 500
          mock.timers.tick(911_000)
          throw new FakeApiError('Server error (500)', 500)
        },
        undefined,
        { maxTotalRetries: 5, maxTotalDurationMs: 600_000, onRetry },
      ).catch((e: Error) => { err = e })

      for (let i = 0; i < 5; i++) await flush()
      // 多轮 tick：重试延迟 = retryDelayMs 2000 + jitter 最多 +50%，5s 覆盖一轮。
      // 旧行为（预算错误被分类空转）会注册第二个 delay timer，第二轮 tick 放它
      // 过并让错误在断言处快速失败——不挂起。
      for (let round = 0; round < 3; round++) {
        mock.timers.tick(5_000)
        for (let i = 0; i < 5; i++) await flush()
      }
      await p

      assert.equal(calls, 1, '预算耗尽后不得再发起新尝试')
      // 第一次失败（500）的重试回调允许有一次；预算错误自身不得再触发
      assert.equal(infos.length, 1, `预算错误不得再空转，got ${infos.length} retries`)
      assert.ok(err)
      assert.match((err as unknown as Error).message, /Retry budget exhausted/)
      assert.match((err as unknown as Error).message, /across 1 attempt\(s\)/)
    } finally {
      mock.timers.reset()
    }
  })

  it('Retry-After 超出剩余预算时不空等——立即预算终结（核验补漏）', async () => {
    // 服务器指定 30 分钟等待 vs 10s 总预算：预算只在每轮 attempt 顶部检查，
    // 修复前会把 30 分钟（含 jitter 后更长）真实睡满，才在下一轮发现超预算——
    // 与「防挂死」目标背道而驰。修复后：预测「本次等待必然超预算」立即终结。
    const err = Object.assign(new Error('429 rate limit exceeded'), {
      status: 429,
      retryAfterMs: 30 * 60_000,
    })
    const ac = new AbortController()
    const guard = setTimeout(() => ac.abort(), 3_000)
    guard.unref?.()
    const t0 = Date.now()
    try {
      await assert.rejects(
        () => withStructuredRetry(() => Promise.reject(err), ac.signal, {
          maxTotalDurationMs: 10_000,
        }),
        (e: unknown) => e instanceof RetryBudgetExhaustedError,
        '应直接以 RetryBudgetExhaustedError 终结；修复前会进入 30min 等待（被 3s 后的 abort 打断为 AbortError）',
      )
      assert.ok(Date.now() - t0 < 1_000, `不应进入长等待（实测 ${Date.now() - t0}ms）`)
    } finally {
      clearTimeout(guard)
    }
  })
})

// ---------------------------------------------------------------------------
// Retry policy config (issue #75)
// ---------------------------------------------------------------------------

describe('withStructuredRetry policy config', () => {
  it('keeps the legacy fixed+jitter delay for 429 when no backoff is configured', async () => {
    const { infos, onRetry } = createCollector()
    const fn = flakyFactory('ok', 1, 429)
    const result = await withStructuredRetry(fn, undefined, { onRetry })
    assert.equal(result, 'ok')
    // No policy → 429 keeps the historical fixed 2000ms + 0–50% jitter.
    const delay = infos[0]!.nextDelayMs
    assert.ok(delay >= 2000 && delay <= 3000, `expected 2000..3000, got ${delay}`)
  })

  it('grows delay exponentially from the category override base when backoff is configured', async () => {
    const { infos, onRetry } = createCollector()
    const fn = flakyFactory('ok', 3, 429)
    const result = await withStructuredRetry(fn, undefined, {
      onRetry,
      policy: {
        backoff: { maxDelayMs: 60_000, jitterRatio: 0 },
        overrides: { rate_limit: { retryDelayMs: 4, maxRetries: 8 } },
      },
    })
    assert.equal(result, 'ok')
    // base=4 → 4, 8, 16 (jitterRatio 0 → deterministic series).
    assert.deepEqual(infos.map(i => i.nextDelayMs), [4, 8, 16])
  })

  it('uses the classifier delay as the exponential base when no override delay is set', async () => {
    const { infos, onRetry } = createCollector()
    const fn = flakyFactory('ok', 2, 429)
    const result = await withStructuredRetry(fn, undefined, {
      onRetry,
      policy: { backoff: { jitterRatio: 0 } },
    })
    assert.equal(result, 'ok')
    // 429's classifier delay (2000) becomes the base: 2000, 4000.
    assert.deepEqual(infos.map(i => i.nextDelayMs), [2000, 4000])
  })

  it('keeps server Retry-After delays fixed even with backoff configured', async () => {
    const { infos, onRetry } = createCollector()
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      if (calls <= 2) {
        const err = new FakeApiError('Rate limited (429)', 429) as FakeApiError & { retryAfterMs?: number }
        err.retryAfterMs = 20
        throw err
      }
      return 'ok'
    }
    const result = await withStructuredRetry(fn, undefined, {
      onRetry,
      policy: { backoff: { jitterRatio: 0 } },
    })
    assert.equal(result, 'ok')
    // Server named the wait (20ms): stays fixed across attempts, no exponential growth.
    assert.deepEqual(infos.map(i => i.nextDelayMs), [20, 20])
  })

  it('falls back to the classifier ceiling when neither maxRetries nor overrides set a count', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    await assert.rejects(() => withStructuredRetry(fn, undefined, {
      // Delay override only — the retry count must still come from the classifier (3).
      policy: { overrides: { server_error: { retryDelayMs: 1 } } },
    }))
    assert.equal(calls, 4, `expected 1 + 3 classifier retries, got ${calls}`)
  })

  it('lets an explicit maxTotalRetries raise the classifier ceiling', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    await assert.rejects(() => withStructuredRetry(fn, undefined, {
      maxTotalRetries: 6,
      policy: { overrides: { server_error: { retryDelayMs: 1 } } },
    }))
    // Explicit 6 wins over the classifier's 3 — the §3 gap from issue #75.
    assert.equal(calls, 7, `expected 1 + 6, got ${calls}`)
  })

  it('honors a per-category maxRetries override', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Rate limited (429)', 429)
    }
    await assert.rejects(() => withStructuredRetry(fn, undefined, {
      policy: { overrides: { rate_limit: { maxRetries: 2, retryDelayMs: 1 } } },
    }))
    assert.equal(calls, 3, `expected 1 + 2, got ${calls}`)
  })

  it('caps a per-category override by an explicit maxTotalRetries', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Rate limited (429)', 429)
    }
    await assert.rejects(() => withStructuredRetry(fn, undefined, {
      maxTotalRetries: 3,
      policy: { overrides: { rate_limit: { maxRetries: 8, retryDelayMs: 1 } } },
    }))
    assert.equal(calls, 4, `expected 1 + min(8, 3), got ${calls}`)
  })

  it('does not let maxTotalRetries inflate the one-shot image_strip budget', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Payload Too Large (413)', 413)
    }
    await assert.rejects(() => withStructuredRetry(fn, undefined, {
      maxTotalRetries: 20,
      policy: { overrides: { image_strip: { retryDelayMs: 1 } } },
    }))
    // stripImages carries one-shot semantics: min(classifier 1, 20) = 1.
    assert.equal(calls, 2, `expected 1 + 1, got ${calls}`)
  })

  it('disables retries entirely with maxTotalRetries 0', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    await assert.rejects(() => withStructuredRetry(fn, undefined, { maxTotalRetries: 0 }))
    assert.equal(calls, 1, `expected a single call, got ${calls}`)
  })
})
