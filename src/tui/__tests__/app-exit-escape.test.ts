/**
 * 退出逃生通道 — Ctrl+C 在 agent 活跃/卡死时仍必须能退出。
 *
 * 缺陷（2026-09-10 修复前）：键路由先判 agent-active，活跃时 Ctrl+C 只
 * 走 handleAbort 且**不开启退出确认窗口**。用户按两次的后果是——第一次
 * abort、第二次因 agent 仍未 settle 再次进入 abort 分支（实测 abort 调用
 * 1 次、进程不退出），必须按满三次才可能进窗口；agent 彻底卡住时则永远
 * 退不出。修复：窗口判定优先于 agent-active，且活跃分支在 abort 的同时
 * 开启确认窗口（armExitConfirm）。
 *
 * 本组测试锁死该不变量：**无论 agent 是否活跃，两次 Ctrl+C 必定退出。**
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

type AnyApp = Record<string, (...args: unknown[]) => unknown>
const tick = () => new Promise(r => setTimeout(r, 10))

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
  let exited = false
  let aborts = 0
  ;(app as unknown as AnyApp).onExit!(((): void => { exited = true }) as never)
  ;(app as unknown as AnyApp).onAbort!(((): void => { aborts++ }) as never)
  return {
    app, stdin,
    state: { get exited() { return exited }, get aborts() { return aborts } },
  }
}

test('空闲态：两次 Ctrl+C 退出（回归保护）', async () => {
  const { app, stdin, state } = makeApp()
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(state.exited, false, '首按只进确认窗口，不退出')
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(state.exited, true, '窗口内二次 Ctrl+C 必须退出')
  assert.equal(
    (app as unknown as { inputController: { ctrlCPendingSince: number } }).inputController.ctrlCPendingSince,
    0, '退出后确认窗口已复位',
  )
})

test('agent 活跃：两次 Ctrl+C 必须退出（本次修复的核心不变量）', async () => {
  const { app, stdin, state } = makeApp()
  ;(app as unknown as { agentBusy: boolean }).agentBusy = true
  assert.equal((app as unknown as AnyApp).isAgentActive!(), true, '前置条件：agent 处于活跃态')

  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(state.aborts, 1, '首按仍作 interrupt（对齐 Claude Code）')
  assert.equal(state.exited, false, '首按不直接退出')
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(state.exited, true, 'agent 活跃时二次 Ctrl+C 也必须能退出——卡死的 agent 不得封死退出通道')
})

test('agent 活跃：abort 后 agent 仍未 settle，二次 Ctrl+C 依然退出', async () => {
  const { app, stdin, state } = makeApp()
  ;(app as unknown as { agentBusy: boolean }).agentBusy = true
  stdin.dataHandler!('\x03')
  await tick()
  // 模拟 abort 未生效：agent 依旧活跃
  ;(app as unknown as { agentBusy: boolean }).agentBusy = true
  assert.equal((app as unknown as AnyApp).isAgentActive!(), true, '前置条件：abort 后 agent 仍活跃')
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(state.exited, true, '不 settle 的 agent 不得吞掉退出通道')
})

test('agent 活跃：/exit 直通退出（immediate 命令不被 steer 排队）', async () => {
  const { app, stdin, state } = makeApp()
  ;(app as unknown as { agentBusy: boolean }).agentBusy = true
  for (const ch of '/exit') stdin.dataHandler!(ch)
  stdin.dataHandler!('\r')
  await tick(); await tick(); await tick()
  assert.equal(state.exited, true, 'agent 活跃时 /exit 仍须直通退出')
})
