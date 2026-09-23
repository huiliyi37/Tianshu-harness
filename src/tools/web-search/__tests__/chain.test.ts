import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runBackendChain } from '../chain.js'
import { OFF_TOPIC_ERROR } from '../relevance.js'
import type { SearchBackend, SearchResult } from '../types.js'

function backend(
  name: string,
  behavior: () => Promise<SearchResult[]>,
  available = true,
): SearchBackend & { calls: number } {
  return {
    name,
    calls: 0,
    isAvailable: () => available,
    async search() {
      ;(this as { calls: number }).calls++
      return behavior()
    },
  }
}

const hit: SearchResult[] = [{ title: 't', url: 'https://x', snippet: 's' }]

/** 覆盖两个查询词（杭州西湖 / 门票预约）的真实形态样本——判跑题判据下的「相关批」。 */
const relevant: SearchResult[] = [
  { title: '2026杭州西湖景区门票预约购买入口汇总', url: 'https://x/r1', snippet: '杭州西湖门票预约入口，每日限流。' },
  { title: '杭州西湖景区预约指南', url: 'https://x/r2', snippet: '西湖门票预约流程与开放时间。' },
]

describe('runBackendChain', () => {
  it('returns the first non-empty backend and short-circuits the rest', async () => {
    const first = backend('brave', async () => hit)
    const second = backend('ddg', async () => hit)
    const out = await runBackendChain([first, second], 'q', 10, 1000)
    assert.equal(out.backend, 'brave')
    assert.deepEqual(out.results, hit)
    assert.equal(first.calls, 1)
    assert.equal(second.calls, 0, 'second backend must not be called after a hit')
  })

  it('falls through on empty results and records them', async () => {
    const first = backend('brave', async () => [])
    const second = backend('ddg', async () => hit)
    const out = await runBackendChain([first, second], 'q', 10, 1000)
    assert.equal(out.backend, 'ddg')
    assert.equal(second.calls, 1)
    assert.deepEqual(out.errors, [{ backend: 'brave', message: 'no results' }])
  })

  it('falls through on a thrown error and records the message', async () => {
    const first = backend('brave', async () => { throw new Error('HTTP 429') })
    const second = backend('ddg', async () => hit)
    const out = await runBackendChain([first, second], 'q', 10, 1000)
    assert.equal(out.backend, 'ddg')
    assert.equal(out.errors[0]!.backend, 'brave')
    assert.match(out.errors[0]!.message, /HTTP 429/)
  })

  it('skips unavailable backends without recording an error', async () => {
    const skipped = backend('brave', async () => hit, false)
    const used = backend('ddg', async () => hit)
    const out = await runBackendChain([skipped, used], 'q', 10, 1000)
    assert.equal(out.backend, 'ddg')
    assert.equal(skipped.calls, 0)
    assert.equal(out.errors.length, 0)
  })

  it('returns null backend with aggregated errors when all fail', async () => {
    const a = backend('brave', async () => { throw new Error('boom') })
    const b = backend('ddg', async () => [])
    const out = await runBackendChain([a, b], 'q', 10, 1000)
    assert.equal(out.backend, null)
    assert.deepEqual(out.results, [])
    assert.equal(out.errors.length, 2)
  })

  // 静默错位：HTTP 200 + 解析成功 + 内容与查询无关。必须像空结果一样落穿，
  // 否则无关内容会被当成答案交给模型（2026-09 cn.bing.com 故障形态）。
  it('falls through when a backend returns off-topic results', async () => {
    const offTopic = backend('bing', async () => [
      { title: '西南交通大学研究生院（党委研究生工作部）', url: 'https://gsnews.swjtu.edu.cn/', snippet: '与查询无关的内容。' },
    ])
    const onTopic = backend('ddg', async () => relevant)
    const out = await runBackendChain([offTopic, onTopic], '杭州西湖 门票预约', 10, 1000)
    assert.equal(out.backend, 'ddg', 'off-topic 结果不得胜出')
    assert.equal(onTopic.calls, 1, '必须继续走后一个后端')
    assert.deepEqual(out.errors, [{ backend: 'bing', message: OFF_TOPIC_ERROR }])
  })

  it('returns null backend when every backend is off-topic', async () => {
    const a = backend('bing', async () => [
      { title: '国家科学评论 (National Science Review)', url: 'https://example.com/a', snippet: '无关。' },
    ])
    const b = backend('ddg', async () => [
      { title: 'Nvidia Driver Install Location?', url: 'https://example.com/b', snippet: 'Unrelated.' },
    ])
    const out = await runBackendChain([a, b], '杭州西湖 门票预约', 10, 1000)
    assert.equal(out.backend, null)
    assert.deepEqual(out.results, [], '跑题结果不得胜出')
    assert.equal(out.errors.length, 2)
  })

  // 兜底契约：判跑题的批次不静默消失——链序第一个非空批次记入 offTopicFallback，
  // 供 tool 层在全部后端都无相关结果时降级返回（带显式低相关标注）。
  it('retains the first off-topic batch as a low-confidence fallback', async () => {
    const bingBatch: SearchResult[] = [
      { title: '美国（美国）_百度百科', url: 'https://example.com/1', snippet: '美国是……' },
      { title: '国家概况_中华人民共和国外交部', url: 'https://example.com/2', snippet: '美国前五大货物贸易伙伴……' },
    ]
    const a = backend('bing', async () => bingBatch)
    const b = backend('ddg', async () => [
      { title: 'Nvidia Driver Install Location?', url: 'https://example.com/b', snippet: 'Unrelated.' },
    ])
    const out = await runBackendChain([a, b], '美国 AI 实验室 出逃', 10, 1000)
    assert.equal(out.backend, null)
    assert.deepEqual(out.results, [], '兜底不得伪装成胜出结果')
    assert.equal(out.offTopicFallback?.backend, 'bing')
    assert.deepEqual(out.offTopicFallback?.results, bingBatch)
  })

  // 反向保护：多词覆盖过半 → 放行，不误杀。
  it('keeps a result set whose majority covers two query words', async () => {
    const mixed = backend('bing', async () => [
      ...relevant,
      { title: '杭州市人民政府门户网站', url: 'https://x/3', snippet: '政务公开。' },
    ])
    const fallback = backend('ddg', async () => hit)
    const out = await runBackendChain([mixed, fallback], '杭州西湖 门票预约', 10, 1000)
    assert.equal(out.backend, 'bing')
    assert.equal(fallback.calls, 0)
    assert.deepEqual(out.errors, [])
  })

  // 2026-09 降级形态：只覆盖查询中最泛的词。整批不得胜出。
  it('rejects a batch that only covers a single generic word', async () => {
    const generic = backend('bing', async () => [
      { title: '杭州市_百度百科', url: 'https://x/1', snippet: '杭州市，浙江省省会。' },
      { title: '百度地图', url: 'https://x/2', snippet: '浏览地图、地点搜索。' },
      { title: '杭州市人民政府门户网站', url: 'https://x/3', snippet: '政务公开。' },
    ])
    const fallback = backend('ddg', async () => relevant)
    const out = await runBackendChain([generic, fallback], '杭州西湖 门票预约', 10, 1000)
    assert.equal(out.backend, 'ddg', '只覆盖单泛词的批不得胜出')
    assert.deepEqual(out.errors, [{ backend: 'bing', message: OFF_TOPIC_ERROR }])
  })
})
