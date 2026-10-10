import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'
/**
 * T9 steer 队列语义：
 *
 * 契约（对齐 Claude Code：普通消息在 AI 输出期间只入队，本轮结束后自动作为下一轮发出）：
 *  1. 工具边界（onHumanGuidanceDrain）不得注入普通排队消息（later 级）——不混进当前轮的
 *     [User guidance]，否则界面显示「已排队」实际已注入，是撒谎。
 *  2. 工具边界仍注入紧急意图（halt=now / redirect=next）。
 *  3. run 正常结束（onTurnComplete isFinal → notifyRunSettled）后，排队内容
 *     自动作为新 run 发出，不回填输入框等用户再按 Enter。
 *     agent.run() 的 finally 可能抢在 isFinal 的 await flush 之前到达，
 *     仍须自动发出（不得因当时仍 busy 而吞掉队列）。
 *  4. 支持多条 FIFO：先发第一条，其余留在队列；下一次 settle 再发下一条。
 *  5. ESC 中断仍回填输入框（用户主动喊停，交还编辑权）。
 *  6. ⏳ 已排队 条贴在输入框上方（chrome），不夹在 thinking 与工具卡之间随输出跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn, stripAnsi, makeApp as makeHarnessApp } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

function lastFrameLines(out: { chunks: string[] }): string[] {
  const last = out.chunks[out.chunks.length - 1] ?? ''
  return stripAnsi(last).split('\n').filter(l => l.trim() !== '')
}

/** 在最近若干帧里从新到旧找第一个满足条件的帧。
 *  MockOut 是行级 diff 写入流——单帧只含**变化**的行，未变化的行（如排队条）
 *  在后续帧里缺席，所以「最后一帧」不等于「当前屏幕完整内容」。 */
function findFrame(
  out: { chunks: string[] },
  pred: (lines: string[]) => boolean,
  lookback = 40,
): string[] | null {
  const from = Math.max(0, out.chunks.length - lookback)
  for (let i = out.chunks.length - 1; i >= from; i--) {
    const lines = stripAnsi(out.chunks[i] ?? '').split('\n').filter(l => l.trim() !== '')
    if (pred(lines)) return lines
  }
  return null
}

/** 轮询等待出现满足条件的帧（默认 1s 上限，超时返回最后一帧供失败信息使用）。 */
async function waitForFrame(
  out: { chunks: string[] },
  pred: (lines: string[]) => boolean,
  timeoutMs = 1_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = findFrame(out, pred)
    if (hit) return hit
    if (Date.now() >= deadline) return lastFrameLines(out)
    await new Promise(r => setTimeout(r, 10))
  }
}

// ── 契约 1: 工具边界不注入普通排队消息 ─────────────────────────

test('工具边界不注入普通排队消息：later 级消息保持排队', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true, '前置：agentBusy 应为 true')

  app.setInput('note during busy')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(app.steerBuffer.hasPending(), '前置：消息应在 steer buffer 中排队')

  // 0c8840f60：工具边界迁移至 onHumanGuidanceDrain（drainHuman）；旧键不再挂载。
  const drained = await app.callbacks.onHumanGuidanceDrain?.() ?? null

  assert.equal(drained, null, '普通排队消息不应被格式化为 [User guidance] 注入')
  assert.equal(app.steerBuffer.hasPending(), true, '普通排队消息应留在队列')
})

// ── 契约 2: 紧急意图仍即时注入 ─────────────────────────────────

test('工具边界仍注入紧急意图（halt/redirect 即时 steer 保留）', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()

  app.steerBuffer.pushNow('停')
  assert.ok(app.steerBuffer.hasPending())

  const drained = await app.callbacks.onHumanGuidanceDrain?.() ?? null
  assert.ok(drained !== null, 'halt 应立即注入')
  assert.ok(drained!.text.includes('停'), '注入文本包含 halt 消息')
  assert.equal(app.steerBuffer.hasPending(), false, 'halt 注入后队列应清空')
})

// ── 契约 3: run 正常结束后自动发出 ─────────────────────────────

test('run 正常结束后：排队内容自动作为新 run 发出，不回填输入框', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('全权交由你负责！请你继续推进！')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(app.steerBuffer.hasPending(), '前置：消息应在 steer buffer 中排队')

  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  await tick()
  assert.equal(app.busy, false, '前置：isFinal 后 agentBusy 应为 false')
  app.notifyRunSettled()
  await tick()

  assert.equal(app.getInputValue(), '', '不应回填输入框')
  assert.equal(app.steerBuffer.hasPending(), false, '发出后队列应清空')
  assert.equal(runs.length, 2, '排队内容应自动发起新 run')
  assert.equal(runs[1], '全权交由你负责！请你继续推进！')
  const sb = app.getScrollbackContent()
  assert.equal(sb.includes('拉回输入框'), false, '不应出现回填提示')
})

test('promise settle 抢在 isFinal flush 之前：仍自动发出，不回填', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('全权交由你负责！请你继续推进！')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(app.steerBuffer.hasPending())

  // 生产顺序：onTurnComplete(isFinal) 先 await flush（仍 busy），
  // agent.run() finally 立刻 notifyRunSettled。
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 10 }, 1, true)
  app.notifyRunSettled()
  await tick()

  assert.equal(app.getInputValue(), '', '不应回填输入框')
  assert.equal(app.steerBuffer.hasPending(), false, '发出后队列应清空')
  assert.equal(runs.length, 2, 'finally 抢跑时排队内容仍应自动发出')
  assert.equal(runs[1], '全权交由你负责！请你继续推进！')
})

// ── 契约 4: 多条 FIFO ──────────────────────────────────────────

test('多条排队 FIFO：settle 先发第一条，其余留队等下一轮 settle', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('note 1')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('note 2')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.steerBuffer.getPending().length, 2)

  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 1, true)
  await tick()
  app.notifyRunSettled()
  await tick()

  assert.equal(runs[1], 'note 1', '先发第一条')
  assert.deepEqual([...app.steerBuffer.getPending()], ['note 2'], '第二条留队')
  assert.equal(app.busy, true, '自动发出后应进入新 run')

  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 2, true)
  await tick()
  app.notifyRunSettled()
  await tick()

  assert.equal(runs[2], 'note 2', '下一轮 settle 再发第二条')
  assert.equal(app.steerBuffer.hasPending(), false)
})

// ── 契约 5: ESC 仍回填 ─────────────────────────────────────────

test('ESC abort settle：队列回填输入框，不自动发出', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })
  let agentRunning = false
  app.setAgentRunningProbe(() => agentRunning)

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  agentRunning = true
  app.setInput('note 1')
  stdin.dataHandler!('\r')
  await tick()

  app.callbacks.onAbort()
  await tick()
  agentRunning = false
  app.notifyRunSettled()
  await tick()

  assert.equal(runs.length, 1, 'ESC 后不应自动发出排队内容')
  assert.equal(app.getInputValue(), 'note 1', '应回填输入框交还编辑')
  assert.equal(app.steerBuffer.hasPending(), false)
})

test('自然结束时输入框有草稿：不自动发出，队列保留', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('note 1')
  stdin.dataHandler!('\r')
  await tick()

  app.setInput('草稿')
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 1 }, 1, true)
  await tick()
  app.notifyRunSettled()
  await tick()

  assert.equal(runs.length, 1, '有草稿时不自动发出')
  assert.equal(app.getInputValue(), '草稿')
  assert.deepEqual([...app.steerBuffer.getPending()], ['note 1'])
})

// ── 契约 6: banner 贴输入框 ─────────────────────────────────────

test('⏳ 已排队条贴在输入框上方，不夹在 thinking 与工具卡之间', async () => {
  const { app, out, stdin } = makeHarnessApp({ cols: 80, rows: 24 })
  app.onSubmit(() => {})

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.callbacks.onThinkingDelta('思考中：分析代码结构。\n')
  await tick()
  app.setInput('全权交由你负责！请你继续推进！')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('第二条排队')
  stdin.dataHandler!('\r')
  await tick()
  app.callbacks.onToolUse('t1', 'apply_edit', { path: 'src/a.ts', replacement: 'foo' })
  await tick()

  // 判据要求同一帧内同时含排队条与输入框顶边——位置断言（banner 在输入框上方）
  // 只有在两者同帧时才可判读
  const lines = await waitForFrame(
    out,
    l => l.some(x => x.includes('已排队')) && l.some(x => /^[─━┄-]{3,}/.test(x)),
  )
  const bannerIdx = lines.findIndex(l => l.includes('已排队'))
  // 工具卡样式随主题/版本有 `- Tool` 与 `Tool | ⎿` 两种头，这里只锚定「卡存在」。
  const toolIdx = lines.findIndex(l => /(?:^|\s)-?\s*Tool\b|apply_edit|src\/a\.ts/.test(l))
  const topIdx = lines.findIndex(l => /^[─━┄-]{3,}/.test(l))
  assert.ok(bannerIdx >= 0, `应渲染已排队条，帧: ${lines.join(' | ')}`)
  assert.ok(toolIdx >= 0, `应渲染工具卡，帧: ${lines.join(' | ')}`)
  assert.ok(topIdx >= 0, `应有输入框顶边，帧: ${lines.join(' | ')}`)
  assert.ok(bannerIdx < topIdx, '已排队条应在输入框上方')
  assert.ok(
    lines[bannerIdx]!.includes('全权交由你负责'),
    `预览应是 FIFO 下一条（第一条），帧: ${lines[bannerIdx]}`,
  )
  assert.ok(lines[bannerIdx]!.includes('+1'), `多条应显示 +N，帧: ${lines[bannerIdx]}`)
  if (toolIdx >= 0) {
    assert.ok(
      bannerIdx > toolIdx,
      `已排队条不应夹在工具卡之上（banner=${bannerIdx} tool=${toolIdx}）：${lines.join(' | ')}`,
    )
  }
  assert.ok(
    topIdx - bannerIdx <= 3,
    `已排队条应贴着输入框（gap=${topIdx - bannerIdx}）：${lines.join(' | ')}`,
  )
})

// ── 契约 5: 守护中断语义（watchdog/convergence 均不回填，队列留待提交归并）─
// 注：convergence 不回填是有意契约（/queue 语义，b73da5b67，
// queue-lane.test.ts「守护中断（convergence）settle 不回填」）——convergence
// 引导用户键入 continue，提交时归并排队消息；回填会破坏续跑流程。

test('watchdog 守护中断（自动续跑）：排队消息不回填输入框', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})
  app.setAgentRunningProbe(() => true)

  app.setInput('task A')
  stdin.dataHandler!('\r')
  await tick()
  app.setInput('note during watchdog')
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(app.steerBuffer.hasPending(), '前置：消息应在 steer buffer 中排队')

  app.callbacks.onAbort('watchdog:goal')
  await tick()
  app.notifyRunSettled()
  await tick()

  assert.equal(app.getInputValue(), '', 'watchdog 自动续跑：不得把排队消息拉回输入框打断续跑')
  assert.equal(app.steerBuffer.hasPending(), true, '排队消息保留在队列，随续跑提交归并')
})
