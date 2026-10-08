/**
 * 提问的会话记录。已提交的答案紧随状态行展示，不重复打印全部候选项；
 * 未作答或转入讨论时保留完整题面，按终端宽度折行。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { hardWrapToDisplayWidth } from '../width.js'

const DEFAULT_WIDTH = 80

/** 把一段文本按目标显示宽度折成多行，保留已有换行。 */
function wrapLines(text: string, width: number): string[] {
  return text.split('\n').flatMap(line => hardWrapToDisplayWidth(line, width))
}

export interface FormatAskUserQuestionInput {
  content: string
  columns?: number
  state?: 'pending' | 'answered' | 'discussion' | 'unanswered'
}

export function formatAskUserQuestion(input: FormatAskUserQuestionInput, theme: RivetTheme): string[] {
  const cols = Math.max(1, input.columns ?? DEFAULT_WIDTH)
  const indent = cols > 2 ? '  ' : ''
  const innerWidth = Math.max(1, cols - indent.length)
  const state = input.state ?? 'pending'
  const tone = state === 'pending' ? theme.warning : theme.muted
  const label = { pending: '? 需要你的回答', answered: '✓ 已提交回答', discussion: '◇ 提问 · 转入讨论', unanswered: '◇ 提问 · 未作答' }[state]
  const title = wrapLines(label, innerWidth).map(line => indent + color(line, state === 'answered' ? theme.success : tone, { bold: true }))
  return state === 'answered' ? title : [...title, ...wrapLines(input.content, innerWidth).map(line => indent + line)]
}

/** 判断 ask_user_question 内容是否需要在终端宽度下折行。 */
export function isAskUserQuestionWrapped(content: string, columns?: number): boolean {
  const cols = Math.max(1, columns ?? DEFAULT_WIDTH)
  const innerWidth = Math.max(1, cols - (cols > 2 ? 2 : 0))
  return wrapLines(content, innerWidth).length > content.split('\n').length
}
