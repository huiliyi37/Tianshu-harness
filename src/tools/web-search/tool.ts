import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import type { ProxyResolverOptions } from '../net/proxy-resolver.js'
import type { SearchBackend, SearchFetch } from './types.js'
import { DuckDuckGoBackend } from './duckduckgo.js'
import { runBackendChain } from './chain.js'
import { OFF_TOPIC_ERROR } from './relevance.js'
import { createProxyAwareFetch } from './proxy-fetch.js'
import { lenientPositiveNumber, lenientString } from '../lenient.js'

const MAX_RESULTS = 20
const DEFAULT_TIMEOUT_MS = 15_000

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
        return { content: '错误：query 必须是非空字符串。', isError: true }
      }
      const query = queryCandidate.trim()
      const count = Math.min(
        Math.max(1, lenientPositiveNumber(params.input.count) ?? 10),
        MAX_RESULTS,
      )

      const { backend, results, errors } = await runBackendChain(backends, query, count, timeoutMs)

      if (results.length === 0) {
        // All backends failed → surface why. All backends empty (or returned
        // off-topic content that was dropped) → benign no-hit: reporting a
        // hard error would be misleading, the user-visible outcome is the same.
        const hardErrors = errors.filter(e => e.message !== 'no results' && e.message !== OFF_TOPIC_ERROR)
        if (hardErrors.length > 0) {
          const detail = hardErrors.map(e => `${e.backend}: ${e.message}`).join('; ')
          // detail 转发后端原文（可能含 HTTP 503 等）——中文前缀+变量，可不打标。
          return { content: `搜索失败（${detail}）`, isError: true }
        }
        return { content: `未找到与「${query}」相关的搜索结果` }
      }

      const formatted = results
        .map((r, i) => {
          // 来源站点与发布时间（博查等后端提供）附在 snippet 后，帮助判断可信度与时效
          const meta = [r.siteName, r.publishedAt].filter(Boolean).join(' · ')
          const snippet = r.snippet + (meta ? `（${meta}）` : '')
          return `${i + 1}. [${r.title}](${r.url})\n   ${snippet}`
        })
        .join('\n\n')

      const via = backend ? `（经 ${backend}）` : ''
      return { content: `「${query}」的网页搜索结果${via}：\n\n${formatted}` }
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
