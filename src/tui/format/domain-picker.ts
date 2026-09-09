/**
 * Domain Picker overlay 渲染——从 overlay.ts 沿接缝拆分（overlay.ts 行数棘轮）。
 *
 * 列表（cursor + current 标记 + 星名 + 工程别名 + 职责标语）→ 分隔线 →
 * 详情区（别名徽章 / 职责标语+创始星 / motto / 提示词精华 essence 多行）。
 * 列表带滚动窗口（scrollWindowWithIndicators）：选中项恒可见，截断处留指示行。
 * 应用后只写单行确认，完整方法论照常由引擎注入（UI 不转储 volatileBlock）。
 */
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { DOMAIN_SWITCH_CACHE_NOTE } from '../../agent/domain-picker-entries.js'
import {
  frameTop as formatBorder,
  frameBottom as formatBottomBorder,
  frameFooter as formatFooter,
  frameLine as padLine,
  CURSOR,
} from './overlay-frame.js'
import {
  compactHints,
  renderTabBar,
  wrapToWidth,
  scrollWindowWithIndicators,
} from './overlay.js'

export interface DomainPickerEntry {
  /** 选择键：'auto' | domain id */
  key: string
  /** 展示名（中文星域名或 Auto 标签） */
  name: string
  /** 座右铭（可空） */
  motto: string
  /** 工程别名（如 晨光向导）——custom 域缺省时回退 tagline */
  alias?: string
  /** 职责标语（如 破夜指引 · 洞察全景）——缺省时回退 motto */
  tagline?: string
  /** 次要元信息（dim）：decisionStyle · keywords */
  meta: string
  /** 选中项的一段式 essence 预览（不转储整段 volatileBlock） */
  essence: string
  /** 创始星短名（来自 star-genesis-data；auto / custom 域缺省） */
  founder?: string
  /** 一句话核心专长（来自 star-genesis-data；auto / custom 域缺省） */
  expertise?: string
  /** 是否为当前生效项 */
  current: boolean
  uiPersona?: {
    separator: 'thin' | 'thick' | 'dots'
    accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
    glyph: string
  }
}

export interface DomainPickerData {
  entries: DomainPickerEntry[]
  selectedIndex: number
}

/**
 * 渲染 Domain Picker overlay（CC 风星域选择器）。
 */
export function renderDomainPicker(data: DomainPickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(renderTabBar('domain', width, theme))

  const innerWidth = width - 4 // padLine 占 2，左右各留 1 空隙
  const contentRows = Math.max(3, height - 4) // border + title + footer + bottom
  // 详情区（提示词精华）上限 8 行，随 contentRows 收缩（下限 1：徽章行）——
  // 保证 listRows + detailRows + 固定 6 行 ≤ height，矮终端不超屏（2026-08 回归）。
  const detailRows = Math.min(8, Math.max(1, contentRows - 6))
  const listRows = Math.max(1, contentRows - detailRows - 2) // 分隔线 + 缓存备注行

  const sel = data.selectedIndex
  const current = data.entries[sel]
  const currentAccentKey = current?.uiPersona?.accent ?? 'primary'
  const currentAccent = (theme as any)[currentAccentKey] ?? theme.primary

  // 列表滚动窗口：选中项恒可见，截断处留指示行（指示行仅在行数装得下时显示，
  // 防矮终端 listRows=1 时 ↑+选中+↓ 撑破预算——2026-08 超屏回归）。
  const win = scrollWindowWithIndicators(data.entries.map(() => 1), sel, listRows)
  const winRows = win.end - win.start
  let row = 0
  if (win.start > 0 && row + 1 + winRows <= listRows) {
    lines.push(padLine(` ${color('↑ 更多', theme.dim)}`, width, theme))
    row++
  }
  for (let i = win.start; i < win.end; i++) {
    const e = data.entries[i]!
    const selected = i === sel
    const eAccentKey = e.uiPersona?.accent ?? 'primary'
    const eAccent = (theme as any)[eAccentKey] ?? theme.primary
    const eGlyph = e.uiPersona?.glyph ?? '●'

    const cursor = selected ? color(CURSOR, currentAccent, { bold: true }) : ' '
    const mark = e.current ? color(eGlyph, eAccent, { bold: true }) : selected ? color(eGlyph, currentAccent) : color(eGlyph, theme.dim)
    const name = selected ? color(e.name, currentAccent, { bold: true }) : color(e.name, theme.secondary)
    // 行内：工程别名 + 职责标语——一眼看懂这颗星干什么；创始星移入详情区。
    const alias = e.alias ? color(` · ${e.alias}`, theme.muted) : ''
    const tagline = e.tagline ? color(`  ${e.tagline}`, theme.dim) : ''
    const head = `${cursor} ${mark} ${name}${alias}${tagline}`
    lines.push(padLine(head, width, theme))
    row++
  }
  if (win.end < data.entries.length && row + 1 <= listRows) {
    lines.push(padLine(` ${color('↓ 更多', theme.dim)}`, width, theme))
    row++
  }
  for (; row < listRows; row++) {
    lines.push(padLine('', width, theme))
  }

  // 分隔线自适应强调色与样式
  const sepChar = current?.uiPersona?.separator === 'dots'
    ? '·'
    : current?.uiPersona?.separator === 'thick'
      ? '━'
      : '─'
  lines.push(padLine(` ${color(sepChar.repeat(Math.max(0, innerWidth - 1)), currentAccent)}`, width, theme))

  // 详情区：别名徽章 → 职责标语 + 创始星 → motto → 提示词精华（essence 多行）
  const previewLines: string[] = []
  if (current) {
    const glyph = current.uiPersona?.glyph ?? '●'
    const aliasPart = current.alias ? ` · ${current.alias}` : ''
    previewLines.push(color(`  ${glyph}  ${current.name}${aliasPart}`, currentAccent, { bold: true }))

    const founderPart = current.founder ? ` · 创始星 ${current.founder}` : ''
    const taglineText = current.tagline ? `${current.tagline}${founderPart}` : (current.founder ? `创始星 ${current.founder}` : (current.meta || ''))
    previewLines.push(` ${color(taglineText, theme.muted)}`)

    previewLines.push(` ${color(`「${current.motto}」`, theme.dim)}`)
    previewLines.push(` ${color('─'.repeat(Math.max(0, innerWidth - 2)), theme.dim)}`)

    // 提示词精华：motto + volatileBlock 首行（entry.essence），按宽折行填满剩余详情区
    const desc = current.essence || current.expertise || ''
    const wrappedDesc = wrapToWidth(desc, innerWidth - 1, Math.max(1, detailRows - previewLines.length))
    for (const d of wrappedDesc) {
      if (previewLines.length < detailRows) {
        previewLines.push(` ${color(d, theme.muted)}`)
      }
    }
  }

  for (let i = 0; i < detailRows; i++) {
    lines.push(padLine(previewLines[i] ?? '', width, theme))
  }

  // 常驻备注：切换星域的缓存代价（预防性提示，切换后的忠告见 slash-commands）。
  lines.push(padLine(` ${color(DOMAIN_SWITCH_CACHE_NOTE, theme.dim)}`, width, theme))

  lines.push(formatFooter(compactHints([['←/→', '切换'], ['↑↓', '选择'], ['Enter', '应用'], ['g', '碑文'], ['S', '设为默认'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}
