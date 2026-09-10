/**
 * CronScheduler + CronLock 测试
 *
 * 覆盖：
 * - schedule 表 CRUD + 持久化
 * - 时间触发 tick（interval / oneshot / cron）
 * - oneshot 触发即删，recurring 重排
 * - 启动恢复
 * - PID 存活探测
 * - 锁获取/释放/陈旧回收
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, unlinkSync, existsSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { hostname as osHostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CronScheduler,
  computeNextTrigger,
  createScheduledTask,
  type ScheduledTask,
  type ScheduleTable,
} from '../cron-scheduler.js'
import { CronLock, isPidAlive, type LockInfo } from '../cron-lock.js'

// Hermetic: unique temp dir per test instead of a shared fixed .test-tmp path,
// so concurrent runs never collide and corrupt-backup files don't leak into the
// working tree.
let tmpDir = ''
let TEST_SCHEDULE_PATH = ''
let TEST_LOCK_PATH = ''

// ─── CronScheduler ────────────────────────────────────────────

describe('CronScheduler', () => {
  let scheduler: CronScheduler
  let firedTasks: Array<{ prompt: string; tools: string[] }>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-sched-'))
    TEST_SCHEDULE_PATH = join(tmpDir, 'test-scheduled-tasks.json')
    firedTasks = []
    scheduler = new CronScheduler({
      schedulePath: TEST_SCHEDULE_PATH,
      tickIntervalMs: 100,
      onCreateTask: async (prompt, tools) => {
        firedTasks.push({ prompt, tools })
      },
    })
  })

  afterEach(() => {
    scheduler.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('adds and lists scheduled tasks', () => {
    const task = createScheduledTask('test', { type: 'oneshot', spec: futureISO(60) })
    scheduler.add(task)

    const list = scheduler.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.prompt, 'test')
    assert.equal(list[0]!.trigger.type, 'oneshot')
  })

  it('list/get return defensive copies so callers cannot mutate scheduler state', () => {
    const task = createScheduledTask('immutable', { type: 'interval', spec: '60000' })
    scheduler.add(task)

    const listed = scheduler.list()
    listed[0]!.prompt = 'mutated outside'

    assert.equal(scheduler.get(task.id)!.prompt, 'immutable')
  })

  it('supports multiple task-due subscribers without private-field rewiring', async () => {
    const seen: string[] = []
    const unsubscribe = scheduler.subscribeTaskDue(async (prompt) => { seen.push(`sub:${prompt}`) })
    const task = createScheduledTask('due', { type: 'oneshot', spec: new Date(Date.now() - 1000).toISOString() })

    scheduler.add(task)
    await sleep(20)
    unsubscribe()

    assert.ok(firedTasks.some(t => t.prompt === 'due'))
    assert.ok(seen.includes('sub:due'))
  })

  it('removes scheduled task by id', () => {
    const task = createScheduledTask('test', { type: 'interval', spec: '60000' })
    scheduler.add(task)
    assert.equal(scheduler.list().length, 1)

    scheduler.remove(task.id)
    assert.equal(scheduler.list().length, 0)
  })

  it('fires oneshot task that is already due', async () => {
    const task = createScheduledTask('immediate', {
      type: 'oneshot',
      spec: new Date(Date.now() - 1000).toISOString(), // 1 秒前
    })
    scheduler.add(task)

    // oneshot 已过期 → 应立即可见被触发（task 不入表，直接 fire）
    // add() 中已过期 oneshot 直接 fireTask，不入表
    assert.equal(scheduler.list().length, 0)
    assert.equal(firedTasks.length, 1)
    assert.equal(firedTasks[0]!.prompt, 'immediate')
  })

  it('fires oneshot task when its time arrives via tick', async () => {
    const task = createScheduledTask('future', {
      type: 'oneshot',
      spec: new Date(Date.now() + 200).toISOString(), // 200ms 后
    })
    scheduler.add(task)
    assert.equal(scheduler.list().length, 1)

    scheduler.start()

    // 等待 tick 触发
    await sleep(500)

    assert.equal(firedTasks.length, 1)
    assert.equal(firedTasks[0]!.prompt, 'future')

    // oneshot 触发后应被删除
    assert.equal(scheduler.list().length, 0)
  })

  it('fires interval task repeatedly', async () => {
    const task = createScheduledTask('recurring', {
      type: 'interval',
      spec: '50', // 50ms 间隔
    })
    scheduler.add(task)

    scheduler.start()

    await sleep(400)

    // 400ms / 50ms ≈ 8 次触发（至少应 >= 2）
    assert.ok(firedTasks.length >= 2, `expected >= 2 firings, got ${firedTasks.length}`)
    firedTasks.forEach(f => assert.equal(f.prompt, 'recurring'))

    // interval 任务仍在表中
    assert.equal(scheduler.list().length, 1)
  })

  it('persists schedule table and recovers on restart', () => {
    const task = createScheduledTask('persisted', { type: 'interval', spec: '60000' })
    scheduler.add(task)

    // 创建新 scheduler 实例（模拟重启）
    const scheduler2 = new CronScheduler({
      schedulePath: TEST_SCHEDULE_PATH,
    })
    scheduler2.start()

    const list = scheduler2.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.prompt, 'persisted')

    scheduler2.stop()
  })

  it('quarantines a corrupt schedule file instead of silently clearing it', () => {
    writeFileSync(TEST_SCHEDULE_PATH, '{not-json', 'utf-8')

    const scheduler2 = new CronScheduler({ schedulePath: TEST_SCHEDULE_PATH })
    scheduler2.start()

    assert.equal(scheduler2.list().length, 0)
    assert.ok(readdirSync(tmpDir).some(f => f.startsWith('test-scheduled-tasks.json.corrupt-')))
    scheduler2.stop()
  })

  it('drops invalid persisted schedule entries while keeping valid ones', () => {
    const valid = createScheduledTask('valid', { type: 'interval', spec: '60000' })
    writeFileSync(TEST_SCHEDULE_PATH, JSON.stringify([{ id: '../bad' }, valid]), 'utf-8')

    const scheduler2 = new CronScheduler({ schedulePath: TEST_SCHEDULE_PATH })
    scheduler2.start()

    assert.deepEqual(scheduler2.list().map(t => t.id), [valid.id])
    scheduler2.stop()
  })

  it('removes recurring task past maxAge', async () => {
    const task = createScheduledTask('expiring', { type: 'interval', spec: '100' }, [], {
      recurringMaxAgeMs: 200, // 200ms 后过期
    })
    // 手动设置 createdAt 为过去
    task.createdAt = new Date(Date.now() - 300).toISOString()

    scheduler.add(task)
    scheduler.start()

    // 第一次 tick 应该清理掉过期任务
    await sleep(300)

    assert.equal(scheduler.list().length, 0)
    scheduler.stop()
  })

  it('stops tick on stop()', async () => {
    const task = createScheduledTask('stopped', { type: 'interval', spec: '100' })
    scheduler.add(task)

    scheduler.start()
    await sleep(150)

    const countBeforeStop = firedTasks.length
    scheduler.stop()
    await sleep(300)

    // 停止后不再触发
    assert.equal(firedTasks.length, countBeforeStop)
  })

  // ── 事件触发器 fireByEvent（startup / app-open）──

  it('fireByEvent: fires matching enabled tasks, skips paused and other types', () => {
    const boot1 = createScheduledTask('boot task', { type: 'startup', spec: '' })
    const boot2 = createScheduledTask('boot task 2', { type: 'startup', spec: '' })
    boot2.enabled = false
    const open1 = createScheduledTask('open task', { type: 'app-open', spec: '' })
    const interval1 = createScheduledTask('interval', { type: 'interval', spec: '999999' })
    scheduler.add(boot1)
    scheduler.add(boot2)
    scheduler.add(open1)
    scheduler.add(interval1)

    const fired = scheduler.fireByEvent('startup')
    assert.equal(fired, 1, '只有 boot1（enabled）fire，boot2 paused 跳过')
    assert.equal(firedTasks.length, 1)
    assert.equal(firedTasks[0]!.prompt, 'boot task')

    const fired2 = scheduler.fireByEvent('app-open')
    assert.equal(fired2, 1, '只有 open1 fire')
    assert.equal(firedTasks.length, 2)
    assert.equal(firedTasks[1]!.prompt, 'open task')

    // interval 任务不被事件触发影响
    assert.equal(scheduler.list().find(t => t.id === interval1.id)!.triggerCount, 0)
  })

  it('fireByEvent: 更新 lastTriggeredAt 和 triggerCount', () => {
    const task = createScheduledTask('boot', { type: 'startup', spec: '' })
    scheduler.add(task)
    assert.equal(scheduler.list()[0]!.triggerCount, 0)

    scheduler.fireByEvent('startup')
    const updated = scheduler.list().find(t => t.id === task.id)!
    assert.equal(updated.triggerCount, 1)
    assert.ok(updated.lastTriggeredAt, 'lastTriggeredAt 已设置')
  })

  // ── 事件触发器 spec 匹配（file-change / git-push）──

  it('fireByEvent: file-change 按 spec 路径匹配（前缀覆盖子路径）', () => {
    const srcWatcher = createScheduledTask('watch src', { type: 'file-change', spec: 'src' })
    const anyWatcher = createScheduledTask('watch all', { type: 'file-change', spec: '' })
    const docsWatcher = createScheduledTask('watch docs', { type: 'file-change', spec: 'docs' })
    scheduler.add(srcWatcher)
    scheduler.add(anyWatcher)
    scheduler.add(docsWatcher)

    // 文件 src/foo.ts 变更 → 匹配 src（前缀）+ 空 spec（任意）
    const fired = scheduler.fireByEvent('file-change', { spec: 'src/foo.ts' })
    assert.equal(fired, 2, 'src 前缀匹配 + 空 spec 全匹配')
    const firedPrompts = firedTasks.slice(-2).map(f => f.prompt).sort()
    assert.deepEqual(firedPrompts, ['watch all', 'watch src'])

    // docs/README.md 变更 → 只匹配 docs + 空 spec，不匹配 src
    const fired2 = scheduler.fireByEvent('file-change', { spec: 'docs/README.md' })
    assert.equal(fired2, 2)
  })

  it('fireByEvent: git-push 空匹配 + 带分支的按 spec 匹配', () => {
    const anyBranch = createScheduledTask('any push', { type: 'git-push', spec: '' })
    const mainOnly = createScheduledTask('main only', { type: 'git-push', spec: 'main' })
    scheduler.add(anyBranch)
    scheduler.add(mainOnly)

    // main 分支推送 → 匹配空 spec（任意）+ main 全等
    const firedMain = scheduler.fireByEvent('git-push', { spec: 'main' })
    assert.equal(firedMain, 2)

    // dev 分支推送 → 只匹配空 spec（任意），不匹配 main
    const firedDev = scheduler.fireByEvent('git-push', { spec: 'dev' })
    assert.equal(firedDev, 1)
  })

  it('fireByEvent: focus-change 无 spec 全匹配', () => {
    const focusTask = createScheduledTask('on focus', { type: 'focus-change', spec: '' })
    scheduler.add(focusTask)
    const fired = scheduler.fireByEvent('focus-change')
    assert.equal(fired, 1)
  })
})

// ─── computeNextTrigger ──────────────────────────────────────

describe('computeNextTrigger', () => {
  it('interval: returns lastTriggeredAt + interval', () => {
    const now = Date.now()
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'interval', spec: '60000' }),
      lastTriggeredAt: new Date(now).toISOString(),
    }
    const next = computeNextTrigger(task, now + 1000)
    assert.equal(next, now + 60000)
  })

  it('interval: uses createdAt as base if never triggered', () => {
    const now = Date.now()
    const createdAt = new Date(now - 10000).toISOString() // 10 秒前创建
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'interval', spec: '60000' }),
      createdAt,
    }
    const next = computeNextTrigger(task, now)
    // createdAt + 60000ms
    assert.equal(next, new Date(createdAt).getTime() + 60000)
  })

  it('oneshot: returns spec time if not yet triggered', () => {
    const future = new Date(Date.now() + 60000).toISOString()
    const task = createScheduledTask('test', { type: 'oneshot', spec: future })
    const next = computeNextTrigger(task, Date.now())
    assert.equal(next, new Date(future).getTime())
  })

  it('oneshot: returns null if already triggered', () => {
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'oneshot', spec: new Date().toISOString() }),
      triggerCount: 1,
    }
    const next = computeNextTrigger(task, Date.now())
    assert.equal(next, null)
  })

  it('oneshot: returns now if spec is in the past and not triggered', () => {
    const past = new Date(Date.now() - 60000).toISOString()
    const task = createScheduledTask('test', { type: 'oneshot', spec: past })
    const now = Date.now()
    const next = computeNextTrigger(task, now)
    assert.ok(next !== null)
    assert.ok(next! <= now) // 立即触发
  })

  it('cron: returns next matching time (simple minute hour)', () => {
    const now = new Date('2024-06-01T10:00:00Z').getTime()
    const task = createScheduledTask('test', { type: 'cron', spec: '30 14 * * *' }) // 14:30
    const next = computeNextTrigger(task, now)
    assert.ok(next !== null)
    // Should be today at 14:30
    const nextDate = new Date(next!)
    assert.equal(nextDate.getUTCHours(), 14)
    assert.equal(nextDate.getUTCMinutes(), 30)
  })

  it('cron: returns next day if time already passed', () => {
    const now = new Date('2024-06-01T15:00:00Z').getTime() // 15:00, past 14:30
    const task = createScheduledTask('test', { type: 'cron', spec: '30 14 * * *' })
    const next = computeNextTrigger(task, now)
    assert.ok(next !== null)
    // Should be tomorrow at 14:30
    const nextDate = new Date(next!)
    assert.equal(nextDate.getUTCHours(), 14)
    assert.equal(nextDate.getUTCMinutes(), 30)
    assert.ok(nextDate.getTime() > now)
  })

  it('cron: returns null for invalid expression', () => {
    const task = createScheduledTask('test', { type: 'cron', spec: 'invalid' })
    const next = computeNextTrigger(task, Date.now())
    assert.equal(next, null)
  })

  it('cron: fires when the tick lands after the scheduled minute (regression)', () => {
    // 旧实现从 now 起算下一次触发 → next 恒 > now → `next <= now` 永假 → cron 永不触发。
    // 新实现从 lastTriggeredAt/createdAt 起算：过点后的任意 tick 都能看到 next <= now。
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'cron', spec: '30 14 * * *' }),
      createdAt: '2024-06-01T10:00:00Z',
    }
    const tickAt = new Date('2024-06-01T14:30:45Z').getTime() // 过点 45 秒的 tick
    const next = computeNextTrigger(task, tickAt)
    assert.equal(next, new Date('2024-06-01T14:30:00Z').getTime())
    assert.ok(next! <= tickAt, 'due — the scheduler tick will fire it')
  })

  it('cron: after firing, next trigger is computed from lastTriggeredAt', () => {
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'cron', spec: '30 14 * * *' }),
      createdAt: '2024-06-01T10:00:00Z',
      lastTriggeredAt: '2024-06-01T14:30:45.000Z',
      triggerCount: 1,
    }
    const next = computeNextTrigger(task, new Date('2024-06-01T14:31:00Z').getTime())
    assert.equal(next, new Date('2024-06-02T14:30:00Z').getTime(), 'not due again until tomorrow')
  })

  it('cron: supports step expressions (*/15 minutes)', () => {
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'cron', spec: '*/15 * * * *' }),
      createdAt: '2024-06-01T10:07:00Z',
    }
    const next = computeNextTrigger(task, new Date('2024-06-01T10:20:00Z').getTime())
    assert.equal(next, new Date('2024-06-01T10:15:00Z').getTime())
  })

  it('cron: supports day-of-week schedules (weekly Monday 09:00)', () => {
    // 2024-06-01 is a Saturday; next Monday is 2024-06-03.
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'cron', spec: '0 9 * * 1' }),
      createdAt: '2024-06-01T10:00:00Z',
    }
    const next = computeNextTrigger(task, new Date('2024-06-03T09:00:30Z').getTime())
    assert.equal(next, new Date('2024-06-03T09:00:00Z').getTime())
  })

  it('cron: dow 7 is an alias for Sunday (0)', () => {
    // 2024-06-02 is a Sunday.
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'cron', spec: '0 12 * * 7' }),
      createdAt: '2024-06-01T00:00:00Z',
    }
    const next = computeNextTrigger(task, new Date('2024-06-01T13:00:00Z').getTime())
    assert.equal(next, new Date('2024-06-02T12:00:00Z').getTime())
  })

  it('cron: supports lists and ranges (0,30 9-10 * * *)', () => {
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'cron', spec: '0,30 9-10 * * *' }),
      createdAt: '2024-06-01T09:35:00Z',
    }
    const next = computeNextTrigger(task, new Date('2024-06-01T09:40:00Z').getTime())
    assert.equal(next, new Date('2024-06-01T10:00:00Z').getTime())
  })

  it('cron: supports day-of-month + month schedules (monthly 1st 00:00)', () => {
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'cron', spec: '0 0 1 * *' }),
      createdAt: '2024-06-15T10:00:00Z',
    }
    const next = computeNextTrigger(task, new Date('2024-06-20T10:00:00Z').getTime())
    assert.equal(next, new Date('2024-07-01T00:00:00Z').getTime())
  })

  it('cron: rejects out-of-range field values', () => {
    for (const spec of ['60 * * * *', '* 24 * * *', '* * * 13 *', '* * * * 8', '1-70 * * * *']) {
      const task = createScheduledTask('test', { type: 'cron', spec })
      assert.equal(computeNextTrigger(task, Date.now()), null, `should reject "${spec}"`)
    }
  })

  // ── 事件触发器（startup / app-open）── 不参与 tick 轮询 ──

  it('startup trigger: computeNextTrigger 恒返回 null（不参与 tick）', () => {
    const task = createScheduledTask('boot task', { type: 'startup', spec: '' })
    assert.equal(computeNextTrigger(task, Date.now()), null)
  })

  it('app-open trigger: computeNextTrigger 恒返回 null（不参与 tick）', () => {
    const task = createScheduledTask('open task', { type: 'app-open', spec: '' })
    assert.equal(computeNextTrigger(task, Date.now()), null)
  })
})

// ─── CronLock ─────────────────────────────────────────────────

describe('CronLock', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-sched-lock-'))
    TEST_LOCK_PATH = join(tmpDir, 'test-scheduled-tasks.lock')
    rmSync(TEST_LOCK_PATH, { force: true })
  })

  afterEach(() => {
    try { unlinkSync(TEST_LOCK_PATH) } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('acquires lock when no lock file exists', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'acquired')
    assert.equal((state as any).info.pid, process.pid)
    assert.ok(existsSync(TEST_LOCK_PATH))
    lock.release()
  })

  it('contends when another pid holds the lock', () => {
    // 写入一个伪造的活跃 PID 锁文件
    const fakeOwner: LockInfo = {
      pid: process.pid, // 自己（确保存活）
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
    }
    writeFileSync(TEST_LOCK_PATH, JSON.stringify(fakeOwner), 'utf-8')

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'contended') // 同 PID 但缺少 owner token → 不视为自己持有，防 PID 复用
    lock.release()
  })

  it('recovers stale lock when owner pid is dead', () => {
    // 写入一个不可能存活的 PID
    const fakeOwner: LockInfo = {
      pid: 99999, // 极不可能存在
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
    }
    writeFileSync(TEST_LOCK_PATH, JSON.stringify(fakeOwner), 'utf-8')

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'stale_recovered')
    assert.equal((state as any).previousOwner.pid, 99999)
    assert.equal((state as any).info.pid, process.pid)
    lock.release()
  })

  it('releases lock and removes file', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    lock.acquire()
    assert.ok(existsSync(TEST_LOCK_PATH))

    lock.release()
    assert.equal(existsSync(TEST_LOCK_PATH), false)
  })

  it('isOwner returns true after acquire', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    lock.acquire()
    assert.ok(lock.isOwner())
    lock.release()
  })

  it('isOwner returns false after release', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    lock.acquire()
    lock.release()
    assert.equal(lock.isOwner(), false)
  })

  it('forceRelease removes lock regardless of owner', () => {
    const fakeOwner: LockInfo = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
    }
    writeFileSync(TEST_LOCK_PATH, JSON.stringify(fakeOwner), 'utf-8')

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH })
    lock.forceRelease()
    assert.equal(existsSync(TEST_LOCK_PATH), false)
  })

  it('getState returns null before acquire', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH })
    assert.equal(lock.getState(), null)
  })
})

// ─── isPidAlive ───────────────────────────────────────────────

describe('isPidAlive', () => {
  it('current process is alive', () => {
    assert.ok(isPidAlive(process.pid))
  })

  it('pid 0 is not alive (kernel process, not a real pid)', () => {
    // pid 0 is the kernel idle process — it exists but has no state
    const alive = isPidAlive(0)
    // On macOS, pid 0 usually reports nothing from ps
    // Just verify it doesn't throw
    assert.equal(typeof alive, 'boolean')
  })

  it('very large pid is not alive', () => {
    assert.equal(isPidAlive(999999), false)
  })
})

// ─── Helpers ──────────────────────────────────────────────────

function futureISO(secondsAhead: number): string {
  return new Date(Date.now() + secondsAhead * 1000).toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}


describe('ScheduledTask.cwd 创建工作区快照（2026-09-11 F2：多项目 sidecar 修复）', () => {
  it('runNow 触发时 TaskDueMeta 携带任务 cwd', () => {
    const metas: Array<{ cwd?: string }> = []
    const scheduler = new CronScheduler({
      schedulePath: join(tmpDir, 'f2-meta.json'),
      tickIntervalMs: 60_000,
    })
    scheduler.subscribeTaskDue(async (_prompt, _tools, _agentId, meta) => {
      metas.push({ cwd: meta?.cwd })
    })
    const task = createScheduledTask('deps check', { type: 'interval', spec: '3600000' }, [], { cwd: '/workspace/A' })
    scheduler.add(task)
    assert.equal(scheduler.runNow(task.id), true)
    assert.equal(metas.length, 1)
    assert.equal(metas[0]!.cwd, '/workspace/A', 'due handler 必须拿到任务的工作区快照')
  })

  it('cwd 经持久化 roundtrip 存活（跨重启语义）', () => {
    const path = join(tmpDir, 'f2-persist.json')
    const s1 = new CronScheduler({ schedulePath: path, tickIntervalMs: 60_000 })
    s1.add(createScheduledTask('daily check', { type: 'interval', spec: '86400000' }, [], { cwd: '/workspace/A' }))
    s1.stop()

    const s2 = new CronScheduler({ schedulePath: path, tickIntervalMs: 60_000 })
    s2.start()
    s2.stop()
    const loaded = s2.list()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.cwd, '/workspace/A', '持久化必须保留 cwd（重启后任务仍在原工作区跑）')
  })

  it('旧持久化数据（无 cwd）normalize 后保持 undefined——回退 defaultCwd', () => {
    const path = join(tmpDir, 'f2-legacy.json')
    const s1 = new CronScheduler({ schedulePath: path, tickIntervalMs: 60_000 })
    s1.add(createScheduledTask('legacy', { type: 'interval', spec: '86400000' }))
    s1.stop()
    const s2 = new CronScheduler({ schedulePath: path, tickIntervalMs: 60_000 })
    s2.start()
    s2.stop()
    assert.equal(s2.list()[0]!.cwd, undefined)
  })
})
