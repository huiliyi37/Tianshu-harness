/**
 * T9 格式化函数 — 输入框下方键位提示行（prompt footer）。
 *
 * 至多三个当前可执行的动作；窄屏逐项收起，审批由决策区显示自己的提示。
 */

import { color } from '../engine/ansi.js'
import { displayWidth, ambiguousWideEnabled } from '../width.js'
import { getKeybindingRows } from '../keybindings.js'
import type { FrontendPreferences } from '../frontend-preferences.js'
import type { RivetTheme } from '../theme.js'

export interface PromptFooterInput {
  /** 终端宽度 */
  width: number
  /** 粘滞换行模式：Enter 换行，Ctrl+X Enter 发送。 */
  newlineMode?: boolean
  /** agent 运行中：提示打断键 */
  agentBusy?: boolean
  /** 审批挂起：提示审批动作 */
  approvalPending?: boolean
  /** kitty keyboard protocol 能力回包确认后，可以提示 Ctrl+Enter 发送。 */
  shiftEnterAvailable?: boolean
  keymap?: 'standard' | 'legacy'
  renderer?: 'classic' | 'fullscreen'
  stashedDraft?: boolean
  bindings?: FrontendPreferences['bindings']
}

/**
 * 提示从后往前逐项收起；权限与模式由独立工作区行负责。
 */
export function formatPromptFooter(input: PromptFooterInput, theme: RivetTheme): string[] {
  if (input.approvalPending) return []
  const prefs = { keymap: input.keymap ?? 'legacy', bindings: input.bindings ?? {} } as FrontendPreferences
  const key = (action: 'history' | 'stash') => {
    const row = getKeybindingRows(prefs).find(row => row.action === action)!
    return row.key?.replace(/^ctrl_/, 'Ctrl+').replace(/^alt_/, 'Alt+').replace(/[a-z]$/, letter => letter.toUpperCase()) ?? row.command
  }
  const hints = input.newlineMode
    ? ['Enter 换行', input.shiftEnterAvailable ? 'Ctrl+Enter 发送' : 'Ctrl+X Enter 发送', `${key('history')} 历史`]
    : input.agentBusy
      ? ['Esc 停止', 'Enter 排队', 'Alt+Enter 插队', 'Ctrl+J 换行']
      : [input.stashedDraft ? `${key('stash')} 恢复草稿` : 'Enter 发送', 'Ctrl+J 换行', `${key('history')} 历史`]
  while (hints.length > 1 && displayWidth(hints.join(' · '), { ambiguousAsWide: ambiguousWideEnabled() }) > input.width - 1) hints.pop()
  return displayWidth(hints[0] ?? '', { ambiguousAsWide: ambiguousWideEnabled() }) > input.width - 1 ? [] : [color(hints.join(' · '), theme.muted)]
}
