/**
 * issue #247 第 1–3 条 — CVM 拦截提示的 TUI 接线防回归。
 *
 * 覆盖两层：
 *  #A `TuiApp.callbacks.onCvmInterception` → `commitStatic` → 主屏 scrollback。
 *  #B bridge 的世代守卫：旧 run 的迟到通知不得污染新 run 的渲染。
 *
 * 其中「端到端」那条刻意**不 mock 中间层**——用真实的 `emitCvmInterception`
 * 与真实的 `CvmVectorDecision` 走完整条链（分级 → 文案 → 通知 → 渲染），
 * 而不是构造一个手写的 notice 字面量。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { wrapCallbacksWithTuiApp } from '../bridge.js'
import { buildCvmNotice, emitCvmInterception, type CvmInterceptionNotice } from '../../../agent/cvm-notice.js'
import type { CvmVectorDecision } from '../../../agent/hooks/cognitive-capsule-router.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const scrollback = (app: TuiApp) => stripAnsi(app.getScrollbackContent())

const activeIntercept: CvmInterceptionNotice = {
  level: 'intercept', kind: 'verification-debt', ruleId: 'CV1',
  mode: 'active', turn: 9,
  text: '⛨ CVM 拦截：验证债务（CV1） — 已注入纠偏',
}

test('#A 拦截级通知渲染到主屏 scrollback', () => {
  const { app } = makeApp()
  app.callbacks.onCvmInterception?.(activeIntercept)
  const text = scrollback(app)
  assert.ok(text.includes('CVM 拦截'), `拦截级通知必须可见：${text.slice(0, 300)}`)
  assert.ok(text.includes('验证债务'), `类型名必须可见：${text.slice(0, 300)}`)
  assert.ok(text.includes('CV1'), `规则 id 必须可见：${text.slice(0, 300)}`)
})

test('#A 警告级与提示级也渲染（分级只影响默认开关，不影响渲染能力）', () => {
  const { app } = makeApp()
  app.callbacks.onCvmInterception?.({
    level: 'warn', kind: 'perspective-locked', ruleId: 'CV2', mode: 'active', turn: 9,
    text: '⛨ CVM 警告：视角锁定（CV2） — 命中但已让位给其他机制',
  })
  app.callbacks.onCvmInterception?.({
    level: 'info', kind: 'gate-blocked', ruleId: null, mode: 'shadow', turn: 9,
    text: '⛨ CVM 提示：门禁让位 — 已记台账，未发声',
  })
  const text = scrollback(app)
  assert.ok(text.includes('CVM 警告'), text.slice(0, 300))
  assert.ok(text.includes('CVM 提示'), text.slice(0, 300))
})

test('#A 端到端（不 mock 中间层）：真实 decision → 分级 → 文案 → 渲染', () => {
  const { app } = makeApp()
  const decision: CvmVectorDecision = {
    classification: { kind: 'verification-debt', ruleId: 'CV1', facts: { turn: 12 } },
    candidate: {
      ruleId: 'CV1', star: '天权',
      entry: { key: 'cvm-vector-天权-CV1', priority: 0.5, category: 'star_domain', content: '改了文件但交付未验证', ttl: 1 },
    },
    yielded: null,
  }
  const counted: string[] = []
  emitCvmInterception(
    { recordCvmInterception: k => { counted.push(k) } },
    app.callbacks,
    decision, 'active', 12,
  )
  const text = scrollback(app)
  assert.deepEqual(counted, ['verification-debt'], '台账计数必须发生')
  assert.ok(text.includes('CVM 拦截：验证债务（CV1）'), `端到端文案：${text.slice(0, 300)}`)
  assert.ok(text.includes('已注入纠偏'), `端到端应保留 active 措辞：${text.slice(0, 300)}`)
})

test('#A shadow 下渲染出的文案不得含「已注入 / 已阻止」', () => {
  const { app } = makeApp()
  const decision: CvmVectorDecision = {
    classification: { kind: 'verification-debt', ruleId: 'CV1', facts: { turn: 12 } },
    candidate: {
      ruleId: 'CV1', star: '天权',
      entry: { key: 'cvm-vector-天权-CV1', priority: 0.5, category: 'star_domain', content: 'x', ttl: 1 },
    },
    yielded: null,
  }
  const notice = buildCvmNotice(decision, 'shadow', 12)!
  app.callbacks.onCvmInterception?.(notice)
  const text = scrollback(app)
  assert.ok(!text.includes('已注入'), `shadow 不得说已注入：${text.slice(0, 300)}`)
  assert.ok(!text.includes('已阻止'), `shadow 不得说已阻止：${text.slice(0, 300)}`)
  assert.ok(text.includes('未注入'), `shadow 应显式说明：${text.slice(0, 300)}`)
})

test('#B 世代守卫：旧 run 的迟到 CVM 通知被丢弃', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起不结束 */ })

  app.setInput('A')
  stdin.dataHandler!('\r')
  await tick()
  // 本次 run 开始 → main-ansi 会 wrap 一组回调（捕获本轮世代）
  const liveCallbacks = wrapCallbacksWithTuiApp(app)
  liveCallbacks.onCvmInterception?.(activeIntercept)
  assert.ok(scrollback(app).includes('CVM 拦截'), '活跃世代必须渲染（否则下面的丢弃断言无意义）')

  // 用户中止 → runGen 自增，这一组回调成为旧世代
  stdin.dataHandler!('\x03')
  await tick()

  const before = scrollback(app)
  liveCallbacks.onCvmInterception?.({
    ...activeIntercept, text: '⛨ CVM 拦截：攻坚停滞（CV3） — 已注入纠偏',
  })
  assert.equal(scrollback(app), before, '旧世代的迟到通知不得写入新 run 的 scrollback')
  assert.ok(!scrollback(app).includes('攻坚停滞'), '旧世代通知内容不得出现')
})

// ── Wave 3：窗口聚合的 app 层接线 ────────────────────────────────
// 纯函数层已在 src/tui/__tests__/cvm-notice-coalescer.test.ts 覆盖；
// 这里只验「接线对不对」——push 走不走聚合器、flush 补不补得出来。

test('#C 窗口内同类只渲染一行；flush 到期后补 ×N（issue #247 第 3 条）', () => {
  const { app } = makeApp()
  const at = (turn: number) => ({ ...activeIntercept, turn })
  app.callbacks.onCvmInterception?.(at(1))
  app.callbacks.onCvmInterception?.(at(2))
  app.callbacks.onCvmInterception?.(at(3))

  const during = scrollback(app)
  assert.equal((during.match(/CVM 拦截/g) ?? []).length, 1,
    `窗口内三条同类只应渲染一行：${during.slice(0, 400)}`)
  assert.ok(!during.includes('×'), `窗口未到期不得出现 ×N：${during.slice(0, 400)}`)

  app.flushCvmNotices(Date.now() + 60_000)

  const after = scrollback(app)
  assert.equal((after.match(/CVM 拦截/g) ?? []).length, 2,
    `flush 后应补出合并行：${after.slice(0, 400)}`)
  assert.ok(after.includes('CVM 拦截 ×3：验证债务'), `合并行文案：${after.slice(0, 400)}`)
})

test('#C flush 未到期时不补发（不能变成「每条都补」的放大镜）', () => {
  const { app } = makeApp()
  app.callbacks.onCvmInterception?.({ ...activeIntercept, turn: 1 })
  app.callbacks.onCvmInterception?.({ ...activeIntercept, turn: 2 })
  const before = scrollback(app)

  app.flushCvmNotices(Date.now())   // 窗口刚开始
  assert.equal(scrollback(app), before, '未到期 flush 不得产生任何新行')
})

test('#C 重设窗口后，旧在途窗口被丢弃（不跨新旧窗口混算 ×N）', () => {
  const { app } = makeApp()
  app.callbacks.onCvmInterception?.({ ...activeIntercept, turn: 1 })
  app.callbacks.onCvmInterception?.({ ...activeIntercept, turn: 2 })

  app.setCvmNoticeWindowMs(1000)
  app.flushCvmNotices(Date.now() + 60_000)
  const after = scrollback(app)
  assert.ok(!after.includes('×2'), `重设窗口前积累的计数必须丢弃：${after.slice(0, 400)}`)

  // 新窗口重新计
  app.callbacks.onCvmInterception?.({ ...activeIntercept, turn: 3 })
  assert.ok(!scrollback(app).includes('×'), '新窗口首条不带 ×N')
})
