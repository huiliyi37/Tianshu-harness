/**
 * 活动期定高视口测试（TUI 输入框钉底）。
 *
 * 契约：
 *  1. padDynamicRegion 把动态段垫高/截断到恰好 budget display rows：
 *     - 不足 → 在动态内容与 chrome 之间垫空行（内容贴上、输入框贴下）；
 *     - 超出 → 从顶部截最旧行（approval 等关键内容在动态段尾部，天然保留）；
 *     - budget<=0 → 纯函数原样返回。
 *  2. TuiApp 活动期（thinking/streaming）连续帧的 live region 总 display rows
 *     恒定 —— 输入框屏幕坐标不随字符增长浮动。
 *  3. 活动、空闲与菜单开合均保持完整终端高度，输入框不移动。
 *  4. 小终端（rows=10）预算收缩，live region 不超屏。
 *  5. liveMaxRowsFor 保留旧区域/读屏预算语义；经典满窗口视口独立按 rows 计算。
 *  6. 审批、菜单与历史投影共享输入框上方的空间，不改变终端视口高度。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padDynamicRegion, type LiveRegionLine } from '../live-engine.js'
import { liveMaxRowsFor } from '../app.js'
import { makeApp, stripAnsi } from './_harness.js'

const L = (...texts: string[]): LiveRegionLine[] => texts.map(text => ({ text }))

// ── padDynamicRegion 纯函数 ─────────────────────────────────────

test('不足预算：动态内容与 chrome 之间垫空行到恰好 budget，chromeStart 相应后移', () => {
  const lines = [...L('spinner', 'thinking'), ...L('input-top', 'input', 'input-bot')]
  const r = padDynamicRegion(lines, 2, 6)
  assert.equal(r.chromeStart, 6, 'chromeStart = 2 dynamic + 4 padding')
  assert.equal(r.lines.length, 9, '6 dynamic rows + 3 chrome')
  assert.deepEqual(r.lines.slice(0, 2).map(l => l.text), ['spinner', 'thinking'], '动态内容贴上')
  assert.ok(r.lines.slice(2, 6).every(l => l.text === ''), '空行垫在内容与 chrome 之间')
  assert.deepEqual(r.lines.slice(6).map(l => l.text), ['input-top', 'input', 'input-bot'], 'chrome 不动')
})

test('超出预算：从顶部截最旧行，动态段尾部（approval）保留', () => {
  const dynamic = L('old-1', 'old-2', 'old-3', 'old-4', 'approval-prompt')
  const chrome = L('input')
  const r = padDynamicRegion([...dynamic, ...chrome], 5, 3)
  assert.equal(r.chromeStart, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['old-3', 'old-4', 'approval-prompt', 'input'])
})

test('恰好等于预算：原样保留，无垫行无截断', () => {
  const lines = [...L('a', 'b', 'c'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', 'c', 'input'])
  assert.equal(r.chromeStart, 3)
})

test('budget<=0：纯函数保持原始输入', () => {
  const lines = [...L('a'), ...L('input')]
  const r = padDynamicRegion(lines, 1, 0)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'input'])
  assert.equal(r.chromeStart, 1)
})

test('动态段为空：全部垫空行到 budget', () => {
  const r = padDynamicRegion(L('input'), 0, 4)
  assert.equal(r.chromeStart, 4)
  assert.ok(r.lines.slice(0, 4).every(l => l.text === ''))
  assert.equal(r.lines[4]!.text, 'input')
})

test('多 display-row 行按 measure 计数；整行丢弃低于预算后垫空行补齐到恰好 budget', () => {
  // wide 行占 3 display rows。budget=4：丢弃 wide(3) 后剩 a+b=2 rows < 4 → 垫 2 空行。
  const measure = (text: string): number => (text === 'wide' ? 3 : 1)
  const lines = [...L('wide', 'a', 'b'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 4, measure)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', '', '', 'input'])
  assert.equal(r.chromeStart, 4)
  const total = r.lines.slice(0, r.chromeStart).reduce((s, l) => s + measure(l.text), 0)
  assert.equal(total, 4, '动态段恒等于 budget display rows')
})

// ── liveMaxRowsFor ──────────────────────────────────────────────

test('liveMaxRowsFor：高终端封顶 28，小终端 rows-1，下限 4，非法值回退', () => {
  assert.equal(liveMaxRowsFor(50), 28)
  assert.equal(liveMaxRowsFor(29), 28)
  assert.equal(liveMaxRowsFor(20), 19)
  assert.equal(liveMaxRowsFor(10), 9)
  assert.equal(liveMaxRowsFor(4), 4)
  assert.equal(liveMaxRowsFor(2), 4, '下限 4：宁可超行不裁输入框')
  assert.equal(liveMaxRowsFor(0), 23, 'rows 缺失回退 24-1')
})

// ── TuiApp 集成：帧高度稳定性 ───────────────────────────────────

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const liveRows = (app: unknown): number => (app as { live: { lastDisplayRows: number } }).live.lastDisplayRows

function observeFrames(app: unknown): () => readonly LiveRegionLine[] {
  const live = (app as { live: { render: (lines: readonly LiveRegionLine[], opts?: { reservedTail?: number }) => void } }).live
  const render = live.render.bind(live)
  let frame: readonly LiveRegionLine[] = []
  live.render = (lines, opts) => { frame = lines; render(lines, opts) }
  return () => frame
}

function anchored(frame: readonly LiveRegionLine[], rows: number): { caret: number; bottom: number } {
  assert.equal(frame.length, rows, '视口必须按当前终端高度完整绘制')
  const caret = frame.findIndex(line => line.caretCol !== undefined)
  const bottom = frame.map(line => line.region).lastIndexOf('composer')
  assert.ok(caret >= rows - 4 && caret <= bottom, '可编辑光标必须留在底部输入框')
  assert.ok(bottom >= rows - 2, '输入框之后只允许普通键位 footer')
  return { caret, bottom }
}

test('thinking 逐字增长期间满窗口视口与底部输入框保持不变', async t => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setInput('保留草稿')
  const position = anchored(frame(), 40)
  const heights: number[] = []
  for (let i = 0; i < 12; i++) {
    app.callbacks.onThinkingDelta(`推理片段 ${i}：分析代码结构与依赖关系。\n`)
    await flush()
    heights.push(liveRows(app))
    assert.deepEqual(anchored(frame(), 40), position)
  }
  assert.ok(heights.every(height => height === 40), `heights=${heights}`)
})

test('streaming 文本增长期间同样保持满视口和底部光标', async t => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setInput('保留草稿')
  const position = anchored(frame(), 40)
  const heights: number[] = []
  for (let i = 0; i < 10; i++) {
    app.callbacks.onTextDelta(`streaming output chunk ${i} with some longer content to fill the tail. `)
    await flush()
    heights.push(liveRows(app))
    assert.deepEqual(anchored(frame(), 40), position)
  }
  assert.ok(heights.every(height => height === 40), `heights=${heights.join(',')}`)
})

test('turn 结束后清理实时活动内容，满视口和输入框位置不塌缩', async t => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setInput('保留草稿')
  app.callbacks.onThinkingDelta('思考中……\n')
  await flush()
  const active = liveRows(app)
  const position = anchored(frame(), 40)

  await (app as unknown as { handleTurnComplete: (u: object, t: number, f: boolean) => Promise<void> })
    .handleTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await flush()
  const idle = liveRows(app)

  assert.equal(idle, active, '轮末不能把输入框从窗口底部抬起')
  assert.deepEqual(anchored(frame(), 40), position)
  assert.ok(!frame().some(line => line.livePart === 'status' || line.livePart === 'tail'), '已结束的实时状态必须退场')
  assert.equal(app.getInputValue(), '保留草稿')
})

test('连续多轮活动与空闲都保持完整高度，底部输入框不漂移', async t => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setInput('保留草稿')
  const position = anchored(frame(), 40)
  const priv = app as unknown as {
    setPhase: (p: string) => void
    renderLive: () => void
    agentBusy: boolean
    handleTurnComplete: (u: object, t: number, f: boolean) => Promise<void>
  }
  const heights: number[] = []

  for (let turn = 1; turn <= 3; turn++) {
    // 轮开局：用户提交 → 进入活动期
    priv.agentBusy = true
    priv.setPhase('thinking')
    priv.renderLive()
    await flush()
    heights.push(liveRows(app))
    assert.deepEqual(anchored(frame(), 40), position)

    for (let i = 0; i < 5; i++) {
      app.callbacks.onThinkingDelta(`推理片段 ${i}\n`)
      await flush()
    }
    app.callbacks.onTextDelta('简短回复。')
    await flush()
    heights.push(liveRows(app))
    assert.deepEqual(anchored(frame(), 40), position)

    await priv.handleTurnComplete({ input_tokens: 10, output_tokens: 5 }, turn, true)
    await flush()
    heights.push(liveRows(app))
    assert.deepEqual(anchored(frame(), 40), position)
  }

  const idle = heights.filter((_, i) => i % 3 === 2)
  assert.ok(idle.every(height => height === idle[0]), `idle=${idle}`)
  assert.ok(heights.every(height => height === 40), `heights=${heights}`)
})

test('首帧占满窗口，但不单独写出成片空行污染原生历史', async t => {
  const { app, out } = makeApp({ cols: 80, rows: 40 })
  t.after(() => app.dispose())
  await flush()
  assert.equal(liveRows(app), 40)
  assert.equal(out.chunks.find(c => /^\n{2,}$/.test(c)), undefined,
    `首帧不应出现成片空行: ${JSON.stringify(out.chunks.slice(0, 4))}`)
})

test('小终端（rows=10）仍填满窗口，live region 不超屏', async t => {
  const { app } = makeApp({ cols: 80, rows: 10 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  for (let i = 0; i < 8; i++) {
    app.callbacks.onThinkingDelta(`小屏思考片段 ${i}\n`)
    await flush()
    assert.equal(liveRows(app), 10, '小屏视口必须恰好等于终端高度')
    anchored(frame(), 10)
  }
})

test('30 行窗口：活动内容增长与回落都不改变底部输入框的位置', async t => {
  const { app } = makeApp({ cols: 80, rows: 30 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setInput('峰值期间保留草稿')
  const position = anchored(frame(), 30)
  app.callbacks.onThinkingDelta('较长的思考内容\n'.repeat(20))
  await flush()
  assert.deepEqual(anchored(frame(), 30), position)
  assert.ok(frame().some(line => line.livePart === 'status'))
  await (app as unknown as { handleTurnComplete: (u: object, t: number, f: boolean) => Promise<void> })
    .handleTurnComplete({}, 1, true)
  await flush()
  assert.deepEqual(anchored(frame(), 30), position)
  assert.equal(app.getInputValue(), '峰值期间保留草稿')
})

test('32 行窗口同样保持完整视口与可编辑的底部草稿', async t => {
  const { app } = makeApp({ cols: 80, rows: 32 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setInput('桌面草稿')
  app.callbacks.onTextDelta('正文增长。'.repeat(200))
  await flush()
  anchored(frame(), 32)
  assert.equal(liveRows(app), 32)
  assert.equal(app.getInputValue(), '桌面草稿')
})

test('满窗口预算保留审批状态行：rows=30 审批挂起时「等待审批」仍可见', async t => {
  const { app, out } = makeApp({ cols: 80, rows: 30 })
  t.after(() => app.dispose())
  void app.callbacks.onApprovalRequired!('1', 'read_file', { file_path: '/tmp/x' })
  await flush()
  const frame = stripAnsi(out.chunks.join(''))
  assert.ok(frame.includes('等待审批 read_file'), '满窗口预算下审批状态行不得被截掉')
  assert.equal(liveRows(app), 30)
})

test('欢迎页 slash 开合只移除菜单内容，输入框持续贴底', async t => {
  const { app } = makeApp({ cols: 80, rows: 24 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setSlashCommands(
    Array.from({ length: 8 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `desc ${i}`,
      tier: 'core' as const,
    })),
  )
  app.forceRedraw()
  await flush()
  const idle = liveRows(app)
  assert.equal(idle, 24)
  const position = anchored(frame(), 24)

  app.setInput('/')
  await flush()
  const open = liveRows(app)
  assert.equal(open, idle, 'slash 打开不能移动底部输入框')
  assert.deepEqual(anchored(frame(), 24), position)
  assert.ok(frame().some(line => stripAnsi(line.text).includes('/cmd0')), '菜单项确实显示')

  app.setInput('')
  await flush()
  const closed = liveRows(app)
  assert.equal(closed, open, '关闭菜单后仍保持满视口')
  assert.deepEqual(anchored(frame(), 24), position)
  assert.ok(!frame().some(line => stripAnsi(line.text).includes('/cmd0')), '取消后菜单项不得残留')
})

test('活动期 slash 开合保持满视口，关闭后菜单内容不残留', async t => {
  const { app } = makeApp({ cols: 80, rows: 24 })
  t.after(() => app.dispose())
  const frame = observeFrames(app)
  app.setSlashCommands(
    Array.from({ length: 8 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `desc ${i}`,
      tier: 'core' as const,
    })),
  )
  app.callbacks.onThinkingDelta('思考中\n')
  await flush()
  const before = liveRows(app)
  const position = anchored(frame(), 24)

  app.setInput('/')
  await flush()
  const open = liveRows(app)
  assert.equal(open, before)
  assert.deepEqual(anchored(frame(), 24), position)
  assert.ok(frame().some(line => stripAnsi(line.text).includes('/cmd0')))

  app.setInput('')
  await flush()
  const closed = liveRows(app)
  assert.equal(closed, 24)
  assert.deepEqual(anchored(frame(), 24), position)
  assert.ok(!frame().some(line => stripAnsi(line.text).includes('/cmd0')))
})
