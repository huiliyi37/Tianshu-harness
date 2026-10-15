import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebSearchTool, WEB_SEARCH_TOOL } from '../tool.js'
import type { SearchBackend } from '../types.js'

function backend(name: string, behavior: SearchBackend['search'], available = true): SearchBackend {
  return { name, isAvailable: () => available, search: behavior }
}

const params = (input: Record<string, unknown>) => ({ input, toolUseId: 't', cwd: '/tmp' })

describe('createWebSearchTool', () => {
  it('keeps the tool definition byte-stable regardless of backends (prefix cache)', () => {
    const a = createWebSearchTool()
    const b = createWebSearchTool({ backends: [backend('brave', async () => [])] })
    assert.deepEqual(a.definition, b.definition)
    assert.deepEqual(WEB_SEARCH_TOOL.definition, a.definition)
    assert.equal(a.definition.name, 'web_search')
  })

  it('rejects an empty query', async () => {
    const tool = createWebSearchTool()
    const out = await tool.execute(params({ query: '  ' }))
    assert.equal(out.isError, true)
    assert.match(out.content, /非空字符串/)
  })

  it('formats results and attributes the winning backend', async () => {
    const tool = createWebSearchTool({
      backends: [backend('brave', async () => [{ title: 'T', url: 'https://x', snippet: 'S' }])],
    })
    const out = await tool.execute(params({ query: 'q' }))
    assert.equal(out.isError, undefined)
    assert.match(out.content, /经 brave/)
    assert.match(out.content, /\[T\]\(https:\/\/x\)/)
  })

  it('returns a benign no-results message when all backends are empty', async () => {
    const tool = createWebSearchTool({ backends: [backend('ddg', async () => [])] })
    const out = await tool.execute(params({ query: 'nothing here' }))
    assert.equal(out.isError, undefined)
    assert.match(out.content, /未找到与「nothing here」相关的搜索结果/)
  })

  it('renders the low-confidence fallback as an explicitly off-topic, non-answer outcome', async () => {
    // issue #484 问题 1：兜底不得与正常路径同构。判跑题的批次只能作为「后端确实
    // 返回过内容」的信号保留，输出必须显式标注「已判定不相关」，且不得复用普通
    // 结果的标题形态——否则模型会把泛结果当成答案。
    const tool = createWebSearchTool({
      backends: [backend('bing', async () => [
        { title: '魔兽世界数据库NPC', url: 'https://x/1', snippet: '无关。' },
        { title: '知乎ChatGPT问答', url: 'https://x/2', snippet: '无关。' },
      ])],
    })
    const out = await tool.execute(params({ query: '如何解决 npm install 报错 EACCES permission denied' }))
    assert.equal(out.isError, undefined)
    assert.match(out.content, /已判定不相关/)
    assert.ok(
      !out.content.includes('的网页搜索结果（经'),
      '兜底标题不得复用正常路径的「…的网页搜索结果（经 …）」形态',
    )
  })

  it('truncates the low-confidence fallback instead of dumping every off-topic hit', async () => {
    // issue #484 问题 1：兜底结果必须截断——全量回灌会放大噪声、且与正常结果更难区分。
    const rows = Array.from({ length: 5 }, (_, i) => ({
      title: `无关条目${i}`, url: `https://example.com/${i}`, snippet: '与查询无关。',
    }))
    const tool = createWebSearchTool({ backends: [backend('bing', async () => rows)] })
    const out = await tool.execute(params({ query: '如何解决 npm install 报错 EACCES permission denied' }))
    assert.equal(out.isError, undefined)
    assert.match(out.content, /https:\/\/example\.com\/0/)
    assert.match(out.content, /https:\/\/example\.com\/2/)
    assert.ok(!out.content.includes('https://example.com/3'), '超过展示上限的兜底结果不得出现')
    assert.ok(!out.content.includes('https://example.com/4'))
    assert.match(out.content, /已截断/)
  })

  it('keeps a relevant result set unlabelled', async () => {
    const tool = createWebSearchTool({
      backends: [backend('bing', async () => [
        { title: '2026杭州西湖景区门票预约购买入口汇总', url: 'https://x/1', snippet: '杭州西湖门票预约入口，每日限流。' },
        { title: '杭州西湖景区预约指南', url: 'https://x/2', snippet: '西湖门票预约流程与开放时间。' },
      ])],
    })
    const out = await tool.execute(params({ query: '杭州西湖 门票预约' }))
    assert.equal(out.isError, undefined)
    assert.ok(!out.content.includes('低相关'), '相关结果不得带低相关标注')
    assert.match(out.content, /经 bing/)
  })

  it('does not report a hard error when the only results are low-confidence', async () => {
    // 软失败语义：低置信兜底不是硬错误，不该显示「搜索失败」。
    const tool = createWebSearchTool({
      backends: [backend('bing', async () => [
        { title: '湖南科技大学', url: 'https://www.hnust.edu.cn/', snippet: '无关。' },
      ])],
    })
    const out = await tool.execute(params({ query: '杭州西湖 门票预约' }))
    assert.equal(out.isError, undefined)
    assert.ok(!out.content.includes('搜索失败'))
  })

  it('surfaces an error when all backends fail hard', async () => {
    const tool = createWebSearchTool({
      backends: [backend('ddg', async () => { throw new Error('HTTP 503') })],
    })
    const out = await tool.execute(params({ query: 'q' }))
    assert.equal(out.isError, true)
    assert.match(out.content, /搜索失败/)
    assert.match(out.content, /ddg: HTTP 503/)
  })

  it('coerces a numeric-string count to a number', async () => {
    let receivedCount: number | undefined
    const tool = createWebSearchTool({
      backends: [backend('brave', async (_q, count) => {
        receivedCount = count
        return Array.from({ length: count }, (_, i) => ({
          title: `T${i}`,
          url: `https://x/${i}`,
          snippet: 'S',
        }))
      })],
    })
    const out = await tool.execute(params({ query: 'q', count: '3' }))
    assert.equal(out.isError, undefined)
    assert.equal(receivedCount, 3)
    assert.match(out.content, /1\. \[T0\]\(https:\/\/x\/0\)/)
    assert.match(out.content, /3\. \[T2\]\(https:\/\/x\/2\)/)
  })

  it('coerces a numeric query to a string', async () => {
    let receivedQuery: string | undefined
    const tool = createWebSearchTool({
      backends: [backend('brave', async (q) => {
        receivedQuery = q
        // 标题回带查询词：否则「123」与「T」零重叠会被 off-topic 守卫判为低置信兜底
        // （守卫行为见 relevance.test.ts）。本用例只关心 query 的类型转换。
        return [{ title: 'T123', url: 'https://x', snippet: 'S' }]
      })],
    })
    const out = await tool.execute(params({ query: 123 }))
    assert.equal(out.isError, undefined)
    assert.equal(receivedQuery, '123')
    assert.match(out.content, /「123」的网页搜索结果/)
  })

  it('falls back to the default count for an invalid count string', async () => {
    let receivedCount: number | undefined
    const tool = createWebSearchTool({
      backends: [backend('brave', async (_q, count) => {
        receivedCount = count
        return Array.from({ length: count }, (_, i) => ({
          title: `T${i}`,
          url: `https://x/${i}`,
          snippet: 'S',
        }))
      })],
    })
    const out = await tool.execute(params({ query: 'q', count: 'abc' }))
    assert.equal(out.isError, undefined)
    assert.equal(receivedCount, 10)
  })

  it('requires approval and is concurrency-safe', () => {
    const tool = createWebSearchTool()
    assert.equal(tool.requiresApproval(params({ query: 'q' })), true)
    assert.equal(tool.isConcurrencySafe(), true)
    assert.equal(tool.isEnabled(), true)
  })
})
