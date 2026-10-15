import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockIn, MockOut } from './_harness.js'
import { setClipboardReader } from '../clipboard-image.js'

const image = { dataUrl: 'data:image/png;base64,aGVsbG8=', mime: 'image/png', name: 'clip.png', source: 'png' as const }
function makeApp() {
  const out = new MockOut(), stdin = new MockIn()
  const app = new TuiApp({ stdout: out as unknown as WriteStream, stdin: stdin as unknown as ReadStream, cols: 80, rows: 24 })
  app.start(); app.setInput('original')
  return { app, out, stdin }
}

for (const stage of ['focus-text', 'image', 'fallback-text'] as const) {
  for (const cleanup of ['dispose', 'restoreTerminalSync'] as const) {
    test(`pending ${stage} paste cannot change a draft after ${cleanup}`, async () => {
      const { app, out } = makeApp()
      let release!: (value: any) => void
      const pendingRead = new Promise<any>(resolve => { release = resolve })
      let reads = 0
      setClipboardReader({
        readImage: async () => stage === 'image' ? (reads++, pendingRead) : null,
        readText: async () => { reads++; return pendingRead },
      })
      ;(app as any).lastInputFocusAt = stage === 'focus-text' ? Date.now() : Date.now() - 2000
      try {
        const pending = (app as any).handleCtrlV() as Promise<void>
        await tick()
        assert.equal(reads, 1, 'the clipboard operation must be awaiting its result')
        app[cleanup]()
        const boundary = out.chunks.length
        release(stage === 'image' ? image : 'late text')
        await pending
        assert.equal(app.getInputValue(), 'original')
        assert.equal(app.getInputImagesCount(), 0)
        assert.equal(out.chunks.slice(boundary).join(''), '')
      } finally { release(null); setClipboardReader(null); app.dispose() }
    })
  }
}

for (const stage of ['focus-text', 'image', 'fallback-text'] as const) {
  test(`pending ${stage} paste cannot change the next draft after submitting`, async () => {
    const { app, stdin } = makeApp()
    let release!: (value: any) => void
    const pendingRead = new Promise<any>(resolve => { release = resolve })
    let started = false
    const submitted: string[] = []
    app.onSubmit(text => { submitted.push(text) })
    setClipboardReader({
      readImage: async () => stage === 'image' ? (started = true, pendingRead) : null,
      readText: async () => { started = true; return pendingRead },
    })
    ;(app as any).lastInputFocusAt = stage === 'focus-text' ? Date.now() : Date.now() - 2000
    try {
      const pending = (app as any).handleCtrlV() as Promise<void>
      await tick()
      assert.equal(started, true, 'the paste must still be awaiting its result')
      stdin.dataHandler!('\r')
      await tick()
      assert.deepEqual(submitted, ['original'])
      app.setInput('next draft')
      release(stage === 'image' ? image : 'late text')
      await pending
      assert.equal(app.getInputValue(), 'next draft')
      assert.equal(app.getInputImagesCount(), 0, 'an old paste must not attach to the next message')
    } finally { release(null); setClipboardReader(null); app.dispose() }
  })
}

test('an empty Enter does not cancel a paste for the current draft', async () => {
  const { app, stdin } = makeApp()
  let release!: (text: string | null) => void
  const read = new Promise<string | null>(resolve => { release = resolve })
  setClipboardReader({ readImage: async () => null, readText: async () => read })
  ;(app as any).lastInputFocusAt = Date.now()
  try {
    app.setInput('')
    const pending = (app as any).handleCtrlV() as Promise<void>
    await tick()
    stdin.dataHandler!('\r')
    await tick()
    release('current paste')
    await pending
    assert.equal(app.getInputValue(), 'current paste')
  } finally { release(null); setClipboardReader(null); app.dispose() }
})

test('Ctrl+V cancels exit confirmation before waiting for the clipboard', async () => {
  const { app, stdin } = makeApp()
  let release!: (text: string | null) => void
  const read = new Promise<string | null>(resolve => { release = resolve })
  setClipboardReader({ readImage: async () => null, readText: async () => read })
  ;(app as any).lastInputFocusAt = Date.now()
  try {
    app.setInput('')
    stdin.dataHandler!('\x03')
    assert.ok((app as any).inputController.ctrlCPendingSince > 0)
    const pending = (app as any).handleCtrlV() as Promise<void>
    await tick()
    assert.equal((app as any).inputController.ctrlCPendingSince, 0, 'continuing to paste must restore the input immediately')
    assert.equal((app as any).inputController.ctrlCExitTimer, null)
    release('visible paste')
    await pending
    assert.equal(app.getInputValue(), 'visible paste')
  } finally { release(null); setClipboardReader(null); app.dispose() }
})

test('pending binary paste cannot attach an image after terminal restoration', async () => {
  const { app, stdin } = makeApp()
  let release!: (value: typeof image | null) => void
  const pending = new Promise<typeof image | null>(resolve => { release = resolve })
  let started = false
  setClipboardReader({ readText: async () => null, readImage: async () => { started = true; return pending } })
  try {
    stdin.dataHandler!('\x1b[200~' + '\ufffd'.repeat(20) + '\x1b[201~')
    await tick()
    assert.equal(started, true)
    app.restoreTerminalSync()
    release(image)
    await tick()
    assert.equal(app.getInputImagesCount(), 0)
    assert.equal(app.getInputValue(), 'original')
  } finally { release(null); setClipboardReader(null); app.dispose() }
})

for (const owner of ['palette', 'palette-return', 'approval-edit'] as const) {
  test(`pending conversation paste cannot cross into ${owner}`, async () => {
    const { app } = makeApp()
    let release!: (text: string | null) => void
    const read = new Promise<string | null>(resolve => { release = resolve })
    setClipboardReader({ readImage: async () => null, readText: async () => read })
    ;(app as any).lastInputFocusAt = Date.now() - 2000
    try {
      const pending = (app as any).handleCtrlV()
      await tick()
      if (owner === 'approval-edit') {
        void app.callbacks.onApprovalRequired!('t1', 'write_file', { path: 'example.ts', content: 'original' })
        ;(app as any).enterApprovalEditMode()
      } else {
        app.registerOverlays({ paletteCommands: () => ({ commands: [], selectedIndex: 0 }) })
        app.activateOverlay('command-palette')
        if (owner === 'palette-return') app.deactivateOverlay()
      }
      const draft = app.getInputValue()
      release('late text')
      await pending
      assert.equal(app.getInputValue(), draft, 'old reads must not write into a different input owner')
      assert.equal(app.getOverlayQuery(), '')
    } finally { release(null); setClipboardReader(null); app.dispose() }
  })
}

test('terminal restoration cancels its native writer and queued copies', async () => {
  const { app } = makeApp()
  const originalSpawn = childProcess.spawn
  const writers: Array<EventEmitter & { stdin: PassThrough; kill: () => boolean }> = []
  let kills = 0
  childProcess.spawn = (() => {
    const writer = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: () => { kills++; return true } })
    writer.stdin.resume()
    writers.push(writer)
    return writer
  }) as unknown as typeof childProcess.spawn
  syncBuiltinESMExports()
  const oldPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const sshEnv = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']
  const savedEnv = new Map(sshEnv.map(name => [name, process.env[name]]))
  for (const name of sshEnv) delete process.env[name]
  try {
    ;(app as any).frontend.copySelection = () => 'selected text'
    assert.equal((app as any).copyFrontendSelection(), true)
    assert.equal((app as any).copyFrontendSelection(), true)
    await tick()
    assert.equal(writers.length, 1, 'the second writer must be queued')
    app.restoreTerminalSync()
    assert.equal(kills, 1, 'the owned native writer must be stopped')
    writers[0]!.emit('close', null)
    await tick()
    assert.equal(writers.length, 1, 'queued copies must not start after exit')
  } finally {
    for (const writer of writers) writer.emit('close', null)
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', { value: oldPlatform })
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    app.dispose()
  }
})
