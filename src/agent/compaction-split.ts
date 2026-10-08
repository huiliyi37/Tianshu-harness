import type { OaiMessage } from '../api/oai-types.js'

/**
 * Find a safe split point that doesn't cut through a tool_calls ↔ tool group.
 *
 * The OpenAI-compatible API requires every assistant message with tool_calls
 * to be immediately followed by matching tool messages. If tryPartialCompact
 * splits between an assistant(tool_calls) and its tool results, the resulting
 * message list becomes invalid and the API returns an error.
 *
 * This function walks backward from the desired split point to ensure we
 * split only at group boundaries: a tool call group (assistant + its tool
 * results) stays together in either oldZone or recentZone, not split across.
 */
export function findSafeSplitPoint(
  messages: OaiMessage[],
  desiredSplit: number,
  minSplit: number,
): number {
  let sp = desiredSplit
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { lastUserIndex = i; break }
  }
  const signedCurrentTurn = messages.slice(lastUserIndex + 1).some(msg => msg.role === 'assistant'
    && msg.tool_calls?.some(call => call.providerMetadata?.gemini?.thoughtSignature))
  // Gemini continuation requires the signed steps of the current user turn.
  // Returning before minSplit makes the caller skip an unsafe partial rewrite.
  if (signedCurrentTurn && sp > lastUserIndex) sp = Math.max(0, lastUserIndex)

  // Walk backward while the message at sp is a tool — its owning assistant
  // must be before sp, so we move sp before that assistant to keep the group intact.
  let iterations = 0
  while (sp > minSplit && sp < messages.length && messages[sp]?.role === 'tool') {
    if (++iterations > 100) break // safety valve
    const toolCallId = (messages[sp] as unknown as Record<string, unknown>).tool_call_id as string | undefined
    if (!toolCallId) break
    let found = false
    for (let i = sp - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant') {
        const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls as Array<{ id: string }> | undefined
        if (toolCalls?.some(tc => tc.id === toolCallId)) {
          sp = i // move split before the assistant that owns this tool
          found = true
          break
        }
      }
    }
    if (!found) break // orphaned tool with no matching assistant — shouldn't happen
  }

  return sp
}
