import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { makeApp } from './_harness.js'

// Normal-screen grid with scrollback; unlike frame-only assertions it retains escaped chrome.
class TerminalGrid {
  private grid: string[][]
  private history: string[] = []
  private row = 0
  private col = 0
  constructor(private columns: number, private rows: number) { this.grid = Array.from({ length: rows }, () => this.blank()) }
  private blank(): string[] { return Array(this.columns).fill(' ') }
  private feed(): void {
    if (this.row === this.rows - 1) { this.history.push(this.grid.shift()!.join('').trimEnd()); this.grid.push(this.blank()) }
    else this.row++
  }
  write(chunk: string): void {
    const tokens = chunk.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\s\S]/gu) ?? []
    for (const token of tokens) {
      if (token.startsWith('\x1b[')) {
        const match = /^\x1b\[([?]?)([0-9;]*)([A-Za-z])$/.exec(token)
        if (!match || match[1]) continue
        const parts = match[2]!.split(';').map(x => Number(x) || 1), n = parts[0]!
        switch (match[3]) {
          case 'A': this.row = Math.max(0, this.row - n); break
          case 'B': this.row = Math.min(this.rows - 1, this.row + n); break
          case 'G': this.col = Math.min(this.columns - 1, n - 1); break
          case 'H': this.row = Math.min(this.rows - 1, n - 1); this.col = (parts[1] ?? 1) - 1; break
          case 'J':
            if (match[2] === '2') this.grid = Array.from({ length: this.rows }, () => this.blank())
            else { this.grid[this.row]!.fill(' ', this.col); for (let r = this.row + 1; r < this.rows; r++) this.grid[r] = this.blank() }
            break
          case 'K': this.grid[this.row]!.fill(' ', match[2] === '2' ? 0 : this.col); break
        }
        continue
      }
      if (token.startsWith('\x1b]')) continue
      if (token === '\n') { this.feed(); this.col = 0; continue }
      if (token === '\r') { this.col = 0; continue }
      const width = stringWidth(token)
      if (!width) continue
      if (this.col + width > this.columns) { this.feed(); this.col = 0 }
      this.grid[this.row]![this.col] = token
      for (let c = 1; c < width; c++) this.grid[this.row]![this.col + c] = ''
      this.col += width
    }
  }
  text(): string { return [...this.history, ...this.grid.map(row => row.join('').trimEnd())].join('\n') }
}

const question = { requestId: 'layering-question', questions: [{ id: 'scope', prompt: '按哪个范围落地修复？', allowMultiple: false,
  options: ['前置归一化', '保守变体', '只改提示词', '增加修复按钮'], optionDetails: [{ recommended: true,
    description: '保留合法形状并修复兼容性', recommendationReason: '覆盖当前目标并保持现有流程' }, {}, {}, {}] }] }
const plan = { requestId: 'layering-plan', slug: 'layering-plan', title: '修复界面分层', options: [
  { label: '最小修复', description: '修复光标定位', recommended: true, recommendationReason: '保持现有行为' },
  { label: '扩展方案', description: '扩展界面' }] }
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

for (const [cols, rows] of [[120, 30], [80, 24]] as const) {
  for (const kind of ['question', 'plan'] as const) {
    test(`${cols}x${rows} ${kind}: first decision leaves one chrome across the whole terminal and scrollback`, async () => {
      const h = makeApp({ cols, rows, modelName: 'ONE_CHROME_MODEL', autoStart: false })
      const terminal = new TerminalGrid(cols, rows)
      h.out.write = chunk => { h.out.chunks.push(chunk); terminal.write(chunk); return true }
      try {
        h.app.start(); await (h.app as any).frontend.ready
        h.app.commitStatic('对话正文必须保留')
        if (kind === 'question') h.app.openAskUserQuestionPanel(question)
        else h.app.openPlanApprovalPanel(plan, { body: '计划正文必须可见' })
        await tick()
        const text = terminal.text()
        assert.match(text, /对话正文必须保留/)
        assert.match(text, kind === 'question' ? /按哪个范围落地修复/ : /计划审批.*修复界面分层/)
        assert.equal(text.split('ONE_CHROME_MODEL').length - 1, 1, 'opening a decision must erase the old chrome rather than append beneath its caret')
        h.app.commitStatic('轮次完成摘要')
        await tick()
        assert.equal(terminal.text().split('ONE_CHROME_MODEL').length - 1, 1, 'a subsequent commit must keep the same single live region')
      } finally { h.app.dispose() }
    })

    test(`${cols}x${rows} ${kind}: collapse releases card height and Tab preserves selection without a blank band`, async () => {
      const h = makeApp({ cols, rows })
      try {
        await (h.app as any).frontend.ready
        if (kind === 'question') h.app.openAskUserQuestionPanel(question)
        else h.app.openPlanApprovalPanel(plan, { body: Array.from({ length: 30 }, (_, i) => `计划第${i + 1}行`).join('\n') })
        h.stdin.dataHandler!('\x1b[B')
        const cursor = h.app.decisions.active!.cursor
        const expanded = (h.app as any).live.lastDisplayRows
        h.stdin.dataHandler!('\x1b')
        await tick()
        const collapsed = (h.app as any).live.lastDisplayRows
        assert.ok(collapsed <= 7, `collapsed card must leave only its return hint and input chrome, got ${collapsed}`)
        assert.ok(collapsed < expanded)
        h.stdin.dataHandler!('\t')
        await tick()
        assert.equal(h.app.decisions.active?.cursor, cursor)
        assert.equal(h.app.decisions.focused, true)
        const cache: string[] = (h.app as any).live.lineCache
        const footer = cache.findIndex(line => line.includes('Enter 确认'))
        const chrome = cache.findIndex(line => line.includes('test'))
        assert.ok(chrome - footer <= 2, 'restored card must join the composer without old height padding')
      } finally { h.app.dispose() }
    })
  }
}
