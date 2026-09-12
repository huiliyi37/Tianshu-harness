/**
 * 显示宽度度量 — 解决 string-width 的窄宽假设与终端实际渲染的错位。
 *
 * 背景：`string-width` 把 East-Asian **Ambiguous** 字符（如 `—` `…` `↑↓` `·`）
 * 一律按 1 列计；但很多终端（尤其 CJK 环境/字体）把这些符号按 2 列渲染。
 * LiveEngine 据 string-width 估算每行占几个显示行（`rowsForLine`），低估后
 * 相对光标回顶量不足 → 旧帧顶部泄漏进 scrollback（输入框重影/重叠）。
 *
 * 关键陷阱：Unicode 把 **box-drawing / block**（U+2500–U+259F，如 `─ │ ╭ █`）
 * 也归为 ambiguous，但 xterm 系终端普遍按 **1 列** 渲染它们。若把所有 ambiguous
 * 当宽，会把输入框边框算成双宽 → over-erase 反噬 scrollback。因此 wide 模式只对
 * **非 box/block 的 ambiguous 符号** 叠加 +1 宽度增量。
 *
 * 但 Windows legacy conhost（GBK 中文字体）连框线字符也按 **2 列** 渲染——
 * wide 档在那里仍会低估边框行宽度 → 折行 → 回顶欠擦。为此增设 **full 档**：
 * box/block 一并 +1。三档语义：
 * - narrow：= string-width（默认，xterm 系）
 * - wide：非 box/block 的 ambiguous +1（CJK xterm 终端）
 * - full：所有 ambiguous 含 box/block +1（legacy CJK conhost，自动探测默认）
 *
 * 度量建立在 `string-width` 之上（继承其对 emoji/ZWJ/组合符/控制符的正确处理），
 * narrow 模式与 string-width 完全一致（零回归）。
 */

import stringWidth from 'string-width'
import { eastAsianWidthType } from 'get-east-asian-width'
import { isLegacyCjkConsole } from './term-caps.js'

// CSI（\x1B[…m 等）+ OSC（\x1B]…BEL / …ST，含 OSC 8 超链接）。OSC 的 payload
// 是可打印 ASCII（URL），若只剥 CSI 会把 URL 当可见字符计宽 → 截断/padding 错位。
const ANSI_RE = /\x1B(?:\[[0-9;]*[a-zA-Z]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g
/** 黏附匹配（按位置）用于截断时识别转义序列。 */
const ANSI_STICKY = /\x1B(?:\[[0-9;]*[a-zA-Z]|\][^\x07\x1B]*(?:\x07|\x1B\\))/y
const RESET = '\x1B[0m'
const OSC8_OPEN_RE = /\x1B\]8;[^\x07\x1B]*(?:\x07|\x1B\\)/g
const OSC8_CLOSE = '\x1B]8;;\x07'

/** box-drawing（U+2500–257F）与 block elements（U+2580–259F）：终端均按 1 列渲染。 */
function isBoxOrBlock(cp: number): boolean {
  return cp >= 0x2500 && cp <= 0x259f
}

/** 一个 code point 在 wide/full 模式下相对 string-width 的额外宽度（0 或 1）。 */
function ambiguousExtraForCp(cp: number): number {
  if (isBoxOrBlock(cp)) return ambiguousWidthMode() === 'full' ? 1 : 0
  return eastAsianWidthType(cp) === 'ambiguous' ? 1 : 0
}

/** 去掉 ANSI 后逐 code point 累计的 ambiguous 额外宽度。 */
function ambiguousExtra(plain: string): number {
  let extra = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    extra += ambiguousExtraForCp(cp)
  }
  return extra
}

export type AmbiguousWidthMode = 'narrow' | 'wide' | 'full'

let detectedModeCache: AmbiguousWidthMode | null = null

/**
 * 宽度模式：env `RIVET_AMBIGUOUS_WIDTH` 显式值优先（narrow/wide/full），
 * 未设时按终端探测——legacy CJK conhost（GBK 字体连框线都按 2 列渲染）
 * 默认 full，其余平台默认 narrow（与历史行为一致）。
 */
export function ambiguousWidthMode(): AmbiguousWidthMode {
  const env = (process.env.RIVET_AMBIGUOUS_WIDTH ?? '').toLowerCase()
  if (env === 'wide') return 'wide'
  if (env === 'full') return 'full'
  if (env === 'narrow') return 'narrow'
  if (detectedModeCache === null) {
    detectedModeCache = isLegacyCjkConsole() ? 'full' : 'narrow'
  }
  return detectedModeCache
}

/** 兼容旧布尔口径：wide 或 full 均视为启用（消费方只区分「是否加宽」）。 */
export function ambiguousWideEnabled(): boolean {
  return ambiguousWidthMode() !== 'narrow'
}

/** 测试钩子：重置探测缓存。 */
export function resetWidthModeCache(): void {
  detectedModeCache = null
}

export interface DisplayWidthOptions {
  /** 把非 box/block 的 ambiguous 符号按 2 列计。默认 false（= string-width 行为）。 */
  ambiguousAsWide?: boolean
}

/** 文本的显示宽度（已忽略 ANSI 转义）。 */
export function displayWidth(text: string, opts: DisplayWidthOptions = {}): number {
  const plain = text.replace(ANSI_RE, '')
  const base = stringWidth(plain)
  if (!opts.ambiguousAsWide) return base
  return base + ambiguousExtra(plain)
}

/**
 * 按显示宽度硬折行（纯文本 → 若干段，每段 ≤ max 显示列）。
 *
 * 与 truncateToDisplayWidth 同源的逐 code point 度量（wide 上界可选），但不丢
 * 内容：放不下的字符整体挪到下一段。输入必须是 ANSI-free 纯文本（thinking 正文、
 * 流式 tail 均为纯文本，着色在分段之后施加）。
 *
 * 用途：live region 的多行内容在源头折好行，使每段在任何终端（narrow/wide
 * ambiguous 渲染）都恰占 1 显示行——引擎 rowsForLine 因此恒与实际行数一致，
 * cursorUp 回顶不再欠行（spinner 残影根修，见 live-engine-ghost-render 测试）。
 * 零宽字符（组合符/VS16/ZWJ）计 0 宽，永远黏附所在段，不会落到段首。
 */
export function hardWrapToDisplayWidth(text: string, max: number, opts: DisplayWidthOptions = {}): string[] {
  if (max <= 0) return [text]
  if (displayWidth(text, opts) <= max) return [text]
  const wide = !!opts.ambiguousAsWide
  const segments: string[] = []
  let current = ''
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    let cw = stringWidth(ch)
    if (wide) cw += ambiguousExtraForCp(cp)
    if (cw > 0 && w + cw > max && current !== '') {
      segments.push(current)
      current = ''
      w = 0
    }
    current += ch
    w += cw
  }
  if (current !== '') segments.push(current)
  return segments
}

/**
 * 按显示宽度截断（ANSI 安全：转义序列原样保留、不计宽；截断发生时补一个 RESET
 * 防止颜色泄漏到后续行）。已在预算内则原样返回。
 */
export function truncateToDisplayWidth(text: string, max: number, opts: DisplayWidthOptions = {}): string {
  if (max <= 0) return ''
  if (displayWidth(text, opts) <= max) return text
  const wide = !!opts.ambiguousAsWide
  let out = ''
  let w = 0
  let i = 0
  let sawAnsi = false
  while (i < text.length) {
    ANSI_STICKY.lastIndex = i
    const m = ANSI_STICKY.exec(text)
    if (m && m.index === i) {
      out += m[0]
      i += m[0].length
      sawAnsi = true
      continue
    }
    const cp = text.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    let cw = stringWidth(ch)
    if (wide) cw += ambiguousExtraForCp(cp)
    if (w + cw > max) break
    out += ch
    w += cw
    i += ch.length
  }
  if (!sawAnsi) return out
  // OSC 8 链接开在截断点之前、闭在截断点之后时补闭合，防止链接吞掉后续输出。
  const oscSeqs = out.match(OSC8_OPEN_RE) ?? []
  const lastOsc = oscSeqs[oscSeqs.length - 1]
  const unclosedLink = lastOsc !== undefined && !/^\x1B\]8;;(?:\x07|\x1B\\)$/.test(lastOsc)
  return unclosedLink ? out + OSC8_CLOSE + RESET : out + RESET
}
