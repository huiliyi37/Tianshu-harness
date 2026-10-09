/**
 * T9 用户消息提交路径回归测试（Phase 6）。
 *
 * 验证三条 submit 路径均能生成 scrollback 中的用户气泡：
 *   1. Idle 路径：agent 空闲时发消息
 *   2. Steer 路径：agent 执行中发消息
 *   3. Slash passthrough 路径：/review 等命令透传给 agent
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

/** 检查 scrollback 包含指定文本（忽略 ANSI 转义码干扰）。
 *  CC 对标重构（f9001b16）后用户气泡去掉 "You" 标签，改用 ❯/▌ 标记（formatUserMessage）。 */
function hasUserBubbleFor(scrollback: string, text: string): boolean {
  return /[>❯▌]/.test(scrollback) && scrollback.includes(text)
}

// ── 路径 1: Idle submit ────────────────────────────────────────

test('idle 路径：空闲时提交 → scrollback 包含用户气泡', async () => {
  const { app, stdin } = makeApp()
  let passed: string | null = null
  app.onSubmit((t) => { passed = t })

  app.setInput('hello from idle')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(passed, 'hello from idle', '应透传给 agent')
  const sb = app.getScrollbackContent()
  assert.ok(hasUserBubbleFor(sb, 'hello from idle'), 'scrollback 应包含用户消息')
})

// ── 路径 2: Steer 路径（agent 执行中） ─────────────────────────

test('steer 路径：agent 执行中提交 → scrollback 立即包含用户气泡', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // 发起第一个 run，使 agentBusy = true
  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true)

  // agent 执行中再发消息 → steer 路径
  app.setInput('note during busy')
  stdin.dataHandler!('\r')
  await tick()

  // steer 路径应已将用户气泡 commit 到 scrollback
  const sb = app.getScrollbackContent()
  assert.ok(hasUserBubbleFor(sb, 'note during busy'), 'steer 路径应立即 commit 用户气泡')

  // 确认 steerBuffer 中有排队消息
  assert.ok(app.steerBuffer.hasPending(), '消息应在 steer buffer 中排队')
})

// ── 路径 3: Slash passthrough ──────────────────────────────────

test('slash passthrough 路径：透传命令 → scrollback 包含用户原始输入', async () => {
  const { app, stdin } = makeApp()
  let passed: string | null = null
  app.onSubmit((t) => { passed = t })
  app.setSlashHandler(async () => false) // 透传，如 /team

  // 用 /team 而非 /review — 单测只覆盖 TuiApp 层，main 层 resolveAppPromptInput
  // 会为 /review 返回 null 并 rejectSubmit，行为不同于此单测预期。
  app.setInput('/team plan.md')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(passed, '/team plan.md', '应透传给 agent')
  const sb = app.getScrollbackContent()
  assert.ok(hasUserBubbleFor(sb, '/team plan.md'), 'slash 透传也应 commit 用户气泡')
})

// ── 边界：steer 合并后不重复 commit ────────────────────────────

test('steer 归并后：不重复生成用户气泡', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // run A: busy 时排队一条消息
  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('note 1')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(app.steerBuffer.hasPending())

  // 结束 run A → busy 复位
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()
  assert.equal(app.busy, false)

  // run B: 残留 steer 归并
  app.setInput('task B')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(runs.length, 2)
  assert.equal(runs[1], 'note 1\n\ntask B', '归并到新 prompt')

  // scrollback 应有 note 1 的独立气泡（steer 路径已 commit）+ task A 的气泡
  // + merge note + task B(merged) — 由于 steerMerged=true，不重复 commit 合并气泡
  const sb = app.getScrollbackContent()
  // note 1 在 steer 路径中已单独 commit
  assert.ok(hasUserBubbleFor(sb, 'note 1'), 'steer 路径的 note 1 应有独立气泡')
  // task B 是合并提交（steerMerged），不 commit 用户气泡
  const bubbleCount = (sb.match(/[>❯▌]/g) ?? []).length
  // task A 1个 + note 1 1个 = 2个气泡标记，不应有第 3 个（task B merged bubble）
  assert.equal(bubbleCount, 2, `应为 2 个用户气泡（task A + note 1），实际 ${bubbleCount}`)
})

// ── rejectSubmit：main 层 resolve null 时清 busy ─────────────────

test('rejectSubmit 撤销 passthrough 设置的 agentBusy', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})
  app.setSlashHandler(async () => false)

  app.setInput('/typo-slash')
  stdin.dataHandler!('\r')
  await tick()

  assert.equal(app.busy, true, 'slash passthrough 应先置 busy')
  app.rejectSubmit()
  assert.equal(app.busy, false, 'rejectSubmit 应清 busy')
})
