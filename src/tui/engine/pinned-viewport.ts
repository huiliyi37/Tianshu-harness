/**
 * 全高钉住视口（classic 非读屏模式）——把整帧按终端实际高度分区：
 * 顶部指令摘要（pinned）→ 近期已提交历史的只读投影 → 实时动态段 → 底部输入区。
 *
 * 取代旧的「底部定高 live region + padDynamicRegion 高水位」模型：摘要此前只是
 * live region 内第一行，长会话滚屏后悬在窗口中下部；纯高度 resize 也没有失效
 * 路径。本模块只产出帧内容（不发终端控制序列、不写历史），锚定与 scrollback
 * 纪律仍归 LiveEngine/CommitEngine。
 *
 * 历史投影经 revision 缓存（ticker 每帧命中），/clear 与会话切换只移动显示
 * 边界（afterRevision），pager 读的原始历史不动。
 */
import { budgetInputChrome } from './input-layout.js'
import { padDynamicRegion, type LiveRegionLine } from './live-engine.js'
import { wrapViewportText } from './conversation-viewport.js'

export interface PinnedViewportOptions {
  rows: number
  /** 已提交文本的帧内投影；绝不再回交 CommitEngine。 */
  historyLines?: readonly string[]
  rowsForLine?: (text: string) => number
}

export interface CommittedHistorySource {
  readonly revision: number
  getContentSince(revision: number): string
}

/** 只读历史尾部缓存；clear 只改显示边界，绝不碰 pager 历史。 */
export class CommittedHistoryViewport {
  private source?: CommittedHistorySource
  private afterRevision = 0
  private cached?: { revision: number; columns: number; rows: number; lines: readonly string[] }

  clear(revision: number): void {
    this.afterRevision = revision
    this.cached = undefined
  }

  /** columns 用终端全宽；历史文本留出最后一格（末列写入会触发部分终端折行）。 */
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

/** 只回绕可见视口所需的最新若干条已提交逻辑行（旧内容不重算）。 */
export function projectCommittedHistory(content: string, width: number, rows: number): string[] {
  const budget = Math.max(0, Math.floor(rows))
  if (!content || !budget) return []
  const logical = content.split('\n')
  const suffix = logical.slice(-budget).join('\n')
  const prefix = content.slice(0, content.length - suffix.length)
  const reset = prefix.lastIndexOf('\x1b[0m')
  let styles = ''
  // 可见尾部开头要延续边界处仍未关闭的 SGR 样式（颜色跨截断点不断色）。
  // eslint-disable-next-line no-control-regex
  for (const match of prefix.slice(reset < 0 ? 0 : reset + 4).matchAll(/\x1b\[[\d;]*m/g)) styles += match[0]
  return wrapViewportText(styles + suffix, width).slice(-budget)
}

/**
 * normal-buffer 视口布局：首行固定摘要、中部近期已提交历史、
 * 实时活动与输入区居底。不输出终端控制、不写历史——
 * 锚定与 scrollback 归 LiveEngine 所有。
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

  // 只有矮到摘要与 caret 不可兼得的屏幕才允许省略摘要。
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
      // 极矮决策屏：编辑 caret 与操作按钮优先于事实行。
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
