import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronScheduler, setActiveScheduler, setScheduleWriteGuard, setUnattendedAutomationGate } from '../../../server/cron-scheduler.js'
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

// 回归（2026-09-24）：Pro 门原先只长在 HTTP 路由（schedule-routes 的
// wantsUnattended），而 agent 的 schedule_create 直接调 CronScheduler.add，
// 非 Pro 环境下模型能自建无人值守任务。工具层补上同口径判定。
test('schedule_create: Pro 门关闭时拒绝无人值守创建，always-review 放行', async () => {
  setUnattendedAutomationGate(() => false)
  try {
    const denied = await run(SCHEDULE_CREATE_TOOL, {
      prompt: 'x', trigger: { type: 'interval', spec: '3600000' }, reviewPolicy: 'auto-proceed',
    })
    assert.match(denied.content, /pro_required/, denied.content)
    assert.equal(scheduler.list().length, 0, '被拒时不得落任务')

    // 含 computer_use 白名单同样归「无人值守自动化」
    const denied2 = await run(SCHEDULE_CREATE_TOOL, {
      prompt: 'x', trigger: { type: 'interval', spec: '3600000' }, allowedTools: ['computer_use'],
    })
    assert.match(denied2.content, /pro_required/, denied2.content)
    assert.equal(scheduler.list().length, 0)

    // always-review + 不含 computer_use：不属于无人值守，放行
    const ok = await run(SCHEDULE_CREATE_TOOL, {
      prompt: 'x', trigger: { type: 'interval', spec: '3600000' }, reviewPolicy: 'always-review',
    })
    assert.ok(ok.content.includes('定时任务已创建'), ok.content)
    assert.equal(scheduler.list().length, 1)
  } finally {
    setUnattendedAutomationGate(undefined)
  }
})

test('schedule_create: 门未注入（CLI/测试缺省）时不拦截', async () => {
  const r = await run(SCHEDULE_CREATE_TOOL, {
    prompt: 'x', trigger: { type: 'interval', spec: '3600000' }, reviewPolicy: 'auto-proceed',
  })
  assert.ok(r.content.includes('定时任务已创建'), r.content)
})

// 回归（issue #290）：多 sidecar 共用同一数据目录时，非锁主进程内存调度表
// 恒空，scheduler.add/remove 会以空表为基底整表覆写 scheduled_tasks.json。
// 路由侧经 options.isWriteAllowed 拦（见 schedule-write-guard.test.ts），工具
// 侧不经 HTTP 路由，必须经同一运行时门（setScheduleWriteGuard）自己拦。
describe('schedule_* 工具锁主守卫（issue #290）', () => {
  test('非锁主：create/delete 被拒且不落盘、不动既有盘表', async () => {
    const schedulePath = join(dir, 'tasks.json')
    // 既有盘表（锁主进程建的任务）——非锁主从没载入过它
    scheduler.add({ ...INTERVAL_TASK })
    const diskBefore = readFileSync(schedulePath, 'utf-8')

    setScheduleWriteGuard(() => false)
    try {
      const deniedCreate = await run(SCHEDULE_CREATE_TOOL, {
        prompt: 'x', trigger: { type: 'interval', spec: '3600000' },
      })
      assert.match((deniedCreate as { content: string; isError?: boolean }).content, /未持有调度锁/)
      assert.equal((deniedCreate as { isError?: boolean }).isError, true, '必须是错误回执')
      assert.equal(scheduler.list().length, 1, '被拒不新增内存任务')
      assert.equal(readFileSync(schedulePath, 'utf-8'), diskBefore, '盘表不得被整表覆写')

      const deniedDelete = await run(SCHEDULE_DELETE_TOOL, { id: INTERVAL_TASK.id })
      assert.match((deniedDelete as { content: string; isError?: boolean }).content, /未持有调度锁/)
      assert.equal(readFileSync(schedulePath, 'utf-8'), diskBefore, '删除同样不得动盘')

      // 读工具不受限
      const listed = await run(SCHEDULE_LIST_TOOL, {})
      assert.ok(listed.content.includes('共 1 个定时任务'), listed.content)
    } finally {
      setScheduleWriteGuard(undefined)
    }
  })

  test('锁主（isOwner=true）与缺省（未注入门）都放行 create', async () => {
    setScheduleWriteGuard(() => true)
    try {
      const r = await run(SCHEDULE_CREATE_TOOL, { prompt: 'x', trigger: { type: 'interval', spec: '3600000' } })
      assert.ok(r.content.includes('定时任务已创建'), r.content)
    } finally {
      setScheduleWriteGuard(undefined)
    }
    const r2 = await run(SCHEDULE_CREATE_TOOL, { prompt: 'y', trigger: { type: 'interval', spec: '3600000' } })
    assert.ok(r2.content.includes('定时任务已创建'), r2.content)
  })
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

