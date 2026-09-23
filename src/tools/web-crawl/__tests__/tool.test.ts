import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebCrawlTool } from '../tool.js'
import { createWebMapTool } from '../map-tool.js'
import type { FetchLike } from '../../net/http-fetch.js'
import type { SearchBackend } from '../../web-search/types.js'

function publicLookup() {
  return async (_h: string) => ({ address: '93.184.216.34' })
}

function siteFetch(table: Record<string, string>): FetchLike {
  return ((url: string) => {
    const body = table[url]
    if (body === undefined) {
      return Promise.resolve(new Response('nf', { status: 404, headers: { 'content-type': 'text/plain' } }))
    }
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }))
  }) as unknown as FetchLike
}

/** 实质内容（> 200 字符），避免触发渲染/兜底降级。 */
const BIG = '实质内容。'.repeat(50)

const SITE = {
  'https://ex.com/': `<html><body><a href="/p1">p1</a><a href="/p2">p2</a><p>${BIG}</p></body></html>`,
  'https://ex.com/p1': `<html><body><p>${BIG} 第一页</p></body></html>`,
  'https://ex.com/p2': `<html><body><p>${BIG} 第二页</p></body></html>`,
}

function fakeArtifactStore() {
  const saved: Record<string, unknown>[] = []
  return {
    saved,
    save: async (input: Record<string, unknown>) => {
      saved.push(input)
      return 'artifact-test-1'
    },
  }
}

describe('web_crawl 工具', () => {
  it('端到端小站爬取：摘要 + artifact 按页切分', async () => {
    const store = fakeArtifactStore()
    const tool = createWebCrawlTool({ lookup: publicLookup(), fetch: siteFetch(SITE) })
    const result = await tool.execute(
      { input: { url: 'https://ex.com/', maxPages: 10, maxDepth: 1 }, toolUseId: 'tc_1', cwd: '/', artifactStore: store } as any,
    )
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('成功 3 页'))
    assert.ok(result.content.includes('https://ex.com/p1'))
    assert.ok(result.content.includes('artifact-test-1'))
    assert.equal(store.saved.length, 1)
    const sections = store.saved[0]!.sections as { name: string }[]
    assert.equal(sections.length, 3)
    assert.ok(sections.some((s) => s.name === 'https://ex.com/p2'))
  })

  it('无效 includePaths 正则直接报错', async () => {
    const tool = createWebCrawlTool({ lookup: publicLookup(), fetch: siteFetch(SITE) })
    const result = await tool.execute(
      { input: { url: 'https://ex.com/', includePaths: ['[unclosed'] }, toolUseId: 'tc_2', cwd: '/' } as any,
    )
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('无效正则'))
  })

  it('非 http(s) 种子拒绝', async () => {
    const tool = createWebCrawlTool({ lookup: publicLookup(), fetch: siteFetch(SITE) })
    const result = await tool.execute({ input: { url: 'ftp://ex.com/' }, toolUseId: 'tc_3', cwd: '/' } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('不支持的协议'))
  })

  it('requiresApproval 恒 true', () => {
    const tool = createWebCrawlTool()
    assert.equal(tool.requiresApproval({ input: { url: 'https://ex.com' }, toolUseId: 't', cwd: '/' } as any), true)
  })
})

describe('web_map 工具', () => {
  // 必须用与上面 SITE 不同的 host：web-fetch 缓存按 URL 落在 <cwd>/.rivet/cache/web-fetch/
  // 且跨用例共享（cwd 都是 '/'），共用 'https://ex.com/' 会让本组取到 web_crawl 用例
  // 写入的内容（多出 p1/p2 链接）——「种子页链接 ×2」的偶发红即由此而来。
  const MAP_SITE = {
    'https://ex2.com/': `<html><body><a href="/docs/a">a</a><p>${BIG}</p></body></html>`,
    'https://ex2.com/sitemap.xml': '<urlset><url><loc>https://ex2.com/docs/s</loc></url></urlset>',
  }

  function fakeBackend(results: { title: string; url: string }[]): SearchBackend {
    return {
      name: 'fake',
      isAvailable: () => true,
      search: async (query) => results.map((r) => ({ ...r, snippet: query })),
    }
  }

  it('三路来源汇合 + 来源分布统计', async () => {
    const tool = createWebMapTool(
      {
        lookup: publicLookup(),
        fetch: siteFetch(MAP_SITE),
        searchBackends: [fakeBackend([{ title: 'API 参考', url: 'https://ex2.com/docs/api' }])],
      },
    )
    const result = await tool.execute(
      { input: { url: 'https://ex2.com/', search: 'api', limit: 50 }, toolUseId: 'tm_1', cwd: '/' } as any,
    )
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('https://ex2.com/docs/a'))
    assert.ok(result.content.includes('https://ex2.com/docs/s'))
    assert.ok(result.content.includes('https://ex2.com/docs/api — API 参考'))
    assert.ok(result.content.includes('来源分布：sitemap ×1、种子页链接 ×1、搜索 ×1（fake）'))
  })

  it('结果 ≤1 且种子非根域时附 base domain 建议', async () => {
    const tool = createWebMapTool({ lookup: publicLookup(), fetch: siteFetch({}) })
    const result = await tool.execute(
      { input: { url: 'https://ex.com/deep/path' }, toolUseId: 'tm_2', cwd: '/' } as any,
    )
    assert.ok(result.content.includes('base domain'))
    assert.ok(result.content.includes('https://ex.com'))
  })
})
