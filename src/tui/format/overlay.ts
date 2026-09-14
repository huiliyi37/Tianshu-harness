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

import stringWidth from 'string-width'
import { truncateToDisplayWidth } from '../width.js'
import { color } from '../engine/ansi.js'
import { resolveThemeEntry, type RivetTheme } from '../theme.js'
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
  frameTitleLeft as formatTitleLeft,
  frameFooter as formatFooter,
  frameLine as padLine,
  frameDivider,
  CURSOR,
  CURRENT_MARK,
  keyHints,
  type BorderStyle,
} from './overlay-frame.js'


/** 紧凑快捷键提示（逗号分隔，类似 fzf 风格）。 */
export function compactHints(pairs: [key: string, action: string][]): string {
  return pairs.map(([k, a]) => `${k}:${a}`).join(', ')
}

export function renderTabBar(activeTab: 'domain' | 'model' | 'theme', width: number, theme: RivetTheme): string {
  const tabDomain = activeTab === 'domain' ? color('Domain', theme.primary, { bold: true }) : color(' Domain ', theme.dim)
  const tabModel = activeTab === 'model' ? color('Model', theme.primary, { bold: true }) : color(' Model ', theme.dim)
  const tabTheme = activeTab === 'theme' ? color('Theme', theme.primary, { bold: true }) : color(' Theme ', theme.dim)

  const separator = color('│', theme.dim)
  const tabs = `${tabDomain}${separator}${tabModel}${separator}${tabTheme}`
  const tabsPlain = 'Domain  │  Model  │  Theme'
  const remaining = Math.max(0, width - 2 - stringWidth(tabsPlain))
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return color('│', theme.dim) + ' '.repeat(left) + tabs + ' '.repeat(right) + color('│', theme.dim)
}

// ── Pager ─────────────────────────────────────────────────────

export interface PagerData {
  /** 要显示的文本内容 */
  content: string
  /** 当前页码（0-based） */
  page: number
  /** 标题 */
  title?: string
  /** 当前模式 */
  mode?: 'page' | 'search' | 'message'
  /** 搜索 query */
  searchQuery?: string
  /** 搜索总匹配数 */
  searchMatches?: number
  /** 当前匹配序号（1-based） */
  searchCurrent?: number
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
  const highlighted = `${before}${color(match, theme.primary, { bold: true })}${after}`
  // Re-pad to width; highlighted line may have different display width due to ANSI,
  // but padLine uses stringWidth which strips ANSI, so it's safe.
  const padding = Math.max(0, width - 2 - stringWidth(highlighted))
  return color('│', theme.dim) + highlighted + ' '.repeat(padding) + color('│', theme.dim)
}

function pageForMessage(messages: readonly TranscriptMessage[], messageIndex: number, pageSize: number): number {
  if (messageIndex < 0 || messageIndex >= messages.length || pageSize <= 0) return 0
  let rows = 0
  for (let i = 0; i < messageIndex; i++) {
    rows += messages[i]!.lines.length
  }
  return Math.floor(rows / pageSize)
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
  const pageSize = height - 4 // 1 border top + 1 title + 1 footer + 1 border bottom = 4
  const totalPages = Math.max(1, Math.ceil(contentLines.length / pageSize))
  const mode = data.mode ?? 'page'
  const messages = data.messages ?? []

  let effectivePage = Math.min(data.page, totalPages - 1)
  let title: string
  const verboseHint: [string, string] = data.verbose ? ['v', '简略'] : ['v', '详细']
  let footer = compactHints(data.footerHints ?? [['↑↓/j/k', '滚动'], ['PgUp/PgDn', '翻页'], ['/', '搜索'], verboseHint, ['q', '关闭']])

  if (mode === 'search') {
    const current = data.searchCurrent ?? 0
    const total = data.searchMatches ?? 0
    const query = data.searchQuery ?? ''
    title = data.title
      ? `${data.title} — 搜索 "${query}" (${current}/${total})`
      : `搜索 "${query}" (${current}/${total})`
    footer = compactHints([['n/N', '匹配'], ['Esc', '清除'], ['q', '关闭']])
    if (messages.length > 0 && current > 0) {
      const msgIdx = current - 1 < messages.length ? current - 1 : 0
      effectivePage = pageForMessage(messages, msgIdx, pageSize)
      effectivePage = Math.min(effectivePage, totalPages - 1)
    }
  } else if (mode === 'message' && messages.length > 0) {
    const idx = Math.min(Math.max(0, data.selectedMessageIndex ?? 0), messages.length - 1)
    title = data.title
      ? `${data.title} — 消息 ${idx + 1}/${messages.length}`
      : `消息 ${idx + 1}/${messages.length}`
    footer = compactHints([['↑↓/j/k', '切换'], ['Esc', '返回'], ['q', '关闭']])
    effectivePage = pageForMessage(messages, idx, pageSize)
    effectivePage = Math.min(effectivePage, totalPages - 1)
  } else {
    const verboseTag = data.verbose ? ' [verbose]' : ''
    title = data.title ? `${data.title}${verboseTag} (${effectivePage + 1}/${totalPages})` : `查看${verboseTag} (${effectivePage + 1}/${totalPages})`
  }

  // Top border + title
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(title, width, theme))

  // Content
  const start = effectivePage * pageSize
  const pageLines = contentLines.slice(start, start + pageSize)

  if (mode === 'message' && messages.length > 0) {
    const idx = Math.min(Math.max(0, data.selectedMessageIndex ?? 0), messages.length - 1)
    const msg = messages[idx]!
    const header = msg.isTruncated
      ? color(`〔message ${idx + 1}/${messages.length} — truncated in scrollback〕`, theme.warning)
      : color(`〔message ${idx + 1}/${messages.length}〕`, theme.dim)
    lines.push(padLine(header, width, theme))
    for (const line of msg.lines.slice(0, pageSize - 1)) {
      lines.push(padLine(line, width, theme))
    }
    for (let i = msg.lines.length + 1; i < pageSize; i++) {
      lines.push(padLine('', width, theme))
    }
  } else if (mode === 'search') {
    for (let i = 0; i < pageLines.length; i++) {
      const line = pageLines[i]!
      if (data.searchQuery && lineMatchesQuery(line, data.searchQuery)) {
        lines.push(highlightMatch(line, data.searchQuery, width, theme))
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
  lines.push(formatFooter(footer, width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

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

  const title = data.searchText
    ? `⌘ 命令面板 — "${data.searchText}"`
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
}

/**
 * 渲染 Chronicle overlay（会话编年史）。
 */
export function renderChronicle(data: ChronicleData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []

  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(data.title ?? '会话编年史', width, theme))

  const idxWidth = 6
  const timeWidth = Math.min(14, Math.floor(width * 0.18))
  const summaryWidth = width - 2 - idxWidth - timeWidth - 5

  const maxEntries = height - 5
  const visible = data.entries.slice(0, maxEntries)
  const sel = data.selectedIndex ?? -1

  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i]!
    const selected = i === sel
    // 选中游标；当前会话用 primary 高亮（与选中区分：选中靠游标，当前靠色）。
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const idxColor = entry.current ? theme.primary : theme.dim
    const idx = color(`#${String(entry.index)}`.padEnd(idxWidth - 1), idxColor, entry.current ? { bold: true } : undefined)
    const time = color(entry.time.padEnd(timeWidth), entry.current ? theme.primary : theme.dim)
    const summaryText = entry.summary.slice(0, summaryWidth).padEnd(summaryWidth)
    const summary = selected || entry.current ? summaryText : color(summaryText, theme.muted)

    lines.push(padLine(`${cursor}${idx}${time}${summary}`, width, theme))
  }

  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  // footer 不再展示 Enter=恢复会话（2026-07-25）：恢复功能保留但不主动
  // 展示——降低顺手回连带来的碎缓存风险。
  lines.push(formatFooter(compactHints([['↑↓', '选择'], ['Esc', '关闭']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── Tasks ──────────────────────────────────────────────────────

export type TasksWorkerStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'escalated'

export interface TasksWorkerRow {
  /** 稳定的 per-worker id（work order id），用于进入 detail pager。 */
  workerId: string
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

export type TasksFilter = 'running' | 'completed' | 'all'

export interface TasksGroup {
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
  running: '◐',
  completed: '✓',
  failed: '✗',
  blocked: '⊘',
  escalated: '↑',
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
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (w + cw > width) {
      // 溢出：末位补省略号（若有空间）
      if (w < width) { out += '…'; w += 1 }
      break
    }
    out += ch
    w += cw
  }
  return out + ' '.repeat(Math.max(0, width - w))
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
  if (width <= 0 || maxLines <= 0) return []
  const out: string[] = []
  let line = ''
  let w = 0
  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    const cw = stringWidth(ch)
    if (w + cw > width) {
      out.push(line)
      if (out.length >= maxLines) {
        // 末行加省略号标记溢出
        const last = out[maxLines - 1]!
        out[maxLines - 1] = last.length > 1 ? last.slice(0, -1) + '…' : '…'
        return out.slice(0, maxLines)
      }
      line = ''
      w = 0
    }
    line += ch
    w += cw
  }
  if (line) out.push(line)
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
  const tabs: [TasksFilter, string][] = [['running', '运行中'], ['completed', '已完成'], ['all', '全部']]
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
  selectedIndex = -1,
): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(`${color('子代理任务', theme.secondary, { bold: true })}   ${tasksFilterTabs(data.filter, theme)}`, width, theme))
  lines.push(frameDivider(width, theme))

  const maxEntries = Math.max(1, height - 6) // top + title + divider + footer + bottom = 5, -1 安全余量

  // 逐组渲染：组头（进度条 + 语义色计数）后跟 worker 行。多组时以
  // 序号区分（parentToolId 是不透明的 tool id，不直接展示）。
  const body: string[] = []
  const selectable: { workerId: string; bodyIndex: number }[] = []
  const multiGroup = data.groups.length > 1
  const inner = width - 2

  // objective 子行的纵向预算。body 在下方是 `slice(0, maxEntries)` 硬截断、
  // 没有滚动——子行让每个 worker 占两行，屏幕矮时会把列表底部的 worker 整个
  // 挤出可视区。宁可不显示 objective，也不能让 worker 消失，所以先按最坏情况
  // （每个 worker 都有 objective）算总需求，装不下就整体降级回单行。
  const workerTotal = data.groups.reduce((n, g) => n + g.workers.length, 0)
  const totalRowsNeeded = data.groups.length + workerTotal * 2 + Math.max(0, data.groups.length - 1)
  const showObjective = totalRowsNeeded <= maxEntries

  data.groups.forEach((g, gi) => {
    // 组头：进度条填充段用语义色（全过→success，有失败→warning，其余→primary）
    const barColor = g.total > 0 && g.done === g.total ? theme.success
      : g.failed > 0 ? theme.warning
        : theme.primary
    const barW = 10
    const filledN = g.total > 0 ? Math.min(barW, Math.round((g.done / g.total) * barW)) : 0
    const bar = color('█'.repeat(filledN), barColor) + color('░'.repeat(barW - filledN), theme.dim)
    const countParts: string[] = [color(`${g.done}/${g.total} 完成`, theme.muted)]
    if (g.running > 0) countParts.push(color(`◐${g.running} 运行`, theme.primary))
    if (g.failed > 0) countParts.push(color(`✗${g.failed} 失败`, theme.warning))
    const groupTitle = multiGroup ? `批次 ${gi + 1}` : '任务组'
    body.push(` ${color('◆', theme.primary)} ${color(groupTitle, theme.secondary)}  ${bar}  ${countParts.join(color(' · ', theme.dim))}`)

    for (const w of g.workers) {
      selectable.push({ workerId: w.workerId, bodyIndex: body.length })
      const glyph = TASK_STATUS_GLYPH[w.status] ?? '·'
      const glyphColored = color(glyph, taskStatusColor(w.status, theme, w.failureReason))
      // unread：终态但用户还没打开 detail —— 行首圆点提示（CC 未读结果对标）。
      // 无色纯字符：选中行会被 slice(3) 替换为光标前缀，带 ANSI 会被切坏。
      const unreadMark = w.unread ? '●' : ' '

      // 三段式：`  ●◐ label(固定列)  activity(弹性)  stats(右对齐)`
      const labelW = Math.min(22, Math.max(12, Math.floor(inner * 0.28)))
      const label = fitDisplay(`${w.shortLabel} ${formatWorkerIdentity({ profile: w.profile, authority: w.authority })}`, labelW)

      const statParts: string[] = []
      if (w.toolUseCount && w.toolUseCount > 0) statParts.push(`⚙${w.toolUseCount}`)
      if (w.tokenCount && w.tokenCount > 0) statParts.push(`${formatTokenCount(w.tokenCount)}tok`)
      statParts.push(formatElapsed(w.elapsedMs))
      let statsPlain = statParts.join(' · ')

      // prefix(2sp+unread+glyph+1sp=5) + label + 2 gap + activity + 2 gap + stats + 1 右边距
      let activityW = inner - 5 - labelW - 2 - stringWidth(statsPlain) - 3
      if (activityW < 4 && statParts.length > 1) {
        // 窄屏降级：只留耗时列
        statsPlain = statParts[statParts.length - 1]!
        activityW = inner - 5 - labelW - 2 - stringWidth(statsPlain) - 3
      }
      const activity = fitDisplay(w.activity ?? '', Math.max(0, activityW))
      const stats = color(statsPlain, theme.muted)
      const labelColored = w.status === 'running' ? label : color(label, theme.muted)
      body.push(`  ${unreadMark}${glyphColored} ${labelColored}  ${activity}  ${stats}`)

      // objective 子行：缩进到 label 列下方。追加在主行**之后**，selectable
      // 记录的 bodyIndex 仍指向主行，光标的 slice(3) 前缀替换不受影响。
      if (showObjective && w.objective) {
        const objText = w.objective.replace(/\s+/g, ' ').trim()
        if (objText) body.push(`     ${color(fitDisplay(objText, Math.max(0, inner - 6)), theme.dim)}`)
      }
    }
    // 组间空行（最后一组后不加）
    if (gi < data.groups.length - 1) body.push('')
  })

  if (selectable.length === 0) {
    const emptyText = data.filter === 'completed' ? '（暂无已完成的子代理）'
      : data.filter === 'all' ? '（暂无子代理）'
        : '（暂无运行中的子代理 · ←/→ 切换筛选）'
    body.push('')
    body.push(color(`  ${emptyText}`, theme.muted))
  }

  const selectedBodyIndex = selectedIndex >= 0 && selectedIndex < selectable.length
    ? selectable[selectedIndex]!.bodyIndex
    : -1

  const visible = body.slice(0, maxEntries)
  for (let i = 0; i < visible.length; i++) {
    let line = visible[i]!
    if (i === selectedBodyIndex) {
      // 把前导三个空格替换为光标 + 两个空格，保持宽度一致
      line = `${color(CURSOR, theme.primary, { bold: true })}  ${line.slice(3)}`
    }
    lines.push(padLine(line, width, theme))
  }
  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  const runningCount = data.groups.reduce((n, g) => n + g.workers.filter(w => w.status === 'running').length, 0)
  const summaryParts: string[] = []
  if (data.filter === 'running' || data.filter === 'all') {
    summaryParts.push(`${runningCount} 运行中`)
  }
  if (data.filter === 'completed' || data.filter === 'all') {
    summaryParts.push(`${data.completedCount} 已完成`)
  }
  const summary = summaryParts.join(' · ')
  // 分隔符收紧为 " · "：frameFooter 溢出时从前截断，summary 在最前面，
  // f/x 键位加入后 80 列下过长会把计数吃掉。
  lines.push(formatFooter(`${summary} · ${compactHints([['↑↓', '选择'], ['Enter', '详情'], ['f', '切入'], ['x', '停止'], ['←/→/Tab', '筛选'], ['q/Esc', '关闭']])}`, width, theme))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── Model Picker ───────────────────────────────────────────────

export function renderModelPicker(data: ModelPickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(renderTabBar('model', width, theme))

  const innerWidth = width - 4
  const contentRows = Math.max(3, height - 4)
  const effortRows = data.effort ? 1 : 0
  const previewRows = Math.min(4, Math.max(2, contentRows - data.entries.length - 1 - effortRows))
  const listRows = Math.max(1, contentRows - previewRows - 1 - effortRows)

  const sel = data.selectedIndex
  const visible = data.entries.slice(0, listRows)
  if (data.entries.length === 0) {
    lines.push(padLine(color('  尚无已保存的 provider——运行 /connect 接入后模型会出现在这里', theme.muted), width, theme))
  }
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!
    const selected = i === sel
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const mark = e.current ? color(CURRENT_MARK, theme.primary) : ' '
    // 模型一律按原 ID 展示（alias 短名体系 2026-09 废弃——glm-53/k27-code 这类
    // 短名与真实 id 的错位曾让用户认不出自己保存的模型）。
    const idColor = selected ? color(e.id, theme.primary, { bold: true }) : color(e.id, theme.secondary)
    const providerColor = selected ? color(`[${e.provider}] `, theme.dim) : color(`[${e.provider}] `, theme.dim)
    const tokensText = e.contextWindow ? `  ${(e.contextWindow / 1000).toFixed(0)}k ctx` : ''
    const head = `${cursor} ${mark} ${providerColor}${idColor}`

    const plainHead = `  ${e.current ? '●' : ' '} [${e.provider}] ${e.id}`
    const metaRoom = Math.max(0, innerWidth - stringWidth(plainHead) - 2)
    const metaText = tokensText && metaRoom > 6 ? tokensText.slice(0, metaRoom) : ''
    lines.push(padLine(`${head}${color(metaText, theme.dim)}`, width, theme))
  }
  for (let i = visible.length; i < listRows; i++) {
    lines.push(padLine('', width, theme))
  }

  // Divider
  lines.push(padLine(` ${color('─'.repeat(Math.max(0, innerWidth - 1)), theme.dim)}`, width, theme))
  const current = data.entries[sel]
  const previewLines: string[] = []
  if (current) {
    const modelDesc = current.id.includes('pro') || current.id.includes('reasoning') || current.id.includes('o1') || current.id.includes('5.5')
      ? '性能旗舰：支持长考与高级推理，完美攻克超复杂重构与深层 Debug 任务。'
      : '极速先锋：响应灵敏、前缀缓存友好度极高，适合日常代码编写与文件级小修补。'
    const ctxText = current.contextWindow 
      ? `上下文配额: ${current.contextWindow.toLocaleString()} tokens` 
      : '上下文配额: 128k tokens'
    const features = `标识: ${current.id}`
    const wrappedDesc = wrapToWidth(modelDesc, innerWidth - 1, previewRows - 2)
    previewLines.push(color(`  ${ctxText}`, theme.primary))
    previewLines.push(color(`  ${features}`, theme.dim))
    for (const d of wrappedDesc) {
      if (previewLines.length < previewRows) {
        previewLines.push(` ${color(d, theme.muted)}`)
      }
    }
  }

  for (let i = 0; i < previewRows; i++) {
    lines.push(padLine(previewLines[i] ?? '', width, theme))
  }

  // effort 行（CC 对标）：`● high effort </> 调整`。档位着色分三层——
  // off=muted（关）、low/medium=text（常规）、high/max=primary（重档）、auto=dim；
  // 选中模型不支持时整行灰化并明说，</> 在按键层不响应。
  if (data.effort) {
    if (data.effort.supported) {
      const v = data.effort.value
      const dotColor = v === 'off' ? theme.muted : v === 'auto' ? theme.dim : (v === 'high' || v === 'max') ? theme.primary : theme.secondary
      const label = v === 'auto' ? 'auto（按任务自动）' : `${v} effort`
      lines.push(padLine(` ${color('●', dotColor)} ${color(label, v === 'off' ? theme.muted : theme.secondary)} ${color('</> 调整', theme.dim)}`, width, theme))
    } else {
      lines.push(padLine(` ${color('○ 此模型不支持推理等级调节', theme.muted)}`, width, theme))
    }
  }

  // footer：effort 行存在时才带 </> 提示（提示与可做的动作恒一致）
  const hints: Array<[string, string]> = [['←/→', '切换'], ['↑↓', '选择'], ['Enter', '设为默认'], ['s', '仅本会话']]
  if (data.effort) hints.push(['</>', '推理等级'])
  hints.push(['Esc', '取消'])
  lines.push(formatFooter(compactHints(hints), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Theme Picker ───────────────────────────────────────────────

export function renderThemePicker(data: ThemePickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(renderTabBar('theme', width, theme))

  const innerWidth = width - 4
  const contentRows = Math.max(3, height - 4)
  const previewRows = Math.min(6, Math.max(4, contentRows - data.entries.length - 1))
  const listRows = Math.max(1, contentRows - previewRows - 1)

  const sel = data.selectedIndex
  const visible = data.entries.slice(0, listRows)
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!
    const selected = i === sel
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const mark = e.current ? color(CURRENT_MARK, theme.primary) : ' '
    const defaultMark = e.isDefault ? color('★', theme.warning, { bold: true }) : ' '
    const nameColor = selected ? color(e.name, theme.primary, { bold: true }) : color(e.name, theme.secondary)
    lines.push(padLine(`${cursor} ${mark} ${defaultMark} ${nameColor}`, width, theme))
  }
  for (let i = visible.length; i < listRows; i++) {
    lines.push(padLine('', width, theme))
  }

  // Divider
  lines.push(padLine(` ${color('─'.repeat(Math.max(0, innerWidth - 1)), theme.dim)}`, width, theme))
  const current = data.entries[sel]
  const previewLines: string[] = []
  if (current) {
    // 1. Description
    const wrappedDesc = wrapToWidth(current.description, innerWidth - 1, 2)
    for (const d of wrappedDesc) {
      previewLines.push(` ${color(d, theme.muted)}`)
    }
    
    // 2. Swatch Preview!（resolveThemeEntry 同时覆盖内置与 custom: 主题）
    const targetThemeInfo = resolveThemeEntry(current.name)
    if (targetThemeInfo) {
      const tc = targetThemeInfo.truecolor
      const primarySwatch = color('● Accent', tc.primary)
      const secondarySwatch = color('● Secondary', tc.secondary)
      const successSwatch = color('✓ Success', tc.success)
      const errorSwatch = color('✗ Error', tc.error)
      const swatchLine = `  ${primarySwatch}  ${secondarySwatch}  ${successSwatch}  ${errorSwatch}`
      previewLines.push(swatchLine)
    }
  }
  
  for (let i = 0; i < previewRows; i++) {
    lines.push(padLine(previewLines[i] ?? '', width, theme))
  }

  lines.push(formatFooter(compactHints([['←/→', '切换'], ['↑↓', '选择'], ['Enter', '应用'], ['S', '设为默认'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
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
  const contentRows = Math.max(1, height - 5)
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
    if (win.start > 0) push(`   ${color(`↑ 以上还有 ${win.start} 项`, theme.muted)}`)
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

  const footer = view.kind === 'choice'
    ? compactHints([['↑↓', '选择'], ['Enter', '确认'], ['Esc', '取消']])
    : view.kind === 'multi-choice'
      ? compactHints([['↑↓', '移动'], ['空格', '勾选'], ['输入', '搜索'], ['Ctrl+A', '全选'], ['Enter', '确认'], ['Esc', '取消']])
      : view.kind === 'busy'
        ? compactHints([['Esc', '取消']])
        : view.kind === 'form'
          ? compactHints([['↑↓', '选字段'], ['←→', '移光标'], ['空格', '切换'], ['Enter', '确认'], ['Esc', '返回']])
          : compactHints([['←→', '移动'], ['Enter', '提交'], ['Esc', '取消']])
  lines.push(formatFooter(footer, width, theme, 'subtle'))
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
  const contentRows = Math.max(1, height - 5)
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
    if (win.start > 0) push(`   ${color(`↑ 以上还有 ${win.start} 项`, theme.muted)}`)
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

  const footer = view.kind === 'multi-choice'
    ? compactHints([['↑↓', '移动'], ['空格', '勾选'], ['Enter', '继续'], ['Esc', '取消']])
    : compactHints([['Enter', '执行'], ['Esc', '取消']])
  lines.push(formatFooter(footer, width, theme, 'subtle'))
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
