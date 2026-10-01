/**
 * ui.cvmNotices / ui.cvmNoticeWindowMs 的 schema 契约（issue #247 第 2–3 条）。
 *
 * ⚠️ 本节刻意避开一个陷阱：`z.object` 默认 **strip** 未知键，所以单看
 * `safeParse({ cvmNotices: 'all' }).success === true` 是**没有判别力**的——
 * 键根本不存在时它也为 true（这正是 `example-config-keys.test.ts` 记录的那类
 * 静默漂移：文档承诺了旋钮、zod 悄悄吃掉、用户改完不生效也不报错）。
 *
 * 因此每条「接受」断言都必须同时验证**解析后字段确实还在**（没被剥掉）；
 * 每条「拒绝」断言则依赖 `success === false`——strip 行为下非法值也会 success，
 * 所以这两类断言都只有真加了键才会通过。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { uiSchema } from '../schema.js'

describe('ui.cvmNotices — 级别开关（issue #247 第 2 条）', () => {
  it('四档取值被接受，且解析后**字段仍在**（不是被 strip 吃掉）', () => {
    for (const value of ['off', 'intercept', 'warn', 'all'] as const) {
      const r = uiSchema.safeParse({ cvmNotices: value })
      assert.equal(r.success, true, `应接受 ${value}`)
      assert.equal(r.data?.cvmNotices, value, `${value} 必须出现在解析结果里（未被 strip）`)
    }
  })

  it('非法档被**拒绝**（strip 行为下不会报错，所以这是一条有判别力的断言）', () => {
    assert.equal(uiSchema.safeParse({ cvmNotices: 'silent' }).success, false)
    assert.equal(uiSchema.safeParse({ cvmNotices: true }).success, false)
    assert.equal(uiSchema.safeParse({ cvmNotices: 'OFF' }).success, false, '大小写敏感')
  })

  it('缺省时是 undefined —— 默认值由消费方给（CVM_NOTICE_GATE_DEFAULT = intercept）', () => {
    const r = uiSchema.safeParse({})
    assert.equal(r.success, true)
    assert.equal(r.data?.cvmNotices, undefined)
  })
})

describe('ui.cvmNoticeWindowMs — 聚合窗口（issue #247 第 3 条）', () => {
  it('正整数被接受且字段仍在', () => {
    const r = uiSchema.safeParse({ cvmNoticeWindowMs: 8000 })
    assert.equal(r.success, true)
    assert.equal(r.data?.cvmNoticeWindowMs, 8000)
  })

  it('0 / 负数 / 小数 / 字符串被拒绝', () => {
    for (const bad of [0, -1, 1.5, '8000'] as const) {
      assert.equal(uiSchema.safeParse({ cvmNoticeWindowMs: bad }).success, false,
        `${JSON.stringify(bad)} 不该被接受`)
    }
  })

  it('缺省时是 undefined —— 默认值由 CVM_NOTICE_WINDOW_MS_DEFAULT 给（8000）', () => {
    const r = uiSchema.safeParse({})
    assert.equal(r.success, true)
    assert.equal(r.data?.cvmNoticeWindowMs, undefined)
  })
})
