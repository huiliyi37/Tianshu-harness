import { budgetInputChrome } from './input-layout.js'
import { padDynamicRegion, type LiveRegionLine } from './live-engine.js'
import { wrapViewportText } from './conversation-viewport.js'

export interface PinnedViewportOptions {
  rows: number
  /** Already committed text projected into the frame; never sent back to CommitEngine. */
  historyLines?: readonly string[]
  rowsForLine?: (text: string) => number
}

export interface CommittedHistorySource {
  readonly revision: number
  getContentSince(revision: number): string
}

/** Cache a read-only history tail; clearing changes the display boundary, never the pager history. */
export class CommittedHistoryViewport {
  private source?: CommittedHistorySource
  private afterRevision = 0
  private cached?: { revision: number; columns: number; rows: number; lines: readonly string[] }

  clear(revision: number): void {
    this.afterRevision = revision
    this.cached = undefined
  }

  /** Columns are the terminal's full width; leave its final cell free of history text. */
  project(history: CommittedHistorySource, columns: number, rows: number): readonly string[] {
    if (this.source !== history) {
      if (this.source) this.afterRevision = 0
      this.source = history
      this.cached = undefined
    }
    const revision = history.revision
    if (this.cached?.revision === revision && this.cached.columns === columns && this.cached.rows === rows) return this.cached.lines
    const content = revision > this.afterRevision && rows > 0 ? history.getContentSince(this.afterRevision) : ''
    const lines = projectCommittedHistory(content, Math.max(1, columns - 1), rows)
    this.cached = { revision, columns, rows, lines }
    return lines
  }
}

/** Rewrap only the newest committed logical lines needed by the visible viewport. */
export function projectCommittedHistory(content: string, width: number, rows: number): string[] {
  const budget = Math.max(0, Math.floor(rows))
  if (!content || !budget) return []
  const logical = content.split('\n')
  const suffix = logical.slice(-budget).join('\n')
  const prefix = content.slice(0, content.length - suffix.length)
  const reset = prefix.lastIndexOf('\x1b[0m')
  let styles = ''
  // SGR controls intentionally carry an existing color across the visible tail boundary.
  // eslint-disable-next-line no-control-regex
  for (const match of prefix.slice(reset < 0 ? 0 : reset + 4).matchAll(/\x1b\[[\d;]*m/g)) styles += match[0]
  return wrapViewportText(styles + suffix, width).slice(-budget)
}

/**
 * A normal-buffer viewport: fixed prompt first, recent committed history in the
 * middle, live activity and the composer last. It emits no terminal controls or
 * history writes; LiveEngine retains ownership of anchoring and scrollback.
 */
export function layoutPinnedViewport(
  lines: readonly LiveRegionLine[],
  chromeStart: number,
  options: PinnedViewportOptions,
): { lines: LiveRegionLine[]; chromeStart: number } {
  const height = Math.max(1, Math.floor(options.rows))
  const cost = (line: LiveRegionLine): number => Math.max(1, Math.ceil(options.rowsForLine?.(line.text) ?? 1))
  const size = (part: readonly LiveRegionLine[]): number => part.reduce((total, line) => total + cost(line), 0)
  const dynamic = lines.slice(0, chromeStart)
  const chrome = lines.slice(chromeStart)
  const caret = chrome.find(line => line.caretCol !== undefined)
  const minChrome = Math.min(size(chrome), caret ? cost(caret) : Math.min(1, size(chrome)))

  // Only a screen too short for both the prompt and caret may omit the prompt.
  const pinned: LiveRegionLine[] = []
  let pinnedRows = 0
  for (const line of dynamic.filter(line => line.livePart === 'pinned')) {
    if (pinnedRows + cost(line) > height - minChrome) break
    pinned.push(line)
    pinnedRows += cost(line)
  }
  const body = dynamic.filter(line => line.livePart !== 'pinned')
  const required = size(body.filter(line => line.decisionPart || line.caretCol !== undefined))
  const available = height - pinnedRows
  const chromeBudget = Math.min(size(chrome), Math.max(minChrome, available - Math.min(required, available - minChrome)))
  let chromeCount = Math.min(chrome.length, chromeBudget)
  let keptChrome = budgetInputChrome(chrome, chromeCount)
  while (size(keptChrome) > chromeBudget && chromeCount > 0) keptChrome = budgetInputChrome(chrome, --chromeCount)

  const bodySpace = Math.max(0, available - size(keptChrome))
  const protectedBodyRows = size(body.filter(line => line.decisionPart || line.caretCol !== undefined || line.livePart === 'status' || line.livePart === 'disclosure'))
  const historyReserve = options.historyLines?.length && bodySpace >= protectedBodyRows + 3 ? 3 : 0
  const bodyBudget = Math.min(size(body), Math.max(0, bodySpace - historyReserve))
  let keptBody: LiveRegionLine[] = []
  if (bodyBudget > 0) {
    if (required <= bodyBudget) {
      keptBody = padDynamicRegion(body, body.length, bodyBudget, text => cost({ text })).lines
    } else {
      // In a very short decision screen, the edit caret and actions precede facts.
      const priority = (line: LiveRegionLine): number => line.caretCol !== undefined ? 0
        : line.decisionPart === 'action' ? 1 : line.decisionPart === 'title' ? 2
        : line.decisionPart === 'fact' ? 3 : line.decisionPart ? 4 : 5
      const selected = new Set<number>()
      let used = 0
      for (const { line, index } of body.map((line, index) => ({ line, index })).sort((a, b) => priority(a.line) - priority(b.line) || a.index - b.index)) {
        if (used + cost(line) <= bodyBudget) { selected.add(index); used += cost(line) }
      }
      keptBody = body.filter((_, index) => selected.has(index))
    }
  }

  const gap = Math.max(0, bodySpace - size(keptBody))
  const history: LiveRegionLine[] = []
  let historyRows = 0
  for (let i = (options.historyLines?.length ?? 0) - 1; i >= 0; i--) {
    const line = { text: options.historyLines![i]! }
    if (historyRows + cost(line) > gap) break
    history.unshift(line)
    historyRows += cost(line)
  }
  const padding = Array.from({ length: Math.max(0, gap - size(history)) }, () => ({ text: '' }))
  const beforeChrome = [...pinned, ...history, ...padding, ...keptBody]
  return { lines: [...beforeChrome, ...keptChrome], chromeStart: beforeChrome.length }
}
