/**
 * `rivet web` — web 工具（web_search / web_fetch）的命令行入口与连通性自检。
 *
 * 设计意图：让纯 CLI（无 TTY、无桌面端）用户能直接调用 web 工具并拿到结果，
 * 不经过 agent / LLM 推理——确定性、可脚本化。CI、SSH、自动化场景下验证
 * 「代理通不通、哪个 backend 可用、能不能抓到页面」一条命令搞定。
 *
 * 子命令：
 *   rivet web search <query> [--count N] [--json]
 *     直接调 buildSearchBackends + runBackendChain，逐后端报告并打印结果
 *   rivet web fetch <url> [--json]
 *     直接调 fetchMarkdown（复用三级降级链：直连→Playwright→Jina）
 *   rivet web status [--json]
 *     打印当前 web 配置生效状态：代理来源、各 backend 可用性、jinaBaseUrl、OS 系统代理
 *
 * 复用既有纯函数（不引入新依赖）：
 *   - buildSearchBackends / runBackendChain（web-search）
 *   - fetchMarkdown（web-fetch 内核）
 *   - resolveProxyForUrl / parseScutilProxy（proxy-resolver）
 *   proxy 自动从 loadConfig().network 读，与 TUI/headless 路径完全一致。
 */
import type { Config } from '../config/schema.js'
import type { SearchResult } from '../tools/web-search/types.js'

const USAGE = [
  'rivet web — web 工具命令行入口与连通性自检',
  '',
  '  rivet web search <query> [--count N] [--json]   搜索并逐后端报告结果',
  '  rivet web fetch <url> [--json]                  抓取 URL 转 markdown',
  '  rivet web status [--json]                       打印 web 配置生效状态',
  '',
  '示例：',
  '  rivet web search "GLM-5.2 发布"',
  '  rivet web fetch https://example.com',
  '  rivet web status',
].join('\n')

export interface WebCliContext {
  /** 工作目录（项目级 config 解析基准）。默认 process.cwd()。 */
  cwd?: string
  /** 输出回调（默认 process.stdout.write）。注入便于测试。 */
  write?: (s: string) => void
}

/** 返回退出码：0 成功，1 失败（搜索无结果/抓取失败/参数错误）。 */
export async function runWebCLI(args: string[], ctx: WebCliContext = {}): Promise<number> {
  const write = ctx.write ?? ((s: string) => process.stdout.write(s))
  const sub = args[0]

  if (!sub || sub === '-h' || sub === '--help') {
    write(USAGE + '\n')
    return sub ? 0 : 1
  }

  // 延迟导入 config 与工具模块——仅在真正需要时加载（与 main.ts 其他子命令一致）
  const { loadConfig } = await import('../config/manager.js')
  const config = loadConfig({ cwd: ctx.cwd ?? process.cwd() })

  switch (sub) {
    case 'search':
      return runSearch(args.slice(1), config, write)
    case 'fetch':
      return runFetch(args.slice(1), config, write)
    case 'status':
      return runStatus(args.slice(1), config, write)
    default:
      write(`未知子命令: "${sub}"\n\n${USAGE}\n`)
      return 1
  }
}

// ── web search ───────────────────────────────────────────────────────

async function runSearch(args: string[], config: Config, write: (s: string) => void): Promise<number> {
  const { query, count, json } = parseSearchArgs(args)

  if (!query) {
    write('用法: rivet web search <query> [--count N] [--json]\n')
    return 1
  }

  const { buildSearchBackends } = await import('../tools/web-search/build-backends.js')
  const { runBackendChain } = await import('../tools/web-search/chain.js')
  const { resolveProxyForUrl } = await import('../tools/net/proxy-resolver.js')

  const proxyOpts = {
    ...(config.network.proxy ? { proxyUrl: config.network.proxy } : {}),
    ...(config.network.noProxy ? { noProxy: config.network.noProxy } : {}),
  }
  const backends = buildSearchBackends(config, { proxy: proxyOpts })
  // timeout 从 config 读，与 tool.ts 行为一致
  const timeoutMs = config.search.timeoutMs
  const result = await runBackendChain(backends, query, count, timeoutMs)

  if (json) {
    write(JSON.stringify({
      query,
      count,
      backend: result.backend,
      results: result.results,
      errors: result.errors,
      ...(result.offTopicFallback ? { offTopicFallback: result.offTopicFallback } : {}),
      proxy: resolveProxyForUrl('https://example.com', proxyOpts) ?? null,
    }, null, 2) + '\n')
    return result.results.length > 0 || result.offTopicFallback ? 0 : 1
  }

  // 文本输出：逐后端报告 + 结果（与 formatSearchResultText 共用同一实现，避免双实现漂移）
  const proxy = resolveProxyForUrl('https://example.com', proxyOpts) ?? null
  write(formatSearchResultText(query, result, proxy) + '\n')
  return result.results.length > 0 || result.offTopicFallback ? 0 : 1
}

// ── web fetch ────────────────────────────────────────────────────────

async function runFetch(args: string[], config: Config, write: (s: string) => void): Promise<number> {
  const json = args.includes('--json')
  const url = args.find(a => !a.startsWith('-') && a !== '--json')

  if (!url) {
    write('用法: rivet web fetch <url> [--json]\n')
    return 1
  }

  const { fetchMarkdown } = await import('../tools/web-fetch/fetch-core.js')
  const { buildFetchOptions } = await import('../tools/web-fetch/build-options.js')

  const opts = { ...buildFetchOptions(config), cwd: process.cwd() }
  const outcome = await fetchMarkdown(url, {}, opts)

  if (json) {
    write(JSON.stringify(outcome, null, 2) + '\n')
    return outcome.ok ? 0 : 1
  }

  if (!outcome.ok) {
    write(`抓取失败：${outcome.error}\n`)
    return 1
  }

  const via = outcome.via ? ` ${outcome.via}` : ''
  const cache = outcome.fromCache ? '（缓存）' : ''
  write(`URL：${url}\n状态：${outcome.status}${cache}${via}\n长度：${outcome.markdown.length}\n\n`)
  // 截断超长内容，避免刷屏（与 web_fetch 工具的 50K 限制同精神）
  const MAX = 50_000
  const body = outcome.markdown.length > MAX
    ? outcome.markdown.slice(0, MAX) + `\n\n…（已截断，共 ${outcome.markdown.length} 字符）`
    : outcome.markdown
  write(body + '\n')
  return 0
}

// ── web status ───────────────────────────────────────────────────────

async function runStatus(args: string[], config: Config, write: (s: string) => void): Promise<number> {
  const json = args.includes('--json')
  const { resolveProxyForUrl } = await import('../tools/net/proxy-resolver.js')
  const { buildSearchBackends } = await import('../tools/web-search/build-backends.js')

  const proxyOpts = {
    ...(config.network.proxy ? { proxyUrl: config.network.proxy } : {}),
    ...(config.network.noProxy ? { noProxy: config.network.noProxy } : {}),
  }
  const proxy = resolveProxyForUrl('https://example.com', proxyOpts)
  // 代理来源判定（帮助用户理解为何走/不走代理）
  const proxySource = config.network.proxy
    ? 'config (network.proxy)'
    : process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      ? 'env (HTTPS_PROXY/HTTP_PROXY)'
      : proxy ? 'system (OS)' : 'direct（直连）'

  const backends = buildSearchBackends(config, { proxy: proxyOpts })
  const backendStatus = backends.map(b => ({
    name: b.name,
    available: b.isAvailable(),
  }))

  const status = {
    proxy: { url: proxy ?? null, source: proxySource },
    noProxy: config.network.noProxy ?? null,
    search: {
      backends: config.search.backends,
      timeoutMs: config.search.timeoutMs,
      region: config.search.region ?? null,
      backendStatus,
    },
    fetch: {
      jinaBaseUrl: config.fetch.jinaBaseUrl,
      enablePlaywright: config.fetch.enablePlaywright,
      userAgent: config.fetch.userAgent,
      timeoutMs: config.fetch.timeoutMs,
    },
  }

  if (json) {
    write(JSON.stringify(status, null, 2) + '\n')
    return 0
  }

  const lines: string[] = []
  lines.push('═══ Web 工具配置生效状态 ═══')
  lines.push('')
  lines.push('── 代理 ──')
  lines.push(`  地址：${proxy ?? '（直连）'}`)
  lines.push(`  来源：${proxySource}`)
  if (config.network.noProxy) lines.push(`  NO_PROXY：${config.network.noProxy}`)
  lines.push('')
  lines.push('── web_search 后端链 ──')
  for (const b of backendStatus) {
    const mark = b.available ? '✓' : '✗'
    const note = b.available ? '可用' : '不可用（缺 API key 或未配置）'
    lines.push(`  ${mark} ${b.name} — ${note}`)
  }
  lines.push(`  超时：${config.search.timeoutMs}ms`)
  if (config.search.region) lines.push(`  区域：${config.search.region}`)
  lines.push('')
  lines.push('── web_fetch ──')
  lines.push(`  Jina Reader：${config.fetch.jinaBaseUrl}`)
  lines.push(`  Playwright 渲染：${config.fetch.enablePlaywright ? '开' : '关'}`)
  lines.push(`  User-Agent：${config.fetch.userAgent}`)
  lines.push(`  超时：${config.fetch.timeoutMs}ms`)
  lines.push('')
  lines.push('提示：用 `rivet web search <query>` / `rivet web fetch <url>` 实测连通性。')
  write(lines.join('\n') + '\n')
  return 0
}

// ── helpers ──────────────────────────────────────────────────────────

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 解析 `rivet web search` 参数：`--count` 的取值不得落入查询词。 */
export function parseSearchArgs(args: string[]): { query: string; count: number; json: boolean } {
  let count = 10
  let json = false
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--json') {
      json = true
      continue
    }
    if (a === '--count') {
      // 连带吃掉取值：否则它以普通词身份残留进 query（Bing 会收到「… 应用 3」）。
      const v = args[i + 1]
      if (v !== undefined) {
        count = clampInt(v, 1, 20, 10)
        i++
      }
      continue
    }
    if (a.startsWith('--count=')) {
      count = clampInt(a.slice('--count='.length), 1, 20, 10)
      continue
    }
    if (a.startsWith('-')) continue // 未识别的选项：跳过（保持宽容）
    words.push(a)
  }
  return { query: words.join(' ').trim(), count, json }
}

// 便于测试：导出纯文本格式化函数（不依赖网络）
export function formatSearchResultText(query: string, result: {
  backend: string | null
  results: SearchResult[]
  errors: Array<{ backend: string; message: string }>
  /** 被判跑题但保留的低置信批次（见 web-search/chain.ts 的 offTopicFallback）。 */
  offTopicFallback?: { backend: string; results: SearchResult[] } | undefined
}, proxy: string | null): string {
  const lines: string[] = []
  lines.push(`搜索：「${query}」`)
  lines.push(`代理：${proxy ?? '直连'}`)
  lines.push('')
  if (result.errors.length > 0) {
    lines.push('后端链路：')
    for (const e of result.errors) lines.push(`  ✗ ${e.backend}: ${e.message}`)
  }
  if (result.backend) lines.push(`  ✓ ${result.backend} 命中 ${result.results.length} 条`)
  lines.push('')

  if (result.results.length === 0) {
    // 低置信兜底优先于「未找到结果」：结果保留 + 显式标注，采信判断权交回使用者。
    const fallback = result.offTopicFallback
    if (fallback) {
      lines.push(`⚠ 低相关兜底（${fallback.backend}）——搜索后端未返回覆盖查询要点的结果，以下为宽泛匹配结果，仅供参考：`)
      lines.push('')
      appendResults(lines, fallback.results)
      return lines.join('\n')
    }
    lines.push('未找到结果（所有后端均无结果或失败）。')
    return lines.join('\n')
  }
  appendResults(lines, result.results)
  return lines.join('\n')
}

function appendResults(lines: string[], results: readonly SearchResult[]): void {
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
    lines.push('')
  }
}
