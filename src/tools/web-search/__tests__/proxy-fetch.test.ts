import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProxyAwareFetch } from '../proxy-fetch.js'

/**
 * RED→GREEN: proxy-fetch wiring.
 *
 * Original bug: web_search used boundedSearchFetch(globalThis.fetch) — no proxy
 * awareness. Chinese users with a configured proxy (config.network.proxy) still
 * timed out on DDG/Brave/Tavily because traffic went direct.
 *
 * createProxyAwareFetch closes this gap by wrapping the fetch with
 * resolveProxyForUrl + undici ProxyAgent, reusing the same proxy infra as
 * web_fetch and the updater.
 *
 * Test strategy: intercept the inner fetch to observe the init object. A real
 * ProxyAgent requires a live network proxy, so we verify the wiring — that
 * dispatcher is present when proxyUrl matches, and absent otherwise — rather
 * than running a full round-trip.
 */

/** 隔离本机代理环境变量——resolveProxyForUrl 无 opts 时回退读
 *  HTTPS_PROXY/HTTP_PROXY（大小写不敏感），开发机常年开代理会让
 *  「无 proxy → 无 dispatcher」断言在真实环境下必挂。 */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const
async function withoutProxyEnv(fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const k of PROXY_ENV_KEYS) {
    saved.set(k, process.env[k])
    delete process.env[k]
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** A fetch that captures its init for inspection. */
function spyFetch(): { fetch: typeof globalThis.fetch; lastInit: RequestInit | undefined } {
  const state: { lastInit: RequestInit | undefined } = { lastInit: undefined }
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    state.lastInit = init
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  return {
    fetch: fetch as typeof globalThis.fetch,
    get lastInit(): RequestInit | undefined { return state.lastInit },
  }
}

describe('createProxyAwareFetch', () => {
  it('without proxy opts, passes init through without dispatcher', async () => {
    await withoutProxyEnv(async () => {
      const spy = spyFetch()
      // noProxy:'*' 隔离宿主机 OS 系统代理（开发机 macOS scutil --proxy 可能
      // 读到 Clash 等），本用例验证的是「proxy-aware fetch 在无显式 proxyUrl
      // 时透传 init 不注入 dispatcher」的 wiring，OS 回退由 proxy-resolver 覆盖。
      const wrapped = createProxyAwareFetch({ noProxy: '*' }, spy.fetch)
      const res = await wrapped('https://example.com/search', { headers: { 'User-Agent': 'test' } })
      assert.equal(res.status, 200)
      assert.equal(res.ok, true)
      // No dispatcher — raw fetch path
      assert.ok(spy.lastInit, 'init should be passed through')
      const hasDispatcher = 'dispatcher' in (spy.lastInit ?? {})
      assert.equal(hasDispatcher, false, 'should NOT add dispatcher without proxy')
    })
  })

  it('without proxy opts, preserves caller-supplied headers and signal', async () => {
    const spy = spyFetch()
    const ac = new AbortController()
    const wrapped = createProxyAwareFetch(undefined, spy.fetch)
    await wrapped('https://example.com/search', {
      headers: { 'X-Custom': '1' },
      signal: ac.signal,
      redirect: 'manual',
    })
    assert.ok(spy.lastInit, 'init should be passed through')
    // Headers may be a Headers object or plain object depending on fetch impl
    const hdrs = spy.lastInit?.headers
    assert.ok(hdrs, 'headers should be present')
    const headersObj = hdrs instanceof Headers ? Object.fromEntries(hdrs.entries()) : hdrs as Record<string, string>
    assert.equal((headersObj as Record<string, string>)['x-custom'] ?? (headersObj as Record<string, string>)['X-Custom'], '1')
    assert.equal(spy.lastInit?.signal, ac.signal)
    assert.equal(spy.lastInit?.redirect, 'manual')
  })

  it('with proxyUrl set, adds dispatcher to init', async () => {
    const spy = spyFetch()
    const wrapped = createProxyAwareFetch({ proxyUrl: 'http://proxy.internal:8080' }, spy.fetch)
    const res = await wrapped('https://example.com/search')
    assert.equal(res.status, 200)
    assert.ok(spy.lastInit, 'init should be present')
    // dispatcher should be a ProxyAgent (undici class). We verify the key is there
    // without importing undici for instanceof.
    const hasDispatcher = 'dispatcher' in (spy.lastInit ?? {})
    assert.equal(hasDispatcher, true, 'should add dispatcher when proxyUrl is set')
    const dispatcher = (spy.lastInit as Record<string, unknown>)?.dispatcher
    assert.ok(dispatcher, 'dispatcher should be non-null')
    // ProxyAgent's toString is [object Object]; check constructor name instead
    assert.equal((dispatcher as object).constructor.name, 'ProxyAgent', 'dispatcher should be a ProxyAgent')
  })

  it('with proxyUrl + noProxy matching the URL host, bypasses proxy', async () => {
    const spy = spyFetch()
    const wrapped = createProxyAwareFetch(
      { proxyUrl: 'http://proxy.internal:8080', noProxy: '.internal,localhost' },
      spy.fetch,
    )
    // URL hostname "example.internal" matches noProxy pattern ".internal"
    const res = await wrapped('https://example.internal/search')
    assert.equal(res.status, 200)
    const hasDispatcher = 'dispatcher' in (spy.lastInit ?? {})
    assert.equal(hasDispatcher, false, 'should NOT add dispatcher when host matches noProxy')
  })

  it('with proxyUrl + noProxy NOT matching, still proxies', async () => {
    const spy = spyFetch()
    const wrapped = createProxyAwareFetch(
      { proxyUrl: 'http://proxy.internal:8080', noProxy: '.internal' },
      spy.fetch,
    )
    // URL hostname "cn.bing.com" does NOT match ".internal"
    const res = await wrapped('https://cn.bing.com/search?q=test')
    assert.equal(res.status, 200)
    const hasDispatcher = 'dispatcher' in (spy.lastInit ?? {})
    assert.equal(hasDispatcher, true, 'should add dispatcher when host does NOT match noProxy')
  })

  it('empty proxy opts behave same as undefined', async () => {    await withoutProxyEnv(async () => {
      const spy = spyFetch()
      // noProxy:'*' 显式绕过宿主机 OS 系统代理（开发机 macOS 可能正开着
      // Clash/V2Ray，scutil --proxy 会读到它）——本用例只验证「无 proxyUrl
      // 时不强制走代理」，OS 系统代理的回退由 proxy-resolver 测试覆盖。
      const wrapped = createProxyAwareFetch({ noProxy: '*' }, spy.fetch)
      const res = await wrapped('https://example.com/search')
      assert.equal(res.status, 200)
      const hasDispatcher = 'dispatcher' in (spy.lastInit ?? {})
      assert.equal(hasDispatcher, false, 'no proxyUrl + noProxy:* should not add dispatcher')
    })
  })
})
