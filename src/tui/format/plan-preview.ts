import type { RivetTheme } from '../theme.js'
import { ANSI_SEQ_RE } from '../engine/ansi.js'
import { formatMarkdown } from './markdown.js'
import { frameInset } from './overlay-frame.js'
import { wrapReadingText } from './reading-layout.js'

interface ReadAnchor { line: number; offset: number }

/** Keep logical text separate from terminal wrapping for search and resize. */
export function preparePlanPreview(content: string, columns: number, theme: RivetTheme) {
  const width = Math.max(1, columns - frameInset(columns) * 2 - 1)
  const logical = formatMarkdown({ text: content, columns: width, fullDocument: true, wrapText: false }, theme)
    .map(text => ({ text, plain: text.replace(ANSI_SEQ_RE, '') }))
  const rows: string[] = [], anchors: ReadAnchor[] = []
  for (const [line, source] of logical.entries()) {
    let offset = 0
    for (const row of wrapReadingText(source.text, width)) {
      const plain = row.replace(ANSI_SEQ_RE, '')
      const start = source.plain.indexOf(plain, offset)
      anchors.push({ line, offset: start < 0 ? offset : start })
      rows.push(row)
      offset = (start < 0 ? offset : start) + plain.length
    }
  }
  const rowForAnchor = (anchor: ReadAnchor): number => {
    let row = 0
    for (const [index, current] of anchors.entries()) {
      if (current.line > anchor.line || current.line === anchor.line && current.offset > anchor.offset) break
      row = index
    }
    return row
  }
  return {
    content: rows.join('\n'),
    anchorAt: (row: number): ReadAnchor => anchors[Math.min(Math.max(0, row), anchors.length - 1)] ?? { line: 0, offset: 0 },
    rowForAnchor,
    searchRows: (query: string): number[] => query ? logical.flatMap((line, index) => {
      const offset = line.plain.toLowerCase().indexOf(query.toLowerCase())
      return offset < 0 ? [] : [rowForAnchor({ line: index, offset })]
    }) : [],
  }
}
