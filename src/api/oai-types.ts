/** OpenAI function call in assistant message. */
export interface OaiToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON string. */
    arguments: string
  }
}

/** System message. */
export interface OaiSystemMessage {
  role: 'system'
  content: string
}

/** Vision content parts for multimodal user messages (OpenAI image_url format). */
export interface OaiTextPart {
  type: 'text'
  text: string
}
export interface OaiImagePart {
  type: 'image_url'
  image_url: { url: string } // data:image/...;base64,... or https URL
}
export type OaiContentPart = OaiTextPart | OaiImagePart

/** User message — content is plain text or multimodal parts (vision). */
export interface OaiUserMessage {
  role: 'user'
  content: string | OaiContentPart[]
}

/** Assistant message, optionally including tool calls and provider reasoning. */
export interface OaiAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OaiToolCall[]
  /** Provider reasoning content. Stored locally; stripped before sending to DeepSeek (400 if present). */
  reasoning_content?: string
}

/** Tool result message. */
export interface OaiToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type OaiMessage =
  | OaiSystemMessage
  | OaiUserMessage
  | OaiAssistantMessage
  | OaiToolMessage

export function isToolMessage(msg: OaiMessage): msg is OaiToolMessage {
  return msg.role === 'tool'
}

export function isAssistantWithTools(msg: OaiMessage): msg is OaiAssistantMessage & { tool_calls: OaiToolCall[] } {
  return msg.role === 'assistant'
    && Array.isArray(msg.tool_calls)
    && msg.tool_calls.length > 0
}

/**
 * Normalize assistant messages before they are persisted or sent over the
 * wire. OpenAI-compatible APIs distinguish between an omitted `tool_calls`
 * field and an empty array; the latter is invalid (`minItems: 1`) even when
 * the assistant has ordinary text content. Empty arrays can survive in old
 * session files or be produced by partial tool-call recovery, so remove them
 * without mutating the caller's message object.
 */
export function normalizeOaiMessage(message: OaiMessage): OaiMessage {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 0) {
    return message
  }

  const { tool_calls: _, ...rest } = message
  // A null assistant content is valid only alongside a real tool call for the
  // providers we support. Once the empty array is removed, use an empty text
  // value so a recovered message remains a valid assistant message.
  return { ...rest, content: rest.content ?? '' }
}

/** Return the original array when no message needs normalization. */
export function normalizeOaiMessages(messages: OaiMessage[]): OaiMessage[] {
  let normalized: OaiMessage[] | undefined
  for (let i = 0; i < messages.length; i++) {
    const message = normalizeOaiMessage(messages[i]!)
    if (message !== messages[i]) {
      normalized ??= messages.slice()
      normalized[i] = message
    }
  }
  return normalized ?? messages
}

export function isUserMessage(msg: OaiMessage): msg is OaiUserMessage {
  return msg.role === 'user'
}

/** Placeholder substituted for an image-only user message after stripping, so
 *  the message (and role alternation) survives even when it carried no text. */
export const STRIPPED_IMAGE_PLACEHOLDER = '[image removed to reduce payload size]'

/**
 * True when at least one user message carries a multimodal `image_url` part.
 * The retry path uses this to decide whether an image_strip recovery can help.
 */
export function oaiMessagesHaveImageParts(messages: OaiMessage[]): boolean {
  return messages.some(
    m => m.role === 'user'
      && Array.isArray(m.content)
      && m.content.some(p => p.type === 'image_url'),
  )
}

export interface StrippedOaiMessages {
  /** Messages with image_url parts removed (same reference when nothing changed). */
  messages: OaiMessage[]
  /** Number of image_url parts removed. */
  removedCount: number
}

/**
 * Return a copy of `messages` with every multimodal `image_url` part removed,
 * preserving all text and the overall message/role structure. This is the
 * payload-shrinking recovery for a 413 / image-rejection retry: drop images and
 * resend instead of repeating the identical oversized request.
 *
 * Pure — never mutates input. Returns the SAME array reference when no image
 * was removed, so callers can cheaply detect a no-op. An image-only user message
 * (no text part) is replaced with a short text placeholder so the request still
 * has a non-empty user turn and valid role alternation after the strip.
 */
export function stripOaiImageParts(
  messages: OaiMessage[],
  placeholder: string = STRIPPED_IMAGE_PLACEHOLDER,
): StrippedOaiMessages {
  let removedCount = 0
  let next: OaiMessage[] | undefined

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const imageCount = msg.content.reduce(
      (n, p) => (p.type === 'image_url' ? n + 1 : n),
      0,
    )
    if (imageCount === 0) continue

    removedCount += imageCount
    next ??= messages.slice()
    const kept = msg.content.filter(p => p.type !== 'image_url')
    const content: OaiContentPart[] = kept.length > 0
      ? kept
      : [{ type: 'text', text: placeholder }]
    next[i] = { ...msg, content }
  }

  return { messages: next ?? messages, removedCount }
}

/**
 * Extract plain text from any OaiMessage content (handles multimodal user messages).
 * Use this instead of `msg.content` when you need a string regardless of content type.
 */
export function oaiMessageText(msg: OaiMessage): string {
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === 'text').map(p => p.text).join('')
  }
  return msg.content as string
}

/** Tool definition in OpenAI function calling format. */
export interface OaiToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    /** Provider-specific configuration (e.g. GLM web_search native integration). */
    providerFormat?: Record<string, unknown>
  }
}

/** Request body for OpenAI-compatible Chat Completions APIs. */
export interface OaiChatRequest {
  model: string
  messages: OaiMessage[]
  tools?: OaiToolDefinition[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  temperature?: number
  /** DeepSeek extension. */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
  /** Force the model to emit valid JSON (OpenAI-compatible json_object mode).
   *  Worker sessions set this on the final (no-tools) turn to eliminate free-text
   *  parse failures. Requires the prompt to mention "json". */
  response_format?: { type: 'json_object' }
  /** Main-turn marker for the wire-level prefix probe (2026-07-06 cache
   *  investigation). Set by PromptEngine.buildOaiRequest on non-sidePath builds;
   *  the client fingerprints the FINAL wire bytes (post reasoning-strip /
   *  sanitize / system-suffix) only for these requests, so side-path calls
   *  (compaction summaries etc.) don't poison the baseline. Never serialized
   *  into the HTTP body. */
  prefixProbe?: boolean
}

/** Usage stats from OpenAI-compatible API responses. */
export interface OaiUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}
