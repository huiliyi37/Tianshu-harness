/** Local protocol metadata travels with its call through history and restore. */
export interface ToolCallProviderMetadata {
  gemini?: { thoughtSignature: string }
}

/** OpenAI function call in assistant message. */
export interface OaiToolCall {
  id: string
  type: 'function'
  providerMetadata?: ToolCallProviderMetadata
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
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
}
export type OaiContentPart = OaiTextPart | OaiImagePart

/** User message — content is plain text or multimodal parts (vision). */
export interface OaiUserMessage {
  role: 'user'
  content: string | OaiContentPart[]
  /** Local-only provenance, persisted but removed before transport. */
  origin?: import('../agent/input-origin.js').InputOrigin
}

/** Assistant message, optionally including tool calls and provider reasoning. */
export interface OaiAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OaiToolCall[]
  /** Provider reasoning content; official DeepSeek tool requests must echo it intact. */
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

/**
 * 剥图重发时替换 image part 的占位文本。措辞必须让模型知道「图不在了」而不是
 * 「图还在但看不清」——静默丢图会诱导模型凭记忆描述（Grok Build
 * `IMAGE_COMPACT_PLACEHOLDER` 同款纪律）。wire 剥图与持久化剥图共用同一常量：
 * 两条路径必须产出逐字节相同的 part，下一轮才接得上已缓存前缀。
 */
export const STRIPPED_IMAGE_PLACEHOLDER =
  '[Image removed to reduce payload size and no longer visible. '
  + 'Do not describe or reason about its contents from memory; ask the user to re-share it if you need to see it again.]'

/** 请求里是否至少有一条用户消息带多模态 image_url part。
 *  retry 路径据此判断 image_strip 恢复还有没有牌可打。 */
export function oaiMessagesHaveImageParts(messages: OaiMessage[]): boolean {
  return messages.some(
    m => m.role === 'user'
      && Array.isArray(m.content)
      && m.content.some(p => p.type === 'image_url'),
  )
}

export interface StrippedOaiMessages {
  /** 已替换 image_url part 的消息（无图可剥时返回原数组引用）。 */
  messages: OaiMessage[]
  /** 被替换的 image_url part 数量。 */
  removedCount: number
  /**
   * 剥图前请求里**不同** image URL 的数量。
   * 服务端 4xx/413 只指认「这个请求」而不是具体哪张图，调用方据此判断 blame
   * 是否唯一（uniqueUrlCount===1）再决定要不要把剥离持久化写回历史——
   * 与 Grok Build `image_strip.rs` 的 ServerRejected 门同款。
   */
  uniqueUrlCount: number
}

/**
 * 返回 `messages` 的副本，把其中所有多模态 image_url part **就地替换为占位文本**
 * （顺序保持）。这是 413 / 图片被拒的重试恢复：去掉图重发，而不是把同一个过大的
 * 请求再发一遍（那样必然再次 413）。
 *
 * 占位符而不是直接删 part：混排消息删掉图片后模型不知道图曾经存在，会按记忆
 * 描述（Grok 同款纪律）。纯图片消息因此天然保持非空 user 轮次与角色交替合法。
 *
 * 纯函数，绝不修改入参——调用方的会话历史由 agent 层按 uniqueUrlCount 决定是否
 * 写回（见 `src/agent/persisted-image-strip.ts`）。无图可剥时返回**同一个数组
 * 引用**，调用方可零成本识别 no-op。
 */
export function stripOaiImageParts(
  messages: OaiMessage[],
  placeholder: string = STRIPPED_IMAGE_PLACEHOLDER,
): StrippedOaiMessages {
  let removedCount = 0
  const urls = new Set<string>()
  let next: OaiMessage[] | undefined

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const hasImage = msg.content.some(p => p.type === 'image_url')
    if (!hasImage) continue

    next ??= messages.slice()
    const content: OaiContentPart[] = msg.content.map(p => {
      if (p.type !== 'image_url') return p
      removedCount++
      urls.add(p.image_url.url)
      return { type: 'text', text: placeholder }
    })
    next[i] = { ...msg, content }
  }

  return { messages: next ?? messages, removedCount, uniqueUrlCount: urls.size }
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
  /** Internal accounting, never serialized as a provider field. */
  contextBudget?: import('../server/protocol.js').ContextBudgetSnapshot
  model: string
  messages: OaiMessage[]
  tools?: OaiToolDefinition[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  temperature?: number
  /** DeepSeek extension. 取值含**内部档位** `'off'`（auto-reasoning 逐轮降档走这条
   *  路）：它不是合法 wire 枚举，由 client 侧 resolveWireEffort 统一映射/省略——
   *  写成窄类型只会把越界值推到运行时（issue #258 的第一条报错正是「类型说不会
   *  发生、线上照样发」的形状）。 */
  reasoning_effort?: 'off' | 'low' | 'medium' | 'high' | 'max'
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
  diagnostics?: import('./continuation-prefix.js').RequestDiagnostics
}

/** Usage stats from OpenAI-compatible API responses. */
export interface OaiUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}

/** Provenance is local storage metadata, never a provider parameter. */
export function wireOaiMessage(message: OaiMessage): OaiMessage {
  if (message.role !== 'user' || !message.origin) return message
  const { origin: _origin, ...wire } = message
  return wire
}

/** OpenAI-compatible transports must not serialize other providers' metadata. */
export function stripOaiProviderMetadata(message: OaiMessage): OaiMessage {
  if (message.role !== 'assistant' || !message.tool_calls?.some(call => call.providerMetadata)) return message
  return { ...message, tool_calls: message.tool_calls.map(({ providerMetadata: _, ...call }) => call) }
}
