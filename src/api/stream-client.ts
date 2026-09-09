import type { OaiChatRequest } from './oai-types.js'
import type { ContentBlock, Usage } from './types.js'

/** Diagnostic payload emitted when a stream attempt dies after partial output.
 *  4e1aaa21 post-mortem: aborted attempts silently discarded minutes of
 *  streamed reasoning; forensics had to reverse-engineer the loss from
 *  cache-log timestamp gaps. This event makes the discard observable. */
export interface StreamAttemptAbortedInfo {
  provider: string
  /** Characters received before the abort (reasoning + text deltas). */
  receivedChars: number
  /** Milliseconds from stream start to the abort. */
  elapsedMs: number
  errorName: string
  errorMessage: string
}

export interface StreamCallbacks {
  /** Streaming text delta for live display */
  onTextDelta: (text: string) => void
  /** Streaming thinking delta for live display */
  onThinkingDelta: (thinking: string) => void
  /** Complete content block (text, thinking, or tool_use with full input) */
  onContentBlock: (block: ContentBlock) => void
  /** Called when message_delta arrives with stop_reason + usage */
  onStopReason: (stopReason: string, usage: Partial<Usage>) => void
  onError: (error: Error) => void
  /** Hint: a tool call's name and partial args are parseable (for speculative prewarm). Optional. */
  onToolCallHint?: (toolName: string, partialArgs: Record<string, unknown>) => void
  /** Observability-only signal for the earliest provider tool-call start/delta. */
  onToolCallDelta?: () => void
  /** Called when a rate limit (429) is encountered and being retried. Optional. */
  onRateLimit?: (retryDelayMs?: number) => void
  /** Called when a stream attempt aborts after receiving partial output (each failed attempt, before any retry). Optional. */
  onStreamAttemptAborted?: (info: StreamAttemptAbortedInfo) => void
}

/** Wire-level prefix divergence: how this request's FINAL bytes (after
 *  reasoning-strip, sanitize, system-suffix — exactly what goes on the socket)
 *  differ from the previous main-turn request. Complements the engine-level
 *  probe (PromptEngine.consumePrefixDivergence): the engine probe proves the
 *  message arrays are append-only BEFORE send-time transforms; this one covers
 *  the transforms themselves. A cacheRead regression with a clean engine probe
 *  but a wireDiverged record = send-layer byte churn; clean on both = provider-
 *  side rendering/落盘 behavior. */
export interface WireDivergence {
  /** Index into the wire messages array (0 = system message). -1 = 非消息维度（tools）。 */
  idx: number
  role: string
  /** tools_changed：工具定义数组变化（不进 messages，消息级探针隐形——
   *  它打的是整个前缀的 system+tools 段，优先于消息级分歧报告）。 */
  kind: 'message_changed' | 'message_removed' | 'tools_changed'
  prevCount: number
  newCount: number
  /** Approximate char offset of the diverged message's start in the wire payload. */
  approxCharPos: number
}

/** Canonical streaming interface shared by all provider clients */
export interface StreamClient {
  stream(request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void>
  /** Update reasoning effort at runtime (optional — not all providers support this) */
  setReasoningEffort?(effort: string): void
  /** Toggle thinking/reasoning mode at runtime (GLM turn-level thinking). Optional — not all providers support this. */
  setThinking?(mode: 'enabled' | 'disabled'): void
  /** Consume-once accessor for the latest wire-level prefix divergence. Optional. */
  consumeWireDivergence?(): WireDivergence | null
}
