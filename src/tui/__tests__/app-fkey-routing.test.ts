/**
 * f1-f8 快捷键路由测试 — app.ts 键路由接线。
 *
 * 覆盖：
 *  #1 f1-f8 映射到对应 slash 命令（经 tryDispatchSlash 管线）
 *  #2 f9-f12 未绑定 → 不触发分发
 *  #3 overlay 激活时不路由（防面板叠加/误触关闭）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../engine/app.js'

class MockOut {
  columns = 120; rows = 24; chunks: string[] = []
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
    cols: 120, rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  return { app, stdin }
}

/** 序列来自 input-handler.ts ANSI_ESCAPE_MAP（L160-171）：'OP'→f1 … '[19~'→f8 */
const FKEY_SEQS: Record<string, string> = {
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
  f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
  f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
}

function stubDispatch(app: TuiApp): string[] {
  const calls: string[] = []
  ;(app as unknown as { tryDispatchSlash: (input: string) => Promise<boolean> }).tryDispatchSlash =
    async (input: string) => { calls.push(input); return true }
  return calls
}

test('#1 f1-f8 route to their slash commands via tryDispatchSlash', () => {
  const { app, stdin } = makeApp()
  const calls = stubDispatch(app)

  const expected: Record<string, string> = {
    f1: '/help', f2: '/tasks', f3: '/cache', f4: '/cockpit',
    f5: '/theme', f6: '/model', f7: '/permission', f8: '/sessions',
  }

  for (const [keyName, cmd] of Object.entries(expected)) {
    stdin.dataHandler!(FKEY_SEQS[keyName]!)
    assert.equal(calls.at(-1), cmd, `${keyName} routes to ${cmd}`)
  }
  assert.equal(calls.length, 8, 'exactly 8 dispatches')
})

test('#2 unbound f9-f12 do not dispatch', () => {
  const { app, stdin } = makeApp()
  const calls = stubDispatch(app)

  for (const keyName of ['f9', 'f10', 'f11', 'f12']) {
    stdin.dataHandler!(FKEY_SEQS[keyName]!)
  }
  assert.equal(calls.length, 0, 'no dispatch for unbound F keys')
})

test('#3 F keys do not route while an overlay is active', () => {
  const { app, stdin } = makeApp()
  const calls = stubDispatch(app)

  // 模拟 overlay 激活态（overlay 引擎的激活链路需完整 setup，另测）——
  // 这里测的是 f 键路由分支对 isActive 守卫的真实行为。
  const overlay = (app as unknown as { overlay: { isActive: () => boolean } }).overlay
  const origIsActive = overlay.isActive
  overlay.isActive = () => true
  try {
    stdin.dataHandler!(FKEY_SEQS['f1']!)
    assert.equal(calls.length, 0, 'f1 not routed while overlay active')
  } finally {
    overlay.isActive = origIsActive
  }
})

test('#4 shift+return 翻转粘滞换行模式（对齐公开仓 newlineMode）', () => {
  const { app, stdin } = makeApp()
  const inputLine = (app as unknown as { inputLine: { newlineMode: boolean } }).inputLine
  // kitty modifyOtherKeys：\x1b[13;2u → name=return shift=true（input-handler L552-556 + L479）
  const SHIFT_RETURN = '\x1b[13;2u'

  assert.equal(inputLine.newlineMode, false, '初始为正常模式')
  stdin.dataHandler!(SHIFT_RETURN)
  assert.equal(inputLine.newlineMode, true, 'shift+return 开启换行模式')
  stdin.dataHandler!(SHIFT_RETURN)
  assert.equal(inputLine.newlineMode, false, '再按 shift+return 退出换行模式（双向翻转，防永远置位）')
})

test('#5 start() 请求 kitty 键盘消歧协议（>1u + ?u 能力探测），restore 弹栈还原（<u）——Shift+Enter 能被终端以 CSI-u 送达的前提', () => {
  const { app } = makeApp()
  const out = (app as unknown as { stdout: { chunks: string[] } }).stdout
  out.chunks = []
  // start() 在欢迎块渲染后由 main 调用；直接调用以断言协议序列写入
  app.start()
  assert.ok(out.chunks.some(c => c.includes('\x1B[>1u')), 'start 必须请求 kitty 键盘消歧（否则终端把 Shift+Enter 当普通 Enter 提交）')
  assert.ok(out.chunks.some(c => c.includes('\x1B[?u')), 'start 须发 ?u 能力探测（收到回包才在 footer 提示 shift+enter——不支持终端上该键与 Enter 同码，提示即谎言）')
  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004h')), 'bracketed paste 照常开启')

  out.chunks = []
  app.restoreTerminalSync()
  assert.ok(out.chunks.some(c => c.includes('\x1B[<u')), 'restore 必须弹出 kitty keyboard protocol（与 >1u 成对）')
  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004l')), 'bracketed paste 照常关闭')
})
