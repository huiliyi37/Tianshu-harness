/**
 * TokenLedgerService — 台账编排层：折叠新行 → 维护本地快照 → 按配置推送论坛。
 *
 * 三个消费面：
 *  - server 路由（summary/status/sync，见 src/server/token-ledger-routes.ts）
 *  - bootstrap 自动同步（autoSync=true 且配了 endpoint 时，会话内按间隔推）
 *  - shutdown 冲刷（有界超时，best-effort，绝不阻塞退出）
 *
 * 配置来源：config.tokenLedger（schema 见 src/config/schema.ts），env
 * RIVET_FORUM_API / RIVET_FORUM_TOKEN 覆盖 endpoint/apiKey（联调与多环境用）。
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { tokenLedgerStatePath, sessionsDir } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { findUsagePricing } from '../utils/deepseek-pricing.js'
import type { PricingResolver } from '../cache/usage-aggregator.js'
import { pushTokenUsageSnapshot, type FetchLike, type ForumPushResult } from './forum-sync.js'
import { DEFAULT_FORUM_ENDPOINT } from './settings.js'
import { TokenLedgerStore, type LedgerRefreshResult } from './store.js'
import type { TokenDayModelRecord, TokenLedgerTotals } from './types.js'

const DEFAULT_SYNC_INTERVAL_MINUTES = 30

export interface TokenLedgerServiceDeps {
  statePath?: string
  sessionsRoot?: string
  fetchImpl?: FetchLike
  now?: () => number
}

export interface TokenLedgerSyncOutcome {
  ok: boolean
  /** 未发起推送的原因 */
  skipped?: 'disabled' | 'no_endpoint' | 'no_key' | 'unchanged'
  push?: ForumPushResult
  newRows?: number
  digest?: string
}

export interface TokenLedgerStatus {
  enabled: boolean
  endpointConfigured: boolean
  autoSync: boolean
  autoSyncConfigured: boolean
  deviceId: string
  deviceName: string
  totals: TokenLedgerTotals
  dayCount: number
  /** 有本地变更未被论坛确认 */
  pending: boolean
  lastPushAt?: string
  lastPushResult?: { ok: boolean; status?: number; code?: string; error?: string; at?: string }
  statePath: string
}

export class TokenLedgerService {
  private config: Config
  private readonly store: TokenLedgerStore
  private readonly fetchImpl?: FetchLike
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private syncing: Promise<TokenLedgerSyncOutcome> | undefined
  private configGeneration = 0
  private syncingGeneration = 0
  private syncQueueEpoch = 0
  private syncAbort: AbortController | undefined

  constructor(config: Config, deps: TokenLedgerServiceDeps = {}) {
    this.config = config
    this.fetchImpl = deps.fetchImpl
    this.now = deps.now ?? (() => Date.now())
    const resolvePricing: PricingResolver = (model, provider, timestamp) =>
      findUsagePricing(this.config.provider.providers, provider ?? this.config.provider.default, model, timestamp ?? this.now())
    this.store = new TokenLedgerStore({
      statePath: deps.statePath ?? tokenLedgerStatePath(),
      sessionsRoot: deps.sessionsRoot ?? sessionsDir(),
      resolvePricing,
      now: this.now,
    })
  }

  get enabled(): boolean {
    return this.config.tokenLedger.enabled !== false
  }

  get endpoint(): string | undefined {
    return process.env.RIVET_FORUM_API || this.config.tokenLedger.forum?.endpoint || (this.apiKey?.trim() ? DEFAULT_FORUM_ENDPOINT : undefined)
  }

  private get apiKey(): string | undefined {
    return process.env.RIVET_FORUM_TOKEN || this.config.tokenLedger.forum?.apiKey
  }

  private get deviceName(): string {
    return this.config.tokenLedger.deviceName || hostname()
  }

  reconfigure(config: Config): void {
    this.configGeneration++
    this.syncAbort?.abort()
    this.stopAutoSync()
    this.config = config
    this.startAutoSync()
  }

  private get targetHash(): string {
    return createHash('sha256').update(this.endpoint ?? '').update('\0').update(this.apiKey ?? '').digest('hex')
  }

  /** 折叠 cache-log 新增计费行（幂等增量，游标推进后落盘）。 */
  refresh(): Promise<LedgerRefreshResult> {
    if (!this.enabled) return Promise.resolve({ newRows: 0, scannedFiles: 0 })
    return this.store.refresh()
  }

  /** 台账 day×model 明细（date 升序），sinceDate（YYYY-MM-DD）起。 */
  records(sinceDate?: string): TokenDayModelRecord[] {
    return this.store.records(sinceDate)
  }

  status(): TokenLedgerStatus {
    const totals = this.store.totals()
    return {
      enabled: this.enabled,
      endpointConfigured: Boolean(this.endpoint),
      autoSync: this.timer !== undefined,
      autoSyncConfigured: this.config.tokenLedger.forum?.autoSync === true,
      deviceId: this.store.deviceId,
      deviceName: this.deviceName,
      totals,
      dayCount: new Set(this.store.records().map(record => record.date)).size,
      // 空台账不算 pending——还没有任何值得论坛确认的内容。
      pending: this.enabled && totals.requests > 0 && (this.store.digest() !== this.store.lastPushedDigest || this.targetHash !== this.store.lastPushedTargetHash),
      lastPushAt: this.store.lastPushAt,
      lastPushResult: this.store.lastPushResult ? { ...this.store.lastPushResult, error: undefined } : undefined,
      statePath: this.store.filePath,
    }
  }

  /** 手动/定时同步：refresh → 摘要未变跳过 → 推送 → 落回执。进程内串行。 */
  syncNow(): Promise<TokenLedgerSyncOutcome> {
    if (this.syncing) {
      if (this.syncingGeneration === this.configGeneration) return this.syncing
      const epoch = this.syncQueueEpoch
      const resume = () => epoch === this.syncQueueEpoch ? this.syncNow() : Promise.resolve<TokenLedgerSyncOutcome>({ ok: false })
      return this.syncing.then(resume, resume)
    }
    this.syncingGeneration = this.configGeneration
    this.syncAbort = new AbortController()
    this.syncing = this.syncImpl(this.syncAbort.signal).finally(() => { this.syncing = undefined; this.syncAbort = undefined })
    return this.syncing
  }

  /**
   * 启动会话内自动同步。返回是否真正启动（未开 autoSync 或未配 endpoint 时
   * 是 no-op）。定时器 unref——绝不因为它的存在拖住进程退出。
   */
  startAutoSync(): boolean {
    if (this.timer || !this.enabled) return false
    if (this.config.tokenLedger.forum?.autoSync !== true || !this.endpoint || !this.apiKey?.trim()) return false
    const minutes = this.config.tokenLedger.forum.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES
    this.timer = setInterval(() => {
      void this.syncNow().catch(() => { /* fire-and-forget：失败回执已落在状态里 */ })
    }, minutes * 60_000)
    this.timer.unref?.()
    return true
  }

  stopAutoSync(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Always preserve local usage; upload on exit only with explicit opt-in. */
  async shutdownFlush(timeoutMs = 3_000): Promise<void> {
    const shouldUpload = this.timer !== undefined
    this.stopAutoSync()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        shouldUpload ? this.syncNow() : this.refresh(),
        new Promise<void>(resolve => {
          timeout = setTimeout(() => { this.syncQueueEpoch++; this.syncAbort?.abort(); resolve() }, timeoutMs)
        }),
      ])
    } catch { /* best-effort */ }
    finally { if (timeout) clearTimeout(timeout) }
  }

  private async syncImpl(signal: AbortSignal): Promise<TokenLedgerSyncOutcome> {
    if (!this.enabled) return { ok: false, skipped: 'disabled' }
    const { newRows } = await this.refresh()
    const endpoint = this.endpoint
    if (!endpoint) return { ok: false, skipped: 'no_endpoint', newRows }

    const apiKey = this.apiKey
    if (!apiKey?.trim()) return { ok: false, skipped: 'no_key', newRows }
    const targetHash = this.targetHash
    const { snapshot, digest } = await this.store.snapshotWithDigest(this.deviceName)
    // 台账没有 2xx 确认之外的变更时不重复推送（论坛端是累计 upsert，重推无信息量）。
    if (digest === this.store.lastPushedDigest && targetHash === this.store.lastPushedTargetHash && newRows === 0) {
      return { ok: true, skipped: 'unchanged', newRows, digest }
    }

    const push = await pushTokenUsageSnapshot(snapshot, {
      endpoint,
      apiKey,
      signal,
      fetchImpl: this.fetchImpl,
    })
    await this.store.markPushed(push.ok ? { ok: true, status: push.status } : {
      ok: false,
      status: 'status' in push ? push.status : undefined,
      code: 'code' in push ? push.code : undefined,
      error: 'error' in push ? push.error : undefined,
    }, digest, targetHash, snapshot.sentAt)
    return { ok: push.ok, push, newRows, digest }
  }
}
