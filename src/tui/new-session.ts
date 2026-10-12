/**
 * /new —— 会话中途开新会话（对齐 Claude Code 的 /clear：同进程换一段干净上下文）。
 *
 * 独立成模块的两条理由：
 *  ① `slash-commands.ts` 是 architecture-guards 点名的巨石（max-lines ratchet
 *     只降不升），新命令不该继续撑大它——与 yolo-toggle.ts / zen-command.ts 同处置；
 *  ② 「切换后状态复原」是 /resume 与 /new 共用的逻辑，做成模块导出让
 *     onSessionSwitch 侧 import 复用，避免第四份复制（仓库吃过 R24 两份复制的亏：
 *     复制即分叉根因）。
 *
 * 命名与启动标志 `--new` 对齐——同一个「新会话」概念的两个入口（进程级 / 会话级）。
 * 天枢的 `/clear` 已被占为纯清屏，故此命令用 /new。
 */

import type { TuiApp } from './engine/app.js'
import type { BootstrapContext } from '../bootstrap.js'
import { restorePlanModeFromMeta } from '../bootstrap.js'
import { startFreshSession, type StartFreshSessionResult } from '../agent/fresh-session.js'
import { getSessionDir } from '../agent/session-persist.js'
import { restoreGoalTracker } from '../agent/goal-persist.js'
import { loadTodos, setTodoSession } from '../tools/todo.js'
import { setPlanSession } from '../agent/plan-store.js'
import { catalogMetaFor } from './command-catalog.js'
import { initializeFrontendHistory } from './frontend-session-provider.js'

/**
 * 会话切换成功后的 UI / 状态复原——/resume、/fork、/branch back 与 /new 共用
 * 这一份（此前内联在 slash-commands.ts 的 onSessionSwitch 里）。
 *
 * 对 /new 同样成立：新会话的 goal/todo/plan 本就查不到 → 全部落到「空」分支，
 * 正是重置语义；侧栏按新 meta 关闭。一份代码覆盖两种切换。
 */
export function applySessionSwitch(app: TuiApp, ctx: BootstrapContext, targetId: string): void {
  void initializeFrontendHistory(app, ctx, targetId).catch(error => app.commitStatic(`阅读历史切换失败：${(error as Error).message}`, { isError: true }))
  app.setStreamingState(false)
  // 会话边界重置定高视口高水位——旧会话的峰值空白不带进新会话
  //（对齐 tianshu-public switchSession）。
  app.resetLiveHighWater()
  app.clearPinnedPrompt()
  // 切换后恢复目标、todo 列表与 side panel 状态，保持会话连续性。
  try {
    const restoredGoal = restoreGoalTracker(getSessionDir(ctx.cwd), targetId, {
      maxJudgeRuns: ctx.config.agent.goal?.judge?.maxRuns,
    })
    if (restoredGoal) {
      ctx.agent.setGoalTracker(restoredGoal)
      ctx.refs.goalTrackerRef.current = restoredGoal
    } else {
      ctx.refs.goalTrackerRef.current = null
    }
  } catch { /* goal restore best-effort */ }
  try {
    loadTodos(targetId, ctx.cwd)
    setTodoSession(targetId, ctx.cwd)
    setPlanSession(targetId)
  } catch { /* todo/plan restore best-effort */ }
  try {
    const meta = ctx.persist.loadMetadata()
    if (meta?.sidePanelOpen) app.setSidePanelOpen(true)
    else app.setSidePanelOpen(false)
    // 计划模式恢复：目标会话退出时在 planning 且 draft 仍在 → 重进。
    const restoredPlan = restorePlanModeFromMeta(ctx.agent, ctx.cwd, meta)
    if (restoredPlan) {
      app.commitStatic(`🔍 已恢复计划模式（draft: ${restoredPlan}）— /plan-mode 退出或批准计划后执行。`)
    }
  } catch { /* panel/plan restore best-effort */ }
}

/** 注入点：单测用 fake 覆盖「新会话创建成功」这条重路径（真实路径会重建 AgentLoop）。 */
export interface NewSessionDeps {
  startFresh?: (ctx: BootstrapContext) => StartFreshSessionResult
}

/**
 * 注册 /new。busy 守卫在实现侧（handler 需要 app），因此本命令走 register 形式
 * 而非 TUI_SLASH_COMMANDS 数组——与 /clear、/queue、/glance 同一模式。
 */
export function registerNewSessionCommand(
  app: TuiApp,
  ctx: BootstrapContext,
  deps: NewSessionDeps = {},
): void {
  const startFresh = deps.startFresh ?? startFreshSession

  app.registerSlashCommand({
    name: '/new',
    description: catalogMetaFor('/new')?.description,
    immediate: true,
    async handler() {
      // busy 守卫：运行中切会话会让在途 run 的产出落进一个已经被换掉的上下文
      //（且 switchAgentSession 内部会 abort = 悄悄吃掉用户正在做的事）。
      // 宁可不做——等还是中断，由用户决定。
      if (app.busy) {
        app.commitStatic('⚠️ 开新会话失败：agent 正在运行——等本轮结束（或 Esc 中断）再开新会话。')
        return true
      }
      // 旧会话写缓冲必须先落盘再切：切换会整体替换 persist 实例，仍排在旧
      // batchWriter 队列里的末几条消息会随之被丢弃（与 /fork 同款纪律）。
      try { await ctx.persist.flushSessionBuffer() } catch { /* flush 尽力而为，失败不阻断切换 */ }

      const res = startFresh(ctx)
      if (!res.ok || !res.sessionId) {
        app.commitStatic(`⚠️ 开新会话失败：${res.error ?? '未知错误'}`)
        return true
      }

      applySessionSwitch(app, ctx, res.sessionId)
      // 队列 lane 攒的是「旧会话的下一条」：新会话是干净的一段，攒着的话不该被
      // 带进去（否则它会在新上下文里被发出，而那是旧上下文的意图）。
      app.queueLane.length = 0
      // 清屏是「上下文已重置」的视觉断点——提示行写在清屏之后才看得见。
      app.clearScreen()

      const short = res.sessionId.slice(0, 8)
      const prev = res.previousSessionId?.slice(0, 8)
      app.commitStatic([
        `✨ 新会话 ${short} 已开始 — 上下文已重置；项目记忆 / 配置 / 工作目录不变。`,
        prev ? `   上一会话 ${prev} 已存档，/resume ${prev} 可回访。` : '',
      ].filter(Boolean).join('\n'))
      return true
    },
  })
}
