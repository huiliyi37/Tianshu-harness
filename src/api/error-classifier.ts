/**
 * API Error Classifier — maps raw exceptions to structured recovery strategies.
 *
 * Used by the retry engine (task 2) to decide whether, how, and when to retry.
 * Pure functions, no side effects.
 */

import { ReasoningRepetitionError } from './reasoning-repetition.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'auth_error'
  | 'client_error'
  | 'context_overflow'
  | 'image_strip'
  | 'stream_parse'
  | 'reasoning_repetition'
  | 'unknown'

/** 全部错误类别的运行时清单——config 侧（schema.ts 的 retry.overrides 键枚举）
 *  以此为单一真源：字段拼错在 loadConfig 时就报错，而不是静默失效。 */
export const ERROR_CATEGORIES = [
  'rate_limit', 'overloaded', 'server_error', 'timeout', 'auth_error',
  'client_error', 'context_overflow', 'image_strip', 'stream_parse',
  'reasoning_repetition', 'unknown',
] as const satisfies readonly ErrorCategory[]

// 编译期穷尽检查：类型新增类别而清单漏列时，下面这行报错（无运行时代价）。
type _AllCategoriesListed = ErrorCategory extends (typeof ERROR_CATEGORIES)[number] ? true : never
const _allCategoriesListed: _AllCategoriesListed = true
void _allCategoriesListed

export interface ClassifiedError {
  retryable: boolean
  retryDelayMs: number
  shouldReconnect: boolean
  category: ErrorCategory
  userMessage: string
  maxRetries: number
  /** When true, the retry engine should strip image_url content from
   * messages before retrying. Does not consume retry budget (first strip only). */
  stripImages?: boolean
  /** True when `retryDelayMs` came from the server's Retry-After header rather
   *  than the category default — the retry engine keeps such delays fixed
   *  (jitter only, no exponential growth; the server named the wait). */
  retryDelayFromServer?: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract HTTP status code from various error shapes. */
function extractStatus(error: unknown): number | null {
  if (error != null && typeof error === 'object') {
    // ApiError exposes .status directly
    const obj = error as Record<string, unknown>
    if (typeof obj.status === 'number') return obj.status

    // Codex-style message: "Codex API error (429): ..."
    if (obj.message && typeof obj.message === 'string') {
      const m = obj.message.match(/\((\d{3})\)/)
      if (m) return parseInt(m[1]!, 10)
    }
  }

  // Fallback: scan the error message if it's an Error
  if (error instanceof Error) {
    const m = error.message.match(/\((\d{3})\)/)
    if (m) return parseInt(m[1]!, 10)
  }

  return null
}

/** Extract human-readable message from various error shapes. */
function extractMessage(error: unknown): string | null {
  if (error != null && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
  }
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return null
}

/** Classify based on HTTP status code. Returns null if status is unrecognised.
 *  `payloadHadImages` 由 API client 打标（它知道自己发出了什么）——413 靠它
 *  区分「图片过重」与「上下文超限」，见 413 分支的注释。 */
function classifyByStatus(status: number, payloadHadImages?: boolean): ClassifiedError | null {
  // Rate limit
  if (status === 429) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'rate_limit',
      userMessage: 'Rate limited — too many requests. Retrying after back-off.',
      maxRetries: 5,
    }
  }

  // Overloaded
  if (status === 529 || status === 503) {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'overloaded',
      userMessage: 'Server is overloaded. Retrying after back-off.',
      maxRetries: 3,
    }
  }

  // Generic server errors
  if (status === 500 || status === 502) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: 'Server error. Retrying.',
      maxRetries: 3,
    }
  }

  // Request timeout (server timed out waiting for request) — transient, retryable
  if (status === 408) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: 'Server request timeout. Retrying.',
      maxRetries: 3,
    }
  }

  // Too Early (RFC 8470) — server unwilling to process, retryable after delay
  if (status === 425) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'overloaded',
      userMessage: 'Server not ready (Too Early). Retrying.',
      maxRetries: 3,
    }
  }

  // 413 Payload Too Large — 两种成因在 wire 层长得一模一样，区分所需的信息只有
  // API client 有：它知道自己刚发出去的请求体里有没有 image_url。client 在错误上
  // 留 `payloadHadImages` 标记，这里据此分流：
  //   true      → 图片过重：剥离 image_url 后重发一次（剥离由 client 在重试时执行）
  //   false     → 请求本就没图：纯上下文超限，重发同一个体必然再 413，不可重试
  //   undefined → 第三方网关转述的 413（client 没打过标）：乐观按 image_strip，
  //               client 侧无图可剥时会即时失败，不会空转一轮
  if (status === 413) {
    if (payloadHadImages === false) {
      return {
        retryable: false,
        retryDelayMs: 0,
        shouldReconnect: false,
        category: 'context_overflow',
        userMessage: 'Payload too large (413) — the request exceeds the provider limit.',
        maxRetries: 0,
      }
    }
    return {
      retryable: true,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'image_strip',
      userMessage: 'Payload too large — stripping images and retrying.',
      maxRetries: 1,
      stripImages: true,
    }
  }

  // Auth errors
  if (status === 401 || status === 403) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'auth_error',
      userMessage: 'Authentication failed. Check your API key.',
      maxRetries: 0,
    }
  }

  // 404 — usually a wrong model id or a wrong endpoint path (missing /v1).
  // Point at the command that lists what the endpoint actually serves.
  if (status === 404) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: 'Not found (404) — verify the model id with `rivet provider models <provider>`.',
      maxRetries: 0,
    }
  }

  // Other 4xx
  if (status >= 400 && status < 500) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: `Client error (${status}).`,
      maxRetries: 0,
    }
  }

  // Other 5xx
  if (status >= 500) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: `Server error (${status}). Retrying.`,
      maxRetries: 3,
    }
  }

  return null
}

/** Classify based on error name / message patterns. */
function classifyByPattern(error: unknown): ClassifiedError {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  // undici buries the real network failure in err.cause ("fetch failed" alone
  // matches nothing) — classify against the full cause chain, not just the top.
  const causeDetail = fetchCauseDetail(error)
  const searchText = causeDetail ? `${message} | ${causeDetail}` : message
  const lower = searchText.toLowerCase()

  // Connection reset / refused / unreachable — transport-level network failures.
  // "fetch failed" without a recognizable cause still lands here: it is by
  // definition a pre-response network error (DNS/connect/TLS), never a server
  // verdict, so reconnect-and-retry is the right default.
  if (
    name === 'ECONNRESET' ||
    name === 'EPIPE' ||
    name === 'ECONNREFUSED' ||
    /ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|UND_ERR_CONNECT|UND_ERR_SOCKET|other side closed|fetch failed/i.test(searchText)
  ) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: causeDetail
        ? `Connection lost (${causeDetail}). Reconnecting.`
        : 'Connection lost. Reconnecting.',
      maxRetries: 3,
    }
  }

  // Timeout (incl. ETIMEDOUT buried in a fetch-failed cause chain)
  if (name === 'TimeoutError' || /timeout|timed?\s*out/i.test(searchText)) {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'timeout',
      userMessage: 'Request timed out. Retrying.',
      maxRetries: 3,
    }
  }

  // Some OpenAI-compatible gateways return provider overload as a structured
  // error body without preserving the HTTP 503 status on the thrown Error.
  // Keep these errors in the overloaded category so FallbackStreamClient can
  // switch to a configured backup provider instead of treating them as an
  // unknown, non-fallbackable failure.
  if (/service[_\s-]*unavailable|too\s+busy|temporarily\s+unavailable|server\s+overload|overloaded|capacity/i.test(lower)) {
    return {
      retryable: true,
      retryDelayMs: 3000,
      shouldReconnect: true,
      category: 'overloaded',
      userMessage: 'Service is busy. Retrying or switching provider.',
      maxRetries: 3,
    }
  }

  // Upstream stream closed before first payload (cliproxy / proxy errors)
  if (/empty_stream|upstream.*stream.*closed|stream.*closed.*before.*payload/i.test(lower)) {
    return {
      retryable: true,
      retryDelayMs: 2000,
      shouldReconnect: true,
      category: 'server_error',
      userMessage: 'Upstream stream closed. Retrying.',
      maxRetries: 3,
    }
  }

  // AbortError — user-initiated cancellation, never retry
  if (name === 'AbortError') {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: 'Request was aborted.',
      maxRetries: 0,
    }
  }

  // Context overflow patterns
  if (
    /prompt is too long|context_length_exceeded|max.*token|context.*overflow/i.test(message)
  ) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'context_overflow',
      userMessage: 'Context too long — reduce prompt size.',
      maxRetries: 0,
    }
  }

  // Stream parse errors
  if (/stream.*parse|parse.*stream|invalid.*sse|unexpected.*event/i.test(lower)) {
    return {
      retryable: true,
      retryDelayMs: 1000,
      shouldReconnect: true,
      category: 'stream_parse',
      userMessage: 'Stream parse error. Reconnecting.',
      maxRetries: 2,
    }
  }

  // Fallback — unknown
  return {
    retryable: true,
    retryDelayMs: 2000,
    shouldReconnect: false,
    category: 'unknown',
    userMessage: `Unexpected error: ${message || 'unknown'}`,
    maxRetries: 2,
  }
}

/**
 * Extract human-readable detail from an error's `cause` chain.
 *
 * Node's undici fetch throws `TypeError: fetch failed` with the actual network
 * failure (ECONNREFUSED / ENOTFOUND / ETIMEDOUT / TLS / proxy) buried in
 * `err.cause` — often nested one level deeper, or inside an AggregateError
 * (Happy Eyeballs makes one connect attempt per resolved address). Without
 * unwrapping, both the user-facing error line and pattern classification see
 * only the useless top-level message.
 *
 * Returns a ` ← `-joined chain of cause messages, or null when there is none.
 */
export function fetchCauseDetail(error: unknown): string | null {
  const parts: string[] = []
  let cur: unknown = error instanceof Error ? error.cause : null
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (cur instanceof AggregateError && cur.errors.length > 0) {
      for (const sub of cur.errors.slice(0, 3)) {
        parts.push(sub instanceof Error ? sub.message : String(sub))
      }
      break
    }
    if (cur instanceof Error) {
      const code = (cur as NodeJS.ErrnoException).code
      parts.push(cur.message || code || cur.name)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  const detail = [...new Set(parts.filter(Boolean))].join(' ← ')
  return detail || null
}

/** Read retryAfterMs from the error object (set by ApiError (legacy)). */
function extractRetryAfter(error: unknown): number | undefined {
  if (error != null && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.retryAfterMs === 'number') return obj.retryAfterMs
  }
  return undefined
}

/** 读 API client 留在 413 错误上的「这次请求体是否含图」标记。
 *  true/false 是 client 的确定判断；undefined = 没打过标（第三方网关转述的 413）。 */
function extractPayloadHadImages(error: unknown): boolean | undefined {
  if (error != null && typeof error === 'object') {
    const v = (error as Record<string, unknown>).payloadHadImages
    if (typeof v === 'boolean') return v
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an API error into a structured recovery strategy.
 *
 * Priority: status code → error name → message pattern → fallback.
 */
export function classifyApiError(error: unknown): ClassifiedError {
  if (error instanceof ReasoningRepetitionError) {
    return {
      retryable: false, retryDelayMs: 0, shouldReconnect: false,
      category: 'reasoning_repetition', userMessage: error.message, maxRetries: 0,
    }
  }
  // Non-SSE 200 (openai-client content-type gate): the endpoint answered but
  // not with a stream — wrong path / no streaming support. Retrying repeats
  // the same misconfiguration; surface the original actionable message.
  if (error != null && typeof error === 'object' && (error as Record<string, unknown>).nonSse === true) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'client_error',
      userMessage: extractMessage(error) ?? 'Endpoint returned a non-SSE 200 response.',
      maxRetries: 0,
    }
  }

  // 0. Image processing errors (400/500 wrapping image rejection):
  //    Check before status-code classification so these bypass generic 4xx/5xx.
  //    Pattern source: grok-build retry.rs — "Could not process image" (400),
  //    "upstream: 400 ... image" (500 wrap)
  const status = extractStatus(error)
  const msg = extractMessage(error)
  if (
    status !== null && (status === 400 || status === 500) &&
    msg !== null &&
    /could not process image|image processing|unsupported image|invalid image format/i.test(msg)
  ) {
    return {
      retryable: true,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'image_strip',
      userMessage: 'Image processing error — stripping images and retrying.',
      maxRetries: 1,
      stripImages: true,
    }
  }

  // 1. Try status-code based classification first
  if (status !== null) {
    const result = classifyByStatus(status, extractPayloadHadImages(error))
    if (result) {
      // Override delay with server-provided retryAfterMs if available
      const retryAfter = extractRetryAfter(error)
      if (retryAfter !== undefined) {
        return { ...result, retryDelayMs: retryAfter, retryDelayFromServer: true }
      }
      return result
    }
  }

  // 2. Fall back to name / message pattern classification
  return classifyByPattern(error)
}

/**
 * 终态恢复指引（TUI handleError 用）——与 userMessage 的分工：userMessage 是
 * 重试进行中的过程文案（"Retrying…"），本函数是重试耗尽后的「下一步」。
 * 返回中文可行动指引（按 category 分流）；无法分类时给通用兜底。
 */
export function errorRecoveryGuidance(error: unknown): string {
  const c = classifyApiError(error)
  switch (c.category) {
    case 'rate_limit':
      return '限流/额度不足：稍等片刻再发，或 /model 切轻量档（如 deepseek-v4-flash）；持续 429 先查余额（桌面端 Insights 面板）'
    case 'overloaded':
    case 'server_error':
      return '服务商暂时性故障：稍后重发，或 /model 切换服务商'
    case 'timeout':
      return '网络超时：检查网络/代理后重发；反复超时用 /doctor 体检'
    case 'auth_error':
      return '认证失败：/connect 检查 API Key；订阅型（codex）用 /login 重新授权'
    case 'context_overflow':
      return '上下文超限：/compact 压缩，或 /handoff 交接后开新会话'
    case 'client_error':
      return '请求被拒（模型 id 或端点路径错）：/model 确认模型；自定义端点检查 baseUrl 是否缺 /v1'
    case 'image_strip':
      return '图片负载超限：去掉部分图片后重发'
    case 'stream_parse':
      return '流解析失败：重发一次；反复出现用 /logs 打包日志提 issue'
    case 'reasoning_repetition':
      return '检测到推理短句持续重复，已停止请求；建议新建会话或 /model 切换模型后重试'
    default:
      return '重发一次；持续失败：/doctor 体检 + /logs 看日志'
  }
}

/**
 * Parse Retry-After header value (RFC 7231 §7.1.3).
 * Numeric string → seconds × 1000.
 * HTTP-date string → delta from now in ms.
 * Unparseable → undefined.
 */
export function parseRetryAfterMs(value: string): number | undefined {
  const parsed = parseFloat(value)
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed * 1000
  }
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}
