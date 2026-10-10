import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scaledThreshold, isB2ConvergingRecently } from '../window-thresholds.js'

describe('scaledThreshold — 上下文窗口感知的提醒阈值', () => {
  it('200K 及以下返回 200K 基准值（旧行为）', () => {
    assert.equal(scaledThreshold(200_000, 12, 28), 12)
    assert.equal(scaledThreshold(128_000, 12, 28), 12)
    assert.equal(scaledThreshold(0, 12, 28), 12)
  })

  it('1M 及以上返回 1M 目标值', () => {
    assert.equal(scaledThreshold(1_000_000, 12, 28), 28)
    assert.equal(scaledThreshold(2_000_000, 12, 28), 28)
  })

  it('中间窗口线性插值并取整', () => {
    // 600K = 200K 与 1M 的中点 → (12+28)/2 = 20
    assert.equal(scaledThreshold(600_000, 12, 28), 20)
    // 400K = 1/4 处 → 12 + 16*0.25 = 16
    assert.equal(scaledThreshold(400_000, 12, 28), 16)
    // 800K = 3/4 处 → 12 + 16*0.75 = 24
    assert.equal(scaledThreshold(800_000, 12, 28), 24)
  })

  it('B1/回归空转使用各自基准对（4→9、5→12）', () => {
    assert.equal(scaledThreshold(200_000, 4, 9), 4)
    assert.equal(scaledThreshold(1_000_000, 4, 9), 9)
    assert.equal(scaledThreshold(1_000_000, 5, 12), 12)
    // 600K 中点
    assert.equal(scaledThreshold(600_000, 4, 9), 7) // round(6.5)
    assert.equal(scaledThreshold(600_000, 5, 12), 9) // round(8.5)
  })
})

describe('isB2ConvergingRecently — B2 收敛轨迹门（会话 506a5e86 优化）', () => {
  it('冷启动：空轨迹或样本不足 → false（保守照发，旧行为）', () => {
    assert.equal(isB2ConvergingRecently([]), false)
    assert.equal(isB2ConvergingRecently([0.9]), false)
  })

  it('最近样本均值 ≥ 0.6 → true（轨迹收敛，静默；bar 对齐 detector L1 线）', () => {
    // [0.9, 0.5] → avg 0.7
    assert.equal(isB2ConvergingRecently([0.9, 0.5]), true)
    // [0.5, 0.7] → avg 0.6 恰过线（含等号边界）
    assert.equal(isB2ConvergingRecently([0.5, 0.7]), true)
    // 持续收敛
    assert.equal(isB2ConvergingRecently([0.9, 0.8, 0.7]), true)
  })

  it('均值 < 0.6 → false（轨迹发散，照发；含旧 bar=0.4 的回退保护）', () => {
    assert.equal(isB2ConvergingRecently([0.2, 0.3, 0.2]), false)
    // avg 0.5 落在 0.4-0.6 疑似区：当前 bar 下不静默。若 bar 被回退到 0.4，
    // 本断言变 true → 红——其余默认参数用例在 0.4/0.6 下同绿（抓不住回退），
    // 本条是 bar 标定的唯一直接保护；行为契约面由 b2-mode 用例兜底。
    assert.equal(isB2ConvergingRecently([0.5, 0.5]), false)
  })

  it('只看最近 window=3 个样本：旧高分不掩盖最近转坏', () => {
    // 前两个 0.9/0.8 是旧高分，最近三个全 0.2 → 照发
    assert.equal(isB2ConvergingRecently([0.9, 0.8, 0.2, 0.2, 0.2]), false)
  })

  it('自定义 window/minSamples/bar 参数生效', () => {
    // window=2：只看最近两个 [0.3, 0.3] → 发散
    assert.equal(isB2ConvergingRecently([0.9, 0.3, 0.3], 2, 2, 0.4), false)
    // bar=0.8：[0.5, 0.5, 0.5] avg 0.5 < 0.8 → 照发
    assert.equal(isB2ConvergingRecently([0.5, 0.5, 0.5], 2, 3, 0.8), false)
    // minSamples=4：3 样本不足 → 照发
    assert.equal(isB2ConvergingRecently([0.9, 0.9, 0.9], 4, 3, 0.4), false)
  })

  it('P3 口径切片：同 regime 才累计；混合口径不足不静默（保守照发）', () => {
    const ok = (score: number, regimeKey: string) => ({ score, regimeKey, quality: 'ok' as const })
    const insufficient = (score: number, regimeKey: string) => ({ score, regimeKey, quality: 'insufficient' as const })
    // 尾部同口径 2 条高分 → 静默（同 regime 段达 minSamples）
    assert.equal(isB2ConvergingRecently([ok(0.9, 'a'), ok(0.8, 'a')]), true)
    // 尾部同口径仅 1 条（前两条属另一 regime）→ 不足，照发（不得凭混合旧分数静默）
    assert.equal(isB2ConvergingRecently([ok(0.9, 'a'), ok(0.9, 'a'), ok(0.9, 'b')]), false)
    // 尾部 insufficient（无证据）→ 不静默
    assert.equal(isB2ConvergingRecently([ok(0.9, 'a'), insufficient(0.9, 'a')]), false)
  })
})
