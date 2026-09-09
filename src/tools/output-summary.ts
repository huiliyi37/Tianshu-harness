/**
 * Smart output summarization for truncated bash results.
 *
 * 2026-09-07: 现截断机制（bash.ts `stdout.slice(-24_000)`）只保留尾部，丢失头部与
 * 中部的错误段（RED 复现：40KB 输出错误在 10KB 处被丢弃）。本模块在 raw 全文
 * （rawSpool 已落盘）上做一次线性扫描，提取 head + anchors(error/stack 段) + tail，
 * 预算与现状持平（默认 6K + 10K + 8K = 24K）。
 */

export interface SmartSummaryOptions {
  /** head 预算（默认 6KB；按 JS string length 计 = UTF-16 code units，非字节） */
  headBytes?: number
  /** anchors 合并预算（默认 10KB；同上口径） */
  anchorBytes?: number
  /** tail 预算（默认 8KB；同上口径） */
  tailBytes?: number
  /** 锚段内单行截断长度（默认 2000 字符，防长行吞预算） */
  maxLineChars?: number
}

export interface AnchorSnippet {
  /** 1-based 起始行号（提示用，可 read_file offset 直达 raw） */
  startLine: number
  snippet: string
}

export interface SmartSummary {
  head: string
  anchors: AnchorSnippet[]
  /** 全部锚行号（1-based），进截断提示 */
  anchorLines: number[]
  tail: string
  /** 中间是否有省略 */
  middleOmitted: boolean
}

/** 跨工具错误形态锚正则（行级匹配）
 * 2026-09-07 P0-2：栈帧 alternative 由 `at .+\(.+:\d+:\d+\)` 改为有界形态
 * `at (?:async )?\S{1,120}\s*\([^)]{1,400}:\d+:\d+\)`——旧式嵌套量词在大量
 * `at …(` 但凑不出 `:数字:数字)` 的单行上超二次方回溯（实测 96KB >60s 阻塞事件
 * 循环）。有界后失败在帧长内结束；`(?:async )?` 容忍 Node async 栈帧
 * （`at async fn (f.js:1:2)`）。真实帧如 `at foo (bar.ts:1:2)` 语义不变。
 */
export const ANCHOR_RE =
  /error|Error|ERROR|✖|✗|failed|FAIL|panic|exception|stack trace|at (?:async )?\S{1,120}\s*\([^)]{1,400}:\d+:\d+\)|npm error|ERR_|tsc:|Cannot find|not found|denied|Traceback|assert/i

const DEFAULT = { headBytes: 6 * 1024, anchorBytes: 10 * 1024, tailBytes: 8 * 1024, maxLineChars: 2000 } as const

/** 对匹配锚的长行取锚位置窗口，而非整行（防预算爆） */
function anchorWindow(line: string, maxLineChars: number): string {
  if (line.length <= maxLineChars) return line
  const m = ANCHOR_RE.exec(line)
  if (!m || m.index === undefined) return line.slice(0, maxLineChars)
  const half = Math.floor(maxLineChars / 2)
  const start = Math.max(0, m.index - Math.floor(half / 3))
  return line.slice(start, start + maxLineChars) + '…[长行截断]'
}

/**
 * 中段真省略判定：head 覆盖 [0, headLines)、锚段覆盖 spans、tail 覆盖 [tailStart, n)。
 * 只要 [headLines, tailStart) 区间内存在未被任何锚段覆盖的行即为 true——
 * P1-3：旧判据 `tailStart > headLines || (spans.length > 0 && tailStart > 0)` 在
 * head+锚+tail 无缝覆盖全文（head 到首锚、锚间、末锚到 tail 均无 gap）时误报 true。
 */
function hasMiddleGap(headLines: number, tailStart: number, spans: { start: number; end: number }[]): boolean {
  if (tailStart <= headLines) return false
  let cursor = headLines
  for (const sp of spans) {
    if (sp.start > cursor) return true
    cursor = Math.max(cursor, sp.end + 1)
    if (cursor >= tailStart) return false
  }
  return cursor < tailStart
}

export function extractSmartSummary(full: string, opts: SmartSummaryOptions = {}): SmartSummary {
  const headBytes = opts.headBytes ?? DEFAULT.headBytes
  const anchorBytes = opts.anchorBytes ?? DEFAULT.anchorBytes
  const tailBytes = opts.tailBytes ?? DEFAULT.tailBytes
  const maxLineChars = opts.maxLineChars ?? DEFAULT.maxLineChars

  const lines = full.split('\n')
  const n = lines.length

  // prefix[i] = 前 i 行累计字节（含换行）
  const prefix = new Array<number>(n + 1)
  prefix[0] = 0
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + lines[i]!.length + 1
  const total = prefix[n] ?? 0

  // 锚行（0-based）
  const anchorIdx: number[] = []
  for (let i = 0; i < n; i++) if (ANCHOR_RE.test(lines[i] ?? '')) anchorIdx.push(i)

  // 锚段 span：锚行 -1..+2，gap ≤6 行合并（相邻锚段相距 ≤5 行中间行并入）
  const spans: { start: number; end: number }[] = []
  for (const ai of anchorIdx) {
    const s = Math.max(0, ai - 1)
    const e = Math.min(n - 1, ai + 2)
    const last = spans[spans.length - 1]
    if (last && s - last.end <= 6) last.end = Math.max(last.end, e)
    else spans.push({ start: s, end: e })
  }

  // head 行数：预算内且不进入首个锚段
  let headLines = 0
  const firstSpanStart = spans.length ? spans[0]!.start : n
  for (let i = 0; i <= firstSpanStart; i++) {
    if ((prefix[i] ?? 0) > headBytes) break
    headLines = i
  }
  if (spans.length && headLines > spans[0]!.start) headLines = spans[0]!.start

  // tail 行数：预算内且不进入末个锚段、不与 head 重叠
  const lastSpanEnd = spans.length ? spans[spans.length - 1]!.end : -1
  let tailStart = n
  for (let i = n; i > Math.max(headLines, lastSpanEnd + 1); i--) {
    if (total - (prefix[i] ?? 0) > tailBytes) break
    tailStart = i
  }

  const middleOmitted = hasMiddleGap(headLines, tailStart, spans)
  const renderSpan2 = (sp: { start: number; end: number }): AnchorSnippet => {
    const seg = lines.slice(sp.start, sp.end + 1)
    const text = seg
      .map((ln, k) => {
        if (k === 0) return anchorWindow(ln, maxLineChars)
        return ln.length > maxLineChars ? ln.slice(0, maxLineChars) + '…[行截断]' : ln
      })
      .join('\n')
    return { startLine: sp.start + 1, snippet: text }
  }

  let anchors: AnchorSnippet[]
  if (spans.length === 0) {
    anchors = []
  } else {
    const rendered = spans.map(renderSpan2)
    const used = rendered.reduce((b, a) => b + a.snippet.length + 1, 0)
    if (used <= anchorBytes) {
      anchors = rendered
    } else {
      // 超预算：保首段 + 末段（各自可能还要截）
      const fit = (sn: AnchorSnippet): AnchorSnippet => ({
        startLine: sn.startLine,
        snippet: sn.snippet.length > anchorBytes / 2 ? sn.snippet.slice(0, anchorBytes / 2) + '…[锚段截断]' : sn.snippet,
      })
      const firstSn = rendered[0]
      const lastSn = rendered[rendered.length - 1]
      anchors = firstSn ? [fit(firstSn)] : []
      if (lastSn && lastSn !== firstSn) anchors.push(fit(lastSn))
    }
  }

  const head = lines.slice(0, headLines).join('\n')
  const tail = tailStart < n ? lines.slice(tailStart).join('\n') : ''

  return {
    head,
    anchors,
    anchorLines: anchorIdx.map((i) => i + 1),
    tail,
    middleOmitted,
  }
}

/** 组装模型可见文本（bash.ts buildResult 接线用） */
export function renderSmartSummary(s: SmartSummary, totalBytes: number): string {
  void totalBytes
  const parts: string[] = []
  // 32KB 截断声明由 bash.ts truncNote 输出（rawPath 指向也由它给）——此处只输出
  // 锚点索引与内容段，避免与 truncNote 双声明。
  if (s.anchorLines.length > 0) {
    parts.push(`[error anchors @raw 行 ${s.anchorLines.slice(0, 8).join(', ')}${s.anchorLines.length > 8 ? ` …共${s.anchorLines.length}处` : ''}]`)
  }
  if (s.head) parts.push(s.head)
  for (const a of s.anchors) {
    parts.push(`\n──── anchor @raw L${a.startLine} ────\n${a.snippet}`)
  }
  if (s.middleOmitted) {
    // 简短省略标注——32KB 截断声明由 bash.ts 的 truncNote 输出，此处不重复
    parts.push('\n…[中段省略——需要时 read_file rawPath 按上方行号定位]…')
  }
  if (s.tail) parts.push(s.tail)
  return parts.join('\n')
}
