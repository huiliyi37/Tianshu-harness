import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../index.js'
import { RuntimeSessionManager } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { SseConnectionRegistry } from '../sse-registry.js'
import { TaskRegistry } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'
import { SessionRuntimePool } from '../session-runtime-pool.js'

const auth = 'audit-fixture-auth'
const headers = { authorization: `Bearer ${auth}` }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail('fixture condition did not settle')
}

test('malformed JSON returns 400 without creating a session; empty bodies still create', async t => {
  const manager = new RuntimeSessionManager({ createAgent: () => { throw new Error('unused') }, defaultCwd: tmpdir() })
  const server = await startServer(0, buildSessionRoutes(manager, auth), auth)
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const url = `http://127.0.0.1:${server.port}/sessions`
  const bad = await fetch(url, { method: 'POST', headers, body: '{broken' })
  assert.equal(bad.status, 400)
  assert.equal(manager.listSessions().length, 0)
  const empty = await fetch(url, { method: 'POST', headers })
  assert.equal(empty.status, 201)
  await empty.text()
  assert.equal(manager.listSessions().length, 1)
})

test('oversized HTTP bodies deliver 413 without entering the mutation handler', async t => {
  let mutations = 0
  const server = await startServer(0, { 'POST /fixture': () => { mutations++; return { status: 201 } } }, auth)
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${server.port}/fixture`, { method: 'POST', headers }, res => {
      let body = ''
      res.on('data', chunk => { body += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end(Buffer.alloc(64 * 1024 * 1024 + 1, 32))
  })
  assert.equal(response.status, 413)
  assert.match(response.body, /too large/i)
  assert.equal(mutations, 0)
})

test('disconnect during real HTTP SSE replay leaves no subscription or registry entry', async t => {
  const manager = new RuntimeSessionManager({ createAgent: () => { throw new Error('unused') }, defaultCwd: tmpdir() })
  const record = manager.createSession({})
  const session = (manager as unknown as { sessions: Map<string, { events: unknown[]; seq: number; listeners: Set<unknown> }> }).sessions.get(record.id)!
  for (let seq = 1; seq <= 8000; seq++) session.events.push({ seq, ts: 1, type: 'error', data: { error: 'fictional replay' } })
  session.seq = 8000
  const registry = new SseConnectionRegistry()
  const routes = buildSessionRoutes(manager, auth, undefined, undefined, { sseRegistry: registry })
  const stream = routes['GET /sessions/:id/stream']!
  let finished = false
  routes['GET /sessions/:id/stream'] = async (...args) => {
    try { return await stream(...args) } finally { finished = true }
  }
  const server = await startServer(0, routes, auth)
  t.after(() => { registry.closeAll(); return new Promise<void>(resolve => server.close(() => resolve())) })
  await new Promise<void>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${server.port}/sessions/${record.id}/stream`, { headers }, res => {
      res.once('data', () => { res.destroy(); resolve() })
    })
    req.on('error', reject)
    req.end()
  })
  await until(() => finished)
  await delay(20)
  assert.equal(session.listeners.size, 0)
  assert.equal(registry.size, 0)
})

test('retry runs in the original workspace through SessionRuntimePool', async t => {
  const root = mkdtempSync(join(tmpdir(), 'retry-workspace-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwds: string[] = []
  const pool = new SessionRuntimePool({
    defaultCwd: join(root, 'default'),
    manager: {
      createSession: (options: { cwd: string }) => { cwds.push(options.cwd); return { id: `fixture-${cwds.length}` } },
      runAndWait: async () => ({ status: cwds.length === 1 ? 'failed' : 'completed', summary: 'fictional', changedFiles: [] }),
      abort() {},
    } as unknown as RuntimeSessionManager,
  })
  const registry = new TaskRegistry({ taskStore: new JsonTaskStore(root), runtimePool: pool })
  t.after(() => registry.dispose())
  const original = await registry.createTask({ prompt: 'fictional check', source: 'cron', cwd: join(root, 'project-a'), retry: { maxAttempts: 2, backoffMs: 0 } })
  await until(async () => (await registry.listTasks()).some(task => task.attempt === 2 && task.status === 'completed'))
  assert.deepEqual(cwds, [join(root, 'project-a'), join(root, 'project-a')])
  assert.equal((await registry.listTasks()).find(task => task.retryOf === original.id)?.cwd, join(root, 'project-a'))
})

test('cancel during backoff prevents another task attempt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'retry-cancel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let executions = 0
  const registry = new TaskRegistry({
    taskStore: new JsonTaskStore(root),
    runtimePool: { size: 0, acquire: async () => ({ execute: async () => { executions++; throw new Error('fixture failure') }, release() {} }) },
  })
  t.after(() => registry.dispose())
  const task = await registry.createTask({ prompt: 'fictional check', source: 'cron', retry: { maxAttempts: 2, backoffMs: 100 } })
  await until(async () => (await registry.getTask(task.id))?.status === 'failed')
  assert.equal((await registry.cancel(task.id))?.status, 'cancelled')
  await delay(200)
  assert.equal(executions, 1)
  assert.equal((await registry.listTasks()).length, 1)
})

test('distinct schedules with the same prompt get distinct tasks while one schedule still deduplicates', async t => {
  const root = mkdtempSync(join(tmpdir(), 'schedule-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const registry = new TaskRegistry({ taskStore: new JsonTaskStore(root) })
  t.after(() => registry.dispose())
  const input = { prompt: 'fictional check', source: 'cron' as const, callerId: 'cron-scheduler' }
  const first = await registry.createTask({ ...input, scheduledTaskId: 'fixture-schedule-a', cwd: '/fictional/a' })
  const second = await registry.createTask({ ...input, scheduledTaskId: 'fixture-schedule-b', cwd: '/fictional/b' })
  const repeated = await registry.createTask({ ...input, scheduledTaskId: 'fixture-schedule-a', cwd: '/fictional/a' })
  assert.notEqual(first.id, second.id)
  assert.equal(repeated.id, first.id)
  assert.equal((await registry.listTasks()).length, 2)
})
