/**
 * issue #236 — 自动化任务的**原地更新**与**「停止」终态**。
 *
 * 覆盖三层：
 * 1. 状态机 active/paused/stopped 与旧数据兼容（磁盘上只有 enabled 布尔的形态）
 * 2. 原地更新 update()：字段覆盖 / 可选项显式清除 / 不变式（id、运行历史、状态）
 * 3. HTTP 面：PATCH /schedule/:id、POST /schedule/:id/stop、?status= 过滤、Pro 门禁
 *
 * 动机：缺少更新通道时，任何 prompt / trigger / 策略调整都只能「删除旧任务 + 新建」，
 * 旧定义被物理移除后其运行历史入口一并失联（见 issue #237）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import {
  CronScheduler,
  createScheduledTask,
  resolveTaskStatus,
  type ScheduleTable,
  type ScheduledTask,
} from '../cron-scheduler.js'
import { buildScheduleRoutes } from '../schedule-routes.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tmpSchedule(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-sched-lifecycle-'))
  return { path: join(dir, 'sched.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function readTable(path: string): ScheduleTable {
  return JSON.parse(readFileSync(path, 'utf-8')) as ScheduleTable
}

function onDisk(path: string, id: string): ScheduledTask {
  const found = readTable(path).find(t => t.id === id)
  assert.ok(found, `task ${id} missing from ${path}`)
  return found
}

// ── 状态机与旧数据兼容 ────────────────────────────────────────

describe('状态机与旧数据兼容（issue #236）', () => {
  test('只有 enabled=false 的旧持久化数据派生成 paused，且不触发', async () => {
    const { path, cleanup } = tmpSchedule()
    try {
      // 旧版本落盘形态：无 status 字段，只有 enabled 布尔。
      const legacy: ScheduledTask[] = [{
        id: 'cron_legacy1',
        prompt: 'legacy paused task',
        allowedTools: [],
        trigger: { type: 'interval', spec: '10' },
        createdAt: new Date(Date.now() - 1000).toISOString(),
        triggerCount: 0,
        enabled: false,
      }]
      writeFileSync(path, JSON.stringify(legacy), 'utf-8')

      const scheduler = new CronScheduler({ schedulePath: path, tickIntervalMs: 10 })
      const fired: string[] = []
      scheduler.subscribeTaskDue(async (prompt) => { fired.push(prompt) })
      scheduler.start()
      await sleep(80)
      scheduler.stop()

      assert.deepEqual(fired, [], '旧 paused 任务不得因缺 status 被当作 active 触发')
      assert.equal(resolveTaskStatus(scheduler.get('cron_legacy1')!), 'paused')
    } finally { cleanup() }
  })

  test('pause / resume 同步写 status 与 enabled 兼容镜像', () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('t', { type: 'interval', spec: '3600000' })
      scheduler.add(task)

      scheduler.setEnabled(task.id, false)
      assert.equal(onDisk(path, task.id).status, 'paused')
      assert.equal(onDisk(path, task.id).enabled, false, '旧 runtime 读 enabled 也必须不触发')

      scheduler.setEnabled(task.id, true)
      assert.equal(onDisk(path, task.id).status, 'active')
      assert.equal(onDisk(path, task.id).enabled, true)
    } finally { cleanup() }
  })

  test('stop 保留定义但三条触发路径全拦（tick / 事件 / 试跑）', async () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path, tickIntervalMs: 10 })
      const task = createScheduledTask('nightly', { type: 'interval', spec: '10' })
      scheduler.add(task)
      assert.equal(scheduler.setStatus(task.id, 'stopped'), true)

      const stopped = scheduler.get(task.id)!
      assert.equal(stopped.status, 'stopped')
      assert.equal(stopped.enabled, false)
      // 与 DELETE 的本质区别：定义仍在
      assert.equal(scheduler.list().length, 1, '停止不得物理移除定义')

      const fired: string[] = []
      scheduler.subscribeTaskDue(async (p) => { fired.push(p) })
      scheduler.start()
      await sleep(80)
      scheduler.stop()
      assert.deepEqual(fired, [], '停止态不得被 tick 触发')
      assert.equal(scheduler.runNow(task.id), false, '停止态不得试跑')

      const evt = createScheduledTask('on startup', { type: 'startup', spec: '' })
      scheduler.add(evt)
      scheduler.setStatus(evt.id, 'stopped')
      assert.equal(scheduler.fireByEvent('startup'), 0, '停止态不得被事件触发')
    } finally { cleanup() }
  })

  test('stopped → active 可重新启用（状态迁移 4）', () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('t', { type: 'interval', spec: '3600000' })
      scheduler.add(task)
      scheduler.setStatus(task.id, 'stopped')
      assert.equal(scheduler.setEnabled(task.id, true), true)
      const revived = scheduler.get(task.id)!
      assert.equal(revived.status, 'active')
      assert.equal(revived.enabled, true)
    } finally { cleanup() }
  })
})

// ── 原地更新 ─────────────────────────────────────────────────

describe('原地更新 update()（issue #236）', () => {
  test('覆盖 prompt / trigger / allowedTools / reviewPolicy 并落盘，不动身份与历史', () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('old prompt', { type: 'interval', spec: '1000' }, ['read_file'])
      scheduler.add(task)
      // 制造运行历史：试跑计数不应被更新重置
      scheduler.setEnabled(task.id, false)
      scheduler.setEnabled(task.id, true)

      const before = scheduler.get(task.id)!
      const updated = scheduler.update(task.id, {
        prompt: 'new prompt',
        trigger: { type: 'cron', spec: '30 2 * * *' },
        allowedTools: ['read_file', 'grep'],
        reviewPolicy: 'first-runs',
      })
      assert.ok(updated)
      assert.equal(updated!.prompt, 'new prompt')
      assert.deepEqual(updated!.trigger, { type: 'cron', spec: '30 2 * * *' })
      assert.deepEqual(updated!.allowedTools, ['read_file', 'grep'])
      assert.equal(updated!.reviewPolicy, 'first-runs')
      // 不变式
      assert.equal(updated!.id, before.id)
      assert.equal(updated!.createdAt, before.createdAt)
      assert.equal(updated!.triggerCount, before.triggerCount)
      assert.equal(updated!.status, before.status, '更新定义不得改变生命周期状态')

      // 落盘且能被新实例读回（重启后仍生效）
      const persisted = onDisk(path, task.id)
      assert.equal(persisted.prompt, 'new prompt')
      assert.deepEqual(persisted.trigger, { type: 'cron', spec: '30 2 * * *' })
      const reloaded = new CronScheduler({ schedulePath: path })
      reloaded.start()
      reloaded.stop()
      assert.equal(reloaded.get(task.id)!.prompt, 'new prompt')
    } finally { cleanup() }
  })

  test('显式 null 清除可选项，缺席字段不动', () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('t', { type: 'interval', spec: '1000' }, [], {
        retry: { maxAttempts: 3, backoffMs: 1000 },
        reviewPolicy: 'auto-proceed',
      })
      scheduler.add(task)

      // 只动 retry：reviewPolicy 必须原样保留
      const onlyRetry = scheduler.update(task.id, { retry: null })!
      assert.equal(onlyRetry.retry, undefined)
      assert.equal(onlyRetry.reviewPolicy, 'auto-proceed', '缺席字段不得被清掉')

      const cleared = scheduler.update(task.id, { reviewPolicy: null })!
      assert.equal(cleared.reviewPolicy, undefined)
    } finally { cleanup() }
  })

  test('非法 trigger 抛错、未知 id 返回 null', () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const task = createScheduledTask('t', { type: 'interval', spec: '1000' })
      scheduler.add(task)
      assert.throws(
        () => scheduler.update(task.id, { trigger: { type: 'cron', spec: 'not a cron' } }),
        /Invalid cron expression/,
      )
      // 抛错不得留下半更新状态
      assert.deepEqual(scheduler.get(task.id)!.trigger, { type: 'interval', spec: '1000' })
      assert.equal(scheduler.update('cron_missing', { prompt: 'x' }), null)
    } finally { cleanup() }
  })
})

// ── HTTP 面 ──────────────────────────────────────────────────

describe('PATCH /schedule/:id 与 stop 路由（issue #236）', () => {
  test('PATCH 原地更新；空补丁 / 非法值 400；未知 id 404', async () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))
      const created = await router('POST', '/schedule', {
        prompt: 'old', trigger: { type: 'interval', spec: '3600000' },
      }, AUTH)
      const id = (created.body as { id: string }).id

      const patched = await router('PATCH', `/schedule/${id}`, {
        prompt: 'new', allowedTools: ['read_file'],
      }, AUTH)
      assert.equal(patched.status, 200)
      assert.equal((patched.body as ScheduledTask).prompt, 'new')
      assert.equal(scheduler.get(id)!.prompt, 'new')

      assert.equal((await router('PATCH', `/schedule/${id}`, {}, AUTH)).status, 400)
      assert.equal((await router('PATCH', `/schedule/${id}`, { prompt: '   ' }, AUTH)).status, 400)
      assert.equal((await router('PATCH', `/schedule/${id}`, { trigger: { type: 'cron', spec: 'bogus' } }, AUTH)).status, 400)
      assert.equal((await router('PATCH', `/schedule/${id}`, { reviewPolicy: 'nope' }, AUTH)).status, 400)
      assert.equal((await router('PATCH', `/schedule/${id}`, { allowedTools: 'read_file' }, AUTH)).status, 400)
      assert.equal((await router('PATCH', '/schedule/cron_missing', { prompt: 'x' }, AUTH)).status, 404)
      // 非法输入不得改动任务
      assert.equal(scheduler.get(id)!.prompt, 'new')
    } finally { cleanup() }
  })

  test('stop 归档：定义保留，?status= 可过滤，pause{enabled:true} 可复活', async () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))
      const a = (await router('POST', '/schedule', { prompt: 'a', trigger: { type: 'interval', spec: '3600000' } }, AUTH)).body as ScheduledTask
      const b = (await router('POST', '/schedule', { prompt: 'b', trigger: { type: 'interval', spec: '3600000' } }, AUTH)).body as ScheduledTask

      const stopped = await router('POST', `/schedule/${a.id}/stop`, {}, AUTH)
      assert.equal(stopped.status, 200)
      assert.equal(scheduler.get(a.id)!.status, 'stopped')
      assert.equal(scheduler.list().length, 2, '定义必须保留')

      const filtered = await router('GET', '/schedule?status=stopped', {}, AUTH)
      const tasks = (filtered.body as { tasks: ScheduledTask[] }).tasks
      assert.deepEqual(tasks.map(t => t.id), [a.id])

      const activeOnly = await router('GET', '/schedule?status=active', {}, AUTH)
      assert.deepEqual((activeOnly.body as { tasks: ScheduledTask[] }).tasks.map(t => t.id), [b.id])

      // 拼错的过滤值忽略（返回全量）而不是筛成空
      const bogus = await router('GET', '/schedule?status=bogus', {}, AUTH)
      assert.equal((bogus.body as { tasks: ScheduledTask[] }).tasks.length, 2)

      const revived = await router('POST', `/schedule/${a.id}/pause`, { enabled: true }, AUTH)
      assert.equal(revived.status, 200)
      assert.equal(scheduler.get(a.id)!.status, 'active')

      assert.equal((await router('POST', '/schedule/cron_missing/stop', {}, AUTH)).status, 404)
    } finally { cleanup() }
  })

  test('PATCH 不得成为绕过无人值守 Pro 门禁的通道', async () => {
    const { path, cleanup } = tmpSchedule()
    try {
      const scheduler = new CronScheduler({ schedulePath: path })
      const router = createRouter(buildScheduleRoutes(scheduler, TOKEN, {
        isUnattendedAutomationEnabled: () => false,
      }))
      const task = (await router('POST', '/schedule', {
        prompt: 'a', trigger: { type: 'interval', spec: '3600000' },
      }, AUTH)).body as ScheduledTask

      const gated = await router('PATCH', `/schedule/${task.id}`, { reviewPolicy: 'auto-proceed' }, AUTH)
      assert.equal(gated.status, 403)
      assert.equal(scheduler.get(task.id)!.reviewPolicy, undefined, '被门禁拦下不得留下改动')

      const gatedTools = await router('PATCH', `/schedule/${task.id}`, { allowedTools: ['computer_use'] }, AUTH)
      assert.equal(gatedTools.status, 403)

      // 非无人值守的更新照常放行
      assert.equal((await router('PATCH', `/schedule/${task.id}`, { prompt: 'b' }, AUTH)).status, 200)
    } finally { cleanup() }
  })
})
