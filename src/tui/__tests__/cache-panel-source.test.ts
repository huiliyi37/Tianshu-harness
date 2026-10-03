import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CachePanelSource, periodDays } from '../cache-panel-source.js'
import type { OfficialUsageSnapshot } from '../../cache/deepseek-official-usage.js'

const NOW = new Date(2026, 6, 30, 12, 0, 0).getTime() // 本地正午 → 今日已过 0.5 天

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

/** 条件轮询：负载下扫盘/快照解析耗时不定，固定 tick 是 flaky 源（D 波遗留 b）。
 *  正向断言一律等到条件成立（有界），负向窗口才用固定 tick。 */
async function waitFor(cond: () => boolean, timeoutMs = 3_000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）：${label}`)
    await tick(10)
  }
}

async function makeSessionsRoot(rows: Array<Record<string, unknown>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cache-src-'))
  const dir = join(root, 'session-1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cache-log.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return root
}

function mainRow(t: number, overrides: Record<string, unknown> = {}) {
  return { t, model: 'deepseek-chat', input: 10_000, cacheRead: 9_000, cacheCreate: 200, output: 500, ...overrides }
}

const noOfficial = async (): Promise<OfficialUsageSnapshot> => ({ source: 'none', hint: '未登录' })

test('periodDays: today 取本地零点起，7d/30d 是滚动窗口', () => {
  assert.equal(periodDays('7d', NOW), 7)
  assert.equal(periodDays('30d', NOW), 30)
  assert.equal(periodDays('today', NOW), 0.5)
})

test('首帧返回 loading，扫描完成后回调重画并给出三周期聚合', async () => {
  const root = await makeSessionsRoot([
    mainRow(NOW - 3_600_000),
    mainRow(NOW - 3 * 86_400_000),
    mainRow(NOW - 20 * 86_400_000),
  ])
  try {
    let updates = 0
    const source = new CachePanelSource({
      sessionsRoot: () => root,
      session: () => null,
      resolvePricing: () => ({ input: 4, output: 12, cacheRead: 0.4 }),
      loadOfficial: noOfficial,
      onUpdate: () => { updates += 1 },
      now: () => NOW,
    })

    const first = source.data()
    assert.equal(first.aggregates, null)
    assert.equal(first.loading, true)

    await waitFor(() => updates >= 1 && source.data('30d').aggregates !== null, 3_000, '首次扫盘完成')
    assert.ok(updates >= 1)

    const ready = source.data('30d')
    assert.ok(ready.aggregates)
    assert.equal(ready.loading, false)
    // 今日只含 1 条，7 天含 2 条，30 天含 3 条
    assert.equal(ready.aggregates!.today.totals.requests, 1)
    assert.equal(ready.aggregates!['7d'].totals.requests, 2)
    assert.equal(ready.aggregates!['30d'].totals.requests, 3)
    assert.equal(ready.period, '30d')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TTL 内不重复扫盘，invalidate 后重新扫', async () => {
  const root = await makeSessionsRoot([mainRow(NOW - 1_000)])
  try {
    let roots = 0
    const source = new CachePanelSource({
      sessionsRoot: () => { roots += 1; return root },
      session: () => null,
      resolvePricing: () => undefined,
      loadOfficial: noOfficial,
      onUpdate: () => {},
      now: () => NOW,
    })
    source.data()
    await waitFor(() => roots > 0 && !source.data().loading, 3_000, '首次扫盘完成')
    const afterFirst = roots
    source.data()
    source.data()
    await tick(20)
    assert.equal(roots, afterFirst, 'TTL 内不应再扫')

    source.invalidate()
    source.data()
    await waitFor(() => roots > afterFirst, 3_000, 'invalidate 后重扫')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('官方快照映射：平台 / 仅余额 / 不可用', async () => {
  const root = await makeSessionsRoot([mainRow(NOW - 1_000)])
  try {
    const make = (snapshot: OfficialUsageSnapshot) => new CachePanelSource({
      sessionsRoot: () => root,
      session: () => null,
      resolvePricing: () => undefined,
      loadOfficial: async () => snapshot,
      onUpdate: () => {},
      now: () => NOW,
    })

    const platform = make({ source: 'platform', todayCost: 1.5, monthCost: 20, balance: '3.21', currency: 'CNY' })
    platform.data()
    await waitFor(() => platform.data().official.status === 'ready', 3_000, 'platform 快照就绪')
    assert.deepEqual(
      { ...platform.data().official },
      { status: 'ready', source: 'platform', todayCost: 1.5, monthCost: 20, balance: '3.21', currency: 'CNY', hint: undefined },
    )

    const balance = make({ source: 'balance', balance: '9.9', currency: 'CNY' })
    balance.data()
    await waitFor(() => balance.data().official.source === 'balance', 3_000, 'balance 快照就绪')
    assert.equal(balance.data().official.source, 'balance')

    const none = make({ source: 'none', hint: '未登录 DeepSeek 平台' })
    none.data()
    await waitFor(() => none.data().official.status === 'unavailable', 3_000, 'none 快照就绪')
    assert.equal(none.data().official.status, 'unavailable')
    assert.match(none.data().official.hint ?? '', /未登录/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('官方查询抛错时降级为不可用提示，不冒泡到渲染', async () => {
  const root = await makeSessionsRoot([mainRow(NOW - 1_000)])
  try {
    const source = new CachePanelSource({
      sessionsRoot: () => root,
      session: () => null,
      resolvePricing: () => undefined,
      loadOfficial: async () => { throw new Error('boom') },
      onUpdate: () => {},
      now: () => NOW,
    })
    source.data()
    await waitFor(() => source.data().official.status === 'unavailable', 3_000, '错误降级')
    const official = source.data().official
    assert.equal(official.status, 'unavailable')
    assert.match(official.hint ?? '', /boom/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('扫描失败（目录不存在）不卡在 loading', async () => {
  const source = new CachePanelSource({
    sessionsRoot: () => join(tmpdir(), 'definitely-missing-cache-root'),
    session: () => null,
    resolvePricing: () => undefined,
    loadOfficial: noOfficial,
    onUpdate: () => {},
    now: () => NOW,
  })
  source.data()
  await waitFor(() => source.data().loading === false, 3_000, '缺失目录扫盘收尾')
  const data = source.data()
  assert.equal(data.loading, false)
  assert.ok(data.aggregates)
  assert.equal(data.aggregates!.today.totals.requests, 0)
})

test('TTL 内三档聚合按 rows 版本记忆化——逐帧调用不重算（#98 配套）', async () => {
  const root = await makeSessionsRoot([mainRow(NOW - 1_000)])
  try {
    const source = new CachePanelSource({
      sessionsRoot: () => root,
      session: () => null,
      resolvePricing: () => undefined,
      loadOfficial: noOfficial,
      onUpdate: () => {},
      now: () => NOW,
    })
    source.data()
    await waitFor(() => source.data().aggregates !== null, 3_000, '首次扫盘完成')

    const first = source.data('7d')
    const second = source.data('30d')
    assert.ok(first.aggregates)
    assert.equal(first.aggregates, second.aggregates, 'TTL 内应复用同一 aggregates 对象（未重算）')

    // invalidate（面板打开时调用）把 rowsAt 归零 → 缓存版本失配 → 重算，引用更新。
    source.invalidate()
    assert.notEqual(source.data().aggregates, first.aggregates, 'invalidate 后应重算')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
