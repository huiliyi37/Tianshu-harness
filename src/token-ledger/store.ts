/**
 * TokenLedgerStore — 本地 token 消耗台账引擎。
 *
 * 增量消费各会话 cache-log.jsonl（append-only）的计费行，折叠成
 * day × model(×provider) 累计记录，整体原子落盘。消费游标是字节偏移：
 * 仅提交完整换行边界；每次读取以上次 stat 的文件大小为上界。
 *
 * 失效方向（修复纪律）：
 *  - 文件被截断（size < offset）→ 游标直接钉到当前 size、跳过未知区间，
 *    宁可少算绝不重算（重算会让已折叠的行再计一次）；
 *  - 折叠与游标同一份状态原子落盘——崩溃至多丢失「已折叠未落盘」的一段，
 *    下次从旧游标重扫重做，结果一致；
 *  - 行解析完全复用 usage-aggregator 的 parseUsageRows / 计费行判据，
 *    不自写过滤，口径不漂移。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { writeFileAtomicDurableAsync } from '../fs-atomic.js'
import {
  attemptDedupeKey,
  dayKey,
  parseUsageRows,
  type CacheUsageRow,
  type PricingResolver,
} from '../cache/usage-aggregator.js'
import { StoreLock } from '../server/store-lock.js'
import { computeUsageCost } from '../utils/pricing.js'
import type {
  TokenDayModelRecord,
  TokenLedgerState,
  TokenLedgerTotals,
  TokenUsageSnapshot,
} from './types.js'

const CACHE_LOG_NAME = 'cache-log.jsonl'
const transactions = new Map<string, Promise<unknown>>()

interface LedgerIdentity {
  version: 1
  deviceId: string
  lastSnapshotAt?: string
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validState(value: unknown): value is TokenLedgerState {
  if (!object(value) || value.version !== 1 || typeof value.deviceId !== 'string' || !value.deviceId
    || !object(value.offsets) || !object(value.days)) return false
  if (Object.values(value.offsets).some(n => !Number.isSafeInteger(n) || (n as number) < 0)) return false
  return Object.values(value.days).every(buckets => object(buckets) && Object.values(buckets).every(record =>
    object(record) && typeof record.date === 'string' && typeof record.model === 'string'
    && ['requests', 'input', 'output', 'cacheRead', 'cacheCreate', 'cost'].every(key =>
      typeof record[key] === 'number' && Number.isFinite(record[key]) && (record[key] as number) >= 0)))
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

function parseJson(content: string | undefined): unknown {
  if (content === undefined) return undefined
  try { return JSON.parse(content) } catch { return undefined }
}

/** 与 usage-aggregator 的 rollup 键同构：provider 存在时参与复合键。 */
export function ledgerBucketKey(model: string, provider?: string): string {
  return provider ? `${provider}\0${model}` : model
}

/** 排序键的稳定序列化——digest 只依赖台账内容，与 Map/对象插入序无关。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

export function ledgerDigest(days: TokenLedgerState['days']): string {
  return createHash('sha256').update(stableStringify(days)).digest('hex')
}

function emptyTotals(): TokenLedgerTotals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 }
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000
}

export interface TokenLedgerStoreOptions {
  /** 状态文件路径（默认 tokenLedgerStatePath()） */
  statePath: string
  /** 会话根目录（默认 sessionsDir()，即全项目） */
  sessionsRoot: string
  resolvePricing?: PricingResolver
  /** 时钟注入（测试） */
  now?: () => number
}

export interface LedgerRefreshResult {
  newRows: number
  scannedFiles: number
}

export class TokenLedgerStore {
  private readonly statePath: string
  private readonly sessionsRoot: string
  private readonly resolvePricing?: PricingResolver
  private readonly now: () => number
  private state: TokenLedgerState | undefined
  private refreshing: Promise<LedgerRefreshResult> | undefined

  constructor(options: TokenLedgerStoreOptions) {
    this.statePath = options.statePath
    this.sessionsRoot = options.sessionsRoot
    this.resolvePricing = options.resolvePricing
    this.now = options.now ?? (() => Date.now())
  }

  get deviceId(): string {
    return this.load().deviceId
  }

  get filePath(): string {
    return this.statePath
  }

  get lastPushAt(): string | undefined {
    return this.load().lastPushAt
  }

  get lastPushResult(): TokenLedgerState['lastPushResult'] {
    return this.load().lastPushResult
  }

  get lastPushedTargetHash(): string | undefined {
    return this.load().lastPushedTargetHash
  }

  get lastPushedDigest(): string | undefined {
    return this.load().lastPushedDigest
  }

  /** 当前台账内容摘要；与 lastPushedDigest 不同即存在未推送变更。 */
  digest(): string {
    return ledgerDigest(this.load().days)
  }

  totals(): TokenLedgerTotals {
    const totals = emptyTotals()
    for (const buckets of Object.values(this.load().days)) {
      for (const record of Object.values(buckets)) {
        totals.requests += record.requests
        totals.input += record.input
        totals.output += record.output
        totals.cacheRead += record.cacheRead
        totals.cacheCreate += record.cacheCreate
        totals.cost += record.cost
      }
    }
    totals.cost = round6(totals.cost)
    return totals
  }

  /** 累计 day×model 明细（date 升序、同日 cost 降序），可经 since 过滤近 N 天。 */
  records(sinceDate?: string): TokenDayModelRecord[] {
    const out: TokenDayModelRecord[] = []
    for (const [date, buckets] of Object.entries(this.load().days)) {
      if (sinceDate && date < sinceDate) continue
      for (const record of Object.values(buckets)) out.push({ ...record })
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost || b.input - a.input)
    return out
  }

  /** 构造快照并持久化跨进程单调时间；digest 与载荷来自同一份锁内状态。 */
  async snapshot(deviceName: string): Promise<TokenUsageSnapshot> {
    return (await this.snapshotWithDigest(deviceName)).snapshot
  }

  snapshotWithDigest(deviceName: string): Promise<{ snapshot: TokenUsageSnapshot; digest: string }> {
    return this.transaction(async state => {
      const previous = Date.parse(state.lastSnapshotAt ?? '')
      const sentAt = new Date(Math.max(this.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString()
      state.lastSnapshotAt = sentAt
      this.state = state
      const snapshot: TokenUsageSnapshot = {
        version: 1, deviceId: state.deviceId, deviceName, sentAt,
        totals: this.totals(), days: this.records(),
      }
      return { snapshot, digest: ledgerDigest(state.days) }
    })
  }

  /**
   * 扫描 sessionsRoot 下所有 cache-log，把上次游标之后的新行折叠进台账，
   * 然后「游标 + days」同一份状态原子落盘。进程内并发 refresh 共享同一趟。
   */
  refresh(): Promise<LedgerRefreshResult> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refreshImpl()
      .finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** 回执仅确认实际上送的digest；迟到旧快照的回执不能覆盖较新的结果。 */
  markPushed(
    result: { ok: boolean; status?: number; code?: string; error?: string },
    digest?: string,
    targetHash?: string,
    sentAt?: string,
  ): Promise<void> {
    return this.transaction(async state => {
      if (sentAt && state.lastPushSnapshotAt && sentAt < state.lastPushSnapshotAt) return
      const at = new Date(this.now()).toISOString()
      if (result.ok) {
        state.lastPushAt = at
        state.lastPushedDigest = digest ?? ledgerDigest(state.days)
        state.lastPushedTargetHash = targetHash
      }
      if (sentAt) state.lastPushSnapshotAt = sentAt
      state.lastPushResult = { ...result, at }
    })
  }

  private load(reload = false): TokenLedgerState {
    if (this.state && !reload) return this.state
    const raw = readOptional(this.statePath)
    const parsed = parseJson(raw)
    const identityRaw = readOptional(this.statePath + '.identity.json')
    const candidate = parseJson(identityRaw)
    const identity = object(candidate) && candidate.version === 1
      && typeof candidate.deviceId === 'string' && candidate.deviceId ? candidate as unknown as LedgerIdentity : undefined
    const recoveredId = object(parsed) && typeof parsed.deviceId === 'string' && parsed.deviceId
      ? parsed.deviceId : undefined
    const deviceId = identity?.deviceId ?? recoveredId
    if (!deviceId && (raw !== undefined || identityRaw !== undefined)) {
      throw new Error('Token ledger identity cannot be recovered; restore the original device identity before syncing.')
    }
    if (validState(parsed) && identity && parsed.deviceId !== identity.deviceId) {
      throw new Error('Token ledger identity conflicts with its installation identity; restore matching files before syncing.')
    }
    const state: TokenLedgerState = validState(parsed) ? parsed : {
      version: 1, deviceId: deviceId ?? this.state?.deviceId ?? randomUUID(), offsets: {}, days: {},
    }
    const identityTimestamp = identity?.lastSnapshotAt
    if (identityTimestamp && (!state.lastSnapshotAt || identityTimestamp > state.lastSnapshotAt)) {
      state.lastSnapshotAt = identityTimestamp
    }
    this.state = state
    return state
  }

  /** StoreLock recognizes all same-process holders; the shared queue also serializes instances. */
  private transaction<T>(operation: (state: TokenLedgerState) => Promise<T>): Promise<T> {
    const key = resolve(this.statePath)
    const previous = transactions.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      const lock = new StoreLock({ lockPath: key + '.lock', legacyWriterLockPaths: [] })
      const acquired = await lock.acquire({ retryWindowMs: 5_000, retryIntervalMs: 25 })
      if (!acquired.acquired) throw new Error(`Cannot lock token ledger: ${acquired.status}`)
      try {
        const raw = readOptional(this.statePath)
        const state = this.load(true)
        if (raw !== undefined && !validState(parseJson(raw))) {
          await writeFileAtomicDurableAsync(this.statePath + '.corrupt-' + randomUUID() + '.bak', raw)
        }
        // Identity commits first, so a crash before state publication can still rebuild under the same id.
        const identity: LedgerIdentity = { version: 1, deviceId: state.deviceId,
          ...(state.lastSnapshotAt ? { lastSnapshotAt: state.lastSnapshotAt } : {}) }
        await writeFileAtomicDurableAsync(this.statePath + '.identity.json', JSON.stringify(identity))
        const result = await operation(state)
        if (state.lastSnapshotAt !== identity.lastSnapshotAt) {
          identity.lastSnapshotAt = state.lastSnapshotAt
          await writeFileAtomicDurableAsync(this.statePath + '.identity.json', JSON.stringify(identity))
        }
        await writeFileAtomicDurableAsync(this.statePath, JSON.stringify(state))
        this.state = state
        return result
      } catch (error) {
        this.state = undefined
        throw error
      } finally { lock.release() }
    })
    transactions.set(key, current)
    void current.finally(() => {
      if (transactions.get(key) === current) transactions.delete(key)
    }).catch(() => {})
    return current
  }

  private refreshImpl(): Promise<LedgerRefreshResult> {
    return this.transaction(async state => {
      const files = await findCacheLogFiles(this.sessionsRoot)
      let newRows = 0
      for (const file of files) {
        const rel = relative(this.sessionsRoot, file).split(sep).join('/')
        const prevOffset = state.offsets[rel] ?? 0
        let size: number
        try { size = (await stat(file)).size } catch { continue }
        const attempts = state.attempts ??= {}
        if (prevOffset > 0 && attempts[rel] === undefined) {
          // Migrate consumed v1 history once, collecting ids without replaying any usage.
          const consumed = await readFromOffset(file, 0, Math.min(prevOffset, size))
          attempts[rel] = [...new Set(consumed.toString('utf8').split(/\r?\n/).flatMap(line => {
            if (!parseUsageRows(line).length) return []
            const record = parseJson(line)
            const key = object(record) ? attemptDedupeKey(record) : undefined
            return key === undefined ? [] : [key]
          }))]
        }
        if (size < prevOffset) {
          // Preserve conservative truncation behavior; never replay previously consumed bytes.
          state.offsets[rel] = size
          continue
        }
        if (size === prevOffset) continue
        const content = await readFromOffset(file, prevOffset, size)
        if (!content.length) continue
        const seen = new Set(attempts[rel] ?? [])
        const lines = content.toString('utf8').split(/\r?\n/).reverse()
        const accepted: string[] = []
        for (const line of lines) {
          if (!parseUsageRows(line).length) continue
          const record = parseJson(line)
          const dedupeKey = object(record) ? attemptDedupeKey(record) : undefined
          if (dedupeKey !== undefined) {
            if (seen.has(dedupeKey)) continue
            seen.add(dedupeKey)
          }
          accepted.push(line)
        }
        const rows = parseUsageRows(accepted.reverse().join('\n'))
        for (const row of rows) this.fold(state, row)
        attempts[rel] = [...seen]
        newRows += rows.length
        state.offsets[rel] = prevOffset + content.length
      }
      return { newRows, scannedFiles: files.length }
    })
  }

  private fold(state: TokenLedgerState, row: CacheUsageRow): void {
    const date = dayKey(row.t)
    const key = ledgerBucketKey(row.model, row.provider)
    let buckets = Object.hasOwn(state.days, date) ? state.days[date] : undefined
    if (!buckets) state.days[date] = buckets = {}
    let record = Object.hasOwn(buckets, key) ? buckets[key] : undefined
    if (!record) {
      record = {
        date, model: row.model, ...(row.provider ? { provider: row.provider } : {}),
        requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0,
      }
      Object.defineProperty(buckets, key, { value: record, enumerable: true, writable: true, configurable: true })
    }
    record.requests += 1
    record.input += row.input
    record.output += row.output
    record.cacheRead += row.cacheRead
    record.cacheCreate += row.cacheCreate
    const pricing = this.resolvePricing?.(row.model, row.provider, row.t)
    if (pricing) {
      record.cost += computeUsageCost({
        input_tokens: row.input,
        output_tokens: row.output,
        cache_read_input_tokens: row.cacheRead,
        cache_creation_input_tokens: row.cacheCreate,
      }, pricing).total
    }
  }
}

/** 与 usage-aggregator findCacheLogs 同布局：`<root>/<sid>/` 或 `<root>/<slug>/<sid>/`。 */
async function findCacheLogFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    try {
      await stat(join(dir, CACHE_LOG_NAME))
      files.push(join(dir, CACHE_LOG_NAME))
    } catch { /* 本层无日志 */ }
    if (depth >= 2) return
    let children: string[] = []
    try {
      children = (await readdir(dir, { withFileTypes: true }))
        .filter(e => e.isDirectory()).map(e => e.name)
    } catch { /* 目录不可读 */ }
    await Promise.all(children.map(name => visit(join(dir, name), depth + 1)))
  }
  await visit(root, 0)
  return files
}

async function readFromOffset(file: string, offset: number, end: number): Promise<Buffer> {
  if (end <= offset) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(file, { start: offset, end: end - 1 })) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const content = Buffer.concat(chunks)
  const lastNewline = content.lastIndexOf(10)
  return content.subarray(0, lastNewline + 1)
}
