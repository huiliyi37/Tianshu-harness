import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stableStringify } from '../api/stable-json.js'
import { orderFileKey } from '../utils/safe-path.js'
import { coordinatorSubagentsDir, persistWorkerResult } from './worker-result-store.js'
import { saveWorkerSession } from './worker-session-persist.js'
import { writeWorkerFileAtomic } from './worker-history-store.js'
import type { WorkerSessionRun } from './worker-session.js'
import type { WorkOrder, WorkerResult } from './work-order.js'
import type { OaiMessage } from '../api/oai-types.js'

export function auditWorkerStage(result: WorkerResult) {
  return { status: result.status, evidenceStatus: result.evidenceStatus, failureReason: result.failureReason,
    digest: createHash('sha256').update(stableStringify(result)).digest('hex') }
}

export function persistWorkerDispatch(order: WorkOrder, nonce: string, results: WorkerResult[],
  run: { sessionMessages?: readonly OaiMessage[]; checkpoint?: WorkerSessionRun['checkpoint']; frozenSnapshot?: WorkerSessionRun['frozenSnapshot']; prefixProof?: WorkerSessionRun['prefixProof'] },
  stages: Record<string, ReturnType<typeof auditWorkerStage>>, fingerprint?: string): void {
  const outcome = run.sessionMessages?.length
    ? saveWorkerSession(order.id, order.profile, order.objective, run.sessionMessages, undefined, run.checkpoint, { frozenSnapshot: run.frozenSnapshot, prefixProof: run.prefixProof }, nonce)
    : { ok: false, error: 'no complete execution history captured' }
  for (const result of results) {
    if (!outcome.ok) {
      result.nextActions = result.nextActions.filter(a => !a.startsWith('Resumable:'))
      result.risks = [...result.risks, `Full execution history unavailable: ${outcome.error}; do not claim resumable.`]
    }
  }
  const resultsSaved = results.map(result => {
    const ok = persistWorkerResult(result, fingerprint, nonce)
    if (!ok) result.risks.push('Final worker result could not be persisted.')
    return ok
  }).every(Boolean)
  try {
    const dir = coordinatorSubagentsDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${orderFileKey(order.id)}.${nonce}.dispatch.json`)
    const manifest = { version: 1, workOrderId: order.id, nonce, dispatchId: results[0]?.dispatchId, attemptId: results[0]?.attemptId,
      source: results[0]?.failureReason === 'policy_short_circuit' ? 'blocked' : 'live', contract: order.delivery ?? 'contract_unknown',
      provider: results[0]?.provider, model: results[0]?.model, persistenceStatus: outcome.ok && resultsSaved ? 'saved' : 'failed', persistenceError: outcome.error,
      historySaved: outcome.ok, resultsSaved,
      stages: { ...stages, final: auditWorkerStage(results[0]!) }, savedAt: Date.now() }
    if (!writeWorkerFileAtomic(path, JSON.stringify(manifest))) throw new Error('dispatch audit write failed')
  } catch { for (const result of results) result.risks.push('Dispatch audit could not be persisted.') }
}

/** A continuation is acknowledged only after its history, delivery and audit exist. */
export function workerDispatchIsDurable(orderId: string, nonce: string, since: number): boolean {
  try {
    const value = JSON.parse(readFileSync(join(coordinatorSubagentsDir(), `${orderFileKey(orderId)}.${nonce}.dispatch.json`), 'utf8'))
    return value.workOrderId === orderId && value.nonce === nonce && value.persistenceStatus === 'saved'
      && value.historySaved === true && value.resultsSaved === true && value.savedAt >= since
  } catch { return false }
}

/** Early refusals, cancellations and reuse have no new execution history to save. */
export function persistWorkerNonExecution(order: WorkOrder, nonce: string, results: WorkerResult[], source: 'blocked' | 'canceled' | 'reused' | 'live'): void {
  const dir = coordinatorSubagentsDir(), path = join(dir, `${orderFileKey(order.id)}.${nonce}.dispatch.json`)
  if (existsSync(path)) return
  try {
    mkdirSync(dir, { recursive: true })
    if (!writeWorkerFileAtomic(path, JSON.stringify({ version: 1, workOrderId: order.id, nonce, source,
      dispatchId: results[0]?.dispatchId, attemptId: results[0]?.attemptId, contract: order.delivery ?? 'contract_unknown',
      model: results[0]?.model, provider: results[0]?.provider, persistenceStatus: source === 'live' ? 'failed' : 'not_applicable',
      stages: { final: auditWorkerStage(results[0]!) }, savedAt: Date.now() }))) throw new Error('dispatch audit write failed')
  } catch { for (const result of results) result.risks.push('Dispatch audit could not be persisted.') }
  for (const result of results) if (!persistWorkerResult(result, undefined, nonce)) result.risks.push('Final worker result could not be persisted.')
}
