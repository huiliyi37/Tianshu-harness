export function anthropicBodyHasImages(body: Record<string, unknown>): boolean {
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  return messages.some(message => {
    const content = (message as { content?: unknown } | null)?.content
    return Array.isArray(content) && content.some(block => (block as { type?: unknown } | null)?.type === 'image')
  })
}
