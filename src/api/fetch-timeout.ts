/**
 * Fetch with pre-first-byte timeout.
 *
 * When the server accepts the TCP connection but never sends response headers,
 * a plain `fetch()` hangs indefinitely. This wrapper arms a timeout that
 * aborts the request if response HEADERS have not arrived within `timeoutMs`.
 *
 * CRITICAL — the timeout is disarmed the moment fetch resolves (headers
 * received). It must NOT stay armed during body streaming: a long healthy SSE
 * stream (e.g. a multi-minute reasoning response) would otherwise be cut off
 * mid-body with a raw `TimeoutError` ("The operation was aborted due to
 * timeout") once total request duration exceeds the first-byte budget.
 * Mid-body stream health is the responsibility of the SSE parsers' layered
 * guards (idle/read timers, thinking-stall, progress-extended hard cap) —
 * see the 4e1aaa21 post-mortem (2026-07-02).
 *
 * Error routing — critical for retry logic:
 * - Pre-first-byte timeout → throws descriptive Error (retryable)
 * - AbortError (user-initiated AbortController.abort) → re-throws as-is (non-retryable)
 * - Other → re-throws original error
 */

import { fetchCauseDetail } from './error-classifier.js'
import { beginCallAudit, auditConfigFingerprint, type CallAuditContext } from './call-audit.js'
import { observeAuditResponse } from './transport-audit.js'
import { prepareExecutionSend, credentialPrincipal, currentExecutionScope } from './execution-continuity.js'

const DEFAULT_TIMEOUT_MS = 45_000

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  /** undici dispatcher（如 ProxyAgent）——provider 级代理覆盖的透传槽位。 */
  dispatcher?: unknown,
  auditContext?: CallAuditContext,
): Promise<Response> {
  const userSignal = init.signal
  const execution = currentExecutionScope()
  if (execution && auditContext?.requestId) {
    execution.requestId = auditContext.requestId
    execution.attemptId = auditContext.attemptId
  }
  if (execution && typeof init.body === 'string') {
    const body = JSON.parse(init.body) as Record<string, unknown>
    await prepareExecutionSend(String(url), body, credentialPrincipal(init.headers))
  }
  if (execution?.sessionId) {
    const headers = new Headers(init.headers)
    headers.set('X-Request-Session', execution.sessionId)
    for (const name of ['x-grok-conv-id', 'x-opencode-session']) if (headers.has(name)) headers.set(name, execution.sessionId)
    if (init.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)) {
      const original = { ...init.headers } as Record<string, string>
      for (const name of ['X-Request-Session', 'x-grok-conv-id', 'x-opencode-session']) {
        const key = Object.keys(original).find(key => key.toLowerCase() === name.toLowerCase())
        if (key || name === 'X-Request-Session') original[key ?? name] = execution.sessionId
      }
      init = { ...init, headers: original }
    } else init = { ...init, headers }
  }
  let model: string | undefined
  let wireOptions: Record<string, unknown> = {}
  try { const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; model = body.model; wireOptions = Object.fromEntries(['thinking', 'reasoning', 'reasoning_effort', 'max_tokens', 'max_output_tokens', 'temperature', 'tool_choice', 'response_format'].map(key => [key, body[key]])) } catch { /* non-model request */ }
  // OpenAI chat has a richer attempt observer; other protocols use this transport observer.
  const context = { ...auditContext, configFingerprint: auditConfigFingerprint(wireOptions), model, provider: auditContext?.provider ?? (() => { try { return new URL(url).hostname } catch { return undefined } })(), purpose: auditContext?.purpose ?? 'transport_completion', sessionId: auditContext?.sessionId ?? new Headers(init.headers).get('X-Request-Session') ?? undefined }
  const audit = (model ?? execution?.model) && !String(url).includes('/chat/completions') ? beginCallAudit({ ...context, model: model ?? execution?.model }) : undefined
  if (audit && execution) execution.usageFields = {}
  // Own controller + timer instead of AbortSignal.timeout: AbortSignal.timeout
  // cannot be disarmed, so merging it into the fetch signal would keep counting
  // down through the entire body stream. A clearable timer lets us cover only
  // the pre-headers window.
  const timeoutController = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, timeoutMs)

  const combinedSignal = userSignal
    ? AbortSignal.any([userSignal, timeoutController.signal])
    : timeoutController.signal

  try {
    // API 出口默认拒绝重定向：聊天/补全端点不存在合法重定向，而 undici 跨源
    // 重定向只剥 Authorization/Cookie——Anthropic 协议的 x-api-key 会原样转发
    // 到重定向目标（凭证泄漏）。显式传 init.redirect 的调用方不受影响。
    const redirect = init.redirect ?? 'error'
    const response = await fetch(url, { ...init, redirect, signal: combinedSignal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
    return audit ? observeAuditResponse(response, context, audit) : response
  } catch (err) {
    audit?.finish({ status: userSignal?.aborted ? 'aborted' : 'failed', errorName: (err as Error).name })
    const name = (err as Error).name
    // Our pre-first-byte timeout fired. Always wrap with a descriptive message
    // so error-classifier detects it as a retryable timeout.
    if (timedOut || name === 'TimeoutError') {
      throw new Error(
        `Request timed out: server did not respond within ${Math.round(timeoutMs / 1000)} seconds`,
      )
    }
    // AbortError: user-initiated cancellation — propagate as-is (non-retryable)
    if (name === 'AbortError' || userSignal?.aborted) throw err
    // undici throws `TypeError: fetch failed` with the real network failure
    // (ECONNREFUSED / ENOTFOUND / ETIMEDOUT / TLS / proxy) buried in err.cause.
    // Surface it in the message so the TUI/desktop error line is diagnosable
    // instead of a bare "fetch failed". Original error kept as cause for the
    // classifier's cause-chain matching and for logs.
    if (err instanceof Error && /fetch failed/i.test(err.message)) {
      const detail = fetchCauseDetail(err)
      // 响应头畸形（上游网关/WAF 拼接坏了）单独点破：裸的 parser 原文
      // （"Response does not match the HTTP/1.1 protocol (Unexpected whitespace
      // after header value)"）在桌面端就是用户唯一能看到的一行，读起来像
      // 本地网络/客户端问题。前缀点明「上游响应本身畸形」，尾部保留 parser
      // 原文供提 issue 对照。`fetch failed` 前缀保留——多处匹配依赖它。
      if (detail && isHttpResponseParseFailure(detail)) {
        throw new Error(`fetch failed: upstream HTTP response malformed (gateway/WAF edge) — ${detail}`, { cause: err })
      }
      if (detail) throw new Error(`${err.message}: ${detail}`, { cause: err })
    }
    throw err
  } finally {
    // Headers arrived (or fetch failed) — disarm. Body streaming continues
    // under the caller's own signal, unaffected by this timeout.
    clearTimeout(timer)
  }
}

/**
 * 这次失败是不是「上游把 HTTP 响应头拼坏了」。
 *
 * undici 在解析响应头阶段就拒绝，错误正文是 llhttp 的原文（"Response does not
 * match the HTTP/1.1 protocol (Unexpected whitespace after header value)"）。
 * 判据用协议错误正文而不是连接类错误码：连接类（ECONNRESET 等）是**没拿到**
 * 响应，这里恰恰相反——响应到了，字节不合协议。
 */
export function isHttpResponseParseFailure(detail: string): boolean {
  return /does not match the HTTP\/1\.1 protocol|unexpected whitespace after header value|unexpected space after start line|invalid header token|HTTPParserError|HPE_[A-Z_]+/i.test(detail)
}
