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
 * B2 收敛轨迹门（会话 506a5e86 优化）：最近 window 个收敛 score 均值 >= bar
 * → 轨迹收敛 → B2 静默。score 来自 convergence-detector.evaluateConvergence
 * （[0,1]，越高越收敛）。bar=0.4 对齐 detector 的 L2 分档线（<=0.4 = L2）：
 * B2 静默区与 detector 的 L2+ 提醒严格不重叠，防双提醒叠罗汉（0.4-0.6 的
 * L1 区间 detector 仍会发轻度提醒，B2 不追加）。
 * 冷启动：样本 < minSamples 时返回 false（保守照发，旧行为）。
 */
export function isB2ConvergingRecently(
  scoreHistory: readonly number[],
  minSamples = 2,
  window = 3,
  bar = 0.4,
): boolean {
  if (scoreHistory.length < minSamples) return false
  const recent = scoreHistory.slice(-window)
  return recent.reduce((a, b) => a + b, 0) / recent.length >= bar
}
