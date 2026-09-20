/**
 * Sanitization utilities for safe JSON transport to LLM APIs.
 *
 * Problem: certain terminal inputs (garbled bytes, raw emoji, binary paste)
 * produce JavaScript strings with characters that inflate the JSON body size
 * (each C0 control char becomes a 6-byte `\u00XX` escape) or create lone
 * surrogates that some API JSON parsers reject. When the inflated body
 * exceeds an API server's internal body-size limit, the server truncates it
 * at a byte boundary — which can split a `\uXXXX` escape and produce the
 * "unexpected end of hex escape" HTTP 400 error.
 *
 * Strategy:
 * 1. Strip/replace characters that bloat JSON size (C0/C1 controls).
 * 2. Remove lone surrogates that could confuse parsers.
 * 3. Normalize to NFC to avoid duplicate Unicode representations.
 * 4. Apply at message-entry points AND as a safety net in the API client.
 */

// Use String.prototype.normalize('NFC') directly — no external dep needed.
const nfNormalize = (s: string) => s.normalize('NFC')

/**
 * Maximum safe JSON body size for LLM API requests (bytes).
 * DeepSeek and most OpenAI-compatible APIs reject or truncate bodies above ~4MB.
 * We use a conservative limit with headroom.
 */
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024 // 4 MB

/**
 * Sanitize a string for safe JSON transport.
 *
 * - C0 control chars (U+0000–U+001F) except \t \n \r → replaced with space
 * - C1 control chars (U+0080–U+009F) → replaced with space
 * - Lone surrogates (unpaired high/low) → replaced with U+FFFD
 * - Unicode normalized to NFC
 */
export function sanitizeForJsonTransport(input: string): string {
  if (input.length === 0) return input

  // Fast path: scan for characters that need replacement.
  // Most strings (normal text, code) pass through unchanged.
  let needsWork = false
  for (let i = 0; i < input.length; i++) {
    const cp = input.charCodeAt(i)
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) {
      needsWork = true
      break
    }
    if (cp >= 0x80 && cp <= 0x9F) {
      needsWork = true
      break
    }
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      // High surrogate — check if followed by a low surrogate
      const next = input.charCodeAt(i + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        needsWork = true
        break
      }
      i++ // skip low surrogate
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      // Lone low surrogate
      needsWork = true
      break
    }
  }

  if (!needsWork) return nfNormalize(input)

  // Slow path: build sanitized string
  const chars: string[] = []
  for (let i = 0; i < input.length; i++) {
    const cp = input.charCodeAt(i)

    // C0 control characters (except \t \n \r)
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) {
      chars.push(' ')
      continue
    }

    // C1 control characters
    if (cp >= 0x80 && cp <= 0x9F) {
      chars.push(' ')
      continue
    }

    // Lone high surrogate
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      const next = input.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        // Valid surrogate pair — keep both
        chars.push(input[i]!, input[i + 1]!)
        i++ // skip low surrogate
      } else {
        // Lone high surrogate — replace with replacement character
        chars.push('\uFFFD')
      }
      continue
    }

    // Lone low surrogate
    if (cp >= 0xDC00 && cp <= 0xDFFF) {
      chars.push('\uFFFD')
      continue
    }

    chars.push(input[i]!)
  }

  return nfNormalize(chars.join(''))
}

/**
 * Recursively sanitize all string values in an object tree.
 * Returns a new object — does not mutate the input.
 */
export function sanitizeMessageContent<T>(value: T): T {
  if (typeof value === 'string') return sanitizeForJsonTransport(value) as T
  if (Array.isArray(value)) return value.map(sanitizeMessageContent) as T
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeMessageContent(child)
    }
    return result as T
  }
  return value
}

/**
 * 超过这个字符数（≈1–3MB 的 wire 体）就放弃增量清洗、每次请求全量清洗。
 *
 * API client 的增量清洗（只洗上次之后新增的消息）省的是 O(chars)，但它有两个
 * 漏洗窗口：① 历史消息被原地改写（长度不变时无从察觉）；② 同一个 client 实例
 * 被不同数组复用（次数相近时不触发 reset）。漏过的一个控制字符在 wire 上就是
 * `\u00XX` 转义，正是上游按字节截断 body 时被切开的那个东西（见
 * src/api/request-body-guard.ts）。而全量扫描与本次请求必做的 JSON.stringify
 * 同阶——在 1M 字符这个量级，省它已经没有意义，正确性优先。
 */
export const FULL_SANITIZE_CHARS = 1_000_000

/** 消息数组的正文总字符数（只数 content/tool_calls，用于决定是否全量清洗）。 */
export function countContentChars(messages: readonly unknown[]): number {
  let chars = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const rec = m as { content?: unknown; tool_calls?: unknown }
    if (typeof rec.content === 'string') chars += rec.content.length
    else if (Array.isArray(rec.content)) {
      for (const part of rec.content) {
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: unknown }).text
          if (typeof t === 'string') chars += t.length
        }
      }
    }
    if (Array.isArray(rec.tool_calls)) chars += JSON.stringify(rec.tool_calls)?.length ?? 0
  }
  return chars
}
