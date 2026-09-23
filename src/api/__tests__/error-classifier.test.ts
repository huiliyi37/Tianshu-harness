import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyApiError, classifyTlsIntercept, errorRecoveryGuidance, fetchCauseDetail, parseRetryAfterMs } from '../error-classifier.js'
import type { ErrorCategory } from '../error-classifier.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mimics the ApiError class from client.ts */
class FakeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyApiError', () => {
  // ---- Status code path -------------------------------------------------

  it('classifies 429 as rate_limit with 5 retries', () => {
    const result = classifyApiError(new FakeApiError('Rate limited', 429))
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.equal(result.maxRetries, 5)
  })

  it('classifies 529 as overloaded', () => {
    const result = classifyApiError(new FakeApiError('Overloaded', 529))
    assert.equal(result.category, 'overloaded')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 503 as overloaded', () => {
    const result = classifyApiError(new FakeApiError('Service unavailable', 503))
    assert.equal(result.category, 'overloaded')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 500 as server_error', () => {
    const result = classifyApiError(new FakeApiError('Internal server error', 500))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 502 as server_error', () => {
    const result = classifyApiError(new FakeApiError('Bad gateway', 502))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
  })

  it('classifies 401 as auth_error', () => {
    const result = classifyApiError(new FakeApiError('Unauthorized', 401))
    assert.equal(result.category, 'auth_error')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies 403 as auth_error', () => {
    const result = classifyApiError(new FakeApiError('Forbidden', 403))
    assert.equal(result.category, 'auth_error')
    assert.equal(result.retryable, false)
  })

  it('classifies 408 as timeout (retryable)', () => {
    const result = classifyApiError(new FakeApiError('Request Timeout', 408))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 425 as overloaded (retryable)', () => {
    const result = classifyApiError(new FakeApiError('Too Early', 425))
    assert.equal(result.category, 'overloaded')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies 413 as image_strip (retry with image removal)', () => {
    const result = classifyApiError(new FakeApiError('Payload too large', 413))
    assert.equal(result.category, 'image_strip')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 1)
    assert.equal(result.stripImages, true)
  })

  it('classifies image processing 400 as image_strip', () => {
    const result = classifyApiError(new FakeApiError('Could not process image: bad format', 400))
    assert.equal(result.category, 'image_strip')
    assert.equal(result.retryable, true)
    assert.equal(result.stripImages, true)
  })

  it('classifies wrapped image processing 500 as image_strip', () => {
    const result = classifyApiError(new FakeApiError('upstream: 400 Bad Request: Could not process image', 500))
    assert.equal(result.category, 'image_strip')
    assert.equal(result.retryable, true)
    assert.equal(result.stripImages, true)
  })

  it('classifies unsupported image format 400 as image_strip', () => {
    const result = classifyApiError(new FakeApiError('unsupported image format', 400))
    assert.equal(result.category, 'image_strip')
    assert.equal(result.stripImages, true)
  })

  it('classifies generic 4xx as client_error', () => {
    const result = classifyApiError(new FakeApiError('Conflict', 409))
    assert.equal(result.category, 'client_error')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies generic 5xx as server_error', () => {
    const result = classifyApiError(new FakeApiError('Not implemented', 501))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  // ---- Codex-style embedded status in message ---------------------------

  it('extracts status from Codex-style "(429)" in message', () => {
    const result = classifyApiError(new Error('Codex API error (429): rate limited'))
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 5)
  })

  it('extracts status from Codex-style "(500)" in message', () => {
    const result = classifyApiError(new Error('Codex API error (500): internal'))
    assert.equal(result.category, 'server_error')
    assert.equal(result.retryable, true)
  })

  // ---- retryAfterMs override --------------------------------------------

  it('uses retryAfterMs from ApiError when available', () => {
    const result = classifyApiError(new FakeApiError('Rate limited', 429, 5000))
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryDelayMs, 5000)
  })

  // ---- Error name / message pattern path --------------------------------

  it('classifies ECONNRESET by name as timeout', () => {
    const err = new Error('connection reset')
    err.name = 'ECONNRESET'
    const result = classifyApiError(err)
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies ECONNRESET in message as timeout', () => {
    const result = classifyApiError(new Error('read ECONNRESET'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies EPIPE in message as timeout', () => {
    const result = classifyApiError(new Error('write EPIPE'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies ECONNREFUSED in message as timeout', () => {
    const result = classifyApiError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies timeout message as timeout', () => {
    const result = classifyApiError(new Error('request timed out'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies status-less service_unavailable/too busy errors as overloaded', () => {
    const result = classifyApiError(new Error(
      'OpenAI API error (service_unavailable_error): Service is too busy',
    ))
    assert.equal(result.category, 'overloaded')
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies TimeoutError by name as timeout', () => {
    const err = new Error('timeout exceeded')
    err.name = 'TimeoutError'
    const result = classifyApiError(err)
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  // 4e1aaa21 post-mortem: raw undici TimeoutError DOMException (fired by an
  // AbortSignal.timeout mid-body) must classify as retryable timeout, NOT as
  // a user AbortError (DOMException name takes precedence over instance type).
  it('classifies undici AbortSignal.timeout DOMException as retryable timeout', () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const result = classifyApiError(err)
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
  })

  it('classifies AbortError as client_error (no retry)', () => {
    const err = new DOMException('Aborted', 'AbortError')
    const result = classifyApiError(err)
    assert.equal(result.category, 'client_error')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies RequestBodyTooLargeError as context_overflow (no retry — 确定性失败)', () => {
    // 护栏的超限判定是确定性的：重试逐字节重现同一个超限体。走 unknown 兜底
    // 会白烧 2 轮 backoff 才把可行动文案还给用户（该文案原样透出，不含凭证）。
    const err = new Error('请求体 4.6MB 超出传输上限 4.0MB……')
    err.name = 'RequestBodyTooLargeError'
    const result = classifyApiError(err)
    assert.equal(result.category, 'context_overflow')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
    assert.equal(result.userMessage, err.message)
  })

  it('classifies "prompt is too long" as context_overflow', () => {
    const result = classifyApiError(new Error('prompt is too long: 200000 tokens'))
    assert.equal(result.category, 'context_overflow')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
  })

  it('classifies "context_length_exceeded" as context_overflow', () => {
    const result = classifyApiError(new Error('context_length_exceeded: max 128k'))
    assert.equal(result.category, 'context_overflow')
    assert.equal(result.retryable, false)
  })

  it('classifies stream parse errors as stream_parse', () => {
    const result = classifyApiError(new Error('failed to stream parse SSE event'))
    assert.equal(result.category, 'stream_parse')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 2)
  })

  it('classifies "invalid SSE" as stream_parse', () => {
    const result = classifyApiError(new Error('invalid SSE data received'))
    assert.equal(result.category, 'stream_parse')
    assert.equal(result.retryable, true)
  })

  // ---- undici "fetch failed" cause-chain unwrapping ----------------------
  // Node's fetch throws TypeError('fetch failed') with the real network error
  // in err.cause. It must classify as a reconnectable network failure (NOT the
  // unknown fallback whose shouldReconnect=false disables agent-level reconnect)
  // and the user message must surface the buried cause.

  it('classifies bare "fetch failed" (no cause) as reconnectable network error', () => {
    const result = classifyApiError(new TypeError('fetch failed'))
    assert.equal(result.category, 'timeout')
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.equal(result.maxRetries, 3)
  })

  it('classifies fetch failed with ECONNREFUSED cause and surfaces the detail', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 104.18.27.90:443'), { code: 'ECONNREFUSED' })
    const result = classifyApiError(new TypeError('fetch failed', { cause }))
    assert.equal(result.category, 'timeout')
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /ECONNREFUSED 104\.18\.27\.90:443/)
  })

  it('classifies fetch failed with ENOTFOUND cause (DNS) as reconnectable', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.deepseek.com'), { code: 'ENOTFOUND' })
    const result = classifyApiError(new TypeError('fetch failed', { cause }))
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /ENOTFOUND api\.deepseek\.com/)
  })

  it('unwraps nested cause chains (fetch failed → SocketError → ECONNRESET)', () => {
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const mid = new Error('other side closed', { cause: inner })
    const result = classifyApiError(new TypeError('fetch failed', { cause: mid }))
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /other side closed/)
    assert.match(result.userMessage, /ECONNRESET/)
  })

  it('unwraps AggregateError causes (Happy Eyeballs multi-address connect)', () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('connect ENETUNREACH ::1:443'), { code: 'ENETUNREACH' }),
      ],
      'connect failed',
    )
    const result = classifyApiError(new TypeError('fetch failed', { cause: agg }))
    assert.equal(result.retryable, true)
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /ETIMEDOUT 1\.2\.3\.4:443/)
  })

  it('fetchCauseDetail returns null when there is no cause', () => {
    assert.equal(fetchCauseDetail(new Error('plain')), null)
    assert.equal(fetchCauseDetail('not an error'), null)
    assert.equal(fetchCauseDetail(null), null)
  })

  // ---- TLS 证书校验失败（加密连接扫描 / 企业代理 / 服务端半截链） -----------
  // 现场形状：中间人做 HTTPS 替换 → undici 只报 "fetch failed"，证书原因在 cause
  // 链里。归类成可重试的 "Connection lost" 会让用户对着稳定复现的证书错误白等三轮
  // backoff 且看不出成因——故单列 tls_intercept；但**两种成因不能一律甩给杀毒软件**
  // （2026-09-23 跟进修），分类结果按本机探测决定重试与文案，故 helper 单测为主。

  it('检出本机加密连接扫描 → 0 次重试 + 三条本地处置（含厂商名）', () => {
    const result = classifyTlsIntercept('UNABLE_TO_VERIFY_LEAF_SIGNATURE', {
      suspectCount: 1,
      vendors: ['Kaspersky'],
    })
    assert.equal(result.category, 'tls_intercept')
    assert.equal(result.retryable, false)
    assert.equal(result.maxRetries, 0)
    assert.equal(result.shouldReconnect, false)
    assert.match(result.userMessage, /Kaspersky/)
    assert.match(result.userMessage, /NODE_EXTRA_CA_CERTS/)
    assert.match(result.userMessage, /--use-system-ca/)
  })

  it('未检出中间人 → 留 1 次重试（服务端证书链半更新重试能自愈），文案不咬定杀毒软件', () => {
    const result = classifyTlsIntercept('UNABLE_TO_VERIFY_LEAF_SIGNATURE', { suspectCount: 0, vendors: [] })
    assert.equal(result.category, 'tls_intercept')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 1)
    assert.equal(result.shouldReconnect, true)
    assert.match(result.userMessage, /服务端证书链/)
    assert.match(result.userMessage, /\/doctor/)
    // 不能把"杀毒软件"当结论：未检出时它只是可能性之一
    assert.doesNotMatch(result.userMessage, /本机系统证书存储里有/)
  })

  it('探不到（非 Windows / 存储不可读，probe=null）按未检出处理——保守重试一次', () => {
    const result = classifyTlsIntercept('SELF_SIGNED_CERT_IN_CHAIN', null)
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 1)
  })

  it('厂商名缺失时仍给出可读文案（不出现 undefined）', () => {
    const result = classifyTlsIntercept('CERT_UNTRUSTED', { suspectCount: 2, vendors: [] })
    assert.match(result.userMessage, /未知来源/)
    assert.doesNotMatch(result.userMessage, /undefined/)
  })

  it('classifyApiError 端到端：证书失败一律落 tls_intercept（不落笼统的 Connection lost）', () => {
    const cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    const result = classifyApiError(new TypeError('fetch failed', { cause }))
    assert.equal(result.category, 'tls_intercept')
    assert.match(result.userMessage, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/)
  })

  it('纯 code（message 为空）也能识别为 tls_intercept', () => {
    const cause = Object.assign(new Error(''), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })
    const result = classifyApiError(new TypeError('fetch failed', { cause }))
    assert.equal(result.category, 'tls_intercept')
  })

  it('主机名不匹配（ALTNAME）不算加密连接扫描——那是代理/CDN 配置问题', () => {
    const cause = Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    })
    const result = classifyApiError(new TypeError('fetch failed', { cause }))
    assert.notEqual(result.category, 'tls_intercept')
  })

  // ---- Fallback / edge cases --------------------------------------------

  it('classifies unknown error as unknown with retry', () => {
    const result = classifyApiError(new Error('something went wrong'))
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 2)
  })

  it('handles non-Error input (string)', () => {
    const result = classifyApiError('plain string error')
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
  })

  it('handles null input', () => {
    const result = classifyApiError(null)
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 2)
  })

  it('handles undefined input', () => {
    const result = classifyApiError(undefined)
    assert.equal(result.category, 'unknown')
    assert.equal(result.retryable, true)
  })

  it('handles plain object with status property', () => {
    const result = classifyApiError({ status: 429, message: 'rate limited' })
    assert.equal(result.category, 'rate_limit')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 5)
  })

  it('every ErrorCategory has at least one positive test', () => {
    // Verify all categories are reachable
    const categories: ErrorCategory[] = [
      'rate_limit', 'overloaded', 'server_error', 'timeout',
      'auth_error', 'client_error',
      'image_strip', 'stream_parse', 'unknown',
      // 'context_overflow' is reserved — currently no status code triggers it
      // directly (413 defaults to image_strip). Will be added when 413 message
      // disambiguation lands.
    ]
    const covered = new Set<ErrorCategory>()

    const cases: unknown[] = [
      new FakeApiError('', 429),          // rate_limit
      new FakeApiError('', 529),          // overloaded
      new FakeApiError('', 500),          // server_error
      Object.assign(new Error(''), { name: 'ECONNRESET' }), // timeout
      new FakeApiError('', 401),          // auth_error
      new FakeApiError('', 409),          // client_error
      new FakeApiError('', 413),          // image_strip
      new Error('stream parse error'),    // stream_parse
      new Error('mystery'),              // unknown
    ]

    for (const c of cases) {
      covered.add(classifyApiError(c).category)
    }

    for (const cat of categories) {
      assert.ok(covered.has(cat), `Category "${cat}" not covered`)
    }
    assert.equal(covered.size, categories.length, 'All categories covered')
  })
})

describe('parseRetryAfterMs', () => {
  it('parses numeric seconds to milliseconds', () => {
    const result = parseRetryAfterMs('30')
    assert.equal(result, 30_000)
  })

  it('parses decimal seconds to milliseconds', () => {
    const result = parseRetryAfterMs('2.5')
    assert.equal(result, 2_500)
  })

  it('parses HTTP-date format by computing delta from now', () => {
    const futureDate = new Date(Date.now() + 30_000).toUTCString()
    const result = parseRetryAfterMs(futureDate)
    assert.ok(typeof result === 'number', 'should return a number for HTTP-date')
    assert.ok(result! > 20_000 && result! < 40_000, `delta should be ~30s, got ${result}`)
  })

  it('returns undefined for past HTTP-date', () => {
    const pastDate = new Date(Date.now() - 30_000).toUTCString()
    const result = parseRetryAfterMs(pastDate)
    assert.equal(result, undefined)
  })

  it('returns undefined for non-numeric non-date string', () => {
    const result = parseRetryAfterMs('not-a-number')
    assert.equal(result, undefined)
  })

  it('returns undefined for empty string', () => {
    const result = parseRetryAfterMs('')
    assert.equal(result, undefined)
  })

  it('handles zero as zero milliseconds', () => {
    const result = parseRetryAfterMs('0')
    assert.equal(result, 0)
  })
})

describe('errorRecoveryGuidance（终态「下一步」，与重试中过程文案 userMessage 分工）', () => {
  it('429 → 限流指引（等/降档/查余额）', () => {
    const g = errorRecoveryGuidance({ status: 429, message: 'rate limited' })
    assert.match(g, /限流|额度/)
    assert.match(g, /\/model/)
  })

  it('401 → 认证指引（/connect 或 /login）', () => {
    const g = errorRecoveryGuidance({ status: 401, message: 'unauthorized' })
    assert.match(g, /\/connect/)
    assert.match(g, /\/login/)
  })

  it('网络断连（cause 链 ECONNREFUSED）→ 超时/网络指引', () => {
    const err = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED') })
    assert.match(errorRecoveryGuidance(err), /网络/)
  })

  it('上下文超限 → /compact 或 /handoff', () => {
    const g = errorRecoveryGuidance(new Error('prompt is too long: context_length_exceeded'))
    assert.match(g, /\/compact|\/handoff/)
  })

  it('404 → 模型/端点指引', () => {
    assert.match(errorRecoveryGuidance({ status: 404, message: 'not found' }), /\/model/)
  })

  it('未知错误 → 通用兜底（重发 + /doctor /logs）', () => {
    const g = errorRecoveryGuidance(new Error('weird'))
    assert.match(g, /\/doctor/)
    assert.match(g, /\/logs/)
  })
})

// ---------------------------------------------------------------------------
// 413 分流：图片过重（可剥图重发） vs 上下文超限（不可重试）
//
// wire 层无法区分二者（都是 413），区分所需的信息只有 API client 有——
// 它知道自己刚发出去的请求体里有没有 image_url。client 在错误上留
// `payloadHadImages` 标记，分类器据此分流。
// ---------------------------------------------------------------------------

describe('413 payload-shape split (image_strip vs context_overflow)', () => {
  function tagged413(payloadHadImages: boolean): Error {
    return Object.assign(new FakeApiError('Payload too large', 413), { payloadHadImages })
  }

  it('请求带图 → image_strip（剥图重发一次）', () => {
    const result = classifyApiError(tagged413(true))
    assert.equal(result.category, 'image_strip')
    assert.equal(result.retryable, true)
    assert.equal(result.maxRetries, 1)
    assert.equal(result.stripImages, true)
  })

  it('请求无图 → context_overflow，不可重试（重发同样的体必然再 413）', () => {
    const result = classifyApiError(tagged413(false))
    assert.equal(result.category, 'context_overflow')
    assert.equal(result.retryable, false, '纯上下文超限重发无意义')
    assert.equal(result.maxRetries, 0)
    assert.equal(result.stripImages, undefined, '无图可剥，不得承诺剥离')
  })

  it('无标记（第三方网关转述 413）→ 保持乐观的 image_strip', () => {
    const result = classifyApiError(new FakeApiError('Payload too large (413)', 413))
    assert.equal(result.category, 'image_strip')
    assert.equal(result.retryable, true)
  })

  it('无图 413 的用户指引指向压缩上下文，不是「去掉图片」', () => {
    const guidance = errorRecoveryGuidance(tagged413(false))
    assert.ok(guidance.includes('/compact'), `应指引压缩上下文，实得：${guidance}`)
    assert.ok(!guidance.includes('图片'), `无图请求不该被指点去删图，实得：${guidance}`)
  })

  it('有图 413 的用户指引仍指向图片', () => {
    const guidance = errorRecoveryGuidance(tagged413(true))
    assert.ok(guidance.includes('图片'), `实得：${guidance}`)
  })
})

// ── issue #258 ②：网关要求回传 reasoning_content ─────────────────────────────
// 托管 DeepSeek 思考模型的网关会拒收「历史里被剥掉思考内容」的请求：
//   The `reasoning_content` in the thinking mode must be passed back to the API.
// 这是 400 —— 默认落 client_error（不可重试），但这条**只能靠重试修**（client 把
// 思考内容保留后重发即可通过），所以必须早于状态码分类，且带一次性语义。

describe('reasoning_echo classification (issue #258)', () => {
  it('classifies the DeepSeek wording as reasoning_echo and makes it retryable', () => {
    const result = classifyApiError(new FakeApiError(
      'OpenAI API error (invalid_request_error): The `reasoning_content` in the thinking mode must be passed back to the API.',
      400,
    ))
    assert.equal(result.category, 'reasoning_echo')
    assert.equal(result.retryable, true, '400 默认不可重试，这一类必须例外')
    assert.equal(result.preserveReasoning, true)
    assert.equal(result.maxRetries, 1, '一次性：改一次 wire 形态，成功即结束')
    assert.equal(result.retryDelayMs, 0)
  })

  it('classifies the gateway-relayed wording (no backticks/caps variance)', () => {
    const result = classifyApiError(new FakeApiError(
      'Upstream request failed: invalid_request_error: reasoning_content must be passed back',
      400,
    ))
    assert.equal(result.category, 'reasoning_echo')
    assert.equal(result.preserveReasoning, true)
  })

  it('does not hijack unrelated 400s that merely mention reasoning', () => {
    const result = classifyApiError(new FakeApiError('reasoning_effort: unknown variant `off`', 400))
    assert.notEqual(result.category, 'reasoning_echo')
    assert.equal(result.category, 'client_error')
  })

  it('recovery guidance tells the user how to skip the wasted retry', () => {
    const guidance = errorRecoveryGuidance(new FakeApiError(
      'The `reasoning_content` in the thinking mode must be passed back to the API.',
      400,
    ))
    assert.match(guidance, /preservedThinkingProtocol/)
  })
})
