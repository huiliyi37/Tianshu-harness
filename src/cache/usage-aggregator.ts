/**
 * Cross-session cache usage aggregator (DeepSeek cache panel data layer).
 *
 * Scans `<sessionsRoot>/<sid>/cache-log.jsonl` files (and one level deeper for
 * the all-projects root layout `sessions/<slug>/<sid>/`), buckets per-request
 * usage rows by day × model, and computes weighted hit rate, cost, and cache
 * savings. Consumed by the TUI `/cache` overlay and the desktop sidecar
 * `GET /cache/usage` route.
 *
 * Row semantics (see loop-factory.ts recordTurnCache / side-path recorder):
 * - main request rows have no `event` field and carry cache-inclusive `input`
 * - `event:'side_path'` rows are real billing (speculation / compaction) and
 *   count toward consumption, but are excluded from the hit-rate quotient
 *   (本地口径: ΣcacheRead/Σinput over main rows only)
 * - all other `event` rows (reclaim_decision, amnesia_shadow, …) carry no
 *   usage and are ignored
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelConfig } from '../config/schema.js'
import { computeUsageCost } from '../utils/pricing.js'

export interface CacheUsageRow {
  t: number
  model: string
  /** Provider name (2026-08-07 T3). Spark shares wire model ids with official
   *  DeepSeek (`deepseek-v4-flash`) — without this dimension the two are
   *  indistinguishable in the log. Absent on rows written before the field
   *  existed; those aggregate under the bare model key (legacy behaviour). */
  provider?: string
  input: number
  cacheRead: number
  cacheCreate: number
  output: number
  prefixStable?: boolean
  sidePath: boolean
  retry?: boolean
  usageFields?: Record<string, string>
}

export interface UsageTotals {
  prefixStableRate?: number
  prefixSamples?: number
  retryRequests?: number
  cacheCreateUnreported?: number
  hitRateUnknown?: number
  /** main request count */
  requests: number
  /** side-path (speculation / summary) request count */
  sidePathRequests: number
  input: number
  cacheRead: number
  cacheCreate: number
  output: number
  /** weighted ΣcacheRead/Σinput over main rows, percent 0–100; null when no input */
  hitRate: number | null
  /**
   * ΣcacheRead/Σinput over **every** row the provider charged for — side_path,
   * retry (`stream_attempt_aborted`) and usage-unreported rows included.
   * Same semantics as `computeBilledHitRate` (billed-hit-rate.ts); kept as its
   * own number rather than folded into `hitRate` because the two answer
   * different questions, and the gap between them is the only place a
   * regression that grows side-path/retry traffic at a poor hit rate shows up
   * (the bill rises, `hitRate` doesn't move). Equivalence with
   * `computeBilledHitRate` is pinned by a reconciliation case in
   * `billed-hit-rate-regression.test.ts` (same fixture, both computations).
   */
  billedHitRate: number | null
  /** total cost in the model's billing currency (per computeUsageCost) */
  cost: number | null
  /** money saved by cache hits: ΣcacheRead × (missPrice − hitPrice) */
  savings: number | null
}

export interface ModelUsage extends UsageTotals {
  model: string
  /** Provider dimension — set when the underlying rows carried it. Same model
   *  served by two providers (spark vs official) produces two entries. */
  provider?: string
}

export interface DayUsage extends UsageTotals {
  /** local-time day key, YYYY-MM-DD */
  date: string
  models: ModelUsage[]
}

export interface CacheUsageAggregate {
  totals: UsageTotals
  /** ascending by date */
  days: DayUsage[]
  /** whole-window per-model rollup, descending by cost then input */
  models: ModelUsage[]
  scannedFiles: number
  /** files skipped by the mtime window filter */
  skippedFiles: number
  windowDays: number
}

/** Optional second arg (2026-08-07 T3): row provider — lets resolvers price
 *  the same wire model id differently per provider once tariffs diverge.
 *  Optional third arg is the request timestamp for time-dependent tariffs.
 *  Existing resolvers stay valid (extra args ignored). */
export type PricingResolver = (model: string, provider?: string, timestamp?: number) => ModelConfig['pricing'] | undefined

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 计费行判据（**单一事实源**）：主请求行（event 缺省）、side_path 与 retry
 * （stream_attempt_aborted）都是 provider 实际计费的调用。
 * 对账类消费者（scripts/audit-usage-ledgers.ts 等）必须导入本函数，不要自写
 * 过滤——2026-10-02 审计脚本曾自称"同口径"却漏掉 retry 行，把计入 retry 的
 * meta 误判为 overcount（第三批修复）。
 */
export function isBilledCacheLogEvent(event: unknown): boolean {
  return event === undefined || event === 'side_path' || event === 'stream_attempt_aborted'
}

/**
 * 尝试级去重键（provider × model × requestId × attemptId）：同一 attempt 的
 * 重复落行只计一次。requestId/attemptId 缺失时返回 undefined（不去重）。
 * parseUsageRows 与 audit-usage-ledgers 共用，防止口径再次漂移。
 */
export function attemptDedupeKey(record: Record<string, unknown>): string | undefined {
  if (typeof record.requestId !== 'string' || typeof record.attemptId !== 'string') return undefined
  return JSON.stringify([record.provider, record.model, record.requestId, record.attemptId])
}

/** Parse cache-log JSONL content into usage rows. Non-usage event rows and malformed lines are dropped. */
export function parseUsageRows(content: string): CacheUsageRow[] {
  const attempts = new Set<string>()
  return content.split(/\r?\n/).reverse().flatMap(line => {
    if (!line.trim()) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return []
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const record = parsed as Record<string, unknown>
    const dedupeKey = attemptDedupeKey(record)
    if (dedupeKey !== undefined) {
      if (attempts.has(dedupeKey)) return []
      attempts.add(dedupeKey)
    }
    const event = record.event
    if (!isBilledCacheLogEvent(event)) return []
    const t = num(record.t)
    const input = num(record.input)
    if (t === undefined || input === undefined) return []
    return [{
      t,
      model: typeof record.model === 'string' && record.model ? record.model : 'unknown',
      ...(typeof record.provider === 'string' && record.provider ? { provider: record.provider } : {}),
      input,
      cacheRead: num(record.cacheRead) ?? 0,
      cacheCreate: num(record.cacheCreate) ?? 0,
      output: num(record.output) ?? 0,
      sidePath: event === 'side_path',
      ...(record.prefix && typeof (record.prefix as { changed?: unknown }).changed === 'boolean'
        ? { prefixStable: !(record.prefix as { changed: boolean }).changed } : {}),
      ...(event === 'stream_attempt_aborted' ? { retry: true } : {}),
      ...(record.usageFields && typeof record.usageFields === 'object' ? { usageFields: record.usageFields as Record<string, string> } : {}),
    }]
  }).reverse()
}

interface Accumulator {
  prefixSamples: number
  prefixStable: number
  retryRequests: number
  cacheCreateUnreported: number
  hitRateUnknown: number
  requests: number
  sidePathRequests: number
  input: number
  cacheRead: number
  cacheCreate: number
  output: number
  /** hit-rate quotient parts — main rows only */
  mainInput: number
  mainCacheRead: number
  unpriced: boolean
  cost: number
  savings: number
}

function newAccumulator(): Accumulator {
  return {
    prefixSamples: 0, prefixStable: 0, retryRequests: 0, cacheCreateUnreported: 0, hitRateUnknown: 0,
    requests: 0, sidePathRequests: 0,
    input: 0, cacheRead: 0, cacheCreate: 0, output: 0,
    mainInput: 0, mainCacheRead: 0, unpriced: false,
    cost: 0, savings: 0,
  }
}

function addRow(acc: Accumulator, row: CacheUsageRow, pricing: ModelConfig['pricing']): void {
  if (!row.sidePath && row.prefixStable !== undefined) { acc.prefixSamples++; if (row.prefixStable) acc.prefixStable++ }
  if (row.usageFields && !row.usageFields.cache_creation_input_tokens) acc.cacheCreateUnreported++
  if (row.retry) acc.retryRequests++
  else if (row.sidePath) acc.sidePathRequests += 1
  else {
    acc.requests += 1
    if (row.cacheRead <= row.input && (!row.usageFields || (row.usageFields.input_tokens && row.usageFields.cache_read_input_tokens))) {
      acc.mainInput += row.input
      acc.mainCacheRead += row.cacheRead
    } else acc.hitRateUnknown++
  }
  acc.input += row.input
  acc.cacheRead += row.cacheRead
  acc.cacheCreate += row.cacheCreate
  acc.output += row.output
  if (!pricing) acc.unpriced = true
  if (pricing) {
    acc.cost += computeUsageCost({
      input_tokens: row.input,
      output_tokens: row.output,
      cache_read_input_tokens: row.cacheRead,
      cache_creation_input_tokens: row.cacheCreate,
    }, pricing).total
    const missPrice = pricing.input ?? 0
    const hitPrice = pricing.cacheRead ?? missPrice
    acc.savings += (row.cacheRead / 1_000_000) * Math.max(0, missPrice - hitPrice)
  }
}

function toTotals(acc: Accumulator): UsageTotals {
  const round = (v: number) => Math.round(v * 1_000_000) / 1_000_000
  return {
    ...(acc.prefixSamples ? { prefixSamples: acc.prefixSamples, prefixStableRate: Math.round(acc.prefixStable / acc.prefixSamples * 1000) / 10 } : {}),
    ...(acc.retryRequests ? { retryRequests: acc.retryRequests } : {}),
    ...(acc.cacheCreateUnreported ? { cacheCreateUnreported: acc.cacheCreateUnreported } : {}),
    ...(acc.hitRateUnknown ? { hitRateUnknown: acc.hitRateUnknown } : {}),
    requests: acc.requests,
    sidePathRequests: acc.sidePathRequests,
    input: acc.input,
    cacheRead: acc.cacheRead,
    cacheCreate: acc.cacheCreate,
    output: acc.output,
    hitRate: acc.mainInput > 0 ? Math.round(acc.mainCacheRead / acc.mainInput * 1000) / 10 : null,
    billedHitRate: acc.input > 0 ? Math.round(acc.cacheRead / acc.input * 1000) / 10 : null,
    cost: acc.unpriced ? null : round(acc.cost),
    savings: acc.unpriced ? null : round(acc.savings),
  }
}

/** Local-time day key (the panel is a human-facing daily view, not a billing ledger). */
export function dayKey(t: number): string {
  const d = new Date(t)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export interface AggregateRowsOptions {
  /** window in days, default 30 */
  days?: number
  /** clock override for tests */
  now?: number
  resolvePricing?: PricingResolver
}

/** Pure aggregation over parsed rows. Rows outside the [now − days, now] window are dropped. */
export function aggregateUsageRows(rows: readonly CacheUsageRow[], options: AggregateRowsOptions = {}): Omit<CacheUsageAggregate, 'scannedFiles' | 'skippedFiles'> {
  const windowDays = options.days ?? 30
  const now = options.now ?? Date.now()
  const windowStart = now - windowDays * 86_400_000
  const resolvePricing = options.resolvePricing

  const total = newAccumulator()
  const byDay = new Map<string, Accumulator>()
  // provider × model rollup (T3): spark and official DeepSeek share wire model
  // ids, so the rollup key must include provider when present. Legacy rows
  // without provider keep the bare-model key — they aggregate exactly as before.
  interface ModelBucket { acc: Accumulator; model: string; provider?: string }
  const byModel = new Map<string, ModelBucket>()
  const byDayModel = new Map<string, Map<string, ModelBucket>>()
  const bucketKey = (row: CacheUsageRow): string => row.provider ? `${row.provider}\u0000${row.model}` : row.model
  const bucketFor = (map: Map<string, ModelBucket>, row: CacheUsageRow): ModelBucket => {
    const key = bucketKey(row)
    let bucket = map.get(key)
    if (!bucket) {
      bucket = { acc: newAccumulator(), model: row.model, ...(row.provider ? { provider: row.provider } : {}) }
      map.set(key, bucket)
    }
    return bucket
  }

  for (const row of rows) {
    if (row.t < windowStart || row.t > now) continue
    const pricing = resolvePricing?.(row.model, row.provider, row.t)
    addRow(total, row, pricing)

    const day = dayKey(row.t)
    let dayAcc = byDay.get(day)
    if (!dayAcc) byDay.set(day, dayAcc = newAccumulator())
    addRow(dayAcc, row, pricing)

    addRow(bucketFor(byModel, row).acc, row, pricing)

    let dayModels = byDayModel.get(day)
    if (!dayModels) byDayModel.set(day, dayModels = new Map())
    addRow(bucketFor(dayModels, row).acc, row, pricing)
  }

  const sortModels = (entries: ReadonlyMap<string, ModelBucket>): ModelUsage[] =>
    [...entries.values()]
      .map(({ model, provider, acc }) => ({ model, ...(provider ? { provider } : {}), ...toTotals(acc) }))
      .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.input - a.input || a.model.localeCompare(b.model) || (a.provider ?? '').localeCompare(b.provider ?? ''))

  const days: DayUsage[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, acc]) => ({
      date,
      ...toTotals(acc),
      models: sortModels(byDayModel.get(date) ?? new Map()),
    }))

  return {
    totals: toTotals(total),
    days,
    models: sortModels(byModel),
    windowDays,
  }
}

const CACHE_LOG_NAME = 'cache-log.jsonl'

async function safeReaddirDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return []
  }
}

/**
 * Find cache-log files under the sessions root. Handles both layouts:
 * per-project root (`<root>/<sid>/cache-log.jsonl`) and all-projects root
 * (`<root>/<slug>/<sid>/cache-log.jsonl`). Files untouched since `minMtimeMs`
 * cannot contain in-window rows (append-only logs) and are skipped.
 */
async function findCacheLogs(root: string, minMtimeMs: number): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = []
  let skipped = 0

  const visit = async (dir: string, depth: number): Promise<void> => {
    try {
      const info = await stat(join(dir, CACHE_LOG_NAME))
      if (info.mtimeMs >= minMtimeMs) files.push(join(dir, CACHE_LOG_NAME))
      else skipped += 1
    } catch { /* no log at this level */ }
    if (depth >= 2) return
    const children = await safeReaddirDirs(dir)
    await Promise.all(children.map(name => visit(join(dir, name), depth + 1)))
  }

  await visit(root, 0)
  return { files, skipped }
}

export interface AggregateCacheUsageOptions extends AggregateRowsOptions {
  /** e.g. sessionsDir(cwd) for the current project, or sessionsDir() for all projects */
  sessionsRoot: string
}

export interface CollectedUsageRows {
  rows: CacheUsageRow[]
  scannedFiles: number
  skippedFiles: number
}

/**
 * Scan cache-log files once and return the raw rows — callers that need
 * several period views (today / 7d / 30d) aggregate the same rows repeatedly
 * with `aggregateUsageRows` instead of re-scanning the filesystem.
 */
export async function collectUsageRows(sessionsRoot: string, options: Pick<AggregateRowsOptions, 'days' | 'now'> = {}): Promise<CollectedUsageRows> {
  const windowDays = options.days ?? 30
  const now = options.now ?? Date.now()
  const windowStart = now - windowDays * 86_400_000
  const { files, skipped } = await findCacheLogs(sessionsRoot, windowStart)

  const rowChunks = await Promise.all(files.map(async file => {
    try {
      return parseUsageRows(await readFile(file, 'utf8'))
    } catch {
      return []
    }
  }))

  return { rows: rowChunks.flat(), scannedFiles: files.length, skippedFiles: skipped }
}

/** Scan cache-log files under a sessions root and aggregate usage. Best-effort: unreadable files are skipped. */
export async function aggregateCacheUsage(options: AggregateCacheUsageOptions): Promise<CacheUsageAggregate> {
  const windowDays = options.days ?? 30
  const now = options.now ?? Date.now()
  const collected = await collectUsageRows(options.sessionsRoot, { days: windowDays, now })
  const aggregate = aggregateUsageRows(collected.rows, { days: windowDays, now, resolvePricing: options.resolvePricing })
  return { ...aggregate, scannedFiles: collected.scannedFiles, skippedFiles: collected.skippedFiles }
}
