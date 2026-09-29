/**
 * 自动化信任工作流（试跑驱动信任）
 *
 * 覆盖：
 * - CronScheduler.runNow：恒有人值守、计入 triggerCount、暂停/缺失拒绝
 * - POST /schedule/:id/run-now 路由
 * - halt 结构化：unattended 中止的缺授权 app 名沿
 *   session-manager → runAndWait → SessionRuntimePool → TaskRegistry
 *   一路结构化落入 TaskRecord.haltedApp
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import {
  CronScheduler,
  createScheduledTask,
  FIRST_RUNS_TRUST_THRESHOLD,
  resolveRunUnattended,
  type TaskDueMeta,
} from '../cron-scheduler.js'
import { buildScheduleRoutes } from '../schedule-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { SessionRuntimePool } from '../session-runtime-pool.js'
import { TaskRegistry, type RuntimeHandle, type RuntimePool } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ─── CronScheduler.runNow ────────────────────────────────────

test('runNow：恒有人值守（无视 auto-proceed）且带 manual 标记', async () => {
  const dir = tmp('rivet-runnow-')
  try {
    const scheduler = new CronScheduler({ schedulePath: join(dir, 's.json') })
    const metas: TaskDueMeta[] = []
    scheduler.subscribeTaskDue(async (_p, _t, _a, meta) => { if (meta) metas.push(meta) })

    const task = createScheduledTask('p', { type: 'interval', spec: '3600000' }, [], { reviewPolicy: 'auto-proceed' })
    scheduler.add(task)

    assert.equal(scheduler.runNow(task.id), true)
    await new Promise((r) => setTimeout(r, 10))

    assert.equal(metas.length, 1)
    assert.equal(metas[0]!.unattended, false, 'trial run must be attended')
    assert.equal(metas[0]!.manual, true)
    assert.equal(metas[0]!.scheduledTaskId, task.id)
    assert.equal(scheduler.get(task.id)!.triggerCount, 1)
    assert.ok(scheduler.get(task.id)!.lastTriggeredAt)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runNow：缺失/暂停的任务返回 false 且不触发', async () => {
  const dir = tmp('rivet-runnow-')
  try {
    const scheduler = new CronScheduler({ schedulePath: join(dir, 's.json') })
    let fired = 0
    scheduler.subscribeTaskDue(async () => { fired++ })

    assert.equal(scheduler.runNow('cron_missing'), false)

    const task = createScheduledTask('p', { type: 'interval', spec: '3600000' })
    scheduler.add(task)
    scheduler.setEnabled(task.id, false)
    assert.equal(scheduler.runNow(task.id), false)

    await new Promise((r) => setTimeout(r, 10))
    assert.equal(fired, 0)
    assert.equal(scheduler.get(task.id)!.triggerCount, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runNow 与 first-runs 晋级衔接：试跑 N 次后自动放行', async () => {
  const dir = tmp('rivet-runnow-')
  try {
    const scheduler = new CronScheduler({ schedulePath: join(dir, 's.json') })
    scheduler.subscribeTaskDue(async () => {})
    const task = createScheduledTask('p', { type: 'interval', spec: '3600000' }, [], { reviewPolicy: 'first-runs' })
    scheduler.add(task)

    for (let i = 0; i < FIRST_RUNS_TRUST_THRESHOLD; i++) {
      assert.equal(scheduler.runNow(task.id), true)
    }
    await new Promise((r) => setTimeout(r, 10))

    const after = scheduler.get(task.id)!
    assert.equal(after.triggerCount, FIRST_RUNS_TRUST_THRESHOLD)
    // 下一次到点触发（触发前计数 = 阈值）将无人值守。
    assert.equal(resolveRunUnattended(after), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─── POST /schedule/:id/run-now 路由 ─────────────────────────

test('POST /schedule/:id/run-now：触发一次并 404 未知/暂停任务', async () => {
  const dir = tmp('rivet-runnow-route-')
  try {
    const scheduler = new CronScheduler({ schedulePath: join(dir, 's.json') })
    const metas: TaskDueMeta[] = []
    scheduler.subscribeTaskDue(async (_p, _t, _a, meta) => { if (meta) metas.push(meta) })
    const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

    const created = await router('POST', '/schedule', {
      prompt: 'daily digest', trigger: { type: 'interval', spec: '3600000' },
    }, AUTH)
    const id = (created.body as { id: string }).id

    const ok = await router('POST', `/schedule/${id}/run-now`, {}, AUTH)
    assert.equal(ok.status, 200)
    // persisted：issue #266/D5 口径——写盘结果随回执返回（可写路径 → true）。
    assert.deepEqual(ok.body, { id, triggered: true, persisted: true })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(metas.length, 1)
    assert.equal(metas[0]!.unattended, false)

    assert.equal((await router('POST', '/schedule/cron_nope/run-now', {}, AUTH)).status, 404)

    await router('POST', `/schedule/${id}/pause`, { enabled: false }, AUTH)
    assert.equal((await router('POST', `/schedule/${id}/run-now`, {}, AUTH)).status, 404)

    // fail-closed：无鉴权 401。
    assert.equal((await router('POST', `/schedule/${id}/run-now`, {}, {})).status, 401)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─── halt 结构化：session → pool → registry → TaskRecord ─────

/** 请求一次 computer_use 审批（unattended 下被拒并触发中止），然后等 abort。 */
class HaltingAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  private release: () => void = () => {}
  async run(_p: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    const result = await cb.onApprovalRequired('t1', 'computer_use', { action: 'click', app: 'Safari' })
    assert.equal(typeof result === 'boolean' ? result : result.approved, false)
    await new Promise<void>((res) => { this.release = res })
  }
  abort(): void { this.callbacks?.onAbort(); this.release() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_m: OaiMessage[]): void {}
  rewindToMessages(_m: OaiMessage[]): void {}
}

test('runAndWait：unattended 中止透出结构化 haltedApp', async () => {
  const manager = new RuntimeSessionManager({ createAgent: () => new HaltingAgent(), defaultCwd: '/work' })
  const s = manager.createSession({ unattended: true })
  const result = await manager.runAndWait(s.id, 'go click things')
  assert.equal(result.status, 'aborted')
  assert.equal(result.haltedApp, 'Safari')
  assert.match(result.summary, /unattended halt/)
})

test('TaskRegistry：haltedApp 结构化落入 TaskRecord', async () => {
  const dir = tmp('rivet-halt-')
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new HaltingAgent(), defaultCwd: '/work' })
    const pool = new SessionRuntimePool({ manager, defaultCwd: '/work' })
    const registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(dir, 'tasks')), runtimePool: pool })

    const record = await registry.createTask({
      prompt: 'click things', source: 'cron', unattended: true, scheduledTaskId: 'cron_x1',
    })
    // scheduleExecution 异步跑完（agent 被拒 → 中止 → failed）。
    for (let i = 0; i < 100; i++) {
      const cur = await registry.getTask(record.id)
      if (cur && cur.status !== 'pending' && cur.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }

    const final = await registry.getTask(record.id)
    assert.ok(final)
    assert.equal(final.status, 'failed')
    assert.equal(final.haltedApp, 'Safari')
    assert.match(final.error ?? '', /unattended/)
    registry.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RuntimePool 抛错不带 haltedApp 时 TaskRecord 不写字段（回归）', async () => {
  const dir = tmp('rivet-halt-')
  try {
    const failingPool: RuntimePool = {
      size: 0,
      acquire: () => Promise.resolve<RuntimeHandle>({
        execute: () => Promise.reject(new Error('ordinary failure')),
        release: () => {},
      }),
    }
    const registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(dir, 'tasks')), runtimePool: failingPool })
    const record = await registry.createTask({ prompt: 'x', source: 'cron' })
    for (let i = 0; i < 100; i++) {
      const cur = await registry.getTask(record.id)
      if (cur && cur.status !== 'pending' && cur.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const final = await registry.getTask(record.id)
    assert.equal(final!.status, 'failed')
    assert.equal('haltedApp' in final!, false)
    registry.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
