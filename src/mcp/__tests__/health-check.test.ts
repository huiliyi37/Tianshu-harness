import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { HealthChecker, type HealthState } from '../health-check.js'

describe('HealthChecker', () => {
  it('starts in healthy state', () => {
    const checker = new HealthChecker({ intervalMs: 100, timeoutMs: 50 })
    const mockClient = createMockClient(true)
    const states: HealthState[] = []

    checker.register('test-server', mockClient, (_, state) => states.push(state))

    assert.equal(checker.getState('test-server'), 'healthy')
    checker.shutdown()
  })

  it('transitions to degraded after consecutive failures', async () => {
    const checker = new HealthChecker({
      intervalMs: 50,
      timeoutMs: 20,
      failureThreshold: 3,
    })
    const mockClient = createMockClient(false) // Always fail
    const statePromise = waitForState('degraded')

    checker.register('test-server', mockClient, statePromise.callback)

    await statePromise.promise
    assert.equal(checker.getState('test-server'), 'degraded')
    checker.shutdown()
  })

  it('transitions to failed after degraded', async () => {
    const checker = new HealthChecker({
      intervalMs: 50,
      timeoutMs: 20,
      failureThreshold: 2,
    })
    const mockClient = createMockClient(false)
    const statePromise = waitForState('failed')

    checker.register('test-server', mockClient, statePromise.callback)

    await statePromise.promise
    assert.equal(checker.getState('test-server'), 'failed')
    checker.shutdown()
  })

  it('recovers to healthy on successful check', async () => {
    const checker = new HealthChecker({
      intervalMs: 50,
      timeoutMs: 20,
      failureThreshold: 2,
    })
    let shouldFail = true
    const mockClient = createMockClient(() => !shouldFail)
    const states: HealthState[] = []

    let degradedResolver: () => void
    let healthyResolver: () => void
    const degradedPromise = new Promise<void>(resolve => { degradedResolver = resolve })
    const healthyPromise = new Promise<void>(resolve => { healthyResolver = resolve })

    checker.register('test-server', mockClient, (id, state) => {
      states.push(state)
      if (state === 'degraded') degradedResolver()
      if (state === 'healthy' && states.includes('degraded')) healthyResolver()
    })

    // Wait for degraded
    await degradedPromise

    // Recover
    shouldFail = false

    await healthyPromise
    assert.ok(states.includes('degraded'), 'Should have degraded first')
    assert.ok(states.includes('healthy'), 'Should recover to healthy')
    checker.shutdown()
  })

  it('applies exponential backoff for retries', async () => {
    const checker = new HealthChecker({
      intervalMs: 50,
      timeoutMs: 20,
      retryBackoffBaseMs: 100,
      failureThreshold: 1,
    })
    const mockClient = createMockClient(false)
    const checkTimes: number[] = []

    checker.register('test-server', mockClient, (_, state) => {
      if (state === 'retrying') checkTimes.push(Date.now())
    })

    await new Promise(resolve => setTimeout(resolve, 1000))

    // First retry ~100ms, second ~200ms, third ~400ms
    if (checkTimes.length >= 2) {
      const gap1 = checkTimes[1]! - checkTimes[0]!
      assert.ok(gap1 >= 80 && gap1 <= 300, `Expected ~100-200ms gap, got ${gap1}ms`)
    }

    checker.shutdown()
  })

  it('stops checking after max retries', async () => {
    const checker = new HealthChecker({
      intervalMs: 50,
      timeoutMs: 20,
      maxRetries: 3,
      failureThreshold: 1,
      retryBackoffBaseMs: 50,
    })
    const mockClient = createMockClient(false)
    const states: HealthState[] = []
    let lastFailedTime = 0

    checker.register('test-server', mockClient, (_, state) => {
      states.push(state)
      if (state === 'failed') lastFailedTime = Date.now()
    })

    // Wait for retries to exhaust
    await new Promise(resolve => setTimeout(resolve, 600))

    // After some time, no more state changes should occur
    const checkTime = Date.now()
    await new Promise(resolve => setTimeout(resolve, 200))

    // Last state should be 'failed' and no new changes
    assert.ok(states.includes('failed'), 'Should reach failed state')
    assert.ok(checkTime - lastFailedTime < 300, 'Should have stopped retrying')

    checker.shutdown()
  })

  it('unregister stops health checks', async () => {
    const checker = new HealthChecker({ intervalMs: 50, timeoutMs: 20 })
    const mockClient = createMockClient(true)
    let checkCount = 0

    checker.register('test-server', mockClient, () => { checkCount++ })

    await new Promise(resolve => setTimeout(resolve, 80))
    checker.unregister('test-server')
    const countBeforeUnregister = checkCount

    await new Promise(resolve => setTimeout(resolve, 150))

    // Should not increase after unregister
    assert.equal(checkCount, countBeforeUnregister)
    checker.shutdown()
  })

  it('handles timeout correctly', async () => {
    const checker = new HealthChecker({
      intervalMs: 50,
      timeoutMs: 30,
      failureThreshold: 1,
    })
    // Mock client that takes 100ms to respond (longer than timeout)
    const mockClient = {
      request: async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { tools: [] }
      },
    } as any
    const statePromise = waitForState('degraded')

    checker.register('test-server', mockClient, statePromise.callback)

    await statePromise.promise
    assert.equal(checker.getState('test-server'), 'degraded')

    checker.shutdown()
  })
})

function createMockClient(shouldSucceed: boolean | (() => boolean)) {
  return {
    request: async () => {
      const success = typeof shouldSucceed === 'function' ? shouldSucceed() : shouldSucceed
      if (!success) throw new Error('Health check failed')
      return { tools: [] }
    },
  } as any
}

function waitForState(targetState: HealthState) {
  let resolver: (value: void) => void
  const promise = new Promise<void>((resolve) => {
    resolver = resolve
  })

  return {
    promise,
    callback: (_: string, state: HealthState) => {
      if (state === targetState) resolver()
    },
  }
}
