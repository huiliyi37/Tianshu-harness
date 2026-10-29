import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { transpileModule, ModuleKind } from 'typescript'
import type { OverviewRunInfo } from '../session-project-context.js'

const source = readFileSync(new URL('../session-project-context.ts', import.meta.url), 'utf8')
const compiled = transpileModule(source.replace(/^import .*\n/gm, ''), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
const information: OverviewRunInfo = { sessionId: 'foreground-test', cwd: '/synthetic-workspace', recovery: false, autoResubmit: false, hasUserEvents: false }

function fixture(needsRefresh: () => boolean, refresh: () => Promise<void>) {
  const exports: { startAfterProjectOverview?: (info: OverviewRunInfo, start: () => void, signal?: AbortSignal) => void } = {}
  runInNewContext(compiled, { exports, setTimeout, clearTimeout, overviewNeedsRefresh: needsRefresh, refreshProjectOverview: refresh })
  assert.equal(typeof exports.startAfterProjectOverview, 'function')
  return exports.startAfterProjectOverview!
}

async function flush() {
  await setImmediate()
}

test('a pending project scan cannot delay foreground agent preparation beyond 100ms', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let completeScan!: () => void
  const pendingScan = new Promise<void>(resolve => { completeScan = resolve })
  let starts = 0
  const start = fixture(() => true, () => pendingScan)
  start(information, () => { starts++ })
  await flush()
  assert.equal(starts, 0)
  context.mock.timers.tick(100)
  await flush()
  assert.equal(starts, 1)
  completeScan()
  await flush()
  assert.equal(starts, 1)
})

test('a ready overview starts synchronously without rescanning', () => {
  let starts = 0
  const start = fixture(() => false, () => { assert.fail('cached overview was rescanned') })
  start(information, () => { starts++ })
  assert.equal(starts, 1)
})

test('a quick scan is consumed before the foreground deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let starts = 0
  const start = fixture(() => true, async () => {})
  start(information, () => { starts++ })
  await flush()
  assert.equal(starts, 1)
  context.mock.timers.tick(10000)
  await flush()
  assert.equal(starts, 1)
})

test('cancellation promptly returns control to the existing abort gate exactly once', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let completeScan!: () => void
  let starts = 0
  const start = fixture(() => true, () => new Promise<void>(resolve => { completeScan = resolve }))
  start(information, () => { assert.equal(controller.signal.aborted, true); starts++ }, controller.signal)
  controller.abort()
  await flush()
  assert.equal(starts, 1)
  completeScan()
  context.mock.timers.tick(10000)
  await flush()
  assert.equal(starts, 1)
})
