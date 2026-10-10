/**
 * T9 InputLine — 纯 TypeScript 类，替代 base-text-input.tsx / input.tsx。
 *
 * 管理输入文本缓冲区、光标位置、历史、Vim 模式。
 * 零 React/Ink 依赖。通过回调通知外部变化。
 *
 * 核心能力：
 * - 字符输入 + 多字节 UTF-8 支持
 * - 光标移动（左右/home/end/词级）
 * - 删除（backspace/delete/词级删除）
 * - 历史导航（上下键）
 * - 行内编辑（Ctrl+A/E/U/K/W）
 * - Vim 模式（Normal/Insert）
 * - Tab 补全接口
 * - 粘贴支持
 */

export type InputLineEvent =
  | { type: 'change'; value: string; cursor: number }
  | { type: 'submit'; value: string; images?: string[] }
  | { type: 'tab' }
  | { type: 'history'; direction: 'prev' | 'next' }

export interface InputLineOptions {
  /** 初始文本值 */
  value?: string
  /** 占位符文本（当 value 为空时显示） */
  placeholder?: string
  /** 历史记录（最新的在前） */
  history?: string[]
  /** 是否启用 Vim 模式 */
  vimEnabled?: boolean
  /** 回调 */
  onChange?: (value: string, cursor: number) => void
  onSubmit?: (value: string, images?: string[]) => void
  onTabComplete?: () => boolean
  /** 最大输入长度 */
  maxLength?: number
  /** 初始图片附件 data URL 列表 */
  images?: string[]
  /** 图片附件变化回调 */
  onImagesChange?: (images: string[]) => void
}

export interface InputLineDisplayOptions {
  /** Maximum display rows to return. When exceeded, keep the cursor line visible. */
  maxLines?: number
  /** Maximum display columns per line. When the cursor line exceeds this width,
   *  a horizontal viewport centered on the cursor is shown instead of truncating
   *  from the start (which hides the text the user is actively typing at the end). */
  maxWidth?: number
}

export type VimMode = 'normal' | 'insert' | 'visual'

export interface DraftSnapshot {
  value: string
  cursor: number
  images: string[]
  pastes: Array<[number, string]>
  pasteSeq: number
  vimEnabled: boolean
  vimMode: VimMode
  selectionAnchor: number | null
  visualLineWise: boolean
  newlineMode: boolean
}

/** Grapheme 分段器（Node 22+）。用于按用户感知字符（CJK/emoji/ZWJ 簇）步进光标。
 * WSL/Alpine 中若 Node.js 运行时缺少 ICU 数据，Intl.Segmenter 会抛出。
 * 降级到按 code-point 分割（仍正确处理多字节 UTF-8，但不支持 ZWJ emoji 簇）。 */
let graphemeSegmenter: Intl.Segmenter | null = null
try {
  graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
} catch {
  graphemeSegmenter = null
}

const GRAPHEME_SEGMENTER = graphemeSegmenter

// ── fish 式 undo 合并（2026-07-23 P1-1）──────────────────────────────
// 连续 word 字符插入合并为一单元；空格/换行各自独立；删除/粘贴/历史导航/
// 外部写入各自独立；kind 切换或光标跳变（移动/模式切换）时封口。
type UndoKind = 'insert-word' | 'insert-space' | 'insert-other' | 'delete' | 'replace'

interface UndoUnit {
  value: string
  cursor: number
  kind: UndoKind
  /** 图片附件快照（引用拷贝，data URL 字符串不可变）——Ctrl+C 清空/退格删图后可整体恢复。 */
  images: string[]
  pastes: Array<[number, string]>
  pasteSeq: number
}

/** CJK 统一表意/扩展A/兼容/假名/谚文——与 \w 一起视为 word 字符。
 *  不复用 prevWordStart 的 /\w/ 口径：它把整段中文当非词，连续中文输入
 *  会被错分为一堆独立单元。 */
const WORD_CHAR_RE = /^(?:\w|[一-鿿㐀-䶿豈-﫿぀-ヿ가-힯])$/

function classifyInsert(ch: string): UndoKind {
  if (/^\s$/.test(ch)) return 'insert-space'
  if (WORD_CHAR_RE.test(ch)) return 'insert-word'
  return 'insert-other'
}

const UNDO_STACK_MAX = 200
/** 快照滞留总字符上限（≈2M UTF-16 code units）：200 单元 × 极端大 buffer
 * （多次 100KB+ 粘贴）的滞留内存长尾防护——超限时逐出最旧单元。 */
const UNDO_TOTAL_CHARS_MAX = 2_000_000

// ── 长粘贴自动收纳（2026-07-24，对齐 pi-tui 与 Mission Composer §12）────────
// 命中阈值的粘贴不原文进 buffer，而是插入原子标记串 `[paste #N +M lines]`，
// 原文存 _pastes 旁路——输入框不被长计划/日志淹没，提交时展开还原。
/** 触发折叠的阈值（行数 或 字符数）。 */
const PASTE_FOLD_MIN_LINES = 10
const PASTE_FOLD_MIN_CHARS = 1000
/** 标记串形态（grapheme 原子化 / 提交展开 / 渲染着色共用）。 */
const PASTE_MARKER_RE = /\[paste #(\d+) \+\d+ lines?\]/g

import { ambiguousWideEnabled, displayWidth } from '../width.js'
import { inputCaretAt, inputDisplayWidth, wrapInputLines, viewportWithCaret } from './input-layout.js'

/**
 * Grapheme 边界缓存：Intl.Segmenter 对整串分段是 O(n)，而 prevGrapheme/
 * nextGrapheme 在每次光标移动（左右键/backspace/delete）都被调用。长输入下
 * 每次按键重跑全长分段会卡。按 value 缓存边界数组，value 未变（纯光标移动）
 * 直接复用；并用二分定位而非线性扫描边界。
 */
interface GraphemeCache {
  value: string
  bounds: number[] // 升序的 code-unit 偏移（含 0 与末尾）
}

/** 返回字符串中所有 grapheme 边界的 code-unit 偏移（含 0 与末尾）。 */
function graphemeBoundaries(value: string): number[] {
  const bounds = [0]
  if (GRAPHEME_SEGMENTER) {
    for (const seg of GRAPHEME_SEGMENTER.segment(value)) {
      bounds.push(seg.index + seg.segment.length)
    }
  } else {
    // ICU 数据缺失降级：按 code-point 分割（ZWJ emoji 簇会被拆开，但 CJK/ASCII 正常）
    let i = 0
    while (i < value.length) {
      const cp = value.codePointAt(i)
      if (cp === undefined) { bounds.push(i); i++; continue }
      bounds.push(i + (cp > 0xFFFF ? 2 : 1))
      i += cp > 0xFFFF ? 2 : 1
    }
  }
  return bounds
}

/** 在升序边界数组中找严格小于 cursor 的最大下标（光标左侧最近边界）。二分 O(log n)。 */
function boundaryBefore(bounds: number[], cursor: number): number {
  let lo = 0, hi = bounds.length - 1, ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (bounds[mid]! < cursor) { ans = bounds[mid]!; lo = mid + 1 }
    else hi = mid - 1
  }
  return ans
}

/** 在升序边界数组中找严格大于 cursor 的最小下标（光标右侧最近边界）。二分 O(log n)。 */
function boundaryAfter(bounds: number[], cursor: number): number {
  let lo = 0, hi = bounds.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (bounds[mid]! > cursor) hi = mid
    else lo = mid + 1
  }
  return bounds[lo]! > cursor ? bounds[lo]! : -1
}

/** 剔除落在 `[paste #N …]` 标记内部的边界（端点保留）——标记成为原子编辑单位。 */
function atomicPasteMarkerBounds(value: string, bounds: number[]): number[] {
  const spans: Array<[number, number]> = []
  for (const m of value.matchAll(new RegExp(PASTE_MARKER_RE.source, 'g'))) {
    spans.push([m.index!, m.index! + m[0].length])
  }
  if (spans.length === 0) return bounds
  return bounds.filter(b => !spans.some(([s, e]) => b > s && b < e))
}

/** 视窗裁剪：返回可见行 + 光标行在【返回数组内】的下标（硬件光标归位需要）。 */
export class InputLine {
  private _value: string
  private _cursor: number
  private _placeholder: string
  private _history: string[]
  private _historyIdx: number
  private _vimEnabled: boolean
  private _vimMode: VimMode
  private _maxLength: number
  /** 图片附件 data URL 列表 */
  private _images: string[] = []

  /** Grapheme 边界缓存（按 value 失效）。光标移动不改 value，命中缓存省去 O(n) 分段。 */
  private _graphemeCache: GraphemeCache | null = null

  private onChangeCallback?: (value: string, cursor: number) => void
  private onSubmitCallback?: (value: string, images?: string[]) => void
  private onTabCompleteCallback?: () => boolean
  private onImagesChangeCallback?: (images: string[]) => void

  /** undo 栈（改前快照）。submit 后清空——上一条输入的文本不得被下一条撤销复活。 */
  private _undoStack: UndoUnit[] = []
  /** 栈内快照滞留的总字符数（配合 UNDO_TOTAL_CHARS_MAX 防护内存长尾）。 */
  private _undoChars = 0
  /** redo 栈（undo 目标态快照）。任何新编辑（recordUndo）清空——redo 分支失效。 */
  private _redoStack: UndoUnit[] = []
  private _redoChars = 0
  /** 当前未封口单元 kind（仅 insert-word 参与合并）。 */
  private _undoOpen: UndoKind | null = null
  /** 合并继续时光标应处的位置（插入点右缘）；不符即封口。 */
  private _undoExpectCursor = -1
  /** 翻历史前的在输草稿（P1-2 shell 式往返恢复）。 */
  private _draft: string | null = null
  /** 折叠粘贴原文旁路：标记序号 → 原文。提交时展开还原（expandPastes）。 */
  private _pastes = new Map<number, string>()
  private _pasteSeq = 0

  // ── 键盘选区（S1）──
  /** 选区锚点（shift+方向键设定）；null = 无选区。选区 = [min(anchor,cursor), max)。 */
  private _selAnchor: number | null = null
  /** vim visual linewise 标记（V 进入时为 true，v 进入/退出 visual 时复位）。 */
  private _visualLineWise = false
  /** 内部剪贴板（Alt+Y yank / vim p）；系统剪贴板经 OSC52（_clipboardOut → app drain）。 */
  private _clipboard = ''
  /** 待 app 写出 OSC52 的剪贴文本（takeClipboardOut 取走后清空）。 */
  private _clipboardOut: string | null = null

  /** 粘滞换行模式（对齐公开仓 newlineMode）：开启后 Enter=插入换行。 */
  private _newlineMode = false

  constructor(options: InputLineOptions = {}) {
    this._value = options.value ?? ''
    this._cursor = this._value.length
    this._placeholder = options.placeholder ?? ''
    this._history = options.history ?? []
    this._historyIdx = -1
    this._vimEnabled = options.vimEnabled ?? false
    this._vimMode = 'insert'
    this._maxLength = options.maxLength ?? 100000
    this._images = options.images ?? []
    this.onChangeCallback = options.onChange
    this.onSubmitCallback = options.onSubmit
    this.onTabCompleteCallback = options.onTabComplete
    this.onImagesChangeCallback = options.onImagesChange
  }

  // ── Accessors ────────────────────────────────────────────────

  get value(): string { return this._value }
  get cursor(): number { return this._cursor }
  get vimMode(): VimMode { return this._vimMode }
  get vimEnabled(): boolean { return this._vimEnabled }
  get placeholder(): string { return this._placeholder }
  get images(): string[] { return [...this._images] }

  snapshot(): DraftSnapshot {
    return { value: this._value, cursor: this._cursor, images: [...this._images], pastes: [...this._pastes], pasteSeq: this._pasteSeq,
      vimEnabled: this._vimEnabled, vimMode: this._vimMode, selectionAnchor: this._selAnchor, visualLineWise: this._visualLineWise, newlineMode: this._newlineMode }
  }

  restore(snapshot: DraftSnapshot): void {
    this.recordUndo('replace')
    this._value = snapshot.value
    this._cursor = snapshot.cursor
    this._images = [...snapshot.images]
    this._pastes = new Map(snapshot.pastes)
    this._pasteSeq = snapshot.pasteSeq
    this._vimEnabled = snapshot.vimEnabled
    this._vimMode = snapshot.vimMode
    this._selAnchor = snapshot.selectionAnchor
    this._visualLineWise = snapshot.visualLineWise
    this._newlineMode = snapshot.newlineMode
    this.onChangeCallback?.(this._value, this._cursor)
    this.onImagesChangeCallback?.([...this._images])
  }

  /** Mouse hit positions are display cells, never UTF-16 offsets. */
  placeCaret(line: number, column: number, width: number, displayedCursor?: number): void {
    this._cursor = inputCaretAt(this._value, line, column, width, displayedCursor)
    this._selAnchor = null
    this.onChangeCallback?.(this._value, this._cursor)
  }

  placeVisibleCaret(line: number, column: number, width: number, maxLines: number): void {
    const wrapped = wrapInputLines(this._value, this._cursor, width)
    const view = viewportWithCaret(wrapped.lines, wrapped.cursorLine, maxLines)
    if (view.lines[line]?.startsWith('… ')) return
    const start = wrapped.cursorLine - view.caretLine
    this.placeCaret(Math.max(0, start + line), column, Math.max(1, width - displayWidth('❯ ', { ambiguousAsWide: ambiguousWideEnabled() })), this._cursor)
  }

  /** 启用/停用 vim 键位。停用或启用时都复位到 insert 模式，避免残留 normal 态吞字符。 */
  setVimEnabled(enabled: boolean): void {
    this._vimEnabled = enabled
    this._vimMode = 'insert'
    this._visualLineWise = false
  }

  /** 粘滞换行模式（对齐公开仓 newlineMode）。 */
  get newlineMode(): boolean { return this._newlineMode }
  setNewlineMode(enabled: boolean): void {
    this._newlineMode = enabled
  }

  /** visual 模式是否为 linewise（V 进入；charwise v 为 false）。渲染 `-- VISUAL LINE --` 用。 */
  get visualLineWise(): boolean { return this._vimMode === 'visual' && this._visualLineWise }

  /**
   * 多行渲染：返回输入框的显示行数组。
   * - 空值时显示 placeholder（首行）
   * - 光标行以 `❯ ` 前缀标识（高亮行），其余行缩进对齐
   * - 光标位置以 `█` 标记
   * - 当 maxWidth 给出时，长逻辑行按显示宽度软换行，避免前文被水平视窗遮盖。
   *   maxLines 仍按光标所在视觉行裁剪，保证正在编辑的位置始终可见。
   */
  displayLines(options: InputLineDisplayOptions = {}): string[] {
    return this.displayLinesWithCaret(options).lines
  }

  /**
   * displayLines + 光标 cell 坐标（2026-07-23 IME 硬件光标归位）。
   *
   * 返回的 caret 是「█ 左侧」在显示行内的位置：line 为返回数组下标，
   * col 为 0-based cell 数（含 `❯ ` 前缀，按 ambiguousAsWide 口径度量，
   * 与 renderInputRow/rowsForLine 同尺）。调用方把硬件光标搬到该行该列，
   * 终端 IME 候选窗即锚定在输入框内（自绘 █ 终端不可见）。
   */
  displayLinesWithCaret(options: InputLineDisplayOptions = {}): { lines: string[]; caret: { line: number; col: number } } {
    const ambiguousAsWide = ambiguousWideEnabled()
    const prefixWidth = inputDisplayWidth('❯ ', ambiguousAsWide)
    if (!this._value) {
      return { lines: [`❯ █${this._placeholder}`], caret: { line: 0, col: prefixWidth } }
    }
    const before = this._value.slice(0, this._cursor)
    const cursorLine = before.split('\n').length - 1
    const cursorCol = before.length - (before.lastIndexOf('\n') + 1)

    if (options.maxWidth !== undefined) {
      const wrapped = wrapInputLines(this._value, this._cursor, options.maxWidth, this.selectionRange)
      const view = viewportWithCaret(wrapped.lines, wrapped.cursorLine, options.maxLines)
      return { lines: view.lines, caret: { line: view.caretLine, col: wrapped.cursorCol } }
    }

    const lines = this._value.split('\n').map((line, i) => {
      const isCursorLine = i === cursorLine
      const prefix = isCursorLine ? '❯ ' : '  '
      if (!isCursorLine) return `${prefix}${line}`
      const beforeCursor = line.slice(0, cursorCol)
      const afterCursor = `█${line.slice(cursorCol)}`
      return `${prefix}${beforeCursor}${afterCursor}`
    })
    const view = viewportWithCaret(lines, cursorLine, options.maxLines)
    const beforeCursorText = before.slice(before.lastIndexOf('\n') + 1)
    const col = prefixWidth + inputDisplayWidth(beforeCursorText, ambiguousAsWide)
    return { lines: view.lines, caret: { line: view.caretLine, col } }
  }

  /** 设置值（外部更新用）。覆盖式写入（粘贴/补全/审批填充等）记为独立 undo 单元。 */
  setValue(value: string, cursor?: number): void {
    this.recordUndo('replace')
    this._value = value.slice(0, this._maxLength)
    this._cursor = cursor !== undefined ? Math.min(cursor, this._value.length) : this._value.length
    this.onChangeCallback?.(this._value, this._cursor)
  }

  /** 追加文本到末尾 */
  append(text: string): void {
    this.setValue(this._value + text, this._value.length + text.length)
  }

  /** 在光标处插入文本（用于 bracketed paste），光标移动到插入内容之后。
   *  命中折叠阈值的长粘贴收纳为原子标记 `[paste #N +M lines]`（原文旁路存储）。 */
  insertText(text: string): void {
    if (!text) return
    const lineCount = text.split('\n').length
    if (lineCount > PASTE_FOLD_MIN_LINES || text.length > PASTE_FOLD_MIN_CHARS) {
      const id = ++this._pasteSeq
      this._pastes.set(id, text)
      const marker = `[paste #${id} +${lineCount} lines]`
      this.insertText(marker)
      return
    }
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(this._cursor)
    const next = (before + text + after).slice(0, this._maxLength)
    const cursor = Math.min(before.length + text.length, next.length)
    this.setValue(next, cursor)
  }

  /** 提交前把折叠粘贴标记还原为原文（用户手输的同名标记无原文则原样保留）。 */
  expandPastes(text: string): string {
    if (this._pastes.size === 0) return text
    return text.replace(PASTE_MARKER_RE, (m, id) => this._pastes.get(Number(id)) ?? m)
  }

  removePaste(id: number): void {
    if (!this._pastes.has(id)) return
    this.setValue(this._value.replace(new RegExp(`\\[paste #${id} \\+\\d+ lines?\\]`, 'g'), ''))
    this._pastes.delete(id)
  }

  /** 添加图片附件（data URL）。 */
  addImage(dataUrl: string): void {
    this._images.push(dataUrl)
    this.onImagesChangeCallback?.([...this._images])
  }

  /** 移除指定索引的图片附件。 */
  removeImage(index: number): void {
    if (index < 0 || index >= this._images.length) return
    this._images.splice(index, 1)
    this.onImagesChangeCallback?.([...this._images])
  }

  /** 清空图片附件（记 undo——Ctrl+C 清空后 Ctrl+Z 可整体恢复）。 */
  clearImages(): void {
    if (this._images.length === 0) return
    this.recordUndo('delete')
    this._images = []
    this.onImagesChangeCallback?.([])
  }

  /** 清空文本与图片附件（单个 undo 单元——Ctrl+C 后 Ctrl+Z 一键恢复两者）。 */
  clearAll(): void {
    this.recordUndo('replace')
    this._value = ''
    this._cursor = 0
    this.onChangeCallback?.(this._value, this._cursor)
    this._images = []
    this.onImagesChangeCallback?.([])
  }

  /** 图片占位摘要，用于 ANSI 渲染。 */
  imageSummary(maxWidth?: number): string[] {
    if (this._images.length === 0) return []
    const label = `📎 ${this._images.length} image${this._images.length > 1 ? 's' : ''}`
    if (!maxWidth || label.length <= maxWidth) return [label]
    return [label.slice(0, maxWidth - 1) + '…']
  }

  /** 设置历史 */
  setHistory(history: string[]): void {
    this._history = history
  }

  // ── 键盘选区（S1）───────────────────────────────────────────

  /** 选区范围（start<end，buffer code-unit 偏移）；无选区或锚点=光标时 null。
   *  vim visual linewise（V）时对齐整行：start=起始行行首，end=结束行行尾——
   *  删除/复制/高亮自动行级化。 */
  get selectionRange(): { start: number; end: number } | null {
    if (this._selAnchor === null || this._selAnchor === this._cursor) return null
    let start = Math.min(this._selAnchor, this._cursor)
    let end = Math.max(this._selAnchor, this._cursor)
    if (this._vimMode === 'visual' && this._visualLineWise) {
      start = this._value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
      const nl = this._value.indexOf('\n', end)
      // 含行尾换行（vim 行删除语义：删行后剩余行自然上提，不留空行）
      end = nl === -1 ? this._value.length : nl + 1
    }
    return { start, end }
  }

  /** 取走待 OSC52 写出的剪贴文本（app 渲染循环 drain）。 */
  takeClipboardOut(): string | null {
    const t = this._clipboardOut
    this._clipboardOut = null
    return t
  }

  private collapseSelection(): void {
    this._selAnchor = null
  }

  /** Shift+←/→/Home/End：锚定（首次）并移动光标扩展选区。 */
  private extendSelection(name: string): InputLineEvent | null {
    if (this._selAnchor === null) this._selAnchor = this._cursor
    this.sealUndo()
    switch (name) {
      case 'left': this._cursor = this.prevGrapheme(); break
      case 'right': this._cursor = this.nextGrapheme(); break
      case 'home': this._cursor = 0; break
      case 'end': this._cursor = this._value.length; break
    }
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /** Backspace/Delete（有选区）：删除选区（独立 undo 单元）。 */
  private deleteSelection(): InputLineEvent | null {
    const r = this.selectionRange
    if (!r) return null
    this.recordUndo('delete')
    this._value = this._value.slice(0, r.start) + this._value.slice(r.end)
    this._cursor = r.start
    this.collapseSelection()
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /** Ctrl+K（有选区）：剪切选区 → 内部剪贴板 + OSC52 drain。 */
  private cutSelection(): InputLineEvent | null {
    const r = this.selectionRange
    if (!r) return null
    this._clipboard = this._value.slice(r.start, r.end)
    this._clipboardOut = this._clipboard
    return this.deleteSelection()
  }

  /** Alt+W：复制选区 → 内部剪贴板 + OSC52 drain（不删除，复制后折叠选区）。 */
  private copySelection(): InputLineEvent | null {
    const r = this.selectionRange
    if (!r) return null
    this._clipboard = this._value.slice(r.start, r.end)
    this._clipboardOut = this._clipboard
    this.collapseSelection()
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /** Alt+Y：yank 内部剪贴板（直插不走粘贴折叠；setValue 记 undo）。 */
  private yankClipboard(): InputLineEvent | null {
    if (!this._clipboard) return null
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(this._cursor)
    this.setValue(before + this._clipboard + after, before.length + this._clipboard.length)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  // ── Key Dispatch ─────────────────────────────────────────────

  /**
   * 处理按键。返回处理后的文本值（如果需要渲染）。
   */
  handleKey(name: string, char: string, ctrl: boolean, meta: boolean, shift = false): InputLineEvent | null {
    // ── 全局键 ─────────────────────────────────────────────────
    if (name === 'return' && (shift || meta)) {
      return this.insertChar('\n')
    }

    if (name === 'return') {
      // 多行输入：`\` + Enter 续行（去掉尾部反斜杠，插入换行）
      if (this._value.slice(0, this._cursor).endsWith('\\')) {
        this.recordUndo('replace')
        const before = this._value.slice(0, this._cursor - 1)
        const after = this._value.slice(this._cursor)
        this._value = before + '\n' + after
        // 光标落在新插入的换行符之后（去掉了尾部 `\`，补了一个 `\n`）
        this._cursor = before.length + 1
        this.onChangeCallback?.(this._value, this._cursor)
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
      // 粘滞换行模式（对齐公开仓 newlineMode）：Enter 语义是「插入换行」，
      // 发送用 Shift+Enter 退出模式后按 Enter（app 路由层拦截 shift 翻转）。
      if (this._newlineMode && !ctrl) {
        return this.insertChar('\n')
      }
      const submitted = this.expandPastes(this._value)
      const submittedImages = [...this._images]
      this.clearAfterSubmit()
      this.onImagesChangeCallback?.([])
      this.onSubmitCallback?.(submitted, submittedImages)
      return { type: 'submit', value: submitted, images: submittedImages }
    }

    // 多行输入：Ctrl+J 插入换行
    if (name === 'ctrl_j') {
      return this.insertChar('\n')
    }

    if (name === 'tab' && !ctrl) {
      this.onTabCompleteCallback?.()
      return { type: 'tab' }
    }

    // ── Vim mode: visual（必须在 collapseSelection 之前——motion 扩展不折叠）──
    if (this._vimEnabled && this._vimMode === 'visual') {
      return this.handleVimVisual(name, char, ctrl)
    }

    // ── 键盘选区（S1）：shift+移动扩展；编辑/移动/导航折叠；剪切/复制/yank ──
    if (shift && !ctrl && !meta && (name === 'left' || name === 'right' || name === 'home' || name === 'end')) {
      return this.extendSelection(name)
    }
    if (meta && char === 'w') return this.copySelection()
    if (meta && char === 'y') return this.yankClipboard()
    if (ctrl && name === 'ctrl_k' && this.selectionRange) return this.cutSelection()
    if (!ctrl && !meta && (name === 'backspace' || name === 'delete') && this.selectionRange) {
      return this.deleteSelection()
    }
    this.collapseSelection()

    // ── Vim mode: normal ────────────────────────────────────────
    if (this._vimEnabled && this._vimMode === 'normal') {
      return this.handleVimNormal(name, char, ctrl)
    }

    // ── Insert mode ────────────────────────────────────────────
    // Meta/Option key (word-level) — check before switch
    if (meta) {
      if (char === 'b') return this.moveWordLeft()
      if (char === 'f') return this.moveWordRight()
      switch (name) {
        case 'left': return this.moveWordLeft()
        case 'right': return this.moveWordRight()
        case 'backspace': return this.deleteWordBack()
        case 'delete': return this.deleteWordForward()
        default: return null
      }
    }

    switch (name) {
      case 'escape':
        if (this._vimEnabled) {
          this.sealUndo()
          this._vimMode = 'normal'
          // change 事件触发重绘——模式标签（-- NORMAL --）切换不能等下一帧
          return { type: 'change', value: this._value, cursor: this._cursor }
        }
        break // not vim → fall through to ignore

      case 'backspace':
      case 'ctrl_h': return this.backspace()
      case 'delete': return this.deleteForward()
      case 'left': return this.moveLeft()
      case 'right': return this.moveRight()
      case 'home': return this.moveHome()
      case 'end': return this.moveEnd()
      case 'up': return this.moveUpOrHistory()
      case 'down': return this.moveDownOrHistory()

      default: break
    }

    // Ctrl+key combos (in insert mode)
    if (ctrl) {
      switch (name) {
        case 'ctrl_a': return this.moveHome()
        case 'ctrl_e': return this.moveEnd()
        case 'ctrl_u': return this.deleteToStart()
        case 'ctrl_k': return this.deleteToEnd()
        case 'ctrl_w': return this.deleteWordBack()
        case 'ctrl_d': return this.deleteForward()
        case 'ctrl_b': return this.moveLeft()
        case 'ctrl_f': return this.moveRight()
        case 'ctrl_n': return this.historyNext()
        // Ctrl+P 已让位给命令面板（TuiApp 全局拦截）；多行时翻上一条历史
        // 用 Ctrl+R 历史搜索。ctrl_n 保留 readline 对偶（下一条）。
        case 'ctrl_minus':
        case 'ctrl_z': return this.undo()
        case 'ctrl_y': return this.redo()
        default: break
      }
      return null
    }

    // ── 可打印字符 ─────────────────────────────────────────────
    if (char && char.length > 0 && !ctrl) {
      return this.insertChar(char)
    }

    return null
  }

  // ── Editing Operations ───────────────────────────────────────

  /**
   * 改值前记录 undo 单元（改前快照）。仅 insert-word 在光标连续时合并
   * （不新增单元）；其余 kind 每次独立成元。kind 切换即自然封口。
   */
  private recordUndo(kind: UndoKind): void {
    // 新编辑分支使 redo 失效（标准编辑器语义）——undo 本身不经此方法，不受影响。
    this._redoStack = []
    this._redoChars = 0
    const canMerge = kind === 'insert-word'
      && this._undoOpen === kind
      && this._undoExpectCursor === this._cursor
    if (!canMerge) {
      this._undoStack.push({ value: this._value, cursor: this._cursor, kind, images: [...this._images], pastes: [...this._pastes], pasteSeq: this._pasteSeq })
      this._undoChars += this._value.length
      while (this._undoStack.length > UNDO_STACK_MAX || this._undoChars > UNDO_TOTAL_CHARS_MAX) {
        const dropped = this._undoStack.shift()
        if (!dropped) break
        this._undoChars -= dropped.value.length
      }
    }
    this._undoOpen = kind
    this._undoExpectCursor = -1 // 由插入方在改值后按需重设
  }

  /** 纯光标移动/模式切换：封口袋前单元（不产生新单元）。 */
  private sealUndo(): void {
    this._undoOpen = null
    this._undoExpectCursor = -1
  }

  /** fish 式撤销：弹出最近单元恢复 {value, cursor}。Ctrl+- / Ctrl+Z。 */
  private undo(): InputLineEvent | null {
    const unit = this._undoStack.pop()
    this.sealUndo()
    if (!unit) return null
    this._undoChars -= unit.value.length
    this._redoStack.push({ value: this._value, cursor: this._cursor, kind: unit.kind, images: [...this._images], pastes: [...this._pastes], pasteSeq: this._pasteSeq })
    this._redoChars += this._value.length
    while (this._redoStack.length > UNDO_STACK_MAX || this._redoChars > UNDO_TOTAL_CHARS_MAX) {
      const dropped = this._redoStack.shift()
      if (!dropped) break
      this._redoChars -= dropped.value.length
    }
    this._value = unit.value
    this._cursor = Math.min(unit.cursor, this._value.length)
    this._images = [...unit.images]
    this._pastes = new Map(unit.pastes)
    this._pasteSeq = unit.pasteSeq
    this.onChangeCallback?.(this._value, this._cursor)
    this.onImagesChangeCallback?.([...this._images])
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /** 重做：恢复最近一次 undo 前的状态。Ctrl+Y。 */
  private redo(): InputLineEvent | null {
    const unit = this._redoStack.pop()
    this.sealUndo()
    if (!unit) return null
    this._redoChars -= unit.value.length
    this._undoStack.push({ value: this._value, cursor: this._cursor, kind: unit.kind, images: [...this._images], pastes: [...this._pastes], pasteSeq: this._pasteSeq })
    this._undoChars += this._value.length
    this._value = unit.value
    this._cursor = Math.min(unit.cursor, this._value.length)
    this._images = [...unit.images]
    this._pastes = new Map(unit.pastes)
    this._pasteSeq = unit.pasteSeq
    this.onChangeCallback?.(this._value, this._cursor)
    this.onImagesChangeCallback?.([...this._images])
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /**
   * 提交后重置缓冲：清空文本、归零光标、复位历史游标、清空图片附件。
   * 不触发 onChangeCallback —— submit 路径自己负责后续渲染，
   * 避免在 submit 回调里又触发一次 change 渲染造成竞态。
   *
   * public：Alt+Enter 插队入口（app.ts 的 submitSteer）不经 onSubmit 回调直接
   * 提交，需要调用方自行重置缓冲——与 /steer 命令共用同一通路。
   */
  clearAfterSubmit(): void {
    this._value = ''
    this._cursor = 0
    this._historyIdx = -1
    this._images = []
    this._undoStack = []
    this._undoChars = 0
    this._redoStack = []
    this._redoChars = 0
    this.sealUndo()
    this._draft = null
    this._pastes.clear()
    this._selAnchor = null // 内部剪贴板随会话保留（常规剪贴板语义）
    this._visualLineWise = false
  }

  private insertChar(ch: string): InputLineEvent | null {
    if (this._value.length >= this._maxLength) return null
    const kind = classifyInsert(ch)
    this.recordUndo(kind)
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(this._cursor)
    this._value = before + ch + after
    this._cursor += ch.length
    if (kind === 'insert-word') this._undoExpectCursor = this._cursor
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private backspace(): InputLineEvent | null {
    if (this._cursor <= 0) {
      // 文本已空：退格删除最后一张图片附件（2026-08 用户反馈：粘贴后删不掉）。
      if (this._images.length > 0) {
        this.recordUndo('delete')
        this._images.pop()
        this.onImagesChangeCallback?.([...this._images])
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
      return null
    }
    this.recordUndo('delete')
    // @mention 节点原子删除：光标左侧紧邻完整 token 时整体删除（@file 节点化 v1）。
    // 右侧字符必须是空白或行尾——否则光标其实在 token 中间（如 'fix @file:sr|c'），
    // 左侧形似完整 token 是误判，走 grapheme 单删。
    const left = this._value.slice(0, this._cursor)
    const mentionTail = left.match(/@(?:file|folder|symbol|codebase):(?:"[^"]+"|[^\s]+)\s?$/)
    const nextCh = this._value[this._cursor] ?? ''
    if (mentionTail && (nextCh === '' || /\s/.test(nextCh))) {
      const start = this._cursor - mentionTail[0].length
      this._value = left.slice(0, start) + this._value.slice(this._cursor)
      this._cursor = start
      this.onChangeCallback?.(this._value, this._cursor)
      return { type: 'change', value: this._value, cursor: this._cursor }
    }
    // grapheme-aware：删除光标左侧一个完整用户字符（CJK/emoji 簇）
    const start = this.prevGrapheme()
    const before = this._value.slice(0, start)
    const after = this._value.slice(this._cursor)
    this._value = before + after
    this._cursor = start
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteForward(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    this.recordUndo('delete')
    // grapheme-aware：删除光标右侧一个完整用户字符
    const end = this.nextGrapheme()
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(end)
    this._value = before + after
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteToStart(): InputLineEvent | null {
    if (this._cursor <= 0) return null
    this.recordUndo('delete')
    this._value = this._value.slice(this._cursor)
    this._cursor = 0
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteToEnd(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    this.recordUndo('delete')
    this._value = this._value.slice(0, this._cursor)
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteWordBack(): InputLineEvent | null {
    if (this._cursor <= 0) return null
    this.recordUndo('delete')
    const start = this.prevWordStart()
    const before = this._value.slice(0, start)
    const after = this._value.slice(this._cursor)
    this._value = before + after
    this._cursor = start
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteWordForward(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    this.recordUndo('delete')
    const end = this.nextWordEnd()
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(end)
    this._value = before + after
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  // ── Cursor Movement ──────────────────────────────────────────

  private moveLeft(): InputLineEvent | null {
    if (this._cursor <= 0) return null
    this.sealUndo()
    this._cursor = this.prevGrapheme()
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveRight(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    this.sealUndo()
    this._cursor = this.nextGrapheme()
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /** 光标左侧最近的 grapheme 边界。 */
  private prevGrapheme(): number {
    if (this._cursor <= 0) return 0
    return boundaryBefore(this.graphemeBounds(), this._cursor)
  }

  /** 光标右侧最近的 grapheme 边界。 */
  private nextGrapheme(): number {
    if (this._cursor >= this._value.length) return this._value.length
    const b = boundaryAfter(this.graphemeBounds(), this._cursor)
    return b < 0 ? this._value.length : b
  }

  /** 当前 value 的 grapheme 边界（按 value 缓存，纯光标移动命中缓存）。
   *  折叠粘贴标记为原子单位：标记内部的边界被剔除，光标/删除整体越过。 */
  private graphemeBounds(): number[] {
    if (this._graphemeCache?.value === this._value) return this._graphemeCache.bounds
    let bounds = graphemeBoundaries(this._value)
    if (this._pastes.size > 0) bounds = atomicPasteMarkerBounds(this._value, bounds)
    this._graphemeCache = { value: this._value, bounds }
    return bounds
  }

  private moveHome(): InputLineEvent | null {
    if (this._cursor === 0) return null
    this.sealUndo()
    this._cursor = 0
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveEnd(): InputLineEvent | null {
    if (this._cursor === this._value.length) return null
    this.sealUndo()
    this._cursor = this._value.length
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveWordLeft(): InputLineEvent | null {
    const start = this.prevWordStart()
    if (start === this._cursor) return null
    this.sealUndo()
    this._cursor = start
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveWordRight(): InputLineEvent | null {
    const end = this.nextWordEnd()
    if (end === this._cursor || end >= this._value.length && this._cursor === this._value.length) return null
    this.sealUndo()
    this._cursor = end
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  // ── Multi-line Navigation ────────────────────────────────────

  /** 当前光标的（行,列），列以 grapheme 计。 */
  private getLineCol(pos: number): { line: number; col: number } {
    const parts = this._value.slice(0, pos).split('\n')
    return { line: parts.length - 1, col: graphemeBoundaries(parts[parts.length - 1]!).length - 1 }
  }

  /** 由（行,grapheme 列）还原 code-unit 偏移，col 超出行长则贴到行尾。 */
  private posFromLineCol(line: number, col: number): number {
    const lines = this._value.split('\n')
    const clampedLine = Math.max(0, Math.min(line, lines.length - 1))
    let pos = 0
    for (let i = 0; i < clampedLine; i++) pos += lines[i]!.length + 1 // +1 = '\n'
    const bounds = graphemeBoundaries(lines[clampedLine]!)
    pos += bounds[Math.min(Math.max(0, col), bounds.length - 1)]!
    return pos
  }

  /** Up：多行且不在首行时上移一行，否则取上一条历史。 */
  private moveUpOrHistory(): InputLineEvent | null {
    if (this._value.includes('\n')) {
      // 多行：方向键专注行间导航，到首行原地停，不翻历史（防误触——
      // 多行编辑时光标频繁停在首行，按上想继续编辑却跳走）。
      // 多行时翻历史用 Ctrl+N（下一条）/ Ctrl+R（历史搜索）；Ctrl+P 已让位
      // 给命令面板，多行时上一条历史经 Ctrl+R 全屏搜索可达。
      const { line, col } = this.getLineCol(this._cursor)
      if (line > 0) {
        this.sealUndo()
        this._cursor = this.posFromLineCol(line - 1, col)
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
      return null
    }
    return this.historyPrev()
  }

  /** Down：多行时专注行间导航（末行原地停，不翻历史）；单行取下一条历史。 */
  private moveDownOrHistory(): InputLineEvent | null {
    if (this._value.includes('\n')) {
      const { line, col } = this.getLineCol(this._cursor)
      const lastLine = this._value.split('\n').length - 1
      if (line < lastLine) {
        this.sealUndo()
        this._cursor = this.posFromLineCol(line + 1, col)
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
      return null
    }
    return this.historyNext()
  }

  // ── History ──────────────────────────────────────────────────

  private historyPrev(): InputLineEvent | null {
    if (this._history.length === 0) return null
    this.recordUndo('replace')
    if (this._historyIdx === -1) {
      // P1-2：首次上翻暂存在输草稿，回到 historyNext(-1) 时恢复（shell 式往返）。
      this._draft = this._value
      this._historyIdx = 0
    }
    else if (this._historyIdx < this._history.length - 1) this._historyIdx++
    else { this.sealUndo(); return null }
    this._value = this._history[this._historyIdx] ?? ''
    this._cursor = this._value.length
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private historyNext(): InputLineEvent | null {
    if (this._historyIdx < 0) return null
    this.recordUndo('replace')
    if (this._historyIdx === 0) {
      // 越过最新一条 → 恢复在输草稿（无草稿即空串）
      this._historyIdx = -1
      this._value = this._draft ?? ''
      this._draft = null
    } else {
      this._historyIdx--
      this._value = this._history[this._historyIdx] ?? ''
    }
    this._cursor = this._value.length
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  // ── Vim Normal Mode ──────────────────────────────────────────

  private handleVimNormal(name: string, _char: string, _ctrl: boolean): InputLineEvent | null {
    switch (name) {
      case 'escape': return null
      case 'return': {
        const submitted = this.expandPastes(this._value)
        const submittedImages = [...this._images]
        this.clearAfterSubmit()
        this.onImagesChangeCallback?.([])
        this.onSubmitCallback?.(submitted, submittedImages)
        return { type: 'submit', value: submitted, images: submittedImages }
      }
      case 'left':
      case 'ctrl_b': return this.moveLeft()
      case 'right':
      case 'ctrl_f': return this.moveRight()
      case 'home': return this.moveHome()
      case 'end': return this.moveEnd()
      case 'up': return this.historyPrev()
      case 'down': return this.historyNext()
      case 'ctrl_minus':
      case 'ctrl_z': return this.undo()
      case 'ctrl_y': return this.redo()
      default:
        // i → insert, a → append, I → insert at start, A → append at end
        //（模式切换 = 封口袋前 undo 单元；a/I/A 附带光标移动同理；
        //  change 事件触发重绘——模式标签切换不能等下一帧）
        if (_char === 'i') { this.sealUndo(); this._vimMode = 'insert'; return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'a') { this.sealUndo(); this._cursor = Math.min(this._cursor + 1, this._value.length); this._vimMode = 'insert'; return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'I') { this.sealUndo(); this._cursor = 0; this._vimMode = 'insert'; return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'A') { this.sealUndo(); this._cursor = this._value.length; this._vimMode = 'insert'; return { type: 'change', value: this._value, cursor: this._cursor } }
        // x → delete char, D → delete to end
        if (_char === 'x') return this.deleteForward()
        if (_char === 'D') return this.deleteToEnd()
        // 0 → home, $ → end, ^ → first non-whitespace
        if (_char === '0') return this.moveHome()
        if (_char === '$') return this.moveEnd()
        if (_char === '^') { this.sealUndo(); this._cursor = this._value.search(/\S|$/); return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'w') return this.moveWordRightVim()
        if (_char === 'b') return this.moveWordLeft()
        // v → visual charwise；V → visual linewise；p/P → 粘贴内部剪贴板
        if (_char === 'v') { this.sealUndo(); this._selAnchor = this._cursor; this._visualLineWise = false; this._vimMode = 'visual'; return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'V') { this.sealUndo(); this._selAnchor = this._cursor; this._visualLineWise = true; this._vimMode = 'visual'; return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'p') return this.pasteClipboard(false)
        if (_char === 'P') return this.pasteClipboard(true)
        return null
    }
  }

  // ── Vim Visual Mode ──────────────────────────────────────────

  /** vim p/P：内部剪贴板插到光标后/前（charwise 直插，不走粘贴折叠）。 */
  private pasteClipboard(before: boolean): InputLineEvent | null {
    if (!this._clipboard) return null
    const at = before ? this._cursor : Math.min(this._cursor + 1, this._value.length)
    const head = this._value.slice(0, at)
    const tail = this._value.slice(at)
    this.setValue(head + this._clipboard + tail, head.length + this._clipboard.length)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /** visual：motion 扩展选区（选区渲染/linewise 对齐由 selectionRange 驱动）。 */
  private handleVimVisual(name: string, _char: string, _ctrl: boolean): InputLineEvent | null {
    switch (name) {
      case 'escape':
        this.collapseSelection()
        this._visualLineWise = false
        this._vimMode = 'normal'
        return { type: 'change', value: this._value, cursor: this._cursor }
      case 'return': {
        const submitted = this.expandPastes(this._value)
        const submittedImages = [...this._images]
        this.clearAfterSubmit()
        this._visualLineWise = false
        this._vimMode = 'normal'
        this.onImagesChangeCallback?.([])
        this.onSubmitCallback?.(submitted, submittedImages)
        return { type: 'submit', value: submitted, images: submittedImages }
      }
      case 'left': this._cursor = this.prevGrapheme(); return { type: 'change', value: this._value, cursor: this._cursor }
      case 'right': this._cursor = this.nextGrapheme(); return { type: 'change', value: this._value, cursor: this._cursor }
      case 'home': this._cursor = 0; return { type: 'change', value: this._value, cursor: this._cursor }
      case 'end': this._cursor = this._value.length; return { type: 'change', value: this._value, cursor: this._cursor }
      case 'up':
      case 'down': {
        const { line, col } = this.getLineCol(this._cursor)
        const lastLine = this._value.split('\n').length - 1
        const next = name === 'up' ? Math.max(0, line - 1) : Math.min(lastLine, line + 1)
        this._cursor = this.posFromLineCol(next, col)
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
      case 'backspace':
      case 'delete': {
        // vim：x/d 同义剪切（Backspace/Delete 同 d）——先取选区（linewise 对齐
        // 依赖 visual 模式态）再复位模式，顺序不可换。
        const ev = this.cutSelection()
        this._vimMode = 'normal'
        this._visualLineWise = false
        return ev
      }
      case 'ctrl_minus':
      case 'ctrl_z': return this.undo()
      case 'ctrl_y': return this.redo()
      default:
        if (_char === 'h') { this._cursor = this.prevGrapheme(); return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'l') { this._cursor = this.nextGrapheme(); return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === '0') { this._cursor = 0; return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === '$') { this._cursor = this._value.length; return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === '^') { this._cursor = this._value.search(/\S|$/); return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'w') { const r = this.moveWordRightVim(); return r ?? { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'b') { const r = this.moveWordLeft(); return r ?? { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'j' || _char === 'k') return this.handleVimVisual(_char === 'j' ? 'down' : 'up', _char, _ctrl)
        // o：交换锚点/光标（选区另一端编辑）
        if (_char === 'o') {
          if (this._selAnchor !== null) {
            const tmp = this._selAnchor
            this._selAnchor = this._cursor
            this._cursor = tmp
          }
          return { type: 'change', value: this._value, cursor: this._cursor }
        }
        // d/x：剪切回 normal；c：剪切进 insert；y：复制回 normal；v：退出 visual
        //（均先取选区再复位模式——linewise 对齐依赖 visual 模式态，顺序不可换）
        if (_char === 'd' || _char === 'x') {
          const ev = this.cutSelection()
          this._vimMode = 'normal'
          this._visualLineWise = false
          return ev
        }
        if (_char === 'c') {
          const ev = this.cutSelection()
          this._vimMode = 'insert'
          this._visualLineWise = false
          return ev
        }
        if (_char === 'y') {
          const ev = this.copySelection()
          this._vimMode = 'normal'
          this._visualLineWise = false
          return ev
        }
        if (_char === 'v') {
          this.collapseSelection()
          this._visualLineWise = false
          this._vimMode = 'normal'
          return { type: 'change', value: this._value, cursor: this._cursor }
        }
        return null
    }
  }

  // ── Word Navigation Helpers ──────────────────────────────────

  private prevWordStart(): number {
    if (this._cursor <= 0) return 0
    let i = this._cursor - 1
    while (i > 0 && !/\w/.test(this._value[i] ?? '')) i--
    while (i > 0 && /\w/.test(this._value[i - 1] ?? '')) i--
    return i
  }

  private nextWordEnd(): number {
    if (this._cursor >= this._value.length) return this._value.length
    let i = this._cursor
    while (i < this._value.length && !/\w/.test(this._value[i] ?? '')) i++
    if (i >= this._value.length) return this._cursor
    while (i < this._value.length && /\w/.test(this._value[i] ?? '')) i++
    return i
  }

  /** Vim 'w' — move to start of next word (not end) */
  private moveWordRightVim(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    let i = this._cursor
    // Skip current word
    while (i < this._value.length && /\w/.test(this._value[i] ?? '')) i++
    // Skip whitespace
    while (i < this._value.length && !/\w/.test(this._value[i] ?? '')) i++
    if (i === this._cursor) return null
    this.sealUndo()
    this._cursor = i
    return { type: 'change', value: this._value, cursor: this._cursor }
  }
}
