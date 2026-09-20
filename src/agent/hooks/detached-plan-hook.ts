import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { drainSettledDetachedPlanRuns, listDetachedPlanRuns } from '../detached-plan-registry.js'

/**
 * Detached-Plan Hook — plan_task(execute) 超时转后台后的 preTurn 通知。
 *
 * 通道与 monitor-hook 同一先例：settle 事件经 advisory bus 的
 * system-reminder（functional / immediate）注入下个对话轮——模型必读、
 * 尾部追加、前缀缓存安全。运行中的条目每轮一条 informational 轻提醒
 * （勿重复派发同一计划），同 background-jobs hook 的 awareness 模式。
 */
export interface DetachedPlanHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 多会话隔离：只 drain/提醒本会话的后台执行。 */
  sessionId?: string
}

function fmtElapsed(startedAt: number): string {
  const s = Math.round((Date.now() - startedAt) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

export function createDetachedPlanHook(deps: DetachedPlanHookDeps): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'detached-plan-events',
    run(_ctx: RuntimeHookContext) {
      // 终态事件：一次一 key（run id 天然唯一），遗言只投递一次（drain 即移除）。
      for (const run of drainSettledDetachedPlanRuns(deps.sessionId)) {
        const settled = run.settled!
        deps.advisoryBus.submit({
          key: `detached-plan-${run.id}`,
          priority: 0.65,
          category: 'background',
          tier: 'operational',
          channel: 'system-reminder',
          srClass: 'functional',
          immediate: true,
          content:
            `[后台计划执行${settled.ok ? '完成' : '失败'}] ${run.objective.slice(0, 80)}（${run.groupId}，` +
            `等待上限 ${Math.round(run.timeoutMs / 1000)}s 后转后台，实际运行 ${fmtElapsed(run.startedAt)}）：${settled.summary}` +
            (settled.ok
              ? ''
              : `——可用 team_orchestrate({ objective }) 续跑（会话内已存计划自动消费），checkpoint .rivet/checkpoints/${run.groupId}.json 记录最后完成波`),
        })
      }

      // 运行中 awareness：单条、ttl=1、informational——不吵，但防止模型忘记
      // 后台还有计划在跑而重复派发。
      // 类别独立（回流偏差 2026-09-21）：alpha 用 'background'，会与
      // background-jobs hook 争 MAX_PER_CATEGORY=2 的每类别预算——计划在跑时把
      // 别的后台提醒挤掉。独立类别天然各占各的预算（同 monitor 的先例）。
      const running = listDetachedPlanRuns(deps.sessionId).filter(r => !r.settled)
      if (running.length > 0) {
        const lines = running.map(r => `  [${r.groupId}] ${r.objective.slice(0, 60)} · 已运行 ${fmtElapsed(r.startedAt)}`)
        deps.advisoryBus.submit({
          key: 'detached-plan-running',
          priority: 0.5,
          category: 'detached-plan',
          tier: 'informational',
          content:
            `后台计划执行中 (${running.length})：\n${lines.join('\n')}\n` +
            `每波完成即写 checkpoint；执行结束时下轮会有完成提醒。勿重复派发同一计划。`,
          ttl: 1,
        })
      }
    },
  }
}
