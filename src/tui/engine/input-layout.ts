import { ambiguousWideEnabled, displayWidth } from '../width.js'
import { ANSI } from './ansi.js'

/** In a tight decision screen, preserve permission and caret before decorative input borders. */
export function budgetInputChrome<T extends { caretCol?: number; inputLine?: number; region?: string }>(lines: T[], budget: number): T[] {
  if (lines.length <= budget) return lines
  const caret = lines.findIndex(line => line.caretCol !== undefined)
  const mode = lines.findIndex(line => line.region === 'mode')
  if (mode < 0 || caret < 0 || budget < 2) {
    const start = Math.max(0, Math.min(lines.length - budget, caret - Math.floor(budget / 2)))
    return lines.slice(start, start + budget)
  }
  const kept = new Set([mode, caret])
  const nearby = lines.map((_, i) => i).sort((a, b) => Math.abs(a - caret) - Math.abs(b - caret))
  for (const i of nearby) if (lines[i]!.inputLine !== undefined && kept.size < budget) kept.add(i)
  const borders = [caret - 1, caret + 1].filter(i => i >= 0 && i < lines.length && lines[i]!.region === 'composer')
  if (borders.length === 2 && budget - kept.size >= 2) for (const i of borders) kept.add(i)
  for (let i = lines.length - 1; i >= 0 && kept.size < budget; i--) if (lines[i]!.region !== 'composer') kept.add(i)
  return [...kept].sort((a, b) => a - b).map(i => lines[i]!)
}

/** Resolve a cell hit against the same wrap width, keeping emoji clusters atomic. */
export function inputCaretAt(value: string, line: number, column: number, width: number, cursor?: number): number {
  let segmenter: Intl.Segmenter | undefined
  try { segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' }) } catch { /* code-point fallback */ }
  let offset = 0
  const parts = segmenter ? Array.from(segmenter.segment(value)) : Array.from(value).map(segment => {
    const part = { segment, index: offset }; offset += segment.length; return part
  })
  let row = 0, col = 0
  const hit = (text: string, index: number): number | undefined => {
    const cells = Math.max(1, displayWidth(text, { ambiguousAsWide: ambiguousWideEnabled() }))
    if (col > 0 && col + cells > width) { row++; col = 0 }
    if (row > line || row === line && column < col + cells) return index
    col += cells
    return undefined
  }
  for (const part of parts) {
    if (part.segment === '\n') { if (row >= line) return part.index; row++; col = 0; continue }
    const result = hit(part.segment, part.index)
    if (result !== undefined) return result
  }
  return value.length
}

interface VisualLine {
  text: string
  cursor: boolean
}

export function inputDisplayWidth(text: string, ambiguousAsWide: boolean): number {
  return displayWidth(text, { ambiguousAsWide })
}

function pushWrappedSegment(
  out: VisualLine[],
  segment: string,
  prefix: string,
  maxContentWidth: number,
  cursorOffset: number | null,
  ambiguousAsWide: boolean,
  /** 输出参数：记录光标插入点左侧的 cell 数（不含前缀，零位移硬件光标）。仅在光标命中行写入。 */
  caretCol?: { value: number },
  /** segment 在 buffer 中的绝对起始偏移（选区高亮定位用）。 */
  segAbsStart?: number,
  /** 键盘选区（buffer 绝对偏移，start<end）：范围内字符反色渲染。 */
  sel?: { start: number; end: number } | null,
  softwareCursor = false,
): void {
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(segment), part => part.segment)
  let current = ''
  let currentWidth = 0
  let currentHasCursor = false
  let offset = 0
  let inSel = false

  const flush = (): void => {
    // 选区跨越折行边界：本行末 RESET 封口，下一视觉行重新 REVERSE 起头。
    out.push({ text: `${prefix}${current}${inSel ? ANSI.RESET : ''}`, cursor: currentHasCursor })
    current = inSel ? ANSI.REVERSE : ''
    currentWidth = 0
    currentHasCursor = false
  }

  for (const ch of chars) {
    const absOff = (segAbsStart ?? 0) + offset
    if (sel && inSel && absOff === sel.end) { current += ANSI.RESET; inSel = false }
    if (sel && !inSel && absOff === sel.start) { current += ANSI.REVERSE; inSel = true }
    if (cursorOffset !== null && cursorOffset >= offset && cursorOffset < offset + ch.length) {
      if (caretCol) caretCol.value = currentWidth
      currentHasCursor = true
      if (softwareCursor) {
        const markerWidth = inputDisplayWidth('█', ambiguousAsWide)
        if (currentWidth > 0 && currentWidth + markerWidth > maxContentWidth) flush()
        current += '█'
        currentWidth += markerWidth
      }
    }

    const chWidth = Math.max(1, inputDisplayWidth(ch, ambiguousAsWide))
    if (currentWidth > 0 && currentWidth + chWidth > maxContentWidth) flush()
    current += ch
    currentWidth += chWidth
    offset += ch.length
  }

  if (cursorOffset !== null && cursorOffset === segment.length) {
    const absOff = (segAbsStart ?? 0) + offset
    if (sel && inSel && absOff === sel.end) { current += ANSI.RESET; inSel = false }
    if (sel && !inSel && absOff === sel.start) { current += ANSI.REVERSE; inSel = true }
    if (caretCol) caretCol.value = currentWidth
    currentHasCursor = true
    if (softwareCursor) {
      const markerWidth = inputDisplayWidth('█', ambiguousAsWide)
      if (currentWidth > 0 && currentWidth + markerWidth > maxContentWidth) flush()
      current += '█'
      currentWidth += markerWidth
    }
  }

  if (currentWidth > 0 || currentHasCursor || segment.length === 0) flush()
}

export function wrapInputLines(value: string, cursor: number, maxWidth: number, sel?: { start: number; end: number } | null, softwareCursor = false): { lines: string[]; cursorLine: number; cursorCol: number } {
  const ambiguousAsWide = ambiguousWideEnabled()
  const visual: VisualLine[] = []
  const logicalLines = value.split('\n')
  const prefixWidth = inputDisplayWidth('❯ ', ambiguousAsWide)
  const maxContentWidth = Math.max(1, maxWidth - prefixWidth)
  let cursorLine = 0
  let cursorCol = prefixWidth
  let absoluteOffset = 0

  for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex++) {
    const logicalLine = logicalLines[lineIndex]!
    const lineStart = absoluteOffset
    const lineEnd = lineStart + logicalLine.length
    const cursorInLine = cursor >= lineStart && cursor <= lineEnd
    const prefix = cursorInLine ? '❯ ' : '  '
    const beforeCount = visual.length
    const caretCol: { value: number } = { value: 0 }
    pushWrappedSegment(visual, logicalLine, prefix, maxContentWidth, cursorInLine ? cursor - lineStart : null, ambiguousAsWide, caretCol, lineStart, sel, softwareCursor)
    if (cursorInLine) {
      const found = visual.findIndex((line, idx) => idx >= beforeCount && line.cursor)
      cursorLine = found >= 0 ? found : beforeCount
      cursorCol = prefixWidth + caretCol.value
    }
    absoluteOffset = lineEnd + 1
  }

  return { lines: visual.map(line => line.text), cursorLine, cursorCol }
}

export function viewportWithCaret(lines: string[], cursorLine: number, maxLines?: number): { lines: string[]; caretLine: number } {
  if (maxLines === undefined || lines.length <= maxLines) {
    return { lines, caretLine: Math.min(Math.max(cursorLine, 0), lines.length - 1) }
  }
  const max = Math.max(1, Math.floor(maxLines))
  const cursor = Math.min(Math.max(cursorLine, 0), lines.length - 1)
  if (max === 1) return { lines: [lines[cursor]!], caretLine: 0 }
  if (max === 2) {
    return cursor < lines.length - 1
      ? { lines: [lines[cursor]!, `… ${lines.length - cursor - 1} lines below`], caretLine: 0 }
      : { lines: [`… ${cursor} lines above`, lines[cursor]!], caretLine: 1 }
  }

  const hasAbove = cursor > 0
  const hasBelow = cursor < lines.length - 1
  const contentSlots = Math.max(1, max - (hasAbove ? 1 : 0) - (hasBelow ? 1 : 0))
  const minStart = hasAbove ? 1 : 0
  const maxStart = hasBelow
    ? Math.max(minStart, lines.length - 1 - contentSlots)
    : Math.max(minStart, lines.length - contentSlots)
  const centeredStart = cursor - Math.floor(contentSlots / 2)
  const start = Math.min(Math.max(centeredStart, minStart), maxStart)
  const visible = lines.slice(start, start + contentSlots)

  return {
    lines: [
      ...(hasAbove ? [`… ${start} lines above`] : []),
      ...visible,
      ...(hasBelow ? [`… ${lines.length - (start + contentSlots)} lines below`] : []),
    ],
    caretLine: (hasAbove ? 1 : 0) + (cursor - start),
  }
}
