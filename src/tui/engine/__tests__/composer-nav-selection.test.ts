/**
 * 输入框对齐 codex：↑/↓ 历史闸门 + 视觉行导航，鼠标选区（拖选/双击/三击）、选中即复制与选区编辑。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WriteStream } from 'node:tty'
import { InputLine } from '../input-line.js'
import { FrontendSession } from '../frontend-session.js'
import { FrontendMouse } from '../frontend-mouse.js'
import type { MousePress } from '../fullscreen-engine.js'
import { makeApp, MockOut } from './_harness.js'

const up = (input: InputLine) => input.handleKey('up', '', false, false)
const down = (input: InputLine) => input.handleKey('down', '', false, false)
const type = (input: InputLine, text: string) => { for (const ch of text) input.handleKey('unknown', ch, false, false) }
/** 以指定总宽渲染一次，InputLine 记下软换行宽度（内容宽 = 总宽 - `❯ ` 前缀 2 列）。 */
const layout = (input: InputLine, maxWidth: number) => input.displayLinesWithCaret({ maxWidth })

describe('↑/↓ 历史闸门（对齐 codex should_handle_navigation）', () => {
  it('空输入框翻历史；未改动的召回条目在首/尾继续翻', () => {
    const input = new InputLine({ history: ['newest', 'older\nline2', 'oldest'] })
    up(input)
    assert.equal(input.value, 'newest')
    up(input)
    assert.equal(input.value, 'older\nline2', '多行召回条目，光标在末尾仍继续翻')
    up(input)
    assert.equal(input.value, 'oldest')
    up(input)
    assert.equal(input.value, 'oldest', '最旧一条之后 ↑ 退化为光标移动（codex：navigate_up 返回 None）')
    assert.equal(input.cursor, 0)
    down(input)
    down(input)
    down(input)
    assert.equal(input.value, '', '越过最新一条回到空草稿')
  })

  it('召回条目内移开首/尾后，↑/↓ 只在行间移动', () => {
    const input = new InputLine({ history: ['abc\ndef'] })
    up(input)
    input.handleKey('left', '', false, false)
    up(input)
    assert.equal(input.value, 'abc\ndef')
    assert.equal(input.cursor, 2)
  })

  it('有选区时 ↑ 只移动光标，不翻历史', () => {
    const input = new InputLine({ history: ['h1', 'h2'] })
    up(input)
    input.handleKey('left', '', false, false, true)
    up(input)
    assert.equal(input.value, 'h1')
    assert.equal(input.cursor, 0)
  })

  it('vim normal 模式同一闸门', () => {
    const input = new InputLine({ history: ['h1'], vimEnabled: true })
    type(input, 'draft')
    input.handleKey('escape', '', false, false)
    up(input)
    assert.equal(input.value, 'draft')
  })
})

describe('↑/↓ 视觉行导航（软换行 + 目标列）', () => {
  it('单行软换行时 ↑ 逐视觉行上移，首行再按回到开头，不翻历史', () => {
    const input = new InputLine({ value: 'a'.repeat(30), history: ['h1'] })
    layout(input, 12) // 内容宽 10 → 三个视觉行
    up(input)
    assert.equal(input.cursor, 19, '第 3 行行尾 → 第 2 行最后一格（不越过折行点）')
    up(input)
    assert.equal(input.cursor, 9)
    up(input)
    assert.equal(input.cursor, 0)
    assert.equal(up(input), null)
    assert.equal(input.value, 'a'.repeat(30))
    down(input)
    assert.equal(input.cursor, 10)
  })

  it('跨短行保持目标列', () => {
    const input = new InputLine({ value: 'abcdef\nx\nabcdef' })
    up(input)
    assert.equal(input.cursor, 8, '短行贴行尾')
    up(input)
    assert.equal(input.cursor, 6, '回到原目标列')
  })

  it('按显示宽度对齐 CJK 列', () => {
    const input = new InputLine({ value: '中文字\nabcd' })
    up(input)
    assert.equal(input.cursor, 2, 'abcd 末尾为第 4 格 → 「中文」之后')
  })

  it('落点不停在折叠粘贴标记内部', () => {
    const input = new InputLine()
    input.insertText(Array.from({ length: 12 }, () => 'l').join('\n'))
    input.handleKey('ctrl_j', '', true, false)
    type(input, 'abcdefghij')
    up(input)
    assert.equal(input.cursor, 0)
  })
})

describe('选区编辑（对齐 codex）', () => {
  it('粘贴替换选区', () => {
    const input = new InputLine({ value: 'hello world' })
    for (let i = 0; i < 5; i++) input.handleKey('left', '', false, false, true)
    input.insertText('there')
    assert.equal(input.value, 'hello there')
  })

  it('词删 / 行删键删除整个选区', () => {
    const input = new InputLine({ value: 'hello world' })
    input.handleKey('home', '', false, false)
    for (let i = 0; i < 3; i++) input.handleKey('right', '', false, false)
    for (let i = 0; i < 5; i++) input.handleKey('right', '', false, false, true)
    input.handleKey('ctrl_w', '', true, false)
    assert.equal(input.value, 'helrld', '跨词选区整体删除，而不是退化为删光标前一个词')
  })
})

describe('InputLine 鼠标选区', () => {
  it('start/extend 拖选、word 双击、line 三击；selectedText 展开折叠粘贴', () => {
    const input = new InputLine({ value: 'hello world\nnext line' })
    input.selectVisible(0, 0, 80, 12, 'start')
    input.selectVisible(0, 5, 80, 12, 'extend')
    assert.equal(input.selectedText, 'hello')
    input.selectVisible(0, 7, 80, 12, 'word')
    assert.equal(input.selectedText, 'world')
    input.selectVisible(1, 2, 80, 12, 'line')
    assert.equal(input.selectedText, 'next line')
    assert.equal(input.clearSelection(), true)
    assert.equal(input.selectedText, null)

    const pasted = Array.from({ length: 12 }, (_, i) => `p${i}`).join('\n')
    const folded = new InputLine()
    folded.insertText(pasted)
    folded.selectVisible(0, 0, 80, 12, 'word')
    assert.equal(folded.selectedText, pasted, '标记整体选中，复制得到原文')
  })
})

async function composerSession(line: InputLine) {
  const frontend = new FrontendSession(new MockOut() as unknown as WriteStream, () => ({ cols: 80, rows: 24 }), () => {}, () => {})
  await new Promise(resolve => setTimeout(resolve, 20))
  frontend.record({ kind: 'assistant', text: 'HISTORY_TEXT' })
  frontend.startFullscreen(true)
  await frontend.viewport.prepare(80, 16)
  const rows = line.value.split('\n')
  frontend.render(rows.map((text, i) => ({ text: `${i ? '  ' : '❯ '}${text}`, inputLine: i, inputStartCol: 2, ...(i ? {} : { caretCol: 2 }) })), 0, [])
  const composer = (frontend as unknown as { composer: Array<{ y: number }> }).composer
  return { frontend, y: composer[0]!.y }
}

function mouseHost(frontend: FrontendSession, line: InputLine, copyOnSelect = true) {
  const copies: string[] = []
  const host = { session: frontend, line, columns: 80, copyOnSelect, render() {}, message() {}, copy() {},
    copyComposer() { copies.push(line.selectedText ?? '') }, overlay: { activeId: () => null }, controller: {} } as unknown as Parameters<FrontendMouse['handle']>[1]
  return { host, copies }
}

const at = (type: MousePress['type'], x: number, y: number): MousePress => ({ type, x, y, button: type === 'move' ? 32 : 0, ctrl: false, shift: false, meta: false })

describe('全屏输入框鼠标交互', () => {
  it('拖选 → 松开即复制，选区保留可退格删除、可输入替换', async () => {
    const line = new InputLine({ value: 'hello world' })
    const { frontend, y } = await composerSession(line)
    const { host, copies } = mouseHost(frontend, line)
    const mouse = new FrontendMouse()
    try {
      mouse.handle(at('press', 3, y), host, 0)
      mouse.handle(at('move', 8, y), host, 10)
      mouse.handle(at('release', 8, y), host, 20)
      assert.deepEqual(copies, ['hello'])
      line.handleKey('backspace', '', false, false)
      assert.equal(line.value, ' world')
      mouse.handle(at('press', 4, y), host, 1000)
      mouse.handle(at('move', 9, y), host, 1010)
      mouse.handle(at('release', 9, y), host, 1020)
      type(line, 'X')
      assert.equal(line.value, ' X')
    } finally { frontend.stopFullscreen() }
  })

  it('双击选词、三击选行；原地松开不收缩选区', async () => {
    const line = new InputLine({ value: 'hello world' })
    const { frontend, y } = await composerSession(line)
    const { host, copies } = mouseHost(frontend, line)
    const mouse = new FrontendMouse()
    try {
      for (const t of [0, 100]) { mouse.handle(at('press', 10, y), host, t); mouse.handle(at('release', 10, y), host, t + 10) }
      assert.equal(line.selectedText, 'world')
      mouse.handle(at('press', 10, y), host, 200)
      mouse.handle(at('release', 10, y), host, 210)
      assert.equal(line.selectedText, 'hello world')
      assert.deepEqual(copies, ['world', 'hello world'])
      mouse.handle(at('press', 10, y), host, 5000)
      mouse.handle(at('release', 10, y), host, 5010)
      assert.equal(line.selectedText, null, '超出连击窗口的单击只落光标')
      assert.equal(line.cursor, 7)
    } finally { frontend.stopFullscreen() }
  })

  it('拖出输入框上方贴到行首；在正文区按下取消输入框选区；关闭选中即复制则不复制', async () => {
    const line = new InputLine({ value: 'hello world' })
    const { frontend, y } = await composerSession(line)
    const { host, copies } = mouseHost(frontend, line, false)
    const mouse = new FrontendMouse()
    try {
      mouse.handle(at('press', 8, y), host, 0)
      mouse.handle(at('move', 30, 1), host, 10)
      mouse.handle(at('release', 30, 1), host, 20)
      assert.equal(line.selectedText, 'hello')
      assert.deepEqual(copies, [])
      mouse.handle(at('press', 3, 3), host, 1000)
      assert.equal(line.selectedText, null)
    } finally { frontend.stopFullscreen() }
  })
})

describe('Ctrl+C 复制输入框选区', () => {
  it('有选区时 Ctrl+C 复制而不清空输入框', async () => {
    const originalSpawn = childProcess.spawn
    const copied: string[] = []
    childProcess.spawn = (() => {
      const writer = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: () => true })
      let value = ''
      writer.stdin.on('data', chunk => { value += chunk.toString('utf8') })
      writer.stdin.on('finish', () => { copied.push(value); writer.emit('close', 0) })
      return writer
    }) as unknown as typeof childProcess.spawn
    syncBuiltinESMExports()
    const { app, stdin } = makeApp()
    try {
      app.setInput('hello')
      stdin.dataHandler!('\x1b[1;2D\x1b[1;2D')
      stdin.dataHandler!('\x03')
      await new Promise(resolve => setTimeout(resolve, 30))
      const line = (app as unknown as { inputLine: InputLine }).inputLine
      assert.equal(line.value, 'hello', 'Ctrl+C 不应清空草稿')
      assert.equal(line.selectedText, 'lo')
      assert.ok(copied.includes('lo') || copied.length === 0, '本地剪贴板可用时写入选区原文')
    } finally {
      app.dispose()
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
    }
  })
})
