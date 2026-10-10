import { createHash } from 'node:crypto'
import { stableStringify } from './stable-json.js'
import type { Usage } from './types.js'

export interface ContinuationPrefixProof {
  version: 1
  provider: string
  model: string
  requestId: string
  endpointHash?: string
  optionsHash: string
  toolsHash: string
  messages: Array<{ hash: string; chars: number; role: string }>
}

export interface RequestDiagnostics {
  purpose: 'worker_execution' | 'worker_finalize' | 'worker_report_repair' | 'compact_summary' | 'side_question' | 'vision_description' | 'vision_question' | 'reasoning_recovery' | 'essence_gate' | 'llm_speculation' | 'risk_explain'
  workOrderId?: string
  routeReason?: string
  parentRequestId?: string
  continuationSource?: string
  previousMainRequestId?: string
  baseline?: 'present' | 'baseline_missing' | 'configuration_changed'
  priorPrefix?: ContinuationPrefixProof
}

export class LocalWorkerPolicyError extends Error {
  readonly code = 'LOCAL_WORKER_POLICY'
  constructor(message: string) { super(message); this.name = 'LocalWorkerPolicyError' }
}

export class ContinuationPrefixError extends LocalWorkerPolicyError {
  constructor(readonly changed: string | number, readonly previous: ContinuationPrefixProof, readonly next: ContinuationPrefixProof) {
    super(`worker continuation prefix diverged at ${changed}; request not sent`)
    this.name = 'ContinuationPrefixError'
  }
}

export function isLocalWorkerPolicyError(error: unknown): error is LocalWorkerPolicyError {
  return error instanceof LocalWorkerPolicyError || (error instanceof Error && ['ContinuationPrefixError', 'LocalWorkerPolicyError'].includes(error.name))
}

const hash = (value: unknown): string => createHash('sha256').update(stableStringify(value)).digest('hex')

/** Hash the final transport body, after every send-time transformation. No content or headers. */
export function proveWirePrefix(body: Record<string, unknown>, provider: string, requestId: string, endpoint?: string): ContinuationPrefixProof {
  return {
    version: 1, provider, model: String(body.model), requestId,
    ...(endpoint ? { endpointHash: hash(endpoint) } : {}),
    optionsHash: hash(wireOptions(body)), toolsHash: hash(body.tools ?? []),
    messages: ((body.messages ?? []) as Array<Record<string, unknown>>).map(m => ({
      hash: hash(m), chars: JSON.stringify(m).length, role: String(m.role),
    })),
  }
}

export function wireOptions(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['thinking', 'reasoning_effort', 'tool_choice', 'response_format', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'output_config']
    .map(key => [key, body[key] ?? null]))
}

export function wireObservation(body: Record<string, unknown>, proof: ContinuationPrefixProof, diagnostics?: RequestDiagnostics, main?: ContinuationPrefixProof): NonNullable<NonNullable<Usage['observation']>['wire']> {
  return { provider: proof.provider, model: proof.model, purpose: diagnostics?.purpose,
    continuationSource: diagnostics?.continuationSource, previousMainRequestId: diagnostics?.previousMainRequestId ?? main?.requestId,
    baseline: diagnostics?.priorPrefix || main ? 'present' : 'baseline_missing', comparison: 'not_checked', endpointHash: proof.endpointHash,
    messages: proof.messages, toolsHash: proof.toolsHash, options: wireOptions(body) }
}

/** Unknown old baselines fail toward observation; proven historical forks fail before dispatch. */
export function assertContinuationPrefix(previous: ContinuationPrefixProof | undefined, next: ContinuationPrefixProof): 'present' | 'baseline_missing' | 'configuration_changed' {
  if (!previous) return 'baseline_missing'
  if (previous.provider !== next.provider || previous.model !== next.model || (previous.endpointHash && previous.endpointHash !== next.endpointHash)) return 'configuration_changed'
  const changed = previous.toolsHash !== next.toolsHash
    ? 'tools' : previous.messages.findIndex((m, i) => next.messages[i]?.hash !== m.hash)
  if (changed === 'tools' || changed !== -1) throw new ContinuationPrefixError(changed, previous, next)
  return previous.optionsHash === next.optionsHash ? 'present' : 'configuration_changed'
}
