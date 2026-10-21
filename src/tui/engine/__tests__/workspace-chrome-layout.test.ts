import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripVTControlCharacters as plain } from 'node:util'
import { makeApp } from './_harness.js'
import type { LiveRegionLine } from '../live-engine.js'
import { displayWidth } from '../../width.js'
import { UIHistory } from '../../ui-history.js'
import { ConversationViewport, viewportPlainText } from '../conversation-viewport.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

for (const cols of [40, 80, 120]) {
  test(`${cols}×30：原生回滚下环境固定于输入边框、状态行常驻、跨轮不漂移`, async t => {
    const { app, out } = makeApp({ cols, rows: 30, modelName: 'deepseek-v4-flash' })
    t.after(() => app.dispose())
    const cwd = '/project/revit'
    app.setCwd(cwd)
    app.setSessionStarDomain('启明')
    const priv = app as unknown as {
      live: { render: (lines: LiveRegionLine[], options: { reservedTail: number }) => void }
      handleTurnComplete: (usage: object, turn: number, final: boolean) => Promise<void>
    }
    let frame: LiveRegionLine[] = [], reservedTail = 0
    const original = priv.live.render.bind(priv.live)
    priv.live.render = (lines, options) => {
      frame = lines; reservedTail = options.reservedTail
      original(lines, options)
    }
    const check = () => {
      const texts = frame.map(row => plain(row.text))
      const composer = frame.findIndex(row => row.region === 'composer')
      const status = frame.findIndex(row => row.region === 'mode')
      // 环境（星域/分支/cwd）固定于输入边框，状态行紧随其上——两者都在固定 chrome 区。
      assert.ok(status >= frame.length - reservedTail && status < composer, JSON.stringify(texts))
      assert.ok(composer >= frame.length - reservedTail, JSON.stringify(texts))
      assert.ok(texts[composer]?.includes('启明'), JSON.stringify(texts))
      // 窄屏（<60 列）状态行对模型名 slice(0,12)，谓词取前缀。
      assert.equal(texts.filter(row => row.includes(cols >= 60 ? 'deepseek-v4-flash' : 'deepseek-v4')).length, 1)
      assert.equal(texts.filter(row => row.includes('启明')).length, 1)
      assert.equal(texts.filter(row => row.includes('工作区：')).length, 0)
      if (cols >= 60) {
        assert.ok(texts[composer]?.includes(cwd), JSON.stringify(texts))
        assert.equal(texts.filter(row => row.includes(cwd)).length, 1)
      }
      assert.ok(frame.every(row => displayWidth(row.text) < cols))
      assert.ok(frame.some(row => row.caretCol !== undefined))
    }
    app.setInput('检查排版')
    await flush(); check()
    for (let turn = 1; turn <= 2; turn++) {
      app.callbacks.onThinkingDelta('分析代码结构。\n'.repeat(8))
      await flush(); check()
      app.callbacks.onTextDelta('回复正文。\n')
      await flush(); check()
      await priv.handleTurnComplete({ input_tokens: 10, output_tokens: 5 }, turn, true)
      await flush(); check()
    }
    assert.ok(!out.chunks.join('').includes('\x1b[?1049h'), '原生回滚不能切换到 alternate screen')
  })
}

test('历史查看器保留嵌套列表与原编号，宽屏正文和实时渲染使用相同宽度', async () => {
  const history = await UIHistory.open()
  const text = '另有 ' + '甲'.repeat(30) + ' desktop/surfaces/ThreadView.tsx 等在对应主题内。'
  history.append({ kind: 'assistant', text: `${text}\n\n3. 主项\n   - 子项目\n4. 下一项` })
  const viewport = new ConversationViewport(history, () => {})
  await viewport.prepare(120, 30)
  const rows = viewport.render(120, 30).map(viewportPlainText)
  assert.ok(rows.some(row => row.includes(text)), rows.join('\n'))
  assert.ok(rows.some(row => row.trimStart() === '3. 主项'), rows.join('\n'))
  assert.ok(rows.some(row => /^ {5}◇ 子项目/.test(row)), rows.join('\n'))
  assert.ok(rows.some(row => row.trimStart() === '4. 下一项'), rows.join('\n'))
  assert.ok(rows.every(row => displayWidth(row) < 120))
})

for (const [cols, rows] of [[120, 30], [80, 24], [40, 24], [120, 50]] as const) {
  test(`${cols}×${rows}: metrics stay visible and menu/idle keep the composer at the viewport bottom`, async t => {
    const { app } = makeApp({ cols, rows })
    t.after(() => app.dispose())
    const priv = app as unknown as {
      state: { phase: string }
      live: { render: (lines: LiveRegionLine[], options: { reservedTail: number }) => void }
      renderLive: () => void
    }
    let frame: LiveRegionLine[] = []
    priv.live.render = lines => { frame = lines }
    const anchored = () => {
      assert.equal(frame.length, rows, 'classic frames occupy the current terminal height')
      const mode = frame.findIndex(line => line.region === 'mode')
      const composer = frame.findIndex(line => line.region === 'composer')
      const caret = frame.findIndex(line => line.caretCol !== undefined)
      const bottom = frame.map(line => line.region).lastIndexOf('composer')
      assert.ok(mode >= rows - 7 && mode < composer, 'metrics and mode remain beside the bottom composer')
      assert.ok(caret >= composer && caret < bottom, 'the editable caret remains inside the composer')
      assert.ok(bottom >= rows - 2, 'only the ordinary prompt footer may follow the composer')
      return { caret, bottom }
    }
    app.setGitBranch('feature/中文')
    app.setReasoningEffortProvider(() => 'high')
    app.setMetricsProvider(() => ({ estimatedTokens: 32000, conversationTokens: 100, maxTokens: 64000,
      cacheHitRate: .98, cacheStatus: 'degraded', cost: 1.25, costSource: 'api',
      inputTokens: 100, outputTokens: 10, lastRealPromptTokens: 32000 }))
    app.setInput('测试')
    priv.renderLive()
    let text = frame.map(row => plain(row.text)).join('\n')
    assert.match(text, /⚡98%冷/)
    assert.match(text, /◧50%/)
    assert.match(text, /API ?¥1\.25/)
    assert.doesNotMatch(text, /后台 0/)
    assert.doesNotMatch(text, /\/metrics/)
    if (cols >= 80) { assert.match(text, /feature\/中文/); assert.match(text, /◎high/) }
    const resting = anchored()
    app.setInput('/')
    priv.renderLive()
    assert.deepEqual(anchored(), resting, 'opening the menu must not lift the input box')
    priv.state.phase = 'streaming'
    app.setInput('继续')
    priv.renderLive()
    assert.deepEqual(anchored(), resting, 'closing the menu during a run must keep the input box fixed')
    priv.state.phase = 'idle'
    priv.renderLive()
    assert.deepEqual(anchored(), resting, 'settling to idle must keep the input box at the same screen rows')
    assert.ok(frame.every(row => displayWidth(row.text) < cols))
    app.setMetricsProvider(() => null)
    priv.renderLive()
    text = frame.map(row => plain(row.text)).join('\n')
    assert.match(text, /⚡-/)
    assert.doesNotMatch(text, /¥/)
  })
}

for (const cols of [40, 80, 120]) test(`${cols}: long live tail keeps activity and disclosure in separate rows`, t => {
  const { app } = makeApp({ cols, rows: 30 })
  t.after(() => app.dispose())
  const priv = app as unknown as { live: { render: (lines: LiveRegionLine[]) => void }; renderLive: () => void }
  let frame: LiveRegionLine[] = []
  priv.live.render = lines => { frame = lines }
  app.callbacks.onTextDelta('长段落'.repeat(600))
  priv.renderLive()
  assert.ok(frame.some(row => row.livePart === 'status'))
  const notice = frame.find(row => row.livePart === 'disclosure')
  assert.ok(notice, frame.map(row => plain(row.text)).join('\n'))
  assert.match(plain(notice.text), new RegExp(`末 ${frame.filter(row => row.livePart === 'tail').length} 行`))
  assert.ok(frame.some(row => row.caretCol !== undefined))
})

for (const name of ['read_file', 'bash']) test(`${name}: collapsed results retain their captured raw source`, t => {
  const { app } = makeApp()
  t.after(() => app.dispose())
  app.callbacks.onToolUse('raw-source', name, name === 'bash' ? { command: 'pwd' } : { file_path: 'a.ts' })
  app.callbacks.onToolResult('raw-source', name, 'output\n'.repeat(12), false, '/tmp/tui-source.raw')
  app.callbacks.onTextDelta('已完成')
  app.callbacks.onTurnComplete({}, 1, true)
  assert.match(plain(app.getScrollbackContent()), /全文来源: \/tmp\/tui-source.raw/)
})

test('resize after menu expansion recomputes the full viewport and bottom composer', t => {
  const { app, out } = makeApp({ cols: 120, rows: 50 })
  t.after(() => app.dispose())
  const priv = app as unknown as {
    state: { phase: string }; renderLive: () => void
    live: { render: (lines: LiveRegionLine[]) => void }
  }
  let frame: LiveRegionLine[] = []
  priv.live.render = lines => { frame = lines }
  app.setInput('/')
  priv.state.phase = 'streaming'
  app.setInput('继续')
  for (const [columns, rows] of [[80, 24], [120, 50], [40, 12], [80, 30]] as const) {
    out.columns = columns; out.rows = rows
    priv.renderLive()
    assert.equal(frame.length, rows, 'resizing must use the new viewport height immediately')
    const composer = frame.findIndex(line => line.region === 'composer')
    const caret = frame.findIndex(line => line.caretCol !== undefined)
    const bottom = frame.map(line => line.region).lastIndexOf('composer')
    assert.ok(caret >= rows - 4 && caret >= composer, 'the caret must stay at the new window bottom')
    assert.ok(bottom >= rows - 2, 'the composer must be followed only by its optional footer')
    const mode = frame.findIndex(line => line.region === 'mode')
    if (mode >= 0) assert.ok(mode < composer && mode >= rows - 7)
    assert.ok(frame.every(line => displayWidth(line.text) < columns), 'resizing must also use the new width')
  }
})

test('narrow telemetry details command is local and includes the omitted branch and effort', async t => {
  const { app } = makeApp({ cols: 40, rows: 24 })
  t.after(() => app.dispose())
  let modelCalls = 0
  app.onSubmit(() => { modelCalls++ })
  app.setGitBranch('feature/omitted-details')
  app.setReasoningEffortProvider(() => 'high')
  assert.equal(await app.tryDispatchSlash('/metrics'), true)
  assert.match(plain(app.getScrollbackContent()), /feature\/omitted-details/)
  assert.match(plain(app.getScrollbackContent()), /推理 high/)
  assert.equal(modelCalls, 0)
})
