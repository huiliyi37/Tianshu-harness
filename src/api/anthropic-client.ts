import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest, OaiMessage } from './oai-types.js'
import { oaiMessagesHaveImageParts, stripOaiImageParts } from './oai-types.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { wireAbortToReaderCancel, wrapBodyTimeoutError } from './abort-reader.js'
import { parseJsonObjectWithEscapeRepair } from './json-escape-repair.js'
import { ProxyAgent } from 'undici'

export interface AnthropicClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  thinkingBudget?: number
  /** 总时限（ms）：替换内置 10min 硬顶，显式配置即严格。 */
  requestTimeoutMs?: number
  /** 重试次数覆盖；undefined = 内置默认（5），0 = 禁用。 */
  maxRetries?: number
  /** 采样温度默认值（clamp 到 Anthropic 合法的 0–1）；thinking 启用时不注入
   *  （Anthropic 要求 thinking 请求 temperature=1）。 */
  temperature?: number
  /** Per-provider HTTP proxy（优先于全局 network.proxy）。 */
  proxy?: string
  /** Custom User-Agent — providers that verify caller identity (OpenCode Go
   *  rejects generic SDK/HTTP-library names) declare it via catalog wire. */
  userAgent?: string
  /** Stable per-conversation session ID (cache/routing affinity). */
  sessionId?: string
  /** Header name carrying sessionId. Default 'X-Request-Session'; OpenCode Go
   *  mandates 'x-opencode-session' and 400s without it. */
  sessionHeader?: string
}

interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  source?: { type: 'base64'; media_type: string; data: string }
  cache_control?: { type: 'ephemeral'; ttl?: '1h' }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

interface AnthropicRequestBody {
  model: string
  max_tokens: number
  system?: AnthropicContentBlock[]
  tools?: Array<{
    name: string
    description?: string
    input_schema: Record<string, unknown>
    cache_control?: { type: 'ephemeral'; ttl?: '1h' }
  }>
  messages: AnthropicMessage[]
  stream: boolean
  thinking?: { type: 'enabled'; budget_tokens: number }
  temperature?: number
  tool_choice?: { type: 'tool'; name: string }
}

/**
 * 折叠连续同角色消息为一条（content blocks 按序拼接）。
 *
 * Anthropic 官方 API 对连续同角色自动合并（"Consecutive user or assistant
 * turns in your request will be combined into a single turn"），但严格兼容
 * 实现（AWS Bedrock 等）直接 400 "roles must alternate between user and
 * assistant"。客户端主动折叠 = 官方合并语义的显式化：对官方零行为差异，
 * 对严格实现消除假崩；且折叠是确定性纯函数——跨请求字节稳定，不影响
 * prompt cache。
 *
 * 触发来源之一：ceiling checkpoint 结构（59205b109）
 * [anchors…, assistant(handoff), user(原文), user(task-anchor appendix)]
 * 天然含连续 assistant / 连续 user。
 */
function foldConsecutiveSameRole(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const msg of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === msg.role) {
      prev.content.push(...msg.content)
    } else {
      out.push({ role: msg.role, content: [...msg.content] })
    }
  }
  return out
}

export class AnthropicClient implements StreamClient {
  /** undici ProxyAgent for config.proxy (undefined = no per-provider proxy). */
  private readonly proxyDispatcher: ProxyAgent | undefined

  constructor(private config: AnthropicClientConfig) {
    this.proxyDispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined
  }

  setReasoningEffort(_effort: string): void {
    // Anthropic doesn't use reasoning_effort — thinking budget is set at construction
  }

  setThinking(_mode: 'enabled' | 'disabled'): void {
    // Anthropic thinking is controlled via budget_tokens, not a toggle
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    // image_strip recovery state — see openai-client.sendStream for the flow:
    // first request sends images; on a 413 / image-rejection retry the images
    // are dropped and resent once; any further image_strip error is rethrown.
    const messagesHaveImages = oaiMessagesHaveImageParts(request.messages)
    let stripRequested = false
    let imagesStripped = false

    await withStructuredRetry(async () => {
      const body = this.buildRequestBody(request, {
        stripImages: stripRequested && !imagesStripped,
      })
      if (stripRequested && !imagesStripped) {
        imagesStripped = true
      }
      // 共享 lifecycle controller（见 openai-client 同名注释）：传给 fetch，
      // 由外部 signal 联动并在 processSSEStream 的 finally 中 abort。
      const lifecycle = new AbortController()
      if (signal) {
        if (signal.aborted) lifecycle.abort()
        else signal.addEventListener('abort', () => lifecycle.abort(), { once: true })
      }
      const response = await fetchWithTimeout(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Accept': 'text/event-stream',
          ...(this.config.userAgent ? { 'User-Agent': this.config.userAgent } : {}),
          ...(this.config.sessionId
            ? { [this.config.sessionHeader ?? 'X-Request-Session']: this.config.sessionId }
            : {}),
        },
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      }, this.config.thinkingBudget && this.config.thinkingBudget > 0 ? 90_000 : 45_000, this.proxyDispatcher)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = Object.assign(
          new Error(`Anthropic API error (${response.status}): ${errorBody}`),
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
      maxTotalDurationMs: 10 * 60_000,
      // provider 级 maxRetries 显式配置时覆盖内置默认（0 = 禁用重试）。
      maxTotalRetries: this.config.maxRetries,
      onRetry: (info) => {
        if (info.classified.category === 'rate_limit') {
          callbacks.onRateLimit?.(info.classified.retryDelayMs)
        }
        if (info.classified.category === 'image_strip') {
          // Nothing to strip (no image parts) or already stripped once → the
          // retry cannot help; surface the original 413 / image error now.
          if (imagesStripped || !messagesHaveImages) {
            return false
          }
          // First image_strip retry: drop images on the next attempt.
          stripRequested = true
        }
      },
    })
  }

  /** Exposed for testing. */
  buildRequestBodyForTest(request: OaiChatRequest): AnthropicRequestBody {
    return this.buildRequestBody(request)
  }

  private buildRequestBody(
    request: OaiChatRequest,
    opts: { stripImages?: boolean } = {},
  ): AnthropicRequestBody {
    // Extract system messages to top-level system array
    let systemText = ''
    const srcMessages = opts.stripImages
      ? stripOaiImageParts(request.messages).messages
      : request.messages
    const nonSystemMessages = srcMessages.filter(m => {
      if (m.role === 'system') {
        systemText += (systemText ? '\n\n' : '') + m.content
        return false
      }
      return true
    })

    const system: AnthropicContentBlock[] = systemText
      ? [{ type: 'text', text: systemText }]
      : []

    // Convert messages, then fold consecutive same-role runs into a single
    // message（严格 Anthropic 实现要求角色交替；官方 API 会自动合并，客户端
    // 折叠 = 官方语义显式化）。BP 计算必须基于折叠后的形态——cache_control
    // 依附加在 block 上，折叠只改消息边界、不动 block 序列。
    const messages = foldConsecutiveSameRole(nonSystemMessages.map(m => this.convertMessage(m)))

    // Convert tools — sorted by name for deterministic cache
    const tools: AnthropicRequestBody['tools'] = request.tools && request.tools.length > 0
      ? [...request.tools]
          .sort((a, b) => a.function.name.localeCompare(b.function.name))
          .map(t => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          }))
      : undefined

    const body: AnthropicRequestBody = {
      // 空 model 回退到 client 绑定值（侧路调用契约，同 openai-client）。
      model: request.model || this.config.model,
      max_tokens: request.max_tokens ?? this.config.maxTokens,
      messages,
      stream: true,
    }

    if (system.length > 0) body.system = system
    if (tools) body.tools = tools
    if (this.config.thinkingBudget && this.config.thinkingBudget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: this.config.thinkingBudget }
    } else if (this.config.temperature !== undefined) {
      // provider 级采样温度默认值；Anthropic 合法范围 0–1（config 层允许 0–2）。
      // thinking 启用时不注入——Anthropic 要求 thinking 请求 temperature=1。
      body.temperature = Math.max(0, Math.min(1, this.config.temperature))
    }

    // OAI 对象形式 tool_choice（{type:'function',function:{name}}）映射为
    // Anthropic { type:'tool', name }。auto/none 是 Anthropic 默认行为，不产生字段；
    // 指定函数不在 tools 中时忽略（避免把不存在的函数强塞给 API）。
    if (request.tool_choice && typeof request.tool_choice === 'object' && tools) {
      const name = request.tool_choice.function.name
      if (tools.some(t => t.name === name)) {
        body.tool_choice = { type: 'tool', name }
      }
    }

    // ── Four cache_control breakpoints ──────────────────────────────
    // BP1: last tool definition (1h TTL — tools rarely change)
    if (tools && tools.length > 0) {
      tools[tools.length - 1]!.cache_control = { type: 'ephemeral', ttl: '1h' }
    }

    // BP2: last system content block (1h TTL — system prompt is static)
    if (system.length > 0) {
      system[system.length - 1]!.cache_control = { type: 'ephemeral', ttl: '1h' }
    }

    // BP3 & BP4: locate target positions in messages
    let firstUserIdx = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'user') {
        firstUserIdx = i
        break
      }
    }

    // BP3: last content block of first user message (project-instructions + session-memory)
    if (firstUserIdx >= 0) {
      const blocks = messages[firstUserIdx]!.content
      if (blocks.length > 0) {
        blocks[blocks.length - 1]!.cache_control = { type: 'ephemeral' }
      }
    }

    // BP4: rolling breakpoint — farthest assistant message whose last content
    // block is within MAX_LOOKBACK blocks of the end of messages.
    //
    // Anthropic's prompt cache has a hard 20-block lookback window: a cached
    // prefix is only reachable if its last block is within 20 blocks of the
    // current request end. We use a 15-block placement threshold (rather than
    // the full 20) because BP4 is re-evaluated on every request — the next
    // request may grow the message array, and a breakpoint placed at the
    // boundary (fromEnd=20) would immediately fall out of the window.
    //
    // In long multi-turn conversations with many tool_use/tool_result blocks
    // (each tool call = 2 blocks), this rolling strategy picks the farthest
    // assistant still safely within the window, maximizing cached prefix.
    // Excludes the BP3 target message to avoid wasting a breakpoint on overlap.
    const MAX_LOOKBACK = 15

    let totalBlocks = 0
    for (const msg of messages) {
      totalBlocks += msg.content.length
    }

    let bp4Idx = -1
    let blockPos = 0
    for (let i = 0; i < messages.length; i++) {
      blockPos += messages[i]!.content.length
      if (messages[i]!.role === 'assistant' && i !== firstUserIdx) {
        const fromEnd = totalBlocks - blockPos
        if (fromEnd < MAX_LOOKBACK) {
          bp4Idx = i
          break // first qualifying = farthest from end within window
        }
      }
    }

    if (bp4Idx >= 0) {
      const bp4Blocks = messages[bp4Idx]!.content
      if (bp4Blocks.length > 0) {
        bp4Blocks[bp4Blocks.length - 1]!.cache_control = { type: 'ephemeral' }
      }
    }

    return body
  }

  private convertMessage(msg: OaiMessage): AnthropicMessage {
    if (msg.role === 'user') {
      // Multimodal: pass through content parts; Anthropic supports native image_url.
      if (Array.isArray(msg.content)) {
        return {
          role: 'user',
          content: msg.content.map(p => {
            if (p.type === 'text') return { type: 'text', text: p.text }
            // Convert OpenAI image_url format to Anthropic's image block format.
            const url = p.image_url.url
            const m = url.match(/^data:(image\/[a-z+]+);base64,(.+)$/)
            if (m) return { type: 'image', source: { type: 'base64', media_type: m[1]!, data: m[2]! } }
            return { type: 'text', text: `[unsupported image: ${url.slice(0, 50)}]` }
          }),
        }
      }
      return {
        role: 'user',
        content: [{ type: 'text', text: msg.content }],
      }
    }

    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
      }
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []

      // Anthropic API rejects requests that contain `thinking` content blocks
      // in the message history — they are model-output only. Merge previous
      // reasoning into the text block instead of sending a `thinking` block.
      let text = msg.content ?? ''
      if (msg.reasoning_content) {
        text = `<thinking>\n${msg.reasoning_content}\n</thinking>\n\n${text}`
      }

      if (text) {
        blocks.push({ type: 'text', text })
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const input: Record<string, unknown> = parseJsonObjectWithEscapeRepair(tc.function.arguments) ?? {}
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
      }

      return { role: 'assistant', content: blocks }
    }

    // Fallback — types are exhaustive, this path should be unreachable.
    // Throw explicitly so new role types added to OaiMessage are caught
    // at development time rather than silently producing empty messages.
    throw new Error(`Unsupported message role in AnthropicClient: ${JSON.stringify(msg)}`)
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
    let usage: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    } = {}

    // Accumulators for content blocks
    const textBlocks: string[] = []
    const thinkingBlocks: string[] = []
    // Tool use buffering: Anthropic streams tool_use parameters as
    // incremental input_json_delta chunks. We accumulate by block index
    // and emit the complete tool_use only on content_block_stop.
    const toolUseBuffer = new Map<number, { id: string; name: string; partialJson: string }>()

    // SSE idle timeout — same pattern as OpenAIClient and CodexClient.
    // Non-thinking requests use shorter timeouts (45s/120s) for faster
    // failure detection; extended-thinking requests use 90s/180s to
    // accommodate long first-byte delays from reasoning.
    const FIRST_BYTE_TIMEOUT_MS = (this.config.thinkingBudget && this.config.thinkingBudget > 0) ? 90_000 : 45_000
    const READ_TIMEOUT_MS = (this.config.thinkingBudget && this.config.thinkingBudget > 0) ? 180_000 : 120_000
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let receivedFirstChunk = false
    /** Chars streamed this attempt (reasoning + text) — reported when the attempt aborts. */
    let receivedChars = 0

    // Wire external abort signal to reader.cancel() so that agent.abort()
    // can interrupt a blocking reader.read() call (same fix as OpenAIClient).

    // Hard timeout guarantee: ensures reader.read() is unblocked even if
    // reader.cancel() alone cannot break the TCP connection (keep-alive hang).
    // Matches the OpenAIClient pattern — max stream duration = 10 minutes.
    // provider 级 requestTimeoutMs 显式配置时替换内置 10min。
    const timeoutController = new AbortController()
    const maxStreamMs = this.config.requestTimeoutMs ?? 10 * 60_000
    const maxStreamTimer = setTimeout(() => timeoutController.abort(), maxStreamMs)
    const streamStartedAt = Date.now()

    const signalCleanup = signal
      ? wireAbortToReaderCancel(AbortSignal.any([signal, timeoutController.signal]), reader)
      : wireAbortToReaderCancel(timeoutController.signal, reader)

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const timeout = receivedFirstChunk ? READ_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, timeout)
    }

    try {
      resetIdleTimer()
      // 硬顶 abort 可能发生在 reader.read() 阻塞期间——cancel() 让 read() 以
      // done=true 返回，若不在此显式抛出会变成"静默正常结束"，严格时限形同虚设。
      const throwIfHardCapAborted = (): void => {
        if (!timeoutController.signal.aborted) return
        throw new Error(this.config.requestTimeoutMs !== undefined
          ? `Anthropic SSE stream request timeout (${Math.round(this.config.requestTimeoutMs / 1000)}s, provider requestTimeoutMs) — total request duration exceeded configured limit`
          : 'Anthropic SSE stream hard timeout (10min) — stream exceeded maximum duration')
      }
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        throwIfHardCapAborted()

        const { done, value } = await reader.read()
        // Check timeout AFTER read — reader.cancel() from idle timer causes
        // read() to return done=true, but we must throw, not silently break.
        if (streamTimedOut) throw new Error('Anthropic SSE stream idle timeout (180s)')
        if (done) {
          throwIfHardCapAborted()
          break
        }
        receivedFirstChunk = true

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        // keepalive 感知：Anthropic 心跳是 `data: {"type":"ping"}` 事件（非注释行），
        // 故"进展"判定须排除 ping —— 只有真实内容事件才重置 idle timer。
        let sawContentEvent = false
        for (const line of lines) {
          const trimmed = line.trim()

          // Skip event: lines — type is in the JSON body
          if (trimmed.startsWith('event: ')) continue

          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5)

          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(data) } catch { continue }

          const type = parsed.type as string
          if (type !== 'ping') sawContentEvent = true

          switch (type) {
            case 'message_start': {
              const msg = parsed.message as Record<string, unknown> | undefined
              if (msg?.usage) {
                const u = msg.usage as Record<string, unknown>
                usage = {
                  input_tokens: u.input_tokens as number,
                  cache_read_input_tokens: u.cache_read_input_tokens as number,
                  cache_creation_input_tokens: u.cache_creation_input_tokens as number,
                }
              }
              break
            }

            case 'content_block_start': {
              const index = parsed.index as number | undefined
              const block = parsed.content_block as Record<string, unknown> | undefined
              if (!block) break
              if (block.type === 'tool_use' && index !== undefined) {
                callbacks.onToolCallDelta?.()
                const id = block.id as string
                const name = block.name as string
                if (id && name) {
                  toolUseBuffer.set(index, { id, name, partialJson: '' })
                }
              }
              break
            }

            case 'content_block_delta': {
              const index = parsed.index as number | undefined
              const delta = parsed.delta as Record<string, unknown> | undefined
              if (!delta) break
              if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                receivedChars += delta.text.length
                textBlocks.push(delta.text)
                callbacks.onTextDelta(delta.text)
              } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                receivedChars += delta.thinking.length
                thinkingBlocks.push(delta.thinking)
                callbacks.onThinkingDelta(delta.thinking)
              } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && index !== undefined) {
                const buf = toolUseBuffer.get(index)
                if (buf) {
                  buf.partialJson += delta.partial_json
                }
              }
              break
            }

            case 'content_block_stop': {
              const index = parsed.index as number | undefined
              if (index !== undefined) {
                const buf = toolUseBuffer.get(index)
                if (buf) {
                  let input: Record<string, unknown> = {}
                  let argsTruncated: boolean | undefined
                  const repaired = parseJsonObjectWithEscapeRepair(buf.partialJson || '{}')
                  if (repaired !== null) {
                    input = repaired
                  } else {
                    // Incomplete/unparseable partial_json at block stop — mark
                    // the block so the tool pipeline refuses to execute the {}
                    // placeholder (same contract as openai-client final flush).
                    argsTruncated = true
                  }
                  callbacks.onContentBlock({ type: 'tool_use', id: buf.id, name: buf.name, input, argsTruncated })
                  toolUseBuffer.delete(index)
                }
              }
              break
            }

            case 'message_delta': {
              const d = parsed.delta as Record<string, unknown> | undefined
              if (d?.stop_reason) {
                stopReason = d.stop_reason as string
              }
              if (parsed.usage) {
                const u = parsed.usage as Record<string, unknown>
                usage.output_tokens = u.output_tokens as number
              }
              break
            }

            case 'message_stop': {
              break
            }

            case 'error': {
              const err = parsed.error as Record<string, unknown> | undefined
              throw new Error(`Anthropic stream error: ${err?.message ?? 'Unknown error'}`)
            }
          }
        }
        // 仅在收到真实内容事件（排除 ping 心跳）时重置 idle timer
        if (sawContentEvent) resetIdleTimer()
      }
    } catch (err) {
      // Observability: surface how much streamed output this attempt discards.
      callbacks.onStreamAttemptAborted?.({
        provider: 'anthropic',
        receivedChars,
        elapsedMs: Date.now() - streamStartedAt,
        errorName: (err as Error)?.name ?? 'Error',
        errorMessage: (err as Error)?.message ?? String(err),
      })
      // Body-phase TimeoutError (raw undici DOMException) → descriptive,
      // classifiable Error. User AbortError and other errors pass through.
      throw wrapBodyTimeoutError(err, 'Anthropic', streamStartedAt)
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (maxStreamTimer) clearTimeout(maxStreamTimer)
      if (signalCleanup) signalCleanup()
      reader.releaseLock()
      // 拆 fetch 连接（见 openai-client 同名注释）。
      lifecycle?.abort()
    }

    // Emit text content block
    if (textBlocks.length > 0) {
      callbacks.onContentBlock({ type: 'text', text: textBlocks.join('') })
    }

    // Emit thinking content block
    if (thinkingBlocks.length > 0) {
      callbacks.onContentBlock({ type: 'thinking', thinking: thinkingBlocks.join('') })
    }

    // Anthropic reports cache-EXCLUSIVE input_tokens (cache read/creation are
    // separate buckets). Normalize to the codebase convention where
    // Usage.input_tokens is the cache-INCLUSIVE prompt total (see api/types.ts)
    // so hit-rate / cost / meta accounting treat all providers uniformly.
    const rawInput = usage.input_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheCreation = usage.cache_creation_input_tokens ?? 0
    callbacks.onStopReason(stopReason ?? 'end_turn', {
      input_tokens: rawInput + cacheRead + cacheCreation,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
    })
  }
}
