import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runTestCommandIn,
  type RunTestCommandDeps,
  type RunnableTestCommand,
} from '../run-tests.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
}

class ManualTimers {
  tasks: Array<{ ms: number; callback: () => void | Promise<void>; cleared: boolean }> = []

  setTimeout(callback: () => void | Promise<void>, ms: number): number {
    this.tasks.push({ ms, callback, cleared: false })
    return this.tasks.length - 1
  }

  clearTimeout(handle: unknown): void {
    const task = this.tasks[handle as number]
    if (task) task.cleared = true
  }

  fire(ms: number): void | Promise<void> {
    const task = this.tasks.find((entry) => entry.ms === ms && !entry.cleared)
    assert.ok(task, `missing active ${ms}ms timer`)
    return task.callback()
  }
}

/** Completion capture is prepared behind an await, so the spawn/timer setup
 *  lands on a later microtask — wait for the observable side effect. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('run_tests timeout claims settlement before synchronous child close and finalizes once', async () => {
  const originalClock = Date.now
  Date.now = () => 100
  try {
    const child = new FakeChild()
    const timers = new ManualTimers()
    let persistCalls = 0
    let decoderEnds = 0
    const command: RunnableTestCommand = {
      type: 'run',
      command: 'fake-tests',
      args: [],
      display: 'fake-tests',
      runner: 'declared',
      scope: 'full',
    }
    const deps: RunTestCommandDeps = {
      spawn: () => child,
      kill: () => {
        // Reproduce the race deterministically: process close fires inside the
        // timeout cleanup, before output persistence resolves.
        child.emit('close', 0, null)
      },
      persist: async () => {
        persistCalls++
        await Promise.resolve()
        return '/tmp/raw-output'
      },
      setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
      clearTimeout: (handle) => timers.clearTimeout(handle),
      createDecoder: () => ({
        write: (data: Buffer) => data.toString('utf8'),
        end: () => {
          decoderEnds++
          return ''
        },
      }),
      prepareCompletion: async () => undefined,
    }

    const pending = runTestCommandIn(
      '/tmp',
      command,
      { input: {}, toolUseId: 'timeout-race', cwd: '/tmp' },
      undefined,
      50,
      deps,
    )
    await waitFor(() => timers.tasks.some(task => task.ms === 50 && !task.cleared), 'timeout timer')
    child.stdout.write('partial output')
    await timers.fire(50)
    const result = await pending

    assert.equal(result.isError, true)
    assert.match(result.content, /50ms 后超时/)
    assert.equal(result.verification?.blockedReason, 'timeout')
    assert.equal(persistCalls, 1, 'raw output must be persisted exactly once')
    assert.equal(decoderEnds, 2, 'stdout and stderr decoders finalize exactly once each')
  } finally { Date.now = originalClock }
})

test('EPERM fallback receives only remaining budget and cannot spawn after exhaustion', async () => {
  for (const elapsed of [40, 60]) {
    const clock = Date.now
    const base = clock()
    let spent = 0, spawns = 0
    Date.now = () => base + spent
    const children = [new FakeChild(), new FakeChild()], timers = new ManualTimers()
    const deps: RunTestCommandDeps = {
      spawn: () => children[spawns++]!, kill: () => {}, persist: async () => '/tmp/eperm-output',
      setTimeout: (callback, ms) => timers.setTimeout(callback, ms), clearTimeout: handle => timers.clearTimeout(handle),
      createDecoder: () => ({ write: (data: Buffer) => data.toString(), end: () => '' }),
      prepareCompletion: async () => undefined,
    }
    try {
      const command: RunnableTestCommand = { type: 'run', command: 'tsx', args: ['--test'], display: 'tsx --test', runner: 'node-test', scope: 'full' }
      const pending = runTestCommandIn('/tmp', command, { input: {}, toolUseId: 'eperm-budget', cwd: '/tmp' }, undefined, 50, deps)
      await waitFor(() => spawns === 1, 'initial test spawn')
      children[0]!.stderr.write('EPERM')
      spent = elapsed
      children[0]!.emit('close', 1, null)
      if (elapsed < 50) {
        await waitFor(() => spawns === 2, 'tsx EPERM retry spawn')
        assert.equal(spawns, 2)
        assert.ok(timers.tasks.some(task => task.ms === 10 && !task.cleared))
        children[1]!.emit('close', 0, null)
        assert.equal((await pending).isError, false)
      } else {
        assert.equal(spawns, 1, 'exhausted retry must not spawn')
        const result = await pending
        assert.equal(result.verification?.status, 'blocked')
        assert.equal(result.verification?.failureKind, 'timeout')
      }
    } finally { for (const child of children) child.emit('close', 1, null); Date.now = clock }
  }
})
