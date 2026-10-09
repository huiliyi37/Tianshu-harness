import type { WriteStream } from 'node:tty'
import { UIHistory, type UIRecordInput } from '../ui-history.js'
import { ConversationViewport, viewportCellSlice, viewportHighlightCells, wrapViewportText, type ViewportCell } from './conversation-viewport.js'
import { FullscreenEngine, MOUSE_ON, MOUSE_OFF, type MousePress, type TerminalSize } from './fullscreen-engine.js'
import type { KeyPress } from './input-handler.js'
import { budgetInputChrome } from './input-layout.js'
import { decodeTeamPanelModel } from '../team-panel-model.js'
import { decodeCouncilPanel } from '../council-panel-model.js'
import { formatTeamPanel } from '../format/team-panel.js'
import { formatCouncilPanel } from '../format/council-panel.js'
import { formatAskUserQuestion } from '../format/ask-user-question.js'
import { getTheme } from '../theme.js'

interface SelectionPoint { x: number; y: number }
interface Selection { start: SelectionPoint; end: SelectionPoint; rows: ViewportCell[]; moved: boolean; released: boolean }
interface RunningTool { name: string; input: Record<string, unknown> }
export interface FrontendLiveLine {
  text: string
  caretCol?: number
  inputLine?: number
  inputStartCol?: number
  decisionPart?: 'title' | 'fact' | 'action' | 'footer' | 'body'
  region?: 'identity' | 'mode' | 'composer'
}

/** Frontend-only event projection; stable records never become model messages. */
export class FrontendSession {
  history!: UIHistory
  existingCount = 0
  viewport!: ConversationViewport
  private readonly engine: FullscreenEngine
  private readonly ready: Promise<void>
  private generation = 0
  private reading = false
  private mouseEnabled = false
  private textChunks: Array<{ text: string; parts: number }> = []
  private initialRecords: UIRecordInput[] = []
  private loading?: { generation: number; records: UIRecordInput[] }
  private sessionReady: Promise<void> = Promise.resolve()
  private tools = new Map<string, RunningTool>()
  private completed = new Set<string>()
  private selection?: Selection
  private linkPress?: { x: number; y: number; moved: boolean }
  private visible: ViewportCell[] = []
  private historyTop = 0
  private copyRow?: number
  private clearedCount = 0
  private composer: Array<{ y: number; line: number; startCol: number }> = []
  private diagnostic = ''
  welcomeLines: string[] = []
  welcomeRenderer?: (columns: number, availableRows: number) => string[]

  renderWelcome(columns: number, availableRows: number): string[] {
    return availableRows > 0 ? this.welcomeRenderer?.(columns, availableRows) ?? this.welcomeLines : []
  }

  constructor(
    private readonly stdout: WriteStream,
    private readonly getSize: () => TerminalSize,
    private readonly onChange: () => void,
    private readonly onDiagnostic: (text: string) => void,
  ) {
    this.engine = new FullscreenEngine(stdout, getSize)
    this.ready = UIHistory.open().then(h => {
      if (!this.history && !this.loading) {
        this.useHistory(h)
        for (const input of this.initialRecords) h.append(input)
      }
    })
  }
  get isFullscreen(): boolean { return this.engine.active }
  get isReading(): boolean { return this.reading }
  invalidate(): void { this.engine.invalidate() }
  closeHistory(): void { this.reading = false; this.viewport?.stopReading(); this.clearSelection() }
  clearDisplay(): void {
    this.clearedCount = this.history?.count ?? 0
    this.reading = false
    this.viewport?.stopReading()
    this.clearSelection()
    this.invalidate()
  }

  async setSession(path: string): Promise<boolean> {
    this.flushText()
    const generation = ++this.generation
    const loading = { generation, records: this.initialRecords }
    this.initialRecords = []
    this.loading = loading
    this.tools.clear(); this.completed.clear(); this.textChunks = []
    this.clearSelection()
    this.reading = false
    this.clearedCount = 0
    this.welcomeLines = []
    this.welcomeRenderer = undefined
    const opening = UIHistory.open(path).then(async history => {
      if (generation !== this.generation) return
      this.useHistory(history)
      this.existingCount = history.count
      for (const input of loading.records) history.append(input)
      this.loading = undefined
      this.viewport.setStreaming(this.textChunks.length > 0)
      this.reportDiagnostic()
      const { cols, rows } = this.getSize()
      await this.viewport.prepare(cols, Math.max(1, rows - 6))
      if (generation === this.generation) this.onChange()
    })
    this.sessionReady = opening
    await opening
    return generation === this.generation
  }
  private useHistory(history: UIHistory): void {
    this.history = history
    this.viewport = new ConversationViewport(history, () => { this.reportDiagnostic(); this.onChange() })
    this.reportDiagnostic()
  }
  private reportDiagnostic(): void {
    const text = this.history?.diagnostic ?? ''
    if (text && text !== this.diagnostic) { this.diagnostic = text; this.onDiagnostic(text) }
  }
  record(input: UIRecordInput): void {
    if (input.kind === 'user') { this.welcomeLines = []; this.welcomeRenderer = undefined }
    if (this.loading) { this.loading.records.push(input); return }
    if (!this.history) { this.initialRecords.push(input); return }
    if (!this.generation) this.initialRecords.push(input)
    this.history.append(input)
    this.reportDiagnostic()
    this.onChange()
  }
  textDelta(text: string): void {
    if (!text) return
    let chunk = { text, parts: 1 }
    // Binary-sized chunks avoid repeatedly copying an ever-growing assistant string.
    while (this.textChunks.at(-1)?.parts === chunk.parts) {
      const previous = this.textChunks.pop()!
      chunk = { text: previous.text + chunk.text, parts: previous.parts + chunk.parts }
    }
    this.textChunks.push(chunk)
    this.viewport?.setStreaming(true)
  }
  flushText(): void {
    if (!this.textChunks.length) return
    const text = this.textChunks.map(chunk => chunk.text).join('')
    this.textChunks = []
    this.viewport?.setStreaming(false)
    this.record({ kind: 'assistant', text })
  }
  toolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.flushText()
    this.completed.delete(id)
    this.tools.set(id, { name, input })
  }
  toolResult(id: string, name: string, result: string, isError = false, rawPath?: string, uiContent?: string): void {
    this.flushText()
    if (this.completed.has(id)) return
    const running = this.tools.get(id)
    this.tools.delete(id)
    this.completed.add(id)
    const display = uiContent ?? result, theme = getTheme(), width = this.getSize().cols
    const team = name === 'team_orchestrate' ? decodeTeamPanelModel(display) : null
    const council = name === 'council_convene' ? decodeCouncilPanel(display) : null
    const text = team ? formatTeamPanel(team, theme, width).join('\n')
      : council ? formatCouncilPanel(council, theme, width).join('\n')
        : name === 'ask_user_question' && !isError ? formatAskUserQuestion({ content: display, columns: width }, theme).join('\n') : display
    this.record({ kind: 'tool', toolId: id, name: name || running?.name, input: running?.input, text, isError, rawPath })
  }
  /**
   * ask_user_question 的卡片等决策面板结算时统一落历史（TuiApp.commitAskCard）：
   * 这里只推进工具记账（tools/completed 与文本 flush），不把卡片以工具结果
   * 形态写进历史——否则同一提问会在活动面板与历史里各出现一次。
   */
  deferAskResult(id: string): void {
    this.flushText()
    this.tools.delete(id)
    this.completed.add(id)
  }

  boundary(text: string, kind: NonNullable<UIRecordInput['boundary']>): void {
    this.flushText()
    this.record({ kind: 'boundary', text, boundary: kind })
  }
  startFullscreen(mouse: boolean): void { this.engine.enter(mouse); this.mouseEnabled = mouse; this.onChange() }
  stopFullscreen(): void { this.engine.leave(); this.mouseEnabled = false; this.clearSelection(); this.reading = false; this.viewport?.stopReading() }
  setMouse(enabled: boolean): void { this.engine.setMouse(enabled); this.mouseEnabled = enabled; if (!enabled) this.clearSelection() }
  setHistoryMouse(enabled: boolean): void {
    if (this.engine.active) return
    this.stdout.write(enabled ? MOUSE_ON : MOUSE_OFF)
    this.mouseEnabled = enabled
    if (!enabled) this.clearSelection()
  }

  render(liveLines: FrontendLiveLine[], chromeStart: number, identity: string | string[]): void {
    if (!this.engine.active || !this.viewport) return
    const { cols, rows } = this.getSize()
    const width = Math.max(1, cols), height = Math.max(1, rows)
    const identityRows = height >= 14 ? (Array.isArray(identity) ? identity : wrapViewportText(identity, width)).slice(0, 2) : []
    if (identityRows.length) identityRows.push('')
    const chrome = liveLines.slice(Math.max(0, chromeStart))
    // The existing live region is authoritative for transient text, running tools and decisions.
    const dynamic = liveLines.slice(0, Math.max(0, chromeStart))
    const essential = dynamic.map((line, i) => line.decisionPart ? i : -1).filter(i => i >= 0)
    const chromeBudget = Math.min(height, 12, Math.max(2, height - identityRows.length - Math.max(dynamic.length ? 2 : 1, essential.length)))
    const keptChrome = budgetInputChrome(chrome, chromeBudget)
    const available = Math.max(0, height - identityRows.length - keptChrome.length)
    const historyReserve = available > essential.length + 3 ? 3 : 0
    const dynamicBudget = Math.min(dynamic.length, Math.max(0, available - historyReserve), essential.length ? available : Math.max(3, Math.floor(height / 3)))
    const selected = new Set(essential.slice(0, dynamicBudget))
    if (essential.length) {
      const start = dynamic.findIndex(line => line.decisionPart === 'title')
      for (let i = Math.max(0, start); i < dynamic.length && selected.size < dynamicBudget; i++) selected.add(i)
    } else for (let i = dynamic.length - 1; i >= 0 && selected.size < dynamicBudget; i--) selected.add(i)
    const keptDynamic = [...selected].sort((a, b) => a - b).map(i => dynamic[i]!)
    const statusRows = this.reading && available > keptDynamic.length + 1 ? 1 : 0
    const historyHeight = Math.max(0, available - keptDynamic.length - statusRows)
    const intro = !this.reading && !essential.length ? this.renderWelcome(width, historyHeight).flatMap(line => wrapViewportText(line, width)).slice(0, historyHeight) : []
    const readingHeight = intro.length && !this.history.count ? 0 : Math.max(0, historyHeight - intro.length)
    let historyLines = readingHeight ? this.loading ? wrapViewportText('历史正在读取…', width).slice(0, readingHeight) : this.viewport.render(width, readingHeight) : []
    this.historyTop = identityRows.length + intro.length
    this.visible = this.loading ? [] : this.viewport.visibleCells.slice(0, readingHeight)
    if (!this.reading && this.clearedCount && !this.loading) {
      historyLines = historyLines.filter((_, i) => (this.visible[i]?.recordIndex ?? -1) >= this.clearedCount)
      this.visible = this.visible.filter(cell => cell.recordIndex >= this.clearedCount)
    }
    const selectedHistory = this.highlight(historyLines)
    const padding = Array.from({ length: Math.max(0, available - keptDynamic.length - statusRows - intro.length - selectedHistory.length) }, () => '')
    const footer = statusRows ? [wrapViewportText(this.selection?.moved ? '[复制] Ctrl+C · Esc 取消选区' : this.viewport.inlineStatus, width)[0] ?? ''] : []
    this.copyRow = statusRows && this.selection?.moved ? identityRows.length + intro.length + selectedHistory.length + padding.length + 1 : undefined
    const frame = [...identityRows, ...intro, ...selectedHistory, ...padding, ...footer, ...keptDynamic.map(l => l.text), ...keptChrome.map(l => l.text)]
    this.composer = []
    let caret: { row: number; col: number } | undefined
    let line = 0
    for (let i = 0; i < keptChrome.length; i++) {
      const current = keptChrome[i]!
      const row = frame.length - keptChrome.length + i + 1
      if (current.inputLine !== undefined || current.caretCol !== undefined) this.composer.push({ y: row, line: current.inputLine ?? line++, startCol: current.inputStartCol ?? 0 })
      if (current.caretCol !== undefined) caret = { row, col: current.caretCol + 1 }
    }
    const decisionCaret = keptDynamic.findIndex(l => l.caretCol !== undefined)
    if (decisionCaret >= 0) caret = { row: frame.length - keptChrome.length - keptDynamic.length + decisionCaret + 1, col: keptDynamic[decisionCaret]!.caretCol! + 1 }
    this.engine.render(frame, caret)
  }
  renderHistory(width: number, height: number): string[] {
    const title = wrapViewportText('会话历史', width)[0] ?? ''
    if (!this.viewport || this.loading) { this.visible = []; return [title, ...wrapViewportText('历史正在读取…', width)].slice(0, height) }
    this.historyTop = 1
    const budget = Math.max(0, height - 2)
    const lines = budget ? this.viewport.render(width, budget) : []
    this.visible = this.viewport.visibleCells.slice()
    if (!budget) this.visible = []
    this.copyRow = this.selection?.moved ? lines.length + 2 : undefined
    return [title, ...this.highlight(lines), wrapViewportText(this.selection?.moved ? '[复制] Ctrl+C · Esc 取消选区' : this.viewport.status, width)[0] ?? ''].slice(0, height)
  }
  async showHistory(current: () => boolean = () => true): Promise<void> {
    await this.ready
    await this.sessionReady
    if (!current()) return
    this.reading = true
    this.viewport.startReading()
    const { cols, rows } = this.getSize()
    await this.viewport.prepare(cols, Math.max(1, rows - 3))
    if (!current()) return
    this.clearSelection()
    this.onChange()
  }
  handleHistoryKey(key: KeyPress): boolean {
    if (!this.viewport) return false
    if (key.name === 'escape' && this.selection) { this.clearSelection(); this.onChange(); return true }
    return this.viewport.handleKey(key)
  }
  handleKey(key: KeyPress, hasDraft = false): boolean {
    if (!this.engine.active || !this.viewport) return false
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.reading = true
      this.viewport.startReading()
      return this.viewport.handleKey(key)
    }
    if (!this.reading) return false
    if (key.name === 'escape' && this.selection?.moved) { this.clearSelection(); this.onChange(); return true }
    if (hasDraft || (key.char && !key.ctrl) || key.meta || ['backspace', 'delete', 'ctrl_u', 'ctrl_w', 'ctrl_j', 'ctrl_v', 'ctrl_z', 'ctrl_y'].includes(key.name)) {
      this.closeHistory()
      return false
    }
    if (this.handleHistoryKey(key)) return true
    if (key.name === 'escape') { this.reading = false; this.viewport.stopReading(); this.onChange(); return true }
    return false
  }
  handleMouse(event: MousePress): boolean {
    if (!this.viewport || (!this.mouseEnabled && this.engine.active)) return false
    const localY = event.y - 1 - this.historyTop
    if (this.linkPress && (event.type === 'move' || event.type === 'release')) this.linkPress.moved ||= event.x !== this.linkPress.x || event.y !== this.linkPress.y
    if (event.type === 'wheel') {
      this.reading = true
      this.viewport.startReading()
      const up = (event.button & 1) === 0
      return this.viewport.handleKey({ name: up ? 'up' : 'down', char: '', raw: '', ctrl: false, shift: false, meta: false })
    }
    if ((event.button & 3) !== 0 || !this.visible.length) return false
    if (event.type === 'press' && (localY < 0 || localY >= this.visible.length)) return false
    const point = { x: Math.max(0, event.x - 1), y: Math.max(0, Math.min(this.visible.length - 1, localY)) }
    if (event.type === 'press') {
      if (event.ctrl) { this.linkPress = { x: event.x, y: event.y, moved: false }; return true }
      this.linkPress = undefined
      if (event.meta) return false
      this.reading = true
      this.viewport.startReading()
      this.selection = { start: point, end: point, rows: this.visible.slice(), moved: false, released: false }
      return true
    }
    const selection = this.selection
    if (!selection || selection.released) return false
    selection.end = point
    selection.moved ||= point.x !== selection.start.x || point.y !== selection.start.y
    if (event.type === 'release') {
      selection.released = true
      if (!selection.moved) {
        this.selection = undefined
        const cell = selection.rows[point.y]
        if (cell) { this.reading = true; this.viewport.selectCell(cell); this.viewport.handleKey({ name: 'return', char: '', raw: '', ctrl: false, shift: false, meta: false }) }
      }
    }
    this.onChange()
    return true
  }
  copySelection(): string | null {
    const selection = this.selection
    if (!selection?.moved) return null
    const [start, end] = this.selectionBounds(selection)
    const lines: string[] = []
    for (let y = start.y; y <= end.y; y++) {
      const row = selection.rows[y]
      if (row) lines.push(viewportCellSlice(row.text, y === start.y ? start.x : 0, y === end.y ? end.x + 1 : Infinity))
    }
    return lines.join('\n') || null
  }
  copyButtonHit(x: number, y: number): boolean { return !!this.selection?.moved && y === this.copyRow && x >= 1 && x <= 6 }
  clearSelection(): void { this.selection = undefined; this.linkPress = undefined }
  linkTargetAt(event: MousePress): string | null {
    if (event.type === 'press' && event.ctrl) this.linkPress = { x: event.x, y: event.y, moved: false }
    if (event.type !== 'release') return null
    const press = this.linkPress
    this.linkPress = undefined
    if (!event.ctrl || (event.button & 3) !== 0 || this.selection?.moved || (!this.engine.active && !this.reading)) return null
    if (press && (press.moved || press.x !== event.x || press.y !== event.y)) return null
    const cell = this.visible[event.y - 1 - this.historyTop]
    return cell ? this.viewport.knownLinkAt(cell, Math.max(0, event.x - 1)) : null
  }
  composerHit(x: number, y: number): { line: number; column: number } | null {
    const hit = this.composer.find(row => row.y === y)
    if (!hit) return null
    return { line: hit.line, column: Math.max(0, x - 1 - hit.startCol) }
  }
  private selectionBounds(selection: Selection): [SelectionPoint, SelectionPoint] {
    const { start, end } = selection
    return start.y < end.y || (start.y === end.y && start.x <= end.x) ? [start, end] : [end, start]
  }
  private highlight(lines: string[]): string[] {
    if (!this.selection?.moved) return lines
    const [start, end] = this.selectionBounds(this.selection)
    return lines.map((line, y) => {
      if (y < start.y || y > end.y) return line
      const from = y === start.y ? start.x : 0
      const to = y === end.y ? end.x + 1 : Infinity
      const selectedRow = this.selection!.rows[y]
      const currentRow = this.visible[y]
      if (!selectedRow || !currentRow || selectedRow.recordId !== currentRow.recordId || selectedRow.block !== currentRow.block || selectedRow.lineOffset !== currentRow.lineOffset) return line
      return viewportHighlightCells(line, from, to)
    })
  }
}
