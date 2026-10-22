import test from 'node:test'
import assert from 'node:assert/strict'
import { UIHistory } from '../../ui-history.js'
import { ConversationViewport, viewportPlainText } from '../conversation-viewport.js'
import { FrontendSession } from '../frontend-session.js'
import { FrontendMouse } from '../frontend-mouse.js'
import { InputLine } from '../input-line.js'
import type { KeyName, KeyPress } from '../input-handler.js'
import type { WriteStream } from 'node:tty'
import { makeApp, MockOut } from './_harness.js'
import { displayWidth } from '../../width.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const key = (name: KeyName, char = '', ctrl = false): KeyPress => ({ name, char, ctrl, raw: char, meta: false, shift: false })
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20))
const plain = (rows: string[]) => rows.map(viewportPlainText).join('\n')
const wheel = { type: 'wheel' as const, x: 1, y: 4, button: 0, ctrl: false, shift: false, meta: false }

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform}：鼠标选中正文后重复 Ctrl+C 复制，不退出或停止会话`, async () => {
    const originalSpawn = childProcess.spawn
    const originalPlatform = process.platform
    const writers: Array<EventEmitter & { stdin: PassThrough }> = []
    const copied: string[] = []
    const commands: string[] = []
    childProcess.spawn = ((command: string) => {
      commands.push(command)
      const writer = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: () => true })
      let value = ''
      writer.stdin.on('data', chunk => { value += chunk.toString('utf8') })
      writer.stdin.on('finish', () => { copied.push(value); writer.emit('close', 0) })
      writers.push(writer)
      return writer
    }) as unknown as typeof childProcess.spawn
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', { value: platform })
    const copyEnv = ['DISPLAY', 'WAYLAND_DISPLAY', 'TERMUX_VERSION', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']
    const savedEnv = new Map(copyEnv.map(name => [name, process.env[name]]))
    for (const name of copyEnv) delete process.env[name]
    process.env.DISPLAY = ':frontend-test'
    const { app, stdin } = makeApp({ renderer: 'fullscreen' })
    let exited = false
    app.onExit(() => { exited = true })
    const frontend = (app as unknown as { frontend: FrontendSession }).frontend
    try {
      await tick()
      frontend.record({ kind: 'assistant', text: 'COPYABLE_会话正文' })
      await frontend.viewport.prepare(80, 16)
      frontend.startFullscreen(true)
      frontend.render([{ text: '> ', inputLine: 0, inputStartCol: 2, caretCol: 2 }], 0, [])
      const state = frontend as unknown as { visible: Array<{ text: string }>; historyTop: number }
      const index = state.visible.findIndex(cell => viewportPlainText(cell.text).includes('COPYABLE_'))
      assert.ok(index >= 0)
      const y = state.historyTop + index + 1
      stdin.dataHandler!(`\x1b[<0;3;${y}M\x1b[<32;23;${y}M\x1b[<0;23;${y}m`)
      assert.match(frontend.copySelection() ?? '', /COPYABLE_会话正文/)
      stdin.dataHandler!('\x03')
      await tick()
      stdin.dataHandler!('\x03')
      await tick()
      // 选中即复制默认开：松开时复制 1 次，随后两次 Ctrl+C 各复制 1 次。
      assert.equal(copied.length, 3, '松开与两次 Ctrl+C 都应送到剪贴板')
      assert.ok(copied.every(text => /COPYABLE_会话正文/.test(text)))
      assert.equal(exited, false, '重复复制不能当成双 Ctrl+C 退出')
      assert.equal(commands[0], platform === 'darwin' ? 'pbcopy' : platform === 'win32' ? 'powershell.exe' : 'xclip')
    } finally {
      app.dispose()
      for (const writer of writers) writer.emit('close', 0)
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
}

test('选区显示复制按钮，点击仅复制选区，不打开历史详情', async () => {
  const frontend = await session()
  const mouse = new FrontendMouse()
  try {
    frontend.render([{ text: '> ', inputLine: 0, inputStartCol: 2, caretCol: 2 }], 0, [])
    frontend.handleMouse({ ...wheel, type: 'press', x: 1, y: 1 })
    frontend.handleMouse({ ...wheel, type: 'move', x: 8, y: 1 })
    frontend.handleMouse({ ...wheel, type: 'release', x: 8, y: 1 })
    frontend.render([{ text: '> ', inputLine: 0, inputStartCol: 2, caretCol: 2 }], 0, [])
    let copied: string | null = null, copies = 0
    const host = { session: frontend, line: new InputLine({}), columns: 80, copyOnSelect: true, render() {}, message() {},
      copy() { copied = frontend.copySelection(); copies++ }, overlay: { activeId: () => null }, controller: {} } as unknown as Parameters<FrontendMouse['handle']>[1]
    mouse.handle({ ...wheel, type: 'press', x: 2, y: 23 }, host)
    mouse.handle({ ...wheel, type: 'release', x: 2, y: 23 }, host)
    assert.ok(copied)
    mouse.handle({ ...wheel, type: 'press', x: 2, y: 23 }, host)
    mouse.handle({ ...wheel, type: 'move', x: 20, y: 23 }, host)
    mouse.handle({ ...wheel, type: 'move', x: 2, y: 23 }, host)
    mouse.handle({ ...wheel, type: 'release', x: 2, y: 23 }, host)
    assert.equal(copies, 1, '拖出再返回不能触发复制')
    await frontend.viewport.settled()
    assert.equal(frontend.viewport.detailBytes, 0)
  } finally { frontend.stopFullscreen() }
})

test('有草稿且任务运行时，Esc 只取消选区，不停止任务', async () => {
  const { app, stdin } = makeApp({ renderer: 'fullscreen' })
  const frontend = (app as unknown as { frontend: FrontendSession }).frontend
  let aborted = 0
  app.onAbort(() => { aborted++ })
  try {
    await tick()
    frontend.record({ kind: 'assistant', text: 'SELECTABLE_TEXT' })
    await frontend.viewport.prepare(80, 16)
    frontend.startFullscreen(true)
    app.setInput('PRESERVE_DRAFT')
    ;(app as unknown as { agentBusy: boolean }).agentBusy = true
    frontend.render([{ text: '> PRESERVE_DRAFT', inputLine: 0, caretCol: 16 }], 0, [])
    frontend.handleMouse({ ...wheel, type: 'press', x: 3, y: 1 })
    frontend.handleMouse({ ...wheel, type: 'move', x: 15, y: 1 })
    frontend.handleMouse({ ...wheel, type: 'release', x: 15, y: 1 })
    assert.ok(frontend.copySelection())
    stdin.dataHandler!('\x1b')
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(aborted, 0)
    assert.equal(frontend.copySelection(), null)
    assert.equal(app.getInputValue(), 'PRESERVE_DRAFT')
  } finally { app.dispose() }
})

test('连续损坏历史只显示一条摘要，真实错误与审批仍保持可见', async () => {
  const directory = mkdtempSync(join(process.env.RIVET_HOME ?? tmpdir(), 'unavailable-history-'))
  try {
    const path = join(directory, 'ui-history.jsonl')
    writeFileSync(path, 'broken row\n'.repeat(5) + [
      { id: 6, kind: 'error', text: 'REAL_ERROR', time: 1 },
      { id: 7, kind: 'approval', text: 'REAL_APPROVAL', time: 1 },
      { id: 8, kind: 'assistant', text: 'LATEST_ANSWER', time: 1 },
    ].map(record => JSON.stringify(record) + '\n').join(''))
    const history = await UIHistory.open(path)
    const viewport = new ConversationViewport(history, () => {})
    await viewport.prepare(80, 20)
    const collapsed = plain(viewport.render(80, 20))
    assert.match(collapsed, /历史记录损坏.*5.*展开/)
    assert.doesNotMatch(collapsed, /此历史记录损坏/)
    assert.match(collapsed, /REAL_ERROR/)
    assert.match(collapsed, /REAL_APPROVAL/)
    assert.match(collapsed, /LATEST_ANSWER/)
    viewport.selectRecord(0)
    await viewport.settled()
    viewport.handleKey(key('return'))
    await viewport.settled()
    assert.match(plain(viewport.render(80, 20)), /此历史记录损坏/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('未持久化的旧记录合并为不可用摘要，正常错误不折叠', async () => {
  const history = await UIHistory.open()
  for (let i = 0; i < 140; i++) history.append({ kind: 'assistant', text: `ANSWER_${i}` })
  const viewport = new ConversationViewport(history, () => {})
  await viewport.prepare(80, 20)
  viewport.handleKey(key('home', '', true))
  await viewport.settled()
  const text = plain(viewport.render(80, 20))
  assert.match(text, /历史记录不可用.*12.*展开/)
  assert.match(text, /ANSWER_12/)
  assert.doesNotMatch(text, /此历史记录不可用/)
})

test('恢复全损坏历史后，新回复、错误和审批不会与占位记录碰撞', async () => {
  const directory = mkdtempSync(join(process.env.RIVET_HOME ?? tmpdir(), 'corrupt-append-'))
  try {
    const path = join(directory, 'ui-history.jsonl')
    writeFileSync(path, 'broken row\n'.repeat(5))
    const history = await UIHistory.open(path)
    const answer = history.append({ kind: 'assistant', text: 'NEW_LATEST_REPLY' })
    const error = history.append({ kind: 'error', text: 'NEW_ERROR' })
    const approval = history.append({ kind: 'approval', text: 'NEW_APPROVAL' })
    assert.ok(answer.id > 5)
    const records = await history.page(0, 8)
    assert.equal(new Set(records.map(record => record.id)).size, records.length)
    assert.ok(error.id > answer.id && approval.id > error.id)
    const viewport = new ConversationViewport(history, () => {})
    await viewport.prepare(80, 20)
    const text = plain(viewport.render(80, 20))
    assert.match(text, /历史记录损坏.*5.*展开/)
    assert.match(text, /NEW_LATEST_REPLY/)
    assert.match(text, /NEW_ERROR/)
    assert.match(text, /NEW_APPROVAL/)
    const reopened = await UIHistory.open(path)
    assert.match((await reopened.page(5, 3)).map(record => record.text).join('\n'), /NEW_LATEST_REPLY.*\nNEW_ERROR.*\nNEW_APPROVAL/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('旧损坏文件已经复用编号时，原有正文与审批仍可读取', async () => {
  const directory = mkdtempSync(join(process.env.RIVET_HOME ?? tmpdir(), 'legacy-corrupt-'))
  try {
    const path = join(directory, 'ui-history.jsonl')
    writeFileSync(path, 'broken row\n'.repeat(3) + [
      { id: 1, kind: 'assistant', text: 'EXISTING_REPLY', time: 1 },
      { id: 2, kind: 'error', text: 'EXISTING_ERROR', time: 1 },
      { id: 3, kind: 'approval', text: 'EXISTING_APPROVAL', time: 1 },
    ].map(record => JSON.stringify(record) + '\n').join(''))
    const history = await UIHistory.open(path)
    const records = await history.page(0, 6)
    assert.equal(new Set(records.map(record => record.id)).size, 6)
    const viewport = new ConversationViewport(history, () => {})
    await viewport.prepare(80, 20)
    const text = plain(viewport.render(80, 20))
    assert.match(text, /EXISTING_REPLY/)
    assert.match(text, /EXISTING_ERROR/)
    assert.match(text, /EXISTING_APPROVAL/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

async function session() {
  const out = new MockOut()
  const frontend = new FrontendSession(out as unknown as WriteStream, () => ({ cols: 80, rows: 24 }), () => {}, () => {})
  await tick()
  frontend.record({ kind: 'thinking', text: 'OLD_THOUGHT' })
  frontend.startFullscreen(true)
  await frontend.viewport.prepare(80, 16)
  return frontend
}

test('回复完成后滚动历史再输入，Enter 发送完整的新消息', async () => {
  const { app, stdin } = makeApp({ renderer: 'fullscreen' })
  const sent: string[] = []
  app.onSubmit(text => sent.push(text))
  const frontend = (app as unknown as { frontend: FrontendSession }).frontend
  try {
    stdin.dataHandler!('第一条\r')
    await tick()
    app.callbacks.onThinkingDelta('OLD_THOUGHT')
    app.callbacks.onTextDelta('第一条回答')
    app.callbacks.onTurnComplete({}, 1, true)
    await tick()
    frontend.startFullscreen(true)
    frontend.handleMouse(wheel)
    await frontend.viewport.settled()
    stdin.dataHandler!('继续检查 j/k 和路径 /src\r')
    await tick()
    assert.deepEqual(sent, ['第一条', '继续检查 j/k 和路径 /src'])
    assert.equal(frontend.isReading, false)
    assert.equal(app.activeOverlayId(), null)
  } finally { app.dispose() }
})

test('括号粘贴后的新消息不能被历史详情 Enter 截获', async () => {
  const { app, stdin } = makeApp({ renderer: 'fullscreen' })
  const sent: string[] = []
  const frontend = (app as unknown as { frontend: FrontendSession }).frontend
  app.onSubmit(text => sent.push(text))
  try {
    await tick()
    frontend.record({ kind: 'thinking', text: 'OLD_THOUGHT' })
    await frontend.viewport.prepare(80, 16)
    frontend.startFullscreen(true)
    frontend.handleMouse(wheel)
    stdin.dataHandler!('\x1b[200~第二条粘贴消息\x1b[201~')
    await tick()
    stdin.dataHandler!('\r')
    await tick()
    assert.deepEqual(sent, ['第二条粘贴消息'])
    assert.equal(frontend.isReading, false)
  } finally { app.dispose() }
})

test('只有图片的草稿也优先发送，不打开旧思考', async () => {
  const { app, stdin } = makeApp({ renderer: 'fullscreen' })
  const internals = app as unknown as { frontend: FrontendSession; inputLine: InputLine }
  const sent: Array<{ text: string; images?: string[] }> = []
  app.onSubmit((text, images) => sent.push({ text, images }))
  try {
    await tick()
    internals.frontend.record({ kind: 'thinking', text: 'OLD_THOUGHT' })
    await internals.frontend.viewport.prepare(80, 16)
    internals.frontend.startFullscreen(true)
    internals.inputLine.addImage('data:image/png;base64,aGVsbG8=')
    internals.frontend.handleMouse(wheel)
    stdin.dataHandler!('\r')
    await tick()
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.images?.length, 1)
  } finally { app.dispose() }
})

test('点击输入框恢复输入焦点并收起历史详情', async () => {
  const frontend = await session()
  const line = new InputLine({})
  const mouse = new FrontendMouse()
  try {
    frontend.handleMouse(wheel)
    frontend.handleHistoryKey(key('return'))
    await frontend.viewport.settled()
    frontend.render([{ text: '> ', inputLine: 0, inputStartCol: 2, caretCol: 2 }], 0, '天枢')
    const host = { session: frontend, line, columns: 80, copyOnSelect: false, render() {}, copy() {}, message() {},
      overlay: { activeId: () => null }, controller: {} } as unknown as Parameters<FrontendMouse['handle']>[1]
    mouse.handle({ ...wheel, type: 'press', x: 3, y: 24, button: 0 }, host)
    mouse.handle({ ...wheel, type: 'release', x: 3, y: 24, button: 0 }, host)
    await frontend.viewport.settled()
    assert.equal(frontend.isReading, false)
    assert.equal(frontend.viewport.detailBytes, 0)
  } finally { frontend.stopFullscreen() }
})

test('返回输入后，排队中的 Enter 不得迟到展开思考', async () => {
  const frontend = await session()
  try {
    frontend.handleMouse(wheel)
    frontend.handleHistoryKey(key('return'))
    frontend.closeHistory()
    await frontend.viewport.settled()
    assert.equal(frontend.viewport.follow, true)
    assert.equal(frontend.viewport.detailBytes, 0)
    assert.doesNotMatch(plain(frontend.viewport.render(80, 16)), /OLD_THOUGHT/)
  } finally { frontend.stopFullscreen() }
})

test('连续成功工具与思考折叠成一行，展开后保留每项详情', async () => {
  const history = await UIHistory.open()
  history.append({ kind: 'user', text: '检查项目' })
  history.append({ kind: 'thinking', text: 'PRIVATE_PROCESS' })
  history.append({ kind: 'tool', name: 'read_file', text: 'READ_RESULT', input: { path: '/project/src/a.ts' } })
  history.append({ kind: 'tool', name: 'glob', text: 'FIND_RESULT', input: { pattern: '**/*.ts' } })
  history.append({ kind: 'assistant', text: 'FINAL_ANSWER' })
  const viewport = new ConversationViewport(history, () => {})
  await viewport.prepare(80, 20)
  const collapsed = plain(viewport.render(80, 20))
  assert.match(collapsed, /执行过程.*2.*1.*展开/)
  assert.doesNotMatch(collapsed, /PRIVATE_PROCESS|READ_RESULT|FIND_RESULT|Enter 查看/)
  assert.match(collapsed, /FINAL_ANSWER/)
  viewport.selectRecord(1)
  await viewport.settled()
  viewport.handleKey(key('return'))
  await viewport.settled()
  assert.match(plain(viewport.render(80, 20)), /收起|Read|Find/)
  viewport.selectRecord(2)
  await viewport.settled()
  viewport.handleKey(key('return'))
  await viewport.settled()
  assert.match(plain(viewport.render(80, 20)), /READ_RESULT/)
})

test('搜索折叠过程可找到并显示真实匹配，不吞审批和错误', async () => {
  const history = await UIHistory.open()
  history.append({ kind: 'thinking', text: '思考' })
  history.append({ kind: 'tool', name: 'read_file', text: 'SEARCH_MATCH' })
  history.append({ kind: 'tool', name: 'bash', text: 'VISIBLE_ERROR', isError: true })
  history.append({ kind: 'approval', text: 'VISIBLE_APPROVAL' })
  const viewport = new ConversationViewport(history, () => {})
  await viewport.prepare(80, 20)
  const collapsed = plain(viewport.render(80, 20))
  assert.match(collapsed, /VISIBLE_ERROR/)
  assert.match(collapsed, /VISIBLE_APPROVAL/)
  viewport.handleKey(key('unknown', '/'))
  for (const char of 'SEARCH_MATCH') viewport.handleKey(key('unknown', char))
  viewport.handleKey(key('return'))
  await viewport.settled()
  assert.equal(viewport.searchState.matches, 1)
  assert.match(plain(viewport.render(80, 20)), /SEARCH_MATCH/)
})

test('长工具路径与提示保留展开入口，窄宽屏都不挤占正文', async () => {
  const history = await UIHistory.open()
  history.append({ kind: 'tool', name: 'read_file', text: 'FULL_RESULT', input: { file_paths: '/long/'.repeat(40) } })
  history.append({ kind: 'notice', text: '历史记录缺失或读取不完整，已暂停保存；重启后新增记录可能缺失。'.repeat(4) })
  history.append({ kind: 'assistant', text: 'ANSWER' })
  const viewport = new ConversationViewport(history, () => {})
  for (const width of [40, 80, 133]) {
    await viewport.prepare(width, 40)
    const rows = viewport.render(width, 40).map(viewportPlainText)
    assert.ok(rows.length <= 7, `${width} 列不应展开整条长路径与提示`)
    assert.match(rows.join('\n'), /展开/)
    assert.ok(rows.every(row => displayWidth(row) <= width))
    assert.match(rows.join('\n'), /ANSWER/)
  }
})

test('空草稿可用 Enter 展开；输入 j、k、/ 时立即返回输入框', async () => {
  const frontend = await session()
  try {
    frontend.handleMouse(wheel)
    assert.equal(frontend.handleKey(key('return')), true)
    await frontend.viewport.settled()
    assert.match(plain(frontend.viewport.render(80, 16)), /OLD_THOUGHT/)
    for (const char of ['j', 'k', '/']) {
      frontend.handleMouse(wheel)
      assert.equal(frontend.handleKey(key('unknown', char)), false)
      assert.equal(frontend.isReading, false)
      await frontend.viewport.settled()
      assert.equal(frontend.viewport.detailBytes, 0)
    }
  } finally { frontend.stopFullscreen() }
})

test('独立历史面板保留搜索及 j/k 导航，不将查询文字送入草稿', async () => {
  const frontend = await session()
  try {
    await frontend.showHistory()
    assert.equal(frontend.handleHistoryKey(key('unknown', '/')), true)
    frontend.handleHistoryKey(key('unknown', 'OLD_THOUGHT'))
    frontend.handleHistoryKey(key('return'))
    await frontend.viewport.settled()
    assert.equal(frontend.viewport.searchState.matches, 1)
    assert.match(plain(frontend.renderHistory(80, 24)), /OLD_THOUGHT/)
  } finally { frontend.stopFullscreen() }
})

test('长执行过程跨页滚动和搜索均保留记录，内存不随会话增长', async () => {
  const directory = mkdtempSync(join(process.env.RIVET_HOME ?? tmpdir(), 'process-pages-'))
  try {
    const history = await UIHistory.open(join(directory, 'ui-history.jsonl'))
    for (let i = 0; i < 500; i++) history.append({ kind: 'tool', name: 'read_file', text: `RESULT_${i}` })
    history.append({ kind: 'assistant', text: 'FINAL_AFTER_500' })
    const viewport = new ConversationViewport(history, () => {})
    await viewport.prepare(40, 8)
    assert.match(plain(viewport.render(40, 8)), /FINAL_AFTER_500/)
    viewport.handleKey(key('home', '', true))
    await viewport.settled()
    assert.equal(viewport.anchor.recordIndex, 0)
    for (let i = 0; i < 8; i++) {
      viewport.handleKey(key('down'))
      await viewport.settled()
    }
    assert.match(plain(viewport.render(40, 8)), /FINAL_AFTER_500/)
    viewport.handleKey(key('unknown', '/'))
    viewport.handleKey(key('unknown', 'RESULT_257'))
    viewport.handleKey(key('return'))
    await viewport.settled()
    assert.equal(viewport.searchState.matches, 1)
    assert.match(plain(viewport.render(40, 8)), /RESULT_257/)
    viewport.handleKey(key('escape'))
    await viewport.settled()
    assert.doesNotMatch(plain(viewport.render(40, 8)), /RESULT_257/)
    assert.ok(viewport.residentRecords <= 192)
    assert.ok(history.cachedRecords <= 320)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('点击执行过程展开按钮可以再次收起，不产生用户消息', async () => {
  const frontend = await session()
  try {
    frontend.record({ kind: 'tool', name: 'read_file', text: 'FILE_RESULT' })
    await frontend.viewport.prepare(80, 16)
    const paint = () => frontend.render([{ text: '> ', inputLine: 0, caretCol: 2 }], 0, ['天枢'])
    paint()
    const click = (y: number) => {
      frontend.handleMouse({ ...wheel, type: 'press', x: 3, y, button: 0 })
      frontend.handleMouse({ ...wheel, type: 'release', x: 3, y, button: 0 })
    }
    click(3)
    await frontend.viewport.settled()
    paint()
    assert.match(plain(frontend.viewport.render(80, 16)), /收起/)
    click(3)
    await frontend.viewport.settled()
    assert.match(plain(frontend.viewport.render(80, 16)), /展开/)
    assert.equal(frontend.history.count, 2)
  } finally { frontend.stopFullscreen() }
})

test('短分组展开后，方向键可到达第一条思考详情并用 Enter 展开', async () => {
  const history = await UIHistory.open()
  history.append({ kind: 'thinking', text: 'THOUGHT_BODY' })
  history.append({ kind: 'tool', name: 'read_file', text: 'FILE_RESULT' })
  history.append({ kind: 'assistant', text: 'FINAL' })
  const viewport = new ConversationViewport(history, () => {})
  await viewport.prepare(80, 20)
  viewport.selectRecord(0)
  await viewport.settled()
  viewport.handleKey(key('return'))
  await viewport.settled()
  viewport.handleKey(key('down'))
  await viewport.settled()
  viewport.handleKey(key('return'))
  await viewport.settled()
  assert.match(plain(viewport.render(80, 20)), /THOUGHT_BODY/)
  assert.equal(viewport.follow, false)
})

test('窄屏仍直接说明历史保存暂停，完整原因可展开查看', async () => {
  const history = await UIHistory.open()
  const warning = '历史记录缺失或读取不完整，已暂停保存；重启后新增记录可能缺失'
  history.append({ kind: 'notice', text: warning })
  const viewport = new ConversationViewport(history, () => {})
  await viewport.prepare(40, 10)
  assert.match(plain(viewport.render(40, 10)), /保存.*暂停|暂停保存/)
  viewport.handleKey(key('return'))
  await viewport.settled()
  assert.match(plain(viewport.render(40, 10)).replace(/\n/g, ''), /重启后新增记录可能缺失/)
})
