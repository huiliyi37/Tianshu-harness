import { isAssistantWithTools, oaiMessageText, type OaiToolCall, type OaiMessage } from '../api/oai-types.js'
import { toolArgSummary } from '../tui/tool-label.js'
import { listPersistedResultRounds, loadPersistedResult, loadPersistedResultRound } from '../agent/worker-result-store.js'
import { loadWorkerSession } from '../agent/worker-session-persist.js'
import type { SessionEvent } from './session-manager.js'

export interface WorkerLogOptions { full?: boolean; dispatchId?: string; attemptId?: string }

/** 工具调用参数摘要(worker 转录):优先 toolArgSummary 的领域摘要——它已含未覆盖
 *  工具的通用参数键兜底（tool-label.ts），仅当参数里没有可用字符串/数字时才回退
 *  原始 JSON 截断。展示用途,解析失败不抛。 */
function summarizeToolCallArgs(call: OaiToolCall | undefined): string | undefined {
  if (!call) return undefined
  const raw = call.function.arguments ?? ''
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    const summary = toolArgSummary(call.function.name, parsed)
    if (summary) return summary
  } catch {
    // 非法 JSON——直接落原文截断
  }
  return raw && raw !== '{}' ? raw.slice(0, 200) : undefined
}

export function buildWorkerLog(workerId: string, events: SessionEvent[], liveMessages?: readonly OaiMessage[], opts?: WorkerLogOptions) {
  const full = opts?.full === true
  const matches = (value: { dispatchId?: unknown; attemptId?: unknown } | null) => Boolean(value
    && (!opts?.dispatchId || value.dispatchId === opts.dispatchId)
    && (!opts?.attemptId || value.attemptId === opts.attemptId))
  const activity = events.filter(e => e.type === 'delegation' && (e.data.workerId ?? e.data.workOrderId) === workerId && matches(e.data))
    .map(e => e.data.progressLine ?? (e.data.eventKind === 'text' ? e.data.eventDetail : undefined)
      ?? (e.data.status != null ? `status: ${String(e.data.status)}` : undefined))
    .filter((line): line is string => typeof line === 'string' && Boolean(line)).map(line => line.slice(0, 300))
  const archived = listPersistedResultRounds(workerId).map(round => ({ round, result: loadPersistedResultRound(workerId, round.nonce) }))
  const selected = archived.filter(entry => matches(entry.result)).at(-1)
  const latest = loadPersistedResult(workerId)
  const result = opts?.dispatchId || opts?.attemptId ? selected?.result ?? (matches(latest) ? latest : null) : latest
  const rounds = archived.filter(entry => matches(entry.result)).map(entry => entry.round)
  // An explicitly selected dispatch must never fall back to another dispatch's latest history.
  const record = liveMessages !== undefined ? null
    : opts?.dispatchId || opts?.attemptId ? (selected ? loadWorkerSession(workerId, undefined, selected.round.nonce) : null)
      : loadWorkerSession(workerId)
  const messages = liveMessages ?? record?.messages ?? []
  const transcript = (full ? messages : messages.slice(-50)).map(m => ({
    role: m.role, text: (oaiMessageText(m) ?? '').slice(0, full ? 4000 : 800),
    toolName: isAssistantWithTools(m) ? m.tool_calls[0]?.function.name : undefined,
    toolInput: isAssistantWithTools(m) ? summarizeToolCallArgs(m.tool_calls[0]) : undefined,
  }))
  return { activity: full ? activity : activity.slice(-50), result, rounds, transcript,
    savedAt: record?.savedAt ?? null, truncated: !full && messages.length > 50 }
}

export type WorkerLog = ReturnType<typeof buildWorkerLog>
