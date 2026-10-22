/**
 * 1C：中断 UX 与队列策略。
 *
 * 契约：
 *  1. 中断后 scrollback 出现可见的 "⏹ Interrupted" 提示（而非无声卡死）。
 *  2. 中断时若停在审批态：审批被解析为拒绝（promise resolve(false)），输入模式复位，
 *     不残留审批态（否则后续按键被当审批解析、输入框不可用）。
 *  3. steer 队列在中断后被**保留**（对齐 Ink）：卡死期间排队的用户指引不丢失。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { createHandoffRequest } from '../../handoff.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

test('中断后 scrollback 出现 "⏹ Interrupted" 提示', async () => {
  const { app, out } = makeApp()
  out.chunks.length = 0
  app.callbacks.onAbort() // 模拟 loop/桥 驱动的中断
  await tick()
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('⏹ Interrupted'), `应有可见中断提示: ${plain.slice(0, 120)}`)
})

test('普通 onAbort 收尾归档已生成 handoff、清 pending 并反馈结果', () => {
  const { app, out } = makeApp()
  const root = mkdtempSync(join(tmpdir(), 'rivet-handoff-abort-'))
  try {
    const sessionDir = join(root, 'session-store')
    mkdirSync(join(root, '.rivet'), { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    const request = createHandoffRequest(root, 'session-aborted', join(sessionDir, 'session-aborted.handoff.md'))
    writeFileSync(request.sourcePath, 'handoff before abort')
    app.pendingHandoffCopy = request

    app.callbacks.onAbort()

    assert.equal(app.pendingHandoffCopy, undefined, '中断 callback 必须清掉 pending')
    assert.equal(readFileSync(request.destinationPath, 'utf8'), 'handoff before abort')
    assert.equal(readFileSync(request.sourcePath, 'utf8'), 'handoff before abort', '中断归档不删除项目源')
    assert.match(out.chunks.join(''), /交接请求已中断/)
    assert.match(out.chunks.join(''), /已归档至/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('中断解析挂起的审批为拒绝并复位审批态', async () => {
  const { app } = makeApp()
  // 进入审批态（loop 侧 onApprovalRequired 在等用户决定）
  const approvalPromise = app.callbacks.onApprovalRequired('t1', 'bash', { command: 'rm -rf /' })
  await tick()

  // loop 驱动的中断（用户 Esc → agent.abort → 旧 run onAbort 经桥到达）
  app.callbacks.onAbort()

  const result = await approvalPromise
  assert.equal(result, false, '挂起审批应被解析为拒绝，await 立即 settle')

  // 审批态已复位：再次发起审批应能重新进入（证明上一次未残留）
  let secondResolved = false
  const second = app.callbacks.onApprovalRequired('t2', 'bash', { command: 'ls' })
  second.then(() => { secondResolved = true })
  app.callbacks.onAbort()
  await second
  assert.equal(secondResolved, true, '审批态可被再次进入与中断（无残留死锁）')
})

test('steer 队列在中断后保留（卡死期间排队的指引不丢失）', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起 */ })

  // 发起 run → agentBusy=true
  app.setInput('start task')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true)

  // 卡死期间用户继续输入 → 进 steerBuffer
  app.setInput('actually focus on X')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.steerBuffer.hasPending(), true, '卡死期间输入进入 steer 队列')

  // 中断 → steer 队列应被保留
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(app.steerBuffer.hasPending(), true, '中断后 steer 队列应保留，不静默吞掉用户输入')
})
