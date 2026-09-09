/**
 * Repair two high-frequency JSON syntax faults in model-written worker reports:
 * bare quotes inside string values and trailing commas.
 *
 * Background (2026-09-06 review-infra postmortem): a review worker's report
 * failed `workerResultIngestSchema` because a `content` field contained bare
 * quotes (`"content": "他说"好的""`), and only 7/11 findings survived the
 * salvage ladder. The same root cause lost 2/6 findings in session f98bb237.
 * Repair re-asks were proven ineffective (2026-07-29: same model + same budget
 * + same prompt = same failure), so syntax faults should be fixed locally and
 * mechanically, not by asking the model again.
 *
 * Deliberately narrow — syntax-level only, no semantic guessing:
 *  1. A quote inside a string whose next non-space char is NOT a structural
 *     terminator (`,`, `}`, `]`, `:`, EOF) is a bare quote → escape it (`\"`).
 *     Structural closing quotes (followed by terminator) are left untouched.
 *  2. A comma outside strings followed by `}` or `]` is a trailing comma →
 *     delete it.
 * Both run in one state-machine pass; the result is accepted only when the
 * whole text parses. Returns the repaired text, or null when nothing needed
 * repair (callers skip the redundant re-parse) or the text is unparseable
 * even after repair (truncated strings, structural garbage — those fall
 * through to the repair re-ask / salvage ladder unchanged).
 *
 * One known-unfixable ambiguity: a string that never terminates (missing
 * closing quote from maxTokens truncation) is out of whitelist — the existing
 * strategy-6 truncation repair in work-order.ts handles that case.
 */

const STRUCTURAL_AFTER_QUOTE = new Set([',', '}', ']', ':'])
const MAX_REPAIR_PASSES = 3

export function repairJsonSyntax(raw: string): string | null {
  let current = raw
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const repaired = repairOnePass(current)
    if (repaired === null) {
      // 无改动：若本就 parse 成功调用方不会进来；parse 失败且无白名单模式 → 不可修
      return null
    }
    current = repaired
    try {
      JSON.parse(current)
      return current
    } catch {
      /* repaired text still broken — one more pass (e.g. a second bare quote) */
    }
  }
  return null
}

function repairOnePass(raw: string): string | null {
  let out = ''
  let inString = false
  let changed = false
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]!
    if (inString) {
      if (ch === '\\') {
        // 合法转义：整体拷贝两个字符（含可能的行尾残缺——交给 parse 判定）
        out += ch
        if (i + 1 < raw.length) {
          out += raw[i + 1]!
          i += 2
        } else {
          i++
        }
        continue
      }
      if (ch === '"') {
        // 闭合判定：下一非空白字符是结构终止符或 EOF → 闭合；否则裸引号 → 转义
        let j = i + 1
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++
        const next = j < raw.length ? raw[j] : undefined
        if (next === undefined || STRUCTURAL_AFTER_QUOTE.has(next)) {
          inString = false
          out += ch
        } else {
          out += '\\"'
          changed = true
        }
        i++
        continue
      }
      out += ch
      i++
      continue
    }
    // 字符串外
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++
      const next = j < raw.length ? raw[j] : undefined
      if (next === '}' || next === ']') {
        changed = true // 尾逗号：删除
        i++
        continue
      }
      out += ch
      i++
      continue
    }
    out += ch
    i++
  }
  return changed ? out : null
}
