/**
 * Agent 自助调度工具——让 agent 在对话中创建/列出/删除定时任务。
 *
 * 调用 sidecar 的 active CronScheduler 实例（serve.ts 启动时经
 * setActiveScheduler 登记）。非 serve 环境（CLI 无调度器）返回降级提示。
 *
 * 用途：agent 可根据对话上下文主动安排自动化——「每天早上检查依赖更新」
 * 「每次打开应用时拉取最新」等，无需用户手动去自动化面板配置。
 *
 * reviewPolicy 非 always-review 的创建走 Pro 门控（由 CronScheduler/
 * schedule-routes 的现有校验保证，工具层不重复判断）。
 *
 * 注册是**条件性**的：`isSchedulerAvailable()` 为假时 default-registry 不注册
 * 这三个工具。CLI 交互模式永远没有调度器，注册了只会让模型看见一个必然失败
 * 的工具，还白付三段描述的提示词——「能调用但一定失败」比没有这个工具更糟。
 * 下面的 noScheduler 降级仍保留：调度器可被 setActiveScheduler(undefined) 中途
 * 摘掉，届时已装配的工具要有话可说。
 */
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Tool } from '../types.js'
import { getActiveScheduler, validateTriggerOrThrow, type CronTriggerType } from '../../server/cron-scheduler.js'

const triggerSchema = z.object({
  type: z.enum(['interval', 'cron', 'oneshot', 'startup', 'app-open']),
  /** interval=毫秒正整数；cron=5 字段 UTC；oneshot=ISO 时间戳；startup/app-open 可空。 */
  spec: z.string(),
})

const createSchema = z.object({
  prompt: z.string().min(1).describe('任务触发时要 agent 做什么。'),
  trigger: triggerSchema.describe('何时触发：interval/cron/oneshot/startup/app-open。'),
  allowedTools: z.array(z.string()).optional().describe('工具白名单（留空或省略 = 全部工具）。'),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffMs: z.number().int().min(0),
  }).optional().describe('失败自动重试（maxAttempts ≥ 2 才生效）。'),
  reviewPolicy: z.enum(['always-review', 'first-runs', 'auto-proceed']).optional(),
})

/** 当前运行时是否真能执行定时任务。default-registry 用它决定是否注册这三个工具。 */
export function isSchedulerAvailable(): boolean {
  return getActiveScheduler() !== undefined
}

const noScheduler = (): { content: string } => ({
  content: '调度器不可用——定时任务需要 `rivet serve`（桌面端/无头模式）。CLI 交互模式没有 cron 调度器。',
})

/** schedule_create — 在对话中创建一个定时任务。 */
export const SCHEDULE_CREATE_TOOL: Tool = {
  definition: {
    name: 'schedule_create',
    description: '创建定时自动化任务（cron/interval/oneshot/startup/app-open）。任务持久化保存、跨重启存活，按触发器自动执行。用它把对话里已经谈定的周期性工作直接排进日程——「每天早上检查依赖更新」、「每次打开应用拉取最新代码」——不必让用户再去自动化面板手工配置。',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务触发时要 agent 做什么。' },
        trigger: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['interval', 'cron', 'oneshot', 'startup', 'app-open'] },
            spec: { type: 'string' },
          },
          required: ['type', 'spec'],
          description: 'interval=毫秒（如 3600000 表示每小时）；cron=5 字段 UTC 表达式（如 "30 9 * * *"）；oneshot=ISO 时间戳；startup=开机时触发（需已开启自启动）；app-open=应用启动时触发。startup/app-open 的 spec 可留空。',
        },
        allowedTools: { type: 'array', items: { type: 'string' } },
        retry: {
          type: 'object',
          properties: { maxAttempts: { type: 'number' }, backoffMs: { type: 'number' } },
        },
        reviewPolicy: { type: 'string', enum: ['always-review', 'first-runs', 'auto-proceed'] },
      },
      required: ['prompt', 'trigger'],
    },
  },
  async execute(params) {
    const { input, cwd: sessionCwd } = params
    const scheduler = getActiveScheduler()
    if (!scheduler) return noScheduler()
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) {
      return { content: `输入不合法：${parsed.error.message}` }
    }
    const { prompt, trigger, allowedTools, retry, reviewPolicy } = parsed.data
    try {
      validateTriggerOrThrow({ type: trigger.type as CronTriggerType, spec: trigger.spec })
    } catch (err) {
      return { content: `触发器不合法：${(err as Error).message}` }
    }
    const id = `sched-${randomUUID().slice(0, 8)}`
    scheduler.add({
      id,
      prompt,
      allowedTools: allowedTools ?? [],
      trigger: { type: trigger.type as CronTriggerType, spec: trigger.spec },
      ...(retry ? { retry } : {}),
      ...(reviewPolicy ? { reviewPolicy } : {}),
      createdAt: new Date().toISOString(),
      triggerCount: 0,
      // 快照创建时会话的工作区：任务到点在快照 cwd 里执行（桌面多项目下
      // sidecar 的 process.cwd() 不是任何一个会话的工作区）。
      ...(sessionCwd ? { cwd: sessionCwd } : { cwd: process.cwd() }),
    })
    return {
      content: `定时任务已创建（id: ${id}，触发器: ${trigger.type}${trigger.spec ? ` "${trigger.spec}"` : ''}）。它会按触发器自动执行并跨重启存活，可在「自动化」面板管理。`,
    }
  },
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

/** schedule_list — 列出所有定时任务。 */
export const SCHEDULE_LIST_TOOL: Tool = {
  definition: {
    name: 'schedule_list',
    description: '列出全部定时自动化任务（cron/interval/oneshot/startup/app-open）。逐条给出任务 id、触发器、prompt 摘要、启用状态与已触发次数。',
    input_schema: { type: 'object', properties: {} },
  },
  async execute() {
    const scheduler = getActiveScheduler()
    if (!scheduler) return noScheduler()
    const tasks = scheduler.list()
    if (tasks.length === 0) {
      return { content: '当前没有定时任务。用 schedule_create 新建一个。' }
    }
    const lines = tasks.map(t => {
      const enabled = t.enabled === false ? ' [paused]' : ''
      const summary = t.prompt.length > 60 ? `${t.prompt.slice(0, 57)}…` : t.prompt
      return `- ${t.id} · ${t.trigger.type}${t.trigger.spec ? ` "${t.trigger.spec}"` : ''} · fires=${t.triggerCount}${enabled}\n  ${summary}`
    })
    return {
      content: `共 ${tasks.length} 个定时任务：\n${lines.join('\n')}`,
    }
  },
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

/** schedule_delete — 删除一个定时任务。 */
export const SCHEDULE_DELETE_TOOL: Tool = {
  definition: {
    name: 'schedule_delete',
    description: '按 id 删除一个定时自动化任务。id 先用 schedule_list 查出来。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（从 schedule_list 获取）。' },
      },
      required: ['id'],
    },
  },
  async execute({ input }) {
    const scheduler = getActiveScheduler()
    if (!scheduler) return noScheduler()
    const id = typeof input.id === 'string' ? input.id : ''
    if (!id) {
      return { content: '缺少 "id" 参数。' }
    }
    const ok = scheduler.remove(id)
    return {
      content: ok ? `已删除定时任务 ${id}。` : `未找到定时任务 ${id}。`,
    }
  },
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
