import type { BodyGuardNotice } from '../api/request-body-guard.js'
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
  onContextBudget?: StreamCallbacks['onContextBudget']
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolHint?: (name: string) => void
  onStreamStart?: () => void
  onError: (error: Error) => void
  onRateLimit?: (retryDelayMs?: number) => void
  /** 413 / 图片被拒导致本次请求剥掉了 image_url——模型这一轮看不到这些图，
   *  调用方应告知用户，否则会被读成「模型没理我的截图」。
   *  uniqueUrlCount = 唯一 image URL 数：agent 层据此把剥离持久化写回历史。 */
  onImageStripped?: (info: { removedCount: number; uniqueUrlCount?: number }) => void
  /** 网关拒收「历史缺 reasoning_content」，重试已改为保留思考内容重发
   *  （issue #258）。必须可见：wire 形态中途变了，且该 provider 声明
   *  capabilities.preservedThinkingProtocol 就能免掉这次白跑。 */
  onReasoningEchoRecovered?: () => void
  /** 出网请求体触发了体积护栏（截断历史工具输出 / 逼近上限）。必须可见：被截断的
   *  历史静默 = 「模型忘了我们刚做的事」，逼近上限在第三方中转上直接 400。 */
  onBodyGuard?: (info: BodyGuardNotice) => void
  /** provider 层重试节流通知（429/503 退避可见性，dsh 式）——调用方经相位通道
   *  瞬态呈现；缺省 = 不想要该可见性。 */
  onRetryNotice?: (info: { category: string; attempt: number; maxAttempts: number; nextDelayMs: number }) => void
}

export interface TurnStreamDeps {
  recordContextBudget?: (budget: import('../server/protocol.js').ContextBudgetSnapshot) => import('../server/protocol.js').ContextBudgetSnapshot
  client: StreamClient
  /** 惰性取信号：watchdog 误报恢复（AgentLoop.resetAbortAfterRescue）会在 run 中途
   *  更换 AbortController，构造期按值捕获会把已中止的旧信号喂给恢复后的下一次
   *  stream（openai-client 入口即抛 AbortError → 回滚用户消息、run 结束）。 */
  getAbortSignal: () => AbortSignal
  getStreamedTextLength: () => number
  appendStreamedText: (text: string) => void
  truncateStreamedText: (length: number) => void
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
  /**
   * 服务端明确拒图（唯一 URL）后的持久化钩子：把 image part 替换为占位符写回会话
   * 历史，下一轮不再重发毒图（Grok `image_strip.rs` 的 ServerRejected 门同款）。
   * 由 loop-factory 接到 SessionContext；blame 不唯一时实现方必须保持 no-op。
   */
  persistStrippedImages?: (info: { removedCount: number; uniqueUrlCount?: number }) => void
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

    let wireBudget = input.request.contextBudget
    const initialTextLength = this.deps.getStreamedTextLength()
    const abortedAttempts = new Set<string>()
    const partialChars = () => Math.max(turnDisplayBuffer.length + thinkingAccum.length,
      collectedBlocks.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length
        : block.type === 'thinking' ? block.thinking.length : block.type === 'tool_use' ? JSON.stringify(block.input).length : 0), 0))
    const discardAttempt = () => {
      collectedBlocks.length = 0
      toolUses.length = 0
      thinkingAccum = turnDisplayBuffer = stopReason = ''
      chunkHistory.length = thinkingChunkHistory.length = 0
      this.deps.truncateStreamedText(initialTextLength)
      this.deps.setLastPrewarmAt(Math.min(this.deps.getLastPrewarmAt(), initialTextLength))
      streamStartMs = now()
      ttftMs = undefined
    }
    const publishBudget = (budget: import('../server/protocol.js').ContextBudgetSnapshot) => {
      wireBudget = budget
      const current = this.deps.recordContextBudget?.(budget) ?? budget
      if (current.requestId === budget.requestId) input.callbacks.onContextBudget?.(current)
    }
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
        if (wireBudget && (usage.input_tokens ?? 0) > 0) {
          publishBudget({ ...wireBudget,
            sampledAt: Date.now(), source: 'measured', measuredInputTokens: usage.input_tokens,
            inputTokens: usage.input_tokens!, generatedTokens: usage.output_tokens,
            state: usage.input_tokens! > wireBudget.inputBudget ? 'blocked' : usage.input_tokens! >= wireBudget.inputBudget * 0.85 ? 'warning' : 'ready',
          })
        }
        stopReason = reason
        this.deps.addUsage(usage)
        if (ttftMs !== undefined) this.deps.recordTtft?.(ttftMs)
        if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) {
          this.deps.recordTurnCache(input.turn, {
            observation: usage.observation,
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
      onImageStripped: (info) => {
        // 服务端明确拒图（唯一 URL）→ 先尝试把剥离持久化写回历史，下一轮不再
        // 重发毒图；blame 不唯一的启发式剥离由实现方保持 wire-only。
        try { this.deps.persistStrippedImages?.(info) } catch { /* best-effort：持久化失败不阻断流 */ }
        input.callbacks.onImageStripped?.(info)
      },
      onReasoningEchoRecovered: () => {
        input.callbacks.onReasoningEchoRecovered?.()
      },
      onContextBudget: publishBudget,
      onBodyGuard: (info) => {
        input.callbacks.onBodyGuard?.(info)
      },
      onRetryNotice: (info) => {
        input.callbacks.onRetryNotice?.(info)
      },
      onStreamAttemptAborted: (info) => {
        const attemptId = info.attemptId ?? info.usage?.observation?.attemptId
        if (attemptId && abortedAttempts.has(attemptId)) return
        if (attemptId) abortedAttempts.add(attemptId)
        const fields = info.usage?.observation?.fields
        const outputKnown = fields ? fields.output_tokens !== undefined : info.usage?.output_tokens !== undefined
        const chars = Math.max(info.receivedChars, partialChars())
        const usage = !outputKnown && chars > 0
          ? { ...info.usage, output_tokens: Math.ceil(chars / 4), estimated: true }
          : info.usage
        // Settle each failed attempt separately, including explicit provider zero.
        // Keep fields unchanged: local estimates are not provider observations.
        if (this.deps.recordStreamAttemptAborted) this.deps.recordStreamAttemptAborted({ ...info, usage })
        else if (usage) this.deps.addUsage(usage)
        discardAttempt()
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
      await this.deps.client.stream(input.request, streamCallbacks, this.deps.getAbortSignal())
    } catch (err) {
      // TTSR: extract triggeredRule from RuleTriggeredError, suppress as error
      if (err instanceof RuleTriggeredError) {
        triggeredRule = err.rule
      } else {
        // Legacy clients without attempt callbacks still need an estimate. The
        // delta and its final content block describe the same output, not two costs.
        const chars = partialChars()
        if (chars > 0) this.deps.addUsage({ output_tokens: Math.ceil(chars / 4), estimated: true })
        toolUses.length = 0
        streamError = err as Error
      }
    }

    // Tool hints may stream early; actionable tool notifications belong only
    // to a completed attempt, after safety rules and transport checks pass.
    if (!streamError && !triggeredRule) {
      for (const tool of toolUses) input.callbacks.onToolUse(tool.id, tool.name, tool.input)
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
