import type { ContentBlock, Message } from '../api/types.js'
import type { OaiAssistantMessage, OaiMessage, OaiToolCall, OaiToolMessage } from '../api/oai-types.js'
import { stableStringify } from '../api/stable-json.js'

export function legacyMessageToOaiMessages(message: Message): OaiMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }]
  }

  if (message.role === 'user') {
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const toolMessages: OaiToolMessage[] = message.content
      .filter((block): block is ContentBlock & { type: 'tool_result' } => block.type === 'tool_result')
      .map(block => ({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content }))
    return [
      ...(text ? [{ role: 'user' as const, content: text }] : []),
      ...toolMessages,
    ]
  }

  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  const reasoning = message.content
    .filter(block => block.type === 'thinking')
    .map(block => block.thinking)
    .join('')
  const toolCalls: OaiToolCall[] = message.content
    .filter((block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: stableStringify(block.input) },
      ...(block.providerMetadata ? { providerMetadata: block.providerMetadata } : {}),
    }))

  const assistant: OaiAssistantMessage = {
    role: 'assistant',
    content: text || (toolCalls.length === 0 ? '' : null),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  return [assistant]
}
