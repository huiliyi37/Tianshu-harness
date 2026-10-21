import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { makeApp, stripAnsi } from './_harness.js'
import type { FrontendSession } from '../frontend-session.js'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20))
const frontendOf = (app: ReturnType<typeof makeApp>['app']) => (app as unknown as { frontend: FrontendSession }).frontend
let originalTerm: string | undefined
beforeEach(() => { originalTerm = process.env.TERM; process.env.TERM = 'xterm-256color' })
afterEach(() => { if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm })

test('自动模式保留原生主屏，完成正文只提交一次并保留预览，第二条消息正常发送', async () => {
  const saved = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'Apple_Terminal'
  const { app, out, stdin } = makeApp({ renderer: 'auto' })
  const sent: string[] = []
  app.onSubmit(text => sent.push(text))
  try {
    await tick()
    assert.equal(frontendOf(app).isFullscreen, false)
    assert.doesNotMatch(out.chunks.join(''), /\x1b\[\?(?:1049|1002|1006)h/)
    stdin.dataHandler!('第一条\r')
    await tick()
    app.callbacks.onThinkingDelta('RECORDED_THOUGHT')
    app.callbacks.onTextDelta('NativeReplyOnce')
    app.callbacks.onTurnComplete({}, 1, true)
    await tick()
    assert.equal(stripAnsi(app.getScrollbackContent()).split('NativeReplyOnce').length - 1, 1)
    const committedAfterFirst = app.getScrollbackContent()
    out.clear()
    stdin.dataHandler!('第二条 j/k 路径 /src\r')
    await tick()
    assert.deepEqual(sent, ['第一条', '第二条 j/k 路径 /src'])
    const output = out.chunks.join('')
    assert.doesNotMatch(output, /\x1b\[2J|\x1b\[\?(?:1049|1002|1006)h/)
    assert.match(stripAnsi(output), /NativeReplyOnce/, 'the completed answer remains visible in the read-only viewport')
    assert.ok(app.getScrollbackContent().startsWith(committedAfterFirst), 'redrawing must preserve the committed history prefix')
    assert.equal(stripAnsi(app.getScrollbackContent()).split('NativeReplyOnce').length - 1, 1, 'previewing must not commit the answer again')
    assert.equal(frontendOf(app).isFullscreen, false)
    assert.equal(app.activeOverlayId(), null)
  } finally {
    app.dispose()
    if (saved === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = saved
  }
})

test('原生模式历史面板可折叠、鼠标选择，返回后关闭鼠标捕获且预览不重复提交正文', async () => {
  const { app, out, stdin } = makeApp({ renderer: 'classic' })
  const frontend = frontendOf(app)
  try {
    await tick()
    app.callbacks.onThinkingDelta('EXPANDABLE_THOUGHT')
    app.callbacks.onTextDelta('CopyableReply')
    app.callbacks.onTurnComplete({}, 1, true)
    await tick()
    const committedBeforeHistory = app.getScrollbackContent()
    assert.equal(stripAnsi(committedBeforeHistory).split('CopyableReply').length - 1, 1)
    out.clear()
    app.openUIHistory()
    await tick()
    await frontend.viewport.settled()
    assert.equal(app.activeOverlayId(), 'ui-history')
    assert.match(out.chunks.join(''), /\x1b\[\?1049h/)
    assert.match(out.chunks.join(''), /\x1b\[\?1006h/)
    const records = await frontend.history.page(0, frontend.history.count)
    frontend.viewport.selectRecord(records.findIndex(record => record.kind === 'thinking'))
    await frontend.viewport.settled()
    stdin.dataHandler!('\r')
    await frontend.viewport.settled()
    assert.match(stripAnsi(out.chunks.join('')), /EXPANDABLE_THOUGHT/)
    stdin.dataHandler!('\r')
    await frontend.viewport.settled()
    frontend.viewport.selectRecord(records.findIndex(record => record.kind === 'assistant'))
    await frontend.viewport.settled()
    const state = frontend as unknown as { visible: Array<{ text: string }>; historyTop: number }
    const i = state.visible.findIndex(row => stripAnsi(row.text).includes('CopyableReply'))
    assert.ok(i >= 0)
    const y = state.historyTop + i + 1
    stdin.dataHandler!(`\x1b[<0;1;${y}M\x1b[<32;20;${y}M\x1b[<0;20;${y}m`)
    assert.match(frontend.copySelection() ?? '', /CopyableReply/)
    stdin.dataHandler!('\x1b')
    await tick()
    assert.equal(frontend.copySelection(), null)
    out.clear()
    stdin.dataHandler!('\x1b')
    await tick()
    assert.equal(app.activeOverlayId(), null)
    const output = out.chunks.join('')
    assert.match(output, /\x1b\[\?1006l/)
    assert.equal(output.split('\x1b[?1049l').length - 1, 1)
    assert.doesNotMatch(output, /\x1b\[\?(?:1049|1002|1006)h/)
    assert.match(stripAnsi(output), /CopyableReply/, 'leaving history restores the committed answer preview')
    assert.equal(app.getScrollbackContent(), committedBeforeHistory, 'opening, copying and closing history must not append formal output')
    assert.equal(stripAnsi(app.getScrollbackContent()).split('CopyableReply').length - 1, 1)
  } finally { app.dispose() }
})

test('鼠标关闭时历史面板保持键盘可用，不捕获终端鼠标', async () => {
  const { app, out, stdin } = makeApp({ renderer: 'classic' })
  try {
    app.setFrontendPreferences({ ...app.getFrontendPreferences(), mouse: false })
    out.clear()
    app.openUIHistory()
    await tick()
    assert.equal(app.activeOverlayId(), 'ui-history')
    assert.doesNotMatch(out.chunks.join(''), /\x1b\[\?(?:1002|1006)h/)
    stdin.dataHandler!('\x1b')
    await tick()
    assert.equal(app.activeOverlayId(), null)
  } finally { app.dispose() }
})

test('历史面板内同步崩溃时关闭鼠标捕获，恢复主屏且只还原一次', async () => {
  const { app, out } = makeApp({ renderer: 'classic' })
  try {
    app.openUIHistory()
    await tick()
    assert.equal(app.activeOverlayId(), 'ui-history')
    out.clear()
    app.restoreTerminalSync()
    app.restoreTerminalSync()
    const output = out.chunks.join('')
    assert.match(output, /\x1b\[\?1006l/)
    assert.equal(output.split('\x1b[?1049l').length - 1, 1)
  } finally { app.dispose() }
})

test('手动全屏仍可切回自动，草稿与原生主屏保留', async () => {
  const { app, out } = makeApp({ renderer: 'fullscreen' })
  try {
    app.setInput('KEEP_DRAFT')
    out.clear()
    assert.equal(app.setFrontendPreferences({ ...app.getFrontendPreferences(), renderer: 'auto' }), true)
    assert.equal(frontendOf(app).isFullscreen, false)
    assert.equal(app.getInputValue(), 'KEEP_DRAFT')
    assert.match(out.chunks.join(''), /\x1b\[\?1049l/)
  } finally { app.dispose() }
})

test('粘贴 home 图片路径加载真实附件，保留中文空格且不自动发送', async () => {
  const directory = mkdtempSync(join(process.env.RIVET_HOME ?? os.tmpdir(), 'image-home-'))
  const original = os.homedir
  os.homedir = () => directory
  syncBuiltinESMExports()
  const { app, stdin } = makeApp({ renderer: 'classic' })
  let submits = 0
  app.onSubmit(() => { submits++ })
  try {
    mkdirSync(join(directory, 'Pictures'))
    writeFileSync(join(directory, 'Pictures', '截图 一.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0eEAAAAASUVORK5CYII=', 'base64'))
    stdin.dataHandler!('\x1b[200~"~/Pictures/截图 一.png"\x1b[201~')
    for (let i = 0; i < 50 && !app.getInputImagesCount(); i++) await tick()
    assert.equal(app.getInputImagesCount(), 1)
    assert.equal(app.getInputValue(), '')
    assert.equal(submits, 0)
  } finally {
    app.dispose()
    os.homedir = original
    syncBuiltinESMExports()
    rmSync(directory, { recursive: true, force: true })
  }
})
