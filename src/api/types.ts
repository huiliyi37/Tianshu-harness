export type {
  OaiAssistantMessage,
  OaiChatRequest,
  OaiMessage,
  OaiSystemMessage,
  OaiToolCall,
  OaiToolDefinition,
  OaiToolMessage,
  OaiUsage,
  OaiUserMessage,
} from './oai-types.js'

export interface ContentBlockText {
  type: 'text'
  text: string
}

export interface ContentBlockThinking {
  type: 'thinking'
  thinking: string
}

export interface ContentBlockToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  providerMetadata?: import('./oai-types.js').ToolCallProviderMetadata
  /**
   * Set when the stream ended while this call's arguments were still
   * incomplete/unparseable (final-flush-empty). `input` is {} in that case —
   * NOT what the model asked for. The tool pipeline must refuse to execute
   * the call and return an error result instead (session 4df36bcd: a
   * truncated bash call executed with {} and threw deep inside the sandbox
   * wrapper).
   */
  argsTruncated?: boolean
}

export interface ContentBlockToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse
  | ContentBlockToolResult

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ToolDefinition {
  name: string
  description: string
  /** P2-16: MCP capability declared by the server policy (read/write/execute).
   *  Non-MCP tools leave this unset. Consumed by assessToolRisk for accurate
   *  risk labelling instead of hardcoded 'unknown'. */
  capability?: string
  input_schema?: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  providerFormat?: Record<string, unknown>
}

export interface Usage {
  cacheCoverage?: { input: number; read: number; observed: number; unknown: number; creationUnknown: number }
  observation?: {
    requestId: string
    attemptId: string
    status: 'complete' | 'aborted'
    fields: Record<string, string>
    wire?: { provider: string; model: string; purpose?: string; continuationSource?: string; previousMainRequestId?: string; baseline: string; comparison?: string; endpointHash?: string; messages: Array<{ hash: string; chars: number; role: string }>; toolsHash: string; options: Record<string, unknown> }
    responseId?: string
    responseModel?: string
    systemFingerprint?: string
    finishReason?: string
    prefix?: { system: string; tools: string; history: string; chars: number; messages: number; changed: boolean; firstChange?: number }
  }
  /**
   * Total prompt tokens, cache-INCLUSIVE: input_tokens = uncached + cache_read
   * + cache_creation. This is DeepSeek/OpenAI native semantics (prompt_tokens
   * = hit + miss). Clients whose upstream reports cache-EXCLUSIVE input
   * (Anthropic) must normalize at the boundary before emitting Usage.
   * Consumers (hit rate, cost, meta tokenUsage) all assume this convention.
   */
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /**
   * Reasoning/thinking tokens, a subset of output_tokens (NOT additive).
   * Optional: only thinking-capable providers report it (DeepSeek V4 via
   * completion_tokens_details.reasoning_tokens, etc.). Undefined when the
   * provider does not surface the split. Text tokens = output_tokens - reasoning_tokens.
   */
  reasoning_tokens?: number
  /**
   * True when output_tokens is a local estimate because the stream attempt
   * aborted before the provider reported any output usage. Never set on
   * provider-measured usage (including a provider-reported explicit 0).
   */
  estimated?: boolean
}
