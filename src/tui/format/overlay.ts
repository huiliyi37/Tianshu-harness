/**
 * T9 Overlay 渲染函数 — 纯 ANSI 格式化。
 *
 * 每个 overlay 是一个 `render(width, height, data, theme): string[]` 纯函数，
 * 返回 ANSI 格式化后的行数组。由 OverlayEngine 在 alternate screen buffer 中渲染。
 *
 * 支持的 overlays：
 * - Pager — 分页查看器（大段文本浏览）
 * - Starmap — 星域总览
 * - CommandPalette — 命令面板
 * - Chronicle — 会话历史
 */

import { displayWidth, ambiguousWideEnabled, hardWrapToDisplayWidth, truncateToDisplayWidth } from '../width.js'
import { color } from '../engine/ansi.js'
import { createMenuLines, type OverlayMenuLines } from '../engine/overlay-engine.js'
import { resolveThemeEntry, type RivetTheme } from '../theme.js'
import { numberedChoice } from './panel-layout.js'
import { renderThemePreview } from './theme-preview.js'
import { formatElapsed } from '../tool-elapsed.js'
import { formatTokenCount } from './spinner-status.js'
import { formatAuthorityLabel, formatWorkerIdentity } from './profile-labels.js'
import { DOMAIN_SWITCH_CACHE_NOTE } from '../../agent/domain-picker-entries.js'
import type { GenesisEntry } from '../../agent/star-genesis-data.js'
import type { TranscriptMessage } from '../scrollback-transcript.js'
import type { ConnectView } from '../connect-flow.js'
import type { InitView } from '../init-flow.js'
import { uiGlyphs } from '../ui-glyphs.js'
import {
  frameTop as formatBorder,
  frameBottom as formatBottomBorder,
  frameTitleCenter as formatTitleBar,
  frameTitleLeft as frameTitleLeftUnsafe,
  frameFooter as formatFooter,
  frameLine as frameLineUnsafe,
  frameDivider,
  frameHintRows,
  frameInset,
  CURSOR,
  keyHints,
  type BorderStyle,
} from './overlay-frame.js'

const widthOptions = () => ({ ambiguousAsWide: ambiguousWideEnabled() })
const stringWidth = (text: string): number => displayWidth(text, widthOptions())

function visibleLine(text: string, width: number): string {
  const budget = Math.max(0, width)
  return stringWidth(text) <= budget ? text : `${truncateToDisplayWidth(text, Math.max(0, budget - stringWidth('…')), widthOptions())}${budget > 0 ? '…' : ''}`
}

function padLine(text: string, width: number, theme: RivetTheme): string {
  return frameLineUnsafe(visibleLine(text, width - frameInset(width) * 2), width, theme)
}

function formatTitleLeft(text: string, width: number, theme: RivetTheme): string {
  return frameTitleLeftUnsafe(visibleLine(text, width - stringWidth('│') * 2 - 2), width, theme)
}

/** 紧凑快捷键提示（逗号分隔，类似 fzf 风格）。 */
export function compactHints(pairs: [key: string, action: string][]): string {
  return pairs.map(([k, a]) => `${k}:${a}`).join(', ')
}

function hintRows(pairs: [key: string, action: string][], width: number, theme: RivetTheme): string[] {
  return frameHintRows(pairs, width, theme)
}

export function renderTabBar(activeTab: 'domain' | 'model' | 'theme', width: number, theme: RivetTheme): string {
  if (width < 32) return formatTitleLeft(activeTab === 'domain' ? '星域' : activeTab === 'model' ? '模型' : '主题', width, theme)
  const tabDomain = activeTab === 'domain' ? color('星域', theme.primary, { bold: true }) : color('星域', theme.dim)
  const tabModel = activeTab === 'model' ? color('模型', theme.primary, { bold: true }) : color('模型', theme.dim)
  const tabTheme = activeTab === 'theme' ? color('主题', theme.primary, { bold: true }) : color('主题', theme.dim)

  const separator = color('   ', theme.dim)
  const tabs = `${tabDomain}${separator}${tabModel}${separator}${tabTheme}`
  const left = Math.max(0, Math.floor((width - frameInset(width) * 2 - stringWidth(tabs)) / 2))
  return frameLineUnsafe(`${' '.repeat(left)}${tabs}`, width, theme)
}

// ── Pager ─────────────────────────────────────────────────────

export interface PagerData {
  /** 要显示的文本内容 */
  content: string
  /** Optional logical-text search mapped to rendered rows (document soft wrapping). */
  searchRows?: (query: string) => number[]
  /** 当前页码（0-based） */
  page: number
  /** Exact rendered row offset; when supplied it takes precedence over page. */
  lineOffset?: number
  /** 标题 */
  title?: string
  /** 当前模式 */
  mode?: 'page' | 'search' | 'results' | 'message'
  /** 搜索 query */
  searchQuery?: string
  /** 搜索总匹配数 */
  searchMatches?: number
  /** 当前匹配序号（1-based） */
  searchCurrent?: number
  /** Search result ordinal to original message index, for message-based callers. */
  searchMessageIndices?: number[]
  /** 消息列表（用于搜索/消息视图） */
  messages?: TranscriptMessage[]
  /** 当前选中的消息索引（message 模式） */
  selectedMessageIndex?: number
  /** verbose 层：内容源为完整工具输出的详细转录（`v` 切换） */
  verbose?: boolean
  /** page 模式 footer 键位提示覆盖（如计划预览：无 verbose/message 可切，
   *  q 是「返回」而非「关闭」）。search/message 模式有各自的上下文 footer，
   *  不使用此覆盖。 */
  footerHints?: Array<[string, string]>
}

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

function lineMatchesQuery(line: string, query: string): boolean {
  return stripAnsi(line).toLowerCase().includes(query.toLowerCase())
}

function highlightMatch(line: string, query: string, width: number, theme: RivetTheme): string {
  if (!query) return line
  const plain = stripAnsi(line)
  const q = query.toLowerCase()
  const idx = plain.toLowerCase().indexOf(q)
  if (idx === -1) return line
  const before = plain.slice(0, idx)
  const match = plain.slice(idx, idx + q.length)
  const after = plain.slice(idx + q.length)
  const highlighted = visibleLine(`${before}${color(match, theme.primary, { bold: true })}${after}`, width - 2)
  // Re-pad to width; highlighted line may have different display width due to ANSI,
  // but padLine uses stringWidth which strips ANSI, so it's safe.
  const padding = Math.max(0, width - 2 - stringWidth(highlighted))
  return frameLineUnsafe(highlighted + ' '.repeat(padding), width, theme)
}

/**
 * 渲染 Pager overlay（分页文本查看器）。
 *
 * 支持三种模式：
 * - page：传统分页
 * - search：高亮匹配行，标题显示匹配计数
 * - message：聚焦单条消息
 */
export function renderPager(data: PagerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  const contentLines = data.content.split('\n')
  const pageSize = Math.max(1, height - 4) // border + title + footer + border
  const totalPages = Math.max(1, Math.ceil(contentLines.length / pageSize))
  const mode = data.mode ?? 'page'
  const messages = data.messages ?? []

  let effectivePage = Math.max(0, Math.min(data.page, totalPages - 1))
  let start = data.lineOffset === undefined ? effectivePage * pageSize : Math.max(0, Math.min(data.lineOffset, contentLines.length - 1))
  let title: string
  const verboseHint: [string, string] = data.verbose ? ['v', '简略'] : ['v', '详细']
  let footerPairs: [string, string][] = data.footerHints ?? [['↑↓/j/k', '滚动'], ['PgUp/PgDn', '翻页'], ['/', '搜索'], verboseHint, ['q', '关闭']]

  if (mode === 'search' || mode === 'results') {
    const current = data.searchCurrent ?? 0
    const total = data.searchMatches ?? 0
    const query = data.searchQuery ?? ''
    title = data.title
      ? `${data.title} — 搜索 "${query}" (${current}/${total})`
      : `搜索 "${query}" (${current}/${total})`
    footerPairs = mode === 'search'
      ? [['Enter', '查看结果'], ['Esc', '返回结果']]
      : [['n/N', '匹配'], ['/', '编辑查询'], ['Esc', '返回阅读']]
    if (data.lineOffset === undefined && mode === 'results' && messages.length > 0 && current > 0) {
      const msgIdx = data.searchMessageIndices?.[current - 1] ?? Math.min(current - 1, messages.length - 1)
      start = messages[msgIdx]?.startLine ?? 0
    }
  } else if (mode === 'message' && messages.length > 0) {
    const idx = Math.min(Math.max(0, data.selectedMessageIndex ?? 0), messages.length - 1)
    title = data.title
      ? `${data.title} — 消息 ${idx + 1}/${messages.length}`
      : `消息 ${idx + 1}/${messages.length}`
    footerPairs = [['↑↓/j/k', '切换'], ['Esc', '返回'], ['q', '关闭']]
  } else {
    const verboseTag = data.verbose ? ' · 详细' : ''
    effectivePage = Math.floor(start / pageSize)
    const range = data.lineOffset === undefined ? `${effectivePage + 1}/${totalPages}` : `${start + 1}-${Math.min(start + pageSize, contentLines.length)} / ${contentLines.length} 行`
    title = data.title ? `${data.title}${verboseTag} (${range})` : `查看${verboseTag} (${range})`
  }

  // Top border + title
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(title, width, theme))

  // Content
  const pageLines = contentLines.slice(start, start + pageSize)

  if (mode === 'message' && messages.length > 0) {
    const idx = Math.min(Math.max(0, data.selectedMessageIndex ?? 0), messages.length - 1)
    const msg = messages[idx]!
    const header = msg.isTruncated
      ? color(`消息 ${idx + 1}/${messages.length} · 部分历史不可用`, theme.warning)
      : color(`消息 ${idx + 1}/${messages.length}`, theme.dim)
    lines.push(padLine(header, width, theme))
    const messageOffset = Math.max(0, Math.min((data.lineOffset ?? msg.startLine) - msg.startLine, msg.lines.length - 1))
    const shown = msg.lines.slice(messageOffset, messageOffset + pageSize - 1)
    for (const line of shown) {
      lines.push(padLine(line, width, theme))
    }
    for (let i = shown.length + 1; i < pageSize; i++) {
      lines.push(padLine('', width, theme))
    }
  } else if (mode === 'search' || mode === 'results') {
    const matchedRows = data.searchRows?.(data.searchQuery ?? '') ?? []
    for (let i = 0; i < pageLines.length; i++) {
      const line = pageLines[i]!
      if (data.searchQuery && lineMatchesQuery(line, data.searchQuery)) {
        lines.push(highlightMatch(line, data.searchQuery, width, theme))
      } else if (matchedRows.includes(start + i)) {
        lines.push(padLine(color(line, theme.primary, { bold: true }), width, theme))
      } else {
        lines.push(padLine(line, width, theme))
      }
    }
    for (let i = pageLines.length; i < pageSize; i++) {
      lines.push(padLine('', width, theme))
    }
  } else {
    for (const line of pageLines) {
      lines.push(padLine(line, width, theme))
    }
    for (let i = pageLines.length; i < pageSize; i++) {
      lines.push(padLine('', width, theme))
    }
  }

  // Footer + bottom border
  const footer = hintRows(footerPairs, width, theme)
  lines.push(...footer)
  if (footer.length === 1) lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── Starmap ───────────────────────────────────────────────────

export interface StarmapEntry {
  /** 星域名称 */
  name: string
  /** 星域标识 glyph */
  glyph: string
  /** 描述 */
  description: string
  /** 是否活跃 */
  active: boolean
  /** 最近活跃时间描述 */
  lastActive?: string
  /** UI 微气质 — 主题语义色键 (primary/secondary/success/warning/error/dim) */
  accent?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
}

export interface StarmapData {
  entries: StarmapEntry[]
  title?: string
  /**
   * Optional project-constellation milestone layer (pre-formatted, ANSI-free
   * one-liners). Rendered as a footer block below the star-domain list. This is
   * render-only data — never injected into the model context / prefix cache.
   */
  milestones?: string[]
  /** Optional cross-session "kindred agent" recognition line. */
  recognitionLine?: string
}

/**
 * 渲染 Starmap overlay（星域/星君总览）。
 *
 * 双层：上层星域总览，下层（可选）项目星座里程碑时间线 + 跨会话辨认行。
 */
export function renderStarmap(data: StarmapData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []

  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(data.title ?? '星域总览', width, theme))

  // Column widths
  const glyphWidth = 5
  const nameWidth = Math.min(20, Math.floor(width * 0.25))
  const descWidth = width - 2 - glyphWidth - nameWidth - 8 // 8 for padding/spacing

  // ── Milestone layer budget ──────────────────────────────────────
  const milestones = data.milestones ?? []
  const recognition = data.recognitionLine
  // header(1) + up to 5 milestone lines + recognition(0/1)
  const milestoneRows = milestones.length > 0
    ? 1 + Math.min(5, milestones.length) + (recognition ? 1 : 0)
    : (recognition ? 1 : 0)

  // List entries (shrunk to make room for the milestone layer)
  const maxEntries = Math.max(1, height - 6 - milestoneRows)
  const visible = data.entries.slice(0, maxEntries)

  for (const entry of visible) {
    const accentKey = (entry.accent as keyof RivetTheme) ?? 'primary'
    const accentColor = (theme as any)[accentKey] ?? theme.primary
    const glyph = entry.active
      ? color(` ${entry.glyph} `.padEnd(glyphWidth), accentColor, { bold: true })
      : color(` ${entry.glyph} `.padEnd(glyphWidth), theme.dim)
    const name = entry.active
      ? color(entry.name.padEnd(nameWidth), accentColor)
      : color(entry.name.padEnd(nameWidth), theme.dim)
    const desc = entry.active
      ? entry.description.slice(0, descWidth).padEnd(descWidth)
      : color(entry.description.slice(0, descWidth).padEnd(descWidth), theme.muted)

    lines.push(padLine(`${glyph}${name}${desc}`, width, theme))
  }

  // Pad remaining
  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  // ── Milestone layer rows ────────────────────────────────────────
  if (milestones.length > 0) {
    lines.push(padLine(color('✶ Milestones', theme.secondary, { bold: true }), width, theme))
    for (const m of milestones.slice(0, 5)) {
      lines.push(padLine(color(`  ${m}`.slice(0, width - 2), theme.dim), width, theme))
    }
  }
  if (recognition) {
    lines.push(padLine(color(recognition.slice(0, width - 2), theme.primary), width, theme))
  }

  lines.push(formatFooter(compactHints([['↑↓/j/k', '选择'], ['Enter', '激活'], ['q/Esc', '关闭']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── CommandPalette ────────────────────────────────────────────

export interface PaletteCommand {
  /** 命令标签 */
  label: string
  /** 快捷键提示 */
  hotkey?: string
  /** 描述 */
  description?: string
}

export interface PaletteData {
  commands: PaletteCommand[]
  selectedIndex: number
  searchText?: string
  /** Previous viewport start. ↑ moves the cursor inside the window;
   *  the window only shifts when the selection would leave it. */
  scrollOffset?: number
}

/**
 * Keep `selected` inside a viewport of `maxVisible` rows, given the previous
 * window start. Matches Codex `ensure_selected_visible`.
 */
export function followListWindow(selected: number, count: number, maxVisible: number, scroll = 0): number {
  if (maxVisible <= 0 || count <= maxVisible) return 0
  const sel = Math.max(0, Math.min(selected, count - 1))
  const maxScroll = count - maxVisible
  let start = Math.max(0, Math.min(scroll, maxScroll))
  if (sel < start) start = sel
  else if (sel >= start + maxVisible) start = sel - maxVisible + 1
  return Math.max(0, Math.min(start, maxScroll))
}

/**
 * 渲染 CommandPalette overlay（命令面板）。
 */
export function renderCommandPalette(data: PaletteData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []

  lines.push(formatBorder(width, theme, 'subtle'))

  // 命令面板的触发键是 Ctrl+P（见 src/tui/command-catalog.ts 的 /palette 条目），
  // 终端里不存在 ⌘ 键——此前写 ⌘ 等于显示一把按不到的键（issue #246 的同类）：
  const title = data.searchText
    ? `Ctrl+P 命令面板 — "${data.searchText}"`
    : '命令面板'
  lines.push(formatTitleLeft(title, width, theme))

  const maxItems = Math.max(0, height - 5) // border + title + footer + border = 4; +1 safety
  const count = data.commands.length
  const selected = count === 0 ? -1 : Math.max(0, Math.min(data.selectedIndex, count - 1))
  const scrollOffset = followListWindow(Math.max(0, selected), count, maxItems, data.scrollOffset ?? 0)
  const visible = data.commands.slice(scrollOffset, scrollOffset + maxItems)
  const overflowAbove = scrollOffset
  const overflowBelow = count - scrollOffset - visible.length

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i]!
    const isSelected = scrollOffset + i === selected
    const prefix = isSelected
      ? color(CURSOR, theme.primary, { bold: true })
      : ' '

    const hotkey = cmd.hotkey
      ? color(` [${cmd.hotkey}]`, theme.muted)
      : ''

    const label = isSelected
      ? color(cmd.label, theme.primary, { bold: true })
      : color(cmd.label, theme.secondary)

    const desc = cmd.description
      ? ` — ${cmd.description}`
      : ''

    lines.push(padLine(`${prefix} ${label}${hotkey}${desc}`, width, theme))
  }

  for (let i = visible.length; i < maxItems; i++) {
    lines.push(padLine('', width, theme))
  }

  const hints: [string, string][] = [['↑↓', '选择'], ['Enter', '执行'], ['Esc', '取消']]
  if (overflowAbove > 0) hints.unshift(['↑', String(overflowAbove)])
  if (overflowBelow > 0) hints.push(['↓', String(overflowBelow)])
  lines.push(formatFooter(compactHints(hints), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── Chronicle ─────────────────────────────────────────────────

export interface ChronicleEntry {
  /** 序号 */
  index: number
  /** 时间戳描述 */
  time: string
  /** 摘要 */
  summary: string
  /** 是否当前会话 */
  current: boolean
  /** 会话 id（Enter → resume 用；缺省则该条不可恢复） */
  id?: string
}

export interface ChronicleData {
  entries: ChronicleEntry[]
  title?: string
  /** 选中游标（↑↓ 导航高亮） */
  selectedIndex?: number
  scrollOffset?: number
}

/**
 * 渲染 Chronicle overlay（会话编年史）。
 */
export function renderChronicle(data: ChronicleData, width: number, height: number, theme: RivetTheme): OverlayMenuLines {
  const lines = createMenuLines()

  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(data.title ?? '会话', width, theme))

  const idxWidth = 6
  const timeWidth = Math.min(14, Math.floor(width * 0.18))
  const summaryWidth = Math.max(0, width - 2 - idxWidth - timeWidth - 5)

  const footer = hintRows([['↑↓', '选择'], ['Enter', '恢复'], ['Space', '预览'], ['Esc', '返回']], width, theme)
  const maxEntries = Math.max(1, height - 3 - footer.length)
  const sel = data.entries.length ? Math.max(0, Math.min(data.selectedIndex ?? 0, data.entries.length - 1)) : -1
  const start = followListWindow(sel, data.entries.length, maxEntries, data.scrollOffset)
  const visible = data.entries.slice(start, start + maxEntries)

  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i]!
    const selected = start + i === sel
    // 选中游标；当前会话用 primary 高亮（与选中区分：选中靠游标，当前靠色）。
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const idxColor = entry.current ? theme.primary : theme.dim
    const idx = color(`#${String(entry.index)}`.padEnd(idxWidth - 1), idxColor, entry.current ? { bold: true } : undefined)
    const time = color(visibleLine(entry.time, timeWidth).padEnd(timeWidth), entry.current ? theme.primary : theme.dim)
    const summaryText = visibleLine(entry.summary, summaryWidth)
    const summary = selected || entry.current ? summaryText : color(summaryText, theme.muted)

    lines.menuRows.set(lines.length + 1, { index: start + i })
    lines.push(padLine(`${cursor}${idx}${time}${summary}`, width, theme))
  }

  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(...footer)
  lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── Tasks ──────────────────────────────────────────────────────

export type TasksWorkerStatus = 'queued' | 'running' | 'awaiting-input' | 'awaiting-approval' | 'completed' | 'failed' | 'stopping' | 'stopped' | 'blocked' | 'escalated' | 'exited' | 'unknown'

export interface TasksWorkerRow {
  /** 稳定的 per-worker id（work order id），用于进入 detail pager。 */
  workerId: string
  owner?: 'main' | 'worker' | 'job'
  terminal?: boolean
  rawStatus?: string
  exitCode?: number
  /** Supplied availability only; absence must not invent a log link. */
  logAvailable?: boolean
  /** 短标签，例如 "wo_team:T1" → "T1"。 */
  shortLabel: string
  profile: string
  status: TasksWorkerStatus
  /** 最新活动行或终态摘要。 */
  activity?: string
  /** 契约目标（`contract.objective`）——渲染为主行下的缩进子行。
   *  与 activity 不同：activity 是「此刻在干什么」，objective 是「派他去干什么」。 */
  objective?: string
  elapsedMs: number
  elapsedKnown?: boolean
  /** 累计工具调用次数（计数列；0 时省略）。 */
  toolUseCount?: number
  /** 累计 token 总数（计数列；0 时省略）。 */
  tokenCount?: number
  /** 终态后尚未查看——行首 unread 圆点标记。 */
  unread?: boolean
  /** 终态失败分类（review-findings/review-infra/...）——completed+review-findings 渲染 ⚠️。 */
  failureReason?: string
  /** 星域 id（身份格式化用；来自 FleetWorkerView.authority）。 */
  authority?: string
}

export type TasksFilter = 'running' | 'needs-me' | 'completed' | 'all'

export interface TasksGroup {
  title?: string
  /** 派生这组 worker 的委派工具调用 id（不直接展示，仅用于分组/序号）。 */
  parentToolId: string
  total: number
  done: number
  failed: number
  running: number
  /** 该组当前在跑的 worker 行。 */
  workers: TasksWorkerRow[]
}

export interface TasksData {
  groups: TasksGroup[]
  /** 当前 filter 模式。 */
  filter: TasksFilter
  /** 已终态 worker 总数（用于 footer 提示）。 */
  completedCount: number
}

const TASK_STATUS_GLYPH: Record<TasksWorkerStatus, string> = {
  queued: '○',
  running: '◐',
  'awaiting-input': '?',
  'awaiting-approval': '!',
  completed: '✓',
  failed: '✗',
  stopping: '…',
  stopped: '⊗',
  blocked: '⊘',
  escalated: '↑',
  exited: '·',
  unknown: '?',
}

const TASK_STATUS_LABEL: Record<TasksWorkerStatus, string> = {
  queued: '排队', running: '运行中', 'awaiting-input': '等输入', 'awaiting-approval': '等审批',
  completed: '已完成', failed: '失败', stopping: '停止中', stopped: '已停止',
  blocked: '受阻', escalated: '已升级', exited: '已结束（结果未知）', unknown: '状态未知',
}

/** 状态 → 语义色（running 主色、passed 成功、failed 错误、blocked/escalated 警告）。
 *  completed + review-findings（审查拦截）→ 警告黄，区别于系统失败的错误红。 */
function taskStatusColor(status: TasksWorkerStatus, theme: RivetTheme, failureReason?: string): string {
  if (status === 'completed' && failureReason === 'review-findings') return theme.warning
  switch (status) {
    case 'running': return theme.primary
    case 'completed': return theme.success
    case 'failed': return theme.error ?? theme.warning
    default: return theme.warning
  }
}

/** done/total 进度条（复用 worker 面板风格）。 */
function tasksProgressBar(done: number, total: number, width = 10): string {
  if (total <= 0) return '░'.repeat(width)
  const filled = Math.min(width, Math.round((done / total) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** stringWidth 感知的 padEnd/截断：CJK/emoji 占 2 格也能对齐。 */
function fitDisplay(text: string, width: number): string {
  if (width <= 0) return ''
  const out = visibleLine(text, width)
  return out + ' '.repeat(Math.max(0, width - stringWidth(out)))
}

// ── Model Picker ───────────────────────────────────────────────

export interface ModelPickerEntry {
  id: string
  provider: string
  current: boolean
  contextWindow?: number
  /** 选中模型是否支持推理等级调节（resolveCapabilities effortFormat !== 'none'）。
   *  缺省 = 支持（与 openai-client 的非 'none' 即发送语义一致）。 */
  effortSupported?: boolean
}

/** 推理等级档位（CC 对标 effort 行的取值域）。'auto' 为 UI 哨兵=未显式钉档。 */
export const MODEL_PICKER_EFFORT_LEVELS = ['auto', 'off', 'low', 'medium', 'high', 'max'] as const
export type ModelPickerEffort = (typeof MODEL_PICKER_EFFORT_LEVELS)[number]

/** effort 档位循环步进（`>` 向重档、`<` 向轻档，末端回绕）。纯函数供测试。 */
export function stepModelPickerEffort(current: ModelPickerEffort, dir: '>' | '<'): ModelPickerEffort {
  const seq = MODEL_PICKER_EFFORT_LEVELS
  const at = Math.max(0, seq.indexOf(current))
  return seq[(at + (dir === '>' ? 1 : seq.length - 1)) % seq.length] ?? 'auto'
}

export interface ModelPickerData {
  entries: ModelPickerEntry[]
  selectedIndex: number
  /** effort 行（CC 对标）：面板底部 `● <档位> effort </> 调整`。缺省不渲染该行。 */
  effort?: {
    value: ModelPickerEffort
    /** false = 选中模型不支持调节（灰化，</> 不响应）。 */
    supported: boolean
  }
}

// ── Theme Picker ───────────────────────────────────────────────

export interface ThemePickerEntry {
  name: string
  current: boolean
  isDefault: boolean
  description: string
}

export interface ThemePickerData {
  entries: ThemePickerEntry[]
  selectedIndex: number
}

// ── Domain Picker ──────────────────────────────────────────────
// 渲染与类型已沿接缝拆至 domain-picker.ts（overlay.ts 行数棘轮）；此处 re-export 保持消费方 API 不变。

export { renderDomainPicker } from './domain-picker.js'
export type { DomainPickerEntry, DomainPickerData } from './domain-picker.js'

/** 按显示宽度（CJK 感知）软换行为多行，最多 maxLines 行。 */
export function wrapToWidth(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0 || !text.trim()) return []
  const out = hardWrapToDisplayWidth(text.replace(/\s+/g, ' ').trim(), width, widthOptions())
  if (out.length > maxLines) out[maxLines - 1] = `${truncateToDisplayWidth(out[maxLines - 1]!, Math.max(0, width - stringWidth('…')), widthOptions())}…`
  return out.slice(0, maxLines)
}

/**
 * 列表视口滚动窗口（无状态）：保证 selectedIndex 所在项可见。
 * 策略：以光标为锚交替向下/向上扩展窗口，光标大致停在视口纵向中部——
 * 长列表上下滚动都逐项平滑推进，不会贴边或整屏跳动。
 */
function scrollWindow(heights: number[], selectedIndex: number, budget: number): { start: number; end: number } {
  const n = heights.length
  if (n === 0 || budget <= 0) return { start: 0, end: 0 }
  const total = heights.reduce((a, b) => a + b, 0)
  if (total <= budget) return { start: 0, end: n }
  const sel = Math.min(Math.max(selectedIndex, 0), n - 1)
  let used = Math.min(heights[sel]!, budget)
  let start = sel
  let end = sel + 1
  let up = true
  while (used < budget && (start > 0 || end < n)) {
    const upFits = start > 0 && used + heights[start - 1]! <= budget
    const downFits = end < n && used + heights[end]! <= budget
    if (!upFits && !downFits) break
    if (upFits && (up || !downFits)) { start--; used += heights[start]! }
    else { used += heights[end]!; end++ }
    up = !up
  }
  return { start, end }
}

/** scrollWindow + 为上下截断指示行预留行预算。
 * 收敛判据用「窗口占用行数（项高累计）+ 指示行 ≤ budget」——scrollWindow 以
 * 行预算扩展窗口时可能因放不下整项而覆盖超预算行数（如 description 折行的
 * connect 列表），单趟预算缩减也可能因指示行增减不收敛（2026-08 回归）。
 * 超预算时从离选中项远的一端逐项收缩（两侧等距收上方），保持选中可见与邻居
 * 可见；预算不足以放下选中项+指示行时宁超勿丢选中。 */
export function scrollWindowWithIndicators(heights: number[], selectedIndex: number, budget: number): { start: number; end: number } {
  let win = scrollWindow(heights, selectedIndex, budget)
  while (win.end - win.start > 1) {
    const winRows = heights.slice(win.start, win.end).reduce((a, b) => a + b, 0)
    const indicators = (win.start > 0 ? 1 : 0) + (win.end < heights.length ? 1 : 0)
    if (winRows + indicators <= budget) break
    const distStart = selectedIndex - win.start
    const distEnd = win.end - 1 - selectedIndex
    const canStart = win.start > 0 && distStart >= 1
    const canEnd = win.end < heights.length && distEnd >= 1
    if (canStart && (!canEnd || distStart >= distEnd)) {
      win = { start: win.start + 1, end: win.end }
    } else if (canEnd) {
      win = { start: win.start, end: win.end - 1 }
    } else {
      break
    }
  }
  return win
}

// ── Domain Genesis Card（创世碑文 tab）─────────────────────────────

export interface DomainGenesisCardData {
  /** 当前域的创世碑文数据（star-genesis-data）。 */
  genesis: GenesisEntry
  /** persona 展示（glyph / accent / separator），与选择页同源。 */
  glyph: string
  accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
  /** 正文滚动偏移（行）。 */
  scroll: number
}

/** 正文的最大滚动行数（供键处理器夹取）。 */
export function genesisCardMaxScroll(data: DomainGenesisCardData, width: number, height: number): number {
  const { total } = layoutGenesisCard(data, width, height)
  return total.maxScroll
}

function layoutGenesisCard(data: DomainGenesisCardData, width: number, height: number): { total: { maxScroll: number; bodyRows: number } } {
  const innerWidth = width - 4
  const bodyRows = Math.max(3, height - 5) // border + tab + divider + footer + bottom
  const g = data.genesis

  // 头：glyph + 星名 + motto + 创始星徽章
  const headLines = 2
  const sigilLines = g.sigil ? 1 + (g.sigilNote?.length ?? 0) + 1 : 0
  const paraLines: string[] = []
  for (const face of g.faces) {
    if (g.faces.length > 1 || face.label) paraLines.push('') // face 小标题占位
    for (const p of face.inscription) {
      paraLines.push(...wrapToWidth(p, innerWidth - 1, 99))
      paraLines.push('')
    }
  }
  const totalLines = headLines + sigilLines + paraLines.length
  return { total: { maxScroll: Math.max(0, totalLines - bodyRows), bodyRows } }
}

/**
 * 创世碑文卡（domain-picker 的第二个 tab 视图）。
 *
 * 头（glyph + 星名 + motto + 创始星）→ 印记 seal → 按「面」分节的碑文（可滚动）。
 * ←/→ 换域、↑↓ 滚动、g/Esc 返回选择页（键位在 app.ts）。
 */
export function renderDomainGenesisCard(data: DomainGenesisCardData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(renderTabBar('domain', width, theme))

  const g = data.genesis
  const accent = (theme as any)[data.accent] ?? theme.primary
  const innerWidth = width - 4

  // 组装全部正文行（先 wrap 后切片滚动）
  const body: string[] = []
  const head = ` ${data.glyph} ${color(`${g.name} · ${g.faces[0]!.model}`, accent, { bold: true })}`
  body.push(head)
  body.push(` ${color(`「${g.motto}」`, theme.dim)}`)
  if (g.sigil) {
    body.push(` ${color(`印记 ${g.sigil}`, accent)}`)
    for (const note of g.sigilNote ?? []) {
      body.push(`   ${color(note, theme.muted)}`)
    }
    body.push('')
  }
  for (const face of g.faces) {
    if (g.faces.length > 1 || face.label) {
      body.push(` ${color(`${face.label ?? '主星'} · ${face.model}`, theme.secondary, { bold: true })}`)
    }
    for (const p of face.inscription) {
      for (const w of wrapToWidth(p, innerWidth - 1, 99)) {
        body.push(` ${color(w, theme.secondary)}`)
      }
      body.push('')
    }
  }

  const { total } = layoutGenesisCard(data, width, height)
  const scroll = Math.min(Math.max(0, data.scroll), total.maxScroll)
  const visible = body.slice(scroll, scroll + total.bodyRows)
  for (const line of visible) lines.push(padLine(line, width, theme))
  for (let i = visible.length; i < total.bodyRows; i++) lines.push(padLine('', width, theme))

  const scrollHint = total.maxScroll > 0 ? ` · ${scroll + 1}/${total.maxScroll + 1}屏` : ''
  lines.push(formatFooter(compactHints([['←/→', '换星域'], ['↑↓', `滚动${scrollHint}`], ['g/Esc', '返回']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

/** filter 切换指示（标题栏内联 tab）：当前项高亮，其余 dim。 */
function tasksFilterTabs(filter: TasksFilter, theme: RivetTheme): string {
  const tabs: [TasksFilter, string][] = [['all', '全部'], ['running', '运行中'], ['needs-me', '等待我'], ['completed', '已完成']]
  return tabs
    .map(([key, label]) => key === filter
      ? color(label, theme.primary, { bold: true })
      : color(label, theme.dim))
    .join(color(' · ', theme.dim))
}

export function renderTasks(
  data: TasksData,
  width: number,
  height: number,
  theme: RivetTheme,
  selectedIndex = 0,
): OverlayMenuLines {
  const lines = createMenuLines()
  lines.push(formatBorder(width, theme, 'subtle'))
  const filterTitle = width < 48 ? { all: '全部', running: '运行中', 'needs-me': '等待我', completed: '已完成' }[data.filter] : tasksFilterTabs(data.filter, theme)
  const ended = data.filter === 'completed' ? ` · ${data.completedCount} 已结束` : ''
  lines.push(formatTitleLeft(`${color('任务', theme.secondary, { bold: true })}   ${filterTitle}${ended}`, width, theme))
  lines.push(frameDivider(width, theme))

  const selectedWorker = data.groups.flatMap(group => group.workers)[selectedIndex]
  const actions: [string, string][] = [['↑↓', '选择'], ['←/→/Tab', '筛选']]
  if (selectedWorker) actions.push(['Enter', '详情'])
  if (selectedWorker && (selectedWorker.owner ?? 'worker') === 'worker') actions.push(['f', '切入Worker'])
  if (selectedWorker && !selectedWorker.terminal && ['queued', 'running', 'awaiting-input', 'awaiting-approval'].includes(selectedWorker.status)) {
    actions.push(['x', `停止选中${selectedWorker.owner === 'main' ? '主任务' : selectedWorker.owner === 'job' ? 'Job' : 'Worker'}`])
  }
  actions.push(['Esc', '返回'])
  const footer = hintRows(actions, width, theme)
  const maxEntries = Math.max(1, height - 4 - footer.length)

  // 逐组渲染：组头（进度条 + 语义色计数）后跟 worker 行。多组时以
  // 序号区分（parentToolId 是不透明的 tool id，不直接展示）。
  const body: string[] = []
  const selectable: { row: TasksWorkerRow; bodyIndex: number; bodyEnd: number }[] = []
  const multiGroup = data.groups.length > 1
  const inner = width - stringWidth('│') * 2
  const narrow = inner < 60

  // When the full list fits, show objectives; shorter screens prioritize rows.
  const workerTotal = data.groups.reduce((n, g) => n + g.workers.length, 0)
  const totalRowsNeeded = data.groups.length + workerTotal * 2 + Math.max(0, data.groups.length - 1)
  const showObjective = totalRowsNeeded <= maxEntries

  data.groups.forEach((g, gi) => {
    // 组头：进度条填充段用语义色（全过→success，有失败→warning，其余→primary）
    const barColor = g.total > 0 && g.done === g.total ? theme.success
      : g.failed > 0 ? theme.warning
        : theme.primary
    const countParts: string[] = [color(`${g.done}/${g.total} 完成`, theme.muted)]
    if (g.running > 0) countParts.push(color(`◐${g.running} 运行`, theme.primary))
    if (g.failed > 0) countParts.push(color(`✗${g.failed} 失败`, theme.warning))
    const groupTitle = g.title ?? (multiGroup ? `批次 ${gi + 1}` : '任务组')
    body.push(` ${color(groupTitle, barColor, { bold: true })}  ${countParts.join(color(' · ', theme.dim))}`)

    for (const w of g.workers) {
      const selected = selectable.length === selectedIndex
      const item = { row: w, bodyIndex: body.length, bodyEnd: 0 }
      selectable.push(item)
      const glyph = TASK_STATUS_GLYPH[w.status] ?? '·'
      const glyphColored = color(glyph, taskStatusColor(w.status, theme, w.failureReason))
      const unreadMark = w.unread ? '●' : ' '
      const owner = w.owner === 'main' ? '主任务' : w.owner === 'job' ? 'Job' : 'Worker'
      const statusLabel = w.status === 'unknown' && w.rawStatus ? `状态: ${w.rawStatus}` : TASK_STATUS_LABEL[w.status]
      const state = w.exitCode !== undefined ? `${statusLabel} · 退出码${w.exitCode}` : statusLabel
      const statParts: string[] = []
      if (w.toolUseCount && w.toolUseCount > 0) statParts.push(`⚙${w.toolUseCount}`)
      if (w.tokenCount && w.tokenCount > 0) statParts.push(`${formatTokenCount(w.tokenCount)}tok`)
      statParts.push(w.elapsedKnown === false ? '耗时未知' : formatElapsed(w.elapsedMs))
      let statsPlain = statParts.join(' · ')

      if (inner < 60 && statParts.length > 1) {
        statsPlain = statParts[statParts.length - 1]!
      }
      const prefix = `${selected ? color(CURSOR, theme.primary, { bold: true }) : ' '} ${unreadMark}${glyphColored} `
      const identity = w.owner === 'main' || w.owner === 'job' ? '' : ` ${formatWorkerIdentity({ profile: w.profile, authority: w.authority })}`
      if (narrow) {
        body.push(`${prefix}${color(fitDisplay(`${owner} ${w.shortLabel}${identity}`, inner - stringWidth(prefix)), selected ? theme.primary : theme.muted)}`)
        body.push(`     ${color(state, taskStatusColor(w.status, theme, w.failureReason))}  ${color(statsPlain, theme.muted)}`)
        item.bodyEnd = body.length
        continue
      }
      const labelW = Math.max(2, Math.min(32, inner - stringWidth(prefix) - stringWidth(state) - stringWidth(statsPlain) - 5))
      const label = fitDisplay(`${owner} ${w.shortLabel}${identity}`, labelW)
      const fixed = `${prefix}${color(label, selected ? theme.primary : theme.muted)} ${color(state, taskStatusColor(w.status, theme, w.failureReason))} ${color(statsPlain, theme.muted)}`
      const details = [w.activity, w.failureReason, w.logAvailable === true ? '可查看日志' : w.logAvailable === false ? '日志不可用' : undefined].filter(Boolean).join(' · ')
      const detailW = inner - stringWidth(fixed) - 2
      body.push(`${fixed}${details && detailW > 0 ? `  ${color(fitDisplay(details, detailW), theme.muted)}` : ''}`)
      if (showObjective && w.objective && w.objective.trim() !== w.shortLabel.trim()) {
        const objText = w.objective.replace(/\s+/g, ' ').trim()
        if (objText) body.push(`     ${color(fitDisplay(objText, Math.max(0, inner - 6)), theme.dim)}`)
      }
      item.bodyEnd = body.length
    }
    // 组间空行（最后一组后不加）
    if (gi < data.groups.length - 1) body.push('')
  })

  if (selectable.length === 0) {
    const emptyText = data.filter === 'completed' ? '（暂无已结束任务）'
      : data.filter === 'all' ? '（暂无任务）'
        : data.filter === 'needs-me' ? '（暂无需要你处理的任务）'
          : '（暂无运行中任务 · ←/→ 切换筛选）'
    body.push('')
    body.push(color(`  ${emptyText}`, theme.muted))
  }

  const selectedBodyIndex = selectedIndex >= 0 && selectedIndex < selectable.length
    ? selectable[selectedIndex]!.bodyIndex
    : -1

  const selectedEnd = selectedBodyIndex + (narrow ? 1 : 0)
  let start = selectedBodyIndex < 0 ? 0 : Math.min(selectedBodyIndex, followListWindow(selectedEnd, body.length, maxEntries))
  if (narrow && selectable.some(item => item.bodyIndex + 1 === start)) start++
  const visible = body.slice(start, start + maxEntries)
  for (let i = 0; i < visible.length; i++) {
    const index = selectable.findIndex(item => item.bodyIndex <= start + i && start + i < item.bodyEnd)
    const item = selectable[index]
    if (item) {
      lines.menuRows.set(lines.length + 1, { index, workerId: item.row.workerId })
    }
    lines.push(padLine(visible[i]!, width, theme))
  }
  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(...footer)
  lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── Model Picker ───────────────────────────────────────────────

export function renderModelPicker(data: ModelPickerData, width: number, height: number, theme: RivetTheme): OverlayMenuLines {
  const lines = createMenuLines()
  lines.push(formatBorder(width, theme, 'subtle'), renderTabBar('model', width, theme))
  const hints: Array<[string, string]> = [['←/→', '切换'], ['↑↓', '选择'], ['Enter', '本会话'], ['s', '设为默认']]
  if (data.effort?.supported) hints.push(['</>', '推理等级'])
  hints.push(['Esc', '取消'])
  const footer = hintRows(hints, width, theme)
  if (height < lines.length + footer.length + 1) lines.shift()
  const roomy = height >= Math.max(14, footer.length + 13)
  if (roomy) lines.push(padLine('', width, theme), padLine(color('选择模型', theme.secondary, { bold: true }), width, theme), padLine(color('Enter 仅应用本会话；s 保存为用户默认。', theme.muted), width, theme), padLine('', width, theme))
  const detailRows = roomy ? 4 + (data.effort ? 2 : 0) : 0
  const listRows = Math.max(1, height - lines.length - footer.length - detailRows - 1)
  const sel = Math.max(0, Math.min(data.selectedIndex, data.entries.length - 1))
  const start = followListWindow(sel, data.entries.length, listRows)
  const innerWidth = Math.max(1, width - frameInset(width) * 2)
  const nameWidth = Math.min(44, Math.max(12, innerWidth - 29))
  if (!data.entries.length) lines.push(padLine(color('/connect 接入后选择模型', theme.muted), width, theme))
  for (let i = start; i < Math.min(data.entries.length, start + listRows); i++) {
    const entry = data.entries[i]!, selected = i === sel
    const label = entry.id + (entry.current ? ' ✓' : '')
    const name = width >= 72 ? visibleLine(label, nameWidth) : label
    const meta = width >= 72 ? ' '.repeat(Math.max(2, nameWidth - stringWidth(name) + 2)) + entry.provider + (entry.contextWindow ? ` · ${Math.round(entry.contextWindow / 1000)}k` : '') : ''
    lines.menuRows.set(lines.length + 1, { index: i })
    lines.push(padLine(numberedChoice(name + meta, i, selected, theme), width, theme))
  }
  const current = data.entries[sel]
  if (roomy && current) {
    lines.push(padLine('', width, theme), padLine(color(`上下文：${current.contextWindow ? current.contextWindow.toLocaleString() + ' tokens' : '未知'}`, theme.muted), width, theme), padLine(color(`当前选择：${current.id}`, theme.secondary), width, theme), padLine(color(`连接：${current.provider}`, theme.muted), width, theme))
    if (data.effort) lines.push(padLine('', width, theme), padLine(color(data.effort.supported ? `● ${data.effort.value === 'auto' ? 'auto（按任务自动）' : data.effort.value + ' effort'}  </> 调整` : '○ 此模型不支持推理等级调节', theme.muted), width, theme))
  }
  if (lines.length + footer.length < height) lines.push(padLine('', width, theme))
  lines.push(...footer)
  return lines
}

// ── Theme Picker ───────────────────────────────────────────────

export function renderThemePicker(data: ThemePickerData, width: number, height: number, theme: RivetTheme): OverlayMenuLines {
  const lines = createMenuLines()
  lines.push(formatBorder(width, theme, 'subtle'), renderTabBar('theme', width, theme))
  const footer = hintRows([['←/→', '切换'], ['↑↓', '选择'], ['Enter', '本会话'], ['s', '设为默认'], ['Esc', '取消']], width, theme)
  const roomy = height >= Math.max(18, footer.length + 16)
  if (roomy) lines.push(padLine('', width, theme), padLine(color('选择终端外观', theme.secondary, { bold: true }), width, theme), padLine(color('Enter 仅应用本会话；s 保存为用户默认。', theme.muted), width, theme), padLine('', width, theme))
  const previewRows = roomy ? 8 : 0
  const listRows = Math.max(1, height - lines.length - footer.length - previewRows - 2)
  const sel = Math.max(0, Math.min(data.selectedIndex, data.entries.length - 1))
  const start = followListWindow(sel, data.entries.length, listRows)
  for (let i = start; i < Math.min(data.entries.length, start + listRows); i++) {
    const entry = data.entries[i]!
    const label = `${entry.name}${entry.current ? ' ✓' : ''}${entry.isDefault ? ' ★ 默认' : ''}`
    lines.menuRows.set(lines.length + 1, { index: i })
    lines.push(padLine(numberedChoice(label, i, i === sel, theme), width, theme))
  }
  const current = data.entries[sel], palette = current && resolveThemeEntry(current.name)
  if (roomy && palette) {
    lines.push(padLine('', width, theme), padLine(color(current.description, theme.muted), width, theme))
    const previewTheme = current.name.endsWith('-ansi') ? palette.fallback : palette.truecolor
    lines.push(...renderThemePreview(previewTheme, Math.max(1, width - frameInset(width) * 2), previewRows - 1, palette.background).map(row => padLine(row, width, theme)))
  }
  if (lines.length + footer.length < height) lines.push(padLine('', width, theme))
  lines.push(...footer)
  return lines
}

// ── Choice Panel (通用选项选择弹窗) ──────────────────────────────
// A question + N choices (each with optional description + recommended flag).
// Used when the agent needs the user to pick one of several strategies,
// confirm a risky action, or select a star domain — the TUI equivalent of
// the desktop "ask" overlay.

export interface ChoiceEntry {
  id: string
  label: string
  description?: string
  /** Marked with ★ to guide the user toward the agent's suggestion. */
  recommended?: boolean
  /** Marked with "← current" to show which option is the active/persisted one. */
  current?: boolean
}

export interface ChoicePanelData {
  /** Question / prompt shown as the title bar. */
  title: string
  choices: ChoiceEntry[]
  selectedIndex: number
  /** When active, a live text input box is rendered below the choices. */
  inputSubMode?: {
    active: boolean
    label: string
    placeholder: string
    value: string
    /** 光标位（value 内 UTF-16 偏移）；缺省 = 末尾（无光标态兼容旧调用）。 */
    cursorPos?: number
  }
  /** Optional footer key hints; defaults to ↑↓/Enter/Esc. */
  footerHints?: Array<[string, string]>
  /** 硬件光标落点（输入子模式渲染方回填，零占位不挤压文本——与 connect 同款）。 */
  caret?: { row: number; col: number } | null
}

export function renderChoicePanel(data: ChoicePanelData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  data.caret = null
  lines.push(formatBorder(width, theme, 'subtle'))
  // Multi-line titles (ask pager): first line as title, rest as muted captions.
  // 附加行（计划审批 excerpt / 倒计时行等）钳制在 height-10 行以内：不钳制时
  // titleExtra 过大 → contentRows 被压到 1，总行数超 height 被引擎定长网格
  // 静默截掉选项与 footer（矮终端下审批卡看不到选项）。
  const titleLines = data.title.split('\n')
  const shownExtras = titleLines.slice(1, 1 + Math.max(0, height - 10))
  if (titleLines.length - 1 > shownExtras.length) {
    if (shownExtras.length > 0) {
      shownExtras[shownExtras.length - 1] = `${shownExtras[shownExtras.length - 1]!} …`
    } else {
      shownExtras.push('…')
    }
  }
  lines.push(formatTitleLeft(titleLines[0] ?? '', width, theme))
  for (const extra of shownExtras) {
    lines.push(padLine(`  ${color(truncateToDisplayWidth(extra, Math.max(1, width - 8)), theme.secondary)}`, width, theme))
  }
  lines.push(frameDivider(width, theme))

  const innerWidth = width - 6 // padLine border(2) + left indent(2) + right gap(2)
  const inputSubMode = data.inputSubMode?.active ? data.inputSubMode : undefined
  const inputRows = inputSubMode ? 2 : 0 // label line + input line
  const titleExtra = shownExtras.length
  const contentRows = Math.max(1, height - 5 - inputRows - titleExtra) // border + title + separator + footer + bottom = 5

  if (data.choices.length === 0) {
    lines.push(padLine(color('  （无可用选项）', theme.muted), width, theme))
    lines.push(formatFooter(compactHints([['Esc', '关闭']]), width, theme, 'subtle'))
    lines.push(formatBottomBorder(width, theme, 'subtle'))
    return lines
  }

  // Each choice takes 1-2 lines (label + optional description). A scroll
  // window keeps the cursor visible in short terminals instead of silently
  // truncating choices beyond the viewport.
  const choiceHeights = data.choices.map(c => 1 + (c.description ? wrapToWidth(c.description, innerWidth, 2).length : 0))
  const win = scrollWindowWithIndicators(choiceHeights, data.selectedIndex, contentRows)
  let rowsUsed = 0
  if (win.start > 0) {
    lines.push(padLine(`   ${color(`↑ 以上还有 ${win.start} 项`, theme.muted)}`, width, theme))
    rowsUsed++
  }
  for (let i = win.start; i < win.end && rowsUsed < contentRows; i++) {
    const c = data.choices[i]!
    const selected = i === data.selectedIndex

    // Label line: cursor + recommended star + label
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const star = c.recommended ? color('★', theme.warning ?? theme.primary, { bold: true }) : ' '
    const labelColor = selected ? theme.primary : theme.secondary
    const labelText = selected ? color(c.label, labelColor, { bold: true }) : color(c.label, labelColor)
    const currentMark = c.current ? ' ' + color('← current', theme.success) : ''
    lines.push(padLine(` ${cursor} ${star} ${labelText}${currentMark}`, width, theme))
    rowsUsed++

    // Description line(s)
    if (c.description && rowsUsed < contentRows) {
      const descWrapped = wrapToWidth(c.description, innerWidth, 2)
      for (const d of descWrapped) {
        if (rowsUsed >= contentRows) break
        lines.push(padLine(`     ${color(d, theme.muted)}`, width, theme))
        rowsUsed++
      }
    }
  }
  if (win.end < data.choices.length && rowsUsed < contentRows) {
    lines.push(padLine(`   ${color(`↓ 以下还有 ${data.choices.length - win.end} 项`, theme.muted)}`, width, theme))
    rowsUsed++
  }

  // Pad remaining rows
  while (rowsUsed < contentRows) {
    lines.push(padLine('', width, theme))
    rowsUsed++
  }

  if (inputSubMode) {
    lines.push(frameDivider(width, theme))
    lines.push(padLine(` ${color(inputSubMode.label, theme.muted)}`, width, theme))
    // 光标是硬件 caret（格边界、零占位），与 connect overlay 同款——行内不画字形。
    // 超宽窗口化：光标前缀超出可视宽时从行首丢弃（尾部锚定），保光标可见。
    const value = inputSubMode.value
    const pos = Math.min(Math.max(inputSubMode.cursorPos ?? value.length, 0), value.length)
    const max = Math.max(1, width - 6)
    let start = 0
    while (start < pos && stringWidth(value.slice(start, pos)) > max - 1) {
      start += value.codePointAt(start)! > 0xffff ? 2 : 1
    }
    let visible = value.slice(start)
    if (stringWidth(visible) > max) visible = truncateToDisplayWidth(visible, max)
    const shown = visible.length > 0
      ? color(visible, theme.secondary)
      : color(inputSubMode.placeholder, theme.dim)
    data.caret = { row: lines.length + 1, col: 5 + stringWidth(value.slice(start, pos)) }
    lines.push(padLine(` ${color('>', theme.primary, { bold: true })} ${shown}`, width, theme))
    lines.push(formatFooter(compactHints([['↵', '提交'], ['Esc', '返回选项']]), width, theme, 'subtle'))
  } else {
    const hints = data.footerHints ?? [['↑↓', '选择'], ['Enter', '确认'], ['Esc', '取消']]
    lines.push(formatFooter(compactHints(hints), width, theme, 'subtle'))
  }
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Plan Picker (/plan-approve 无参 · 待批计划选择器) ────────────────

export interface PlanPickerEntry {
  /** 选择键：plan slug（planPickerExec 收到它去 approve+kickoff）。 */
  slug: string
  title: string
  status: 'submitted' | 'approved' | 'executed' | 'rejected'
  /** 展示用创建时间（已本地化字符串）。 */
  createdAt: string
  /** 多方案计划的方案标签（可空）。 */
  options?: string[]
}

export interface PlanPickerData {
  entries: PlanPickerEntry[]
  selectedIndex: number
}

function planStatusGlyph(status: PlanPickerEntry['status'], theme: RivetTheme): string {
  const glyphs = uiGlyphs()
  switch (status) {
    case 'approved': return color(glyphs.planApproved, theme.success)
    case 'rejected': return color(glyphs.planRejected, theme.error)
    case 'executed': return color(glyphs.planExecuted, theme.secondary)
    default: return color(glyphs.planSubmitted, theme.dim)
  }
}

/**
 * 渲染 Plan Picker overlay（待批计划选择器）。
 * 列表（cursor + 状态图标 + title）→ 选中项 dim 元信息（slug · 时间 · 方案）。
 * 回车批准并自动分波执行（planPickerExec 收到 slug）。
 */
export function renderPlanPicker(data: PlanPickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft('选择要批准执行的计划', width, theme))
  lines.push(frameDivider(width, theme))

  const innerWidth = width - 6
  const contentRows = Math.max(1, height - 5)

  if (data.entries.length === 0) {
    lines.push(padLine(color('  （无待批计划。/plan-mode 进入计划模式创建）', theme.muted), width, theme))
    lines.push(formatFooter(compactHints([['Esc', '关闭']]), width, theme, 'subtle'))
    lines.push(formatBottomBorder(width, theme, 'subtle'))
    return lines
  }

  const entryHeights = data.entries.map(e => 2) // label line + meta line when selected; conservative uniform height
  const win = scrollWindowWithIndicators(entryHeights, data.selectedIndex, contentRows)
  let rowsUsed = 0
  if (win.start > 0) {
    lines.push(padLine(`   ${color(`↑ 以上还有 ${win.start} 项`, theme.muted)}`, width, theme))
    rowsUsed++
  }
  for (let i = win.start; i < win.end && rowsUsed < contentRows; i++) {
    const e = data.entries[i]!
    const selected = i === data.selectedIndex
    const icon = planStatusGlyph(e.status, theme)
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const labelColor = selected ? theme.primary : theme.secondary
    const title = selected ? color(e.title, labelColor, { bold: true }) : color(e.title, labelColor)
    lines.push(padLine(` ${cursor} ${icon} ${title}`, width, theme))
    rowsUsed++

    if (selected && rowsUsed < contentRows) {
      const optionsPart = e.options && e.options.length > 0 ? ` · 方案: ${e.options.join(' / ')}` : ''
      const meta = `${e.slug} · ${e.createdAt}${optionsPart}`
      for (const d of wrapToWidth(meta, innerWidth, 2)) {
        if (rowsUsed >= contentRows) break
        lines.push(padLine(`     ${color(d, theme.muted)}`, width, theme))
        rowsUsed++
      }
    }
  }
  if (win.end < data.entries.length && rowsUsed < contentRows) {
    lines.push(padLine(`   ${color(`↓ 以下还有 ${data.entries.length - win.end} 项`, theme.muted)}`, width, theme))
    rowsUsed++
  }

  while (rowsUsed < contentRows) {
    lines.push(padLine('', width, theme))
    rowsUsed++
  }

  lines.push(formatFooter(compactHints([['↑↓', '选择'], ['Enter', '批准执行'], ['v', '预览全文'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Connect Wizard (/connect 服务商配置向导) ──────────────────────
// Single stateful overlay driven by ConnectFlow: renders either a choice list
// (provider pick) or a masked/plain text input (URL / model / key), plus a live
// validation error line. Mirrors the polished scream-code connect experience.

export interface ConnectOverlayData {
  view: ConnectView
  /** Live input buffer for input-kind steps. */
  input: string
  /** Validation error for the current step (shown in red). */
  error?: string
  /** Selected option index for choice-kind steps. */
  selectedIndex: number
  /** 输入光标在缓冲中的位置（默认贴末尾）。 */
  cursorPos?: number
  /** 光标本帧是否可见（闪烁期由 app 逐帧计算；默认可见）。 */
  cursorVisible?: boolean
  /** form 步当前选中字段下标。 */
  formFieldIndex?: number
  /**
   * 渲染方回填：本帧硬件光标落点（1-based 行/列）。null = 无光标。
   * 光标是终端原生 caret——落在字符格边界上、零占位、不挤压文本。
   */
  caret?: { row: number; col: number } | null
}

function maskSecret(value: string): string {
  return '•'.repeat([...value].length)
}

export function renderConnect(data: ConnectOverlayData, width: number, height: number, theme: RivetTheme): string[] {
  const { view } = data
  data.caret = null
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  const titleBar = view.stepLabel ? `${view.title}   ${view.stepLabel}` : view.title
  lines.push(formatTitleLeft(titleBar, width, theme))
  lines.push(frameDivider(width, theme))

  const innerWidth = width - 6
  const footerPairs: [string, string][] = view.kind === 'choice'
    ? [['↑↓', '选择'], ['Enter', '确认'], ['Esc', '取消']]
    : view.kind === 'multi-choice'
      ? [['↑↓', '移动'], ['空格', '勾选'], ['输入', '搜索'], ['Ctrl+A', '全选'], ['Enter', '确认'], ['Esc', '取消']]
      : view.kind === 'busy'
        ? [['Esc', '取消']]
        : view.kind === 'form'
          ? [['↑↓', '选字段'], ['←→', '移光标'], ['空格', '切换'], ['Enter', '确认'], ['Esc', '返回']]
          : [['←→', '移动'], ['Enter', '提交'], ['Esc', '取消']]
  const footer = hintRows(footerPairs, width, theme)
  const contentRows = Math.max(1, height - 4 - footer.length)
  let rowsUsed = 0
  const push = (s: string): void => { lines.push(padLine(s, width, theme)); rowsUsed++ }

  if (view.subtitle && rowsUsed < contentRows) {
    for (const d of wrapToWidth(view.subtitle, innerWidth, 1)) {
      if (rowsUsed >= contentRows) break
      push(` ${color(d, theme.muted)}`)
    }
    if (rowsUsed < contentRows) push('')
  }

  if (view.filter !== undefined && rowsUsed < contentRows) {
    // 多选步即时搜索行：查询文本 + 计数。占位文字仅空查询时显示（非实体）；
    // caret 是硬件光标——空时停在占位符前方（句首），非空贴在查询末尾。
    const hasQuery = view.filter.length > 0
    const text = hasQuery ? color(view.filter, theme.secondary) : color('输入关键字过滤模型…', theme.dim)
    const counter = color(` ${view.options?.length ?? 0}/${view.optionTotal ?? 0}`, theme.muted)
    if (data.cursorVisible !== false) {
      // 行首 │ 边框 1 列 + ' > ' 前缀 3 列 → 文本第 5 列起；col 为 1-based。
      data.caret = { row: lines.length + 1, col: 5 + (hasQuery ? stringWidth(view.filter) : 0) }
    }
    push(` ${color('>', theme.primary, { bold: true })} ${text}${counter}`)
    if (rowsUsed < contentRows) push('')
  }

  if (view.report && view.report.length > 0) {
    for (const line of view.report) {
      if (rowsUsed >= contentRows) break
      const toneColor = line.tone === 'ok'
        ? theme.success
        : line.tone === 'fail'
          ? theme.error ?? theme.primary
          : line.tone === 'head'
            ? theme.secondary
            : theme.muted
      const opts = line.tone === 'head' ? { bold: true } : undefined
      for (const d of wrapToWidth(line.text, innerWidth, 2)) {
        if (rowsUsed >= contentRows) break
        push(` ${color(d, toneColor, opts)}`)
      }
    }
    if (rowsUsed < contentRows) push('')
  }

  if (view.kind === 'choice' || view.kind === 'multi-choice') {
    const options = view.options ?? []
    // Scroll window keeps the cursor visible in short terminals (e.g. the
    // 19-item provider list) instead of silently truncating beyond viewport.
    const optionHeights = options.map(o => 1 + (o.description ? wrapToWidth(o.description, innerWidth, 2).length : 0))
    const win = scrollWindowWithIndicators(optionHeights, data.selectedIndex, contentRows - rowsUsed)
    if (win.start > 0 && contentRows - rowsUsed > win.end - win.start) push(`   ${color(`↑ 以上还有 ${win.start} 项`, theme.muted)}`)
    for (let i = win.start; i < win.end && rowsUsed < contentRows; i++) {
      const opt = options[i]!
      const selected = i === data.selectedIndex
      const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const star = opt.recommended ? color('★', theme.warning ?? theme.primary, { bold: true }) : ' '
      const box = view.kind === 'multi-choice'
        ? `${opt.checked ? color('☑', theme.success) : color('☐', theme.muted)} `
        : ''
      const labelColor = selected ? theme.primary : theme.secondary
      const label = selected ? color(opt.label, labelColor, { bold: true }) : color(opt.label, labelColor)
      push(` ${cursor} ${star} ${box}${label}`)
      if (opt.description && rowsUsed < contentRows) {
        for (const d of wrapToWidth(opt.description, innerWidth, 2)) {
          if (rowsUsed >= contentRows) break
          push(`     ${color(d, theme.muted)}`)
        }
      }
    }
    if (win.end < options.length && rowsUsed < contentRows) {
      push(`   ${color(`↓ 以下还有 ${options.length - win.end} 项`, theme.muted)}`)
    }
  } else if (view.kind === 'busy') {
    push(` ${color('⠋ 请稍候…', theme.primary, { bold: true })}`)
  } else if (view.kind === 'form') {
    // 单步表单：字段竖排，选中行带硬件 caret（text 字段）或高亮值（toggle）。
    const fields = view.fields ?? []
    const active = Math.min(Math.max(data.formFieldIndex ?? 0, 0), Math.max(0, fields.length - 1))
    for (let i = 0; i < fields.length && rowsUsed < contentRows; i++) {
      const f = fields[i]!
      const selected = i === active
      const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const labelStr = color(`${f.label}：`, selected ? theme.primary : theme.muted, selected ? { bold: true } : undefined)
      let valueStr: string
      if (f.kind === 'toggle') {
        valueStr = color(f.value, selected ? theme.primary : theme.muted)
      } else {
        valueStr = color(f.value, selected ? theme.secondary : theme.muted)
        if (selected && data.cursorVisible !== false) {
          const caretPos = Math.min(Math.max(data.cursorPos ?? f.value.length, 0), f.value.length)
          // caret col = 行首 │ 边框 1 列 + 纯文本前缀宽 + 值前缀宽 + 1（1-based）。
          const prefixWidth = stringWidth(` ${CURSOR} ${f.label}：`)
          data.caret = { row: lines.length + 1, col: prefixWidth + stringWidth(f.value.slice(0, caretPos)) + 2 }
        }
      }
      const hint = selected && f.hint ? color(`  ${f.hint}`, theme.dim) : ''
      push(` ${cursor} ${labelStr}${valueStr}${hint}`)
    }
  } else {
    const shown = view.masked ? maskSecret(data.input) : data.input
    // 掩码步按码点展示，先把 UTF-16 位置换算成码点。
    const utf16Pos = Math.min(Math.max(data.cursorPos ?? data.input.length, 0), data.input.length)
    const pos = view.masked ? data.input.slice(0, utf16Pos).length : utf16Pos
    // 光标是硬件 caret（格子边界、零占位），不在行内画任何字形；
    // 占位符仅空输入时显示，非实体。
    const body = shown.length > 0
      ? color(shown, theme.secondary)
      : color(view.placeholder ?? '', theme.dim)
    if (data.cursorVisible !== false) {
      data.caret = { row: lines.length + 1, col: 5 + stringWidth(shown.slice(0, pos)) }
    }
    push(` ${color('>', theme.primary, { bold: true })} ${body}`)
  }

  if (data.error && rowsUsed < contentRows) {
    push('')
    for (const d of wrapToWidth(data.error, innerWidth, 1)) {
      if (rowsUsed >= contentRows) break
      push(` ${color(d, theme.error ?? theme.primary)}`)
    }
  }

  while (rowsUsed < contentRows) push('')

  lines.push(...footer)
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Init Wizard (/init 交互式项目初始化) ──────────────────────
// Single stateful overlay driven by InitFlow: multi-choice steps with checkbox
// toggles (scope / details) and a confirm step listing files to be written.

export interface InitOverlayData {
  view: InitView
  /** Validation error for the current step (shown in red). */
  error?: string
  /** Selected option index for multi-choice steps. */
  selectedIndex: number
}

export function renderInitFlow(data: InitOverlayData, width: number, height: number, theme: RivetTheme): string[] {
  const { view } = data
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  const titleBar = view.stepLabel ? `${view.title}   ${view.stepLabel}` : view.title
  lines.push(formatTitleLeft(titleBar, width, theme))
  lines.push(frameDivider(width, theme))

  const innerWidth = width - 6
  const footer = hintRows(view.kind === 'multi-choice'
    ? [['↑↓', '移动'], ['空格', '勾选'], ['Enter', '继续'], ['Esc', '取消']]
    : [['Enter', '执行'], ['Esc', '取消']], width, theme)
  const contentRows = Math.max(1, height - 4 - footer.length)
  let rowsUsed = 0
  const push = (s: string): void => { lines.push(padLine(s, width, theme)); rowsUsed++ }

  if (view.subtitle && rowsUsed < contentRows) {
    for (const d of wrapToWidth(view.subtitle, innerWidth, 1)) {
      if (rowsUsed >= contentRows) break
      push(` ${color(d, theme.muted)}`)
    }
    if (rowsUsed < contentRows) push('')
  }

  if (view.note && rowsUsed < contentRows) {
    for (const d of wrapToWidth(view.note, innerWidth, 1)) {
      if (rowsUsed >= contentRows) break
      push(` ${color(d, theme.warning ?? theme.muted)}`)
    }
    if (rowsUsed < contentRows) push('')
  }

  if (view.kind === 'multi-choice') {
    const options = view.options ?? []
    const optionHeights = options.map(o => 1 + (o.description ? wrapToWidth(o.description, innerWidth, 2).length : 0))
    const win = scrollWindowWithIndicators(optionHeights, data.selectedIndex, contentRows - rowsUsed)
    if (win.start > 0 && contentRows - rowsUsed > win.end - win.start) push(`   ${color(`↑ 以上还有 ${win.start} 项`, theme.muted)}`)
    for (let i = win.start; i < win.end && rowsUsed < contentRows; i++) {
      const opt = options[i]!
      const selected = i === data.selectedIndex
      const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const box = opt.checked ? color('☑', theme.success) : color('☐', theme.muted)
      const star = opt.recommended ? color(' ★', theme.warning ?? theme.primary, { bold: true }) : ''
      const labelColor = selected ? theme.primary : theme.secondary
      const label = selected ? color(opt.label, labelColor, { bold: true }) : color(opt.label, labelColor)
      push(` ${cursor} ${box} ${label}${star}`)
      if (opt.description && rowsUsed < contentRows) {
        for (const d of wrapToWidth(opt.description, innerWidth, 2)) {
          if (rowsUsed >= contentRows) break
          push(`     ${color(d, theme.muted)}`)
        }
      }
    }
    if (win.end < options.length && rowsUsed < contentRows) {
      push(`   ${color(`↓ 以下还有 ${options.length - win.end} 项`, theme.muted)}`)
    }
  } else {
    // confirm step: the file list about to be written.
    for (const line of view.lines ?? []) {
      if (rowsUsed >= contentRows) break
      for (const d of wrapToWidth(line, innerWidth, 1)) {
        if (rowsUsed >= contentRows) break
        push(` ${color(d, theme.secondary)}`)
      }
    }
  }

  if (data.error && rowsUsed < contentRows) {
    push('')
    for (const d of wrapToWidth(data.error, innerWidth, 1)) {
      if (rowsUsed >= contentRows) break
      push(` ${color(d, theme.error ?? theme.primary)}`)
    }
  }

  while (rowsUsed < contentRows) push('')

  lines.push(...footer)
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Fleet Detail (子代理详情弹窗) ───────────────────────────────
// Shows expanded details for a single delegation worker: profile, status,
// current activity, elapsed, authority. Triggered by pressing Enter on a
// worker row in the fleet panel.

import type { FleetWorkerView } from '../fleet-registry.js'

export function renderFleetDetail(worker: FleetWorkerView, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))

  // Title: status glyph + worker label + status word（同色，一眼判断终态）
  const statusGlyph = worker.terminal
    ? (worker.status === 'completed' ? '✓' : worker.status === 'failed' ? '✗' : '⚠')
    : '◐'
  const statusColor = worker.terminal
    ? (worker.status === 'completed' ? theme.success : worker.status === 'failed' ? theme.error : theme.warning)
    : theme.primary
  lines.push(formatTitleLeft(
    `${color(`${statusGlyph} ${worker.shortLabel}`, statusColor, { bold: true })} ${color(`· ${worker.status}`, statusColor)}`,
    width, theme,
  ))
  lines.push(frameDivider(width, theme))

  // Detail rows：标签列右对齐固定宽度，值列对齐成表
  const rows: [string, string][] = []
  rows.push(['Profile', worker.profile])
  if (worker.authority) {
    rows.push(['Authority', formatAuthorityLabel(worker.authority, worker.authorityReason)])
  }
  if (worker.model) rows.push(['Model', worker.model])
  rows.push(['Elapsed', formatElapsed(worker.elapsedMs)])
  const statBits: string[] = []
  if (worker.toolUseCount > 0) statBits.push(`⚙ ${worker.toolUseCount} tools`)
  if (worker.tokenCount > 0) statBits.push(`${formatTokenCount(worker.tokenCount)} tokens`)
  if (statBits.length > 0) rows.push(['Usage', statBits.join(' · ')])
  rows.push(['Parent', worker.parentToolId])

  const labelW = Math.max(...rows.map(([l]) => l.length))
  for (const [label, value] of rows) {
    lines.push(padLine(`  ${color(label.padStart(labelW), theme.muted)}  ${color(value, theme.secondary)}`, width, theme))
  }

  // Activity log (ring buffer — newest last; fallback to single activity line)
  const activityLog = worker.activityLog?.length ? worker.activityLog : (worker.activity ? [worker.activity] : [])
  if (activityLog.length > 0) {
    lines.push(padLine('', width, theme))
    lines.push(padLine(`  ${color('活动日志', theme.muted, { bold: true })}`, width, theme))
    // 高度预算内展示最新条目（newest last），末行留给 footer
    const room = Math.max(1, height - lines.length - 3)
    const shown = activityLog.slice(-room)
    for (const entry of shown) {
      lines.push(padLine(`    ${color('⎿', theme.dim)} ${color(entry, theme.secondary)}`, width, theme))
    }
  }

  // Pad to fill height
  const remaining = Math.max(0, height - lines.length - 3)
  for (let i = 0; i < remaining; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(formatFooter(compactHints([['Esc', '关闭']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}
