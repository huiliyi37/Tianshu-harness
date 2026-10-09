/**
 * /queue 显式排队 lane + ESC abort settle 回填 测试。
 *
 * 契约：
 * 1. /queue <text> 把文本推进 TuiApp.queueLane（简单 FIFO，不进 steer 队列、
 *    不打断当前 run、不触发提交），静态回显确认；无参时预览 lane（只看不清）。
 * 2. 下一次 idle 提交时，steer 残留 + queueLane 一并归并进新 prompt 前部
 *    （steer 在前、lane 在后，各自内部保序），lane 拼完清空，合并提示计数
 *    把 lane 条数算进去。
 * 3. 用户主动 ESC 的 run settle 之后：steer 队列非空且输入框为空 → 排队原文
 *    拉回输入框（getPendingEntries()+clear()，不是 drain——契约见
 *    src/tui/__tests__/esc-abort-steer-preserve.test.ts）；输入框有草稿不动；
 *    守护中断（watchdog/convergence）不回填（自动续跑还要靠队列 drain）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { registerQueueCommand } from '../../slash-commands.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  // 与生产一致：注册命令 + 声明提示列表，slash 分发才不会被当成 Linux 路径。
  registerQueueCommand(app)
  app.setSlashCommands([{ name: '/queue', description: 'queue' }])
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

async function type(app: TuiApp, stdin: MockIn, text: string) {
  app.setInput(text)
  stdin.dataHandler!('\r')
  await tick()
}

test('/queue 入队：静态回显确认，不进 steer 队列、不触发提交', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  await type(app, stdin, '/queue 第一个任务')
  assert.deepEqual([...app.queueLane], ['第一个任务'], '文本进 lane')
  assert.equal(app.steerBuffer.hasPending(), false, '不进 steer 队列')
  assert.equal(runs.length, 0, '不触发提交')
  assert.ok(app.getScrollbackContent().includes('已排队到下轮（1 条）'), '回显计数 1')

  await type(app, stdin, '/queue 第二个')
  assert.deepEqual([...app.queueLane], ['第一个任务', '第二个'], 'FIFO 保序')
  assert.ok(app.getScrollbackContent().includes('已排队到下轮（2 条）'), '回显计数 2')
})

test('/queue 无参：预览 lane，空与非空两种口径，均不消费', async () => {
  const { app, stdin } = makeApp()

  await type(app, stdin, '/queue')
  assert.ok(app.getScrollbackContent().includes('排队队列为空'), '空 lane 提示用法')

  await type(app, stdin, '/queue 甲')
  await type(app, stdin, '/queue 乙')
  await type(app, stdin, '/queue')
  const scrollback = app.getScrollbackContent()
  assert.ok(scrollback.includes('排队队列（2 条）'), '预览带计数')
  assert.ok(scrollback.includes('1. 甲') && scrollback.includes('2. 乙'), '预览按序列出')
  assert.deepEqual([...app.queueLane], ['甲', '乙'], '预览不清空 lane')
})

test('idle 提交归并：lane 拼在新消息前部、保序、lane 清空、计数提示', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  await type(app, stdin, '/queue 第一个任务')
  await type(app, stdin, '/queue 第二个')
  await type(app, stdin, 'main message')

  assert.deepEqual(runs, ['第一个任务\n\n第二个\n\nmain message'], 'lane 文本按序拼在 prompt 前部')
  assert.equal(app.queueLane.length, 0, 'lane 拼完清空')
  assert.ok(app.getScrollbackContent().includes('2 queued messages merged into this prompt'), '合并提示计数含 lane')
})

test('busy 时 /queue 照攒；steer 残留 + lane 混合归并（steer 在前 lane 在后）', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // 启动 run A → busy
  await type(app, stdin, 'task A')
  assert.equal(app.busy, true)

  // busy 期间：普通 Enter 进 steer 队列，/queue 进 lane——两者各行其道。
  await type(app, stdin, 'steer 消息')
  assert.equal(app.steerBuffer.hasPending(), true)
  await type(app, stdin, '/queue lane 消息')
  assert.deepEqual([...app.queueLane], ['lane 消息'], 'busy 时 /queue 可用')
  assert.equal(runs.length, 1, 'busy 期间不发起新 run')

  // run A 结束，再提交 → 两源归并
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()
  await type(app, stdin, 'task B')

  assert.equal(runs.length, 2)
  assert.equal(runs[1], 'steer 消息\n\nlane 消息\n\ntask B', 'steer 残留在前、lane 在后')
  assert.equal(app.steerBuffer.hasPending(), false)
  assert.equal(app.queueLane.length, 0)
})

test('ESC abort settle 回填：buffer 非空 + 输入框空 → 原文回填且 buffer 清空', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起 */ })
  let agentRunning = false
  app.setAgentRunningProbe(() => agentRunning)

  await type(app, stdin, 'task A')
  agentRunning = true
  await type(app, stdin, '排队一')
  await type(app, stdin, '排队二')
  assert.equal(app.steerBuffer.hasPending(), true)

  // 用户主动中断（无 reason）：abort 路径本身只 peek 不消费（契约）。
  app.callbacks.onAbort()
  await tick()
  assert.equal(app.busy, false)
  assert.equal(app.steerBuffer.hasPending(), true, 'abort 当下队列原样保留')
  assert.equal(app.getInputValue(), '', '输入框还是空的')

  // run settle：队列再无 drain 边界 → 拉回输入框。
  agentRunning = false
  app.notifyRunSettled()
  await tick()
  assert.equal(app.getInputValue(), '排队一\n\n排队二', '排队原文按序回填输入框')
  assert.equal(app.steerBuffer.hasPending(), false, 'buffer 已清空')
  assert.ok(app.getScrollbackContent().includes('已把 2 条排队消息拉回输入框'), '静态提示一行')
})

test('ESC abort settle：输入框有草稿 → 不回填，队列留待下次提交归并', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })
  let agentRunning = false
  app.setAgentRunningProbe(() => agentRunning)

  await type(app, stdin, 'task A')
  agentRunning = true
  await type(app, stdin, '排队一')

  app.callbacks.onAbort()
  await tick()
  app.setInput('草稿')
  agentRunning = false
  app.notifyRunSettled()
  await tick()

  assert.equal(app.getInputValue(), '草稿', '草稿不被覆盖')
  assert.equal(app.steerBuffer.hasPending(), true, '队列保留')

  // 下次提交照归并口径拼进前部
  app.setInput('正式消息')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(runs[1], '排队一\n\n正式消息')
})

test('守护中断（convergence）settle 不回填：队列留给自动续跑 drain', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起 */ })
  let agentRunning = false
  app.setAgentRunningProbe(() => agentRunning)

  await type(app, stdin, 'task A')
  agentRunning = true
  await type(app, stdin, '排队一')

  app.callbacks.onAbort('convergence:no-tool')
  await tick()
  agentRunning = false
  app.notifyRunSettled()
  await tick()

  assert.equal(app.getInputValue(), '', '不回填输入框')
  assert.equal(app.steerBuffer.hasPending(), true, '队列保留')
})
