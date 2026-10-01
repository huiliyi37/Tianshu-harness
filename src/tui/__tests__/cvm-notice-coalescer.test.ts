/**
 * CVM 拦截提示的同窗口聚合（issue #247 第 3 条）。
 *
 * issue 原话：「同类拦截聚合：同一会话内、默认 5–10 秒窗口内同类拦截合并为一条
 * （如「CVM 拦截 ×3：验证债务」）。窗口可配置，具体取值由实现定。**聚合是降噪，
 * 不是隐藏。**」
 *
 * 契约：
 *  1. 首条**立即**出（不能让用户等窗口关闭才知道拦了一次）。
 *  2. 窗口内同类只累加计数、不重复渲染。
 *  3. 窗口到期补一条 `×N`（N = 窗口内总数）。
 *  4. 跨 kind / 跨级别不合并——「×3」必须真的是同一件事。
 *  5. 聚合器内部**没有定时器**：时间由调用方以 `now` 注入，因此可在测试里
 *     精确推进（照 src/api/openai-client.ts 的 decideStreamHardCap 范式）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CvmNoticeCoalescer } from '../cvm-notice-coalescer.js'
import type { CvmInterceptionNotice } from '../../agent/cvm-notice.js'

const WINDOW = 8000

function notice(over: Partial<CvmInterceptionNotice> = {}): CvmInterceptionNotice {
  return {
    level: 'intercept',
    kind: 'verification-debt',
    ruleId: 'CV1',
    mode: 'active',
    turn: 9,
    text: '⛨ CVM 拦截：验证债务（CV1） — 已注入纠偏',
    ...over,
  }
}

describe('CvmNoticeCoalescer — 首条立即出、窗口内合并、到期补 ×N', () => {
  it('首条立即渲染，count=1（文案不带 ×1）', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    const out = c.push(notice(), 1000)
    assert.ok(out, '首条必须立即出，不能等窗口关闭')
    assert.equal(out!.count, 1)
    assert.ok(!out!.text.includes('×1'), out!.text)
  })

  it('窗口内同类不再渲染，到期补一条 ×3', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    assert.ok(c.push(notice(), 1000))
    assert.equal(c.push(notice(), 2000), null, '窗口内第二条不该立即渲染')
    assert.equal(c.push(notice(), 3000), null, '窗口内第三条同理')
    assert.deepEqual(c.takeDue(5000), [], '窗口未到期不得补发')

    const due = c.takeDue(1000 + WINDOW)
    assert.equal(due.length, 1, '到期应补一条合并行')
    assert.equal(due[0]!.count, 3, 'N 必须等于窗口内总数（不是重复次数）')
    assert.ok(due[0]!.text.includes('CVM 拦截 ×3：验证债务'), due[0]!.text)
  })

  it('窗口到期但只有 1 条时不补发（避免与首条重复）', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    c.push(notice(), 1000)
    assert.deepEqual(c.takeDue(1000 + WINDOW), [], 'count=1 的窗口到期应静默关闭')
  })

  it('跨 kind 不合并；跨级别也不合并', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    const a = c.push(notice({ kind: 'verification-debt' }), 1000)
    const b = c.push(notice({ kind: 'perspective-locked', level: 'warn', ruleId: 'CV2' }), 1000)
    assert.ok(a && b, '不同 kind 各自立即出')
    assert.equal(c.push(notice({ kind: 'verification-debt' }), 1000), null, '同 kind 才合并')
    assert.equal(c.push(notice({ kind: 'perspective-locked', level: 'warn', ruleId: 'CV2' }), 1000), null)

    const due = c.takeDue(1000 + WINDOW)
    assert.equal(due.length, 2, '两个 key 各补一条')
    assert.deepEqual(due.map(d => d.count).sort(), [2, 2])
  })

  it('窗口过期后再来同类 → 开新窗口，立即渲染', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    c.push(notice(), 1000)
    c.takeDue(1000 + WINDOW)
    const again = c.push(notice(), 1000 + WINDOW + 1)
    assert.ok(again, '新窗口的首条仍是立即出')
    assert.equal(again!.count, 1)
  })

  it('takeDue 幂等：同一窗口只补发一次', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    c.push(notice(), 1000)
    c.push(notice(), 1100)
    assert.equal(c.takeDue(9000).length, 1)
    assert.deepEqual(c.takeDue(9001), [], '已补发过的窗口不得重复')
    assert.deepEqual(c.takeDue(99999), [])
  })

  it('窗口边界：now - firstAt 恰好等于 windowMs 即到期（>= 而非 >）', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    c.push(notice(), 1000)
    c.push(notice(), 1001)
    assert.equal(c.takeDue(1000 + WINDOW).length, 1, '边界当刻应到期')
  })

  it('clear() 丢弃在途窗口（会话结束 / 开关切换）', () => {
    const c = new CvmNoticeCoalescer(WINDOW)
    c.push(notice(), 1000)
    c.push(notice(), 1001)
    c.clear()
    assert.deepEqual(c.takeDue(1000 + WINDOW), [], 'clear 后不得再补发')
    // 清空后同 key 重新计窗
    const fresh = c.push(notice(), 2000)
    assert.ok(fresh && fresh.count === 1)
  })

  it('窗口为 0 时退化為「每条都立即出」（不吞任何一条）', () => {
    const c = new CvmNoticeCoalescer(0)
    assert.ok(c.push(notice(), 1000))
    assert.ok(c.push(notice(), 1000), '窗口 0 不应把第二条也吞掉')
  })
})
