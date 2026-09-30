import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebFetchTool } from '../tool.js'
import type { FetchLike } from '../../net/http-fetch.js'
import { SSRFError } from '../../net/ssrf.js'

/**
 * 缓存隔离：web-fetch 的文件式缓存在 `<cwd>/.rivet/cache/web-fetch/`。
 * 用例原先统一 cwd 为平台根（Windows 落到 C:\.rivet，跨运行持久污染），
 * 且同文件内「写缓存的用例 → 读缓存的用例」经共享 cwd 互相污染
 * （实测「本地提取质量差时走 Playwright 渲染」写入的 github.com/x/y 条目
 * 会让「渲染失败落 Jina 兜底」读到旧结果，5 例稳定红）。
 * 每个用例独立临时目录，读写闭环、互不串扰。
 */
let tmpCwd: string
beforeEach(() => { tmpCwd = mkdtempSync(join(tmpdir(), 'webfetch-test-')) })
afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 }).catch(() => {})
})

/** DOM Response ≡ undici Response at runtime; bridge the nominal type gap. */
const mockFetch = (fn: () => Promise<Response>): FetchLike => fn as unknown as FetchLike

/** 记录请求 URL 的 fetch：用于断言是否请求了 r.jina.ai。 */
function trackingFetch(requested: string[], respond: (url: string) => Response): FetchLike {
  return ((url: string) => {
    requested.push(url)
    return Promise.resolve(respond(url))
  }) as unknown as FetchLike
}

function publicLookup() {
  return async (_hostname: string) => ({ address: '93.184.216.34' })
}

function textResponse(text: string, contentType = 'text/html', status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType },
  })
}

describe('createWebFetchTool', () => {
  it('has correct definition name', () => {
    const tool = createWebFetchTool()
    assert.equal(tool.definition.name, 'web_fetch')
  })

  it('rejects invalid URLs', async () => {
    const tool = createWebFetchTool()
    const result = await tool.execute({ input: { url: 'not-a-url' }, toolUseId: 'tu_1', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('无效 URL'))
  })

  it('rejects non-http protocols', async () => {
    const tool = createWebFetchTool()
    const result = await tool.execute({ input: { url: 'file:///etc/passwd' }, toolUseId: 'tu_2', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('不支持的协议'))
  })

  it('requires approval', () => {
    const tool = createWebFetchTool()
    assert.equal(tool.requiresApproval({ input: { url: 'https://example.com' }, toolUseId: 't', cwd: tmpCwd } as any), true)
  })

  it('rejects binary content types', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: mockFetch(async () => textResponse('binary', 'application/pdf')),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/file.pdf' }, toolUseId: 'tu_bin', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('二进制内容'))
    assert.ok(result.content.includes('import_resource'))
  })

  it('returns full content without 50K truncation', async () => {
    const longText = 'x'.repeat(60_000)
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: mockFetch(async () => textResponse(`<p>${longText}</p>`, 'text/html')),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/long' }, toolUseId: 'tu_long', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(longText))
    assert.ok(!result.content.includes('truncated'))
  })

  it('returns HTTP error for non-2xx', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: mockFetch(async () => textResponse('not found', 'text/plain', 404)),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/missing' }, toolUseId: 'tu_404', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('HTTP 404'))
  })
})

describe('web_fetch 三级降级（Playwright 渲染 → Jina 兜底）', () => {
  // 短内容 + SPA 错误信号词，必然命中 isJinaQualityHeuristic
  const SPA_SHELL = '<html><body>uh oh error while loading</body></html>'

  it('本地提取质量差时走 Playwright 渲染，不再请求 Jina', async () => {
    const requested: string[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, () => textResponse(SPA_SHELL)),
      renderFetch: async () => ({
        markdown: `# 真实 README\n\n${'content '.repeat(100)}`,
        blockedRequests: 0,
        blockedAds: 0,
      }),
    })
    const result = await tool.execute({ input: { url: 'https://github.com/x/y' }, toolUseId: 'tu_pw', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('真实 README'))
    assert.ok(result.content.includes('（经 Playwright 渲染）'))
    assert.ok(!requested.some((u) => u.includes('r.jina.ai')))
  })

  it('渲染失败（undefined）落 Jina 兜底', async () => {
    const requested: string[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, (url) =>
        url.startsWith('https://r.jina.ai/')
          ? textResponse(`jina markdown ${'y'.repeat(300)}`, 'text/plain')
          : textResponse(SPA_SHELL)),
      renderFetch: async () => undefined,
    })
    const result = await tool.execute({ input: { url: 'https://github.com/x/y' }, toolUseId: 'tu_jn', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('jina markdown'))
    assert.ok(result.content.includes('（经 Jina Reader）'))
  })

  it('渲染路径抛 SSRFError 直接报错，不落 Jina', async () => {
    const requested: string[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, () => textResponse(SPA_SHELL)),
      renderFetch: async () => {
        throw new SSRFError('169.254.169.254', '169.254.169.254')
      },
    })
    const result = await tool.execute({ input: { url: 'https://github.com/x/y' }, toolUseId: 'tu_ssrf', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Access denied'))
    assert.ok(!requested.some((u) => u.includes('r.jina.ai')))
  })

  it('未开启 enablePlaywright 且无注入时直接走 Jina', async () => {
    const requested: string[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, (url) =>
        url.startsWith('https://r.jina.ai/')
          ? textResponse(`jina only ${'z'.repeat(300)}`, 'text/plain')
          : textResponse(SPA_SHELL)),
    })
    const result = await tool.execute({ input: { url: 'https://github.com/x/y' }, toolUseId: 'tu_off', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('jina only'))
    assert.ok(result.content.includes('（经 Jina Reader）'))
  })

  it('渲染产出过薄（< 200 字符）视为失败，落 Jina 兜底', async () => {
    const requested: string[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, (url) =>
        url.startsWith('https://r.jina.ai/')
          ? textResponse(`jina 兜底内容 ${'x'.repeat(300)}`, 'text/plain')
          : textResponse(SPA_SHELL)),
      renderFetch: async () => ({ markdown: '白屏薄内容', blockedRequests: 0, blockedAds: 0 }),
    })
    const result = await tool.execute({ input: { url: 'https://github.com/x/y' }, toolUseId: 'tu_thin', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('jina 兜底内容'))
    assert.ok(result.content.includes('（经 Jina Reader）'))
  })
})

describe('web_fetch 成功判定规则（坏状态码+有内容=成功）', () => {
  it('HTTP 403 但有实质内容 → 返回内容（非错误）', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: mockFetch(async () =>
        textResponse(
          `<html><body><main><p>${'被拦页面仍渲染了真实内容。'.repeat(30)}</p></main></body></html>`,
          'text/html',
          403,
        )),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/blocked' }, toolUseId: 'tu_403c', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('被拦页面仍渲染了真实内容'))
    assert.ok(result.content.includes('状态：403'))
  })

  it('HTTP 403 且内容过薄 → 维持错误返回', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: mockFetch(async () => textResponse('<html><body>短</body></html>', 'text/html', 403)),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/blocked' }, toolUseId: 'tu_403t', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('HTTP 403'))
  })

  it('HTTP 404 非 HTML 内容 → 维持原错误路径', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: mockFetch(async () => textResponse('{"error":"not found"}', 'application/json', 404)),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/api' }, toolUseId: 'tu_404j', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('HTTP 404'))
  })
})

describe('web_fetch maxAge 缓存（B1）', () => {
  function fakeCache() {
    const store = new Map<string, { url: string; markdown: string; via: string; status: number; fetchedAt: number }>()
    return {
      store,
      reads: [] as string[],
      writes: [] as string[],
      async read(url: string, variant: string) {
        this.reads.push(url)
        return this.store.get(`${url}\n${variant}`)
      },
      async write(url: string, variant: string, entry: any) {
        this.writes.push(url)
        this.store.set(`${url}\n${variant}`, { ...entry, fetchedAt: Date.now() })
      },
    }
  }

  it('缓存命中直接返回，不发起任何请求', async () => {
    const cache = fakeCache()
    cache.store.set('https://example.com/docs\ne1', {
      url: 'https://example.com/docs',
      markdown: '缓存的文档内容',
      via: '',
      status: 200,
      fetchedAt: Date.now(),
    })
    const requested: string[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, () => textResponse('不应被请求')),
      cache,
    })
    const result = await tool.execute({ input: { url: 'https://example.com/docs' }, toolUseId: 'tu_c1', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('缓存的文档内容'))
    assert.ok(result.content.includes('缓存，'))
    assert.equal(requested.length, 0)
  })

  it('抓取成功写入缓存（实质内容），下次命中', async () => {
    const cache = fakeCache()
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () => textResponse(`<html><body><main><p>${'实质文档内容。'.repeat(30)}</p></main></body></html>`)),
      cache,
    })
    const result = await tool.execute({ input: { url: 'https://example.com/page' }, toolUseId: 'tu_c2', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.equal(cache.writes.length, 1)
    assert.equal(cache.writes[0], 'https://example.com/page')
  })

  it('错误结果与过薄内容不写缓存（宁旧勿错）', async () => {
    const cache = fakeCache()
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () => textResponse('<html><body>薄</body></html>', 'text/html', 500)),
      cache,
    })
    const result = await tool.execute({ input: { url: 'https://example.com/err' }, toolUseId: 'tu_c3', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.equal(cache.writes.length, 0)
  })
})

describe('web_fetch actions（B2）', () => {
  it('actions 校验失败直接报错（不发起请求/渲染）', async () => {
    const requested: string[] = []
    let renderCalled = false
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, () => textResponse('x')),
      renderFetch: async () => {
        renderCalled = true
        return undefined
      },
    })
    const result = await tool.execute({
      input: { url: 'https://ex.com/', actions: [{ type: 'fly' }] },
      toolUseId: 'tu_a1',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('actions 校验失败'))
    assert.equal(requested.length, 0)
    assert.equal(renderCalled, false)
  })

  it('无渲染能力时 actions 返回明确错误', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () => textResponse('x')),
    })
    const result = await tool.execute({
      input: { url: 'https://ex.com/', actions: [{ type: 'click', selector: '.a' }] },
      toolUseId: 'tu_a2',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('需要启用 Playwright'))
  })

  it('actions 直达渲染（跳过直连与缓存），execute_js 返回附尾部', async () => {
    const requested: string[] = []
    const receivedActions: unknown[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, () => textResponse('不应直连')),
      renderFetch: async (_url, actions) => {
        receivedActions.push(actions)
        return {
          markdown: `# 动作后的真实内容\n\n${'x'.repeat(300)}`,
          blockedRequests: 0,
          blockedAds: 0,
          actionResults: [
            { type: 'click', ok: true },
            { type: 'execute_js', ok: true, detail: '{"n":42}' },
          ],
        }
      },
    })
    const result = await tool.execute({
      input: {
        url: 'https://ex.com/',
        actions: [
          { type: 'click', selector: '.tab' },
          { type: 'execute_js', script: '1+1' },
        ],
      },
      toolUseId: 'tu_a3',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('动作后的真实内容'))
    assert.ok(result.content.includes('2 个动作'))
    assert.ok(result.content.includes('{"n":42}'))
    assert.equal(requested.length, 0)
    assert.equal((receivedActions[0] as unknown[]).length, 2)
  })

  it('动作失败记录随内容呈现警告', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () => textResponse('x')),
      renderFetch: async () => ({
        markdown: `已渲染但动作中途失败。${'y'.repeat(300)}`,
        blockedRequests: 0,
        blockedAds: 0,
        actionResults: [
          { type: 'click', ok: true },
          { type: 'write', ok: false, detail: 'Timeout 10000ms exceeded' },
        ],
      }),
    })
    const result = await tool.execute({
      input: {
        url: 'https://ex.com/',
        actions: [
          { type: 'click', selector: '.a' },
          { type: 'write', selector: '#b', text: 'x' },
        ],
      },
      toolUseId: 'tu_a4',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('第 2 步（write）失败'))
  })
})

describe('web_fetch 批量（urls）与 maxCharacters（Shard A）', () => {
  it('批量两页全成功：分段头 + 两页内容', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], (url) =>
        url.includes('a.com')
          ? textResponse(`<main><p>${'A 页内容。'.repeat(30)}</p></main>`, 'text/html')
          : textResponse(`<main><p>${'B 页内容。'.repeat(30)}</p></main>`, 'text/html')),
    })
    const result = await tool.execute({
      input: { urls: ['https://a.com/1', 'https://b.com/2'] },
      toolUseId: 'tu_b1',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('### 1. https://a.com/1'))
    assert.ok(result.content.includes('### 2. https://b.com/2'))
    assert.ok(result.content.includes('A 页内容。'))
    assert.ok(result.content.includes('B 页内容。'))
    assert.ok(result.content.includes('状态：200'))
  })

  it('批量时 urls 优先于 url（url 被忽略）', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], (url) =>
        url.includes('a.com')
          ? textResponse(`<main><p>${'A 内容。'.repeat(30)}</p></main>`, 'text/html')
          : textResponse(`<main><p>${'不该被抓取的 url 内容。'.repeat(30)}</p></main>`, 'text/html')),
    })
    const result = await tool.execute({
      input: { urls: ['https://a.com/1'], url: 'https://other.com/ignored' },
      toolUseId: 'tu_b2',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('### 1. https://a.com/1'))
    assert.ok(!result.content.includes('other.com'))
    assert.ok(!result.content.includes('不该被抓取'))
  })

  it('批量一成一败：成功页照常输出 + 错误行，不整体 isError', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], (url) =>
        url.includes('good.com')
          ? textResponse(`<main><p>${'好页内容。'.repeat(30)}</p></main>`, 'text/html')
          : textResponse('not found', 'text/plain', 404)),
    })
    const result = await tool.execute({
      input: { urls: ['https://good.com/a', 'https://bad.com/missing'] },
      toolUseId: 'tu_b3',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('### 1. https://good.com/a'))
    assert.ok(result.content.includes('好页内容。'))
    assert.ok(!result.content.includes('### 2.'))
    assert.ok(result.content.includes('错误 https://bad.com/missing：'))
    assert.ok(result.content.includes('HTTP 404'))
  })

  it('批量全败：整体 isError，错误逐条列出', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () => textResponse('gone', 'text/plain', 404)),
    })
    const result = await tool.execute({
      input: { urls: ['https://a.com/x', 'https://b.com/y'] },
      toolUseId: 'tu_b4',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('错误 https://a.com/x：'))
    assert.ok(result.content.includes('错误 https://b.com/y：'))
  })

  it('maxCharacters 截断生效并在页头标注', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () =>
        textResponse(`<main><p>${'长内容。'.repeat(200)}</p></main>`, 'text/html')),
    })
    const result = await tool.execute({
      input: { urls: ['https://a.com/long'], maxCharacters: 100 },
      toolUseId: 'tu_b5',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('（已按 100 字符截断）'))
    // 页头与 markdown 之间的首个 \n\n 后即截断内容
    const md = result.content.slice(result.content.indexOf('\n\n') + 2)
    assert.ok(md.length > 0, '截断后仍有内容')
    assert.ok(md.length <= 100, `截断后内容应 ≤100 字符，实际 ${md.length}`)
  })

  it('maxCharacters 非法值（负数/非有限数）回退不截断', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () =>
        textResponse(`<main><p>${'完整内容。'.repeat(50)}</p></main>`, 'text/html')),
    })
    for (const bad of [-100, NaN, Infinity]) {
      const result = await tool.execute({
        input: { urls: ['https://a.com/full'], maxCharacters: bad },
        toolUseId: 'tu_b6',
        cwd: tmpCwd,
      } as any)
      assert.equal(result.isError, undefined)
      assert.ok(!result.content.includes('已按'), `maxCharacters=${String(bad)} 不应截断`)
      assert.ok(result.content.includes('完整内容。'.repeat(50)))
    }
  })

  it('url 单参数兼容不受影响', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () =>
        textResponse(`<main><p>${'单页内容。'.repeat(30)}</p></main>`, 'text/html')),
    })
    const result = await tool.execute({
      input: { url: 'https://a.com/single' },
      toolUseId: 'tu_b7',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('单页内容。'))
    assert.ok(result.content.startsWith('URL：https://a.com/single'))
  })

  it('urls 与 actions 互斥报错', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () => textResponse('x')),
    })
    const result = await tool.execute({
      input: { urls: ['https://a.com/1'], actions: [{ type: 'click', selector: '.a' }] },
      toolUseId: 'tu_b8',
      cwd: tmpCwd,
    } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('urls 与 actions 不能同时使用'))
  })

  it('批量上限：11 个 URL 拒绝且不发任何请求', async () => {
    const requested: string[] = []
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch(requested, () => textResponse('x')),
    })
    const urls = Array.from({ length: 11 }, (_, i) => `https://a.com/${i}`)
    const result = await tool.execute({ input: { urls }, toolUseId: 'tu_b9', cwd: tmpCwd } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('一次最多抓取 10 个 URL'))
    assert.ok(result.content.includes('11'))
    assert.equal(requested.length, 0, '超限时不应发起任何请求')
  })

  it('批量上限内：10 个 URL 正常抓取', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: trackingFetch([], () =>
        textResponse(`<main><p>${'十页内容。'.repeat(30)}</p></main>`, 'text/html')),
    })
    const urls = Array.from({ length: 10 }, (_, i) => `https://a.com/${i}`)
    const result = await tool.execute({ input: { urls }, toolUseId: 'tu_b10', cwd: tmpCwd } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('### 1. https://a.com/0'))
    assert.ok(result.content.includes('### 10. https://a.com/9'))
    assert.ok(result.content.includes('十页内容。'))
  })
})
