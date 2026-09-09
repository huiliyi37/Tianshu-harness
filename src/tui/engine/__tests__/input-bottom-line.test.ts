/**
 * T9 输入框贴底测试（问题2 回归）：
 *
 * 契约：输入框（topBorder + inputLines + botBorder）必须是 live region 渲染帧
 * 的**最后一行**——滚动到底时输入框极限位置在界面最下方（Claude Code 风格）。
 * 状态行（metrics + 权限模式）、slash 提示、文件补全等辅助行全部在输入框上方。
 *
 * RED 基线：修复前输入框 botBorder 之后仍渲染状态行（`test ⚡- 0s ... ⏵ auto-safe`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'

const tick = () => new Promise(r => setTimeout(r, 20))

/** 取最近一帧的纯文本行序列（strip ANSI、去空行）。 */
function lastFrameLines(out: { chunks: string[] }): string[] {
  const last = out.chunks[out.chunks.length - 1] ?? ''
  return stripAnsi(last).split('\n').filter(l => l.trim() !== '')
}

test('输入框（botBorder）应为渲染帧最后一行：其后无状态行/提示行', async () => {
  const { app, out, stdin } = makeApp({ rows: 24 })
  app.onSubmit(() => {})

  // 触发渲染：提交一条消息
  app.setInput('hello')
  stdin.dataHandler!('\r')
  await tick()

  const lines = lastFrameLines(out)
  // 输入框底边框（thick/dots 主题用 ╰，thin 用 └）
  const botIdx = lines.findIndex(l => /^[╰└]/.test(l))
  assert.ok(botIdx >= 0, `应能找到输入框 botBorder，帧行: ${lines.join(' | ')}`)
  const afterBot = lines.slice(botIdx + 1)
  assert.equal(
    afterBot.length,
    0,
    `输入框之后不应有其他行（状态行等应在输入框上方），实际: ${afterBot.join(' | ')}`,
  )
})

test('状态行（metrics/权限模式）位于输入框上方', async () => {
  const { app, out, stdin } = makeApp({ rows: 24 })
  app.onSubmit(() => {})

  app.setInput('hello')
  stdin.dataHandler!('\r')
  await tick()

  const lines = lastFrameLines(out)
  const botIdx = lines.findIndex(l => /^[╰└]/.test(l))
  assert.ok(botIdx >= 0)
  // 状态行特征：权限模式（auto-safe / plan / ask）在输入框上方
  const permIdx = lines.findIndex(l => l.includes('自动') || l.includes('监督') || l.includes('全自动') || l.includes('plan') || l.includes('ask'))
  if (permIdx >= 0) {
    assert.ok(permIdx < botIdx, `状态行（行 ${permIdx}）应在输入框（行 ${botIdx}）上方`)
  }
  // metrics 特征：⚡（effort）或模型名
  const metricsIdx = lines.findIndex(l => l.includes('⚡'))
  if (metricsIdx >= 0) {
    assert.ok(metricsIdx < botIdx, `metrics 行（行 ${metricsIdx}）应在输入框（行 ${botIdx}）上方`)
  }
})
