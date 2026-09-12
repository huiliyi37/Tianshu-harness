/**
 * T9 StreamRenderer — 流式 Markdown 增量渲染（Claude Code StreamingMarkdown 模型）。
 *
 * 职责：
 * - 接收 BlockStreamWriter 吐出的节流文本块，累积到 pending 缓冲区。
 * - 在「最后一个稳定的顶层 block 边界」切分：空行结束的段落、闭合的 ``` 围栏。
 * - 稳定前缀立即经 formatMarkdown 渲染后 commit 到 scrollback（不可回退）。
 * - 尾部不完整 block 留在 pending，由 live 区以原始文本渲染（display-width
 *   aware tail-cap，避免 CJK 宽字符截断错位）。
 * - 围栏代码块流式期间不解析高亮（防闪烁）：未闭合的 ``` 内容停留在 pending，
 *   闭合后整块作为稳定前缀高亮 commit。
 *
 * 数据流：
 *   onTextDelta → BlockStreamWriter（节流）→ StreamRenderer.push
 *     ├── 稳定 block → formatMarkdown → commit(scrollback)
 *     └── 尾部不完整 block → getLiveTail → LiveEngine 底部重绘
 */

import { formatMarkdown } from '../format/markdown.js'
import { capLiveTailMarkdownSafe } from '../live-tail-cap.js'
import { hardWrapToDisplayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'
import type { TuiPerfMonitor } from './perf-monitor.js'

/**
 * 找到文本中最后一个稳定的顶层 block 边界（fence-aware）。
 *
 * 边界定义（均为「该行结尾、含换行符」的 offset）：
 * - 围栏外的空行（段落/列表/标题等 block 在空行处结束）
 * - 闭合的 ``` 围栏行（整个代码块完整，可安全高亮）
 *
 * 围栏内部的空行不算边界（代码块未闭合时不可切分）。
 * 最后一行（可能无尾随换行、仍在增长）永不参与判定。
 *
 * @returns 切割 offset；0 表示尚无稳定边界
 */
export function findStableBoundary(text: string): number {
  let inFence = false
  let lastBoundary = 0
  let offset = 0
  const lines = text.split('\n')

  // lines.length - 1: 最后一段（split 后的尾元素）要么是不完整的行，
  // 要么是空字符串（文本以 \n 结尾）——都不参与边界判定。
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!
    const lineEnd = offset + line.length + 1 // 含 '\n'
    if (line.startsWith('```')) {
      inFence = !inFence
      if (!inFence) lastBoundary = lineEnd // 围栏闭合 → 代码块完整
    } else if (!inFence && line.trim() === '') {
      lastBoundary = lineEnd // 围栏外空行 → 上方 block 完整
    }
    offset = lineEnd
  }
  return lastBoundary
}

export interface StreamRendererOptions {
  /** 将渲染好的 ANSI 多行文本 commit 到 scrollback */
  commit: (ansi: string) => void
  /** 终端列数（动态读取，resize 安全） */
  getColumns: () => number
  /** 主题读取函数（动态，切主题后新 block 立即生效） */
  getTheme: () => RivetTheme
  /** Explicit stable identity; theme objects are deliberately not serialized. */
  getThemeKey: () => string
  /** Optional cache instrumentation hook. Oversized segments do not emit events. */
  onCacheResult?: (hit: boolean) => void
  perfMonitor?: TuiPerfMonitor
}

export class StreamRenderer {
  private static readonly CACHE_MAX_ENTRIES = 64
  private static readonly CACHE_MAX_TEXT = 16 * 1024
  private pending = ''
  private committedAny = false
  private readonly options: StreamRendererOptions
  private readonly stableCache = new Map<string, string>()

  constructor(options: StreamRendererOptions) {
    this.options = options
  }

  /** 是否已有任何内容 commit 到 scrollback（用于 header 等一次性输出判定） */
  get hasCommitted(): boolean {
    return this.committedAny
  }

  /** 是否持有任何内容（pending 或已 commit） */
  get hasContent(): boolean {
    return this.committedAny || this.pending.length > 0
  }

  /** 当前未 commit 的尾部文本 */
  get pendingText(): string {
    return this.pending
  }

  /** 累积流式文本块；返回本次是否同步 commit 了稳定前缀。 */
  push(chunk: string): boolean {
    if (!chunk) return false
    this.pending += chunk
    const cut = findStableBoundary(this.pending)
    if (cut > 0) {
      const stable = this.pending.slice(0, cut)
      this.pending = this.pending.slice(cut)
      return this.commitText(stable)
    }
    return false
  }

  /**
   * 流结束：把剩余 pending 全部渲染 commit。
   * @returns 本轮是否输出过任何内容
   */
  finalize(): boolean {
    if (this.pending.trim().length > 0) {
      this.commitText(this.pending)
    }
    this.pending = ''
    const had = this.committedAny
    this.committedAny = false
    return had
  }

  /** 丢弃所有状态（abort 场景） */
  reset(): void {
    this.pending = ''
    this.committedAny = false
  }

  /**
   * live 区尾部行：原始文本（不做 markdown 解析，防未闭合围栏闪烁），
   * display-width aware 截断到 maxRows 显示行。
   *
   * `extraTail` 为尚未吐块的最新缓冲（BlockStreamWriter.peek()）——拼在
   * pending 之后一起截断，使最新 token 逐字可见（打字机节奏），无需等 blockWriter
   * 吐块。截断对合并文本整体生效，保证不超视口 / CJK 宽度正确。
   */
  getLiveTailLines(maxRows: number, extraTail = ''): string[] {
    const tail = this.pending + extraTail
    if (!tail) return []
    const columns = this.options.getColumns()
    const capped = capLiveTailMarkdownSafe(tail, columns, maxRows)
    if (!capped) return []
    // 硬折行兜底：cap 按显示行收口的是逻辑行，终端折行点仍可能因 ambiguous
    // 宽度（CJK 终端把 ——……“” 按 2 列渲染）与引擎口径错位 → 实际行数 >
    // rowsForLine 估算 → 回顶欠擦 → spinner 残影（与 thinking 区同根因）。
    // 按 wide 上界折到 columns-1 内，任何终端每行恰占 1 显示行。
    const segWidth = Math.max(1, columns - 1)
    return capped.split('\n').flatMap(l => hardWrapToDisplayWidth(l, segWidth, { ambiguousAsWide: true }))
  }

  private commitText(text: string): boolean {
    const trimmed = text.replace(/\n+$/, '')
    if (!trimmed.trim()) return false
    const columns = this.options.getColumns()
    const cacheable = Buffer.byteLength(trimmed, 'utf8') <= StreamRenderer.CACHE_MAX_TEXT
    const language = trimmed.startsWith('```')
      ? (trimmed.slice(3).split(/\s|\n/, 1)[0] ?? '')
      : ''
    const key = cacheable
      ? `${columns}\0${this.options.getThemeKey()}\0${language}\0${trimmed}`
      : undefined
    let ansi = key === undefined ? undefined : this.stableCache.get(key)
    if (ansi !== undefined && key !== undefined) {
      this.stableCache.delete(key)
      this.stableCache.set(key, ansi)
      this.options.onCacheResult?.(true)
      this.options.perfMonitor?.recordCache(true)
    } else {
      if (key !== undefined) {
        this.options.onCacheResult?.(false)
        this.options.perfMonitor?.recordCache(false)
      }
      const render = () => formatMarkdown(
        { text: trimmed, columns },
        this.options.getTheme(),
      )
      const rendered = this.options.perfMonitor?.measure('formatMarkdown', render) ?? render()
      if (rendered.length === 0) return false
      ansi = rendered.join('\n')
      if (key !== undefined) {
        this.stableCache.set(key, ansi)
        if (this.stableCache.size > StreamRenderer.CACHE_MAX_ENTRIES) {
          const oldest = this.stableCache.keys().next().value
          if (oldest !== undefined) this.stableCache.delete(oldest)
        }
      }
    }
    this.options.commit(ansi)
    this.committedAny = true
    return true
  }
}
