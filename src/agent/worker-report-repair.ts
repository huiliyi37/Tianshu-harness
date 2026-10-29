import { OfficialError } from '../models/official-contract.js'
import type { StreamClient } from '../api/stream-client.js'
import type { ArtifactStore } from '../artifact/store.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import type { WorkOrder, WorkerResult } from './work-order.js'
import { classifyWorkerParseError, salvageWorkerResult, parseWorkerResult } from './work-order.js'
import type { WorkerTranscript } from './worker-session.js'
import { streamFinalizeRequest, type FinalizeStreamHooks } from './worker-submit-result.js'

export const REPORT_TOKEN_LIMIT = 16_384
export type ReportFailureKind = 'channel' | 'truncated' | 'syntax' | 'schema' | 'non_report'
export interface ReportDiagnostic { kind: ReportFailureKind; error: string; artifact?: string; omitted?: string[] }

export async function recordReportFailure(store: ArtifactStore | undefined, cwd: string, sessionId: string, diagnostic: ReportDiagnostic, raw: string): Promise<string | undefined> {
  try {
    const id = await store?.save({ tool: 'worker-report-failure', target: sessionId, rawContent: raw, summary: diagnostic.error, sections: [] })
    const artifact = id ? store?.get(id)?.rawPath : undefined
    const dir = join(getSessionDir(cwd), sessionId)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'cache-log.jsonl'), JSON.stringify({ event: 'report_failure', t: new Date().toISOString(), ...diagnostic, artifact }) + '\n')
    return artifact
  } catch { return undefined }
}
export const isReportChannelError = (text: string): boolean => /[｜|]DSML[｜|]|<\/?(?:tool_calls|invoke|parameter)\b/i.test(text)

export function reportFailureKind(text: string, error: unknown, truncated = false): ReportFailureKind {
  if (isReportChannelError(text)) return 'channel'
  if (truncated || classifyWorkerParseError(error) === 'truncated') return 'truncated'
  const kind = classifyWorkerParseError(error)
  return kind === 'schema_field' ? 'schema' : kind === 'no_json' ? 'non_report' : 'syntax'
}

/** Conservative UTF-8 byte ceiling also bounds tokens. Drop whole fields/items, never JSON slices. */
export function buildReportRepairPacket(order: WorkOrder, raw: string, transcript: WorkerTranscript, diagnostic: ReportDiagnostic): { prompt: string; omitted: string[] } | null {
  const instruction = '修复 WorkerResult JSON 报告。仅使用提供的可恢复字段与实际捕获事实；禁止探索、工具调用或新增事实。必须包含 workOrderId/status/summary/findings/artifacts/changedFiles/risks/nextActions/evidenceStatus。无法证明完成时 status=blocked；证据未验证。只输出 JSON 对象。'
  const packet: Record<string, unknown> = { workOrderId: order.id, objective: order.objective, error: diagnostic, omitted: [] }
  const omitted = packet.omitted as string[]
  const render = () => `${instruction}\n${JSON.stringify(packet)}`
  const fits = () => Buffer.byteLength(render(), 'utf8') <= REPORT_TOKEN_LIMIT - 2048
  if (!fits()) return null
  const recovered = salvageWorkerResult(raw, order.id, undefined)
  const fields: Record<string, unknown> = {
    recoverable: recovered,
    capturedFiles: transcript.mutatedFiles ?? [],
    capturedReads: transcript.examinedFiles ?? [],
    verificationCommands: transcript.bashCommands ?? [],
    failedCommands: transcript.failedBashCommands ?? [],
    toolUses: transcript.toolUses,
    errors: transcript.errors,
  }
  // Admit complete recovered entries individually when the full report exceeds the ceiling.
  if (recovered) {
    delete fields.recoverable
    for (const [key, value] of Object.entries(recovered)) fields[`recoverable_${key}`] = value
  }
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      const kept: unknown[] = []
      packet[key] = kept
      for (let i = 0; i < value.length; i++) {
        kept.push(value[i])
        // Reserve space for an omission marker before accepting an entry.
        omitted.push(`${key}:remaining`)
        const accepted = fits()
        omitted.pop()
        if (!accepted) { kept.pop(); omitted.push(`${key}:${i}..${value.length - 1}`); break }
      }
    } else {
      packet[key] = value
      if (!fits()) { delete packet[key]; omitted.push(key) }
    }
  }
  // Omission markers themselves must fit; remove complete fields if necessary.
  while (Buffer.byteLength(render(), 'utf8') > REPORT_TOKEN_LIMIT) {
    const key = Object.keys(packet).reverse().find(k => !['workOrderId', 'objective', 'error', 'omitted'].includes(k))
    if (!key) return null
    delete packet[key]
    omitted.push(key)
  }
  return { prompt: render(), omitted }
}

export async function repairReportOnce(client: StreamClient, model: string, prompt: string, hooks: FinalizeStreamHooks, audit?: { workOrderId?: string; parentRequestId?: string; routeReason?: string }): Promise<string | null> {
  let text = ''
  let truncated = false
  const error = await streamFinalizeRequest(client, {
    model, messages: [{ role: 'user', content: prompt }], stream: true,
    max_tokens: REPORT_TOKEN_LIMIT, response_format: { type: 'json_object' },
    diagnostics: { ...audit, purpose: 'worker_report_repair', baseline: 'baseline_missing' },
  }, { onText: delta => { text += delta }, onStop: reason => { truncated = reason === 'max_tokens' || reason === 'length' } }, hooks)
  if (error instanceof OfficialError) throw error
  let reason = error?.message ?? (truncated ? 'truncated report repair' : isReportChannelError(text) ? 'channel: DSML in report repair' : undefined)
  if (!reason) {
    try { parseWorkerResult(text, 'repair') } catch (err) { reason = String(err) }
  }
  if (reason) { hooks.onReportRejected?.(reason, text); return null }
  return text
}

export function degradeRepairedReport(result: WorkerResult): WorkerResult {
  return {
    ...result, status: result.status === 'failed' ? 'failed' : 'blocked', evidenceStatus: 'unverified',
    verification: undefined,
    risks: [...new Set([...result.risks, '报告由残片修复，仅为未验证线索；未证明任务完成'])],
  }
}
