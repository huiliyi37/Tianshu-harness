import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWebCLI, formatSearchResultText, parseSearchArgs } from '../web-cli.js'

test('runWebCLI prints usage and exits 1 for no subcommand', async () => {
  let out = ''
  const code = await runWebCLI([], { write: (s) => { out += s } })
  assert.equal(code, 1)
  assert.match(out, /rivet web search/)
  assert.match(out, /rivet web fetch/)
  assert.match(out, /rivet web status/)
})

test('runWebCLI -h/--help exits 0', async () => {
  for (const flag of ['-h', '--help']) {
    let out = ''
    const code = await runWebCLI([flag], { write: (s) => { out += s } })
    assert.equal(code, 0, `${flag} should exit 0`)
    assert.match(out, /rivet web/, `${flag} should print usage`)
  }
})

test('runWebCLI unknown subcommand exits 1 with error', async () => {
  let out = ''
  const code = await runWebCLI(['bogus'], { write: (s) => { out += s } })
  assert.equal(code, 1)
  assert.match(out, /未知子命令/)
})

test('runWebCLI search with empty query exits 1', async () => {
  let out = ''
  const code = await runWebCLI(['search'], { write: (s) => { out += s } })
  assert.equal(code, 1)
  assert.match(out, /用法/)
})

test('runWebCLI fetch with no url exits 1', async () => {
  let out = ''
  const code = await runWebCLI(['fetch'], { write: (s) => { out += s } })
  assert.equal(code, 1)
  assert.match(out, /用法/)
})

test('runWebCLI status prints config status without network (text mode)', async () => {
  // status 只读 config + resolveProxyForUrl + buildSearchBackends(isAvailable)，
  // 不发起任何网络请求——可安全断言输出结构。不假设具体 backend 名（config 可被
  // 自定义），只验证结构与必备段落。
  let out = ''
  const code = await runWebCLI(['status'], { write: (s) => { out += s } })
  assert.equal(code, 0)
  assert.match(out, /Web 工具配置生效状态/)
  assert.match(out, /代理/)
  assert.match(out, /web_search 后端链/)
  assert.match(out, /web_fetch/)
  assert.match(out, /Jina Reader/)
  // 至少有一个 backend 被列出（config.backends 非空）
  assert.match(out, /[✓✗]/)
})

test('runWebCLI status --json outputs valid JSON with backendStatus', async () => {
  let out = ''
  const code = await runWebCLI(['status', '--json'], { write: (s) => { out += s } })
  assert.equal(code, 0)
  const parsed = JSON.parse(out) as {
    proxy: { url: string | null; source: string }
    search: { backendStatus: Array<{ name: string; available: boolean }> }
    fetch: { jinaBaseUrl: string }
  }
  assert.ok(Array.isArray(parsed.search.backendStatus))
  assert.ok(parsed.search.backendStatus.length > 0)
  // 每个 backendStatus 项有 name + available 字段（不假设具体名字，config 可自定义）
  for (const b of parsed.search.backendStatus) {
    assert.equal(typeof b.name, 'string')
    assert.equal(typeof b.available, 'boolean')
  }
  // jinaBaseUrl 字段存在（默认值由 schema 决定，不硬断言具体值）
  assert.equal(typeof parsed.fetch.jinaBaseUrl, 'string')
  assert.ok(parsed.fetch.jinaBaseUrl.length > 0)
})

// ── formatSearchResultText 纯函数（确定性，不依赖网络）──────────────────

test('formatSearchResultText renders results with proxy and backend attribution', () => {
  const text = formatSearchResultText('test query', {
    backend: 'bing',
    results: [
      { title: 'First', url: 'https://first.example', snippet: 'snippet one' },
      { title: 'Second', url: 'https://second.example', snippet: 'snippet two' },
    ],
    errors: [],
  }, 'http://127.0.0.1:7890')
  assert.match(text, /搜索：「test query」/)
  assert.match(text, /代理：http:\/\/127\.0\.0\.1:7890/)
  assert.match(text, /bing 命中 2 条/)
  assert.match(text, /First/)
  assert.match(text, /https:\/\/first\.example/)
})

test('formatSearchResultText shows direct when proxy is null', () => {
  const text = formatSearchResultText('q', { backend: null, results: [], errors: [] }, null)
  assert.match(text, /代理：直连/)
})

test('formatSearchResultText lists per-backend errors when all fail', () => {
  const text = formatSearchResultText('q', {
    backend: null,
    results: [],
    errors: [
      { backend: 'bing', message: 'timed out after 15s' },
      { backend: 'duckduckgo', message: 'no results' },
    ],
  }, null)
  assert.match(text, /✗ bing: timed out after 15s/)
  assert.match(text, /✗ duckduckgo: no results/)
  assert.match(text, /未找到结果/)
})

// ── parseSearchArgs 纯函数（参数解析，不触网）────────────────────────────

test('parseSearchArgs keeps the --count value out of the query', () => {
  // 回归：`query` 曾由 args 过滤「以 - 开头」后直接 join——`--count` 本身被滤掉，
  // 但它的取值（如 "3"）不以 - 开头，残留进查询词，Bing 收到「… 区别 应用 3」。
  const p = parseSearchArgs(['量子计算 原理 区别 应用', '--json', '--count', '3'])
  assert.equal(p.query, '量子计算 原理 区别 应用')
  assert.equal(p.count, 3)
  assert.equal(p.json, true)
})

test('parseSearchArgs supports the --count=N form', () => {
  const p = parseSearchArgs(['foo', '--count=5'])
  assert.equal(p.query, 'foo')
  assert.equal(p.count, 5)
})

test('parseSearchArgs defaults count to 10 and clamps out-of-range values', () => {
  assert.equal(parseSearchArgs(['q']).count, 10)
  assert.equal(parseSearchArgs(['q', '--count', '99']).count, 20)
  assert.equal(parseSearchArgs(['q', '--count', '0']).count, 1)
  assert.equal(parseSearchArgs(['q', '--count', 'abc']).count, 10)
})

test('parseSearchArgs drops unrecognised flags without eating query words', () => {
  const p = parseSearchArgs(['--verbose', 'foo', 'bar'])
  assert.equal(p.query, 'foo bar')
  assert.equal(p.json, false)
})

test('parseSearchArgs handles a dangling --count without consuming a word', () => {
  const p = parseSearchArgs(['q', '--count'])
  assert.equal(p.query, 'q')
  assert.equal(p.count, 10)
})

test('formatSearchResultText renders the low-confidence fallback when nothing relevant was found', () => {
  const text = formatSearchResultText('美国 AI 实验室', {
    backend: null,
    results: [],
    errors: [{ backend: 'bing', message: 'off-topic results' }],
    offTopicFallback: {
      backend: 'bing',
      results: [{ title: '美国（美国）_百度百科', url: 'https://example.com/1', snippet: '美国是……' }],
    },
  }, null)
  assert.match(text, /低相关兜底/)
  assert.match(text, /仅供参考/)
  assert.match(text, /美国（美国）_百度百科/)
  assert.ok(!text.includes('未找到结果'), '有兜底结果时不得报「未找到结果」')
})
