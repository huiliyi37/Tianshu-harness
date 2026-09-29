import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCachePanel, type CachePanelData, type CachePeriodAggregate } from '../cache-panel.js'
import { aggregateUsageRows, type CacheUsageRow } from '../../../cache/usage-aggregator.js'
import { getTheme, setTheme } from '../../theme.js'

setTheme('tianshu')
const theme = getTheme()

const NOW = new Date(2026, 6, 30, 12, 0, 0).getTime()

function strip(lines: string[]): string {
  return lines.join('\n').replace(/\x1B\[[0-9;]*m/g, '')
}

function rows(count: number, overrides: Partial<CacheUsageRow> = {}): CacheUsageRow[] {
  return Array.from({ length: count }, (_, i) => ({
    t: NOW - i * 3_600_000,
    model: 'deepseek-chat',
    input: 10_000,
    cacheRead: 9_000,
    cacheCreate: 500,
    output: 800,
    sidePath: false,
    ...overrides,
  }))
}

function agg(input: CacheUsageRow[]): CachePeriodAggregate {
  return aggregateUsageRows(input, {
    now: NOW,
    days: 30,
    resolvePricing: () => ({ input: 4, output: 12, cacheRead: 0.4 }),
  })
}

function baseData(overrides: Partial<CachePanelData> = {}): CachePanelData {
  const a = agg(rows(3))
  return {
    period: 'today',
    session: {
      hitRate: 94.2,
      input: 30_000,
      output: 2_400,
      cacheRead: 27_000,
      cacheCreate: 1_500,
      cost: 0.0312,
      savings: 0.0972,
    },
    aggregates: { today: a, '7d': a, '30d': a },
    loading: false,
    official: { status: 'ready', source: 'platform', todayCost: 1.23, monthCost: 45.6, balance: '12.34', currency: 'CNY' },
    ...overrides,
  }
}

test('三段结构齐备：本会话 / 历史 / 官方，并标注两种口径', () => {
  const text = strip(renderCachePanel(baseData(), 100, 40, theme))
  assert.match(text, /缓存面板 · DeepSeek/)
  assert.match(text, /本地口径 read\/input · 官方口径 hit\/\(hit\+miss\)/)
  assert.match(text, /本会话/)
  assert.match(text, /历史（本项目全会话）/)
  assert.match(text, /官方 · platform\.deepseek\.com/)
  assert.match(text, /←\/→ 或 Tab 切换周期/)
})

test('本会话区显示命中率、四字段 token、成本与缓存节省', () => {
  const text = strip(renderCachePanel(baseData(), 100, 40, theme))
  assert.match(text, /⚡ 94\.2%/)
  assert.match(text, /输入 30\.0k/)
  assert.match(text, /读 27\.0k · 建 1\.5k/)
  assert.match(text, /成本 ¥0\.03/)
  assert.match(text, /缓存节省 ¥0\.10/)
})

test('当前周期页签高亮，其余为普通文本', () => {
  const text = strip(renderCachePanel(baseData({ period: '7d' }), 100, 40, theme))
  assert.match(text, /\[7天\]/)
  assert.doesNotMatch(text, /\[今日\]/)
})

test('历史区显示所选周期的聚合，切页签换数字', () => {
  const today = agg(rows(1))
  const week = agg(rows(5))
  const data = baseData({ aggregates: { today, '7d': week, '30d': week } })
  const todayText = strip(renderCachePanel({ ...data, period: 'today' }, 100, 40, theme))
  const weekText = strip(renderCachePanel({ ...data, period: '7d' }, 100, 40, theme))
  assert.match(todayText, /请求 1\b/)
  assert.match(weekText, /请求 5\b/)
})

test('侧路请求单列标注，不混进主请求计数', () => {
  const mixed = [...rows(2), ...rows(3, { sidePath: true })]
  const a = agg(mixed)
  const text = strip(renderCachePanel(baseData({ aggregates: { today: a, '7d': a, '30d': a } }), 100, 40, theme))
  assert.match(text, /请求 2 \(\+侧路 3\)/)
})

test('有侧路时历史区并列显示账单口径命中率，两口径数字可分', () => {
  // 主轮 2 行 90%；侧路 3 行命中率故意做差（10%）——主轮 90.0%，账单口径
  // (2×9000+3×1000)/50000 = 42.0%。若混算或漏算，两数不会同时正确。
  const mixed = [...rows(2), ...rows(3, { sidePath: true, cacheRead: 1_000 })]
  const a = agg(mixed)
  const text = strip(renderCachePanel(baseData({ aggregates: { today: a, '7d': a, '30d': a } }), 100, 40, theme))
  assert.match(text, /命中率 90\.0%（主轮） 账单口径 42\.0%/)
})

test('无侧路时不显示账单口径（两口径数学上相同，避免噪音）', () => {
  const a = agg(rows(3))
  const text = strip(renderCachePanel(baseData({ aggregates: { today: a, '7d': a, '30d': a } }), 100, 40, theme))
  assert.doesNotMatch(text, /账单口径/)
  assert.match(text, /命中率 90\.0%/)
})

test('无会话、无历史数据时给出空态而不是 NaN', () => {
  const empty = agg([])
  const text = strip(renderCachePanel(baseData({
    session: null,
    aggregates: { today: empty, '7d': empty, '30d': empty },
  }), 100, 40, theme))
  assert.match(text, /尚无请求/)
  assert.match(text, /该周期内没有请求记录/)
  assert.doesNotMatch(text, /NaN/)
})

test('聚合扫描中显示 loading，不显示空态', () => {
  const text = strip(renderCachePanel(baseData({ aggregates: null, loading: true }), 100, 40, theme))
  assert.match(text, /扫描 cache-log 中…/)
})

test('官方区三态：平台账单 / 仅余额 / 未登录引导', () => {
  const platform = strip(renderCachePanel(baseData(), 100, 40, theme))
  assert.match(platform, /今日 ¥1\.23 · 本月 ¥45\.60 · 余额 12\.34 CNY/)

  const balanceOnly = strip(renderCachePanel(baseData({
    official: { status: 'ready', source: 'balance', balance: '9.99', currency: 'CNY' },
  }), 100, 40, theme))
  assert.match(balanceOnly, /余额 9\.99 CNY/)
  assert.match(balanceOnly, /API key 口径；平台账单需桌面端登录/)

  const none = strip(renderCachePanel(baseData({
    official: { status: 'unavailable', hint: '未登录 DeepSeek 平台，去桌面端「成本」登录后可看官方账单' },
  }), 100, 40, theme))
  assert.match(none, /去桌面端「成本」登录/)
})

test('窄终端与矮视口不抛错，输出行数不超过视口', () => {
  const many = agg(rows(200, { t: NOW }))
  const data = baseData({ aggregates: { today: many, '7d': many, '30d': many } })
  for (const [cols, viewRows] of [[60, 12], [80, 24], [200, 60]] as const) {
    const lines = renderCachePanel(data, cols, viewRows, theme)
    assert.ok(lines.length > 0)
    assert.ok(lines.every(l => typeof l === 'string'))
  }
})

test('按天柱条只画在多天数据上，命中率按天标注', () => {
  const multi = agg([
    ...rows(2, { t: NOW }),
    ...rows(2, { t: NOW - 86_400_000, cacheRead: 2_000 }),
  ])
  const text = strip(renderCachePanel(baseData({ aggregates: { today: multi, '7d': multi, '30d': multi }, period: '30d' }), 100, 40, theme))
  assert.match(text, /07-30/)
  assert.match(text, /07-29/)
  assert.match(text, /▇/)
})
