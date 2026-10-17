import type { Message } from '../api/types.js'
import { normalizeOaiMessage, type OaiMessage } from '../api/oai-types.js'
import { JSON_VALUE_KEEP_RATIO, MAX_SESSION_MESSAGE_JSON_CHARS } from '../compact/constants.js'

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = `\n<session-message-truncated original_chars="${value.length}" kept_chars="${maxChars}" />`
  const keep = Math.max(0, maxChars - marker.length)
  return value.slice(0, keep) + marker
}

function capJsonValue(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') return truncateString(value, maxChars)
  if (Array.isArray(value)) return value.map(item => capJsonValue(item, maxChars))
  if (value && typeof value === 'object') {
    const capped: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      capped[key] = capJsonValue(child, maxChars)
    }
    return capped
  }
  return value
}

export function serializeSessionMessage(message: Message, maxChars = MAX_SESSION_MESSAGE_JSON_CHARS): string {
  return serializeSessionJsonValue(message, maxChars, () => ({
    role: message.role,
    content: truncateString(JSON.stringify(message), maxChars),
  }))
}

export function serializeOaiSessionMessage(message: OaiMessage, maxChars = MAX_SESSION_MESSAGE_JSON_CHARS): string {
  const normalized = normalizeOaiMessage(message)
  // Attachments are protocol data. Truncating a URL/base64 value corrupts it.
  if (normalized.role === 'user' && Array.isArray(normalized.content)) return JSON.stringify(normalized)
  // A signature and the associated function arguments are opaque protocol data.
  if (normalized.role === 'assistant' && normalized.tool_calls?.some(call => call.providerMetadata?.gemini?.thoughtSignature)) return JSON.stringify(normalized)
  return serializeSessionJsonValue(normalized, maxChars, () => ({
    role: normalized.role,
    content: truncateString(JSON.stringify(normalized), maxChars),
    ...(normalized.role === 'tool' ? { tool_call_id: normalized.tool_call_id } : {}),
  } as OaiMessage))
}

function serializeSessionJsonValue<T>(message: T, maxChars: number, fallback: () => T): string {
  let json = JSON.stringify(message)
  if (json.length <= maxChars) return json

  const capped = capJsonValue(message, Math.max(1_000, Math.floor(maxChars * JSON_VALUE_KEEP_RATIO))) as T
  json = JSON.stringify(capped)
  if (json.length <= maxChars) return json

  return JSON.stringify(fallback())
}
