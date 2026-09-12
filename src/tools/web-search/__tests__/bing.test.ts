import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BingBackend, parseBingResults } from '../bing.js'

/**
 * RED→GREEN: Bing parser against real cn.bing.com HTML.
 *
 * Original bug: China users had zero working backends — DDG/Brave/Tavily all
 * offshore, blocked by GFW. The BingBackend scrapes cn.bing.com which is
 * China-reachable and returns direct URLs without redirect wrappers.
 *
 * Test strategy:
 * 1. Parse real HTML captured from cn.bing.com/?q=typescript (Jul 2026)
 * 2. Verify the parser extracts title/URL/snippet from b_algo blocks
 * 3. Verify edge cases: empty HTML, no results, partial blocks
 */

// Real HTML snippet from cn.bing.com/search?q=typescript (captured Jul 2026).
// Structure: <li class="b_algo"> with <h2><a href> title + <p class="b_lineclamp2"> snippet.
const REAL_BING_HTML = `<li class="b_algo" data-bm="1">
  <div class="b_tpcn"><a class="tilk" href="https://www.typescriptlang.org/">…favicon…</a></div>
  <h2 class=""><a href="https://www.typescriptlang.org/" target="_blank" h="ID=SERP,5120.1">TypeScript is JavaScript with syntax for types.</a></h2>
  <div class="b_caption"><p class="b_lineclamp2">TypeScript is a strongly typed programming language that builds on JavaScript, giving you better tooling at any scale. Try TypeScript Now. Online or via npm.</p></div>
</li>
<li class="b_algo" data-bm="2">
  <h2><a href="https://www.typescriptlang.org/download/" target="_blank">Download TypeScript</a></h2>
  <div class="b_caption"><p class="b_lineclamp2">TypeScript can be installed through the npm package manager. &ensp;·&ensp; We have frequent releases …</p></div>
</li>
<li class="b_algo" data-bm="3">
  <h2><a href="https://github.com/microsoft/TypeScript" target="_blank">GitHub - microsoft/TypeScript</a></h2>
  <div class="b_caption"><p class="b_lineclamp4">TypeScript is a superset of JavaScript that compiles to clean JavaScript output. — microsoft/TypeScript</p></div>
</li>`

describe('parseBingResults', () => {
  it('extracts title, url, and snippet from real cn.bing.com HTML', () => {
    const results = parseBingResults(REAL_BING_HTML, 10)
    assert.equal(results.length, 3)
    // First result
    assert.equal(results[0]!.title, 'TypeScript is JavaScript with syntax for types.')
    assert.equal(results[0]!.url, 'https://www.typescriptlang.org/')
    assert.ok(results[0]!.snippet.includes('strongly typed programming language'))
    // Second result — verifies &ensp;·&ensp; decoding
    assert.equal(results[1]!.title, 'Download TypeScript')
    assert.equal(results[1]!.url, 'https://www.typescriptlang.org/download/')
    assert.ok(results[1]!.snippet.includes('frequent releases'))
    // Third result — verifies b_lineclamp4 variant
    assert.equal(results[2]!.title, 'GitHub - microsoft/TypeScript')
    assert.equal(results[2]!.url, 'https://github.com/microsoft/TypeScript')
    assert.ok(results[2]!.snippet.includes('superset of JavaScript'))
  })

  it('respects maxCount', () => {
    const results = parseBingResults(REAL_BING_HTML, 2)
    assert.equal(results.length, 2)
  })

  it('returns empty array for empty HTML', () => {
    assert.deepEqual(parseBingResults('', 10), [])
  })

  it('returns empty array for HTML with no b_algo blocks', () => {
    assert.deepEqual(parseBingResults('<html><body>no results</body></html>', 10), [])
  })

  it('skips blocks missing title link', () => {
    const html = '<li class="b_algo"><h2>No link here</h2></li>'
    assert.deepEqual(parseBingResults(html, 10), [])
  })

  it('skips non-http urls', () => {
    const html = '<li class="b_algo"><h2><a href="javascript:void(0)">Click</a></h2></li>'
    assert.deepEqual(parseBingResults(html, 10), [])
  })

  it('skips empty titles (e.g. only whitespace after stripping tags)', () => {
    const html = '<li class="b_algo"><h2><a href="https://example.com"> </a></h2></li>'
    assert.deepEqual(parseBingResults(html, 10), [])
  })
})

/**
 * RED→GREEN: 请求参数的语言标识回归锁。
 *
 * cn.bing.com 对携带任一英文语言标识的请求静默错位（2026-09 实测）。这两条断言
 * 是唯一能拦住"顺手把参数改回 en-US"的防线——没有它们，参数变更只会在真实查询
 * 上表现为"结果跑题"，测试全绿。
 */
describe('BingBackend request parameters', () => {
  function captureSearch() {
    const seen: { url: string; headers: Record<string, string> } = { url: '', headers: {} }
    const backend = new BingBackend(async (url, init) => {
      seen.url = url
      seen.headers = (init?.headers ?? {}) as Record<string, string>
      return new Response('<html><body></body></html>', { status: 200 })
    })
    return { backend, seen }
  }

  it('carries no setlang parameter', async () => {
    const { backend, seen } = captureSearch()
    await backend.search('杭州西湖 门票预约', 10, new AbortController().signal)
    assert.ok(!seen.url.includes('setlang'), `URL 不得携带 setlang（实际：${seen.url}）`)
    assert.match(seen.url, /^https:\/\/cn\.bing\.com\/search\?q=/)
    assert.ok(seen.url.includes(encodeURIComponent('杭州西湖 门票预约')))
  })

  it('sends a Chinese primary Accept-Language', async () => {
    const { backend, seen } = captureSearch()
    await backend.search('杭州西湖 门票预约', 10, new AbortController().signal)
    assert.equal(seen.headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.5')
  })
})
