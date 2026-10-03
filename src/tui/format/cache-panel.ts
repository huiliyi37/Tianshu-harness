/**
 * `/cache` overlay — DeepSeek 专属缓存面板。
 *
 * 三段结构：本会话实时（与 GlanceBar 同源）→ 历史聚合（今日/7天/30天，
 * usage-aggregator 跨会话数据）→ 官方区（platform 登录账单或 API key 余额）。
 * 纯渲染函数，framework-agnostic（ansi/theme only），数据由 main.ts provider 注入。
 *
 * 口径标注：本地命中率 = ΣcacheRead/Σinput（主请求行），两口径分叉时并列
 * 账单口径 billedHitRate = ΣcacheRead/Σinput（全量行，与 billed-hit-rate.ts
 * 同义——侧路/重试行在差命中率上堆积时「成本涨、主轮命中率不动」靠它显形）；
 * 官方命中率 = hit/(hit+miss)——分母各不同，UI 上分别标注，不混算。
 */
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { formatTokens } from '../../utils/pricing.js'
import type { CacheUsageAggregate, DayUsage } from '../../cache/usage-aggregator.js'

export type CachePeriod = 'today' | '7d' | '30d'

export const CACHE_PERIODS: readonly CachePeriod[] = ['today', '7d', '30d']

const PERIOD_LABELS: Record<CachePeriod, string> = {
  today: '今日',
  '7d': '7天',
  '30d': '30天',
}

export type CachePeriodAggregate = Omit<CacheUsageAggregate, 'scannedFiles' | 'skippedFiles'>

export interface CachePanelSession {
  /** recent-turn hit rate percent（GlanceBar 同源），null = 尚无请求 */
  hitRate: number | null
  input: number
  output: number
  cacheRead: number
  cacheCreateUnreported?: boolean
  cacheCreate: number
  /** null = 无 pricing 可算 */
  cost: number | null
  savings: number | null
}

export interface CachePanelOfficial {
  status: 'loading' | 'unavailable' | 'ready'
  source?: 'platform' | 'balance'
  /** 元（platform 返回的 cost_in_cents 已在数据层 /100） */
  todayCost?: number
  monthCost?: number
  balance?: string
  currency?: string
  /** unavailable 时的引导文案 */
  hint?: string
}

export interface CachePanelData {
  period: CachePeriod
  session: CachePanelSession | null
  aggregates: { today: CachePeriodAggregate; '7d': CachePeriodAggregate; '30d': CachePeriodAggregate } | null
  /** 聚合扫描进行中 */
  loading: boolean
  official: CachePanelOfficial
}

function formatYuan(v: number): string {
  if (v === 0) return '0.00'
  if (v < 0.01) return v.toFixed(4)
  return v.toFixed(2)
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${rate.toFixed(1)}%`
}

function rateColor(rate: number | null, theme: RivetTheme): string {
  if (rate === null) return theme.dim
  if (rate >= 90) return theme.success
  if (rate >= 70) return theme.warning
  return theme.error
}

/**
 * 常驻余额角标（issue #98）——输入区状态行（formatWorkspaceMode）复用官方快照
 * 渲染的紧凑单行徽章，与 /cache 面板「官方区」同源同口径。
 *
 * 降级契约（issue #98 要求「不刷屏不报错」）：**仅 ready 时占位**——
 * loading / 未配置（no-credentials）/ 查询失败一律返回 null，不占行宽。
 * 引导文案（去桌面端登录）由 /cache 面板的官方区承担，角标不做二次打扰。
 *
 * 色：闲时（半价）用 success 呼应「省钱时段」（与 formatPricingPhaseBadge 同口径），
 * 峰时用 muted（常态不抢眼）；时段未知（非 DeepSeek / 无计价信号）回退 success
 * ——余额本身是正向信号。颜色一律走 theme token，无色终端按既有 color() 降级。
 */
export function formatOfficialUsageBadge(
  official: CachePanelOfficial,
  phase: 'peak' | 'offpeak' | undefined,
  theme: RivetTheme,
): string | null {
  if (official.status !== 'ready') return null
  const tint = phase === 'peak' ? theme.muted : theme.success
  const cur = official.currency ?? 'CNY'
  const balance = official.balance
  if (balance !== undefined && balance !== '') {
    // CNY 用 ¥ 前缀更紧凑；其他币种带上货币码，避免误读为人民币。
    const amount = cur === 'CNY' ? `¥${balance}` : `${balance} ${cur}`
    return color(`余额 ${amount}`, tint)
  }
  if (official.todayCost !== undefined) {
    return color(`今日 ¥${formatYuan(official.todayCost)}`, tint)
  }
  return null
}

/** 按天迷你双色柱：hit 段 success、miss（含 create/uncached）段 dim。 */
function dayBar(day: DayUsage, maxInput: number, width: number, theme: RivetTheme): string {
  if (maxInput <= 0 || day.input <= 0) return ''
  const cells = Math.max(1, Math.round(day.input / maxInput * width))
  const hitCells = Math.round(cells * (day.cacheRead / day.input))
  const missCells = cells - hitCells
  return color('▇'.repeat(hitCells), theme.success) + color('▇'.repeat(missCells), theme.dim)
}

function sectionTitle(text: string, theme: RivetTheme): string {
  return color(` ${text}`, theme.primary, { bold: true })
}

export function renderCachePanel(
  data: CachePanelData,
  columns: number,
  rows: number,
  theme: RivetTheme,
): string[] {
  const out: string[] = []
  out.push(color(' 缓存面板 · DeepSeek', theme.brandColor, { bold: true })
    + color('   本地口径 read/input · 官方口径 hit/(hit+miss)', theme.dim))
  out.push('')

  // ── 本会话 ─────────────────────────────────────────────
  out.push(sectionTitle('本会话', theme))
  const s = data.session
  if (!s) {
    out.push(color('  尚无请求。', theme.muted))
  } else {
    out.push(
      `  命中率 ${color(`⚡ ${formatRate(s.hitRate)}`, rateColor(s.hitRate, theme))}`
      + `   输入 ${formatTokens(s.input)}`
      + color(` (读 ${formatTokens(s.cacheRead)} · 建 ${(s.cacheCreateUnreported ? '未报告／部分报告' : formatTokens(s.cacheCreate))})`, theme.dim)
      + ` · 输出 ${formatTokens(s.output)}`,
    )
    if (s.cost !== null) {
      const savings = s.savings !== null && s.savings > 0
        ? `   缓存节省 ${color(`¥${formatYuan(s.savings)}`, theme.success)}`
        : ''
      out.push(`  成本 ¥${formatYuan(s.cost)}${savings}`)
    }
  }
  out.push('')

  // ── 历史聚合（周期切换）──────────────────────────────
  const tabs = CACHE_PERIODS.map(p => (
    p === data.period
      ? color(`[${PERIOD_LABELS[p]}]`, theme.primary, { bold: true })
      : color(` ${PERIOD_LABELS[p]} `, theme.dim)
  )).join(' ')
  out.push(sectionTitle('历史（本项目全会话）', theme) + '  ' + tabs)

  const agg = data.aggregates?.[data.period]
  if (data.loading && !agg) {
    out.push(color('  扫描 cache-log 中…', theme.muted))
  } else if (!agg || agg.totals.requests + agg.totals.sidePathRequests === 0) {
    out.push(color('  该周期内没有请求记录。', theme.muted))
  } else {
    const t = agg.totals
    out.push(
      `  请求 ${t.requests}${t.sidePathRequests > 0 ? color(` (+侧路 ${t.sidePathRequests})`, theme.dim) : ''}`
      + `   输入 ${formatTokens(t.input)} · 输出 ${formatTokens(t.output)}`
      + `   命中率 ${color(formatRate(t.hitRate), rateColor(t.hitRate, theme))}`
      // 判据是「两口径实际不同」而非「有侧路行」：除 side_path 外，retry
      // (stream_attempt_aborted) 与主轮用量未报告行同样只进 billed 分母，此时
      // sidePathRequests 为 0，枚举式判据会漏掉整类分叉。反向失效是安全的——
      // 数值巧合相等时只是少显示一列，不会显示错。
      + (t.billedHitRate !== t.hitRate
        ? color('（主轮）', theme.dim)
          + ` 账单口径 ${color(formatRate(t.billedHitRate), rateColor(t.billedHitRate, theme))}`
        : ''),
    )
    out.push(
      `  成本 ¥${formatYuan(t.cost)}`
      + (t.savings > 0 ? `   缓存节省 ${color(`¥${formatYuan(t.savings)}`, theme.success)}` : ''),
    )

    if (t.prefixStableRate !== undefined) out.push(color(`  客户端前缀稳定率 ${formatRate(t.prefixStableRate)}（${t.prefixSamples} 次观测）`, theme.dim))
    if (t.hitRateUnknown) out.push(color(`  ${t.hitRateUnknown} 次用量未报告，未计入命中率`, theme.dim))

    // 按天迷你柱（近 N 天，受视口高度约束）
    const officialLines = 4
    const fixedLines = out.length + 5 /* 模型表头+底部 */ + officialLines
    const maxDayRows = Math.max(3, rows - fixedLines - agg.models.length)
    const days = agg.days.slice(-maxDayRows)
    if (days.length > 1) {
      const maxInput = Math.max(...days.map(d => d.input))
      const barWidth = Math.max(10, Math.min(24, columns - 44))
      for (const day of days) {
        out.push(
          color(`  ${day.date.slice(5)} `, theme.dim)
          + dayBar(day, maxInput, barWidth, theme).padEnd(barWidth)
          + ` ${color(formatRate(day.hitRate), rateColor(day.hitRate, theme))}`
          + color(` ${formatTokens(day.input)}`, theme.dim),
        )
      }
    }

    // 按模型小表
    if (agg.models.length > 0) {
      const nameWidth = Math.min(28, Math.max(12, ...agg.models.map(m => m.model.length)))
      for (const m of agg.models) {
        out.push(
          color(`  ${m.model.slice(0, nameWidth).padEnd(nameWidth)}`, theme.secondary)
          + ` 输入 ${formatTokens(m.input).padStart(7)}`
          + `  命中 ${color(formatRate(m.hitRate).padStart(6), rateColor(m.hitRate, theme))}`
          + `  ¥${formatYuan(m.cost)}`,
        )
      }
    }
  }
  out.push('')

  // ── 官方区 ─────────────────────────────────────────────
  out.push(sectionTitle('官方 · platform.deepseek.com', theme))
  const o = data.official
  if (o.status === 'loading') {
    out.push(color('  查询中…', theme.muted))
  } else if (o.status === 'unavailable') {
    out.push(color(`  ${o.hint ?? '未检测到 DeepSeek 凭证。'}`, theme.muted))
  } else if (o.source === 'platform') {
    const cur = o.currency ?? 'CNY'
    const parts: string[] = []
    if (o.todayCost !== undefined) parts.push(`今日 ¥${formatYuan(o.todayCost)}`)
    if (o.monthCost !== undefined) parts.push(`本月 ¥${formatYuan(o.monthCost)}`)
    if (o.balance !== undefined) parts.push(`余额 ${color(`${o.balance} ${cur}`, theme.success)}`)
    out.push(`  ${parts.join(' · ')}`)
  } else {
    out.push(`  余额 ${color(`${o.balance ?? '—'} ${o.currency ?? 'CNY'}`, theme.success)}`
      + color('（API key 口径；平台账单需桌面端登录）', theme.dim))
  }

  out.push('')
  out.push(color('  ←/→ 或 Tab 切换周期 · q/Esc 关闭', theme.muted))
  return out
}
