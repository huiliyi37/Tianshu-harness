import type { OaiChatRequest, OaiContentPart } from '../api/oai-types.js'
import type { StreamClient } from '../api/stream-client.js'
import { buildContextBudget, capOutputReserve, type RequestBudgetPolicy } from '../context/request-budget.js'
import { deepSeekImageLimitError } from '../context/image-input-limits.js'
import { SUMMARY_ENVELOPE_INSTRUCTION } from './compact-summary-envelope.js'

/** Legacy direct callers retain the 32K input ceiling; runtime supplies its model policy. */
const DEFAULT_POLICY: RequestBudgetPolicy = { windowTokens: 65_536, maxOutputTokens: 4096, transportLimits: 'none' }

export function summaryRequestFits(request: OaiChatRequest, client: StreamClient, policy = DEFAULT_POLICY): boolean {
  const visible = client.previewContextRequest?.(request) ?? request
  const budget = buildContextBudget(visible, policy, { requestId: 'compact-summary', revision: 0 })
  return budget.state !== 'blocked' && budget.inputTokens <= 32_000
    && Buffer.byteLength(JSON.stringify(visible)) <= 40 * 1024 * 1024
    && (policy.transportLimits === 'none' || !deepSeekImageLimitError(visible.messages))
}

/** Oversized text keeps its source marker in every fragment; indivisible parts fail closed. */
export function buildSummaryRequests(parts: OaiContentPart[], model: string, client: StreamClient,
  policy = DEFAULT_POLICY, maxOutputTokens = 4096, summaryFocus?: string): OaiChatRequest[] | undefined {
  const output = Math.floor(Math.min(4096, maxOutputTokens, policy.maxOutputTokens, capOutputReserve(policy.windowTokens / 4, policy.windowTokens)))
  if (!Number.isFinite(output) || output < 1) return undefined
  const request = (content: OaiContentPart[], maxTokens = output): OaiChatRequest => ({
    model, max_tokens: maxTokens, stream: true, response_format: { type: 'json_object' }, diagnostics: { purpose: 'compact_summary' },
    messages: [{ role: 'system', content: SUMMARY_ENVELOPE_INSTRUCTION }, { role: 'user', content: [
      ...(summaryFocus ? [{ type: 'text' as const, text: `User-requested summary focus (apply while preserving the required envelope): ${summaryFocus}\n\n` }] : []),
      ...content,
    ] }],
  })
  const chunks: OaiContentPart[][] = []
  let chunk: OaiContentPart[] = []
  const pending = [...parts].reverse()
  while (pending.length) {
    const part = pending.pop()!
    if (summaryRequestFits(request([...chunk, part]), client, policy)) { chunk.push(part); continue }
    if (chunk.length) {
      chunks.push(chunk); chunk = []; pending.push(part)
      if (chunks.length >= 64) return undefined
      continue
    }
    if (part.type !== 'text') return undefined
    const marker = part.text.match(/^\n\[message:\d+ role:[^\]]+\]\n/)?.[0] ?? ''
    const text = part.text.slice(marker.length)
    if (text.length < 2) return undefined
    let middle = Math.floor(text.length / 2)
    // Keep UTF-16 surrogate pairs intact in individually transmitted fragments.
    if (/[\uD800-\uDBFF]/.test(text[middle - 1]!) && /[\uDC00-\uDFFF]/.test(text[middle]!)) middle--
    if (middle < 1) return undefined
    pending.push({ type: 'text', text: marker + text.slice(middle) }, { type: 'text', text: marker + text.slice(0, middle) })
  }
  if (chunk.length) chunks.push(chunk)
  if (!chunks.length) return undefined
  return chunks.map(content => request(content, Math.min(output, Math.floor(16_384 / chunks.length))))
}
