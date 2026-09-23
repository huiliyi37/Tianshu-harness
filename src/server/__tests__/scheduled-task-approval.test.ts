/**
 * 定时任务显式审批档位（issue #259）——透传链的不变量测试。
 *
 * 三条不变量：
 *  ① `CreateTaskInput.approvalMode` 必须一路到达 `RuntimeHandle.execute` 的 options；
 *  ② **未声明时零差异**——options 里不得出现 `approvalMode` 键（默认 fail-closed 不变）；
 *  ③ `SessionRuntimePool` 把 options.approvalMode 交给 `manager.createSession`（最后一跳）。
 *
 * 刻意**不测端到端行为**（真实 runtime + 沙箱 + 真实审批），那需要起 agent；
 * 这里钉的是"声明能不能传到消费点"与"缺省有没有被改动"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskRegistry, type RuntimeHandle, type RuntimePool, type RuntimeResult } from '../task-registry.js'
import type { TaskRecord, TaskStore } from '../task-store.js'
import { SessionRuntimePool } from '../session-runtime-pool.js'
import type { RuntimeSessionManager } from '../session-manager.js'

const settle = async () => {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
}

/** 最小 store：只为 createTask 的 find→save 路径服务。 */
function makeStore(): TaskStore {
  const map = new Map<string, TaskRecord>()
  return {
    async save(t: TaskRecord) { map.set(t.id, t) },
    async load(id: string) { return map.get(id) ?? null },
    async list() { return [...map.values()] },
    async delete(id: string) { map.delete(id) },
    async findActiveByIdempotencyKey() { return null },
  } as unknown as TaskStore
}

/** 捕获 handle.execute 收到的 options（第 5 个参数）。 */
function makePool() {
  const captured: Array<Record<string, unknown> | undefined> = []
  const pool = {
    size: 1,
    async acquire(): Promise<RuntimeHandle> {
      return {
        async execute(_prompt, _signal, _tools, _onStart, options) {
          captured.push(options as Record<string, unknown> | undefined)
          return { summary: 'ok', changedFiles: [] } as RuntimeResult
        },
        release() {},
      }
    },
  } as unknown as RuntimePool
  return { pool, captured }
}

// ── ① / ② ────────────────────────────────────────────────────

test('createTask：approvalMode 透传到 handle.execute（① 透传到底）', async () => {
  const { pool, captured } = makePool()
  const reg = new TaskRegistry({ taskStore: makeStore(), runtimePool: pool })

  await reg.createTask({
    prompt: 'p',
    source: 'cron',
    callerId: 'cron-scheduler',
    approvalMode: 'auto-safe',
  })
  await settle()

  assert.equal(captured.length, 1, '应执行一次')
  assert.equal(captured[0]?.['approvalMode'], 'auto-safe')
})

test('createTask：未声明时 options 不含 approvalMode 键（② 缺省零差异）', async () => {
  const { pool, captured } = makePool()
  const reg = new TaskRegistry({ taskStore: makeStore(), runtimePool: pool })

  await reg.createTask({ prompt: 'p', source: 'cron', callerId: 'cron-scheduler' })
  await settle()

  assert.equal(captured.length, 1)
  assert.equal(
    Object.prototype.hasOwnProperty.call(captured[0] ?? {}, 'approvalMode'),
    false,
    '缺省不得注入 approvalMode——否则语义从 fail-closed 漂移',
  )
  // unattended 的既有行为不受影响
  assert.equal(captured[0]?.['unattended'], false)
})

test('createTask：unattended 与 approvalMode 可并存且各自独立', async () => {
  const { pool, captured } = makePool()
  const reg = new TaskRegistry({ taskStore: makeStore(), runtimePool: pool })

  await reg.createTask({
    prompt: 'p',
    source: 'cron',
    callerId: 'cron-scheduler',
    unattended: true,
    approvalMode: 'auto-safe',
  })
  await settle()

  assert.equal(captured[0]?.['unattended'], true)
  assert.equal(captured[0]?.['approvalMode'], 'auto-safe')
})

// ── ③ 最后一跳 ────────────────────────────────────────────────

/** 最小 manager：只记录 createSession 的入参，其余方法不参与本用例。 */
function makeManager() {
  const created: Array<Record<string, unknown>> = []
  const manager = {
    createSession(opts: Record<string, unknown>) {
      created.push(opts)
      return { id: 'sess-1' }
    },
    // runAndWait 挂起：本用例只验 createSession 的入参，不关心 run 的终局
    runAndWait() { return new Promise<void>(() => {}) },
    abort() {},
  } as unknown as RuntimeSessionManager
  return { manager, created }
}

test('SessionRuntimePool：approvalMode 交给 createSession（③ 最后一跳）', async () => {
  const { manager, created } = makeManager()
  const pool = new SessionRuntimePool({ manager, defaultCwd: '/w' })

  const handle = await pool.acquire('task-1')
  void handle.execute('p', new AbortController().signal, undefined, undefined, {
    unattended: true,
    approvalMode: 'auto-safe',
  })
  await settle()

  assert.equal(created.length, 1)
  assert.equal(created[0]?.['approvalMode'], 'auto-safe')
  assert.equal(created[0]?.['unattended'], true, 'unattended 既有行为不变')
  assert.equal(created[0]?.['cwd'], '/w')
})

test('SessionRuntimePool：缺省时不向 createSession 注入 approvalMode（② 零点）', async () => {
  const { manager, created } = makeManager()
  const pool = new SessionRuntimePool({ manager, defaultCwd: '/w' })

  const handle = await pool.acquire('task-2')
  void handle.execute('p', new AbortController().signal, undefined, undefined, { unattended: true })
  await settle()

  assert.equal(created.length, 1)
  assert.equal(
    Object.prototype.hasOwnProperty.call(created[0] ?? {}, 'approvalMode'),
    false,
    '缺省不得注入——createSession 侧应保持既有默认档位',
  )
})
