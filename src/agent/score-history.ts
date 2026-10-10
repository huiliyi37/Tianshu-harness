/**
 * 收敛分数历史规范（《收敛阶段补修》§6 P3：独立计时、可比分数与观测）。
 *
 * 分数的可比性边界由 regimeKey 定义：任务边界（taskEpoch）、确认阶段的
 * 连续片段（stageEpoch——只随 committed 相位切换递增，弱候选抖动不切片）、
 * 编辑期待（决定 editRatio 权重份额是否参与及其归一口径）。趋势判定
 * （L3 score-abort 的持续下降、B2 轨迹门的近窗均值）只允许消费末尾连续、
 * 同 regime、有效的样本——混合口径的旧分数不得触发 score-abort，也不得
 * 静默 B2 门。
 *
 * 兼容与缺省（fail-safe 方向）：
 * - 纯 number 条目 = legacy 样本（无口径信息）——旧调用形态按原语义参与，
 *   向后兼容逐位不变；
 * - quality='insufficient'（窗口与指纹全空、分数无证据支撑）在尾部对齐时
 *   截止——不以无证据的分数充当下降/收敛证据；
 * - 同口径样本不足 windowSize 时 declining=false（不足不燃）。
 */

/** 单条评分样本：分数 + 口径键 + 质量。 */
export interface ConvergenceScoreSample {
  score: number
  /** 口径片段键（buildRegimeKey 产出）；null = legacy 样本（无口径信息）。 */
  regimeKey: string | null
  quality: 'ok' | 'insufficient'
}

/** 历史条目：number = legacy 样本（向后兼容旧调用/旧测试形态）。 */
export type ConvergenceScoreHistoryEntry = number | ConvergenceScoreSample

/** regimeKey 的唯一组装点（loop 记录侧与 replay 夹具共用——防两处口径漂移）。 */
export function buildRegimeKey(input: {
  taskEpoch: number
  stageEpoch: number
  /** 编辑期待 kind；null = 未提供（夹具缺字段——不冒充 'required'）。 */
  editExpectationKind: string | null
}): string {
  return `${input.taskEpoch}:${input.stageEpoch}:${input.editExpectationKind ?? 'none'}`
}

/** Deterministic signature of the actual scoring allocation and availability. */
export function effectiveScoreRegimeKey(base: string | null, weights: Readonly<Record<string, number>>, missing: ReadonlySet<string>, phase: string): string | null {
  if (base === null) return null // explicit legacy input retains legacy semantics
  const allocation = Object.keys(weights).sort().map(key => `${key}=${weights[key]!.toFixed(12)}`).join(',')
  return `${base}|${phase}|${allocation}|missing=${[...missing].sort().join(',')}`
}

/** 归一历史条目（legacy number → 无口径样本；不做其他改写）。 */
export function normalizeScoreHistory(
  history: ReadonlyArray<ConvergenceScoreHistoryEntry>,
): ConvergenceScoreSample[] {
  return history.map(entry => typeof entry === 'number'
    ? { score: entry, regimeKey: null, quality: 'ok' as const }
    : entry)
}

/**
 * 末尾连续、同 regime、有效的样本分数（至多 windowSize 条，最近在后）。
 * 从尾部向前扫描：quality 非 ok 或 regimeKey 与尾部不一致即截止——
 * 返回长度 < windowSize 即「同口径数据不足」。
 */
export function tailAlignedScores(
  history: ReadonlyArray<ConvergenceScoreHistoryEntry>,
  windowSize: number,
  expectedRegimeKey?: string | null,
): number[] {
  if (windowSize <= 0) return []
  const samples = normalizeScoreHistory(history)
  const tail = samples[samples.length - 1]
  if (!tail) return []
  if (expectedRegimeKey !== undefined && tail.regimeKey !== expectedRegimeKey) return []
  const segment: number[] = []
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!
    if (s.quality !== 'ok') break
    if (s.regimeKey !== tail.regimeKey) break
    segment.unshift(s.score)
  }
  return segment.slice(-windowSize)
}

export interface ScoreDeclineAnalysis {
  /** 末尾同口径窗口是否持续下降（至多 1 次微反弹；末值 < 首值）。 */
  declining: boolean
  /** 实际参与判定的样本数（< windowSize 即同口径数据不足——不燃）。 */
  sampleCount: number
}

/**
 * L3 score-abort 的下降趋势判定（原 detector 内联逻辑的规范性外移）。
 * 保留原护栏语义：至多 1 次微反弹、整体仍须下降；同口径数据不足时不燃。
 */
export function analyzeScoreDecline(
  history: ReadonlyArray<ConvergenceScoreHistoryEntry>,
  windowSize: number,
  expectedRegimeKey?: string | null,
): ScoreDeclineAnalysis {
  const window = tailAlignedScores(history, windowSize, expectedRegimeKey)
  if (window.length < windowSize) return { declining: false, sampleCount: window.length }
  let reversals = 0
  for (let i = 1; i < window.length; i++) {
    if (window[i]! > window[i - 1]!) reversals++
  }
  return {
    declining: reversals <= 1 && window[window.length - 1]! < window[0]!,
    sampleCount: window.length,
  }
}
