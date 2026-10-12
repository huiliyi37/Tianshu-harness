/**
 * issue #238 同族缺陷（TUI 侧）——run 进行中带图提交时，图片此前被**静默丢弃**：
 * 用户气泡已渲染图片（awaitUserCommit 能编码终端图像）、steerBuffer 只收到文本，
 * 模型从未看到图，且没有任何提示 → 用户以为模型看到了。
 *
 * 契约（与服务端 #238 对齐）：插话通道仅能传文本（SteerBuffer 的 drain 契约是
 * string，无附件注入路径）→ 图片**暂存**到下一轮随 prompt 一并发出，并即时告知去向。
 *
 * RED 前置：TuiApp 尚无 getDeferredImagesCount()，第 1 条用例先红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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

const tick = (ms = 20) => new Promise<void>(r => setTimeout(r, ms))
const visible = (out: MockOut) => out.chunks.join('').replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

test('RED: TuiApp 暴露 getDeferredImagesCount（暂存附件可断言）', () => {
  const { app } = makeApp()
  assert.equal(typeof (app as { getDeferredImagesCount?: unknown }).getDeferredImagesCount, 'function')
  assert.equal((app as unknown as { getDeferredImagesCount(): number }).getDeferredImagesCount(), 0)
})

test('busy 提交带图：图片进入暂存而非消失，并给出可见的去向提示', async () => {
  const { app, out, stdin } = makeApp()
  app.onSubmit(() => {})
  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true, '前置：第一轮 run 使 agent 处于 busy')

  app.setInput('看这张图')
  ;(app as unknown as { inputLine: { addImage(u: string): void } }).inputLine.addImage(PNG_DATA_URL)
  stdin.dataHandler!('\r')
  await tick(40)

  const deferred = (app as unknown as { getDeferredImagesCount(): number }).getDeferredImagesCount()
  assert.equal(deferred, 1, '图片必须进入暂存——此前这里恒为「消失」')
  assert.ok(app.steerBuffer.hasPending(), '文本仍走 steer 通道')
  assert.match(visible(out), /将随下一条消息发送/, '必须明确告知附件去向（不再静默）')
})

test('暂存附件随下一条 prompt 一并发给 agent（顺序：暂存在前、本次提交在后）', async () => {
  const { app, stdin } = makeApp()
  const sent: Array<{ text: string; images?: string[] }> = []
  app.onSubmit((text, images) => {
    sent.push(images ? { text, images } : { text })
  })

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()

  app.setInput('忙时带图')
  ;(app as unknown as { inputLine: { addImage(u: string): void } }).inputLine.addImage(PNG_DATA_URL)
  stdin.dataHandler!('\r')
  await tick(40)
  assert.equal((app as unknown as { getDeferredImagesCount(): number }).getDeferredImagesCount(), 1)

  // 结束当前 run（回 idle），再发下一条——暂存图应随之发出
  ;(app as unknown as { agentBusy: boolean }).agentBusy = false
  app.setInput('下一轮')
  stdin.dataHandler!('\r')
  await tick(40)

  const last = sent[sent.length - 1]!
  assert.match(last.text, /下一轮/)
  assert.deepEqual(last.images, [PNG_DATA_URL], '暂存的图片必须随下一条 prompt 发给模型')
  assert.equal((app as unknown as { getDeferredImagesCount(): number }).getDeferredImagesCount(), 0, '发出后暂存应清空')
})

test('slash/workflow 入口（submitText）同样带走暂存附件——附件必达不变量', async () => {
  const { app, stdin } = makeApp()
  const sent: Array<{ text: string; images?: string[] }> = []
  app.onSubmit((text, images) => {
    sent.push(images ? { text, images } : { text })
  })

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()

  app.setInput('忙时带图')
  ;(app as unknown as { inputLine: { addImage(u: string): void } }).inputLine.addImage(PNG_DATA_URL)
  stdin.dataHandler!('\r')
  await tick(40)

  // 回 idle 后走 ecosystem/workflow 入口，而不是打字提交
  ;(app as unknown as { agentBusy: boolean }).agentBusy = false
  app.submitText('workflow prompt')
  await tick(40)

  const last = sent[sent.length - 1]!
  assert.equal(last.text, 'workflow prompt')
  assert.deepEqual(last.images, [PNG_DATA_URL], '暂存附件不得因提交路径不同而滞留')
  assert.equal((app as unknown as { getDeferredImagesCount(): number }).getDeferredImagesCount(), 0)
})

test("连续排队多条带图消息：settle 出队时各自分发专属图片（粒度绑定）", async () => {
  const { app, stdin } = makeApp()
  const sent: Array<{ text: string; images?: string[] }> = []
  app.onSubmit((text, images) => {
    sent.push(images ? { text, images } : { text })
  })

  const IMG_1 = "data:image/png;base64,QUJD"
  const IMG_2 = "data:image/png;base64,REVm"

  app.setInput("task A")
  stdin.dataHandler!("\r")
  await tick()
  assert.equal(app.busy, true)

  // 排队第一条带图消息
  app.setInput("排队消息1")
  ;(app as unknown as { inputLine: { addImage(u: string): void } }).inputLine.addImage(IMG_1)
  stdin.dataHandler!("\r")
  await tick(40)
  assert.equal(app.getDeferredImagesCount(), 1)

  // 排队第二条带图消息
  app.setInput("排队消息2")
  ;(app as unknown as { inputLine: { addImage(u: string): void } }).inputLine.addImage(IMG_2)
  stdin.dataHandler!("\r")
  await tick(40)
  assert.equal(app.getDeferredImagesCount(), 2)

  // 结算 task A → 自动发出排队消息1
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 1, true)
  await tick()
  app.notifyRunSettled()
  await tick(40)

  assert.equal(sent.length, 2)
  assert.equal(sent[1]!.text, "排队消息1")
  assert.deepEqual(sent[1]!.images, [IMG_1], "第一条排队消息只带第一条绑定的图片")
  assert.equal(app.getDeferredImagesCount(), 1, "第二条消息的图片仍在队列中")

  // 结算排队消息1 → 自动发出排队消息2
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 2, true)
  await tick()
  app.notifyRunSettled()
  await tick(40)

  assert.equal(sent.length, 3)
  assert.equal(sent[2]!.text, "排队消息2")
  assert.deepEqual(sent[2]!.images, [IMG_2], "第二条排队消息只带第二条绑定的图片")
  assert.equal(app.getDeferredImagesCount(), 0, "全部发出后暂存清空")
})

test("↑ 键取回排队带图消息：恢复文本同时还原 inputLine 附件图片", async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  const IMG_X = "data:image/png;base64,R0hJ"

  app.setInput("task A")
  stdin.dataHandler!("\r")
  await tick()
  assert.equal(app.busy, true)

  app.setInput("待撤回的带图消息")
  ;(app as unknown as { inputLine: { addImage(u: string): void } }).inputLine.addImage(IMG_X)
  stdin.dataHandler!("\r")
  await tick(40)
  assert.equal(app.getDeferredImagesCount(), 1)

  // 用户按 ↑ 取回
  stdin.dataHandler!("\x1b[A")
  await tick(20)

  assert.equal(app.getInputValue(), "待撤回的带图消息")
  const inputImages = (app as unknown as { inputLine: { images: string[] } }).inputLine.images
  assert.deepEqual(inputImages, [IMG_X], "图片必须还原回 inputLine")
  assert.equal(app.getDeferredImagesCount(), 0, "从队列取出后暂存计数为 0")
})
