/**
 * 上下文窗口感知的提醒阈值（2026-08 用户反馈：1M 窗口下固定轮数提醒太紧）。
 *
 * 背景：B2 轮内调用上限（12 轮）、B1 只读螺旋（4 轮）、回归空转（5 轮）等
 * advisory 阈值在 200K 窗口时代定稿。1M 窗口下"读 12 轮文件"是任务正常形态，
 * 固定阈值导致合法长任务被反复催收敛（会话 b1b4d856 实测 6 条 B2 + 2 条 B1）。
 * convergence-detector 已有 selectTier 窗口缩放（nLow 8→25），advisory 族补上
 * 同一模式：200K 基准值 ↔ 1M 目标值线性插值，200K 及以下行为逐字节不变。
 *
 * ⚠ 交叉引用：convergence-detector.ts 的 selectTier 是同一插值模式的另一实现
 * （返回 maxTurns/nLow/nMid/nHigh/signalWindow 整组）。调整窗口阈值时两处需
 * 同步评估——语义不同（detector 是 score 阶梯，这里是 advisory 触发阈值），
 * 但插值几何相同。
 */

import { tailAlignedScores, type ConvergenceScoreHistoryEntry } from './score-history.js'

/** 200K 与 1M 之间的线性插值（与 convergence-detector selectTier 同构）。 */
export function scaledThreshold(contextWindow: number, at200K: number, at1M: number): number {
  if (contextWindow <= 200_000) return at200K
  if (contextWindow >= 1_000_000) return at1M
  const ratio = (contextWindow - 200_000) / (1_000_000 - 200_000)
  return Math.round(at200K + (at1M - at200K) * ratio)
}

/** B2 轮内调用上限：200K→12，1M→28（用户指定"至少 28 轮"）。 */
export const b2TurnLimitForWindow = (contextWindow: number): number =>
  scaledThreshold(contextWindow, 12, 28)

/** B1 连续只读螺旋：200K→4，1M→9（与 B2 同比例 28/12 ≈ 2.33×）。 */
export const b1ReadOnlyLimitForWindow = (contextWindow: number): number =>
  scaledThreshold(contextWindow, 4, 9)

/** 回归空转断路器：200K→5，1M→12（与 B2 同比例）。 */
export const regressionLoopLimitForWindow = (contextWindow: number): number =>
  scaledThreshold(contextWindow, 5, 12)

/**
 * B2 收敛轨迹门（会话 506a5e86 优化；2026-10-02 S1 连带修正 bar 标定）：
 * 最近 window 个收敛 score 均值 >= bar → 轨迹收敛 → B2 静默。score 来自
 * convergence-detector.evaluateConvergence（[0,1]，越高越收敛）。
 *
 * bar=0.6 = detector 的 **L1 线**：只有 detector 对轨迹完全无话
 * （score > 0.6，L1/L2/L3 均不触发）时才让 B2 静默。修正原因：旧 bar=0.4
 * （对齐 L2 线，"让位给 detector"）的前提在 B2 的早期兜底区间不成立——
 * L2 有 turn 门（1M nMid=34 / 200K=14，B2 却在 28/12 轮就介入），L1
 * （0.4-0.6）无用户可见消费（纯内部评级，不注入提醒）。该区间 0.4-0.6
 * 分数的会话在旧世界靠 S1 缺陷的分数漂移（长会话累计成本压低
 * tokenEfficiency）隐性获得 B2 提醒；S1 修复（窗口增量口径）移除漂移后
 * 暴露为"提醒真空"（turn-orchestrator-b2-mode 五个契约用例红）。新 bar 下
 * 0.4-0.6 疑似区由 B2 有界补强（每 run 一次，不刷屏），> 0.6 真收敛静默。
 * 冷启动：样本 < minSamples 时返回 false（保守照发，旧行为）。
 */
export function isB2ConvergingRecently(
  scoreHistory: readonly ConvergenceScoreHistoryEntry[],
  minSamples = 2,
  window = 3,
  bar = 0.6,
): boolean {
  // P3：与 detector 趋势同口径——只取末尾连续、同 regime（regimeKey）、
  // 有效的样本；同口径数据不足时返回 false（保守照发 B2），不得凭混合
  // 旧分数静默 B2 门。legacy number 条目按原语义参与（逐位兼容）。
  const recent = tailAlignedScores(scoreHistory, window)
  if (recent.length < minSamples) return false
  return recent.reduce((a, b) => a + b, 0) / recent.length >= bar
}
