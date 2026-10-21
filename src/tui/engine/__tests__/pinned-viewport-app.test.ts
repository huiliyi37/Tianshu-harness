import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LiveEngine, type LiveRegionLine } from '../live-engine.js'
import { makeApp, stripAnsi } from './_harness.js'

test('classic viewport fixes the prompt and composer to window edges across height and width changes', async t => {
  const frames: LiveRegionLine[][] = []
  const render = LiveEngine.prototype.render
  t.mock.method(LiveEngine.prototype, 'render', function (this: LiveEngine, lines: readonly LiveRegionLine[], options?: { reservedTail?: number }) {
    frames.push(lines.map(line => ({ ...line })))
    return render.call(this, lines, options)
  })
  const { app, out, stdin } = makeApp({ cols: 100, rows: 24 })
  t.after(() => app.dispose())
  app.onSubmit(() => {})
  app.setInput('keep this task at the top')
  stdin.dataHandler!('\r')
  await new Promise(resolve => setTimeout(resolve, 20))
  app.commitStatic('latest completed tool output')
  app.setInput('draft remains editable')
  const committed = app.getScrollbackContent()

  for (const [columns, rows] of [[100, 24], [100, 48], [60, 12], [120, 30], [40, 7], [100, 24]]) {
    out.columns = columns!
    out.rows = rows!
    app.forceRedraw()
    const frame = frames.at(-1)!
    const plain = frame.map(line => stripAnsi(line.text))
    assert.equal(frame.length, rows, 'the frame must occupy the current terminal height')
    assert.match(plain[0]!, /^› \[执行中\] keep this task/)
    assert.ok(plain.some(line => line.includes('latest completed tool output')), 'committed output stays visible')
    const caret = frame.findIndex(line => line.caretCol !== undefined)
    assert.ok(caret >= rows! - 4, 'the draft caret stays with the bottom composer')
    assert.ok(plain[caret]!.includes('draft remains editable'))
    assert.equal(app.getScrollbackContent(), committed, 'resizing and projection must not commit history again')
  }

  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 1, true)
  app.forceRedraw()
  assert.match(stripAnsi(frames.at(-1)![0]!.text), /^› \[上一轮\] keep this task/)
  app.clearScreen()
  const cleared = frames.at(-1)!.map(line => stripAnsi(line.text)).join('\n')
  assert.equal(cleared.includes('keep this task'), false)
  assert.equal(cleared.includes('latest completed tool output'), false, 'clear must not resurrect projected history')
})

test('leaving a fixed classic viewport returns the shell to a fresh bottom line exactly once', t => {
  const { app, out } = makeApp({ rows: 24 })
  t.after(() => app.dispose())
  app.setInput('keep the shell out of this draft')
  out.clear()
  app.restoreTerminalSync()
  assert.ok(out.chunks.join('').includes('\x1B[24;1H\r\n'))
  out.clear()
  app.restoreTerminalSync()
  assert.equal(out.chunks.length, 0, 'terminal restoration must remain idempotent')
})
