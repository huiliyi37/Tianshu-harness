import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import type { ProxyResolverOptions } from '../net/proxy-resolver.js'
import type { SearchBackend, SearchFetch, SearchResult } from './types.js'
import { DuckDuckGoBackend } from './duckduckgo.js'
import { runBackendChain } from './chain.js'
import { OFF_TOPIC_ERROR } from './relevance.js'
import { createProxyAwareFetch } from './proxy-fetch.js'
import { lenientPositiveNumber, lenientString } from '../lenient.js'
import { combineSearchFailures } from './errors.js'

const MAX_RESULTS = 20
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 低置信兜底的用户可见标注。判跑题的批次（判据见 relevance.ts）只能作为
 * 「后端确实返回过内容」的信号保留，绝不能冒充答案——标注必须显式声明
 * 「已判定不相关」，与正常路径的「…的网页搜索结果（经 …）」形态区分开，
 * 否则模型会把泛结果当成正常结果直接采信（issue #484 问题 1）。
 */
const OFF_TOPIC_NOTICE =
  '⚠ 已判定不相关：搜索后端未返回覆盖查询要点的结果，以下仅为后端降级返回的宽泛匹配，不能作为答案采信——建议换用更具体的查询词，或改用其他来源。'

/**
 * 低置信兜底最多回灌的结果条数：全量回灌会放大噪声，且让兜底与正常结果更难区分。
 * 超出部分截断并显式标注。
 */
const OFF_TOPIC_MAX_RESULTS = 3

/** 结果渲染（正常路径与低置信兜底共用同一份实现，避免双实现漂移）。 */
function formatResults(results: readonly SearchResult[]): string {
  return results
    .map((r, i) => {
      // 来源站点与发布时间（博查等后端提供）附在 snippet 后，帮助判断可信度与时效
      const meta = [r.siteName, r.publishedAt].filter(Boolean).join(' · ')
      const snippet = r.snippet + (meta ? `（${meta}）` : '')
      return `${i + 1}. [${r.title}](${r.url})\n   ${snippet}`
    })
    .join('\n\n')
}

export interface WebSearchDeps {
  /** Ordered backend chain. Defaults to DuckDuckGo-only (zero-config). */
  backends?: SearchBackend[]
  /** Per-backend timeout. Defaults to 15s. */
  timeoutMs?: number
  /**
   * Injectable fetch for the default DDG backend (tests). When omitted, the
   * production fetch becomes proxy-aware via `createProxyAwareFetch`.
   */
  fetch?: SearchFetch
  /**
   * Proxy resolution options sourced from `config.network.{proxy,noProxy}`.
   * Only consulted when `fetch` is not injected (production path). Lets the
   * default DuckDuckGo backend honor the same proxy as web_fetch.
   */
  proxy?: ProxyResolverOptions
}

export function createWebSearchTool(deps: WebSearchDeps = {}): Tool {
  // Injected test fetches stay as-is; the real global fetch is proxy-aware
  // (config.network.proxy > HTTPS_PROXY/HTTP_PROXY env > direct) and body-size
  // capped via boundedSearchFetch inside createProxyAwareFetch.
  const fetchImpl = deps.fetch ?? createProxyAwareFetch(deps.proxy)
  const backends = deps.backends && deps.backends.length > 0
    ? deps.backends
    : [new DuckDuckGoBackend(fetchImpl)]
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    definition: {
      name: 'web_search',
      description: `搜索 Web 获取实时信息。结果包含标题、URL 和内容摘要。

### 何时搜索
- 当前/时效性事实（最新发布、breaking changes、今日状态）
- 你不认识或记不准的特定库/版本/API/报错
- 任何可能在你训练截止后发生变化的内容
- 不认识的首字母大写名称（产品、工具、包）：陌生名字更可能是训练之后才出现的真实事物，而不是可以臆测的对象——搜索，不要编造

### 何时不要搜索
- 稳定事实、语言语法，或你已掌握的成熟概念
- 本仓库已有的代码——改用 grep/read_file/semantic_search

### 使用结果（署名与版权）
- 用自己的话综合转述；非显而易见的论断要注明来源 URL
- 直接引用保持简短（约 15 词以内），每个来源最多引用一处
- 绝不要逐字复制文章段落、歌词或诗歌
- 摘要不够用时，用 web_fetch 读取完整页面`,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索查询字符串',
          },
          count: {
            type: 'number',
            description: '返回结果数量（默认：10，最大：20）。传 0 或负数按默认 10 处理。',
          },
        },
        required: ['query'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const queryCandidate = lenientString(params.input.query)
      if (queryCandidate === undefined || queryCandidate.trim().length === 0) {
        return { content: '错误：query 必须是非空字符串。', isError: true, errorKind: 'format_error' }
      }
      const query = queryCandidate.trim()
      const count = Math.min(
        Math.max(1, lenientPositiveNumber(params.input.count) ?? 10),
        MAX_RESULTS,
      )

      const { backend, results, errors, offTopicFallback } = await runBackendChain(backends, query, count, timeoutMs)

      if (results.length === 0) {
        // All backends failed → surface why. All backends empty, or only
        // returned off-topic content → benign no-hit: reporting a hard error
        // would be misleading, the user-visible outcome is the same.
        const hardErrors = errors.filter(e => e.errorKind !== undefined || (e.message !== 'no results' && e.message !== OFF_TOPIC_ERROR))
        if (hardErrors.length > 0) {
          const detail = hardErrors.map(e => `${e.backend}: ${e.message}`).join('; ')
          return {
            content: `搜索失败（${detail}）`, isError: true,
            errorKind: combineSearchFailures(hardErrors.map(e => e.errorKind ?? 'unknown')),
          }
        }
        // 判跑题的批次不静默丢弃也不冒充答案：单后端配置下，「后端降级返回泛结果」
        // 若变成「未找到结果」，用户丢掉的是唯一可得的信息。此处保留但用**非正常
        // 结果**的形态降级返回——独立标题、显式「已判定不相关」、截断展示，把采信
        // 判断权交回使用者，同时杜绝泛结果与正常结果同构（issue #484 问题 1）。
        if (offTopicFallback) {
          const shown = offTopicFallback.results.slice(0, OFF_TOPIC_MAX_RESULTS)
          const truncated = offTopicFallback.results.length > shown.length
          return {
            content: `「${query}」：未找到直接相关的搜索结果（后端 ${offTopicFallback.backend} 降级返回）\n\n`
              + `${OFF_TOPIC_NOTICE}\n\n`
              + formatResults(shown)
              + (truncated
                ? `\n\n（已截断：另有 ${offTopicFallback.results.length - shown.length} 条同类低相关结果未展示）`
                : ''),
          }
        }
        return { content: `未找到与「${query}」相关的搜索结果` }
      }

      const via = backend ? `（经 ${backend}）` : ''
      return { content: `「${query}」的网页搜索结果${via}：\n\n${formatResults(results)}` }
    },

    requiresApproval(): boolean {
      return true
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return true
    },
  }
}

/** Default DDG-only tool instance — preserved for existing imports. */
export const WEB_SEARCH_TOOL: Tool = createWebSearchTool()
