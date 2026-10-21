/**
 * T9 /domain → GlanceBar 接线测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { captureLiveFrame, type CapturedLiveFrame } from './_capture-frame.js'

class MockOut {
  columns = 100
  rows = 40
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows: 40, modelName: 'test',
  })
  return { app, out, frame: captureLiveFrame(app) }
}

const glanceFromFrame = (frame: CapturedLiveFrame) => frame.text()

test('setSessionStarDomain 切换 GlanceBar 显示', () => {
  const { app, out, frame } = makeApp()
  app.start()
  out.chunks.length = 0
  app.setSessionStarDomain('天权')
  const plain = glanceFromFrame(frame)
  assert.ok(plain.includes('天权'), `expected 天权 in glance: ${plain.slice(0, 200)}`)
})

test('turnComplete 后保留 /domain 设定的星域（不清回默认）', async () => {
  const { app, out, frame } = makeApp()
  app.start()
  app.setSessionStarDomain('天权')
  out.chunks.length = 0
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await new Promise(r => setTimeout(r, 20))
  const plain = glanceFromFrame(frame)
  assert.ok(plain.includes('天权'), `session domain persists: ${plain.slice(0, 200)}`)
})

test('委派期间会话星域保持不变（天机是编排阶段标记，不上主面板）', async () => {
  const { app, out, frame } = makeApp()
  app.start()
  app.setSessionStarDomain('天权')
  out.chunks.length = 0
  app.callbacks.onToolUse('d1', 'delegate_task', { objective: 'explore' })
  const plain = glanceFromFrame(frame)
  assert.ok(plain.includes('天权'), `session domain must persist during delegation: ${plain.slice(0, 200)}`)
  assert.ok(!plain.includes('天机'), 'no tianji override on the main panel')

  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await new Promise(r => setTimeout(r, 20))
  assert.ok(glanceFromFrame(frame).includes('天权'), 'still 天权 after turn completes')
})
