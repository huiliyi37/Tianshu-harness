import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  touchActivity,
  getLastActivity,
  markIdle,
  clearActivity,
  installStallObserver,
  _resetStallObserverForTest,
  type StallObserverHandle,
} from '../stall-observer.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('no warn while activity is fresh (tick within threshold)', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 200, warn: (m) => warned.push(m) })
  try {
    for (let i = 0; i < 5; i++) {
      touchActivity('session-a', `evt:${i}`)
      await sleep(30)
    }
    assert.equal(warned.length, 0, 'fresh activity must not trigger the stall warning')
  } finally {
    handle.dispose()
  }
})

test('warns once when a session goes silent past the threshold, naming the last source', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 50, warn: (m) => warned.push(m) })
  try {
    touchActivity('session-a', 'tool:write_file:start')
    await sleep(120) // well past 50ms threshold
    assert.equal(warned.length, 1, 'exactly one warning for the silent period')
    assert.ok(warned[0]!.includes('session-a'), `warning must name the stalled session: ${warned[0]}`)
    assert.ok(warned[0]!.includes('tool:write_file:start'), `warning must name the last activity source: ${warned[0]}`)
  } finally {
    handle.dispose()
  }
})

test('multi-session isolation: an active session does not mask a stalled one', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 50, warn: (m) => warned.push(m) })
  try {
    touchActivity('session-stalled', 'tool:write_file:start')
    // Session-b stays active across several ticks — its touches must NOT reset
    // session-stalled's silent counter.
    for (let i = 0; i < 6; i++) {
      touchActivity('session-active', `evt:${i}`)
      await sleep(25)
    }
    assert.ok(warned.some((m) => m.includes('session-stalled')), `stalled session must be reported: ${warned}`)
    assert.ok(!warned.some((m) => m.includes('session-active')), `active session must not be reported: ${warned}`)
  } finally {
    handle.dispose()
  }
})

test('dispose stops the observer', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 20, warn: (m) => warned.push(m) })
  handle.dispose()
  touchActivity('session-x', 'evt:1')
  await sleep(80)
  assert.equal(warned.length, 0, 'no warnings after dispose')
})

test('getLastActivity returns the most recent touch', () => {
  touchActivity('session-a', 'evt:5')
  const a = getLastActivity('session-a')
  assert.equal(a.source, 'evt:5')
  assert.ok(Math.abs(Date.now() - a.ts) < 1000)
})

test('markIdle suppresses warnings while idle; a fresh touch resumes monitoring', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 40, warn: (m) => warned.push(m) })
  try {
    touchActivity('session-a', 'tool:write_file:end')
    markIdle('session-a') // turn finished — awaiting the user, not stalled
    await sleep(120) // well past the threshold, but idle must NOT warn
    assert.equal(warned.length, 0, `idle session must not warn: ${warned}`)

    touchActivity('session-a', 'evt:user-message') // new turn activity resumes monitoring
    await sleep(120)
    assert.equal(warned.length, 1, 'activity after idle must be monitored again')
    assert.ok(warned[0]!.includes('session-a'))
  } finally {
    handle.dispose()
  }
})

test('clearActivity removes a finished session so it never warns again', async () => {
  _resetStallObserverForTest()
  const warned: string[] = []
  const handle = installStallObserver({ intervalMs: 10, thresholdMs: 40, warn: (m) => warned.push(m) })
  try {
    touchActivity('worker-batch-0-abc', 'tool:glob:end')
    clearActivity('worker-batch-0-abc') // worker session finished
    await sleep(120)
    assert.equal(warned.length, 0, `cleared session must not warn: ${warned}`)

    // A later fresh run of the same session id is monitored anew.
    touchActivity('worker-batch-0-abc', 'tool:glob:start')
    await sleep(120)
    assert.equal(warned.length, 1, 're-touched key after clear must be monitored again')
  } finally {
    handle.dispose()
  }
})
