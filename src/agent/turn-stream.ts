import type { StreamCallbacks, StreamAttemptAbortedInfo } from '../api/stream-client.js'
import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest } from '../api/oai-types.js'
import type { ContentBlock, Usage } from '../api/types.js'
import { stripIntraTurnRepetition } from './dedup.js'
import type { StreamCacheObservability } from './cache-log-observability.js'

export interface StreamRule {
  /** Regex pattern matched against a bash tool-call's `command` argument.
   *  When the model emits a bash command matching this, the stream is aborted
   *  and the rule's inject message is appended before retrying.
   *
   *  NOTE: matched against the bash `command` argument only — NOT the model's
   *  prose. This avoids self-triggering when the model legitimately *discusses*
   *  or documents a dangerous pattern (e.g. a security task about `curl | sh`). */
  pattern: string
  /** System reminder injected into the conversation when the rule triggers. */
  inject: string
}

/** Built-in safety-net rules — always active, even without user config.
 *  These catch the most dangerous patterns that no model should ever generate. */
export const DEFAULT_STREAM_RULES: readonly StreamRule[] = [
  { pattern: 'rm\\s+-rf\\s+/(?![a-zA-Z])', inject: 'STOP: Never execute rm -rf / without a specific path. This will destroy the system.' },
  { pattern: 'curl[^\\n]*\\|\\s*(?:sh|bash)', inject: 'STOP: Never pipe curl output directly to a shell. Download first, inspect, then run.' },
  { pattern: 'DROP\\s+TABLE', inject: 'STOP: Do not execute DROP TABLE without explicit user confirmation. This is irreversible.' },
]

export interface TurnStreamCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolHint?: (name: string) => void
  onStreamStart?: () => void
  onError: (error: Error) => void
  onRateLimit?: (retryDelayMs?: number) => void
}

export interface TurnStreamDeps {
  client: StreamClient
  abortSignal: AbortSignal
  getStreamedTextLength: () => number
  appendStreamedText: (text: string) => void
  getLastPrewarmAt: () => number
  setLastPrewarmAt: (position: number) => void
  maybePrewarm: (text: string) => void
  /** Direct file prewarm for speculative tool call hints */
  prewarmFile?: (filePath: string) => void
  addUsage: (usage: Partial<Usage>) => void
  recordTurnCache: (turn: number, usage: Usage, observability?: StreamCacheObservability) => void
  /** 记录本轮等首字节的毫秒数。独立于 `recordTurnCache`——后者被 provider 是否返回
   *  缓存字段 gate 住（延迟指标不该挂在成本字段的存在性上），worker 常用的模型响应
   *  里没有那两个字段时，TTFT 会连同整行一起被丢弃。 */
  recordTtft?: (ttftMs: number) => void
  /** Optional: record a failed stream attempt (partial output discarded) for diagnostics. */
  recordStreamAttemptAborted?: (info: StreamAttemptAbortedInfo) => void
  /** Monotonic-enough clock for TTFT measurement; injectable for deterministic tests. */
  now?: () => number
}

export interface TurnStreamInput {
  request: OaiChatRequest
  turn: number
  lastTurnTextFingerprint: string
  callbacks: TurnStreamCallbacks
  /** Optional stream rules — abort and inject when a bash command matches a pattern. */
  streamRules?: StreamRule[]
  /** Rule patterns to skip this turn (disabled after exceeding the retry cap). */
  disabledRulePatterns?: ReadonlySet<string>
}

export interface TurnStreamResult {
  collectedBlocks: ContentBlock[]
  thinkingAccum: string
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown>; argsTruncated?: boolean }>
  stopReason: string
  streamError: Error | null
  lastTurnTextFingerprint: string
  lastTurnThinkingFingerprint: string
  /** Set when a stream rule triggered the abort — caller should inject the rule and retry. */
  triggeredRule?: StreamRule
}

function isToolUse(b: ContentBlock): b is ContentBlock & { type: 'tool_use'; id: string; name: string } {
  return b.type === 'tool_use'
}

function displayTextFingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Error thrown when a stream rule matches — caught and distinguished from real AbortErrors. */
class RuleTriggeredError extends Error {
  constructor(public readonly rule: StreamRule) {
    super('Stream rule triggered')
    this.name = 'RuleTriggeredError'
  }
}

export class TurnStreamController {
  constructor(private deps: TurnStreamDeps) {}

  async streamTurn(input: TurnStreamInput): Promise<TurnStreamResult> {
    const collectedBlocks: ContentBlock[] = []
    let thinkingAccum = ''
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown>; argsTruncated?: boolean }> = []
    let stopReason = ''
    let turnDisplayBuffer = ''
    const CHUNK_DEDUP_HISTORY = 5
    const chunkHistory: string[] = []
    const thinkingChunkHistory: string[] = []
    const now = this.deps.now ?? Date.now
    let streamStartMs: number | undefined
    let ttftMs: number | undefined
    const markFirstProviderOutput = () => {
      if (streamStartMs === undefined || ttftMs !== undefined) return
      ttftMs = Math.max(0, now() - streamStartMs)
    }

    // TTSR: compile stream rule patterns once â default rules always active
    const rules = [...DEFAULT_STREAM_RULES, ...(input.streamRules ?? [])]
      .filter(r => !input.disabledRulePatterns?.has(r.pattern))
    const compiledRules = rules.map(r => ({ ...r, regex: new RegExp(r.pattern, 'si') }))
    let triggeredRule: StreamRule | undefined

    const streamCallbacks: StreamCallbacks = {
      onTextDelta: (text) => {
        if (text.length > 0) markFirstProviderOutput()
        this.deps.appendStreamedText(text)
        if (this.deps.getStreamedTextLength() - this.deps.getLastPrewarmAt() >= 500) {
          this.deps.setLastPrewarmAt(this.deps.getStreamedTextLength())
          const t = text
          setImmediate(() => this.deps.maybePrewarm(t))
        }
        turnDisplayBuffer += text
        // Real-time push with duplicate-chunk guard (DeepSeek repeats 50+ char chunks)
        // Check recent history for both consecutive and non-consecutive duplicates
        if (text.length >= 50 && chunkHistory.includes(text)) {
          return // skip duplicate — appendStreamedText/turnDisplayBuffer already updated above
        }
        if (text.length >= 50) {
          chunkHistory.push(text)
          if (chunkHistory.length > CHUNK_DEDUP_HISTORY) {
            chunkHistory.shift()
          }
        }
        input.callbacks.onTextDelta(text)
      },
      onThinkingDelta: (thinking) => {
        if (thinking.length > 0) markFirstProviderOutput()
        thinkingAccum += thinking
        // Duplicate-chunk guard for thinking content (mirrors text dedup above).
        // DeepSeek/MiMo can repeat 50+ char reasoning chunks verbatim.
        if (thinking.length >= 50 && thinkingChunkHistory.includes(thinking)) {
          return // skip duplicate — thinkingAccum already updated above
        }
        if (thinking.length >= 50) {
          thinkingChunkHistory.push(thinking)
          if (thinkingChunkHistory.length > CHUNK_DEDUP_HISTORY) {
            thinkingChunkHistory.shift()
          }
        }
        input.callbacks.onThinkingDelta(thinking)
      },
      onContentBlock: (block) => {
        if (
          block.type === 'tool_use'
          || (block.type === 'text' && block.text.length > 0)
          || (block.type === 'thinking' && block.thinking.length > 0)
        ) {
          markFirstProviderOutput()
        }
        collectedBlocks.push(block)
        if (isToolUse(block)) {
          toolUses.push({ id: block.id, name: block.name, input: block.input, argsTruncated: block.argsTruncated })
          input.callbacks.onToolUse(block.id, block.name, block.input)

          // TTSR: match stream rules against the bash command the model is about
          // to run — NOT its prose. Aborts before a dangerous command executes,
          // while leaving discussion/documentation of the pattern untouched.
          if (!triggeredRule && compiledRules.length > 0 && block.name === 'bash') {
            const command = typeof block.input.command === 'string' ? block.input.command : ''
            if (command) {
              for (const rule of compiledRules) {
                if (rule.regex.test(command)) {
                  triggeredRule = { pattern: rule.pattern, inject: rule.inject }
                  throw new RuleTriggeredError(triggeredRule)
                }
              }
            }
          }
        }
      },
      onStopReason: (reason, usage) => {
        stopReason = reason
        this.deps.addUsage(usage)
        if (ttftMs !== undefined) this.deps.recordTtft?.(ttftMs)
        if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) {
          this.deps.recordTurnCache(input.turn, {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          }, ttftMs !== undefined ? { ttftMs } : undefined)
        }
      },
      onError: (error) => {
        input.callbacks.onError(error)
      },
      onRateLimit: (retryDelayMs) => {
        input.callbacks.onRateLimit?.(retryDelayMs)
      },
      onStreamAttemptAborted: (info) => {
        this.deps.recordStreamAttemptAborted?.(info)
      },
      onToolCallDelta: () => {
        markFirstProviderOutput()
      },
      onToolCallHint: (toolName, partialArgs) => {
        markFirstProviderOutput()
        input.callbacks.onToolHint?.(toolName)
        if (toolName === 'read_file' && typeof partialArgs.file_path === 'string') {
          const fp = partialArgs.file_path
          setImmediate(() => this.deps.prewarmFile?.(fp))
        }
      },
    }

    let streamError: Error | null = null
    try {
      streamStartMs = now()
      input.callbacks.onStreamStart?.()
      await this.deps.client.stream(input.request, streamCallbacks, this.deps.abortSignal)
    } catch (err) {
      // TTSR: extract triggeredRule from RuleTriggeredError, suppress as error
      if (err instanceof RuleTriggeredError) {
        triggeredRule = err.rule
      } else {
        const estimatedOut = this.deps.getStreamedTextLength() + collectedBlocks.reduce((sum, block) => (
          sum + (block.type === 'text' ? block.text.length : 0)
        ), 0)
        if (estimatedOut > 0) {
          this.deps.addUsage({ output_tokens: Math.ceil(estimatedOut / 4) })
        }
        streamError = err as Error
      }
    }

    const dedupedBuffer = stripIntraTurnRepetition(turnDisplayBuffer)
    const nextFingerprint = displayTextFingerprint(dedupedBuffer)

    return {
      collectedBlocks,
      thinkingAccum,
      toolUses,
      stopReason,
      streamError,
      lastTurnTextFingerprint: nextFingerprint,
      lastTurnThinkingFingerprint: displayTextFingerprint(thinkingAccum),
      triggeredRule,
    }
  }
}
