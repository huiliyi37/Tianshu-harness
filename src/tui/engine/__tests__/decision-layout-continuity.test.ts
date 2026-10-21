import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { makeApp, stripAnsi } from './_harness.js'
import type { LiveRegionLine } from '../live-engine.js'

/**
 * 收编公开仓 PR #475：内联决策卡（提问 / 计划审批）首弹时的 live 锚点与行预算。
 *
 * 缺陷一（锚点）：首个决策卡到达 → decision-controller 首弹回调 host.reveal() →
 * app.deactivateOverlay()。此前即使没有任何 overlay 在屏，退出逻辑仍会执行
 * `\r\x1B[0J` + live.reset()——live 增量绘制锚点被重置，旧 chrome 残留、
 * 决策卡从输入光标位置继续绘制，对话被分成上下两层。
 *
 * 缺陷二（内容生命周期）：收起后卡片正文必须退场，仅保留返回入口。
 * 经典模式现在保持满窗口高度，允许历史投影与 padding；总帧塌缩不再是验收条件。
 *
 * 断言基于「终态帧文本 + scrollback」：TerminalGrid 模拟 normal screen 的
 * 行为（光标移动、擦除、换行、scrollback），比 frame-only 断言更接近真实终端。
 */
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

    test(`${cols}x${rows} ${kind}: collapse removes the card, keeps the composer fixed and Tab restores selection`, async () => {
      const h = makeApp({ cols, rows })
      try {
        await (h.app as any).frontend.ready
        const live = (h.app as unknown as { live: { render: (lines: readonly LiveRegionLine[], opts?: { reservedTail?: number }) => void } }).live
        const render = live.render.bind(live)
        let frame: readonly LiveRegionLine[] = []
        live.render = (lines, opts) => { frame = lines; render(lines, opts) }
        const position = () => {
          assert.equal(frame.length, rows, 'decision transitions must retain the full terminal height')
          const caret = frame.findIndex(line => line.caretCol !== undefined)
          const bottom = frame.map(line => line.region).lastIndexOf('composer')
          assert.ok(caret >= rows - 4 && caret <= bottom)
          assert.ok(bottom >= rows - 2)
          return { caret, bottom }
        }
        if (kind === 'question') h.app.openAskUserQuestionPanel(question)
        else h.app.openPlanApprovalPanel(plan, { body: Array.from({ length: 30 }, (_, i) => `计划第${i + 1}行`).join('\n') })
        h.stdin.dataHandler!('\x1b[B')
        const cursor = h.app.decisions.active!.cursor
        const expanded = position()
        const cardText = kind === 'question' ? '按哪个范围落地修复' : '修复界面分层'
        assert.ok(frame.some(line => stripAnsi(line.text).includes(cardText)), 'expanded card content must be visible')
        assert.ok(frame.some(line => line.decisionPart === 'action'))
        h.stdin.dataHandler!('\x1b')
        await tick()
        assert.deepEqual(position(), expanded, 'collapsing a card must not lift the bottom composer')
        const collapsed = frame.map(line => stripAnsi(line.text)).join('\n')
        assert.match(collapsed, /Tab 返回卡片/, 'the collapsed card must retain its return control')
        assert.equal(collapsed.includes(cardText), false, 'the old card body must not remain in the frame')
        assert.equal(frame.filter(line => line.decisionPart).length, 1, 'only the return hint may remain from the card')
        h.stdin.dataHandler!('\t')
        await tick()
        assert.equal(h.app.decisions.active?.cursor, cursor, 'Tab must restore the card with the original selection')
        assert.equal(h.app.decisions.focused, true)
        assert.deepEqual(position(), expanded, 'restoring the card must keep the composer at the same screen rows')
        const cache = frame.map(line => stripAnsi(line.text))
        assert.equal(cache.join('\n').split(cardText).length - 1, 1, 'restoring must show one copy of the card')
        const footer = cache.findIndex(line => line.includes('Enter 确认'))
        const chrome = frame.findIndex(line => line.region === 'mode')
        assert.ok(footer >= 0 && chrome > footer && chrome - footer <= 2, 'restored confirmation controls must join the composer without stale card padding')
      } finally { h.app.dispose() }
    })
  }
}
