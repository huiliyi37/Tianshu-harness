import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { looksOffTopic, queryTokens } from '../relevance.js'
import type { SearchResult } from '../types.js'

/**
 * RED→GREEN: cn.bing.com 静默错位结果的识别。
 *
 * 原始缺陷（2026-09 外部诊断报告 + 本机复现）：BingBackend 同时携带
 * `setlang=en-US` 与 `Accept-Language: en-US` 时，cn.bing.com 对部分中文查询
 * 返回**结构完好但内容无关**的 SERP——HTTP 200、10 个 `b_algo` 块、解析器照单
 * 全收，于是"杭州西湖 门票预约"的答案变成"西南交通大学研究生院"。链式 fallback
 * 永不触发，因为这一层没有任何东西是"失败"的。
 *
 * 样本来源：本机实测（macOS，cn.bing.com 直连），非构造。
 *   - 错乱批 = `?q=杭州西湖 门票预约&setlang=en-US` + `Accept-Language: en-US,en;q=0.5`
 *     的 5 条实际返回；同一请求重复执行返回的**是另一批无关内容**（知乎/国家科学评论），
 *     说明这不是一条固定的兜底页，而是服务端侧的语言路由错位。
 *   - 正常批 = 去掉英文标识后的同一查询返回。
 */

// ── 错乱批：en 标识下同一查询的实际返回（无一条与查询相关）──────────────
const OFF_TOPIC_SERP = [
  { title: '西南交通大学研究生院（党委研究生工作部）', url: 'https://gsnews.swjtu.edu.cn/', snippet: '' },
  { title: '大师兄 - 知乎', url: 'https://www.zhihu.com/question/1', snippet: '' },
  { title: '国家科学评论 (National Science Review)', url: 'https://www.nsreviewgroup.com/', snippet: '' },
  { title: '湖南科技大学', url: 'https://www.hnust.edu.cn/', snippet: '' },
  { title: 'Nvidia Driver Install Location? Solved', url: 'https://nvidia.custhelp.com/', snippet: '' },
].map(r => ({ ...r, snippet: r.snippet || 'SERP 片段与查询无关。' })) as SearchResult[]

// ── 正常批：同一查询去掉 en 标识后的实际返回（首条含「杭州」bigram）────────
const ON_TOPIC_SERP: SearchResult[] = [
  { title: '杭州市_百度百科', url: 'https://baike.baidu.com/item/杭州市/200167', snippet: '杭州市，简称“杭”，浙江省辖地级市、省会。' },
  { title: '百度地图', url: 'https://map.baidu.com/', snippet: '浏览地图、地点搜索。' },
  { title: '杭州市人民政府门户网站', url: 'https://www.hangzhou.gov.cn/', snippet: '' },
  { title: '杭州不得不去的十个地方 - 知乎', url: 'https://zhuanlan.zhihu.com/p/150679193', snippet: '' },
]

const QUERY = '杭州西湖 门票预约'

describe('queryTokens', () => {
  it('中文按 bigram 切分、拉丁词整词保留', () => {
    assert.deepEqual(queryTokens('杭州西湖 门票预约'), ['杭州', '州西', '西湖', '门票', '票预', '预约'])
    assert.deepEqual(queryTokens('TypeScript 教程'), ['typescript', '教程'])
  })

  it('单个拉丁字符与单个汉字不产生词元（噪声太大，无法据以判定）', () => {
    assert.deepEqual(queryTokens('q'), [])
    assert.deepEqual(queryTokens('书'), [])
    assert.deepEqual(queryTokens('   '), [])
    assert.deepEqual(queryTokens('!?。'), [])
  })

  it('混排查询同时产出两类词元，大小写归一', () => {
    const t = queryTokens('DeepSeek V4 发布')
    assert.ok(t.includes('deepseek'))
    assert.ok(t.includes('v4'))
    assert.ok(t.includes('发布'))
  })
})

describe('looksOffTopic', () => {
  it('整批与查询零重叠 → 判定为跑题（真实错乱样本）', () => {
    assert.equal(looksOffTopic(QUERY, OFF_TOPIC_SERP), true)
  })

  it('存在任意一条命中 → 放行（真实正常样本，首条含「杭州」）', () => {
    assert.equal(looksOffTopic(QUERY, ON_TOPIC_SERP), false)
  })

  it('整批只命中一条也要放行——判据是整批而非逐条，避免误杀', () => {
    const mostlyOff = [OFF_TOPIC_SERP[0]!, OFF_TOPIC_SERP[1]!, ON_TOPIC_SERP[3]!]
    assert.equal(looksOffTopic(QUERY, mostlyOff), false)
  })

  it('标题无关但摘要命中 → 放行（摘要属于结果内容）', () => {
    const bySnippet: SearchResult[] = [
      { title: '某某旅游网', url: 'https://example.com/a', snippet: '杭州西湖门票免费预约入口，每日限流。' },
    ]
    assert.equal(looksOffTopic(QUERY, bySnippet), false)
  })

  it('拉丁查询大小写不敏感', () => {
    const r: SearchResult[] = [{ title: 'TypeScript: JavaScript With Syntax For Types.', url: 'https://x', snippet: '' }]
    assert.equal(looksOffTopic('typescript types', r), false)
  })

  it('空结果集不判定——空是 chain 的既有「no results」路径，不归守卫管', () => {
    assert.equal(looksOffTopic(QUERY, []), false)
  })

  it('查询提不出词元时不判定——宁可放行也不误杀', () => {
    assert.equal(looksOffTopic('q', [{ title: 't', url: 'https://x', snippet: 's' }]), false)
    assert.equal(looksOffTopic('书', [{ title: '无关标题', url: 'https://x', snippet: '' }]), false)
  })

  it('URL 不参与判定——slug 命中不代表内容相关', () => {
    const urlOnly: SearchResult[] = [
      { title: '完全无关的标题', url: 'https://spam.example/hangzhou-xihu-menpiao', snippet: '无关摘要。' },
    ]
    assert.equal(looksOffTopic(QUERY, urlOnly), true)
  })

  it('无意义查询的无关返回同样被识别（真实场景：asdfqwer → 西雅图地图）', () => {
    const r: SearchResult[] = [
      { title: '西雅图 Belltown 地图 - Google Maps', url: 'https://maps.example', snippet: 'Interactive map of Belltown, Seattle.' },
    ]
    assert.equal(looksOffTopic('asdfqwer 无意义词汇测试', r), true)
  })
})
