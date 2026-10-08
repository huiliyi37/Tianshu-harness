import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { guardRuntimeRoutes } from '../runtime-route-guard.js'

test('runtime mutation guard uses current readiness and preserves diagnostics and recovery controls', async () => {
  const records: number[] = []
  const state = { ownsSessionStore: true, initializationError: undefined as string | undefined, updatePreparing: false }
  const routes = guardRuntimeRoutes({
    'POST /sessions': () => { records.push(records.length + 1); return { status: 201 } },
    'GET /sessions': () => ({ status: 200, body: { records } }),
    'POST /shutdown': () => ({ status: 200 }),
    'POST /runtime/update-prepare': () => ({ status: 200 }),
    'POST /runtime/update-cancel': () => ({ status: 200 }),
  }, () => state)
  // Sidecar adds most routes after installing the guard.
  Object.assign(routes, { 'POST /missions': () => { records.push(99); return { status: 201 } } })
  const route = createRouter(routes)
  assert.equal((await route('POST', '/sessions', {})).status, 201)
  state.ownsSessionStore = false
  state.initializationError = 'data-dir-locked'
  for (const path of ['/sessions', '/missions']) assert.deepEqual(await route('POST', path, {}), { status: 503, body: { error: 'data-dir-locked' } })
  assert.deepEqual(records, [1])
  assert.deepEqual(await route('GET', '/sessions', {}), { status: 200, body: { records: [1] } })
  assert.equal((await route('POST', '/shutdown', {})).status, 200)
  state.ownsSessionStore = true
  state.updatePreparing = true
  assert.deepEqual(await route('POST', '/sessions', {}), { status: 409, body: { error: 'UPDATE_PREPARING' } })
  for (const path of ['/runtime/update-prepare', '/runtime/update-cancel']) assert.equal((await route('POST', path, {})).status, 200)
  assert.deepEqual(records, [1])
})
