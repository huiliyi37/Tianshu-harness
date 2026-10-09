/**
 * `/steer` — 插队引导正在运行的 agent（在工具调用边界立即注入生效，等同于 Alt+Enter）。
 *
 * 独立模块：避免 slash-commands.ts 巨石文件继续增长（受 source-budgets.manifest.json 限制）。
 */

import type { TuiApp } from './engine/app.js'

export function registerSteerCommand(app: TuiApp): void {
  app.registerSlashCommand({
    name: '/steer',
    description: '插队引导正在运行的 agent（工具边界生效，等同于 Alt+Enter）',
    immediate: true,
    handler: ({ trimmed }) => {
      const arg = trimmed.slice('/steer'.length).trim()
      if (!arg) {
        app.commitStatic('⚡ 用法：/steer <引导内容> — 在当前轮次工具边界立即插队引导（等同于 Alt+Enter）')
        return true
      }
      void app.submitSteer(arg)
      return true
    },
  })
}
