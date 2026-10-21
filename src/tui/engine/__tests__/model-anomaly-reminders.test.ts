/**
 * 会话内模型异常提醒（dsh 式，2026-10-05）—— TUI 侧呈现。
 *
 * 契约（RED→GREEN）：
 * - final turn 以 stopReason='max_tokens' 收尾 → 落截断提示行（此前完全静默）；
 *   正常收尾不落。呈现对齐 errorRecoveryGuidance 行（commit 流内 muted 行）。
 * - onModelRetry（agent 层重连）→ 静态警告行带类别中文名与等待秒数。
 * - onPhaseChange('model-retry')（provider 层 429/503 退避，已节流）→ 同款静态警告行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'

const tick = () => new Promise(r => setTimeout(r, 30))

test('final turn stopReason=max_tokens → 截断提示行；正常收尾不落', async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)
  out.chunks.length = 0
  app.callbacks.onTurnComplete({}, 1, true, undefined, undefined, 'max_tokens')
  await new Promise(r => setTimeout(r, 100))
  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('token 上限'), `截断提示行必须在场，实得：${committed.slice(-300)}`)
  assert.ok(committed.includes('继续'), '提示必须告诉用户发「继续」可续')
  const previousContent = app.getScrollbackContent()

  out.chunks.length = 0
  app.callbacks.onTurnComplete({}, 2, true)
  await new Promise(r => setTimeout(r, 100))
  assert.ok(!stripAnsi(app.getScrollbackContent().slice(previousContent.length)).includes('token 上限'), '正常收尾不得再次提交截断提示')
})

test('onModelRetry → 静态警告行带类别中文名与等待秒数', async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)
  out.chunks.length = 0
  app.callbacks.onModelRetry?.({ attempt: 1, maxAttempts: 2, category: 'rate_limit', message: '429', nextDelayMs: 5000 })
  await tick()
  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('限流（429）'), `类别中文名必须在场，实得：${committed.slice(-300)}`)
  assert.ok(committed.includes('等待 5s'), '等待秒数必须在场')
  assert.ok(committed.includes('1/2'))
})

test("onPhaseChange('model-retry') → 静态警告行（provider 层退避不再像卡住）", async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)
  out.chunks.length = 0
  app.callbacks.onPhaseChange?.('model-retry', { reason: '限流（429），8s 后重试（1/5）' })
  await tick()
  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('限流（429），8s 后重试（1/5）'), `相位 reason 必须落成警告行，实得：${committed.slice(-300)}`)
})
