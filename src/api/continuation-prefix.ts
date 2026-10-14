import { createHash } from 'node:crypto'
import { stableStringify } from './stable-json.js'
import type { Usage } from './types.js'

export interface ContinuationPrefixProof {
  version: 1 | 2
  cacheGenerationId?: string
  generationReason?: string
  credentialScope?: string
  options?: Record<string, unknown>
  provider: string
  model: string
  requestId: string
  endpointHash?: string
  optionsHash: string
  toolsHash: string
  messages: Array<{ hash: string; chars: number; role: string }>
}

export interface RewindGenerationAuthorization {
  version: 1
  reason: 'explicit_user_rewind'
  cacheGenerationId: string
  model: string
  history: ContinuationPrefixProof['messages']
  prior: ContinuationPrefixProof
}

export function isRewindGenerationAuthorization(value: unknown): value is RewindGenerationAuthorization {
  if (!value || typeof value !== 'object') return false
  const authorization = value as RewindGenerationAuthorization
  return authorization.version === 1 && authorization.reason === 'explicit_user_rewind'
    && typeof authorization.cacheGenerationId === 'string' && authorization.cacheGenerationId.length > 0
    && typeof authorization.model === 'string' && authorization.model.length > 0
    && isCompleteExecutionSnapshot(authorization.prior)
    && authorization.cacheGenerationId !== authorization.prior.cacheGenerationId
    && Array.isArray(authorization.history) && authorization.history.every(message => message
      && typeof message.hash === 'string' && /^[a-f0-9]{64}$/.test(message.hash)
      && typeof message.role === 'string' && Number.isFinite(message.chars))
}

export function proveRewindHistory(messages: readonly unknown[]): ContinuationPrefixProof['messages'] {
  return messages.map(message => ({ hash: hash(message), chars: JSON.stringify(message).length,
    role: String((message as { role?: unknown }).role) }))
}

export function assertRewindHistory(authorization: RewindGenerationAuthorization, messages: readonly unknown[]): void {
  const current = proveRewindHistory(messages)
  if (authorization.history.some((message, index) => current[index]?.hash !== message.hash)) {
    throw new LocalWorkerPolicyError('回退授权对应的保留历史发生变化；禁止发送请求')
  }
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

export function isCompleteExecutionSnapshot(value: unknown): value is ContinuationPrefixProof & { options: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false
  const p = value as ContinuationPrefixProof
  return p.version === 2 && typeof p.cacheGenerationId === 'string' && typeof p.credentialScope === 'string'
    && typeof p.endpointHash === 'string' && typeof p.provider === 'string' && typeof p.model === 'string'
    && typeof p.requestId === 'string' && typeof p.toolsHash === 'string' && typeof p.optionsHash === 'string'
    && !!p.options && !Array.isArray(p.options) && hash(p.options) === p.optionsHash
    && Array.isArray(p.messages) && p.messages.every(m => typeof m.hash === 'string' && typeof m.role === 'string' && Number.isFinite(m.chars))
}

/** Hash the final transport body, after every send-time transformation. No content or headers. */
export function proveWirePrefix(body: Record<string, unknown>, provider: string, requestId: string, endpoint?: string): ContinuationPrefixProof {
  return {
    version: 2, provider, model: String(body.model), requestId,
    options: wireOptions(body),
    ...(endpoint ? { endpointHash: hash(endpoint) } : {}),
    optionsHash: hash(wireOptions(body)), toolsHash: hash(body.tools ?? []),
    messages: ((body.messages ?? []) as Array<Record<string, unknown>>).map(m => ({
      hash: hash(m), chars: JSON.stringify(m).length, role: String(m.role),
    })),
  }
}

export function wireOptions(body: Record<string, unknown>): Record<string, unknown> {
  const fields = ['thinking', 'reasoning_effort', 'tool_choice', 'response_format', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'output_config', 'generationConfig', 'toolConfig', 'text', 'safetySettings', 'parallel_tool_calls', 'seed', 'stop', 'frequency_penalty', 'presence_penalty', 'service_tier']
  const covered = new Set([...fields, 'model', 'stream', 'messages', 'tools', 'system', 'instructions', 'systemInstruction', 'input', 'contents', 'reasoning', 'max_output_tokens'])
  const extraFields = Object.fromEntries(Object.keys(body).filter(key => !covered.has(key)).sort().map(key => [key, hash(body[key])]))
  return { ...Object.fromEntries(fields.map(key => [key, body[key] ?? null])), ...(Object.keys(extraFields).length ? { extraFields } : {}) }
}

export function wireObservation(body: Record<string, unknown>, proof: ContinuationPrefixProof, diagnostics?: RequestDiagnostics, main?: ContinuationPrefixProof): NonNullable<NonNullable<Usage['observation']>['wire']> {
  return { provider: proof.provider, model: proof.model, purpose: diagnostics?.purpose,
    continuationSource: diagnostics?.continuationSource, previousMainRequestId: diagnostics?.previousMainRequestId ?? main?.requestId,
    baseline: diagnostics?.priorPrefix || main ? 'present' : 'baseline_missing', comparison: 'not_checked', endpointHash: proof.endpointHash,
    messages: proof.messages, toolsHash: proof.toolsHash, options: wireOptions(body) }
}

/** Proven historical forks fail locally before dispatch. Legacy recovery requires a complete snapshot. */
export function assertContinuationPrefix(previous: ContinuationPrefixProof | undefined, next: ContinuationPrefixProof): 'present' | 'baseline_missing' | 'configuration_changed' {
  if (!previous) return 'baseline_missing'
  if (previous.provider !== next.provider || previous.model !== next.model || (previous.endpointHash && previous.endpointHash !== next.endpointHash)) throw new ContinuationPrefixError('binding', previous, next)
  const changed = previous.toolsHash !== next.toolsHash
    ? 'tools' : previous.messages.findIndex((m, i) => next.messages[i]?.hash !== m.hash)
  if (changed === 'tools' || changed !== -1) throw new ContinuationPrefixError(changed, previous, next)
  if (previous.optionsHash !== next.optionsHash) throw new ContinuationPrefixError('options', previous, next)
  return 'present'
}
