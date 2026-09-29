/**
 * issue #266 / D5 —— 调度表**写盘失败必须外显**。
 *
 * 此前 `persist()` 只 `serverLogger.error` 就返回：磁盘写不进去时接口照样 200，
 * 用户看到「保存成功」、重启后改动消失。这正是本仓反复记录的最贵 bug 形状
 * （静默降级：走通和走不通，观察者区分不了）。
 *
 * 失败注入手法：把 `schedulePath` 指到一个**文件底下**（`<tmpfile>/sched.json`）——
 * `mkdirSync(dirname)` 必然 ENOTDIR，且跨平台确定，不需要 chmod（Windows 上 chmod
 * 对目录基本无效，用它做失败注入会变成平台相关测试）。
 *
 * 语义边界同样是断言的一部分：写盘失败**不**回滚内存表——本轮调度照常，
 * `persisted:false` 只承诺「重启后会丢」。界面必须照这个语义说话，
 * 否则会把一次可恢复的权限问题说成「保存失败」，用户会去重打一遍。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { CronScheduler, createScheduledTask } from '../cron-scheduler.js'
import { buildScheduleRoutes } from '../schedule-routes.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** 造一个「父路径是文件」的不可写 schedulePath。 */
function unwritableSchedule(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-sched-persist-'))
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, 'x', 'utf-8')
  return { path: join(blocker, 'sched.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writableSchedule(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-sched-persist-ok-'))
  return { path: join(dir, 'sched.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('写盘失败外显（issue #266 / D5）', () => {
  test('persistenceHealth 记录失败原文与路径；恢复可写后自愈为 ok', () => {
    const bad = unwritableSchedule()
    const good = writableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: bad.path })
      assert.equal(scheduler.persistenceHealth().ok, true, '还没写过盘时不该谎报失败')

      const task = createScheduledTask('t', { type: 'interval', spec: '3600000' })
      scheduler.add(task)

      const health = scheduler.persistenceHealth()
      assert.equal(health.ok, false, '写盘失败必须被记录')
      assert.equal(health.path, bad.path, '路径要原样回显，用户才能去查权限')
      assert.ok(health.lastError && health.lastError.length > 0, '失败原文不得吞掉')
      assert.ok(typeof health.lastAttemptAt === 'number')
      assert.equal(health.lastOkAt, undefined, '从未成功过 → 没有 lastOkAt')

      // 内存表照常生效（这是语义边界，不是 bug）
      assert.equal(scheduler.get(task.id)?.prompt, 't')
      assert.equal(scheduler.list().length, 1)
    } finally {
      bad.cleanup()
      good.cleanup()
    }
  })

  test('可写路径下 ok=true 且带 lastOkAt（正常路径不得被误报）', () => {
    const { path, cleanup } = writableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      scheduler.add(createScheduledTask('t', { type: 'interval', spec: '3600000' }))
      const health = scheduler.persistenceHealth()
      assert.equal(health.ok, true)
      assert.ok(typeof health.lastOkAt === 'number')
      assert.equal(health.lastError, undefined)
    } finally { cleanup() }
  })

  test('PATCH 回执带 persisted:false + 失败原文，且定义仍按内存态生效', async () => {
    const { path, cleanup } = unwritableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('original', { type: 'interval', spec: '3600000' })
      scheduler.add(task)
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

      const res = await router('PATCH', `/schedule/${task.id}`, { prompt: 'edited' }, AUTH)
      assert.equal(res.status, 200, '内存改成功仍是 200——这不是"保存失败"，是"没落盘"')
      const body = res.body as { prompt: string; persisted: boolean; persistError?: string; schedulePath?: string }
      assert.equal(body.prompt, 'edited')
      assert.equal(body.persisted, false)
      assert.ok(body.persistError, '失败原文随回执返回')
      assert.equal(body.schedulePath, path)
      assert.equal(scheduler.get(task.id)?.prompt, 'edited', '内存态已更新，本轮调度照常')
    } finally { cleanup() }
  })

  test('PATCH 正常路径回执 persisted:true 且不带 persistError', async () => {
    const { path, cleanup } = writableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('original', { type: 'interval', spec: '3600000' })
      scheduler.add(task)
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

      const res = await router('PATCH', `/schedule/${task.id}`, { prompt: 'edited' }, AUTH)
      const body = res.body as { persisted: boolean; persistError?: string }
      assert.equal(res.status, 200)
      assert.equal(body.persisted, true)
      assert.ok(!('persistError' in body), '成功时不带噪音字段')
    } finally { cleanup() }
  })

  test('GET /schedule/status 顶层带 persistence —— 轮询也能发现上次没落盘', async () => {
    const { path, cleanup } = unwritableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      scheduler.add(createScheduledTask('t', { type: 'interval', spec: '3600000' }))
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

      const res = await router('GET', '/schedule/status', {}, AUTH)
      assert.equal(res.status, 200)
      const body = res.body as { persistence?: { ok: boolean; path: string; lastError?: string } }
      assert.ok(body.persistence, 'persistence 必须常驻（与 status 是否接线无关）')
      assert.equal(body.persistence.ok, false)
      assert.equal(body.persistence.path, path)
      assert.ok(body.persistence.lastError)
    } finally { cleanup() }
  })

  test('POST（create）回执带 persisted:false + 失败原文——与 PATCH 同口径', async () => {
    const { path, cleanup } = unwritableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

      const res = await router('POST', '/schedule', { prompt: 'probe', trigger: { type: 'interval', spec: '3600000' } }, AUTH)
      assert.equal(res.status, 201, '内存建成功仍是 201——这不是"保存失败"，是"没落盘"')
      const body = res.body as { id: string; persisted: boolean; persistError?: string; schedulePath?: string }
      assert.equal(body.persisted, false)
      assert.ok(body.persistError, '失败原文随回执返回')
      assert.equal(body.schedulePath, path)
      assert.ok(scheduler.get(body.id), '内存态已建，本轮调度照常')
    } finally { cleanup() }
  })

  test('DELETE（remove）回执带 persisted:false——与 PATCH 同口径', async () => {
    const { path, cleanup } = unwritableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('t', { type: 'interval', spec: '3600000' })
      scheduler.add(task)
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

      const res = await router('DELETE', `/schedule/${task.id}`, {}, AUTH)
      assert.equal(res.status, 200)
      const body = res.body as { removed: boolean; persisted: boolean; persistError?: string }
      assert.equal(body.removed, true)
      assert.equal(body.persisted, false)
      assert.ok(body.persistError)
      assert.equal(scheduler.get(task.id), undefined, '内存态已移除')
    } finally { cleanup() }
  })

  test('pause / stop / run-now 回执同口径带 persisted:false', async () => {
    const { path, cleanup } = unwritableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('t', { type: 'interval', spec: '3600000' })
      scheduler.add(task)
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

      // 顺序约束：run-now 只对 active 任务有效——放最前（stop 之后会按设计 404）。
      const ran = await router('POST', `/schedule/${task.id}/run-now`, {}, AUTH)
      assert.equal(ran.status, 200)
      assert.equal((ran.body as { persisted: boolean }).persisted, false)

      const paused = await router('POST', `/schedule/${task.id}/pause`, { enabled: false }, AUTH)
      assert.equal(paused.status, 200)
      assert.equal((paused.body as { persisted: boolean }).persisted, false)

      const stopped = await router('POST', `/schedule/${task.id}/stop`, {}, AUTH)
      assert.equal(stopped.status, 200)
      assert.equal((stopped.body as { persisted: boolean }).persisted, false)
    } finally { cleanup() }
  })

  test('可写路径下 create / delete 回执 persisted:true 且不带 persistError（不误报）', async () => {
    const { path, cleanup } = writableSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))
      const created = await router('POST', '/schedule', { prompt: 'ok', trigger: { type: 'interval', spec: '3600000' } }, AUTH)
      assert.equal(created.status, 201)
      const cbody = created.body as { id: string; persisted: boolean; persistError?: string }
      assert.equal(cbody.persisted, true)
      assert.ok(!('persistError' in cbody), '成功时不带噪音字段')

      const removed = await router('DELETE', `/schedule/${cbody.id}`, {}, AUTH)
      assert.equal(removed.status, 200)
      const rbody = removed.body as { persisted: boolean; persistError?: string }
      assert.equal(rbody.persisted, true)
      assert.ok(!('persistError' in rbody))
    } finally { cleanup() }
  })
})
