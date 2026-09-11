import type { StreamClient } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import type { ContentBlock } from './types.js'
import type { StreamCallbacks } from './stream-client.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { wireAbortToReaderCancel, wrapBodyTimeoutError } from './abort-reader.js'
import { acquireRateLimitSlot } from './rate-limiter.js'
import type { ProviderRetryConfig } from '../config/retry-schema.js'

export interface CodexClientConfig {
  baseUrl: string
  model: string
  maxTokens: number
  auth?: import('../auth/types.js').AuthProvider
  /** 显式重试上限；undefined = 分类器 per-category 默认（显式值不再被夹取），0 = 禁用。 */
  maxRetries?: number
  /** Provider-level retry policy (issue #75)：退避曲线 / 类别覆盖 / 客户端限速。
   *  undefined = 历史行为（分类器固定延迟 + 内置预算）。 */
  retry?: ProviderRetryConfig
}

const CODEX_USER_AGENT = 'codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9'
const CODEX_ORIGINATOR = 'codex_cli_rs'

/**
 * Extract reasoning tokens from a Responses-API usage object.
 * The Responses API nests it under `output_tokens_details.reasoning_tokens`
 * (a subset of output_tokens). Returns undefined when absent.
 */
function extractReasoningTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage.output_tokens_details as Record<string, unknown> | undefined
  const reasoning = details?.reasoning_tokens
  return typeof reasoning === 'number' ? reasoning : undefined
}

export class CodexClient implements StreamClient {
  constructor(private config: CodexClientConfig) {}

  setReasoningEffort(_effort: string): void {}

  setThinking(_mode: 'enabled' | 'disabled'): void {}

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)

    await withStructuredRetry(async () => {
      const authHeaders = this.config.auth
        ? await this.config.auth.getHeaders()
        : {}

      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/responses`
      // 共享 lifecycle controller（见 openai-client 同名注释）：传给 fetch，
      // 由外部 signal 联动并在 processSSEStream 的 finally 中 abort，确保 keep-alive
      // 下连接被真正拆除。
      const lifecycle = new AbortController()
      if (signal) {
        if (signal.aborted) lifecycle.abort()
        else signal.addEventListener('abort', () => lifecycle.abort(), { once: true })
      }
      // 客户端限速（未配置 rateLimit 时零开销）：同 provider 的所有 client 实例共享一只桶。
      await acquireRateLimitSlot(this.config.baseUrl, this.config.retry?.rateLimit, lifecycle.signal)
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': CODEX_USER_AGENT,
          'Originator': CODEX_ORIGINATOR,
          'Accept': 'text/event-stream',
          'Connection': 'Keep-Alive',
          ...authHeaders,
        },
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      }, 180_000)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = Object.assign(
          new Error(`Codex API error (${response.status}): ${errorBody}`),
          { status: response.status },
        )
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) {
          const retryAfterMs = parseRetryAfterMs(retryAfter)
          if (retryAfterMs !== undefined) {
            ;(err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs
          }
        }
        throw err
      }

      await this.processSSEStream(response, callbacks, signal, lifecycle)
    }, signal, {
      maxTotalDurationMs: this.config.retry?.maxTotalDurationMs ?? 10 * 60_000,
      maxTotalRetries: this.config.maxRetries,
      policy: this.config.retry,
      onRetry: (info) => {
        if (info.classified.category === 'rate_limit') {
          callbacks.onRateLimit?.(info.classified.retryDelayMs)
        }
      },
    })
  }

  private buildRequestBody(request: OaiChatRequest): Record<string, unknown> {
    const input: Record<string, unknown>[] = []

    // System message → top-level `instructions` (Codex Responses API requirement)
    let instructions: string | undefined
    // Find system messages and extract instructions
    const nonSystemMessages = request.messages.filter(m => {
      if (m.role === 'system') {
        instructions = (instructions ?? '') + m.content
        return false
      }
      return true
    })

    // Messages — function_call and function_call_output are top-level input items
    for (const msg of nonSystemMessages) {
      if (msg.role === 'user') {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: msg.content }] })
      } else if (msg.role === 'assistant') {
        const textContent = msg.content ?? ''
        if (textContent) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textContent }] })
        }
        // Tool calls → top-level function_call items
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            })
          }
        }
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: msg.content,
        })
      }
    }

    // Tools
    const tools = request.tools?.map(t => {
      const fn = t.function
      const params = fn.parameters as Record<string, unknown> | undefined
      const properties = params?.properties as Record<string, unknown> | undefined
      const required = Array.isArray(params?.required) ? params.required as string[] : undefined
      const schema: Record<string, unknown> = {
        type: 'object',
        properties: properties ?? {},
      }
      if (required?.length) {
        schema.required = required
      }
      if (params?.additionalProperties !== undefined) {
        schema.additionalProperties = params.additionalProperties
      }
      return {
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: schema,
        strict: false,
      }
    }) ?? []

    const body: Record<string, unknown> = {
      model: this.config.model,
      input,
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
    }

    if (instructions) {
      body.instructions = instructions
    }

    if (tools.length > 0) {
      body.tools = tools
    }

    // OAI 对象形式 tool_choice（{type:'function',function:{name}}）映射为
    // Responses API 强制函数选择 { type:'function', name }（W2E）。auto/none
    // 字符串原生透传（Responses API 接受 "auto"/"none"）。强制选择只允许单函数：
    // parallel_tool_calls 置 false。指定函数不在 tools 中时忽略（避免把不存在的
    // 函数强塞给 API，与 anthropic-client W2D 同策略）。
    if (request.tool_choice && tools.length > 0) {
      if (typeof request.tool_choice === 'object') {
        const name = request.tool_choice.function.name
        if (tools.some(t => t.name === name)) {
          body.tool_choice = { type: 'function', name }
          body.parallel_tool_calls = false
        }
      } else {
        body.tool_choice = request.tool_choice
      }
    }

    return body
  }

  private async processSSEStream(
    response: Response,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    /** 共享 lifecycle controller：finally 中 abort 以拆 fetch 连接。见 stream() 注释。 */
    lifecycle?: AbortController,
  ): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: string | null = null
    let usage: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number } | undefined

    // Track function calls by index
    const functionCalls = new Map<number, { id: string; name: string; arguments: string }>()

    // Reasoning-before-text ordering buffer.
    // DeepSeek Codex API may emit output_item.done (message) before
    // output_item.done (reasoning). Without buffering, the TUI shows
    // text first, then reasoning "flashes" in after — breaking the
    // expected thinking→answer order. We buffer the message item
    // until either a reasoning item arrives or the stream ends.
    let pendingMessageItem: {
      texts: string[]
      blocks: ContentBlock[]
      msgUsage?: Record<string, unknown>
    } | null = null
    let seenReasoningItem = false
    let seenTextDelta = false

    const flushPendingMessage = () => {
      if (!pendingMessageItem) return
      if (!seenTextDelta) {
        for (const t of pendingMessageItem.texts) {
          callbacks.onTextDelta(t)
        }
      }
      for (const b of pendingMessageItem.blocks) {
        callbacks.onContentBlock(b)
      }
      if (pendingMessageItem.msgUsage) {
        usage = {
          input_tokens: pendingMessageItem.msgUsage.input_tokens as number,
          output_tokens: pendingMessageItem.msgUsage.output_tokens as number,
          reasoning_tokens: extractReasoningTokens(pendingMessageItem.msgUsage),
        }
      }
      pendingMessageItem = null
    }

    // SSE idle timeout — same pattern as ApiClient and OpenAIClient
    // Codex always uses reasoning (effort: high), so first-byte can be slow.
    // GPT-5.5 thinking can exceed 3 min; match OpenAIClient slow-provider caps.
    const FIRST_BYTE_TIMEOUT_MS = 180_000
    const READ_TIMEOUT_MS = 300_000
    // Thinking-stall timeout: once reasoning items have been received but no
    // text content yet, use a shorter timeout to catch stalled thinking.
    // Same rationale as OpenAIClient — Codex always reasons, so this is
    // even more relevant here. 90s is generous for legitimate pauses.
    const THINKING_STALL_TIMEOUT_MS = 90_000
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let receivedFirstChunk = false
    let receivedThinking = false
    let textReceived = false
    /** Chars streamed this attempt (reasoning + text) — reported when the attempt aborts. */
    let receivedChars = 0

    // Wire external abort signal to reader.cancel() (same fix as OpenAIClient).

    // Hard timeout guarantee: ensures reader.read() is unblocked even if
    // reader.cancel() alone cannot break the TCP connection (keep-alive hang).
    // Matches the OpenAIClient pattern — max stream duration = 10 minutes.
    const timeoutController = new AbortController()
    const maxStreamMs = 10 * 60_000
    const maxStreamTimer = setTimeout(() => timeoutController.abort(), maxStreamMs)
    const streamStartedAt = Date.now()

    const signalCleanup = signal
      ? wireAbortToReaderCancel(AbortSignal.any([signal, timeoutController.signal]), reader)
      : wireAbortToReaderCancel(timeoutController.signal, reader)

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      // Thinking-stall detection: once reasoning arrived but no text yet,
      // use shorter timeout to catch stalled thinking streams.
      const thinkingStallMs = (receivedThinking && !textReceived)
        ? THINKING_STALL_TIMEOUT_MS
        : null
      const timeout = receivedFirstChunk
        ? (thinkingStallMs ?? READ_TIMEOUT_MS)
        : FIRST_BYTE_TIMEOUT_MS
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, timeout)
    }

    try {
      resetIdleTimer()
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (timeoutController.signal.aborted) {
          throw new Error('Codex SSE stream hard timeout (10min) — stream exceeded maximum duration')
        }

        const { done, value } = await reader.read()
        // Check timeout AFTER read — reader.cancel() from idle timer causes
        // read() to return done=true, but we must throw, not silently break.
        if (streamTimedOut) throw new Error('Codex SSE stream idle timeout (300s)')
        if (done) break
        receivedFirstChunk = true

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        // keepalive 感知：只有真实 `data: ` 事件才重置 idle timer，心跳/空行不重置。
        let sawDataEvent = false
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue
          sawDataEvent = true

          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(data)
          } catch {
            continue
          }

          const type = parsed.type as string

          switch (type) {
            case 'response.output_text.delta': {
              seenTextDelta = true
              textReceived = true
              // delta is a plain string, not { text: "..." }
              const text = typeof parsed.delta === 'string'
                ? parsed.delta
                : (parsed.delta as Record<string, unknown>)?.text as string | undefined
              if (text) {
                receivedChars += text.length
                callbacks.onTextDelta(text)
              }
              break
            }

            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta': {
              seenReasoningItem = true
              receivedThinking = true
              const text = typeof parsed.delta === 'string'
                ? parsed.delta
                : (parsed.delta as Record<string, unknown>)?.text as string | undefined
              if (text) {
                receivedChars += text.length
                callbacks.onThinkingDelta(text)
              }
              break
            }

            case 'response.output_item.added': {
              const item = parsed.item as Record<string, unknown> | undefined
              if (item?.type === 'function_call') callbacks.onToolCallDelta?.()
              break
            }

            case 'response.function_call_arguments.delta': {
              callbacks.onToolCallDelta?.()
              break
            }

            case 'response.output_item.done': {
              const item = parsed.item as Record<string, unknown> | undefined
              if (item?.type === 'function_call') {
                const callId = (item.call_id as string) ?? `call_${functionCalls.size}`
                const name = item.name as string ?? ''
                const args = item.arguments as string ?? ''
                functionCalls.set(functionCalls.size, { id: callId, name, arguments: args })
                try {
                  const input = JSON.parse(args)
                  callbacks.onContentBlock({ type: 'tool_use', id: callId, name, input })
                } catch {}
              } else if (item?.type === 'reasoning') {
                // Reasoning item — emit BEFORE text so TUI captures thinking first.
                // The summary array contains sanitized reasoning content.
                seenReasoningItem = true
                const summary = item.summary as Array<Record<string, unknown>> | undefined
                if (summary) {
                  for (const s of summary) {
                    if (typeof s.text === 'string') {
                      callbacks.onThinkingDelta(s.text)
                    }
                  }
                }
                // Flush any buffered message that arrived before reasoning
                flushPendingMessage()
              } else if (item?.type === 'message') {
                // Text message — buffer if reasoning hasn't arrived yet,
                // otherwise emit immediately.
                const content = item.content as Array<Record<string, unknown>> | undefined
                const msgUsage = item.usage as Record<string, unknown> | undefined

                if (!seenReasoningItem) {
                  // Buffer: reasoning hasn't arrived, hold this message
                  const texts: string[] = []
                  const blocks: ContentBlock[] = []
                  if (content) {
                    for (const part of content) {
                      if (part.type === 'output_text' && typeof part.text === 'string') {
                        texts.push(part.text)
                        blocks.push({ type: 'text', text: part.text })
                      }
                    }
                  }
                  pendingMessageItem = { texts, blocks, msgUsage }
                } else {
                  // Emit immediately: reasoning already seen
                  if (content) {
                    for (const part of content) {
                      if (part.type === 'output_text' && typeof part.text === 'string') {
                        if (!seenTextDelta) callbacks.onTextDelta(part.text)
                        callbacks.onContentBlock({ type: 'text', text: part.text })
                      }
                    }
                  }
                  if (msgUsage) {
                    usage = {
                      input_tokens: msgUsage.input_tokens as number,
                      output_tokens: msgUsage.output_tokens as number,
                      reasoning_tokens: extractReasoningTokens(msgUsage),
                    }
                  }
                }
              }
              break
            }

            case 'response.completed': {
              const resp = parsed.response as Record<string, unknown> | undefined
              if (resp?.usage) {
                const u = resp.usage as Record<string, unknown>
                usage = {
                  input_tokens: u.input_tokens as number,
                  output_tokens: u.output_tokens as number,
                  reasoning_tokens: extractReasoningTokens(u),
                }
              }
              stopReason = 'stop'
              break
            }

            case 'response.failed': {
              const resp = parsed.response as Record<string, unknown> | undefined
              const error = resp?.error as Record<string, unknown> | undefined
              const msg = error?.message as string ?? 'Codex request failed'
              throw new Error(msg)
            }

            case 'error': {
              const rawMsg = (parsed.message as string | Record<string, unknown> | undefined)
                ?? (parsed.error as string | Record<string, unknown> | undefined)
              let msg: string
              if (typeof rawMsg === 'string') {
                msg = rawMsg
              } else if (typeof rawMsg === 'object' && rawMsg !== null) {
                // Error object may contain nested message/error fields
                const errObj = rawMsg as Record<string, unknown>
                msg = (errObj.message as string)
                  ?? (errObj.error as string)
                  ?? JSON.stringify(errObj)
              } else {
                msg = 'Unknown Codex error'
              }
              throw new Error(`Codex stream error: ${msg}`)
            }
          }
        }
        // 仅在收到真实内容事件时重置 idle timer（心跳不重置）
        if (sawDataEvent) resetIdleTimer()
      }
    } catch (err) {
      // Observability: surface how much streamed output this attempt discards.
      callbacks.onStreamAttemptAborted?.({
        provider: 'codex',
        receivedChars,
        elapsedMs: Date.now() - streamStartedAt,
        errorName: (err as Error)?.name ?? 'Error',
        errorMessage: (err as Error)?.message ?? String(err),
      })
      // Body-phase TimeoutError (raw undici DOMException) → descriptive,
      // classifiable Error. User AbortError and other errors pass through.
      throw wrapBodyTimeoutError(err, 'Codex', streamStartedAt)
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (maxStreamTimer) clearTimeout(maxStreamTimer)
      if (signalCleanup) signalCleanup()
      reader.releaseLock()
      // 拆 fetch 连接（见 openai-client 同名注释）。
      lifecycle?.abort()
    }

    // Flush any buffered message that arrived before reasoning (e.g. no-reasoning responses)
    flushPendingMessage()

    callbacks.onStopReason(stopReason ?? 'stop', {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: usage?.reasoning_tokens,
    })
  }
}
