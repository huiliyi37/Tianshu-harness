/**
 * ResponsesClient — OpenAI Responses API (`POST /v1/responses`) for API-key
 * endpoints, protocol `'openai-responses'` (issue #239).
 *
 * Sibling of OpenAIClient / AnthropicClient / CodexClient. The internal wire
 * shape stays `OaiChatRequest` (chat-completions-native after the 2026-05
 * migration); this client is the translation boundary:
 *   - request: system → top-level `instructions`, assistant tool_calls →
 *     top-level `function_call` items, role='tool' → `function_call_output`,
 *     tools → flat function definitions, max_tokens → max_output_tokens.
 *   - stream: `response.*` SSE events → StreamCallbacks, with the three
 *     invariants CodexClient proved in production: reasoning-before-text
 *     ordering buffer, delta/done text de-duplication, and no text loss when
 *     the provider only sends `output_item.done`.
 *
 * CodexClient (OAuth) keeps its own implementation this release; this client
 * is the generic shape it converges into (P2). While both exist, the mapping
 * tables are intentionally duplicated — change one, check the other.
 */

import { ProxyAgent } from 'undici'
import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest, OaiUserMessage } from './oai-types.js'
import type { ContentBlock, Usage } from './types.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { resolveWireEffort } from './provider.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { wireAbortToReaderCancel, wrapBodyTimeoutError } from './abort-reader.js'
import { acquireRateLimitSlot } from './rate-limiter.js'
import { repairJsonSyntax } from './json-syntax-repair.js'
import type { ProviderRetryConfig } from '../config/retry-schema.js'

export interface ResponsesClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  /** Optional auth provider (Codex-style OAuth). When set, overrides apiKey. */
  auth?: import('../auth/types.js').AuthProvider
  /** Default reasoning effort; request-level `reasoning_effort` wins. */
  reasoningEffort?: string
  /** Per-provider effort ceiling — values above this cap are clamped. */
  effortCap?: Record<string, string>
  /** Provider-level sampling temperature (injected only outside thinking mode). */
  temperature?: number
  thinking?: 'enabled' | 'disabled'
  /** Custom User-Agent for caller-identity-verifying upstreams. */
  userAgent?: string
  /** Originator header (Codex wire). Omit for generic endpoints. */
  originator?: string
  /** `store: true` lets the upstream persist the response. Default false —
   *  conversation bodies should not land on a third-party by default. */
  store?: boolean
  /** `include: ['reasoning.encrypted_content']` — stateless reasoning echo.
   *  Only meaningful with `store:false` + reasoning items replayed (P2). */
  includeEncryptedReasoning?: boolean
  firstByteTimeoutMs?: number
  thinkingStallTimeoutMs?: number
  requestTimeoutMs?: number
  maxRetries?: number
  retry?: ProviderRetryConfig
  proxy?: string
  providerName?: string
}

/** Extract reasoning tokens from a Responses usage object (`output_tokens_details.reasoning_tokens`). */
function extractReasoningTokens(usage: Record<string, unknown> | undefined): number | undefined {
  const details = usage?.output_tokens_details as Record<string, unknown> | undefined
  const reasoning = details?.reasoning_tokens
  return typeof reasoning === 'number' ? reasoning : undefined
}

/** Responses usage → internal Usage. `input_tokens_details.cached_tokens` is the
 *  auto-prefix-cache hit count; dropping it would zero out cache-log/cost for
 *  every responses-protocol provider. */
function mapResponsesUsage(usage: Record<string, unknown> | undefined): Partial<Usage> {
  const cached = (usage?.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
  return {
    input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
    output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
    cache_read_input_tokens: typeof cached === 'number' ? cached : 0,
    cache_creation_input_tokens: 0,
    reasoning_tokens: extractReasoningTokens(usage),
  }
}

function toResponsesUserContent(content: OaiUserMessage['content']): Record<string, unknown>[] {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }]
  }
  return content.map(part => part.type === 'image_url'
    ? { type: 'input_image', image_url: part.image_url.url }
    : { type: 'input_text', text: part.text })
}

export class ResponsesClient implements StreamClient {
  private readonly proxyDispatcher: ProxyAgent | undefined
  private reasoningEffort: string | undefined
  private thinking: 'enabled' | 'disabled'

  constructor(private config: ResponsesClientConfig) {
    this.proxyDispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined
    this.reasoningEffort = config.reasoningEffort
    this.thinking = config.thinking ?? 'enabled'
  }

  setReasoningEffort(effort: string): void {
    this.reasoningEffort = effort
  }

  setThinking(mode: 'enabled' | 'disabled'): void {
    this.thinking = mode
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)

    await withStructuredRetry(async () => {
      const authHeaders = this.config.auth
        ? await this.config.auth.getHeaders()
        : (this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})

      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/responses`
      // Shared lifecycle controller (same pattern as OpenAIClient/CodexClient):
      // fetch keeps the socket alive under keep-alive; the finally abort tears it down.
      const lifecycle = new AbortController()
      if (signal) {
        if (signal.aborted) lifecycle.abort()
        else signal.addEventListener('abort', () => lifecycle.abort(), { once: true })
      }
      await acquireRateLimitSlot(this.config.baseUrl, this.config.retry?.rateLimit, lifecycle.signal)
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Connection': 'Keep-Alive',
          ...(this.config.userAgent ? { 'User-Agent': this.config.userAgent } : {}),
          ...(this.config.originator ? { 'Originator': this.config.originator } : {}),
          ...authHeaders,
        },
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      }, this.config.firstByteTimeoutMs ?? 180_000, this.proxyDispatcher)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = Object.assign(
          new Error(`Responses API error (${response.status}): ${errorBody}`),
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

  private resolveEffort(requestEffort: string | undefined): string | undefined {
    const raw = requestEffort ?? this.reasoningEffort
    // 与 OpenAIClient 同一口径：内部档位 'off' 无映射时**不写该字段**——responses
    // 端点的 reasoning.effort 同样不认 'off'（issue #258 的同族漏点）。
    return resolveWireEffort(raw, this.config.effortCap)
  }

  /** Internal OaiChatRequest → Responses request body. */
  private buildRequestBody(request: OaiChatRequest): Record<string, unknown> {
    const input: Record<string, unknown>[] = []
    let instructions: string | undefined

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        instructions = (instructions ?? '') + msg.content
        continue
      }
      if (msg.role === 'user') {
        input.push({ type: 'message', role: 'user', content: toResponsesUserContent(msg.content) })
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
        }
        for (const tc of msg.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })
        }
      } else if (msg.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: msg.content })
      }
    }

    // Tools — flat shape (not the chat-completions nested {type,function}).
    const tools = request.tools?.map(t => {
      const fn = t.function
      const params = fn.parameters as Record<string, unknown> | undefined
      const properties = params?.properties as Record<string, unknown> | undefined
      const required = Array.isArray(params?.required) ? params.required as string[] : undefined
      const schema: Record<string, unknown> = {
        type: 'object',
        properties: properties ?? {},
      }
      if (required?.length) schema.required = required
      if (params?.additionalProperties !== undefined) schema.additionalProperties = params.additionalProperties
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
      store: this.config.store ?? false,
      parallel_tool_calls: true,
      max_output_tokens: request.max_tokens ?? this.config.maxTokens,
    }

    if (instructions) body.instructions = instructions

    // reasoning.effort — omitted entirely when unset so relays that reject the
    // field never see it. `max` maps through effortCap exactly like OpenAIClient.
    const effort = this.resolveEffort(request.reasoning_effort)
    if (effort) body.reasoning = { effort }

    // Temperature: request-level wins; provider default only outside thinking
    // mode (reasoning servers reject sampling params).
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    } else if (this.config.temperature !== undefined && this.thinking !== 'enabled') {
      body.temperature = this.config.temperature
    }

    if (request.response_format?.type === 'json_object') {
      body.text = { format: { type: 'json_object' } }
    }

    if (tools.length > 0) body.tools = tools

    // Forced single-function choice → Responses `{type:'function', name}` +
    // parallel_tool_calls:false. String auto/none pass through; a name not in
    // tools is ignored (same policy as CodexClient/AnthropicClient).
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

    if (this.config.includeEncryptedReasoning) {
      body.include = ['reasoning.encrypted_content']
    }

    return body
  }

  private async processSSEStream(
    response: Response,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    lifecycle?: AbortController,
  ): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let sawToolCall = false
    let incompleteReason: string | undefined
    let usage: Partial<Usage> | undefined

    // Reasoning-before-text ordering buffer: some providers emit a completed
    // message item before the reasoning item. Without buffering, the TUI shows
    // the answer first and the thinking "flashes" in after it.
    let pendingMessageItem: {
      texts: string[]
      blocks: ContentBlock[]
      itemUsage?: Record<string, unknown>
    } | null = null
    let seenReasoningItem = false
    let seenTextDelta = false
    /** output_item.done 已消费的 call_id——response.completed 的兜底解析据此去重。 */
    const emittedCallIds = new Set<string>()
    /** message 的 output_item.done 是否到过（含仍被缓冲的）——兜底解析不重复出文本。 */
    let sawMessageItemDone = false

    const flushPendingMessage = () => {
      if (!pendingMessageItem) return
      if (!seenTextDelta) {
        for (const t of pendingMessageItem.texts) callbacks.onTextDelta(t)
      }
      for (const b of pendingMessageItem.blocks) callbacks.onContentBlock(b)
      if (pendingMessageItem.itemUsage) usage = mapResponsesUsage(pendingMessageItem.itemUsage)
      pendingMessageItem = null
    }

    const firstByteTimeoutMs = this.config.firstByteTimeoutMs ?? 180_000
    const readTimeoutMs = 300_000
    // undefined = disabled (OpenAIClient semantics): reasoning models may
    // legitimately pause between reasoning segments. Providers prone to stalling
    // set provider.thinkingStallTimeoutMs explicitly.
    const thinkingStallTimeoutMs = this.config.thinkingStallTimeoutMs
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let receivedFirstChunk = false
    let receivedThinking = false
    let textReceived = false
    let receivedChars = 0

    const timeoutController = new AbortController()
    const maxStreamMs = this.config.requestTimeoutMs ?? 10 * 60_000
    const maxStreamTimer = setTimeout(() => timeoutController.abort(), maxStreamMs)
    const streamStartedAt = Date.now()

    const signalCleanup = signal
      ? wireAbortToReaderCancel(AbortSignal.any([signal, timeoutController.signal]), reader)
      : wireAbortToReaderCancel(timeoutController.signal, reader)

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const stallMs = (thinkingStallTimeoutMs !== undefined && receivedThinking && !textReceived)
        ? thinkingStallTimeoutMs
        : null
      const timeout = receivedFirstChunk ? (stallMs ?? readTimeoutMs) : firstByteTimeoutMs
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
          throw new Error(`Responses SSE stream hard timeout (${Math.round(maxStreamMs / 60_000)}min) — stream exceeded maximum duration`)
        }

        const { done, value } = await reader.read()
        // Check the timeout AFTER read: the idle timer's reader.cancel() makes
        // read() return done=true, but this must throw, not silently break.
        if (streamTimedOut) throw new Error(`Responses SSE stream idle timeout (${Math.round(readTimeoutMs / 1000)}s)`)
        if (done) break
        receivedFirstChunk = true

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        // Only real `data:` events reset the idle timer — keepalive/blank lines don't.
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
              const text = typeof parsed.delta === 'string'
                ? parsed.delta
                : (parsed.delta as Record<string, unknown> | undefined)?.text as string | undefined
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
                : (parsed.delta as Record<string, unknown> | undefined)?.text as string | undefined
              if (text) {
                receivedChars += text.length
                callbacks.onThinkingDelta(text)
              }
              break
            }

            case 'response.output_item.added': {
              const item = parsed.item as Record<string, unknown> | undefined
              if (item?.type === 'function_call') {
                sawToolCall = true
                callbacks.onToolCallDelta?.()
              }
              break
            }

            case 'response.function_call_arguments.delta': {
              sawToolCall = true
              callbacks.onToolCallDelta?.()
              break
            }

            case 'response.output_item.done': {
              const item = parsed.item as Record<string, unknown> | undefined
              if (item?.type === 'function_call') {
                sawToolCall = true
                const callId = (item.call_id as string) ?? `call_${Date.now()}`
                const name = (item.name as string) ?? ''
                const args = (item.arguments as string) ?? ''
                emittedCallIds.add(callId)
                const input = parseToolArguments(args)
                if (input) callbacks.onContentBlock({ type: 'tool_use', id: callId, name, input })
              } else if (item?.type === 'reasoning') {
                // Emit reasoning BEFORE text so the TUI captures thinking first.
                seenReasoningItem = true
                const summary = item.summary as Array<Record<string, unknown>> | undefined
                for (const s of summary ?? []) {
                  if (typeof s.text === 'string') callbacks.onThinkingDelta(s.text)
                }
                flushPendingMessage()
              } else if (item?.type === 'message') {
                sawMessageItemDone = true
                const content = item.content as Array<Record<string, unknown>> | undefined
                const itemUsage = item.usage as Record<string, unknown> | undefined
                const texts: string[] = []
                const blocks: ContentBlock[] = []
                for (const part of content ?? []) {
                  if (part.type === 'output_text' && typeof part.text === 'string') {
                    texts.push(part.text)
                    blocks.push({ type: 'text', text: part.text })
                  }
                }
                if (!seenReasoningItem) {
                  pendingMessageItem = { texts, blocks, itemUsage }
                } else {
                  if (!seenTextDelta) {
                    for (const t of texts) callbacks.onTextDelta(t)
                  }
                  for (const b of blocks) callbacks.onContentBlock(b)
                  if (itemUsage) usage = mapResponsesUsage(itemUsage)
                }
              }
              break
            }

            case 'response.completed': {
              const resp = parsed.response as Record<string, unknown> | undefined
              if (resp?.usage) usage = mapResponsesUsage(resp.usage as Record<string, unknown>)
              // 兜底：极简网关可能只发 completed（带全量 output），不发增量和
              // output_item.done。按 call_id / message 标志去重，已发过的不重发。
              for (const item of (resp?.output as Array<Record<string, unknown>> | undefined) ?? []) {
                if (item.type === 'function_call') {
                  const callId = (item.call_id as string) ?? `call_${Date.now()}`
                  if (emittedCallIds.has(callId)) continue
                  emittedCallIds.add(callId)
                  sawToolCall = true
                  const name = (item.name as string) ?? ''
                  const input = parseToolArguments((item.arguments as string) ?? '')
                  if (input) callbacks.onContentBlock({ type: 'tool_use', id: callId, name, input })
                } else if (item.type === 'message' && !seenTextDelta && !pendingMessageItem && !sawMessageItemDone) {
                  for (const part of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
                    if (part.type === 'output_text' && typeof part.text === 'string') {
                      callbacks.onTextDelta(part.text)
                      callbacks.onContentBlock({ type: 'text', text: part.text })
                    }
                  }
                }
              }
              break
            }

            case 'response.incomplete': {
              const resp = parsed.response as Record<string, unknown> | undefined
              const details = resp?.incomplete_details as Record<string, unknown> | undefined
              incompleteReason = details?.reason as string | undefined
              if (resp?.usage) usage = mapResponsesUsage(resp.usage as Record<string, unknown>)
              break
            }

            case 'response.failed': {
              const resp = parsed.response as Record<string, unknown> | undefined
              const error = resp?.error as Record<string, unknown> | undefined
              throw new Error((error?.message as string) ?? 'Responses request failed')
            }

            case 'error': {
              const rawMsg = (parsed.message as string | Record<string, unknown> | undefined)
                ?? (parsed.error as string | Record<string, unknown> | undefined)
              let msg: string
              if (typeof rawMsg === 'string') {
                msg = rawMsg
              } else if (typeof rawMsg === 'object' && rawMsg !== null) {
                const errObj = rawMsg as Record<string, unknown>
                msg = (errObj.message as string)
                  ?? (errObj.error as string)
                  ?? JSON.stringify(errObj)
              } else {
                msg = 'Unknown Responses error'
              }
              throw new Error(`Responses stream error: ${msg}`)
            }
          }
        }
        // Only real content events reset the idle timer (keepalive does not).
        if (sawDataEvent) resetIdleTimer()
      }
    } catch (err) {
      // Observability: surface how much streamed output this attempt discards.
      callbacks.onStreamAttemptAborted?.({
        provider: this.config.providerName ?? 'responses',
        receivedChars,
        elapsedMs: Date.now() - streamStartedAt,
        errorName: (err as Error)?.name ?? 'Error',
        errorMessage: (err as Error)?.message ?? String(err),
      })
      // Body-phase TimeoutError (raw undici DOMException) → descriptive,
      // classifiable Error. User AbortError and other errors pass through.
      throw wrapBodyTimeoutError(err, 'Responses', streamStartedAt)
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (maxStreamTimer) clearTimeout(maxStreamTimer)
      if (signalCleanup) signalCleanup()
      reader.releaseLock()
      // Tear down the fetch connection (same rationale as OpenAIClient).
      lifecycle?.abort()
    }

    // Flush any buffered message that arrived before reasoning (e.g. no-reasoning responses).
    flushPendingMessage()

    const stopReason = incompleteReason === 'max_output_tokens'
      ? 'max_tokens'
      : (sawToolCall ? 'tool_use' : 'end_turn')
    callbacks.onStopReason(stopReason, usage ?? mapResponsesUsage(undefined))
  }
}

/**
 * Parse a Responses function-call arguments string. Empty args mean a
 * parameter-less tool (valid `{}`); malformed JSON gets one mechanical repair
 * pass (bare quotes / trailing commas) before giving up. Returns null only when
 * the arguments are irrecoverably broken — the caller then skips the block
 * rather than crashing the whole turn.
 */
function parseToolArguments(args: string): Record<string, unknown> | null {
  const trimmed = args.trim()
  if (trimmed === '') return {}
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    const repaired = repairJsonSyntax(trimmed)
    if (!repaired) return null
    try {
      const parsed = JSON.parse(repaired)
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}
