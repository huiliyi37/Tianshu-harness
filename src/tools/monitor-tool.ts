import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { getResolvedEnv } from './resolved-env.js'
import { sanitizeEnv } from './bash.js'
import { buildMirrorEnv } from './mirror-env.js'
import { loadConfig } from '../config/manager.js'
import { DANGEROUS_BASH_PATTERNS } from '../agent/approval-risk.js'

/**
 * Monitor 工具 — 订阅后台事件流，而非阻塞干等。
 *
 * 与 job(action="await") 的语义分野：await 阻塞整个 turn 等一个结果；
 * monitor 订阅后立返，命中事件在后续 API 轮边界以 system-reminder 自动
 * 送达（见 monitor-hook）。引导模型对「持续观察」场景从干等改为订阅。
 */

export const MONITOR_TOOL: Tool = {
  definition: {
    name: 'monitor',
    description: `订阅后台任务的输出事件流——注册即返回，命中事件会作为 system-reminder 在后续轮次自动送达，不要轮询也不要用 job(await) 干等。

Actions:
- subscribe: 订阅事件源。二选一：\`jobId\`（订阅既有后台任务，见 job action="list"）或 \`command\`（新起一个后台命令并订阅，如 "tail -f app.log"、"npm run watch"）。\`pattern\`（正则）可选：只在命中时产事件（如 "error|Error|FAIL"）；不给则每波新输出都产事件。每会话最多 5 个 monitor。
- list: 列出本会话的 monitor（含待投递事件数）。
- unsubscribe: 注销（\`id\` 必填）。任务退出会自动注销。`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['subscribe', 'list', 'unsubscribe'], description: '要执行的操作' },
        jobId: { type: 'string', description: '仅 subscribe：既有后台任务 id' },
        command: { type: 'string', description: '仅 subscribe：新起的后台命令（与 jobId 二选一）' },
        pattern: { type: 'string', description: '仅 subscribe：命中才产事件的正则（可选）' },
        id: { type: 'string', description: '仅 unsubscribe：monitor id' },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const monitors = params.monitors
    if (!monitors) {
      return { content: 'monitor 在当前上下文不可用（无会话）。可用 bash(run_in_background) + job(await) 替代。', isError: false }
    }
    const action = String(params.input.action ?? '')

    switch (action) {
      case 'subscribe': {
        const pattern = params.input.pattern != null ? String(params.input.pattern) : undefined
        const jobId = params.input.jobId != null ? String(params.input.jobId) : undefined
        const command = params.input.command != null ? String(params.input.command) : undefined
        if (!jobId && !command) {
          return { content: 'subscribe 需要 jobId 或 command 之一。', isError: true }
        }
        if (jobId && command) {
          return { content: 'jobId 与 command 只能给一个。', isError: true }
        }

        let resolvedJobId = jobId
        let spawnedJobId: string | undefined
        let jobsForRollback: typeof params.jobs
        if (command) {
          // command 模式：先按 bash 后台任务的同款环境 spawn 成 job，再订阅它
          // （sanitizeEnv + getResolvedEnv + mirrorEnv 三层与 bash.ts 一致；
          // 仅省 git-clone 专属的 earlyFailEnv）。
          if (!params.jobs) {
            return { content: '后台任务系统不可用，无法启动 command。', isError: true }
          }
          jobsForRollback = params.jobs
          const snapshot = params.jobs.spawn({
            command,
            rawCommand: command,
            cwd: params.cwd,
            env: { ...sanitizeEnv(getResolvedEnv(params.cwd)), ...buildMirrorEnv(loadConfig({ cwd: params.cwd }).mirrors) },
          })
          resolvedJobId = snapshot.id
          spawnedJobId = snapshot.id
        }

        const res = monitors.subscribe({ jobId: resolvedJobId!, pattern })
        if (!res.ok) {
          // subscribe 可能在 spawn 之后才失败（已达 monitor 上限 / pattern 非法）。
          // 留下的 job 会变成孤儿继续跑，而错误文案里不带 job id，模型事后无法
          // 用 job 工具回收它——必须在这里就地回滚。
          if (spawnedJobId && jobsForRollback) {
            try { jobsForRollback.kill(spawnedJobId) } catch { /* best-effort */ }
          }
          const rollbackNote = spawnedJobId ? `（已回收刚启动的后台任务 ${spawnedJobId}）` : ''
          return { content: res.error + rollbackNote, isError: true }
        }
        const m = res.monitor
        const desc = `◉ 监视 ${m.id} → job ${m.jobId}${pattern ? ` /${pattern}/` : ''}`
        return {
          content:
            `已注册 monitor ${m.id}：订阅 job ${m.jobId}（${m.command}）${pattern ? `，pattern /${pattern}/` : '，全量输出'}。\n` +
            `命中事件将作为 system-reminder 在后续轮次自动送达——继续当前工作，不要轮询或 job(await) 干等。`,
          uiContent: desc,
          isError: false,
        }
      }

      case 'list': {
        const list = monitors.list()
        if (list.length === 0) return { content: '当前没有 monitor。', uiContent: 'monitor: 0', isError: false }
        const body = list
          .map(m => `  [${m.id}] job ${m.jobId} · ${m.command}${m.pattern ? ` · /${m.pattern}/` : ''}${m.pending > 0 ? ` · 待投递 ${m.pending}` : ''}`)
          .join('\n')
        return { content: `Monitor 订阅（${list.length} 个）：\n${body}`, uiContent: `monitor: ${list.length}`, isError: false }
      }

      case 'unsubscribe': {
        const id = params.input.id != null ? String(params.input.id) : ''
        if (!id) return { content: 'unsubscribe 需要 id 参数。', isError: true }
        const ok = monitors.unsubscribe(id)
        return { content: ok ? `已注销 monitor ${id}。` : `未找到 monitor ${id}。`, uiContent: `unsubscribe ${id}`, isError: !ok }
      }

      default:
        return { content: `未知 action: ${action}。可用: subscribe / list / unsubscribe。`, isError: true }
    }
  },

  requiresApproval(params: ToolCallParams): boolean {
    // subscribe(command) 会 spawn 任意 shell——与 bash 同一危险命令闸门。
    // monitor 不做 rtk 别名重写（spawn 原样执行），故只匹配原始命令。
    if (String(params.input.action ?? '') !== 'subscribe') return false
    const command = params.input.command
    if (typeof command !== 'string' || command.length === 0) return false
    return DANGEROUS_BASH_PATTERNS.some(p => p.test(command))
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
