/**
 * CronWiring 集成测试 — cron-scheduler → TaskRegistry 完整链路
 *
 * 验证：
 * - CronScheduler 触发 → TaskRegistry 创建 cron 任务
 * - 任务 source='cron'
 * - 锁未获取时不启动 scheduler
 * - end-to-end: schedule → task creation
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CronScheduler,
  createScheduledTask,
  type ScheduledTask,
} from '../cron-scheduler.js'
import { CronLock, type LockInfo } from '../cron-lock.js'
import { TaskRegistry } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'
import { CronWiring } from '../cron-wiring.js'

// Hermetic: unique temp dir per setup() instead of a shared fixed .test-tmp
// path, so concurrent runs/sessions never collide.
let TEST_SCHEDULE_PATH = ''
let TEST_LOCK_PATH = ''
let TEST_TASKS_DIR = ''

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cron-wiring-'))
  TEST_SCHEDULE_PATH = join(tmpDir, 'wiring-test-sched.json')
  TEST_LOCK_PATH = join(tmpDir, 'wiring-test-lock.lock')
  TEST_TASKS_DIR = join(tmpDir, 'wiring-test-tasks')

  const store = new JsonTaskStore(TEST_TASKS_DIR)
  const registry = new TaskRegistry({ taskStore: store })
  const scheduler = new CronScheduler({
    schedulePath: TEST_SCHEDULE_PATH,
    tickIntervalMs: 50,
  })
  const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })

  return { store, registry, scheduler, lock }
}

describe('CronWiring', () => {
  let cleanup: () => void

  afterEach(() => {
    cleanup?.()
  })

  it('scheduler triggers cron task creation in registry', async () => {
    const { registry, scheduler } = setup()
    cleanup = () => {
      scheduler.stop()
      rmSync(TEST_SCHEDULE_PATH, { force: true })
      rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
    }

    const wiring = new CronWiring({ scheduler, registry })

    // 添加一个 oneshot 任务（立即过期，调度时触发）
    const task = createScheduledTask('cron health check', {
      type: 'oneshot',
      spec: new Date(Date.now() + 50).toISOString(),
    })
    scheduler.add(task)

    await wiring.start()

    // 等待 tick 触发
    await sleep(200)

    // 验证 TaskRegistry 中有 source='cron' 的任务
    const tasks = await registry.listTasks({ source: 'cron' })
    assert.ok(tasks.length >= 1, `expected >= 1 cron tasks, got ${tasks.length}`)
    assert.equal(tasks[0]!.source, 'cron')
    assert.equal(tasks[0]!.prompt, 'cron health check')

    await wiring.stop()
  })

  it('interval task creates multiple cron tasks over time', async () => {
    const { registry, scheduler } = setup()
    cleanup = () => {
      scheduler.stop()
      rmSync(TEST_SCHEDULE_PATH, { force: true })
      rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
    }

    const wiring = new CronWiring({ scheduler, registry })

    const task = createScheduledTask('periodic check', {
      type: 'interval',
      spec: '50', // 50ms
    })
    scheduler.add(task)

    await wiring.start()
    await sleep(250)

    const cronTasks = await registry.listTasks({ source: 'cron' })
    // 250ms / 50ms ≈ 5 次触发，但去重 key 相同 → 返回同一个 task
    // 去重 key 基于 prompt + callerId + time_bucket_5min
    assert.ok(cronTasks.length >= 1, `expected >= 1 cron tasks, got ${cronTasks.length}`)

    await wiring.stop()
  })

  it('lock contention prevents scheduler from starting', async () => {
    const { registry, scheduler, lock } = setup()
    cleanup = () => {
      // Ensure scheduler is stopped even if test fails
      scheduler.stop()
      rmSync(TEST_LOCK_PATH, { force: true })
      rmSync(TEST_SCHEDULE_PATH, { force: true })
      rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
    }

    // 伪造另一个进程持有锁 — 使用 PID 1（launchd，始终存活但非本进程）
    const fakeOwner: LockInfo = {
      pid: 1,
      acquiredAt: new Date().toISOString(),
      hostname: 'other-process',
    }
    writeFileSync(TEST_LOCK_PATH, JSON.stringify(fakeOwner), 'utf-8')

    const wiring = new CronWiring({ scheduler, registry, lock })
    const status = await wiring.start()

    assert.equal(status.schedulerRunning, false)
    assert.equal(status.lockOwner, false)
  })

  it('getStatus reports correct counts', async () => {
    const { registry, scheduler, lock } = setup()
    cleanup = () => {
      scheduler.stop()
      rmSync(TEST_SCHEDULE_PATH, { force: true })
      rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
      rmSync(TEST_LOCK_PATH, { force: true })
    }

    const wiring = new CronWiring({ scheduler, registry, lock })

    // 添加一些 schedule
    scheduler.add(createScheduledTask('task a', { type: 'interval', spec: '60000' }))
    scheduler.add(createScheduledTask('task b', { type: 'interval', spec: '120000' }))

    await wiring.start()

    const status = await wiring.getStatus()
    assert.equal(status.schedulerRunning, true)
    assert.equal(status.lockOwner, true)
    assert.equal(status.scheduledCount, 2)

    await wiring.stop()
  })

  it('recoverStaleTasks is called on start', async () => {
    const { registry, scheduler } = setup()
    cleanup = () => {
      scheduler.stop()
      rmSync(TEST_SCHEDULE_PATH, { force: true })
      rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
    }

    // 直接在 registry 创建 running 任务（模拟进程崩溃后残留）
    const task = await registry.createTask({
      prompt: 'stale task',
      source: 'cron',
      callerId: 'test',
    })
    await registry.transition(task.id, 'running')

    const wiring = new CronWiring({ scheduler, registry })
    await wiring.start()

    // 验证陈旧任务被标记为 timed_out
    const staleTask = await registry.getTask(task.id)
    assert.equal(staleTask!.status, 'timed_out')

    await wiring.stop()
  })

  it('stop releases lock', async () => {
    const { scheduler, registry, lock } = setup()
    cleanup = () => {
      scheduler.stop()
      rmSync(TEST_SCHEDULE_PATH, { force: true })
      rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
      rmSync(TEST_LOCK_PATH, { force: true })
    }

    const wiring = new CronWiring({ scheduler, registry, lock })
    await wiring.start()
    assert.ok(lock.isOwner())

    await wiring.stop()
    assert.equal(lock.isOwner(), false)
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('CronWiring cwd 透传（2026-09-11 F2）', () => {
  let cleanup: () => void
  afterEach(() => { cleanup?.() })

  it('定时任务触发的 TaskRecord 携带创建工作区 cwd', async () => {
    const { registry, scheduler, lock } = setup()
    cleanup = () => {
      scheduler.stop()
      rmSync(TEST_LOCK_PATH, { force: true })
      rmSync(TEST_SCHEDULE_PATH, { force: true })
      rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
    }
    const task = createScheduledTask('deps check in A', { type: 'interval', spec: '50' }, [], { cwd: '/workspace/A' })
    scheduler.add(task)
    const wiring = new CronWiring({ scheduler, registry, lock })
    await wiring.start()
    await sleep(250)
    const cronTasks = await registry.listTasks({ source: 'cron' })
    assert.ok(cronTasks.length >= 1)
    assert.equal(cronTasks[0]!.cwd, '/workspace/A',
      'cron 触发的任务必须记录创建工作区（执行 cwd 的来源）')
    await wiring.stop()
  })
})

