import type { SearchBackend, SearchFetch, SearchResult } from './types.js'
import { decodeHtmlEntities } from './duckduckgo.js'

/**
 * Bing search backend — scrapes `cn.bing.com`, the China-reachable Bing mirror
 * that returns full server-rendered HTML with direct target URLs (no `/ck/a`
 * redirect wrapper, no JS challenge). International `www.bing.com` gates the
 * SERP behind a Turnstile CAPTCHA and `www.baidu.com` serves a JS interstitial,
 * so cn.bing.com is the only zero-config China-reachable free-text backend we
 * can scrape with a plain fetch.
 *
 * Why a browser UA: unlike DDG (which accepts `terminal-coding-agent/1.0`),
 * Bing serves a degraded/empty SERP to non-browser user agents. The UA below
 * is a generic Chrome 120 string that consistently returns full results.
 *
 * Parser robustness: if Bing changes `b_algo` / `b_lineclamp\d` / `<h2><a>`
 * structure, this throws inside `search()` and the chain falls through to the
 * next backend — never a hard failure.
 */
const BING_ENDPOINT = 'https://cn.bing.com/search'
const BING_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Parse Bing (cn.bing.com) organic results. Structure verified against live
 * responses:
 *   - Legacy (Jul 2026 and earlier):
 *     <li class="b_algo" ...>
 *       <div class="b_tpcn"><a class="tilk" href="URL">…favicon…</a></div>   ← skip
 *       <h2 class=""><a href="URL">TITLE with <strong>…</strong> highlights</a></h2>
 *       <div class="b_caption"><p class="b_lineclamp2">SNIPPET</p></div>
 *     </li>
 *   - Current (post-2026-07 revamp): the `<h2>` wrapper was dropped. The title
 *     link is now a bare `<a>` directly inside `b_algo`, preceded by inline
 *     `<link rel="stylesheet">` tags and an optional `tilk` favicon link.
 *
 * Parser strategy: prefer the `<h2>` anchor (legacy structure) since it cleanly
 * skips the favicon link; when no `<h2>` is present, fall back to scanning the
 * block for the first `<a>` whose href is an external http(s) URL — this skips
 * `tilk` favicon links (internal/same-origin) and Bing's own nav links.
 * URLs on cn.bing.com are direct (no redirect wrapper); the `/ck/a?...&u=a1…`
 * base64url form only appears on international Bing, decoded by `decodeCkAUrl`.
 */
export function parseBingResults(html: string, maxCount: number): SearchResult[] {
  const results: SearchResult[] = []
  // Split on `b_algo` so each block starts at one result. The leading fragment
  // before the first `b_algo` is discarded (index 0 below).
  const blocks = html.split('<li class="b_algo')
  for (let i = 1; i < blocks.length && results.length < maxCount; i++) {
    const block = blocks[i]!

    const linkMatch = extractTitleLink(block)
    if (!linkMatch) continue
    const rawUrl = decodeHtmlEntities(linkMatch.url)
    const url = decodeCkAUrl(rawUrl)
    const title = decodeHtmlEntities(stripHtml(linkMatch.title)).replace(/\s+/g, ' ').trim()
    if (!title || !url || !/^https?:\/\//i.test(url)) continue

    // `b_lineclamp\d` covers b_lineclamp2 (default) and b_lineclamp4 (longer).
    const snippetMatch = block.match(/<p[^>]+class="b_lineclamp\d"[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = snippetMatch
      ? decodeHtmlEntities(stripHtml(snippetMatch[1]!)).replace(/\s+/g, ' ').trim()
      : ''

    results.push({ title, url, snippet })
  }
  return results
}

/**
 * Extract the (url, title-html) of the title link from a `b_algo` block.
 *
 * Strategy:
 *   1. Legacy: anchor on `<h2>` and take the first `<a>` inside it. This skips
 *      the `tilk` favicon link that precedes `<h2>`.
 *   2. Current (post-revamp, no `<h2>`): scan all `<a href="...">` in the block
 *      and return the first whose href is an external http(s) URL. Skips:
 *        - `tilk` favicon links (typically same-origin Bing URLs)
 *        - Bing nav/pagination (`bing.com`, `microsoft.com`, `go.microsoft`)
 *        - non-http anchors (mailto, javascript, in-page `#`)
 *      We truncate the scan window to the first 4 KB of the block so a long
 *      result list can't drag a distant unrelated link into the title slot.
 */
function extractTitleLink(block: string): { url: string; title: string } | undefined {
  // 1. Legacy <h2> anchor.
  const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
  if (h2) {
    const m = h2[1]!.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (m) return { url: m[1]!, title: m[2]! }
  }
  // 2. Fallback: first external http(s) <a> in the block head.
  const head = block.slice(0, 4096)
  const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(head)) !== null) {
    const href = m[1]!
    if (!/^https?:\/\//i.test(href)) continue
    if (isBingInternalUrl(href)) continue
    return { url: href, title: m[2]! }
  }
  return undefined
}

/** Whether a URL points at Bing/Microsoft infrastructure (favicon, nav, etc.). */
function isBingInternalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host.endsWith('.bing.com') ||
      host.endsWith('.microsoft.com') ||
      host === 'go.microsoft.com' ||
      host === 'r.bing.com'
    )
  } catch {
    return false
  }
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}

/**
 * Decode Bing's `/ck/a?...&u=a1aHR0cHM…` redirect wrapper used by international
 * Bing. The `u` param is base64url of the real URL, prefixed with a 2-char tag
 * (`a1`/`a3`). cn.bing.com serves raw URLs directly so this is usually a no-op,
 * but the branch keeps the parser usable if Bing ever flips to wrapped links.
 */
function decodeCkAUrl(rawUrl: string): string {
  if (!rawUrl.includes('/ck/a')) return rawUrl
  try {
    const parsed = new URL(rawUrl)
    const u = parsed.searchParams.get('u')
    if (!u) return rawUrl
    // Strip the 2-char base64url tag prefix, then decode.
    const b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '==='.slice((b64.length + 3) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : rawUrl
  } catch {
    return rawUrl
  }
}

/**
 * Free, zero-config backend. No API key — `isAvailable()` is always true. Acts
 * as the primary China-reachable backend; DuckDuckGo serves as the offshore
 * fallback in the default chain.
 */
export class BingBackend implements SearchBackend {
  readonly name = 'bing'

  constructor(private readonly fetchImpl: SearchFetch) {}

  isAvailable(): boolean {
    return true
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    // No `setlang`, and a Chinese primary Accept-Language. cn.bing.com silently
    // misroutes requests carrying ANY English language marker (`setlang=en-US`
    // or `Accept-Language: en` — either alone suffices) on a subset of Chinese
    // queries: HTTP 200, a structurally perfect SERP, contents unrelated to the
    // query ("杭州西湖 门票预约" → 高校研究生院 / Nvidia 驱动问答). Verified 2026-09
    // against live cn.bing.com: all-Chinese markers returned on-topic 3/3, either
    // English marker returned off-topic. `relevance.ts` guards the chain as a
    // second line of defence — do not reintroduce a language marker here.
    const url = `${BING_ENDPOINT}?q=${encodeURIComponent(query)}`
    // `redirect:'manual'` mirrors the DDG backend: a 3xx to an unvalidated
    // host surfaces as a non-ok status and the chain falls through, rather
    // than silently following a redirect.
    const response = await this.fetchImpl(url, {
      signal,
      headers: {
        'User-Agent': BING_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
      },
      redirect: 'manual',
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const html = await response.text()
    return parseBingResults(html, count)
  }
}
