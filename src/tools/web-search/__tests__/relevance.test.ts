import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { looksOffTopic, queryTokens } from '../relevance.js'
import { LOW_QUALITY_SERPS, RELEVANT_SERPS } from './fixtures/bing-serp-samples.js'
import type { SearchResult } from '../types.js'

/**
 * cn.bing.com 静默错位/降级结果的识别。
 *
 * 第一轮缺陷（2026-09 外部诊断报告 + 本机复现）：BingBackend 同时携带
 * `setlang=en-US` 与 `Accept-Language: en-US` 时，cn.bing.com 对部分中文查询
 * 返回**结构完好但内容无关**的 SERP——HTTP 200、10 个 `b_algo` 块、解析器照单
 * 全收，于是"杭州西湖 门票预约"的答案变成"西南交通大学研究生院"。链式 fallback
 * 永不触发，因为这一层没有任何东西是"失败"的。→ 修复：去掉英文语言标识 +
 * 零重叠守卫（本文件下方的 OFF_TOPIC_SERP 样本）。
 *
 * 第二轮缺陷（2026-09-23 外部诊断报告 + 本机 8 组真实 SERP 对账）：语言标识修复后，
 * cn.bing.com 对**多词查询**仍会返回"降级泛结果"——只匹配查询中最泛的那个词
 * （`美国 AI 实验室 出逃 事件 7月 智能体` → 清一色"美国"百科/领事馆页面；
 * `量子计算 原理 区别 应用` → 清一色"量子"科普）。零重叠判据对这类结果**全部放行**
 * （它们命中了一个泛词），于是劣质结果被当成答案交给模型。
 *
 * 判据演进：从「任意一个词元命中即放行」改为**按查询词覆盖计分**——
 * 要求「覆盖 ≥2 个不同查询词」的结果过半数。同一个查询词内的多枚 bigram
 * 只计一词，避免"量子计算"这一个词靠 3 枚 bigram 自重叠虚高达标。
 * 单查询词（无可比对的覆盖信号）退回零重叠判据，保持保守。
 *
 * 样本来源：本机实测（Windows，cn.bing.com 直连），非构造。真实批见
 * `./fixtures/bing-serp-samples.ts`（完整 10 条/组，判据是过半数形式，条数影响判定）。
 */

// ── 错乱批：en 标识下同一查询的实际返回（无一条与查询相关）──────────────
const OFF_TOPIC_SERP = [
  { title: '西南交通大学研究生院（党委研究生工作部）', url: 'https://gsnews.swjtu.edu.cn/', snippet: '' },
  { title: '大师兄 - 知乎', url: 'https://www.zhihu.com/question/1', snippet: '' },
  { title: '国家科学评论 (National Science Review)', url: 'https://www.nsreviewgroup.com/', snippet: '' },
  { title: '湖南科技大学', url: 'https://www.hnust.edu.cn/', snippet: '' },
  { title: 'Nvidia Driver Install Location? Solved', url: 'https://nvidia.custhelp.com/', snippet: '' },
].map(r => ({ ...r, snippet: r.snippet || 'SERP 片段与查询无关。' })) as SearchResult[]

// ── 泛词批：结果只覆盖查询中第一个词（真实返回：杭州市百科/百度地图/政府网站）。
//    对「杭州西湖 门票预约」而言它们是泛结果——用户要的是预约入口，不是杭州市简介。
const GENERIC_ONLY_SERP: SearchResult[] = [
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

  it('数字+汉字混合词不被整词漏掉（如「7月」）', () => {
    // 旧正则 /[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/ 会把「7月」整体丢弃：
    // 数字段只有 1 位、汉字段只有 1 字，两个分支都不匹配。
    assert.deepEqual(
      queryTokens('美国 AI 实验室 出逃 事件 7月 智能体'),
      ['美国', 'ai', '实验', '验室', '出逃', '事件', '7月', '智能', '能体'],
    )
    assert.ok(queryTokens('2026年 9月 发布').includes('9月'))
  })
})

describe('looksOffTopic', () => {
  it('整批与查询零重叠 → 判定为跑题（真实错乱样本）', () => {
    assert.equal(looksOffTopic(QUERY, OFF_TOPIC_SERP), true)
  })

  it('整批只覆盖单个泛词 → 判定为跑题（真实泛结果批）', () => {
    // 四条全部只命中「杭州」（首词），「门票预约」零覆盖——旧判据因"任意命中"放行。
    assert.equal(looksOffTopic(QUERY, GENERIC_ONLY_SERP), true)
  })

  it('批次中仅个别条目覆盖单查询词 → 仍判跑题（过半数判据，不做逐条豁免）', () => {
    const mostlyOff = [OFF_TOPIC_SERP[0]!, OFF_TOPIC_SERP[1]!, GENERIC_ONLY_SERP[3]!]
    assert.equal(looksOffTopic(QUERY, mostlyOff), true)
  })

  it('覆盖 ≥2 个查询词的结果过半数 → 放行（真实正常批）', () => {
    const mostlyOn = [GENERIC_ONLY_SERP[0]!, ...RELEVANT_SERPS[1]!.results.slice(0, 2)]
    assert.equal(looksOffTopic(QUERY, mostlyOn), false)
  })

  it('恰好半数覆盖 → 判跑题（阈值是"过半数"，不是"半数"）', () => {
    const half = [GENERIC_ONLY_SERP[0]!, GENERIC_ONLY_SERP[1]!, ...RELEVANT_SERPS[1]!.results.slice(0, 2)]
    assert.equal(looksOffTopic(QUERY, half), true)
  })

  it('标题无关但摘要覆盖两个查询词 → 放行（摘要属于结果内容）', () => {
    const bySnippet: SearchResult[] = [
      { title: '某某旅游网', url: 'https://example.com/a', snippet: '杭州西湖门票免费预约入口，每日限流。' },
    ]
    assert.equal(looksOffTopic(QUERY, bySnippet), false)
  })

  it('拉丁查询大小写不敏感', () => {
    const r: SearchResult[] = [{ title: 'TypeScript: JavaScript With Syntax For Types.', url: 'https://x', snippet: '' }]
    assert.equal(looksOffTopic('typescript types', r), false)
  })

  it('单个查询词内的多枚 bigram 只计一词——不因自重叠虚高', () => {
    // 「量子计算」一个词贡献 量子/子计/计算 三枚 bigram。若按 token 计分，
    // 只覆盖这一个词的结果会虚高到"≥2 词覆盖"而蒙混过关；按查询词计分则不然。
    const rows: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
      title: `量子计算科普第${i}篇`,
      url: `https://example.com/q${i}`,
      snippet: '量子计算的基本概念介绍。',
    }))
    assert.equal(looksOffTopic('量子计算 原理 区别 应用', rows), true)
  })

  it('单查询词退回零重叠判据（无多词覆盖信号可依）', () => {
    const relevant: SearchResult[] = [{ title: '杭州西湖景区官网', url: 'https://x', snippet: '预约购票。' }]
    assert.equal(looksOffTopic('杭州西湖', relevant), false)
    assert.equal(looksOffTopic('杭州西湖', OFF_TOPIC_SERP), true)
  })

  it('搜索操作符 site:host 不参与判定——域名只出现在 URL 里，URL 被排除', () => {
    // web_map 的站点内搜索是 `关键词 site:host`。若把 `site`/域名段计入查询词，
    // 结果永远覆盖不到它们（域名在 URL 字段，不参与匹配），整批必被误判跑题。
    assert.deepEqual(queryTokens('教程 site:docs.example.com'), ['教程'])
    const siteResults: SearchResult[] = [
      { title: '快速上手 - 教程中心', url: 'https://docs.example.com/quickstart', snippet: '安装与入门教程。' },
    ]
    assert.equal(looksOffTopic('教程 site:docs.example.com', siteResults), false)
    assert.equal(looksOffTopic('安装 教程 site:docs.example.com', siteResults), false)
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

// ── 真实 SERP 基线：2026-09-23 本机实测（完整 10 条/组）────────────────
// 判据是「过半数」形式——条数与分布都影响判定，故用完整批而非摘录条目。
describe('looksOffTopic — cn.bing.com 真实 SERP 基线', () => {
  for (const s of RELEVANT_SERPS) {
    it(`放行：${s.query}（结果覆盖多个查询词）`, () => {
      assert.equal(looksOffTopic(s.query, s.results), false)
    })
  }
  for (const s of LOW_QUALITY_SERPS) {
    it(`拦截：${s.query}（结果只覆盖单个泛词）`, () => {
      assert.equal(looksOffTopic(s.query, s.results), true)
    })
  }
})
