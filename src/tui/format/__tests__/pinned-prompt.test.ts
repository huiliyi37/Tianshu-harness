/**
 * 置顶执行中/上一轮命令行测试（对标 Codex CLI prompt_header 契约）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { formatPinnedPrompt } from '../pinned-prompt.js'
import { getTheme } from '../../theme.js'
import { TuiApp } from '../../engine/app.js'
import { MockOut, MockIn, stripAnsi } from '../../engine/__tests__/_harness.js'

function makeApp() {
  const out = new MockOut(80, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  app.start()
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

test('formatPinnedPrompt: 运行态渲染 [执行中] 高亮标签', () => {
  const theme = getTheme()
  const res = formatPinnedPrompt({
    prompt: 'npm run test:fast',
    status: 'running',
    width: 80,
    theme,
  })
  const plain = stripAnsi(res)
  assert.ok(plain.includes('› [执行中] npm run test:fast'))
})

test('formatPinnedPrompt: 完成态渲染 [上一轮] 弱化标签', () => {
  const theme = getTheme()
  const res = formatPinnedPrompt({
    prompt: 'git status',
    status: 'completed',
    width: 80,
    theme,
  })
  const plain = stripAnsi(res)
  assert.ok(plain.includes('› [上一轮] git status'))
})

test('formatPinnedPrompt: 多行与长内容压缩为空格并自适应截断', () => {
  const theme = getTheme()
  const longPrompt = '第一行指令\\n第二行详细描述\\n第三行说明'
  const res = formatPinnedPrompt({
    prompt: longPrompt,
    status: 'running',
    width: 30,
    theme,
  })
  const plain = stripAnsi(res)
  assert.ok(plain.includes('第一行指令'))
  assert.ok(!plain.includes('第二行'), '只取首行展示')
  assert.ok(plain.endsWith('…') || plain.length <= 30, '超宽需截断')
})

test('TuiApp: 提交后置顶展示 [执行中]，settle 后切换为 [上一轮]', async () => {
  const { app, out, stdin } = makeApp()
  app.onSubmit(() => {})

  app.setInput('优化核心算法')
  stdin.dataHandler!('\r')
  await tick()

  // 提交后处于 running
  let plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('[执行中] 优化核心算法'), '执行中命令应置顶在页面上方')

  out.clear()
  // 模拟轮次完成
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 1, true)
  await tick()
  app.notifyRunSettled()
  await tick()

  // settle 后更新为上一轮
  plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('[上一轮] 优化核心算法'), '结算后置顶提示应更新为 [上一轮]')
})

test("formatPinnedPrompt: 极窄终端（width < 16）退让返回空字符串", () => {
  const theme = getTheme()
  const res = formatPinnedPrompt({ prompt: "hello", status: "running", width: 10, theme })
  assert.equal(res, "")
})

test("TuiApp: 任务抛错 onError 时，置顶提示同步切换为 [上一轮]，不发生死锁", async () => {
  const { app, out, stdin } = makeApp()
  app.onSubmit(() => {})
  app.setInput("失败的任务")
  stdin.dataHandler!("\r")
  await tick()
  let plain = stripAnsi(out.chunks.join(""))
  assert.ok(plain.includes("[执行中] 失败的任务"))
  out.clear()
  app.callbacks.onError(new Error("测试错误"))
  await tick()
  plain = stripAnsi(out.chunks.join(""))
  assert.ok(plain.includes("[上一轮] 失败的任务"), "报错后应正确切回上一轮状态")
  assert.ok(!plain.includes("[执行中] 失败的任务"), "报错后不得死锁在执行中")
})

test("TuiApp: clearScreen 清屏时清空置顶提示", async () => {
  const { app, out, stdin } = makeApp()
  app.onSubmit(() => {})
  app.setInput("已完成指令")
  stdin.dataHandler!("\r")
  await tick()
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 1, true)
  await tick()
  out.clear()
  app.clearScreen()
  await tick()
  const plain = stripAnsi(out.chunks.join(""))
  assert.ok(!plain.includes("[上一轮] 已完成指令"), "清屏后置顶条应被清空")
})
