import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeScoreDecline,
  buildRegimeKey,
  normalizeScoreHistory,
  tailAlignedScores,
  type ConvergenceScoreSample,
} from '../score-history.js'

const ok = (score: number, regimeKey: string | null = null): ConvergenceScoreSample =>
  ({ score, regimeKey, quality: 'ok' })
const insuff = (score: number, regimeKey: string | null = null): ConvergenceScoreSample =>
  ({ score, regimeKey, quality: 'insufficient' })

describe('score-history — P3 分数历史口径', () => {
  it('buildRegimeKey 由 taskEpoch/stageEpoch/编辑期待唯一决定（缺期待 = none，不冒充 required）', () => {
    assert.equal(buildRegimeKey({ taskEpoch: 1, stageEpoch: 3, editExpectationKind: 'required' }), '1:3:required')
    assert.equal(buildRegimeKey({ taskEpoch: 0, stageEpoch: 0, editExpectationKind: null }), '0:0:none')
  })

  it('normalizeScoreHistory：legacy number → 无口径样本；对象样本原样保留', () => {
    assert.deepEqual(normalizeScoreHistory([0.5, ok(0.4, 'k')]), [
      { score: 0.5, regimeKey: null, quality: 'ok' },
      { score: 0.4, regimeKey: 'k', quality: 'ok' },
    ])
  })

  it('tailAlignedScores：legacy 段 == slice(-window)（向后兼容逐位不变）', () => {
    assert.deepEqual(tailAlignedScores([0.5, 0.4, 0.3, 0.2], 3), [0.4, 0.3, 0.2])
    assert.deepEqual(tailAlignedScores([0.9, 0.5], 3), [0.9, 0.5])
    assert.deepEqual(tailAlignedScores([], 3), [])
  })

  it('tailAlignedScores：regime 切换切断——只取尾部连续段', () => {
    const h = [ok(0.5, 'a'), ok(0.4, 'a'), ok(0.9, 'b'), ok(0.8, 'b')]
    assert.deepEqual(tailAlignedScores(h, 6), [0.9, 0.8])
  })

  it('tailAlignedScores：legacy 与具名 regime 互不匹配（尾部 legacy 只取 legacy 段）', () => {
    assert.deepEqual(tailAlignedScores([0.5, ok(0.9, 'b')], 6), [0.9])
    assert.deepEqual(tailAlignedScores([ok(0.9, 'b'), 0.5, 0.4], 6), [0.5, 0.4])
  })

  it('tailAlignedScores：insufficient 样本在尾部即截止（无证据不充当证据）', () => {
    assert.deepEqual(tailAlignedScores([ok(0.5, 'a'), insuff(0.4, 'a')], 6), [])
    assert.deepEqual(tailAlignedScores([insuff(0.5)], 6), [])
  })

  it('analyzeScoreDecline：同口径持续下降（含至多 1 次微反弹）→ declining', () => {
    assert.deepEqual(analyzeScoreDecline([0.50, 0.40, 0.30, 0.20, 0.10, 0.04], 6), { declining: true, sampleCount: 6 })
    assert.deepEqual(analyzeScoreDecline([0.80, 0.70, 0.75, 0.50, 0.30, 0.10], 6), { declining: true, sampleCount: 6 })
  })

  it('analyzeScoreDecline：混合口径旧分数不构成下降证据（同口径不足不燃）', () => {
    const h = [
      ok(0.9, '1:1:required'), ok(0.8, '1:1:required'), ok(0.7, '1:1:required'), ok(0.6, '1:1:required'),
      ok(0.05, '2:0:required'), ok(0.04, '2:0:required'),
    ]
    const r = analyzeScoreDecline(h, 6)
    assert.equal(r.declining, false)
    assert.equal(r.sampleCount, 2)
  })

  it('analyzeScoreDecline：两次反弹 / 末值≥首值 / 长度不足 → 不燃', () => {
    assert.equal(analyzeScoreDecline([0.8, 0.2, 0.5, 0.3, 0.7, 0.2], 6).declining, false) // 2 次反弹
    assert.equal(analyzeScoreDecline([0.5, 0.4, 0.3, 0.2, 0.1, 0.5], 6).declining, false) // 末值 ≥ 首值
    assert.equal(analyzeScoreDecline([0.1, 0.05], 6).declining, false) // 不足
  })

  it('analyzeScoreDecline：尾部 insufficient 截断历史 → 不燃、样本数为 0', () => {
    const h = [0.50, 0.40, 0.30, 0.20, 0.10, insuff(0.04)]
    const r = analyzeScoreDecline(h, 6)
    assert.equal(r.declining, false)
    assert.equal(r.sampleCount, 0)
  })
})
