/**
 * `/cache` 面板的数据装配层（TUI）。
 *
 * 渲染路径是同步的，而聚合扫描与官方账单都是异步的——本模块负责「同步给出当前
 * 快照 + 后台补数据 + 数据到位回调重画」，并对两路数据各自做 TTL 缓存，避免每帧
 * 重扫 cache-log 或重打平台接口。
 */
import {
  aggregateUsageRows,
  collectUsageRows,
  type CacheUsageRow,
  type PricingResolver,
} from '../cache/usage-aggregator.js'
import type { OfficialUsageSnapshot } from '../cache/deepseek-official-usage.js'
import type {
  CachePanelData,
  CachePanelOfficial,
  CachePanelSession,
  CachePeriod,
} from './format/cache-panel.js'

/** 最长回看窗口——一次扫盘覆盖三个周期页签。 */
export const CACHE_PANEL_MAX_DAYS = 30

const AGGREGATE_TTL_MS = 30_000
const OFFICIAL_TTL_MS = 60_000

export interface CachePanelSourceDeps {
  /** 会话根目录（默认当前项目 slug 目录） */
  sessionsRoot: () => string
  /** 本会话实时口径；null = 还没有会话/请求 */
  session: () => CachePanelSession | null
  resolvePricing: PricingResolver
  loadOfficial: () => Promise<OfficialUsageSnapshot>
  /** 异步数据到位后触发重画 */
  onUpdate: () => void
  now?: () => number
}

/** 周期 → 回看天数。`today` 取本地零点起（不是滚动 24 小时）。 */
export function periodDays(period: CachePeriod, now: number): number {
  if (period === '7d') return 7
  if (period === '30d') return 30
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return Math.max(0, (now - start.getTime()) / 86_400_000)
}

function toPanelOfficial(snapshot: OfficialUsageSnapshot): CachePanelOfficial {
  if (snapshot.source === 'none') {
    return { status: 'unavailable', hint: snapshot.hint }
  }
  return {
    status: 'ready',
    source: snapshot.source,
    todayCost: snapshot.todayCost,
    monthCost: snapshot.monthCost,
    balance: snapshot.balance,
    currency: snapshot.currency,
    hint: snapshot.hint,
  }
}

export class CachePanelSource {
  private rows: CacheUsageRow[] | null = null
  private rowsAt = 0
  private rowsLoading = false
  private official: CachePanelOfficial = { status: 'loading' }
  private officialAt = 0
  private officialLoading = false
  /** 三档聚合的记忆化（issue #98 配套）——data() 现在被 live 渲染循环逐帧调用
   *  （常驻余额角标读 official），聚合只随 rows 刷新（rowsAt 版本）变化，
   *  不做记忆化会让每帧重算三档全量遍历。 */
  private aggregatesCache: { rowsAt: number; value: NonNullable<CachePanelData['aggregates']> } | null = null

  constructor(private deps: CachePanelSourceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** 丢弃缓存，下次读取重新拉取（面板打开时调用，保证看到的是新数据）。 */
  invalidate(): void {
    this.rowsAt = 0
    this.officialAt = 0
  }

  private ensureRows(now: number): void {
    if (this.rowsLoading || now - this.rowsAt < AGGREGATE_TTL_MS) return
    this.rowsLoading = true
    void collectUsageRows(this.deps.sessionsRoot(), { days: CACHE_PANEL_MAX_DAYS, now })
      .then(collected => { this.rows = collected.rows })
      .catch(() => { this.rows = this.rows ?? [] })
      .finally(() => {
        this.rowsLoading = false
        this.rowsAt = this.now()
        this.deps.onUpdate()
      })
  }

  private ensureOfficial(now: number): void {
    if (this.officialLoading || now - this.officialAt < OFFICIAL_TTL_MS) return
    this.officialLoading = true
    void this.deps.loadOfficial()
      .then(snapshot => { this.official = toPanelOfficial(snapshot) })
      .catch(err => { this.official = { status: 'unavailable', hint: `官方账单查询失败：${(err as Error).message}` } })
      .finally(() => {
        this.officialLoading = false
        this.officialAt = this.now()
        this.deps.onUpdate()
      })
  }

  data(period: CachePeriod = 'today'): CachePanelData {
    const now = this.now()
    this.ensureRows(now)
    this.ensureOfficial(now)

    const rows = this.rows
    // rows 版本没变（30s TTL 内）就复用上次聚合：live 区逐帧调 data()，
    // 逐次重算三档是纯浪费。rowsAt 随每次扫盘完成更新，其变化即
    // 「聚合需要重算」的信号；invalidate() 把它归零，同样触发重算。
    if (rows !== null && (this.aggregatesCache === null || this.aggregatesCache.rowsAt !== this.rowsAt)) {
      this.aggregatesCache = {
        rowsAt: this.rowsAt,
        value: {
          today: aggregateUsageRows(rows, { days: periodDays('today', now), now, resolvePricing: this.deps.resolvePricing }),
          '7d': aggregateUsageRows(rows, { days: 7, now, resolvePricing: this.deps.resolvePricing }),
          '30d': aggregateUsageRows(rows, { days: 30, now, resolvePricing: this.deps.resolvePricing }),
        },
      }
    }
    const aggregates = rows !== null && this.aggregatesCache !== null ? this.aggregatesCache.value : null

    return {
      period,
      session: this.deps.session(),
      aggregates,
      loading: this.rowsLoading && rows === null,
      official: this.official,
    }
  }
}
