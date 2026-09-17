/**
 * M3 automation reliability: bounded retry, session-terminal-status propagation
 * (a failed run must NOT be recorded as completed), and ScheduledTask linkage.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, mkdirSync } from 'node:fs'
import { JsonTaskStore } from '../task-store.js'
import { TaskRegistry, type RuntimePool, type RuntimeHandle } from '../task-registry.js'
import { SessionRuntimePool } from '../session-runtime-pool.js'
import type { RuntimeSessionManager } from '../session-manager.js'

const TEST_DIR = '.test-tmp/task-retry-test'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 等条件成立（有界轮询），替代「固定 `delay(N)` 等一条异步链」。
 *
 * 为什么必须换：重试链是 `setTimeout(backoffMs * attempt)` → `enqueue` → `JsonTaskStore`
 * 的**同步落盘**（task-registry.ts:247 / task-store.ts:157）。在本机 ≪120ms，但在共享
 * runner 上事件循环被并行用例挤占时会超出**任意**固定的等待窗口——CI 实测这条用例耗时
 * 381ms 并报错。固定睡眠赌的是机器速度，有界轮询等的是真实条件，超时才失败。
 *
 * 反向断言（「不该发生的事没发生」）不能用它证明，那类仍需固定窗口——见下面各用例的写法。
 */
async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await delay(10)
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）：${what}`)
}

/** Pool whose handle records execution and can be told to fail. */
class FakePool implements RuntimePool {
  size = 0
  executed: string[] = []
  constructor(private readonly behavior: (taskId: string) => 'ok' | 'fail') {}
  acquire(taskId: string): Promise<RuntimeHandle> {
    return Promise.resolve({
      execute: async (_prompt, _signal, _tools, onSessionStart) => {
        onSessionStart?.(`sess-${taskId}`)
        this.executed.push(taskId)
        if (this.behavior(taskId) === 'fail') throw new Error('boom')
        return { summary: 'done', changedFiles: [] }
      },
      release: () => { this.size = Math.max(0, this.size - 1) },
    })
  }
}

describe('TaskRegistry retry + linkage', () => {
  let store: JsonTaskStore
  let registry: TaskRegistry

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    store = new JsonTaskStore(TEST_DIR)
  })

  afterEach(() => {
    registry?.dispose()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('retries a failed task up to maxAttempts, linking retryOf + scheduledTaskId', async () => {
    const pool = new FakePool(() => 'fail')
    registry = new TaskRegistry({ taskStore: store, runtimePool: pool })

    await registry.createTask({
      prompt: 'p',
      source: 'cron',
      scheduledTaskId: 'cron_abc',
      retry: { maxAttempts: 2, backoffMs: 1 },
    })

    // 等「两条记录都在」这个真实条件，而不是赌一个固定的 120ms 窗口。
    await waitFor(async () => (await registry.listTasks()).length === 2, '首次尝试 + 一次重试两条记录落盘')

    const all = await registry.listTasks()
    // First attempt + one retry = 2 records, both failed, both linked to cron_abc.
    assert.equal(all.length, 2)
    assert.ok(all.every((t) => t.status === 'failed'))
    assert.ok(all.every((t) => t.scheduledTaskId === 'cron_abc'))

    const attempts = all.map((t) => t.attempt).sort()
    assert.deepEqual(attempts, [1, 2])
    const retryRec = all.find((t) => t.attempt === 2)!
    assert.ok(retryRec.retryOf, 'retry record points back to the original task')

    const scoped = await registry.listTasks({ scheduledTaskId: 'cron_abc' })
    assert.equal(scoped.length, 2)
  })

  it('does not retry when no retry policy is set', async () => {
    const pool = new FakePool(() => 'fail')
    registry = new TaskRegistry({ taskStore: store, runtimePool: pool })
    await registry.createTask({ prompt: 'p', source: 'cron' })
    // 反向断言：先等那条任务确实跑到终态（failed），再断言「没有第二条」。
    // 直接 sleep 后断言 count===1 是不稳的——sleep 不够长时任务可能还不在列表里，
    // 断言会「碰巧」通过而不是因为「没有重试」。
    await waitFor(async () => (await registry.listTasks())[0]?.status === 'failed', '单次尝试跑到 failed')
    await delay(60) // 再给重试调度一个窗口：若真要重试，这段时间足够它落第二条
    const all = await registry.listTasks()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.status, 'failed')
  })

  it('records sessionId even for failed runs, and completed for success', async () => {
    const okPool = new FakePool(() => 'ok')
    registry = new TaskRegistry({ taskStore: store, runtimePool: okPool })
    const t = await registry.createTask({ prompt: 'p', source: 'api' })
    await waitFor(async () => (await registry.getTask(t.id))?.status === 'completed', '任务跑到 completed')
    const done = await registry.getTask(t.id)
    assert.equal(done!.status, 'completed')
    assert.equal(done!.sessionId, `sess-${t.id}`)
    assert.equal(done!.attempt, 1)
  })
})

describe('SessionRuntimePool status propagation', () => {
  function fakeManager(status: string): RuntimeSessionManager {
    return {
      createSession: () => ({ id: 'sess-1' }),
      abort: () => {},
      runAndWait: async () => ({ status, summary: 'sum', changedFiles: ['a.ts'] }),
    } as unknown as RuntimeSessionManager
  }

  it('throws when the session terminates failed (so registry marks failed, not completed)', async () => {
    const pool = new SessionRuntimePool({ manager: fakeManager('failed'), defaultCwd: '/tmp' })
    const handle = await pool.acquire('task_x')
    await assert.rejects(() => handle.execute('p', new AbortController().signal))
  })

  it('throws when the session is aborted', async () => {
    const pool = new SessionRuntimePool({ manager: fakeManager('aborted'), defaultCwd: '/tmp' })
    const handle = await pool.acquire('task_x')
    await assert.rejects(() => handle.execute('p', new AbortController().signal))
  })

  it('resolves + reports the session id on success', async () => {
    const pool = new SessionRuntimePool({ manager: fakeManager('completed'), defaultCwd: '/tmp' })
    const handle = await pool.acquire('task_x')
    let reported: string | undefined
    const res = await handle.execute('p', new AbortController().signal, undefined, (sid) => { reported = sid })
    assert.equal(res.summary, 'sum')
    assert.deepEqual(res.changedFiles, ['a.ts'])
    assert.equal(reported, 'sess-1')
  })
})
