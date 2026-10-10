import { describe, it } from 'node:test'
import assert from 'node:assert'
import { deepseekPricingPhase, nextPricingTransition } from '../pricing-phase.js'

// 全部用固定 UTC 时间戳字面量（ISO Z 后缀），与宿主时区无关。
// 2026-09-07 = 周一；2026-09-04 = 周五；2026-09-05/06 = 周六/日。
// 北京时间 = UTC + 8h，故北京 09:00 ↔ UTC 01:00。
const utc = (iso: string): number => Date.parse(`${iso}Z`)
const HOUR = 3_600_000

describe('deepseekPricingPhase（北京时间工作日 9-12 / 14-18 为峰时）', () => {
  it('峰时窗口边界左闭右开：08:59/09:00、11:59/12:00', () => {
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T00:59:00')), 'offpeak') // 北京 08:59
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T01:00:00')), 'peak')    // 北京 09:00
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T03:59:00')), 'peak')    // 北京 11:59
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T04:00:00')), 'offpeak') // 北京 12:00
  })

  it('午后窗口边界：13:59/14:00、17:59/18:00', () => {
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T05:59:00')), 'offpeak') // 北京 13:59
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T06:00:00')), 'peak')    // 北京 14:00
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T09:59:00')), 'peak')    // 北京 17:59
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T10:00:00')), 'offpeak') // 北京 18:00
  })

  it('周末全天闲时（含工作日窗口时段）', () => {
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-05T01:00:00')), 'offpeak') // 周六 09:00
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-06T06:00:00')), 'offpeak') // 周日 14:00
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-06T15:00:00')), 'offpeak') // 周日 23:00
  })

  it('weekday 归属按北京日：UTC 周日深夜已是北京周一', () => {
    // UTC 2026-09-06 17:00 = 北京周一 2026-09-07 01:00（闲时）
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-06T17:00:00')), 'offpeak')
    // UTC 2026-09-07 16:00 = 北京周二 00:00（跨日翻转后仍属工作日闲时）
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T16:00:00')), 'offpeak')
    // UTC 2026-09-04 16:00 = 北京周六 00:00 → 闲时（UTC 日还是周五，北京已入周末）
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-04T16:00:00')), 'offpeak')
    // UTC 2026-09-06 16:30 = 北京周一 00:30 → 工作日闲时（UTC 日还是周日）
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-06T16:30:00')), 'offpeak')
  })

  it('法定节假日峰窗时段也闲时；调休补班日（周六）天然闲时；收假即恢复', () => {
    // 2026 国务院安排：国庆 10-01~10-07，春节 02-15~02-23（调休补班 02-14/02-28 均为周六）
    assert.strictEqual(deepseekPricingPhase(utc('2026-10-01T02:00:00')), 'offpeak') // 国庆周四 10:00——节假日覆盖工作日峰窗
    assert.strictEqual(deepseekPricingPhase(utc('2026-10-07T06:00:00')), 'offpeak') // 假期末日周三 14:00
    assert.strictEqual(deepseekPricingPhase(utc('2026-02-17T02:00:00')), 'offpeak') // 春节初一周二 10:00
    assert.strictEqual(deepseekPricingPhase(utc('2026-02-14T02:00:00')), 'offpeak') // 调休补班周六 10:00——周末规则已覆盖
    assert.strictEqual(deepseekPricingPhase(utc('2026-10-08T01:00:00')), 'peak')    // 10-08 周四 09:00 收假恢复峰时
  })

  it('宿主时区无关：TZ=America/New_York 下结果一致', () => {
    process.env.TZ = 'America/New_York'
    // 确认 TZ 真的生效（本地小时偏移），否则本测试没有证明力
    assert.strictEqual(new Date(utc('2026-09-07T01:00:00')).getHours(), 21)
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T01:00:00')), 'peak')
    assert.strictEqual(deepseekPricingPhase(utc('2026-09-07T10:00:00')), 'offpeak')
    process.env.TZ = ''
  })
})

describe('nextPricingTransition（倒计时）', () => {
  it('峰时内 → 最近的窗口结束', () => {
    // 北京周一 10:00 → 12:00 转闲
    const t = nextPricingTransition(utc('2026-09-07T02:00:00'))
    assert.strictEqual(t.to, 'offpeak')
    assert.strictEqual(t.inMs, 2 * HOUR)
  })

  it('午间闲时 → 14:00 转峰', () => {
    const t = nextPricingTransition(utc('2026-09-07T04:00:00')) // 北京 12:00
    assert.strictEqual(t.to, 'peak')
    assert.strictEqual(t.inMs, 2 * HOUR)
  })

  it('早间闲时 → 9:00 转峰', () => {
    const t = nextPricingTransition(utc('2026-09-07T00:00:00')) // 北京 08:00
    assert.strictEqual(t.to, 'peak')
    assert.strictEqual(t.inMs, 1 * HOUR)
  })

  it('周五 18:00 → 跨周末到周一 9:00（63 小时）', () => {
    const t = nextPricingTransition(utc('2026-09-04T10:00:00')) // 北京周五 18:00
    assert.strictEqual(t.to, 'peak')
    assert.strictEqual(t.inMs, 63 * HOUR)
  })

  it('周六上午 → 周一 9:00（47 小时），中间周末边界不产生切换', () => {
    const t = nextPricingTransition(utc('2026-09-05T02:00:00')) // 北京周六 10:00
    assert.strictEqual(t.to, 'peak')
    assert.strictEqual(t.inMs, 47 * HOUR)
  })

  it('边界瞬间（北京 18:00:00）已属闲时，下一跳是次日 9:00', () => {
    const t = nextPricingTransition(utc('2026-09-07T10:00:00')) // 北京周一 18:00 整
    assert.strictEqual(t.to, 'peak')
    assert.strictEqual(t.inMs, 15 * HOUR) // 周一 18:00 → 周二 9:00
  })

  it('跨长假：假前峰尾 → 收假首个工作日 9:00', () => {
    // 北京 2026-09-30 周三 18:00 → 2026-10-08 周四 09:00（183h）
    const national = nextPricingTransition(utc('2026-09-30T10:00:00'))
    assert.strictEqual(national.to, 'peak')
    assert.strictEqual(national.inMs, 183 * HOUR)
    // 北京 2026-02-13 周五 18:00 → 2026-02-24 周二 09:00（255h，跨 9 天春节假 + 调休周末）
    const cny = nextPricingTransition(utc('2026-02-13T10:00:00'))
    assert.strictEqual(cny.to, 'peak')
    assert.strictEqual(cny.inMs, 255 * HOUR)
  })
})
