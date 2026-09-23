/**
 * API Error Classifier — maps raw exceptions to structured recovery strategies.
 *
 * Used by the retry engine (task 2) to decide whether, how, and when to retry.
 * Pure functions, no side effects.
 */

import { ReasoningRepetitionError } from './reasoning-repetition.js'
import { RequestInvariantError } from './request-invariant.js'
import { detectTlsInterception } from '../platform/tls-interception.js'

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
  | 'reasoning_echo'
  | 'request_invariant'
  | 'tls_intercept'
  | 'unknown'

/** 全部错误类别的运行时清单——config 侧（schema.ts 的 retry.overrides 键枚举）
 *  以此为单一真源：字段拼错在 loadConfig 时就报错，而不是静默失效。 */
export const ERROR_CATEGORIES = [
  'rate_limit', 'overloaded', 'server_error', 'timeout', 'auth_error',
  'client_error', 'context_overflow', 'image_strip', 'stream_parse',
  'reasoning_repetition', 'reasoning_echo', 'request_invariant', 'tls_intercept', 'unknown',
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
  /** When true, the retry engine should **re-send reasoning_content** on the next
   *  attempt. Some OpenAI-protocol gateways hosting DeepSeek thinking models reject
   *  history whose assistant turns had their reasoning stripped
   *  ("The `reasoning_content` in the thinking mode must be passed back to the API").
   *  One-shot like stripImages — the retry either proves the gateway needs it or not. */
  preserveReasoning?: boolean
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
        // 发送前护栏默认关闭 → 用户会先吃到这个 413。文案直接给出两条出路：
        // 临时压缩，或把该 provider 的 maxBodyBytes 配上（超限自动截断历史工具输出）。
        userMessage:
          'Payload too large (413) — the request exceeds the provider limit. ' +
          '可用 /compact 压缩本会话；或在该 provider 配置里设 maxBodyBytes（字节）' +
          '启用发送前体积护栏（超限时自动截断历史工具输出）。',
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

/**
 * TLS 证书校验失败的特征。
 *
 * 判定依据是错误链文本：Node/OpenSSL 的 `code`（UNABLE_TO_VERIFY_LEAF_SIGNATURE…）
 * 与 message 文案（"unable to verify the first certificate"…）两套都要认——
 * `fetchCauseDetail` 优先取 message，纯匹配 code 会漏。
 *
 * 刻意**不**收 `ERR_TLS_CERT_ALTNAME_INVALID`（主机名不匹配）：那多为代理/CDN
 * 配置问题，套上"加密连接扫描"的结论是误导。
 */
const TLS_VERIFY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify leaf signature|unable to verify the first certificate/i, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  [/SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|self[-\s]?signed certificate/i, 'SELF_SIGNED_CERT_IN_CHAIN'],
  [/UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|unable to get (local )?issuer certificate/i, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
  [/CERT_UNTRUSTED|CERTIFICATE_VERIFY_FAILED|certificate verify failed/i, 'CERT_UNTRUSTED'],
]

/** Return the matched TLS verification failure code, or null when the text isn't one. */
function matchTlsVerification(text: string): string | null {
  for (const [re, code] of TLS_VERIFY_PATTERNS) {
    if (re.test(text)) return code
  }
  return null
}

/** 判"本机是否有中间人"所需的探测结果子集（便于测试注入）。 */
export interface TlsInterceptionHint {
  suspectCount: number
  vendors: string[]
}

/**
 * 把一次 TLS 证书校验失败分类成 `tls_intercept`。
 *
 * **两种成因必须分开说，不能一律甩给杀毒软件**（2026-09-23 跟进修）：
 *   · 本机系统证书存储里检出加密连接扫描根证书 ⇒ 本地中间人，**确定性失败**，
 *     重试只会重现同一张证书（0 次重试），文案直接给三条本地处置。
 *   · 未检出 ⇒ 更可能是**服务端证书链不完整**（provider 轮换证书时部分节点发半截链，
 *     报的正是 `unable to verify the first certificate`）——那种情况重试能撞上正常节点，
 *     所以留 1 次重试；文案并列两种可能并指向 /doctor 自查，避免把用户引去瞎调杀毒软件。
 *
 * @param code   matchTlsVerification 命中的错误码
 * @param probe  detectTlsInterception() 的结果；null = 探不到（非 Windows / 存储不可读）
 */
export function classifyTlsIntercept(code: string, probe: TlsInterceptionHint | null): ClassifiedError {
  const localMitm = (probe?.suspectCount ?? 0) > 0
  const who = probe && probe.vendors.length > 0 ? probe.vendors.join('、') : '未知来源'

  if (localMitm) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'tls_intercept',
      userMessage:
        `HTTPS 证书校验失败（${code}）：本机系统证书存储里有加密连接扫描根证书（${who}），` +
        '接口的 TLS 连接被中间人替换了证书——天枢的 sidecar 默认只信任内置 CA 列表，不读系统证书存储。处置：' +
        '① 在该软件里为天枢与 node[.exe] 排除接口域名（首选，零信任降级）；' +
        '② 设 NODE_EXTRA_CA_CERTS 指向其根证书；' +
        '③ 或设 NODE_OPTIONS=--use-system-ca 信任系统 CA 存储。' +
        '（同一张证书重试必然复现，故不重试。）',
      maxRetries: 0,
    }
  }

  return {
    retryable: true,
    retryDelayMs: 2000,
    shouldReconnect: true,
    category: 'tls_intercept',
    userMessage:
      `HTTPS 证书校验失败（${code}）：本机未检出加密连接扫描根证书，` +
      '更可能是服务端证书链不完整（provider 轮换证书期间的常见窗口，重试通常自愈）——' +
      '先重试一次。若仍失败：① 换 provider 或稍后再试；' +
      '② 若本机装了杀毒软件/企业代理，运行 /doctor 看「HTTPS 信任链」一节，' +
      '有检出就按其中的排除指引处理（或设 NODE_EXTRA_CA_CERTS / NODE_OPTIONS=--use-system-ca）。',
    maxRetries: 1,
  }
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

  // TLS 证书校验失败——必须排在「Connection lost」之前：undici 只报
  // "fetch failed"，证书原因埋在 cause 链里，落到下面那条就变成笼统的
  // "Connection lost. Reconnecting."，用户永远看不到真实成因。分类本身交给
  // classifyTlsIntercept：它按「本机是否检出加密连接扫描」分开判重试与文案。
  const tlsCode = matchTlsVerification(searchText)
  if (tlsCode) {
    return classifyTlsIntercept(tlsCode, detectTlsInterception())
  }

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

  // 请求体护栏（request-body-guard，由 provider 配置 maxBodyBytes 启用）在发送前判定超限——确定性失败，
  // 重试只会逐字节重现同一个超限体，白烧两轮 backoff 才把错误还给用户。
  if (name === 'RequestBodyTooLargeError') {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'context_overflow',
      userMessage: message, // 护栏的文案本身就是可行动的中文指引，原样透出
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
  // 请求重建不变式违规：不是网络/上游故障，重试只会重复同一份损坏字节，
  // 且必须**穿透**故障转移（FallbackStreamClient 只接管五类上游错误）——
  // 让它落进任何可重试/可接管类别，一次前缀损坏就会变成「悄悄换个 provider
  // 重发」，比不检查更糟。maxRetries=0 + 独占 category 把两件事都钉死。
  if (error instanceof RequestInvariantError) {
    return {
      retryable: false,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'request_invariant',
      userMessage: error.message,
      maxRetries: 0,
    }
  }
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

  // 思考模式要求回传 reasoning_content（issue #258）：网关托管 DeepSeek 思考模型
  // 时，客户端按「陌生供应商默认剥离思考内容」处理历史 → 第二轮起必 400
  // "The `reasoning_content` in the thinking mode must be passed back to the API."
  //
  // 必须早于下面的状态码分类：400 默认落 client_error（不可重试），而这条恰恰
  // **只能靠重试修**——client 侧把 reasoning_content 保留后重发一次即可通过
  // （见 openai-client 的 onRetry 分支）。与 image_strip 同款一次性语义。
  if (
    status !== null && status >= 400 && status < 500 &&
    msg !== null &&
    /reasoning_content/i.test(msg) &&
    /(passed back|must be passed)/i.test(msg)
  ) {
    return {
      retryable: true,
      retryDelayMs: 0,
      shouldReconnect: false,
      category: 'reasoning_echo',
      userMessage: '推理内容未回传被网关拒收——已保留思考内容重发（provider 可声明 capabilities.preservedThinkingProtocol 免去这一次重试）。',
      maxRetries: 1,
      preserveReasoning: true,
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
    case 'reasoning_echo':
      return '该网关要求回传思考内容（reasoning_content）：已在本次重试中保留；'
        + '若持续出现，在该 provider 的 capabilities 里声明 preservedThinkingProtocol: true'
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
