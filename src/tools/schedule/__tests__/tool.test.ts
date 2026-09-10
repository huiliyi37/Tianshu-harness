import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronScheduler, setActiveScheduler } from '../../../server/cron-scheduler.js'
import { SCHEDULE_CREATE_TOOL, SCHEDULE_LIST_TOOL, SCHEDULE_DELETE_TOOL } from '../tool.js'

// schedule 工具测试：真实 CronScheduler 实例（schedulePath 指向 /tmp 临时
// 文件，不污染仓库），setActiveScheduler 注入/清理。覆盖三个工具的
// 降级路径、创建校验、列表格式与删除行为。

let dir: string
let scheduler: CronScheduler

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schedule-tool-'))
  scheduler = new CronScheduler({ schedulePath: join(dir, 'tasks.json'), tickIntervalMs: 60_000 })
  setActiveScheduler(scheduler)
})

afterEach(() => {
  setActiveScheduler(undefined)
  rmSync(dir, { recursive: true, force: true })
})

const INTERVAL_TASK = {
  id: 't1',
  prompt: 'morning check',
  allowedTools: [] as string[],
  trigger: { type: 'interval' as const, spec: '3600000' },
  createdAt: new Date().toISOString(),
  triggerCount: 0,
}

type ToolInput = Record<string, unknown>
type Executable = { execute(p: { input: ToolInput; toolUseId: string; cwd: string }): Promise<{ content: string }> }
const run = (tool: Executable, input: ToolInput) =>
  tool.execute({ input, toolUseId: 'toolu_test', cwd: dir })

test('scheduler 未启动时三个工具均返回降级提示', async () => {
  setActiveScheduler(undefined)
  const r1 = await run(SCHEDULE_CREATE_TOOL, { prompt: 'x', trigger: { type: 'interval', spec: '1000' } })
  const r2 = await run(SCHEDULE_LIST_TOOL, {})
  const r3 = await run(SCHEDULE_DELETE_TOOL, { id: 'a' })
  for (const r of [r1, r2, r3]) {
    assert.ok(r.content.startsWith('调度器不可用'), r.content)
  }
})

test('schedule_create: 合法 interval trigger 创建任务并返回 id', async () => {
  const r = await run(SCHEDULE_CREATE_TOOL, { prompt: 'check deps', trigger: { type: 'interval', spec: '3600000' } })
  assert.ok(r.content.includes('定时任务已创建'), r.content)
  const id = /id: (sched-[a-z0-9]+)/.exec(r.content)?.[1]
  assert.ok(id, '返回消息携带任务 id')
  const tasks = scheduler.list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.id, id)
  assert.equal(tasks[0]!.prompt, 'check deps')
  assert.equal(tasks[0]!.trigger.type, 'interval')
  assert.equal(tasks[0]!.trigger.spec, '3600000')
})

test('schedule_create: 合法 cron trigger 创建任务', async () => {
  const r = await run(SCHEDULE_CREATE_TOOL, { prompt: 'daily digest', trigger: { type: 'cron', spec: '30 9 * * *' } })
  assert.ok(r.content.includes('定时任务已创建'), r.content)
  assert.equal(scheduler.list()[0]!.trigger.spec, '30 9 * * *')
})

test('schedule_create: 非法 cron 表达式返回「触发器不合法」且不创建', async () => {
  const r = await run(SCHEDULE_CREATE_TOOL, { prompt: 'x', trigger: { type: 'cron', spec: 'not-a-cron' } })
  assert.ok(r.content.startsWith('触发器不合法：'), r.content)
  assert.equal(scheduler.list().length, 0, '校验失败不落任务')
})

test('schedule_create: 缺 prompt 返回「输入不合法」', async () => {
  const r = await run(SCHEDULE_CREATE_TOOL, { trigger: { type: 'interval', spec: '1000' } })
  assert.ok(r.content.startsWith('输入不合法：'), r.content)
  assert.equal(scheduler.list().length, 0)
})

test('schedule_list: 空表返回提示', async () => {
  const r = await run(SCHEDULE_LIST_TOOL, {})
  assert.equal(r.content, '当前没有定时任务。用 schedule_create 新建一个。')
})

test('schedule_list: 列出任务摘要（id/trigger/fires 计数）', async () => {
  scheduler.add({ ...INTERVAL_TASK, triggerCount: 3 })
  scheduler.add({
    ...INTERVAL_TASK,
    id: 't2',
    prompt: 'startup hook',
    trigger: { type: 'startup', spec: '' },
  })
  const r = await run(SCHEDULE_LIST_TOOL, {})
  assert.ok(r.content.includes('共 2 个定时任务'), r.content)
  assert.ok(r.content.includes('- t1 · interval "3600000" · fires=3'), r.content)
  assert.ok(r.content.includes('- t2 · startup · fires=0'), r.content)
})

test('schedule_list: paused 任务显示标记；超长 prompt 截断', async () => {
  scheduler.add({ ...INTERVAL_TASK, enabled: false, prompt: 'long prompt '.repeat(20) })
  const r = await run(SCHEDULE_LIST_TOOL, {})
  assert.ok(r.content.includes('[paused]'), r.content)
  assert.ok(r.content.includes('…'), '超长 prompt 截断为省略号')
  assert.ok(r.content.length < 200, '截断后的列表行不超长')
})

test('schedule_delete: 缺 id 返回提示', async () => {
  const r = await run(SCHEDULE_DELETE_TOOL, {})
  assert.equal(r.content, '缺少 "id" 参数。')
})

test('schedule_delete: 删除存在的任务', async () => {
  scheduler.add(INTERVAL_TASK)
  const r = await run(SCHEDULE_DELETE_TOOL, { id: 't1' })
  assert.equal(r.content, '已删除定时任务 t1。')
  assert.equal(scheduler.list().length, 0)
})

test('schedule_delete: 任务不存在返回提示', async () => {
  const r = await run(SCHEDULE_DELETE_TOOL, { id: 'ghost' })
  assert.equal(r.content, '未找到定时任务 ghost。')
})

test('工具定义使用 input_schema 命名（7f22186b0 修复守卫）', () => {
  for (const tool of [SCHEDULE_CREATE_TOOL, SCHEDULE_LIST_TOOL, SCHEDULE_DELETE_TOOL]) {
    assert.ok(tool.definition.input_schema, `${tool.definition.name} 使用 input_schema`)
    assert.equal(
      (tool.definition as { inputSchema?: unknown }).inputSchema,
      undefined,
      `${tool.definition.name} 不使用旧 inputSchema 命名`,
    )
    assert.equal(tool.requiresApproval({} as never), false)
    assert.equal(tool.isConcurrencySafe(), true)
    assert.equal(tool.isEnabled(), true)
  }
})


test('create 把调用会话的 cwd 快照进任务（F2：任务在创建工作区执行）', async () => {
  await run(SCHEDULE_CREATE_TOOL, { prompt: 'morning check', trigger: { type: 'interval', spec: '3600000' } })
  const listed = await run(SCHEDULE_LIST_TOOL, {})
  const tasks = scheduler.list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.cwd, dir, '任务 cwd = 工具调用上下文的工作区')
  assert.ok(listed.content.length > 0)
})

