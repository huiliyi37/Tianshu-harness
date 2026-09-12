import type { SearchResult } from './types.js'

/**
 * 搜索结果的「跑题」守卫。
 *
 * 背景（2026-09 实测复现）：cn.bing.com 在请求同时携带英文语言标识
 * （`setlang=en-US` 或 `Accept-Language: en`，任一）时，对部分中文查询会返回
 * **HTTP 200、结构完好、但内容与查询完全无关**的 SERP——10 个 `b_algo` 块解析
 * 无误，标题与搜索框仍是查询本身，只有结果区是别人的内容。同一请求重复执行返回的
 * 又是另一批无关内容，所以这不是一条可枚举的兜底页，只能靠内容判据兜住。
 *
 * 这类错误的代价最高：它在每一层都"成功"（HTTP ok、解析非空、链式 fallback 不
 * 触发），最终把无关内容当答案交给模型。本模块提供唯一的兜底判据——结果集与查询
 * **零词元重叠**时视为失败。
 *
 * 判定刻意保守：整批只要有一条命中即放行，查询提不出词元时不判定。宁可漏掉一次
 * 跑题，也不误杀一批正常结果（误杀的代价是丢掉本来可用的答案）。
 */

/** 单个 CJK 字符——用来区分扫出来的片段属于中文还是拉丁。 */
const CJK_CHAR = /[\u4e00-\u9fff]/

/**
 * 把查询切成用于匹配的词元。
 *
 * 中文没有分词器可用，改用 bigram：`杭州西湖` → `杭州`/`州西`/`西湖`。
 * 多切几段只会提高命中率（更保守），不会造成误判方向的偏差。
 * 词元顺序与查询中出现顺序一致——混合中英文时才能稳定断言。
 */
export function queryTokens(query: string): string[] {
  const tokens: string[] = []
  // 单次扫描按位置切分，保证中英文混排时的产出顺序等于查询顺序。
  const scan = /[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gi
  let m: RegExpExecArray | null
  while ((m = scan.exec(query)) !== null) {
    const chunk = m[0]
    if (CJK_CHAR.test(chunk)) {
      for (let i = 0; i + 2 <= chunk.length; i++) {
        tokens.push(chunk.slice(i, i + 2))
      }
    } else {
      tokens.push(chunk.toLowerCase())
    }
  }
  return tokens
}

/**
 * 判定一批结果是否整批跑题。
 *
 * 判据：
 *   - 空结果集 → false（"没有结果"是 chain 的既有路径，不归本守卫管）
 *   - 查询提不出词元 → false（无判据可依时放行）
 *   - 任意一条结果的 title/snippet 命中任一词元 → false
 *   - 以上都不成立 → true
 *
 * URL 不参与匹配：命中一个 slug 是噪声（`/hangzhou-xihu-menpiao` 可能挂在完全
 * 无关的垃圾站上），只会让守卫失效。
 */
export function looksOffTopic(query: string, results: readonly SearchResult[]): boolean {
  if (results.length === 0) return false
  const tokens = queryTokens(query)
  if (tokens.length === 0) return false

  for (const r of results) {
    const haystack = `${r.title} ${r.snippet}`.toLowerCase()
    if (tokens.some(t => haystack.includes(t))) return false
  }
  return true
}

/** chain 用它标记"结果跑题"，供上层把这类软失败与硬错误区分开。 */
export const OFF_TOPIC_ERROR = 'off-topic results'
