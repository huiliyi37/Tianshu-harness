import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth, ambiguousWideEnabled } from '../width.js'

export interface FormatPinnedPromptInput {
  prompt: string
  status: 'running' | 'completed'
  width: number
  theme: RivetTheme
}

/**
 * 格式化置顶执行/上一轮命令行（对标 Codex CLI prompt_header 契约）。
 * 在主视图顶部以单行紧凑形式呈现当前执行中或上一轮完成的用户指令，
 * 避免用户在长日志与多工具调用滚动时频繁向上翻阅历史。
 */
export function formatPinnedPrompt(input: FormatPinnedPromptInput): string {
  const { prompt, status, width, theme } = input
  const policy = { ambiguousAsWide: ambiguousWideEnabled() }
  const maxWidth = Math.max(16, width - 1)

  // 截取首行，压缩多行换行与连续空白，过滤控制符
  const firstLine = prompt.split('\n')[0]!.trim()
  const sanitized = firstLine.replace(/[\r\t]/g, ' ').replace(/\s+/g, ' ')
  const text = sanitized || '[附件消息]'

  const isRunning = status === 'running'
  // 运行态：› 符号高亮（cyan/primary）；完成态：› 符号弱化（dim/muted）
  const marker = isRunning
    ? color('› ', theme.primary, { bold: true })
    : color('› ', theme.dim, { bold: true })

  const tag = isRunning
    ? color('[执行中] ', theme.primary)
    : color('[上一轮] ', theme.muted)

  const prefixWidth = displayWidth('› [执行中] ', policy)
  const availableTextWidth = Math.max(4, maxWidth - prefixWidth)

  let fittedText = text
  if (displayWidth(text, policy) > availableTextWidth) {
    fittedText = truncateToDisplayWidth(text, Math.max(1, availableTextWidth - displayWidth('…', policy)), policy) + '…'
  }

  const textColor = isRunning ? theme.assistantColor : theme.muted
  return marker + tag + color(fittedText, textColor)
}
