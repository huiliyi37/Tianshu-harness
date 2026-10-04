import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTick } from 'node:timers/promises'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookContext, type RuntimeHookError } from '../runtime-hooks.js'
import { createMCTSPlanningHook } from '../hooks/mcts-planning-hook.js'
import { AntiAnchoringController } from '../anti-anchoring-controller.js'
import type { StreamClient } from '../../api/stream-client.js'

function context(effects: Parameters<typeof createRuntimeHookContext>[1] = {}): RuntimeHookContext {
  return createRuntimeHookContext({
    cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null,
    strategy: null, vigor: null, gitChangeRate: 0, season: null,
  }, effects)
}

function seedController(streamClient: StreamClient, sessionSignal?: AbortSignal): AntiAnchoringController {
  return new AntiAnchoringController({
    getFingerprint: () => ({ systemSha256: 'test', toolsSha256: 'test' }),
    getModel: () => 'test-model', getLastCycleClose: () => null, getSessionId: () => 'test-session',
    getAntiAnchoringConfig: () => ({}), getAbortSignal: () => sessionSignal, streamClient,
  })
}

describe('runtime hook invocation lifetime', () => {
  it('aborts timed-out work and closes captured effects without closing the next hook', async () => {
    const messages: string[] = []
    const errors: RuntimeHookError[] = []
    const ctx = context({ injectUserMessage: message => messages.push(message) })
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    let signal: AbortSignal | undefined
    const pipeline = new RuntimeHookPipeline([
      { phase: 'preTurn', name: 'late', async run(scoped) {
        signal = scoped.signal
        const inject = scoped.effects.injectUserMessage
        const setRate = scoped.effects.setGitChangeRate
        await wait // deliberately ignores cancellation
        inject('obsolete message')
        setRate(99)
      } },
      { phase: 'preTurn', name: 'next', run(scoped) {
        assert.equal(scoped.signal?.aborted, false)
        scoped.effects.injectUserMessage('current message')
        scoped.effects.setGitChangeRate(3)
      } },
    ], { hookTimeoutMs: 10, onError: error => errors.push(error) })
    await pipeline.runPreTurn(ctx)
    assert.equal(signal?.aborted, true)
    release()
    await nextTick()
    assert.deepEqual(messages, ['current message'])
    assert.equal(ctx.snapshot.gitChangeRate, 3)
    assert.equal(errors.length, 1)
    assert.equal(pipeline.getStats().find(stat => stat.id === 'late')?.timeouts, 1)
  })

  it('closes effects from completed invocations in all five phases', async () => {
    const ctx = context()
    const captured: RuntimeHookContext[] = []
    const run = (scoped: RuntimeHookContext): void => {
      scoped.effects.setGitChangeRate(captured.length + 1)
      captured.push(scoped)
    }
    const pipeline = new RuntimeHookPipeline([
      { phase: 'preTurn', name: 'pre', run }, { phase: 'afterPerception', name: 'perception', run },
      { phase: 'postTool', name: 'tool', run }, { phase: 'postTurn', name: 'turn', run },
      { phase: 'postSession', name: 'session', run },
    ])
    await pipeline.runPreTurn(ctx)
    await pipeline.runAfterPerception(ctx)
    await pipeline.runPostTool(ctx, { name: 'read_file', success: true })
    await pipeline.runPostTurn(ctx)
    await pipeline.runPostSession(ctx)
    assert.equal(ctx.snapshot.gitChangeRate, 5)
    for (const scoped of captured) {
      assert.equal(scoped.signal?.aborted, true)
      scoped.effects.setGitChangeRate(99)
    }
    assert.equal(ctx.snapshot.gitChangeRate, 5)
  })

  it('does not publish late planning results when a provider ignores cancellation', async () => {
    const messages: string[] = []
    let results = 0
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const hook = createMCTSPlanningHook({
      getUserMessage: () => 'refactor auth module', branches: 3,
      callSeedModel: async () => { await wait; return 'Independent implementation path' },
      onResult: () => { results++ },
    })
    const pipeline = new RuntimeHookPipeline([hook], { hookTimeoutMs: 5 })
    await pipeline.runPreTurn(context({ injectUserMessage: message => messages.push(message) }))
    release()
    await nextTick()
    assert.equal(results, 0)
    assert.deepEqual(messages, [])
    assert.equal(pipeline.getStats()[0]?.timeouts, 1)
  })

  it('cancels all 1500 seed streams in a burst of 500 timed-out sessions', async () => {
    let active = 0
    let started = 0
    let cancelled = 0
    let injected = 0
    const streamClient: StreamClient = {
      stream: async (_request, _callbacks, signal) => {
        assert.ok(signal)
        signal.throwIfAborted()
        started++; active++
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => { cancelled++; reject(signal.reason) }, { once: true })
          })
        } finally { active-- }
      },
    }
    const seed = seedController(streamClient)
    const pipelines = Array.from({ length: 500 }, () => new RuntimeHookPipeline([
      createMCTSPlanningHook({
        getUserMessage: () => 'refactor auth module', branches: 3,
        callSeedModel: (prompt, signal) => seed.callSeedModel(prompt, signal),
      }),
    ], { hookTimeoutMs: 5 }))
    await Promise.all(pipelines.map(pipeline => pipeline.runPreTurn(context({ injectUserMessage: () => { injected++ } }))))
    await nextTick()
    assert.equal(started, 1500)
    assert.equal(cancelled, 1500)
    assert.equal(active, 0)
    assert.equal(injected, 0)
    assert.ok(pipelines.every(pipeline => pipeline.getStats()[0]?.timeouts === 1))
  })

  it('preserves session cancellation when the seed stream also has a hook deadline', async () => {
    const session = new AbortController()
    const hook = new AbortController()
    let received: AbortSignal | undefined
    const seed = seedController({ stream: async (_request, _callbacks, signal) => {
      received = signal
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    } }, session.signal)
    const pending = seed.callSeedModel('test prompt', hook.signal)
    const reason = new Error('session stopped')
    session.abort(reason)
    await assert.rejects(pending, error => error === reason)
    assert.equal(received?.aborted, true)
    assert.equal(hook.signal.aborted, false)
  })
})
