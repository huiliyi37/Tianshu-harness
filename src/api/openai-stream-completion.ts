/**
 * SSE transport ended before the provider's terminal `data: [DONE]` marker.
 *
 * A clean socket close is not by itself proof of a complete generation: the
 * connection may be cut by a proxy, an idle LB, or a retryable transport reset
 * after a partial body. Previously that EOF was settled as `complete`, so the
 * discarded partial turn looked successful and no `stream_attempt_aborted`
 * breadcrumb existed. Treat it as an incomplete attempt and let the retry /
 * fallback policy decide the next step.
 */
export class IncompleteStreamError extends Error {
  constructor() {
    super('OpenAI SSE stream ended before [DONE] completion marker (incomplete stream)')
    this.name = 'IncompleteStreamError'
  }
}

// OpenAI 协议终态 finish_reason。收到其一即证明本轮已完成——部分上游
// （MiniMax-M3 大上下文会话）合法结束时不发 `data: [DONE]`。安全边界：仅终态
// finish_reason 可触发宽容；只有部分 content 而无 finish_reason 仍是真·断流。
export const TERMINAL_FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter', 'function_call'])
