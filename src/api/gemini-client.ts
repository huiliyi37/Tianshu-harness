/**
 * GeminiClient — Google Gemini **native** API (`generativelanguage.googleapis.com`),
 * wire protocol `'gemini'`.
 *
 * Sibling of OpenAIClient / AnthropicClient / ResponsesClient / CodexClient.
 * The internal shape stays `OaiChatRequest`; this client is the translation
 * boundary. Google's native API is NOT "another OpenAI-compatible service" —
 * every axis differs from chat/completions, so a compat shim cannot express it:
 *
 *   | axis            | OpenAI chat/completions        | Gemini native                                  |
 *   |-----------------|--------------------------------|------------------------------------------------|
 *   | endpoint        | POST {base}/chat/completions   | POST {base}/{ver}/models/{m}:streamGenerateContent |
 *   | model location  | body `model`                   | URL path (`models/` prefix required)           |
 *   | auth            | Authorization: Bearer          | x-goog-api-key header (?key= also supported)   |
 *   | roles           | system/user/assistant          | user/model (system is a separate top-level)    |
 *   | system prompt   | role:'system' message          | top-level `systemInstruction`                  |
 *   | messages        | messages[].content             | contents[].parts[] ({text}|{inlineData}|{fileData}) |
 *   | sampling        | top-level temperature/max_tokens | `generationConfig`                           |
 *   | thinking        | reasoning_effort               | `generationConfig.thinkingConfig`              |
 *   | safety          | (none)                         | top-level `safetySettings`                     |
 *   | tools           | tools[].function               | tools[].functionDeclarations[]                 |
 *   | tool result     | role:'tool' + tool_call_id     | role:'user' + functionResponse{name,response}  |
 *   | stream          | SSE `data:` deltas             | SSE `data:` chunks (`?alt=sse`)                |
 *   | usage           | usage.prompt_tokens            | usageMetadata.promptTokenCount …               |
 *
 * **thought signatures.** Gemini 3 rejects a replayed `functionCall` that does
 * not carry the `thoughtSignature` the model emitted with it:
 *
 *   HTTP 400 Function call is missing a thought_signature in functionCall parts.
 *
 * (Reproduced against `gemini-3.5-flash` / `gemini-3.8-flash`: the first tool
 * turn succeeds, the follow-up 400s.) The internal `OaiMessage` shape has no
 * slot for provider-private part metadata, so this client retains the
 * signature keyed by the tool-call id it generated itself and re-attaches it on
 * replay. That is process-scoped: a session resumed in a fresh process loses
 * the map and falls back to the 400. Persisting it on the assistant message is
 * the proper fix and is tracked separately.
 */

import { ProxyAgent } from 'undici'
import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiAssistantMessage, OaiChatRequest, OaiToolCall, OaiUserMessage } from './oai-types.js'
import type { ContentBlock, Usage } from './types.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { resolveWireEffort } from './provider.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { wireAbortToReaderCancel } from './abort-reader.js'
import { acquireRateLimitSlot } from './rate-limiter.js'
import { repairJsonSyntax } from './json-syntax-repair.js'
import type { ProviderRetryConfig } from '../config/retry-schema.js'

export interface GeminiClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  /** API version segment. Google's native default is `v1beta`. */
  apiVersion?: string
  /** Default reasoning effort; request-level `reasoning_effort` wins. */
  reasoningEffort?: string
  /** Per-provider effort ceiling — values above this cap are clamped. */
  effortCap?: Record<string, string>
  /** Provider-level sampling temperature (injected only outside thinking mode). */
  temperature?: number
  thinking?: 'enabled' | 'disabled'
  firstByteTimeoutMs?: number
  requestTimeoutMs?: number
  retryBudget?: () => import('./retry-budget.js').RetryBudget | undefined
  maxRetries?: number
  retry?: ProviderRetryConfig
  proxy?: string
  providerName?: string
}

/** One `parts[]` entry on the wire. `camelCase` throughout — this is the native
 *  shape, not the snake_case OpenAI-compat one. */
export interface GeminiPart {
  text?: string
  /** Reasoning chunk. Native marks these explicitly instead of a separate channel. */
  thought?: boolean
  /** Opaque signature Gemini 3 requires back on replayed functionCall / model parts. */
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  fileData?: { mimeType?: string; fileUri: string }
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequestBody {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }>
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'NONE' | 'ANY'; allowedFunctionNames?: string[] } }
  generationConfig: { maxOutputTokens: number; temperature?: number; thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean } }
}

/** Effort → thinking token budget. Google accepts a numeric `thinkingBudget`
 *  (0 disables thinking outright). `off` maps to 0 so "turn thinking off" is a
 *  wire-level guarantee rather than a client-side convention. */
const THINKING_BUDGET: Record<string, number> = {
  off: 0,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  max: 65_536,
}

/** Gemini reports a bare enum; map it onto the stop_reason vocabulary the agent
 *  already understands (`stop` / `length` / `content_filter`). */
function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII': return 'content_filter'
    case 'STOP':
    case undefined: return 'stop'
    default: return reason.toLowerCase()
  }
}

/** `usageMetadata` (native) → internal Usage. `promptTokenCount` is
 *  cache-inclusive per Google's accounting, matching the DeepSeek/OpenAI
 *  convention this repo already standardised on. */
function mapGeminiUsage(meta: Record<string, unknown> | undefined): Partial<Usage> {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  return {
    input_tokens: num(meta?.promptTokenCount) ?? 0,
    output_tokens: num(meta?.candidatesTokenCount) ?? 0,
    cache_read_input_tokens: num(meta?.cachedContentTokenCount) ?? 0,
    cache_creation_input_tokens: 0,
    reasoning_tokens: num(meta?.thoughtsTokenCount),
  }
}

/** `data:<mime>;base64,<payload>` → native inlineData. Returns null for remote
 *  URLs, which take the fileData path instead. */
function splitDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  return { mimeType: match[1] || 'image/png', data: match[3] ?? '' }
}

function toGeminiParts(content: OaiUserMessage['content']): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  return content.flatMap<GeminiPart>(part => {
    if (part.type === 'text') return [{ text: part.text }]
    const inline = splitDataUrl(part.image_url.url)
    if (inline) return [{ inlineData: inline }]
    return [{ fileData: { mimeType: 'image/png', fileUri: part.image_url.url } }]
  })
}

export class GeminiClient implements StreamClient {
  private readonly proxyDispatcher: ProxyAgent | undefined
  private reasoningEffort: string | undefined
  private thinking: 'enabled' | 'disabled'
  /** tool_call id → thoughtSignature. Bounded; see the module header for why
   *  this lives on the client rather than on the persisted message. */
  private readonly signatureByCallId = new Map<string, string>()
  private static readonly SIGNATURE_CACHE_LIMIT = 128

  constructor(private config: GeminiClientConfig) {
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

  /** Test hook, mirroring AnthropicClient.buildRequestBodyForTest. */
  buildRequestBodyForTest(request: OaiChatRequest): GeminiRequestBody {
    return this.buildRequestBody(request)
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)

    await withStructuredRetry(async () => {
      const url = this.endpointUrl()
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
          Accept: 'text/event-stream',
          // Native auth. The key rides a header rather than `?key=` so it never
          // lands in request-line logs or proxy access logs.
          'x-goog-api-key': this.config.apiKey,
        },
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      }, this.config.firstByteTimeoutMs ?? 180_000, this.proxyDispatcher)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const message = extractErrorMessage(errorBody) ?? errorBody
        const err = Object.assign(
          new Error(`Gemini API error (${response.status}): ${message}`),
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

      await this.processSSEStream(response, callbacks, signal)
    }, signal, {
      budget: this.config.retryBudget?.(),
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

  /** `{base}/{version}/models/{model}:streamGenerateContent?alt=sse`. The model
   *  id belongs in the path, and `models/` must appear exactly once — models
   *  pasted from the API's own list endpoint already carry the prefix. The
   *  version segment is appended only when the configured base does not already
   *  end with it, so both `…googleapis.com` and `…googleapis.com/v1beta` work. */
  private endpointUrl(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    const version = this.config.apiVersion ?? 'v1beta'
    const model = this.config.model.startsWith('models/') ? this.config.model : `models/${this.config.model}`
    const root = base.endsWith(`/${version}`) ? base : `${base}/${version}`
    return `${root}/${model}:streamGenerateContent?alt=sse`
  }

  private resolveEffort(requestEffort: string | undefined): string | undefined {
    return resolveWireEffort(requestEffort ?? this.reasoningEffort, this.config.effortCap)
  }

  /** Internal OaiChatRequest → native generateContent body. */
  private buildRequestBody(request: OaiChatRequest): GeminiRequestBody {
    const contents: GeminiContent[] = []
    // Native hoists the system prompt into its own field; several internal
    // system messages concatenate into that single `parts[0]`.
    const systemTexts: string[] = []
    /** tool_call id → function name, so a later role:'tool' message can be
     *  translated into the `functionResponse.name` native requires. The OpenAI
     *  shape only carries the id, never the name. */
    const nameByCallId = new Map<string, string>()

    for (const msg of request.messages) {
      switch (msg.role) {
        case 'system': {
          systemTexts.push(msg.content)
          break
        }
        case 'user': {
          const parts = toGeminiParts(msg.content)
          if (parts.length > 0) contents.push({ role: 'user', parts })
          break
        }
        case 'assistant': {
          const parts = this.assistantParts(msg, nameByCallId)
          if (parts.length > 0) contents.push({ role: 'model', parts })
          break
        }
        case 'tool': {
          const name = nameByCallId.get(msg.tool_call_id) ?? msg.tool_call_id
          contents.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name,
                // Native expects an object; the internal shape carries a string.
                response: { result: msg.content },
              },
            }],
          })
          break
        }
      }
    }

    const body: GeminiRequestBody = {
      contents,
      generationConfig: { maxOutputTokens: request.max_tokens ?? this.config.maxTokens },
    }
    if (systemTexts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemTexts.join('') }] }
    }

    const tools = request.tools ?? []
    if (tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as Record<string, unknown>,
        })),
      }]
    }
    if (request.tool_choice && tools.length > 0) {
      if (typeof request.tool_choice === 'object') {
        const name = request.tool_choice.function.name
        if (tools.some(t => t.function.name === name)) {
          body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } }
        }
      } else {
        body.toolConfig = {
          functionCallingConfig: { mode: request.tool_choice === 'none' ? 'NONE' : 'AUTO' },
        }
      }
    }

    // Sampling: request-level wins; the provider default only applies outside
    // thinking mode (reasoning endpoints reject sampling params).
    const thinkingOn = this.thinking !== 'disabled'
    if (request.temperature !== undefined) {
      body.generationConfig.temperature = request.temperature
    } else if (this.config.temperature !== undefined && !thinkingOn) {
      body.generationConfig.temperature = this.config.temperature
    }

    // "Thinking off" has to be a wire-level statement on the native API: simply
    // omitting `thinkingConfig` leaves the model default (thinking ON). So both
    // the provider-level `thinking: 'disabled'` and the internal `'off'` effort
    // resolve to an explicit zero budget.
    //
    // The raw effort is checked *before* resolveWireEffort because that helper
    // maps 'off' → undefined ("omit the field"), which is the correct answer for
    // the OpenAI / Anthropic paths but the wrong one here.
    const rawEffort = request.reasoning_effort ?? this.reasoningEffort
    if (!thinkingOn || rawEffort === 'off') {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 }
    } else {
      const effort = this.resolveEffort(request.reasoning_effort)
      const budget = effort !== undefined ? THINKING_BUDGET[effort] : undefined
      body.generationConfig.thinkingConfig = {
        ...(budget !== undefined ? { thinkingBudget: budget } : {}),
        includeThoughts: true,
      }
    }

    return body
  }

  /** Assistant text + tool calls → `role:'model'` parts. Re-attaches any
   *  thoughtSignature this client captured for the same call id. */
  private assistantParts(msg: OaiAssistantMessage, nameByCallId: Map<string, string>): GeminiPart[] {
    const parts: GeminiPart[] = []
    const text = typeof msg.content === 'string' ? msg.content : ''
    if (text) parts.push({ text })
    for (const call of msg.tool_calls ?? []) {
      nameByCallId.set(call.id, call.function.name)
      const signature = this.signatureByCallId.get(call.id)
      parts.push({
        functionCall: { name: call.function.name, args: parseArgs(call) },
        ...(signature ? { thoughtSignature: signature } : {}),
      })
    }
    return parts
  }

  private rememberSignature(callId: string, signature: string | undefined): void {
    if (!signature) return
    if (this.signatureByCallId.size >= GeminiClient.SIGNATURE_CACHE_LIMIT) {
      const oldest = this.signatureByCallId.keys().next().value
      if (oldest !== undefined) this.signatureByCallId.delete(oldest)
    }
    this.signatureByCallId.set(callId, signature)
  }

  private async processSSEStream(
    response: Response,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let sawToolCall = false
    let usage: Partial<Usage> | undefined
    let stopReason = 'stop'
    const textChunks: string[] = []
    const thinkingChunks: string[] = []
    let emittedChars = 0

    const timeoutController = new AbortController()
    const maxStreamMs = this.config.requestTimeoutMs ?? 10 * 60_000
    const maxStreamTimer = setTimeout(() => timeoutController.abort(), maxStreamMs)
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const firstByteTimeoutMs = this.config.firstByteTimeoutMs ?? 180_000

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, firstByteTimeoutMs)
    }

    const signalCleanup = signal
      ? wireAbortToReaderCancel(AbortSignal.any([signal, timeoutController.signal]), reader)
      : wireAbortToReaderCancel(timeoutController.signal, reader)

    try {
      resetIdleTimer()
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (timeoutController.signal.aborted) {
          throw new Error(`Gemini stream hard timeout (${Math.round(maxStreamMs / 60_000)}min) — stream exceeded maximum duration`)
        }
        const { done, value } = await reader.read()
        if (streamTimedOut) throw new Error(`Gemini stream idle timeout (${Math.round(firstByteTimeoutMs / 1000)}s)`)
        if (done) break
        resetIdleTimer()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

          let chunk: Record<string, unknown>
          try {
            chunk = JSON.parse(payload)
          } catch {
            continue
          }

          const candidate = (chunk.candidates as Array<Record<string, unknown>> | undefined)?.[0]
          if (chunk.usageMetadata) usage = mapGeminiUsage(chunk.usageMetadata as Record<string, unknown>)
          if (candidate?.finishReason) stopReason = mapFinishReason(candidate.finishReason as string)

          const parts = ((candidate?.content as Record<string, unknown> | undefined)?.parts ?? []) as GeminiPart[]
          for (const part of parts) {
            if (typeof part.text === 'string' && part.text) {
              emittedChars += part.text.length
              if (part.thought === true) {
                thinkingChunks.push(part.text)
                callbacks.onThinkingDelta(part.text)
              } else {
                textChunks.push(part.text)
                callbacks.onTextDelta(part.text)
              }
            }
            if (part.functionCall) {
              sawToolCall = true
              callbacks.onToolCallDelta?.()
              const callId = `gemini_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
              // Native delivers functionCall args as an object, already complete.
              this.rememberSignature(callId, part.thoughtSignature)
              callbacks.onContentBlock({
                type: 'tool_use',
                id: callId,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
              })
            }
          }
        }
      }
    } finally {
      clearTimeout(maxStreamTimer)
      if (idleTimer) clearTimeout(idleTimer)
      signalCleanup?.()
    }

    if (thinkingChunks.length > 0) {
      callbacks.onContentBlock({ type: 'thinking', thinking: thinkingChunks.join('') })
    }
    if (textChunks.length > 0) {
      callbacks.onContentBlock({ type: 'text', text: textChunks.join('') })
    }
    // A tool-only turn has no text; force the stop reason so the agent loop
    // continues instead of treating the turn as a completed answer.
    callbacks.onStopReason(sawToolCall && stopReason === 'stop' ? 'tool_use' : stopReason, {
      ...usage,
      ...(usage ? {} : { input_tokens: 0, output_tokens: 0 }),
    })
    void emittedChars
  }
}

/** Gemini's `functionCall.args` is already an object on the wire; the internal
 *  tool_call carries a JSON string. Tolerate both, and repair the malformed
 *  escapes some gateways emit before giving up. */
function parseArgs(call: OaiToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    const repaired = repairJsonSyntax(raw)
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired)
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      } catch {
        return {}
      }
    }
    return {}
  }
}

/** Gemini nests errors as `{error:{message}}` and wraps arrays for some
 *  endpoints; surfacing the bare JSON blob in the thrown message makes the
 *  429/400 diagnosis needlessly hard. */
function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    const message = (first as { error?: { message?: string } } | undefined)?.error?.message
    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}

export type { ContentBlock }
