/**
 * 输出冻结（Ctrl+S / Ctrl+Q）——触摸终端（Termux 等）滚动回看的根治。
 *
 * 断言的是「冻结期 stdout 真的零写入」而不是「标志位为 true」——任何光标
 * 寻址写入（spinner tick、流式帧、CPR 探针）都会把触摸终端的 scrollback
 * 视口拽回底部，标志位测试挡不住把门接错位置的回归。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn, stripAnsi } from './_harness.js'

interface AppInternals {
  outputFrozen: boolean
  getDynamicBudget(chromeRows: number, dynamicRows: number): number
  rows: number
}

function makeApp(rows = 24) {
  const out = new MockOut(100, rows)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows, modelName: 'test', contextWindow: 200_000,
  })
  app.start()
  return {
    app,
    out,
    stdin,
    internals: app as unknown as AppInternals,
    feed: (raw: string) => stdin.dataHandler!(raw),
  }
}

const tick = () => new Promise(r => setTimeout(r, 10))

describe('输出冻结（Ctrl+S）', () => {
  test('ctrl_s/ctrl_q 键映射生效：切换 outputFrozen', () => {
    const { app, feed, internals } = makeApp()
    assert.equal(internals.outputFrozen, false)
    feed('\x13')
    assert.equal(internals.outputFrozen, true, 'Ctrl+S 冻结')
    feed('\x13')
    assert.equal(internals.outputFrozen, false, 'Ctrl+S 再按解冻')
    feed('\x13')
    feed('\x11')
    assert.equal(internals.outputFrozen, false, 'Ctrl+Q 解冻别名')
  })

  test('冻结期流式 delta 不产生任何 stdout 写入；解冻后补上', async () => {
    const { app, out, feed, stdin } = makeApp()
    app.callbacks.onThinkingDelta('第一段')
    await tick()
    expectRendered(out, '第一段')

    feed('\x13') // 冻结（含一行 ⏸ 标记写入）
    const afterFreeze = out.chunks.length
    assert.ok(stripAnsi(out.chunks.join('')).includes('输出已冻结'), '冻结标记行要写进 scrollback')

    out.chunks.length = 0
    app.callbacks.onThinkingDelta('第二段被缓冲')
    await tick()
    await tick()
    assert.equal(out.chunks.filter(c => stripAnsi(c).includes('第二段')).length, 0, '冻结期不得有流式内容写出')
    assert.equal((app as unknown as AppInternals).outputFrozen, true)

    feed('\x11') // 解冻
    await tick()
    const unfrozenText = stripAnsi(out.chunks.join(''))
    assert.match(unfrozenText, /第二段/, '解冻后缓冲内容必须补上')
    void afterFreeze
    void stdin
  })

  test('冻结期 ticker 不起转（活动态下冻结即停 120ms spinner 写入）', async () => {
    const { app, internals, feed } = makeApp()
    app.callbacks.onThinkingDelta('x')
    await tick()
    feed('\x13')
    const withTicker = internals as unknown as {
      streamRenderController: { ticker: ReturnType<typeof setInterval> | null }
    }
    assert.equal(withTicker.streamRenderController.ticker, null, '冻结必须停掉 120ms ticker')
    feed('\x11')
    assert.ok(withTicker.streamRenderController.ticker, '解冻后 ticker 恢复')
  })
})

describe('矮屏降级 — 高水位半屏封顶', () => {
  // welcomeIdle 守卫（idle + turn 0 → 预算 0）会盖住矮屏断言，先驱动一个
  // delta 让 phase 离开 idle。
  async function makePrimedApp(rows: number) {
    const ctx = makeApp(rows)
    ctx.app.callbacks.onThinkingDelta('prime')
    await tick()
    return ctx
  }

  test('rows=12（软键盘展开）高水位预算 ≤ 半屏', async () => {
    const { internals } = await makePrimedApp(12)
    const budget = internals.getDynamicBudget(3, 100)
    assert.ok(budget <= 6 - 3, `rows=12 的动态预算应 ≤ 3（半屏 6 减 chrome 3），got ${budget}`)
  })

  test('rows=40 桌面高度不受影响（回归锚点）', async () => {
    const { internals } = await makePrimedApp(40)
    const budget = internals.getDynamicBudget(3, 100)
    assert.ok(budget > 10, `rows=40 桌面档维持原 cap（28），got ${budget}`)
  })
})

// —— helpers ——

function expectRendered(out: MockOut, text: string): void {
  assert.match(stripAnsi(out.chunks.join('')), new RegExp(text), `${text} 应已渲染`)
  out.chunks.length = 0
}
