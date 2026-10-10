/**
 * 显式插队引导（Alt+Enter / /steer）—— 与普通 Enter 排队、/queue lane 的契约区分。
 *
 * 契约：
 * 1. busy 时 Alt+Enter / /steer 以 now 优先级进 steer 队列 → 下一个工具边界
 *    drain('next') 立即取走（不等本轮结束）；
 * 2. 普通 Enter（busy）保持 later 优先级 → 工具边界不取，本轮结束后发出
 *    （既有契约，见 queue-lane.test.ts / steer-queue-confirm.test.ts）；
 * 3. idle 时 /steer 等价一次普通提交（不排队）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { registerSteerCommand } from '../../steer-command.js'
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
  registerSteerCommand(app)
  app.setSlashCommands([{ name: '/steer', description: 'steer' }])
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

async function type(app: TuiApp, stdin: MockIn, text: string) {
  app.setInput(text)
  stdin.dataHandler!('\r')
  await tick()
}

test('busy 时 /steer 以 now 优先级插队：工具边界 drain 立即取走', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // 启动 run A → busy
  await type(app, stdin, 'task A')
  assert.equal(app.busy, true)

  await type(app, stdin, '/steer 紧急：跳过当前步骤并换用方案B')
  await tick()

  const entries = app.steerBuffer.getPendingEntries()
  assert.equal(entries.length, 1, '插队引导进了 steer 队列')
  assert.equal(entries[0]!.priority, 'now', '显式插队必须是 now 优先级')
  assert.equal(runs.length, 1, 'busy 期间不发起新 run')

  // 工具边界只取 now/next——插队引导必须在这里被取走
  // 0c8840f60：TUI 工具边界迁移至 onHumanGuidanceDrain（drainHuman），返回
  // HumanGuidance 对象；旧 onSteerDrain 不再挂载（app.callbacks 上已无此键）。
  const drained = await app.callbacks.onHumanGuidanceDrain?.() ?? null
  assert.ok(drained !== null, '插队引导在工具边界被注入')
  assert.ok(drained!.text.includes('跳过当前步骤'), '注入内容包含插队引导文本')
  assert.equal(app.steerBuffer.hasPending(), false, '插队引导已消费')
})

test('普通 Enter（busy）保持 later：工具边界不取，留给本轮结束', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起 */ })

  await type(app, stdin, 'task A')
  assert.equal(app.busy, true)

  await type(app, stdin, '修改一下这个函数')
  await tick()

  const entries = app.steerBuffer.getPendingEntries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.priority, 'later', '普通消息不得被抬成插队优先级')
  assert.equal(await app.callbacks.onHumanGuidanceDrain?.() ?? null, null, '普通消息不被工具边界取走')
  assert.equal(app.steerBuffer.hasPending(), true, '仍在队列，等本轮结束')
})

test('Alt+Enter 与 /steer 同路：ESC+CR 序列 → now 优先级插队', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  await type(app, stdin, 'task A')
  assert.equal(app.busy, true)

  app.setInput('Alt+Enter 插队内容')
  stdin.dataHandler!('\x1b\r')
  await tick()

  const entries = app.steerBuffer.getPendingEntries()
  assert.equal(entries.length, 1, 'Alt+Enter 走了插队通路')
  assert.equal(entries[0]!.priority, 'now')
  assert.equal(app.getInputValue(), '', '输入框已清空（该路径不经 onSubmit 回调，需手工重置）')
  assert.equal(runs.length, 1)
})

test('idle 时 /steer 等价普通提交，不进队列', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  await type(app, stdin, '/steer 直接开始')
  await tick()

  assert.deepEqual(runs, ['直接开始'], 'idle 时作为普通 prompt 发起')
  assert.equal(app.steerBuffer.hasPending(), false, '不进 steer 队列')
})

test('/steer 无参：只提示用法，不提交也不入队', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  await type(app, stdin, '/steer')
  await tick()

  assert.equal(runs.length, 0, '无参不提交')
  assert.equal(app.steerBuffer.hasPending(), false, '无参不入队')
})
