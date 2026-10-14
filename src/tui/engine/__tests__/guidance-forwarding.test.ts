import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drainSteerGuidance, type HumanGuidance } from '../../../agent/course-episodes.js'
import { SteerBuffer } from '../../steer-buffer.js'
import { wrapCallbacksWithTuiApp } from '../bridge.js'
import { makeApp } from './_harness.js'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

test('async empty TUI human drain falls back to the original human input queue', async testContext => {
  const { app } = makeApp({ autoStart: false })
  testContext.after(() => app.dispose())
  const human = new SteerBuffer()
  human.pushNow('original human guidance')
  const appDrain = app.callbacks.onHumanGuidanceDrain!
  app.callbacks.onHumanGuidanceDrain = async () => appDrain()
  const wrapped = wrapCallbacksWithTuiApp(app, { onHumanGuidanceDrain: async () => human.drainHuman() })
  const guidance = await wrapped.onHumanGuidanceDrain!()
  assert.ok(guidance)
  assert.equal(guidance.origin, 'human')
  assert.equal(guidance.inputSequence, 1)
  assert.match(guidance.text, /original human guidance/)
  assert.equal(human.hasPending(), false)
  assert.equal(await wrapped.onHumanGuidanceDrain!(), null)
})

test('async TUI human guidance preserves both original human and legacy queues until later drains', async testContext => {
  const { app } = makeApp({ autoStart: false })
  testContext.after(() => app.dispose())
  const human = new SteerBuffer()
  const legacy = new SteerBuffer()
  human.pushNow('original human guidance')
  legacy.pushNow('[User guidance] worker reminder')
  app.steerBuffer.pushNow('TUI human guidance')
  app.steerBuffer.push('next-run message', 'later')
  const appDrain = app.callbacks.onHumanGuidanceDrain!
  app.callbacks.onHumanGuidanceDrain = async () => appDrain()
  const accepted: HumanGuidance[] = []
  const wrapped = {
    ...wrapCallbacksWithTuiApp(app, {
      onHumanGuidanceDrain: async () => human.drainHuman(),
      onSteerDrain: async () => legacy.drain(),
    }),
    onHumanGuidanceAccepted: (item: HumanGuidance) => { accepted.push(item) },
  }
  const tui = await drainSteerGuidance(wrapped)
  assert.ok(tui)
  assert.match(tui.text, /TUI human guidance/)
  tui.accepted()
  assert.equal(accepted[0]?.origin, 'human')
  assert.equal(human.hasPending(), true)
  assert.equal(legacy.hasPending(), true)
  assert.deepEqual(app.steerBuffer.getPending(), ['next-run message'])

  const original = await drainSteerGuidance(wrapped)
  assert.ok(original)
  assert.match(original.text, /original human guidance/)
  original.accepted()
  assert.equal(accepted[1]?.origin, 'human')
  assert.equal(legacy.hasPending(), true)

  const worker = await drainSteerGuidance(wrapped)
  assert.ok(worker)
  assert.match(worker.text, /worker reminder/)
  worker.accepted()
  assert.equal(accepted.length, 2, 'legacy strings must never acquire human authority')
  assert.equal(await drainSteerGuidance(wrapped), null)
})

test('legacy TUI drain consumes one queue at a time instead of discarding the original queue', async testContext => {
  const { app } = makeApp({ autoStart: false })
  testContext.after(() => app.dispose())
  const tui = new SteerBuffer()
  const original = new SteerBuffer()
  tui.pushNow('TUI legacy guidance')
  original.pushNow('original legacy guidance')
  app.callbacks.onSteerDrain = () => tui.drain()
  const wrapped = wrapCallbacksWithTuiApp(app, { onSteerDrain: () => original.drain() })
  assert.match((await drainSteerGuidance(wrapped))!.text, /TUI legacy guidance/)
  assert.equal(original.hasPending(), true)
  assert.match((await drainSteerGuidance(wrapped))!.text, /original legacy guidance/)
  assert.equal(await drainSteerGuidance(wrapped), null)
})

test('async empty legacy drain falls back without granting human authority', async testContext => {
  const { app } = makeApp({ autoStart: false })
  testContext.after(() => app.dispose())
  const original = new SteerBuffer()
  original.pushNow('[User guidance] runtime reminder')
  app.callbacks.onSteerDrain = async () => null
  let accepted = 0
  const wrapped = {
    ...wrapCallbacksWithTuiApp(app, { onSteerDrain: async () => original.drain() }),
    onHumanGuidanceAccepted: () => { accepted++ },
  }
  const guidance = await drainSteerGuidance(wrapped)
  assert.ok(guidance)
  assert.match(guidance.text, /runtime reminder/)
  guidance.accepted()
  assert.equal(accepted, 0)
  assert.equal(original.hasPending(), false)
  assert.equal(await drainSteerGuidance(wrapped), null)
})

for (const channel of ['onHumanGuidanceDrain', 'onSteerDrain'] as const) {
  test(`stale ${channel} never consumes either input queue`, async testContext => {
    const { app } = makeApp({ autoStart: false })
    testContext.after(() => app.dispose())
    const tui = new SteerBuffer()
    const original = new SteerBuffer()
    tui.pushNow('TUI guidance')
    original.pushNow('original guidance')
    app.callbacks.onHumanGuidanceDrain = () => tui.drainHuman()
    app.callbacks.onSteerDrain = () => tui.drain()
    const wrapped = wrapCallbacksWithTuiApp(app, {
      onHumanGuidanceDrain: () => original.drainHuman(),
      onSteerDrain: () => original.drain(),
    })
    app.callbacks.onAbort()
    assert.equal(await wrapped[channel]!(), null)
    assert.deepEqual(tui.getPending(), ['TUI guidance'])
    assert.deepEqual(original.getPending(), ['original guidance'])
  })

  test(`async ${channel} cannot drain the original queue after its run becomes stale`, async testContext => {
    const { app } = makeApp({ autoStart: false })
    testContext.after(() => app.dispose())
    const original = new SteerBuffer()
    original.pushNow('next-run guidance')
    const gate = deferred<null>()
    app.callbacks[channel] = () => gate.promise
    const wrapped = wrapCallbacksWithTuiApp(app, {
      onHumanGuidanceDrain: () => original.drainHuman(),
      onSteerDrain: () => original.drain(),
    })
    const pending = wrapped[channel]!()
    app.callbacks.onAbort()
    gate.resolve(null)
    assert.equal(await pending, null)
    assert.deepEqual(original.getPending(), ['next-run guidance'])
  })

  test(`async TUI ${channel} cannot deliver guidance after its run becomes stale`, async testContext => {
    const { app } = makeApp({ autoStart: false })
    testContext.after(() => app.dispose())
    const tui = new SteerBuffer()
    const original = new SteerBuffer()
    tui.pushNow('old-run guidance')
    original.pushNow('next-run guidance')
    const gate = deferred<void>()
    app.callbacks.onHumanGuidanceDrain = async () => { await gate.promise; return tui.drainHuman() }
    app.callbacks.onSteerDrain = async () => { await gate.promise; return tui.drain() }
    const wrapped = wrapCallbacksWithTuiApp(app, {
      onHumanGuidanceDrain: () => original.drainHuman(),
      onSteerDrain: () => original.drain(),
    })
    const pending = wrapped[channel]!()
    app.callbacks.onAbort()
    gate.resolve(undefined)
    assert.equal(await pending, null)
    assert.deepEqual(original.getPending(), ['next-run guidance'])
  })

  test(`async original ${channel} cannot deliver guidance after its run becomes stale`, async testContext => {
    const { app } = makeApp({ autoStart: false })
    testContext.after(() => app.dispose())
    const original = new SteerBuffer()
    original.pushNow('old-run guidance')
    const gate = deferred<void>()
    const started = deferred<void>()
    const waitForDrain = async () => {
      started.resolve(undefined)
      await gate.promise
    }
    const wrapped = wrapCallbacksWithTuiApp(app, {
      onHumanGuidanceDrain: async () => { await waitForDrain(); return original.drainHuman() },
      onSteerDrain: async () => { await waitForDrain(); return original.drain() },
    })
    const pending = wrapped[channel]!()
    await started.promise
    app.callbacks.onAbort()
    gate.resolve(undefined)
    assert.equal(await pending, null)
  })

  test(`rejected ${channel} does not consume fallback guidance`, async testContext => {
    const { app } = makeApp({ autoStart: false })
    testContext.after(() => app.dispose())
    const original = new SteerBuffer()
    original.pushNow('preserved guidance')
    const failure = new Error('fixture drain failure')
    app.callbacks[channel] = async () => { throw failure }
    const wrapped = wrapCallbacksWithTuiApp(app, {
      onHumanGuidanceDrain: () => original.drainHuman(),
      onSteerDrain: () => original.drain(),
    })
    await assert.rejects(async () => wrapped[channel]!(), error => error === failure)
    assert.deepEqual(original.getPending(), ['preserved guidance'])
  })
}
