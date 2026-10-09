/**
 * T9 跨 run steer 收口 + 流式残留缓冲回归测试。
 *
 * Bug 1（steer 泄漏）：text-only 收尾的 run 从不 drain steerBuffer，残留的
 * guidance 会在下一次 run 的首个工具回合作为 [User guidance] 注入 ——
 * 上一轮的指令混进新任务上下文，表现为「先回旧话题再答新任务」。
 * 契约：新 submit 时残留 steer 归并进本次 prompt，buffer 清空。
 *
 * Bug 2（blockWriter 残留）：上一 run 未 finalize（abort / maxTurns 耗尽）时
 * blockWriter 缓冲不清，新 run 的文本追加在旧缓冲之上一起 flush ——
 * 上一轮的文字随新轮输出重现。
 * 契约：abort 与新 submit 都丢弃未 finalize 的缓冲。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
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

test('残留 steer 在下一次 submit 时归并进 prompt 并清空 buffer', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // run A：发起后保持 busy，期间输入进 steerBuffer
  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true)

  app.setInput('note 1')
  stdin.dataHandler!('\r')
  await tick()
  assert.deepEqual([...app.steerBuffer.getPending()], ['note 1'], 'busy 期间输入应入队')

  // run A text-only 收尾（从不 drain steer）→ busy 复位，steer 残留
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()
  assert.equal(app.busy, false)
  assert.equal(app.steerBuffer.hasPending(), true, 'text-only 收尾不 drain，残留保留到下一次 submit')

  // run B：残留 steer 必须归并进新 prompt，而非泄漏到 B 的工具回合
  app.setInput('task B')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(runs.length, 2)
  assert.equal(runs[1], 'note 1\n\ntask B', '残留 guidance 按时间序拼在新消息之前')
  assert.equal(app.steerBuffer.hasPending(), false, '归并后 buffer 必须清空')
})

test('abort 丢弃 blockWriter 未 flush 缓冲，新 run 不重现旧文本', async () => {
  const { app, out, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起 */ })

  // run A：流入一段不足以触发 block 切分的短文本（停留在 blockWriter 缓冲）
  app.setInput('A')
  stdin.dataHandler!('\r')
  await tick()
  app.callbacks.onTextDelta('STALE_BUF')
  // 中止 run A → 缓冲必须被丢弃
  stdin.dataHandler!('\x03')
  await tick()
  const baseline = out.chunks.length

  // run B：新文本 + final flush
  app.setInput('B')
  stdin.dataHandler!('\r')
  await tick()
  app.callbacks.onTextDelta('fresh reply from run B')
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()

  const afterAbort = out.chunks.slice(baseline).join('')
  assert.ok(!afterAbort.includes('STALE_BUF'), 'run A 的未 flush 缓冲不得混入 run B 输出')
  assert.ok(afterAbort.includes('fresh reply from run B'), 'run B 自身文本正常输出')
})
