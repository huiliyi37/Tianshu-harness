import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommittedHistoryViewport, layoutPinnedViewport, projectCommittedHistory } from '../pinned-viewport.js'
import { LiveEngine, type LiveRegionLine } from '../live-engine.js'
import { displayWidth } from '../../width.js'
import { makeApp } from './_harness.js'

const chrome: LiveRegionLine[] = [
  { text: 'mode', region: 'mode' },
  { text: 'top border', region: 'composer' },
  { text: '❯ draft', region: 'composer', inputLine: 0, caretCol: 2 },
  { text: 'bottom border', region: 'composer' },
]

test('prompt stays at the first viewport row, history remains visible and composer stays last after resize', () => {
  const historyLines = Array.from({ length: 60 }, (_, index) => `committed ${index}`)
  for (const status of ['执行中', '上一轮']) {
    const prompt: LiveRegionLine = { text: `› [${status}] improve rendering`, livePart: 'pinned' }
    const dynamic: LiveRegionLine[] = [prompt, { text: 'working', livePart: 'status' }]
    const input = [...dynamic, ...chrome]
    for (const rows of [24, 45, 12, 30]) {
      const frame = layoutPinnedViewport(input, dynamic.length, { rows, historyLines })
      assert.equal(frame.lines.length, rows)
      assert.equal(frame.lines[0], prompt)
      assert.equal(frame.lines.at(-1), chrome.at(-1))
      assert.ok(frame.lines.some(line => line.text === 'committed 59'), 'latest committed output must remain visible')
      assert.ok(frame.lines.some(line => line.text === 'working'))
      assert.equal(frame.lines[frame.chromeStart + 2]?.caretCol, 2)
    }
    assert.deepEqual(input, [...dynamic, ...chrome], 'layout must not mutate source messages or caret metadata')
  }
})

test('overflow preserves the prompt, status and latest activity while reserving a short history tail', () => {
  const prompt: LiveRegionLine = { text: '› [执行中] run', livePart: 'pinned' }
  const dynamic: LiveRegionLine[] = [prompt, { text: 'working', livePart: 'status' },
    ...Array.from({ length: 40 }, (_, index) => ({ text: `tail ${index}`, livePart: 'tail' as const }))]
  const frame = layoutPinnedViewport([...dynamic, ...chrome], dynamic.length, { rows: 15, historyLines: ['h1', 'h2', 'h3', 'h4'] })
  assert.equal(frame.lines.length, 15)
  assert.equal(frame.lines[0], prompt)
  for (const text of ['working', 'tail 39', 'h2', 'h3', 'h4']) assert.ok(frame.lines.some(line => line.text === text))
  assert.equal(frame.lines.at(-1), chrome.at(-1))
})

test('short decision windows protect action and edit caret before decorative input borders', () => {
  const dynamic: LiveRegionLine[] = [
    { text: '› [执行中] run', livePart: 'pinned' },
    { text: 'Approval', decisionPart: 'title' },
    { text: 'Facts', decisionPart: 'fact' },
    { text: 'Allow / Deny', decisionPart: 'action' },
  ]
  const frame = layoutPinnedViewport([...dynamic, ...chrome], dynamic.length, { rows: 4, historyLines: ['old1', 'old2', 'old3'] })
  assert.equal(frame.lines.length, 4)
  assert.equal(frame.lines[0]?.livePart, 'pinned')
  assert.ok(frame.lines.some(line => line.decisionPart === 'action'))
  assert.ok(frame.lines.some(line => line.caretCol === 2))
  const tiny = layoutPinnedViewport([...dynamic, ...chrome], dynamic.length, { rows: 1 })
  assert.equal(tiny.lines.length, 1)
  assert.equal(tiny.lines[0]?.caretCol, 2)
})

test('committed history projection reflows ANSI and CJK without re-emitting terminal controls', () => {
  const text = 'old line\n\x1b[31m中文🙂abcdef\x1b[0m\n\x1b[2Jlast line'
  const tail = projectCommittedHistory(text, 6, 3)
  assert.equal(tail.length, 3)
  assert.ok(tail.every(line => displayWidth(line) <= 6))
  assert.ok(tail.join('').includes('last line'))
  assert.equal(tail.join('').includes('\x1b[2J'), false)
  assert.equal(tail.join('').includes('old line'), false)
  assert.deepEqual(projectCommittedHistory(text, 6, 0), [])
})

test('history tail retains a style opened on an earlier committed line and closes it before chrome', () => {
  const tail = projectCommittedHistory('\x1b[31mfirst\nsecond\nthird\x1b[0m', 80, 1)
  assert.deepEqual(tail, ['\x1b[31mthird\x1b[0m'])
})

class HistorySource {
  entries: string[] = []
  reads = 0
  get revision(): number { return this.entries.length }
  getContentSince(revision: number): string { this.reads++; return this.entries.slice(revision).join('\n') }
}

test('history projection caches unchanged revisions and geometry and reserves the terminal last column', () => {
  const history = new HistorySource()
  history.entries.push('abcdefghij')
  const viewport = new CommittedHistoryViewport()
  const first = viewport.project(history, 6, 3)
  assert.deepEqual(first, ['abcde', 'fghij'])
  assert.equal(viewport.project(history, 6, 3), first, 'unchanged frames reuse the same projection')
  assert.equal(history.reads, 1)
  assert.deepEqual(viewport.project(history, 4, 3), ['def', 'ghi', 'j'])
  assert.deepEqual(viewport.project(history, 4, 1), ['j'])
  assert.equal(history.reads, 3)
  history.entries.push('latest')
  assert.deepEqual(viewport.project(history, 4, 1), ['est'])
  assert.equal(history.reads, 4)
})

test('clear excludes old history across resize, preserves the pager source and admits later commits', () => {
  const history = new HistorySource()
  history.entries.push('old command', 'old response')
  const viewport = new CommittedHistoryViewport()
  assert.ok(viewport.project(history, 80, 20).length)
  viewport.clear(history.revision)
  assert.deepEqual(viewport.project(history, 80, 20), [])
  assert.deepEqual(viewport.project(history, 40, 10), [])
  assert.equal(history.reads, 1, 'cleared history should not be reread on resize')
  history.entries.push('new command')
  assert.deepEqual(viewport.project(history, 80, 20), ['new command'])
  assert.deepEqual(history.entries, ['old command', 'old response', 'new command'], 'display clear must preserve native/pager history')
})

test('switching history sources never reuses another session projection with the same revision', () => {
  const first = new HistorySource(), second = new HistorySource()
  first.entries.push('first session')
  second.entries.push('second session')
  const viewport = new CommittedHistoryViewport()
  viewport.project(first, 80, 20)
  viewport.clear(first.revision)
  assert.deepEqual(viewport.project(second, 80, 20), ['second session'])
})

test('history tail is budgeted in display rows even if a caller provides a wrapped logical line', () => {
  const dynamic: LiveRegionLine[] = [{ text: 'prompt', livePart: 'pinned' }]
  const input: LiveRegionLine = { text: 'input', caretCol: 0 }
  const frame = layoutPinnedViewport([...dynamic, input], 1, {
    rows: 6, historyLines: ['first', 'wrapped history', 'last'],
    rowsForLine: text => text === 'wrapped history' ? 3 : 1,
  })
  const physicalRows = frame.lines.reduce((sum, line) => sum + (line.text === 'wrapped history' ? 3 : 1), 0)
  assert.equal(physicalRows, 6)
  assert.equal(frame.lines[0]?.livePart, 'pinned')
  assert.equal(frame.lines.at(-1), input)
})

test('a very short viewport retains live status ahead of a three-row history reservation', () => {
  const dynamic: LiveRegionLine[] = [{ text: 'prompt', livePart: 'pinned' }, { text: 'working', livePart: 'status' }]
  const frame = layoutPinnedViewport([...dynamic, ...chrome], 2, { rows: 8, historyLines: ['h1', 'h2', 'h3'] })
  assert.equal(frame.lines.length, 8)
  assert.ok(frame.lines.some(line => line.text === 'working'))
})

test('a tall side panel cannot enlarge the fixed main viewport after a height resize', async t => {
  const frames: LiveRegionLine[][] = []
  const render = LiveEngine.prototype.render
  t.mock.method(LiveEngine.prototype, 'render', function (this: LiveEngine, lines: readonly LiveRegionLine[], options?: { reservedTail?: number }) {
    frames.push(lines.map(line => ({ ...line })))
    return render.call(this, lines, options)
  })
  const { app, out, stdin } = makeApp({ cols: 140, rows: 24 })
  t.after(() => app.dispose())
  app.onSubmit(() => {})
  app.setInput('keep this command at the top')
  stdin.dataHandler!('\r')
  await new Promise(resolve => setImmediate(resolve))
  app.setSidePanelOpen(true)
  app.setTodos([{ id: 'side-task', content: 'current task', status: 'in_progress' }])
  app.setInput('draft')

  for (const rows of [8, 4, 12, 24]) {
    out.rows = rows
    app.forceRedraw()
    const frame = frames.at(-1)!
    assert.equal(frame.length, rows, 'a side panel must fit the main viewport rather than add rows beneath it')
    assert.equal(frame[0]?.livePart, 'pinned', 'the side panel must not push the fixed prompt out of the row budget')
    assert.ok(frame.findIndex(line => line.caretCol !== undefined) >= rows - 4)
    const bottomComposer = frame.map(line => line.region).lastIndexOf('composer')
    assert.ok(rows - bottomComposer <= 2, 'only the normal prompt footer may follow the bottom composer')
  }
})
