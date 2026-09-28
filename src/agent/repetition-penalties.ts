/**
 * 跨轮重复度惩罚信号（纯函数，无 IO）。
 *
 * 从 `convergence-detector.ts` 沿接缝拆出：`computeOscillationPenalty` /
 * `computeTextRepetitionPenalty` 及其数据充分性守卫同属「一串 fingerprint →
 * 一个 0–1 惩罚值」的纯函数族，与 `evaluateConvergence` 的评分、加权、
 * 信号缺失重分配逻辑无耦合。
 *
 * 拆分动因：issue #287 的 CJK 近重复修复需要在 `convergence-detector.ts`
 * 净增行，而该文件已顶到 1260 行 ceiling（`src/__tests__/architecture-guards.test.ts`
 * 的 max-lines ratchet，基线表 `scripts/source-budgets.manifest.json`）。
 * 按该门禁「只降不升，沿接缝拆分」的要求，重复度度量族是现成的接缝。
 */

/** CJK 表意文字/假名区间（含扩展 A 区与兼容区）——判定文本是否无空格分词可用。 */
const CJK_CHAR_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/**
 * Jaccard 相似度用的 token 集合。
 *
 * 空格分词文本（英文等）沿用词级集合（词长 ≥3，行为不变）；CJK 为主的文本
 * 没有空格，split(/\s+/) 会把整段切成单个 token——「同一段话换序号再发
 * 一遍」（中文复读的典型形态）两个整段 token 不同 → Jaccard 恒 0 → 重复度
 * 恒满分，isProducingReport 跟着恒真，no-tool 熔断与 scoreAbort 双双失明
 * （issue #287）。CJK 文本改用字符级 2-gram 集合：近重复段的 2-gram 集合
 * 几乎全同，Jaccard 恢复区分度。
 */
function buildTextTokenSet(text: string): Set<string> {
  const chars = text.replace(/\s+/g, '')
  let cjkCount = 0
  for (const ch of chars) {
    if (CJK_CHAR_RE.test(ch)) cjkCount++
  }
  if (chars.length > 0 && cjkCount * 2 >= chars.length) {
    const grams = new Set<string>()
    for (let i = 0; i + 1 < chars.length; i++) {
      grams.add(chars.slice(i, i + 2))
    }
    return grams
  }
  return new Set(text.split(/\s+/).filter(w => w.length >= 3))
}

/**
 * oscillationPenalty: detects A→B→A→B alternating patterns in tool fingerprints
 * via positional reversal counting — hash[i] === hash[i-2] && hash[i] !== hash[i-1].
 *
 * Returns continuous 0–1 (0 = heavy oscillation, 1 = no oscillation). Unlike the
 * old strict-2-unique-value gate, this catches gradual oscillation across 3+ values
 * (e.g. A→B→A→C→A→B) that the old detector silently ignored.
 */
export function computeOscillationPenalty(fingerprints: ReadonlyArray<string>): number {
  if (fingerprints.length < 4) return 1.0 // need at least 4 to detect reversals
  let reversals = 0
  for (let i = 2; i < fingerprints.length; i++) {
    if (fingerprints[i] === fingerprints[i - 2] && fingerprints[i] !== fingerprints[i - 1]) {
      reversals++
    }
  }
  const possibleReversals = fingerprints.length - 2
  const oscillationRate = reversals / possibleReversals
  return Math.max(0, Math.min(1, 1 - oscillationRate))
}

/**
 * Whether computeOscillationPenalty has enough data to produce a meaningful
 * (non-sentinel) value. Updated to match new threshold: ≥ 4 fingerprints.
 */
export function oscillationHasData(fingerprints: ReadonlyArray<string>): boolean {
  return fingerprints.length >= 4
}

/**
 * textRepetitionPenalty: detects cross-turn text output repetition.
 * When the model produces nearly identical text across turns (despite calling
 * different tools), it's stuck in a "reformat the same analysis" loop.
 *
 * Uses Jaccard similarity between recent text fingerprints — word sets for
 * space-delimited text, character 2-grams for CJK-dominant text (no spaces
 * to split on; issue #287).
 * Returns 0.0 (heavy penalty) when 3+ of the last 4 turns have >70% word overlap,
 * 1.0 when text is diverse across turns.
 */
export function computeTextRepetitionPenalty(fingerprints: ReadonlyArray<string>): number {
  const window = fingerprints.slice(-5)
  if (window.length < 3) return 1.0 // not enough data

  // Compute token sets for each fingerprint (skip very short ones)
  const tokenSets = window
    .filter(fp => fp.length >= 50)
    .map(fp => buildTextTokenSet(fp))

  if (tokenSets.length < 3) return 1.0

  // Count pairs with high Jaccard similarity
  let highSimilarityPairs = 0
  let totalPairs = 0
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      totalPairs++
      const a = tokenSets[i]!
      const b = tokenSets[j]!
      if (a.size === 0 || b.size === 0) continue
      let intersection = 0
      for (const word of a) {
        if (b.has(word)) intersection++
      }
      const union = a.size + b.size - intersection
      const jaccard = union > 0 ? intersection / union : 0
      if (jaccard > 0.7) highSimilarityPairs++
    }
  }

  if (totalPairs === 0) return 1.0

  // If more than half of pairs are highly similar, apply penalty
  const similarRatio = highSimilarityPairs / totalPairs
  if (similarRatio >= 0.6) return 0.0   // severe: majority of turns repeat same text
  if (similarRatio >= 0.4) return 0.3   // moderate
  return 1.0
}

/**
 * Whether computeTextRepetitionPenalty has enough data to produce a meaningful
 * (non-sentinel) value. The signal returns 1.0 both when data is insufficient
 * (too few fingerprints / too few long ones / no pairs) AND when text is
 * genuinely diverse. Only the former should trigger weight re-allocation.
 * Mirrors the guard conditions in computeTextRepetitionPenalty.
 */
export function textRepetitionHasData(fingerprints: ReadonlyArray<string>): boolean {
  const window = fingerprints.slice(-5)
  if (window.length < 3) return false
  const longWordSets = window.filter(fp => fp.length >= 50)
    .map(fp => new Set(fp.split(/\s+/).filter(w => w.length >= 3)))
  return longWordSets.length >= 3
}
