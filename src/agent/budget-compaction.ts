import { parseSummaryEnvelope } from './compact-summary-envelope.js'
import type { OaiMessage, OaiContentPart } from '../api/oai-types.js'
import { isSystemReminder } from '../prompt/system-reminder.js'
import type { StreamClient } from '../api/stream-client.js'
import { estimateBudgetInput, type RequestBudgetPolicy } from '../context/request-budget.js'
import { buildSummaryRequests, summaryRequestFits } from './budget-summary-request.js'
import { createHash, randomUUID } from 'node:crypto'
import { stableStringify } from '../api/stable-json.js'
import { groupIntoRoundsOai } from '../context/rounds.js'

export interface BudgetCompactionDeps {
  client: StreamClient
  model: string
  signal?: AbortSignal
  targetTokens?: number
  minReclaimTokens?: number
  summaryPolicy?: RequestBudgetPolicy
  summaryMaxTokens?: number
  summaryFocus?: string
  archive: (messages: OaiMessage[]) => Promise<string | { id: string; images: string[] }>
  commit: (messages: OaiMessage[]) => Promise<void>
  protectedUser?: OaiMessage
  recordEvent?: (event: { status: 'committed' | 'rejected'; beforeTokens: number; afterTokens: number; reason: string; artifactId?: string; rewriteTransactionId?: string; beforeDigest?: string; afterDigest?: string }) => void
  recordUsage?: (usage: import('../api/types.js').Usage) => void
  archiveRejectedReport?: (text: string, reason: string) => Promise<string | undefined>
}

/** Keep affordable recent groups verbatim; only complete groups may enter the archived summary.
 * Ambiguous tool results never authorize extending the cut. */
export function budgetCompactionSplit(messages: OaiMessage[], recentBudget?: number): number {
  let split = Math.max(0, messages.length - 4)
  if (recentBudget !== undefined) {
    let tokens = estimateBudgetInput(messages.slice(split)).inputTokens
    while (split > 0) {
      const next = estimateBudgetInput([messages[split - 1]!]).inputTokens
      if (tokens + next > recentBudget) break
      tokens += next; split--
    }
  }
  while (split > 0 && messages[split]?.role === 'tool') split--
  if (recentBudget !== undefined) {
    let tokens = estimateBudgetInput(messages.slice(split)).inputTokens
    if (tokens > recentBudget) {
      for (const round of groupIntoRoundsOai(messages)) {
        if (round.endMessageIndex <= split) continue
        if (round.apiInvariant !== 'ok') break
        const group = messages.slice(round.startMessageIndex, round.endMessageIndex)
        const calls = group[0]?.role === 'assistant' ? group[0].tool_calls ?? [] : []
        const results = group.filter(message => message.role === 'tool')
        if (new Set(calls.map(call => call.id)).size !== calls.length || calls.length !== results.length
          || new Set(results.map(message => message.tool_call_id)).size !== results.length) break
        tokens -= estimateBudgetInput(group).inputTokens
        split = round.endMessageIndex
        if (tokens <= recentBudget) break
      }
    }
  }
  return split
}

function summaryParts(messages: Array<{ message: OaiMessage; index: number }>): OaiContentPart[] {
  const parts: OaiContentPart[] = []
  const appendText = (text: string, marker: string) => {
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 24_000)
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
      parts.push({ type: 'text', text: marker + text.slice(start, end) })
      start = end
    }
  }
  for (const { index, message: m } of messages) {
    const marker = `\n[message:${index} role:${m.role}]\n`
    parts.push({ type: 'text', text: marker })
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'image_url') parts.push(part)
        else appendText(part.text, marker)
      }
    }
    else {
      const text = (m.content ?? '') + (m.role === 'assistant' && m.tool_calls ? JSON.stringify(m.tool_calls) : '')
      // Bounded text chunks also handle a single enormous tool result.
      appendText(text, marker)
    }
  }
  return parts
}

/** Chunk input before summarizing, so compaction never needs a larger model window. */
export async function compactBudgetHistory(messages: OaiMessage[], deps: BudgetCompactionDeps): Promise<boolean> {
  const before = estimateBudgetInput(messages).inputTokens
  const rewriteTransactionId = randomUUID(), beforeDigest = createHash('sha256').update(stableStringify(messages)).digest('hex')
  let recorded = false
  const recordEvent: BudgetCompactionDeps['recordEvent'] = event => { recorded = true; deps.recordEvent?.({ ...event, rewriteTransactionId, beforeDigest }) }
  try {
    const changed = await compactBudgetHistoryImpl(messages, { ...deps, recordEvent })
    if (!recorded) recordEvent({ status: 'rejected', beforeTokens: before, afterTokens: before, reason: 'insufficient_reclaim_or_summary_coverage' })
    return changed
  } catch (error) {
    if (!recorded) recordEvent({ status: 'rejected', beforeTokens: before, afterTokens: before, reason: deps.signal?.aborted ? 'aborted' : 'summary_or_persistence_failed' })
    throw error
  }
}

async function compactBudgetHistoryImpl(messages: OaiMessage[], deps: BudgetCompactionDeps): Promise<boolean> {
  const split = budgetCompactionSplit(messages, deps.targetTokens === undefined ? undefined : deps.targetTokens * 0.8)
  if (split < 2) return false
  deps.signal?.throwIfAborted()
  const old = messages.slice(0, split)
  const recent = messages.slice(split)
  const latestUser = [...messages].reverse().find(m => m.role === 'user' && (m.origin === 'human' || !isSystemReminder(m.content)))
  // Human instructions and legacy user data survive verbatim; a model summary
  // cannot prove it preserved every requirement or pending approval.
  const protectedUsers = new Set([...old.filter(m => m.role === 'user' && (!m.origin || m.origin === 'human' || m.origin === 'legacy_unknown') && (m.origin === 'human' || !isSystemReminder(m.content))), latestUser, deps.protectedUser].filter((m): m is OaiMessage => !!m))
  const protectedUser = old.filter(m => protectedUsers.has(m))
  const parts = summaryParts(old.map((message, index) => ({ message, index })).filter(({ message }) => !protectedUsers.has(message)))
  const requests = buildSummaryRequests(parts, deps.model, deps.client, deps.summaryPolicy, deps.summaryMaxTokens, deps.summaryFocus)
  if (!requests) return false
  const summaries: string[] = []
  const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
  for (const request of requests) {
    signal.throwIfAborted()
    if (!summaryRequestFits(request, deps.client, deps.summaryPolicy)) return false
    const content = request.messages[1]!.content as OaiContentPart[]
    let text = '', error: Error | undefined, stop = ''
    await deps.client.stream(request, {
      onTextDelta: delta => { text += delta }, onThinkingDelta: () => {}, onContentBlock: () => {},
      onStreamAttemptAborted: info => { if (info.usage) deps.recordUsage?.(info.usage as import('../api/types.js').Usage) },
      onStopReason: (reason, usage) => { stop = reason; if (usage) deps.recordUsage?.(usage as import('../api/types.js').Usage) },
      onError: err => { error = err },
    }, signal)
    if (error) throw error
    if (!text.trim() || !['stop', 'end_turn', 'stop_sequence'].includes(stop)) {
      const artifactId = await deps.archiveRejectedReport?.(text, `summary_stop:${stop}`)
      deps.recordEvent?.({ status: 'rejected', beforeTokens: estimateBudgetInput(messages).inputTokens, afterTokens: estimateBudgetInput(messages).inputTokens, reason: `summary_stop:${stop}`, artifactId })
      return false
    }
    const sources = new Set(content.flatMap(p => p.type === 'text' ? [...p.text.matchAll(/\[message:(\d+) role:/g)].map(m => Number(m[1])) : []))
    const parsed = parseSummaryEnvelope(text, sources)
    if (!parsed || summaries.reduce((n, s) => n + s.length, parsed.length) > 65_536) {
      const artifactId = await deps.archiveRejectedReport?.(text, 'summary_schema_or_budget_rejected')
      deps.recordEvent?.({ status: 'rejected', beforeTokens: estimateBudgetInput(messages).inputTokens, afterTokens: estimateBudgetInput(messages).inputTokens, reason: 'summary_schema_or_budget_rejected', artifactId })
      return false
    }
    summaries.push(parsed)
  }
  signal.throwIfAborted()
  // Persist full fidelity history, including image data and reasoning, before removal.
  const preview: OaiMessage = { role: 'user', origin: 'compact', content: `<compact-summary>\n${summaries.join('\n\n')}\n</compact-summary>` }
  const before = estimateBudgetInput(messages).inputTokens
  const after = estimateBudgetInput([preview, ...protectedUser, ...recent]).inputTokens + 1024
  // A tiny reclaim is not worth invalidating a paid prefix. Never publish a
  // rewrite merely because summarization succeeded. targetTokens 只作「尽力压到」的
  // 目标（仅用于 split 计算），不作通过线——长会话里 human 消息 + 大 recent 逐字保留，
  // 压缩保留下限恒高于 target，据此整单放弃会让预算闸门死锁（566K 仅超 16 token 就拒发）。
  if (before - after < (deps.minReclaimTokens ?? 1)) return false
  const ref = await deps.archive(old)
  signal.throwIfAborted()
  const archiveId = typeof ref === 'string' ? ref : ref.id
  const images = typeof ref === 'string' || !ref.images.length ? '' : `\nOriginal images (ask_image with imageId): ${ref.images.join(', ')}`
  const summary: OaiMessage = { role: 'user', origin: 'compact', content: `<compact-summary>\n${summaries.join('\n\n')}\nFull original history: [artifact:${archiveId}]${images}\n</compact-summary>` }
  const candidate = [summary, ...protectedUser, ...recent]
  const actualAfter = estimateBudgetInput(candidate).inputTokens
  if (before - actualAfter < (deps.minReclaimTokens ?? 1)) return false
  await deps.commit(candidate)
  deps.recordEvent?.({ status: 'committed', beforeTokens: before, afterTokens: actualAfter, artifactId: archiveId, reason: 'budget_summary_committed', afterDigest: createHash('sha256').update(stableStringify(candidate)).digest('hex') })
  return true
}
