/**
 * issue #290 — 非锁主进程的调度表写守卫。
 *
 * 病灶：多 sidecar 指向同一 desktop 目录时，非锁主进程（CronWiring.start()
 * 对锁竞争败者早退）内存调度表恒空——loadSchedule 只在 scheduler.start() 里
 * 执行。此进程上任何写操作（POST /schedule、DELETE、PATCH、pause/stop/
 * run-now、schedule_create/delete 工具）都会以空表为基底**整表覆写**
 * scheduled_tasks.json：一次建任务即静默删除盘上全部既有任务定义；锁主下次
 * 落盘又按它的旧内存表反向删掉非锁主建的任务（乒乓互删）。
 *
 * 守卫：serve.ts 给 buildScheduleRoutes 注入 isWriteAllowed = lock.isOwner()
 * （处理器运行时动态判定——锁竞争在异步 wiring.start() 里，注册时未知）；
 * 工具侧同口径（见 tools/schedule/__tests__/tool.test.ts）。
 *
 * 非锁主用真 CronLock 模拟：锁文件写一个别的 hostname 的活 PID（cron-wiring
 * 测试同款手法），acquire() → contended → isOwner() = false。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { CronScheduler, createScheduledTask, type ScheduledTask } from '../cron-scheduler.js'
import { CronLock, type LockInfo } from '../cron-lock.js'
import { buildScheduleRoutes } from '../schedule-routes.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-sched-writeguard-'))
}

/** 盘上放一个既有任务 T1（非锁主进程从没载入过它——这正是覆写病灶的前提）。 */
function seedDiskTable(path: string): ScheduledTask {
  const task = createScheduledTask('existing task from lock owner', { type: 'interval', spec: '3600000' })
  writeFileSync(path, JSON.stringify([task], null, 2), 'utf-8')
  return task
}

/** 伪造另一进程持有锁：别的 hostname + 恒存活的 PID 1 → acquire() 必 contended。 */
function contendedLock(lockPath: string): CronLock {
  const foreignOwner: LockInfo = {
    pid: 1,
    acquiredAt: new Date().toISOString(),
    hostname: 'other-sidecar',
  }
  writeFileSync(lockPath, JSON.stringify(foreignOwner), 'utf-8')
  const lock = new CronLock({ lockPath, healthCheckIntervalMs: 999_999 })
  const state = lock.acquire()
  assert.equal(state.status, 'contended', '测试前提：锁被其他进程持有')
  assert.equal(lock.isOwner(), false)
  return lock
}

describe('非锁主写路由守卫（issue #290）', () => {
  test('POST /schedule 被拒（503 + 明确错误体），盘上 scheduled_tasks.json 原封不动', async () => {
    const dir = tmpDir()
    try {
      const schedulePath = join(dir, 'scheduled_tasks.json')
      const t1 = seedDiskTable(schedulePath)
      // 非锁主：scheduler 不 start()（wiring 对锁竞争败者早退，内存表恒空）。
      const scheduler = new CronScheduler({ schedulePath })
      const lock = contendedLock(join(dir, 'scheduled_tasks.lock'))
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN, {
        isWriteAllowed: () => lock.isOwner(),
      }))
      const diskBefore = readFileSync(schedulePath, 'utf-8')

      const res = await router('POST', '/schedule', {
        prompt: 'non-owner tries to create',
        trigger: { type: 'interval', spec: '60000' },
      }, AUTH)

      assert.equal(res.status, 503, `非锁主建任务必须 5xx，got ${res.status}`)
      assert.match((res.body as { error: string }).error, /lock/, '错误体说明锁主校验')
      // 盘表字节级未动：T1 仍在、无新任务混入
      assert.equal(readFileSync(schedulePath, 'utf-8'), diskBefore, '盘上任务定义不得被触碰')
      assert.deepEqual(JSON.parse(diskBefore).map((t: ScheduledTask) => t.id), [t1.id])
      // 内存表也未被动过（守卫在 add 之前拦）
      assert.equal(scheduler.list().length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('DELETE / PATCH / pause / stop / run-now 同样被拒且盘表不动', async () => {
    const dir = tmpDir()
    try {
      const schedulePath = join(dir, 'scheduled_tasks.json')
      const t1 = seedDiskTable(schedulePath)
      const scheduler = new CronScheduler({ schedulePath })
      const lock = contendedLock(join(dir, 'scheduled_tasks.lock'))
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN, {
        isWriteAllowed: () => lock.isOwner(),
      }))
      const diskBefore = readFileSync(schedulePath, 'utf-8')

      const attempts: Array<[string, string, unknown]> = [
        ['DELETE', `/schedule/${t1.id}`, {}],
        ['PATCH', `/schedule/${t1.id}`, { prompt: 'hijacked' }],
        ['POST', `/schedule/${t1.id}/pause`, { enabled: false }],
        ['POST', `/schedule/${t1.id}/stop`, {}],
        ['POST', `/schedule/${t1.id}/run-now`, {}],
      ]
      for (const [method, path, body] of attempts) {
        const res = await router(method, path, body, AUTH)
        assert.equal(res.status, 503, `${method} ${path} 非锁主必须 503，got ${res.status}`)
        assert.equal(readFileSync(schedulePath, 'utf-8'), diskBefore, `${method} 后盘表不得变化`)
      }
      assert.equal(scheduler.list().length, 0, '内存表也不得有残留')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('GET /schedule 读不受限（200 正常返回）', async () => {
    const dir = tmpDir()
    try {
      const schedulePath = join(dir, 'scheduled_tasks.json')
      seedDiskTable(schedulePath)
      const scheduler = new CronScheduler({ schedulePath })
      const lock = contendedLock(join(dir, 'scheduled_tasks.lock'))
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN, {
        isWriteAllowed: () => lock.isOwner(),
      }))

      const res = await router('GET', '/schedule', {}, AUTH)
      assert.equal(res.status, 200)
      // 非锁主内存表为空 → 列表为空：这是既有的读路径陈旧性（不在 #290 修
      // 范围），此处只断言读不被守卫拦截。
      assert.deepEqual((res.body as { tasks: unknown[] }).tasks, [])
      const statusRes = await router('GET', '/schedule/status', {}, AUTH)
      assert.equal(statusRes.status, 200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('锁主 / 单进程同路径正常写（issue #290 守卫不拦合法写）', () => {
  test('抢到锁的进程：POST / PATCH / DELETE 全部放行且落盘', async () => {
    const dir = tmpDir()
    try {
      const schedulePath = join(dir, 'scheduled_tasks.json')
      const scheduler = new CronScheduler({ schedulePath })
      const lock = new CronLock({ lockPath: join(dir, 'scheduled_tasks.lock'), healthCheckIntervalMs: 999_999 })
      assert.equal(lock.acquire().status, 'acquired', '空锁路径应抢到锁')
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN, {
        isWriteAllowed: () => lock.isOwner(),
      }))

      const created = await router('POST', '/schedule', {
        prompt: 'owner creates', trigger: { type: 'interval', spec: '3600000' },
      }, AUTH)
      assert.equal(created.status, 201)
      const id = (created.body as ScheduledTask).id
      assert.equal(JSON.parse(readFileSync(schedulePath, 'utf-8')).length, 1, '锁主写必须落盘')

      const patched = await router('PATCH', `/schedule/${id}`, { prompt: 'owner updates' }, AUTH)
      assert.equal(patched.status, 200)

      const removed = await router('DELETE', `/schedule/${id}`, {}, AUTH)
      assert.equal(removed.status, 200)
      assert.equal(JSON.parse(readFileSync(schedulePath, 'utf-8')).length, 0)

      lock.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('未注入守卫（缺省）＝允许：单进程 / CLI / 既有测试语义不变', async () => {
    const dir = tmpDir()
    try {
      const schedulePath = join(dir, 'scheduled_tasks.json')
      const scheduler = new CronScheduler({ schedulePath })
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))
      const res = await router('POST', '/schedule', {
        prompt: 'default allows', trigger: { type: 'interval', spec: '3600000' },
      }, AUTH)
      assert.equal(res.status, 201)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
