/**
 * /steer <text> —— 显式插队引导（对齐 Codex CLI 的 pending_steers 契约）。
 *
 * TUI 的输入通道分工（本命令是「显式插队」的斜杠入口，键盘入口是 Alt+Enter）：
 *   /steer <text> / Alt+Enter → now 优先级进 steer 队列，下一个工具边界
 *                               drain('next') 立即注入（见 app.ts onSteerDrain）；
 *   普通 Enter（busy）        → later 优先级，本轮结束后自动作为下一轮发出；
 *                               仅当意图被判为 halt/redirect 时才在工具边界注入
 *                               （分类见 steer-intent.ts）；
 *   /queue <text>             → queueLane，唯一出口是下一次 idle 提交的归并，
 *                               不进本轮。
 *
 * 独立导出：单测没有完整 BootstrapContext，需要能单独注册这一条命令
 * （与 registerQueueCommand 同一处置；本模块独立也避免命令巨石继续膨胀）。
 */

import type { TuiApp } from './engine/app.js'

export function registerSteerCommand(app: TuiApp): void {
  app.registerSlashCommand({
    name: '/steer',
    description: 'Insert guidance at the next tool boundary (same as Alt+Enter)',
    immediate: true,
    handler: ({ trimmed }) => {
      const arg = trimmed.slice('/steer'.length).trim()
      if (!arg) {
        app.commitStatic('⚡ /steer <引导内容>——在当前轮次的工具边界立即插队引导（等同于 Alt+Enter）')
        return true
      }
      void app.submitSteer(arg)
      return true
    },
  })
}
