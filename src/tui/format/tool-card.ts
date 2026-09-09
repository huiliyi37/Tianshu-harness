/**
 * T9 格式化函数 — 工具卡片（Claude Code 风格）。
 *
 * 渲染结构：
 *   › Run(npm test) (1.2s)
 *     ⎿  前 4 行输出
 *        … +25 行 · ctrl+o 展开
 *
 * - 状态形色双通道：› 成功绿 / ✗ 失败红 / ⠋ 进行中 dim / ? 待答黄
 * - 参数摘要：复用 tool-label.ts 的 toolArgSummary + tool-family.ts 动词体系
 * - 截断：默认头 N 行 + `… +N lines` 尾注；read 族用头+尾预览
 * - diff 检测：write/edit 族结果经 isDiffContent() 检测后走红绿渲染
 */

import { color, fileLink } from '../engine/ansi.js'
import { classifyBrowserDebugLine } from '../../tools/browser-debug/log-capture.js'
import type { RivetTheme } from '../theme.js'
import { getToolFamily } from '../tool-family.js'
import { toolArgSummary } from '../tool-label.js'
import { isDelegationTool } from './tool-domain.js'
import { formatElapsed } from '../tool-elapsed.js'
import { formatDiff, isDiffContent, computeDiffStats } from './diff.js'
import { brailleSpinnerFrame } from '../braille-spinner.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { useAsciiGlyphs } from '../term-caps.js'
import { EXPAND_HINT, truncationHint } from '../truncation-marker.js'

/** 宽度口径：与 LiveEngine.rowsForLine 一致。工具输出（git diff/代码/日志）常含
 *  `— … │ →` 等 ambiguous 符号 + CJK，按 .length/stringWidth(narrow) 截断会低估
 *  实际列宽 → 尾行溢出终端宽度折行 → rowsForLine 低估 → chrome 残留重影。 */
const WIDE = { ambiguousAsWide: true }

export interface FormatToolCardInput {
  /** 工具名称 */
  toolName: string
  /** 工具输出内容 */
  content: string
  /** 是否为错误输出 */
  isError?: boolean
  /** 缩进深度（用于工具调用链的树形连接线） */
  depth?: number
  /** 原始文件路径（用于显示文件名） */
  rawPath?: string
  /** 折叠时显示的输出行数上限 */
  maxLines?: number
  /** 工具耗时（毫秒），可选 */
  elapsedMs?: number
  /** 是否正在流式输出中 */
  streaming?: boolean
  /** 工具输入参数（用于标题参数摘要） */
  toolInput?: Record<string, unknown>
  /** 完整展开（ctrl+o），不截断 */
  expanded?: boolean
}

const DEFAULT_MAX_LINES = 4
const READ_HEAD_LINES = 3
const READ_TAIL_LINES = 5
const DIFF_MAX_LINES = 20

/** 按工具家族给不同默认展开高度，避免所有工具都挤在 4 行内。 */
export function getDefaultMaxLines(toolName: string): number {
  const family = getToolFamily(toolName).family
  switch (family) {
    case 'run': return 8
    case 'find': return 6
    case 'write': return DIFF_MAX_LINES
    case 'read': return READ_HEAD_LINES + READ_TAIL_LINES
    case 'other': return DEFAULT_MAX_LINES
    default: return DEFAULT_MAX_LINES
  }
}

const BODY_FIRST_PREFIX = '⎿  '
const BODY_CONT_PREFIX = '   '

/** 标题动词：family verb 首字母大写（Run/Read/Patch/Write/Search/Find…） */
function toolTitleVerb(toolName: string): string {
  const verb = getToolFamily(toolName).verb
  return verb.charAt(0).toUpperCase() + verb.slice(1)
}

/** 标题行文本（无色）：`Run(npm test)` 或 `Read(foo.ts)` */
export function toolCardTitle(toolName: string, toolInput?: Record<string, unknown>, rawPath?: string): string {
  const verb = toolTitleVerb(toolName)
  let arg = toolInput ? toolArgSummary(toolName, toolInput) : ''
  if (!arg && rawPath) arg = rawPath.split('/').pop() ?? rawPath
  return arg ? `${verb}(${arg})` : verb
}

/** 缩进 body 行：第一行 `⎿  `，后续行对齐缩进 */
function indentBody(bodyLines: readonly string[], indent: string, theme: RivetTheme): string[] {
  return bodyLines.map((line, i) =>
    `${indent}${i === 0 ? color(BODY_FIRST_PREFIX, theme.dim) : BODY_CONT_PREFIX}${line}`)
}

/**
 * 格式化工具卡片为 ANSI 行数组（Claude Code ●/⎿ 结构）。
 */
export function formatToolCard(input: FormatToolCardInput, theme: RivetTheme): string[] {
  const {
    toolName,
    content,
    isError = false,
    depth = 0,
    rawPath,
    elapsedMs,
    streaming = false,
    toolInput,
    expanded = false,
  } = input

  const family = getToolFamily(toolName)
  const indent = depth > 0 ? '  '.repeat(depth) : ''
  const isQuestion = toolName === 'ask_user_question'

  // ── Header: ● Verb(arg) (elapsed) ───────────────────────────
  // Bullet 形色双通道：状态不能只靠颜色编码——16 色终端与红绿色觉障碍下
  // 「成功」和「失败」会是同一个 ›。形状同时承载状态，颜色只做强化。
  // 成功态 › 不走 ASCII 降级：useAsciiGlyphs 的门槛是 chalk.level<3，tmux(level 2)
  // 也会命中，而 › 在那里渲染正常——降级它等于给绝大多数会话的主流状态换字形。
  // 新引入的 ✗ / ⠋ 才降级（braille 与 dingbat 在 legacy conhost 是 tofu）。
  const useAscii = useAsciiGlyphs()
  const bulletColor = isError ? theme.error : isQuestion ? theme.warning : streaming ? theme.dim : theme.success
  const bulletGlyph = isError ? (useAscii ? 'x' : '✗')
    : isQuestion ? '?'
    : streaming ? (useAscii ? '-' : '⠋')
    : '›'
  const title = toolCardTitle(toolName, toolInput, rawPath)
  const tColor = isQuestion ? theme.warning : theme.toolColor(toolName)
  // 文件路径 → OSC 8 可点击链接（支持的终端 Cmd/Ctrl+Click 直接打开；其余纯文本降级）
  const linkPath = rawPath
    ?? (typeof toolInput?.path === 'string' ? toolInput.path : undefined)
    ?? (typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined)
  const titleColored = color(title, tColor, { bold: true })
  let header = `${indent}${color(bulletGlyph, bulletColor)} ${linkPath ? fileLink(titleColored, linkPath) : titleColored}`
  if (streaming) {
    header += ` ${color('…', theme.dim)}`
  } else if (elapsedMs !== undefined) {
    header += ` ${color(`(${formatElapsed(elapsedMs)})`, theme.muted)}`
  }

  const lines: string[] = [header]

  // ── Streaming delegation preview ──────────────────────────────
  // When a delegate_batch/delegate_task call is streaming its args (no result
  // yet), show the task list / objective as a live preview so the user sees
  // the delegation scope growing token-by-token. Mirrors pi's
  // renderTaskItemLines — once a result arrives, the worker fleet panel
  // takes over and this preview is skipped (non-streaming).
  if (streaming && isDelegationTool(toolName) && toolInput) {
    const preview = renderDelegationPreview(toolName, toolInput, theme, indent)
    if (preview.length > 0) {
      lines.push(...preview)
      return lines
    }
  }

  const trimmed = content.replace(/\n+$/, '')
  if (!trimmed) {
    lines.push(`${indent}${color(BODY_FIRST_PREFIX, theme.dim)}${color('(无输出)', theme.muted)}`)
    return lines
  }

  // ── Diff 分支：write/edit 族 + diff 内容 → 红绿渲染 ─────────
  // 阈值：adds+dels ≤ 10 内联完整 diff，>10 折叠为单行摘要
  if (family.family === 'write' && isDiffContent(trimmed)) {
    const stats = computeDiffStats(trimmed)
    const changeCount = stats.adds + stats.dels
    if (changeCount <= 10 || expanded) {
      const diffLines = formatDiff({
        content: trimmed,
        maxLines: Number.MAX_SAFE_INTEGER,
      }, theme)
      lines.push(...indentBody(diffLines, indent, theme))
    } else {
      const hunkLabel = stats.hunks > 0 ? `${stats.hunks} 处修改` : `${changeCount} 行修改`
      const summary = `⎿ ${hunkLabel} (+${stats.adds} −${stats.dels})`
      lines.push(`${indent}${color(BODY_FIRST_PREFIX, theme.dim)}${color(summary, theme.muted)}`)
      lines.push(`${indent}${BODY_CONT_PREFIX}${color(`${EXPAND_HINT}完整 diff`, theme.secondary)}`)
    }
    return lines
  }

  // ── browser_debug 分支：console/network 行按前缀分级着色 ───────
  if (toolName === 'browser_debug') {
    const allLines = trimmed.split('\n')
    const maxLines = input.maxLines ?? getDefaultMaxLines(toolName)
    const shown = expanded || allLines.length <= maxLines ? allLines : allLines.slice(0, maxLines)
    const body = shown.map((l) => colorBrowserDebugLine(l, theme))
    if (!expanded && allLines.length > maxLines) {
      body.push(color(truncationHint(allLines.length - maxLines), theme.secondary))
    }
    lines.push(...indentBody(body, indent, theme))
    return lines
  }

  // ── 普通输出分支 ─────────────────────────────────────────────
  const contentLines = trimmed.split('\n')
  const totalLines = contentLines.length
  const maxLines = input.maxLines ?? getDefaultMaxLines(toolName)
  // 正文是「数据」(命令输出/文件列表/git status)，用可读的 muted 前景。
  // 绝不能用 theme.dim —— dim 是装饰专用色(分隔线/快捷键)，在墨夜底上 ~2:1
  // 对比度几乎不可见，会把真实数据染到看不清。
  // ask_user_question 用 warning 色高亮，让用户一眼看到需要回复的问题。
  const bodyColor = isError ? theme.error : isQuestion ? theme.warning : theme.muted

  const renderLine = (l: string) => color(l, bodyColor)

  // ask_user_question 必须完整展示问题和所有选项，禁止截断。
  if (expanded || isQuestion || totalLines <= maxLines) {
    lines.push(...indentBody(contentLines.map(renderLine), indent, theme))
    if (rawPath && !expanded) {
      lines.push(`${indent}${BODY_CONT_PREFIX}${color(`raw: ${rawPath.split('/').pop() ?? rawPath}`, theme.muted)}`)
    }
    return lines
  }

  // 截断：read 族用头+尾预览，其他工具用头 N 行
  if (family.family === 'read') {
    const head = contentLines.slice(0, READ_HEAD_LINES)
    const tail = contentLines.slice(-READ_TAIL_LINES)
    const omitted = totalLines - READ_HEAD_LINES - READ_TAIL_LINES
    const body = [
      ...head.map(renderLine),
      color(truncationHint(omitted), theme.secondary),
      ...tail.map(renderLine),
    ]
    lines.push(...indentBody(body, indent, theme))
    return lines
  }

  const head = contentLines.slice(0, maxLines)
  const omitted = totalLines - maxLines
  const body = [
    ...head.map(renderLine),
    color(truncationHint(omitted), theme.secondary),
  ]
  lines.push(...indentBody(body, indent, theme))
  return lines
}

/** 判断该工具结果在折叠渲染下是否被截断（供 ctrl+o 展开记录用） */
export function isToolCardTruncated(input: Pick<FormatToolCardInput, 'toolName' | 'content' | 'maxLines'>): boolean {
  // ask_user_question is always rendered in full; no expand action needed.
  if (input.toolName === 'ask_user_question') return false
  const trimmed = input.content.replace(/\n+$/, '')
  if (!trimmed) return false
  const totalLines = trimmed.split('\n').length
  const family = getToolFamily(input.toolName)
  if (family.family === 'write' && isDiffContent(trimmed)) {
    const stats = computeDiffStats(trimmed)
    return (stats.adds + stats.dels) > 10
  }
  return totalLines > (input.maxLines ?? getDefaultMaxLines(input.toolName))
}

// ── Live 进行中工具行 ──────────────────────────────────────────

export interface FormatToolCardLiveInput {
  toolName: string
  /** 工具输入参数（标题摘要） */
  toolInput?: Record<string, unknown>
  /** 已累积的流式输出 */
  outputTail?: string
  /** 预切分的 tail 行（可选）：提供时跳过 outputTail 的整串 split——live 区每帧渲染
   *  时调用方可按累加器字符串引用缓存切分结果，避免 60fps 下重复扫描 ≤64KB 全串。 */
  outputTailLines?: string[]
  /** 已运行时长（毫秒） */
  elapsedMs?: number
  /** 末尾输出显示行数 */
  tailLines?: number
  /** 终端列数 */
  columns: number
  /** 动画帧序号；提供时用 spinner 替代静态 bullet */
  tick?: number
}

/**
 * live 区进行中工具的渲染：dim `●` 标题行 + 末 N 行输出（⎿ 缩进）。
 */
export function formatToolCardLive(input: FormatToolCardLiveInput, theme: RivetTheme): string[] {
  const title = toolCardTitle(input.toolName, input.toolInput)
  const useAscii = useAsciiGlyphs()
  const bullet = input.tick !== undefined
    ? (useAscii ? ['-', '\\', '|', '/'][((input.tick % 4) + 4) % 4]! : brailleSpinnerFrame(input.tick))
    : '●'
  let header = `${color(bullet, theme.dim)} ${color(title, theme.toolColor(input.toolName), { bold: true })}`
  if (input.elapsedMs !== undefined && input.elapsedMs >= 1000) {
    header += ` ${color(`(${formatElapsed(input.elapsedMs)})`, theme.muted)}`
  }

  const lines: string[] = [header]
  // 优先用调用方预切的行（按累加器引用缓存），否则从 outputTail 现切。
  const tailRows = input.outputTailLines ?? (() => {
    const tail = (input.outputTail ?? '').replace(/\n+$/, '')
    return tail ? tail.split('\n') : undefined
  })()
  // 负值与 0 都归零：`slice(-0)` 等于 `slice(0)`，会把整个 tail 全量摊开——
  // 正是 tailLines=0（并发时折叠非焦点卡片）想避免的相反效果。
  const tailCount = Math.max(0, input.tailLines ?? 3)
  // BODY_FIRST_PREFIX = '⎿  ' (3 display columns) — content has columns-3 available.
  const maxWidth = Math.max(10, input.columns - 3)

  // 固定 tail 区域高度：内容不足时顶部补空行，避免卡片高度随输出变化而跳动。
  const isBrowserDebug = input.toolName === 'browser_debug'
  const tailLines: string[] = []
  if (tailCount > 0 && tailRows && tailRows.length > 0) {
    const shown = tailRows.slice(-tailCount).map(l => {
      // 按显示宽度截断（CJK 2 列、ambiguous 2 列）。… 自身 2 列，预算留给它。
      const ellW = displayWidth('…', WIDE)
      const clipped = displayWidth(l, WIDE) > maxWidth
        ? `${truncateToDisplayWidth(l, maxWidth - ellW, WIDE)}…`
        : l
      return isBrowserDebug ? colorBrowserDebugLine(clipped, theme) : color(clipped, theme.muted)
    })
    tailLines.push(...indentBody(shown, '', theme))
  }

  // 无输出时显示占位符，保持固定高度（tailCount=0 表示只要标题行，不占位）
  if (tailCount > 0 && tailLines.length === 0) {
    tailLines.push(`${color(BODY_FIRST_PREFIX, theme.dim)}${color('…', theme.dim)}`)
  }
  while (tailLines.length < tailCount) {
    tailLines.unshift(BODY_CONT_PREFIX)
  }

  lines.push(...tailLines)
  return lines
}

// ── Streaming delegation preview ───────────────────────────────
// Renders a live task-list preview while delegate_batch/delegate_task
// args stream in. Mirrors pi's renderTaskItemLines: each task appears
// as `• ID: description` as the JSON tokens arrive. Once a result
// arrives, the worker fleet panel takes over and this preview is skipped.

const DELEGATION_PREVIEW_MAX = 8

function renderDelegationPreview(
  toolName: string,
  toolInput: Record<string, unknown>,
  theme: RivetTheme,
  indent: string,
): string[] {
  const lines: string[] = []
  const bullet = color('•', theme.dim)
  const prefix = `${indent}${BODY_FIRST_PREFIX}`

  // delegate_batch: render tasks[] list
  if (toolName === 'delegate_batch') {
    const tasks = Array.isArray(toolInput.tasks) ? toolInput.tasks : []
    if (tasks.length === 0) {
      lines.push(`${prefix}${color('… 等待任务列表', theme.dim)}`)
      return lines
    }
    const cap = Math.min(tasks.length, DELEGATION_PREVIEW_MAX)
    for (let i = 0; i < cap; i++) {
      const task = tasks[i] as Record<string, unknown> | undefined
      // 目标取自 `objective` —— delegate_batch 的任务 schema 里只有它
      // （delegate-batch.ts required: ['objective']）。此处一度读 `description`
      // 与 `id`，两个字段都不存在，于是每次批量派发都只渲染出 `• #1 • #2`：
      // 逐次一模一样、与真实任务毫无关系。
      const objective = typeof task?.objective === 'string' ? task.objective.trim() : ''
      let line = `${prefix}${bullet} ${color(`#${i + 1}`, theme.secondary, { bold: true })}`
      if (objective) {
        line += color(`: ${truncatePreview(objective, 60)}`, theme.muted)
      }
      lines.push(line)
    }
    if (cap < tasks.length) {
      lines.push(`${prefix}${color(`… +${tasks.length - cap} more`, theme.dim)}`)
    }
    return lines
  }

  // delegate_task (single): render objective
  if (toolName === 'delegate_task') {
    const objective = typeof toolInput.objective === 'string' ? toolInput.objective.trim() : ''
    // 参数还在流式到达时 objective 可能尚未成形；此处退到 profile
    // （schema 里真实存在的字段，`agent` 不是）。
    const profile = typeof toolInput.profile === 'string' ? toolInput.profile : ''
    if (objective) {
      lines.push(`${prefix}${color(truncatePreview(objective, 72), theme.muted)}`)
    } else if (profile) {
      lines.push(`${prefix}${color(`… 派发 ${profile}`, theme.dim)}`)
    } else {
      lines.push(`${prefix}${color('… 派发中', theme.dim)}`)
    }
    return lines
  }

  return lines
}

function truncatePreview(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// ── browser_debug line colouring ───────────────────────────────
// Console lines are prefixed `[error] / [warn] / [log]…`; network lines start
// with a status glyph (`→` pending, `←` done, `✗` failed). Colour by severity
// so the user can eyeball errors and 4xx/5xx in the live/committed card.

/** Colour one browser_debug output line by its console level / HTTP status.
 *  Severity comes from the shared `classifyBrowserDebugLine` so the TUI and the
 *  desktop renderer stay in lockstep; this only maps a bucket to a theme colour. */
export function colorBrowserDebugLine(line: string, theme: RivetTheme): string {
  switch (classifyBrowserDebugLine(line)) {
    case 'error':
      return color(line, theme.error)
    case 'warn':
      return color(line, theme.warning)
    case 'ok':
      return color(line, theme.success)
    case 'pending':
      return color(line, theme.dim)
    default:
      return color(line, theme.muted)
  }
}
