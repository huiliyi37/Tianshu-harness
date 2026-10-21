import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WriteStream } from 'node:tty'
import { LiveEngine, type LiveEngineOptions } from '../live-engine.js'

/** Normal-buffer geometry: growing a terminal adds blank rows below the cursor. */
class ViewportTerminal {
  columns = 80
  rows: number
  cursorRow = 0
  cursorCol = 0
  writes: string[] = []
  screen: string[][]
  scrollback: string[] = []

  constructor(rows: number) {
    this.rows = rows
    this.screen = Array.from({ length: rows }, () => [])
  }

  resize(rows: number, caretRow = this.cursorRow): void {
    this.rows = rows
    while (this.screen.length < rows) this.screen.push([])
    this.screen = this.screen.slice(0, rows)
    this.cursorRow = Math.min(caretRow, rows - 1)
  }

  resizeColumns(columns: number, caretRow = this.cursorRow): void {
    this.columns = columns
    this.screen = this.screen.map(line => line.slice(0, columns))
    this.cursorRow = Math.min(caretRow, this.rows - 1)
    this.cursorCol = Math.min(this.cursorCol, columns - 1)
  }

  flush(): string { const output = this.writes.join(''); this.writes = []; return output }
  line(row: number): string { return (this.screen[row] ?? []).join('').trimEnd() }

  write = (text: string): boolean => {
    this.writes.push(text)
    for (let i = 0; i < text.length;) {
      // eslint-disable-next-line no-control-regex -- Interpret the ANSI emitted by the renderer.
      const csi = /^\x1b\[([\d;?]*)([A-Za-z])/.exec(text.slice(i))
      if (csi) {
        const [, params = '', op] = csi
        const parts = params.replace(/^\?/, '').split(';').map(Number)
        const n = parts[0] || 1
        if (op === 'A') this.cursorRow = Math.max(0, this.cursorRow - n)
        else if (op === 'B') this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n)
        else if (op === 'G') this.cursorCol = Math.max(0, n - 1)
        else if (op === 'H' || op === 'f') {
          this.cursorRow = Math.max(0, Math.min(this.rows - 1, n - 1))
          this.cursorCol = Math.max(0, (parts[1] || 1) - 1)
        } else if (op === 'J') {
          if (parts[0] === 2) this.screen = Array.from({ length: this.rows }, () => [])
          else {
            this.screen[this.cursorRow] = this.screen[this.cursorRow]!.slice(0, this.cursorCol)
            for (let row = this.cursorRow + 1; row < this.rows; row++) this.screen[row] = []
          }
        } else if (op === 'K') {
          this.screen[this.cursorRow] = parts[0] === 2 ? [] : this.screen[this.cursorRow]!.slice(0, this.cursorCol)
        }
        i += csi[0].length
        continue
      }
      const ch = text[i++]!
      if (ch === '\r') { this.cursorCol = 0; continue }
      if (ch === '\n') {
        this.cursorCol = 0
        if (this.cursorRow === this.rows - 1) {
          this.scrollback.push(this.screen.shift()!.join(''))
          this.screen.push([])
        } else this.cursorRow++
        continue
      }
      if (ch < ' ') continue
      this.screen[this.cursorRow]![this.cursorCol++] = ch
    }
    return true
  }
}

function createEngine(terminal: ViewportTerminal): LiveEngine {
  const options: LiveEngineOptions = {
    stdout: terminal as unknown as WriteStream,
    reservedRows: 0,
    maxRows: terminal.rows,
    fullViewport: true,
  }
  return new LiveEngine(options)
}

/** The classic projection owns the visible grid; only formal commits enter scrollback. */
const frame = (rows: number, history = ['previous answer']) => [
  { text: 'TOP' },
  ...history.map(text => ({ text })),
  ...Array.from({ length: Math.max(0, rows - history.length - 3) }, () => ({ text: '' })),
  { text: 'INPUT', caretCol: 2 },
  { text: 'BOTTOM' },
]

test('a full-height normal-buffer frame anchors the header and composer from its first append', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  assert.equal(terminal.line(0), 'TOP')
  assert.equal(terminal.line(11), 'BOTTOM')
  assert.equal(terminal.line(10), 'INPUT')
  assert.equal(terminal.cursorRow, 10)
  assert.equal(terminal.line(1), 'previous answer', 'the read-only projection keeps the conversation visible')
  assert.deepEqual(terminal.scrollback, ['previous answer'], 'the formal history stays in the native buffer')
})

test('height-only growth moves the composer down and removes its old footprint', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  terminal.flush()
  terminal.resize(20, 11)
  engine.setMaxRows(terminal.rows)
  engine.render(frame(terminal.rows))
  assert.equal(terminal.line(0), 'TOP')
  assert.equal(terminal.line(19), 'BOTTOM', 'height changes must not hit the unchanged-text fast path')
  assert.equal(terminal.cursorRow, 18)
  assert.equal(terminal.line(10), '', 'the previous composer must not remain as a ghost')
  assert.deepEqual(terminal.scrollback, ['previous answer'], 'resize must not scroll a preview into native history')
  terminal.flush()
  engine.render(frame(terminal.rows))
  assert.equal(terminal.flush(), '', 'a settled composer must retain zero-output idle frames')
})

test('height-only shrink keeps the whole composer inside the smaller viewport', () => {
  const terminal = new ViewportTerminal(20)
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  terminal.resize(8)
  engine.setMaxRows(terminal.rows)
  engine.render(frame(terminal.rows))
  assert.equal(terminal.line(0), 'TOP')
  assert.equal(terminal.line(6), 'INPUT')
  assert.equal(terminal.line(7), 'BOTTOM')
  assert.equal(terminal.cursorRow, 6)
})

test('pure width resize reanchors unchanged full-viewport content without leaving a stale footer', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  terminal.flush()
  terminal.resizeColumns(40, 11)
  engine.render(frame(terminal.rows))
  assert.notEqual(terminal.flush(), '', 'a width change must invalidate a visually identical frame')
  assert.equal(terminal.line(0), 'TOP')
  assert.equal(terminal.line(10), 'INPUT')
  assert.equal(terminal.line(11), 'BOTTOM')
  assert.equal(terminal.cursorRow, 10)
  assert.deepEqual(terminal.scrollback, ['previous answer'], 'relative reflow recovery must not leak an old header')
  assert.equal(terminal.screen.filter((_, row) => terminal.line(row) === 'BOTTOM').length, 1)
})

test('identical owned frames retain the zero-write idle path', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  terminal.flush()
  for (let i = 0; i < 8; i++) engine.render(frame(terminal.rows))
  assert.equal(terminal.flush(), '')
  assert.equal(terminal.cursorRow, 10)
  assert.deepEqual(terminal.scrollback, ['previous answer'])
})

test('screen-reader mode releases ownership before compact output and can restore the full viewport', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  engine.setFullViewport(false)
  terminal.write('reader answer\n')
  const compact = [{ text: 'INPUT', caretCol: 2 }, { text: 'BOTTOM' }]
  engine.render(compact)
  assert.equal(terminal.line(0), 'reader answer')
  assert.equal(terminal.line(1), 'INPUT')
  assert.equal(terminal.line(2), 'BOTTOM')
  terminal.flush()
  engine.setFullViewport(false)
  terminal.resize(20)
  engine.render(compact)
  assert.equal(terminal.flush(), '', 'an unchanged compact reader frame must not be treated as an owned grid')
  assert.equal(terminal.line(0), 'reader answer')
  assert.equal(terminal.line(2), 'BOTTOM')
  engine.setFullViewport(true)
  engine.setMaxRows(terminal.rows)
  engine.render(frame(terminal.rows, ['reader answer']))
  assert.equal(terminal.line(0), 'TOP')
  assert.equal(terminal.line(1), 'reader answer')
  assert.equal(terminal.line(18), 'INPUT')
  assert.equal(terminal.line(19), 'BOTTOM')
  assert.deepEqual(terminal.scrollback, ['previous answer', 'reader answer'])
})

test('formal commits enter native scrollback once while the live preview is erased first', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  engine.clearForCommit()
  terminal.write('next answer\n')
  engine.render(frame(terminal.rows, ['previous answer', 'next answer']))
  assert.deepEqual(terminal.scrollback, ['previous answer', 'next answer'])
  assert.equal(terminal.line(0), 'TOP')
  assert.equal(terminal.line(2), 'next answer')
  assert.equal(terminal.line(11), 'BOTTOM')
})

test('resize immediately followed by a commit clears the old owned viewport before appending', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  const engine = createEngine(terminal)
  engine.render(frame(terminal.rows))
  // Some terminals reposition the cursor during resize, independently of its old IME row.
  terminal.resize(20, 11)
  engine.setMaxRows(terminal.rows)
  engine.clearForCommit()
  terminal.write('next answer\n')
  engine.render(frame(terminal.rows, ['previous answer', 'next answer']))
  assert.deepEqual(terminal.scrollback, ['previous answer', 'next answer'], 'the old header/input must not be committed as history')
  assert.equal(terminal.line(0), 'TOP')
  assert.equal(terminal.line(18), 'INPUT')
  assert.equal(terminal.line(19), 'BOTTOM')
})

test('full-viewport pollution recovery does not scroll the previous header into native history', () => {
  const terminal = new ViewportTerminal(12)
  terminal.write('previous answer\n')
  let polluted = 0
  const engine = new LiveEngine({
    stdout: terminal as unknown as WriteStream,
    maxRows: terminal.rows,
    fullViewport: true,
    onProbeRequest: () => {},
    onPolluted: () => { polluted++ },
  })
  engine.render(frame(terminal.rows))
  engine.noteCpr(terminal.cursorRow + 1, terminal.cursorCol + 1)
  terminal.write('\n')
  engine.noteCpr(terminal.cursorRow + 1, terminal.cursorCol + 1)
  assert.equal(polluted, 1)
  engine.render(frame(terminal.rows))
  assert.equal(terminal.line(0), 'TOP')
  assert.deepEqual(terminal.scrollback, ['previous answer'], 'recovery must erase the old preview before writing a full new one')
})

test('releasing a caret resets CPR column comparison without masking later external writes', context => {
  let now = 10_000, probes = 0, polluted = 0
  context.mock.method(Date, 'now', () => now)
  const terminal = new ViewportTerminal(3)
  const engine = new LiveEngine({
    stdout: terminal as unknown as WriteStream,
    maxRows: 3,
    onProbeRequest: () => { probes++ },
    onPolluted: () => { polluted++ },
  })
  engine.render([{ text: 'TOP' }, { text: 'INPUT', caretCol: 2 }, { text: 'BOTTOM' }])
  engine.noteCpr(terminal.cursorRow + 1, terminal.cursorCol + 1)
  now += 1000
  engine.render([{ text: 'TOP' }, { text: 'INPUT' }, { text: 'BOTTOM' }])
  assert.equal(probes, 2)
  engine.noteCpr(terminal.cursorRow + 1, terminal.cursorCol + 1)
  assert.equal(polluted, 0, 'the new end-row column must not be compared with the old caret column')
  now += 1000
  terminal.write('\r!')
  engine.requestProbe()
  engine.noteCpr(terminal.cursorRow + 1, terminal.cursorCol + 1)
  assert.equal(polluted, 1, 'later unsolicited column movement must still be detected')
})
