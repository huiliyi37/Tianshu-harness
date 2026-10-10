import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import type { ModelConfig } from '../config/schema.js'
import { computeUsageCost } from '../utils/pricing.js'

export interface CallAuditContext {
  requestId?: string
  attemptId?: string
  sessionId?: string
  parentRequestId?: string
  workOrderId?: string
  provider?: string
  model?: string
  purpose?: string
  routeReason?: string
  configFingerprint?: string
}
export interface CallAuditRecord extends CallAuditContext {
  operationId: string
  t: number
  phase: 'started' | 'finished'
  status?: 'complete' | 'failed' | 'aborted'
  responseId?: string
  responseModel?: string
  systemFingerprint?: string
  finishReason?: string
  usage?: Record<string, number>
  usageKnown?: boolean
  errorName?: string
}

function path(): string { return join(rivetHome(), 'logs', 'provider-calls.jsonl') }
function append(record: CallAuditRecord): void {
  try { mkdirSync(join(rivetHome(), 'logs'), { recursive: true }); appendFileSync(path(), `${JSON.stringify(record)}\n`, { mode: 0o600 }) } catch { /* audit cannot break execution */ }
}

/** Accepts only diagnostic fields, never request bodies or authentication headers. */
export function beginCallAudit(context: CallAuditContext) {
  const operationId = context.attemptId ?? randomUUID()
  const identity: CallAuditContext = Object.fromEntries(Object.entries(context).filter(([key, value]) =>
    ['requestId', 'attemptId', 'sessionId', 'parentRequestId', 'workOrderId', 'provider', 'model', 'purpose', 'routeReason', 'configFingerprint'].includes(key) && typeof value === 'string'))
  append({ ...identity, operationId, t: Date.now(), phase: 'started' })
  let finished = false
  return {
    operationId,
    finish(result: Pick<CallAuditRecord, 'status' | 'responseId' | 'responseModel' | 'systemFingerprint' | 'finishReason' | 'usage' | 'errorName'>) {
      if (finished) return
      finished = true
      const usage = result.usage && Object.fromEntries(Object.entries(result.usage).filter(([key, n]) => /^(?:input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens|reasoning_tokens|prompt_tokens|completion_tokens|total_tokens|prompt_cache_hit_tokens|prompt_cache_miss_tokens)$/.test(key) && Number.isFinite(n) && n >= 0))
      append({ ...identity, operationId, t: Date.now(), phase: 'finished', status: result.status,
        responseId: result.responseId, responseModel: result.responseModel, systemFingerprint: result.systemFingerprint,
        finishReason: result.finishReason, errorName: result.errorName, usage, usageKnown: !!usage && Object.keys(usage).length > 0 })
    },
  }
}

export function auditConfigFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

function loadCallAuditRecords(): CallAuditRecord[] {
  const records = new Map<string, CallAuditRecord>()
  try {
    for (const line of readFileSync(path(), 'utf8').split('\n')) {
      try { const row = JSON.parse(line) as CallAuditRecord; if (row.operationId) records.set(row.operationId, row) } catch { /* interrupted tail */ }
    }
  } catch { return [] }
  return [...records.values()]
}

export interface CallAuditFilters {
  model?: string
  sessionId?: string
  purpose?: string
  /** 按来源组过滤(映射见文末 CALL_SOURCE_GROUPS);与 purpose 同时给定时取交集。 */
  group?: CallSourceGroup
  since?: number
  /** 每页条数,默认 100,上限 500。 */
  limit?: number
  /** 时间游标:只取 t 严格早于它的行(同毫秒行可能被跳过,明细展示可接受)。 */
  before?: number
}
export interface CallAuditPage {
  calls: CallAuditRecord[]
  /** 过滤后(游标前)的全量计数,供「还有 N 条」展示。 */
  total: number
}

export function readCallAudit(filters: CallAuditFilters = {}): CallAuditPage {
  const filtered = loadCallAuditRecords().filter(row => (!filters.model || row.model === filters.model || row.responseModel === filters.model)
    && (!filters.sessionId || row.sessionId === filters.sessionId) && (!filters.purpose || row.purpose === filters.purpose)
    && (!filters.group || callSourceGroup(row.purpose) === filters.group)
    && (!filters.since || row.t >= filters.since)).sort((a, b) => b.t - a.t)
  const limit = Math.max(1, Math.min(500, Math.floor(filters.limit ?? 100)))
  const windowed = filters.before ? filtered.filter(row => row.t < filters.before!) : filtered
  return { calls: windowed.slice(0, limit), total: filtered.length }
}

export function requestAuditContext(config: { sessionId?: string; providerName?: string }, request: { diagnostics?: { purpose?: string; parentRequestId?: string; workOrderId?: string; routeReason?: string } }): CallAuditContext {
  return { requestId: randomUUID(), sessionId: config.sessionId, provider: config.providerName,
    purpose: request.diagnostics?.purpose ?? (config.sessionId?.startsWith('worker-') ? 'worker_execution' : 'main_execution'),
    parentRequestId: request.diagnostics?.parentRequestId, workOrderId: request.diagnostics?.workOrderId, routeReason: request.diagnostics?.routeReason }
}

export function observedAuditUsage(usage: Partial<import('./types.js').Usage> | undefined): Record<string, number> | undefined {
  if (!usage) return undefined
  const fields = usage.observation?.fields
  return Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'reasoning_tokens']
    .filter(key => (!fields || key in fields) && typeof usage[key as keyof typeof usage] === 'number')
    .map(key => [key, usage[key as keyof typeof usage] as number]))
}

// ─── 调用来源分组统计(桌面 Insights「调用来源」面板) ─────────────────────

export type CallSourceGroup = 'main' | 'worker' | 'compact' | 'speculation' | 'side_question' | 'risk_explain' | 'vision' | 'essence' | 'recovery' | 'system' | 'unattributed'

/** purpose → 展示组映射,来源分类的唯一事实源;桌面端按组 key 做本地化标签。 */
export const CALL_SOURCE_GROUPS: Readonly<Record<string, CallSourceGroup>> = {
  main_execution: 'main',
  worker_execution: 'worker', worker_finalize: 'worker', worker_report_repair: 'worker',
  compact_summary: 'compact',
  llm_speculation: 'speculation',
  side_question: 'side_question',
  risk_explain: 'risk_explain',
  vision_description: 'vision', vision_question: 'vision',
  essence_gate: 'essence',
  reasoning_recovery: 'recovery',
  provider_probe: 'system', provider_models: 'system', transport_completion: 'system', 'account-login': 'system',
}

export function callSourceGroup(purpose: string | undefined): CallSourceGroup {
  return (purpose ? CALL_SOURCE_GROUPS[purpose] : undefined) ?? 'unattributed'
}

export interface ProviderCallModelStat {
  provider?: string
  model?: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  reasoning: number
  /** 只有命中定价配置才累计;costKnown=false 时恒 0,避免把未定价模型算成免费。 */
  cost: number
  costKnown: boolean
}
export interface ProviderCallGroupStat extends Omit<ProviderCallModelStat, 'provider' | 'model'> {
  group: CallSourceGroup
  /** 无计量数据(usage 缺失/空,或仅有 started 行)的请求数。 */
  usageMissing: number
  models: ProviderCallModelStat[]
}
export interface ProviderCallSummary {
  since: number
  generatedAt: number
  totals: { requests: number; usageMissing: number; input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number; cost: number }
  groups: ProviderCallGroupStat[]
}

function pickUsage(usage: Record<string, number>, ...keys: string[]): number | undefined {
  for (const key of keys) { const value = usage[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value }
  return undefined
}

/** 归一化到内核五字段口径;各家原生字段(prompt_tokens/cache_hit+miss)在此折算。 */
function normalizeAuditUsage(usage: Record<string, number> | undefined): { input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number } | undefined {
  if (!usage) return undefined
  const hit = pickUsage(usage, 'prompt_cache_hit_tokens'), miss = pickUsage(usage, 'prompt_cache_miss_tokens')
  const input = pickUsage(usage, 'input_tokens', 'prompt_tokens') ?? (hit !== undefined || miss !== undefined ? (hit ?? 0) + (miss ?? 0) : undefined)
  const normalized = {
    input: input ?? 0,
    output: pickUsage(usage, 'output_tokens', 'completion_tokens') ?? 0,
    cacheRead: pickUsage(usage, 'cache_read_input_tokens') ?? hit ?? 0,
    cacheCreate: pickUsage(usage, 'cache_creation_input_tokens') ?? 0,
    reasoning: pickUsage(usage, 'reasoning_tokens') ?? 0,
  }
  return input === undefined && !normalized.output && !normalized.cacheRead && !normalized.cacheCreate && !normalized.reasoning ? undefined : normalized
}

export function summarizeCallAudit(options: { since?: number; resolvePricing?: (model: string | undefined, provider: string | undefined, timestamp: number) => ModelConfig['pricing'] } = {}): ProviderCallSummary {
  const since = options.since ?? 0
  const groups = new Map<CallSourceGroup, { stat: ProviderCallGroupStat; models: Map<string, ProviderCallModelStat> }>()
  const totals = { requests: 0, usageMissing: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, cost: 0 }
  for (const row of loadCallAuditRecords()) {
    if (row.t < since) continue
    const groupKey = callSourceGroup(row.purpose)
    let entry = groups.get(groupKey)
    if (!entry) {
      entry = { stat: { group: groupKey, requests: 0, usageMissing: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, cost: 0, costKnown: false, models: [] }, models: new Map() }
      groups.set(groupKey, entry)
    }
    const model = row.responseModel ?? row.model
    const modelKey = `${row.provider ?? ''}${model ?? ''}`
    let bucket = entry.models.get(modelKey)
    if (!bucket) {
      bucket = { provider: row.provider, model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, cost: 0, costKnown: false }
      entry.models.set(modelKey, bucket)
    }
    entry.stat.requests++; bucket.requests++; totals.requests++
    const usage = normalizeAuditUsage(row.usage)
    if (!usage) { entry.stat.usageMissing++; totals.usageMissing++; continue }
    const pricing = options.resolvePricing?.(model, row.provider, row.t)
    const cost = pricing ? computeUsageCost({ input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheCreate, reasoning_tokens: usage.reasoning }, pricing).total : 0
    if (pricing) { entry.stat.costKnown = true; bucket.costKnown = true }
    for (const target of [entry.stat, bucket, totals] as Array<Pick<ProviderCallModelStat, 'input' | 'output' | 'cacheRead' | 'cacheCreate' | 'reasoning' | 'cost'>>) {
      target.input += usage.input; target.output += usage.output; target.cacheRead += usage.cacheRead
      target.cacheCreate += usage.cacheCreate; target.reasoning += usage.reasoning; target.cost += cost
    }
  }
  return {
    since, generatedAt: Date.now(), totals,
    groups: [...groups.values()]
      .map(entry => ({ ...entry.stat, models: [...entry.models.values()].sort((a, b) => b.input + b.output - (a.input + a.output)) }))
      .sort((a, b) => b.input + b.output - (a.input + a.output)),
  }
}
