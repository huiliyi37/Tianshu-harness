import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aggregateCacheUsage,
  aggregateUsageRows,
  dayKey,
  parseUsageRows,
  type CacheUsageRow,
} from '../usage-aggregator.js'
import type { ModelConfig } from '../../config/schema.js'

const NOW = new Date(2026, 6, 30, 12, 0, 0).getTime() // 2026-07-30 local noon

function mainRow(overrides: Partial<CacheUsageRow> = {}): CacheUsageRow {
  return {
    t: NOW,
    model: 'deepseek-chat',
    input: 1000,
    cacheRead: 800,
    cacheCreate: 100,
    output: 50,
    sidePath: false,
    ...overrides,
  }
}

const deepseekPricing: ModelConfig['pricing'] = {
  input: 4,       // miss price per 1M
  output: 12,
  cacheRead: 0.4, // hit price per 1M
}

test('parseUsageRows: 主请求行保留、side_path 标记、非用量 event 行与坏行丢弃', () => {
  const content = [
    JSON.stringify({ t: NOW, turn: 1, model: 'deepseek-chat', input: 1000, cacheRead: 900, cacheCreate: 50, hitRate: '90.0%', output: 40 }),
    JSON.stringify({ event: 'side_path', kind: 'speculation', t: NOW, model: 'deepseek-chat', input: 500, cacheRead: 400, cacheCreate: 0, output: 10, hitRate: '80.0%' }),
    JSON.stringify({ event: 'reclaim_decision', t: NOW, turn: 3, action: 'trim' }),
    JSON.stringify({ event: 'amnesia_shadow', ts: NOW }),
    'not json at all',
    JSON.stringify({ t: NOW, model: 'deepseek-chat' }), // 无 input，丢弃
    '',
  ].join('\n')

  const rows = parseUsageRows(content)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.sidePath, false)
  assert.equal(rows[0]!.input, 1000)
  assert.equal(rows[1]!.sidePath, true)
  assert.equal(rows[1]!.input, 500)
})

test('parseUsageRows: 缺 model 落 unknown，缺 cacheRead/output 落 0', () => {
  const rows = parseUsageRows(JSON.stringify({ t: NOW, input: 100 }))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.model, 'unknown')
  assert.equal(rows[0]!.cacheRead, 0)
  assert.equal(rows[0]!.output, 0)
})

test('parseUsageRows: provider 字段透传（T3），缺席/空串则不设', () => {
  const content = [
    JSON.stringify({ t: NOW, model: 'deepseek-v4-flash', provider: 'deepseek-spark', input: 100 }),
    JSON.stringify({ event: 'side_path', kind: 'llm-speculation', t: NOW, model: 'deepseek-v4-flash', provider: 'deepseek', input: 50 }),
    JSON.stringify({ t: NOW, model: 'deepseek-v4-flash', input: 100 }), // 旧行无 provider
    JSON.stringify({ t: NOW, model: 'deepseek-v4-flash', provider: '', input: 100 }), // 空串视为缺席
  ].join('\n')
  const rows = parseUsageRows(content)
  assert.equal(rows.length, 4)
  assert.equal(rows[0]!.provider, 'deepseek-spark')
  assert.equal(rows[1]!.provider, 'deepseek')
  assert.equal(rows[2]!.provider, undefined)
  assert.equal(rows[3]!.provider, undefined)
})

test('aggregateUsageRows: 同 model 不同 provider 分行（spark vs 官方对照）', () => {
  const rows: CacheUsageRow[] = [
    mainRow({ model: 'deepseek-v4-flash', provider: 'deepseek', input: 1000, cacheRead: 900 }),
    mainRow({ model: 'deepseek-v4-flash', provider: 'deepseek-spark', input: 2000, cacheRead: 500 }),
    mainRow({ model: 'deepseek-v4-flash', provider: 'deepseek-spark', input: 2000, cacheRead: 700 }),
  ]
  const agg = aggregateUsageRows(rows, { now: NOW })
  assert.equal(agg.models.length, 2, '同 model 双 provider 必须各自成行')
  const official = agg.models.find(m => m.provider === 'deepseek')!
  const spark = agg.models.find(m => m.provider === 'deepseek-spark')!
  assert.equal(official.hitRate, 90)
  assert.equal(spark.requests, 2)
  assert.equal(spark.hitRate, 30) // (500+700)/(2000+2000)
  // 天级明细同样分行
  assert.equal(agg.days[0]!.models.length, 2)
})

test('aggregateUsageRows: 旧行（无 provider）与新行不合并、legacy 聚合行为不变', () => {
  const rows: CacheUsageRow[] = [
    mainRow({ model: 'deepseek-v4-flash', input: 1000, cacheRead: 800 }), // legacy
    mainRow({ model: 'deepseek-v4-flash', provider: 'deepseek-spark', input: 1000, cacheRead: 200 }),
  ]
  const agg = aggregateUsageRows(rows, { now: NOW })
  assert.equal(agg.models.length, 2)
  const legacy = agg.models.find(m => m.provider === undefined)!
  assert.equal(legacy.hitRate, 80, 'legacy 行独立聚合，口径与旧版一致')
})

test('aggregateUsageRows: resolvePricing 收到行级 provider（同 model 各按各价）', () => {
  const seen: Array<string | undefined> = []
  const rows: CacheUsageRow[] = [
    mainRow({ model: 'deepseek-v4-flash', provider: 'deepseek-spark' }),
    mainRow({ model: 'deepseek-v4-flash' }),
  ]
  aggregateUsageRows(rows, {
    now: NOW,
    resolvePricing: (_model, provider) => { seen.push(provider); return deepseekPricing },
  })
  assert.deepEqual(seen.sort(), ['deepseek-spark', undefined].sort())
})

test('aggregateUsageRows: 加权命中率只算主请求行（ΣcacheRead/Σinput）', () => {
  const rows: CacheUsageRow[] = [
    mainRow({ input: 1000, cacheRead: 900 }),
    mainRow({ input: 3000, cacheRead: 1500 }),
    // side_path 命中率 100%，若被计入会拉高结果
    mainRow({ input: 1000, cacheRead: 1000, sidePath: true }),
  ]
  const agg = aggregateUsageRows(rows, { now: NOW })
  // (900+1500)/(1000+3000) = 60%
  assert.equal(agg.totals.hitRate, 60)
  assert.equal(agg.totals.requests, 2)
  assert.equal(agg.totals.sidePathRequests, 1)
  // 消耗总量包含 side_path
  assert.equal(agg.totals.input, 5000)
  assert.equal(agg.totals.cacheRead, 3400)
})

test('aggregateUsageRows: 无主请求输入时 hitRate 为 null', () => {
  const agg = aggregateUsageRows([mainRow({ sidePath: true })], { now: NOW })
  assert.equal(agg.totals.hitRate, null)
})

test('aggregateUsageRows: 按天分桶升序 + 按模型降序（成本优先）', () => {
  const dayMs = 86_400_000
  const rows: CacheUsageRow[] = [
    mainRow({ t: NOW - 2 * dayMs, model: 'deepseek-chat', input: 1000 }),
    mainRow({ t: NOW, model: 'deepseek-chat', input: 2000 }),
    mainRow({ t: NOW, model: 'deepseek-reasoner', input: 500, output: 5000 }),
  ]
  const resolvePricing = () => deepseekPricing
  const agg = aggregateUsageRows(rows, { now: NOW, resolvePricing })

  assert.equal(agg.days.length, 2)
  assert.equal(agg.days[0]!.date, dayKey(NOW - 2 * dayMs))
  assert.equal(agg.days[1]!.date, dayKey(NOW))
  assert.equal(agg.days[1]!.models.length, 2)

  // reasoner output 5000×12/1M = 0.06 > chat 当日成本，排前
  assert.equal(agg.models[0]!.model, 'deepseek-reasoner')
  assert.ok(agg.models[0]!.cost > agg.models[1]!.cost)
})

test('aggregateUsageRows: 成本与缓存节省按 pricing 计算', () => {
  // input 1000（其中 read 800 / create 100 / uncached 100），output 50
  const agg = aggregateUsageRows([mainRow()], {
    now: NOW,
    resolvePricing: model => (model === 'deepseek-chat' ? deepseekPricing : undefined),
  })
  // cost = 100/1M×4 + 50/1M×12 + 800/1M×0.4 + 100/1M×4(cacheWrite 回落 input) = 0.0004+0.0006+0.00032+0.0004
  assert.ok(Math.abs(agg.totals.cost - 0.00172) < 1e-9)
  // savings = 800/1M × (4 − 0.4) = 0.00288
  assert.ok(Math.abs(agg.totals.savings - 0.00288) < 1e-9)
})

test('aggregateUsageRows: 无 pricing 时成本与节省为 0，token 统计不受影响', () => {
  const agg = aggregateUsageRows([mainRow()], { now: NOW })
  assert.equal(agg.totals.cost, 0)
  assert.equal(agg.totals.savings, 0)
  assert.equal(agg.totals.input, 1000)
})

test('aggregateUsageRows: 窗口外（过早/未来）的行被丢弃', () => {
  const rows: CacheUsageRow[] = [
    mainRow({ t: NOW - 31 * 86_400_000 }), // 30 天窗口外
    mainRow({ t: NOW + 60_000 }),          // 未来
    mainRow({ t: NOW }),
  ]
  const agg = aggregateUsageRows(rows, { days: 30, now: NOW })
  assert.equal(agg.totals.requests, 1)
  assert.equal(agg.windowDays, 30)
})

test('aggregateCacheUsage: 扫描两种目录布局并按 mtime 跳过陈旧文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-agg-'))
  try {
    // 布局 1：per-project root/<sid>/cache-log.jsonl
    const sidDir = join(root, 'session-a')
    await mkdir(sidDir, { recursive: true })
    await writeFile(join(sidDir, 'cache-log.jsonl'), JSON.stringify({ t: NOW, model: 'deepseek-chat', input: 1000, cacheRead: 500, cacheCreate: 0, output: 10 }) + '\n')

    // 布局 2：all-projects root/<slug>/<sid>/cache-log.jsonl
    const nestedDir = join(root, 'proj-abc123', 'session-b')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(join(nestedDir, 'cache-log.jsonl'), JSON.stringify({ t: NOW, model: 'deepseek-chat', input: 1000, cacheRead: 900, cacheCreate: 0, output: 10 }) + '\n')

    // 陈旧文件：mtime 早于窗口起点 → 跳过
    const staleDir = join(root, 'session-stale')
    await mkdir(staleDir, { recursive: true })
    const staleFile = join(staleDir, 'cache-log.jsonl')
    await writeFile(staleFile, JSON.stringify({ t: NOW, model: 'deepseek-chat', input: 9999, cacheRead: 0, cacheCreate: 0, output: 0 }) + '\n')
    const staleTime = new Date(NOW - 90 * 86_400_000)
    await utimes(staleFile, staleTime, staleTime)

    const agg = await aggregateCacheUsage({ sessionsRoot: root, days: 30, now: NOW })
    assert.equal(agg.scannedFiles, 2)
    assert.equal(agg.skippedFiles, 1)
    assert.equal(agg.totals.requests, 2)
    assert.equal(agg.totals.input, 2000)
    // (500+900)/2000 = 70%
    assert.equal(agg.totals.hitRate, 70)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('aggregateCacheUsage: 根目录不存在时返回空聚合而非抛错', async () => {
  const agg = await aggregateCacheUsage({ sessionsRoot: join(tmpdir(), 'no-such-dir-xyz'), now: NOW })
  assert.equal(agg.scannedFiles, 0)
  assert.equal(agg.totals.requests, 0)
  assert.equal(agg.totals.hitRate, null)
})
