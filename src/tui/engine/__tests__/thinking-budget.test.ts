/**
 * 小屏推理区预算（2026-09-11 用户反馈：矮终端里「回复被顶到上一屏」）。
 *
 * 现场：rows=10/12 时 live 高水位被 thinking 段 + 流式尾部吃满视口
 * （rows=12 实测峰值 11/12），跨轮不缩 → 历史（含刚发生的回复）常只剩 1 行可见。
 *
 * 契约：
 *  a. 小屏（rows<=16）流式期（phase=streaming）推理压到 1 行——空间还给回复；
 *  b. 小屏非流式期推理下限 2 行（原 3）——矮屏再省一行；
 *  c. 大屏（rows>=18，floor(rows/6)>=3）完全不变——零回归。
 *
 * 断言全部同步（直接调 thinkingRowBudget / getThinkingLines）——不依赖渲染帧
 * 时序（实测合成高度对负载/ticker 的 ±1 行抖动敏感，全量并发下不可靠）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'

const budgetOf = (app: unknown): number =>
  (app as { thinkingRowBudget: () => number }).thinkingRowBudget()

interface ProbeState { phase: string; thinkingText: string; thinkStartMs: number }

const stateOf = (app: unknown): ProbeState =>
  (app as { state: ProbeState }).state

const thinkingLines = (app: unknown): string[] =>
  (app as { getThinkingLines: (e: boolean) => string[] }).getThinkingLines(true)

test('小屏 + 流式期：推理预算压到 1 行（空间还给回复）', () => {
  const { app } = makeApp({ cols: 60, rows: 12, autoStart: false })
  stateOf(app).phase = 'streaming'
  assert.equal(budgetOf(app), 1)
})

test('小屏 + 非流式期：预算下限 2（原 3）', () => {
  const { app } = makeApp({ cols: 60, rows: 12, autoStart: false })
  stateOf(app).phase = 'thinking'
  assert.equal(budgetOf(app), 2)
  const { app: app10 } = makeApp({ cols: 60, rows: 10, autoStart: false })
  stateOf(app10).phase = 'thinking'
  assert.equal(budgetOf(app10), 2)
})

test('大屏完全不变：rows=24 各相位都是 4', () => {
  const { app } = makeApp({ cols: 60, rows: 24, autoStart: false })
  stateOf(app).phase = 'thinking'
  assert.equal(budgetOf(app), 4)
  stateOf(app).phase = 'streaming'
  assert.equal(budgetOf(app), 4, '大屏流式期不压缩')
})

test('流式期推理输出行数 ≤1（同步断言，免疫渲染时序）', () => {
  const { app } = makeApp({ cols: 60, rows: 12, autoStart: false })
  const st = stateOf(app)
  st.thinkingText = Array.from({ length: 10 }, (_, i) => `推理行 ${i}`).join('\n')
  st.thinkStartMs = Date.now()
  st.phase = 'streaming'
  const lines = thinkingLines(app)
  // 行数 = 正文（≤budget）+ 省略标记行（如有省略）；budget=1 → ≤2。
  assert.ok(lines.length <= 2, `小屏流式期推理行数 ${lines.length} 应 ≤2（1 正文 + 省略行；修复前为 4）`)
  assert.ok(lines.length >= 1, '不得为空')
})

test('非流式期推理输出行数 ≤2（小屏）', () => {
  const { app } = makeApp({ cols: 60, rows: 12, autoStart: false })
  const st = stateOf(app)
  st.thinkingText = Array.from({ length: 10 }, (_, i) => `推理行 ${i}`).join('\n')
  st.thinkStartMs = Date.now()
  st.phase = 'thinking'
  const lines = thinkingLines(app)
  assert.ok(lines.length <= 3, `小屏思考期推理行数 ${lines.length} 应 ≤3（2 正文 + 省略行；修复前为 4）`)
  assert.ok(lines.length >= 1, '不得为空')
})

test('大屏流式期推理不被压缩：行数 ≤5', () => {
  const { app } = makeApp({ cols: 60, rows: 24, autoStart: false })
  const st = stateOf(app)
  st.thinkingText = Array.from({ length: 10 }, (_, i) => `推理行 ${i}`).join('\n')
  st.thinkStartMs = Date.now()
  st.phase = 'streaming'
  const lines = thinkingLines(app)
  assert.ok(lines.length <= 5, `大屏推理行数 ${lines.length} 应 ≤5（4 正文 + 省略行）`)
  assert.ok(lines.length >= 3, `大屏不应被小屏逻辑误压：${lines.length}`)
})
