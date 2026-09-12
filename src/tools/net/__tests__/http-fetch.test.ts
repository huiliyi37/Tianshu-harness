import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Agent, ProxyAgent } from 'undici'
import { buildDispatcher, buildPinnedLookup, dispatcherConnectOptions, httpFetchGuarded, type FetchLike, type PinnedLookup } from '../http-fetch.js'
import { SSRFError } from '../ssrf.js'

/** Helper: wrap a DOM-Response-returning mock into the undici FetchLike type.
 *  At runtime undici Response and global Response are structurally identical. */
const mockFetch = (fn: (url: string) => Promise<Response>): FetchLike =>
  fn as unknown as FetchLike

function publicLookup() {
  return async (hostname: string) => ({ address: '93.184.216.34' })
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

describe('httpFetchGuarded', () => {
  it('returns body bytes for a simple 200', async () => {
    const result = await httpFetchGuarded('https://example.com/page', {
      lookup: publicLookup(),
      fetch: mockFetch(async () => new Response(streamOf('hello world'), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })),
    })

    assert.equal(result.status, 200)
    assert.equal(result.finalUrl, 'https://example.com/page')
    assert.equal(result.contentType, 'text/plain')
    assert.equal(new TextDecoder().decode(result.bytes), 'hello world')
  })

  it('follows manual redirects to public URLs', async () => {
    let calls = 0
    const result = await httpFetchGuarded('https://a.example.com', {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetch: mockFetch(async (url) => {
        calls++
        if (url === 'https://a.example.com/') {
          return new Response(null, { status: 302, headers: { location: 'https://b.example.com/secret' } })
        }
        return new Response(streamOf('final'), { status: 200 })
      }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.finalUrl, 'https://b.example.com/secret')
    assert.equal(calls, 2)
    assert.equal(new TextDecoder().decode(result.bytes), 'final')
  })

  it('rejects redirect to private IP', async () => {
    await assert.rejects(
      async () => httpFetchGuarded('https://public.example.com', {
        lookup: async (hostname) => {
          if (hostname === 'evil.com') return { address: '10.0.0.1' }
          return { address: '93.184.216.34' }
        },
        fetch: mockFetch(async () => new Response(null, {
          status: 302,
          headers: { location: 'http://evil.com/private' },
        })),
      }),
      /Access denied.*10\.0\.0\.1/,
    )
  })

  it('rejects an IPv4-mapped loopback target before fetching', async () => {
    let fetched = false
    await assert.rejects(
      () => httpFetchGuarded('http://mapped.example.test/private', {
        lookup: async () => ({ address: '::ffff:127.0.0.1', family: 6 }),
        fetch: mockFetch(async () => {
          fetched = true
          return new Response('should not run')
        }),
      }),
      (err: unknown) => err instanceof SSRFError && err.address === '::ffff:127.0.0.1',
    )
    assert.equal(fetched, false)
  })

  // issue #116 — the embedded-IPv4 spellings must be refused here too: this is
  // the last checkpoint before the address reaches the socket layer.
  it('refuses to hand an IPv4-translated private IP to the socket layer', () => {
    const lookup = buildPinnedLookup('::ffff:0:169.254.169.254', 6)
    let captured: unknown
    lookup('rebind.example.com', {}, (err) => { captured = err })
    assert.ok(captured instanceof SSRFError)
  })

  // issue #122 — the proxy path cannot pin the tunnel target, but the pre-request
  // check must still run, so a private target stays rejected.
  it('rejects a private target before the proxy dispatcher is built', async () => {
    await assert.rejects(
      () => httpFetchGuarded('http://metadata.example/latest/meta-data', {
        lookup: async () => ({ address: '169.254.169.254', family: 4 }),
      }, { proxy: { proxyUrl: 'http://127.0.0.1:9', noProxy: '' } }),
      (err: unknown) => err instanceof SSRFError && err.address === '169.254.169.254',
    )
  })

  // issue #122 — proxy mode has no socket-level pin, so this exercises the proxy
  // path end to end: undici must dial the proxy host itself (a loopback hostname,
  // which undici has to resolve) while the target stays prechecked only.
  it('dials the proxy host itself when a proxy is configured', async () => {
    const proxy = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('via-proxy')
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const { port } = proxy.address() as AddressInfo
    const previousPin = process.env.RIVET_FETCH_PIN
    delete process.env.RIVET_FETCH_PIN
    try {
      const result = await httpFetchGuarded('http://public.example.com/page', {
        lookup: async () => ({ address: '93.184.216.34', family: 4 }),
      }, { proxy: { proxyUrl: `http://localhost:${port}`, noProxy: '' } })
      assert.equal(result.status, 200)
      assert.equal(new TextDecoder().decode(result.bytes), 'via-proxy')
    } finally {
      if (previousPin === undefined) delete process.env.RIVET_FETCH_PIN
      else process.env.RIVET_FETCH_PIN = previousPin
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })

  it('rejects unsupported protocol', async () => {
    await assert.rejects(
      async () => httpFetchGuarded('file:///etc/passwd', { lookup: publicLookup() }),
      /Unsupported protocol/,
    )
  })

  it('enforces maxResponseBytes and cancels the reader', async () => {
    await assert.rejects(
      async () => httpFetchGuarded('https://big.example.com', {
        lookup: publicLookup(),
        fetch: mockFetch(async () => new Response(streamOf('x'.repeat(200)), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })),
      }, { maxResponseBytes: 100 }),
      /exceeds maximum allowed size/,
    )
  })

  it('pins the connection to the validated IP regardless of the hostname asked', () => {
    // The lookup must return the pre-validated address, not re-resolve the name
    // — this is what closes the DNS-rebinding window.
    const lookup = buildPinnedLookup('93.184.216.34', 4)
    let seen: { address?: string; family?: number } = {}
    lookup('attacker-controlled.example.com', {}, (err, address, family) => {
      assert.equal(err, null)
      seen = { address: address as string, family }
    })
    assert.equal(seen.address, '93.184.216.34')
    assert.equal(seen.family, 4)
  })

  it('returns the address-list form when the connector asks for all records', () => {
    const lookup = buildPinnedLookup('2001:4860:4860::8888', 6)
    let list: { address: string; family: number }[] = []
    lookup('example.com', { all: true }, (err, addresses) => {
      assert.equal(err, null)
      list = addresses as { address: string; family: number }[]
    })
    assert.deepEqual(list, [{ address: '2001:4860:4860::8888', family: 6 }])
  })

  it('refuses to hand a private IP to the socket layer (defence in depth)', () => {
    const lookup = buildPinnedLookup('10.0.0.1', 4)
    let captured: unknown
    lookup('rebind.example.com', {}, (err) => { captured = err })
    assert.ok(captured instanceof SSRFError)
  })

  it('aborts on body read timeout', async () => {
    const slowStream = new ReadableStream<Uint8Array>({
      start(_controller) {
        // never closes
      },
    })

    await assert.rejects(
      async () => httpFetchGuarded('https://slow.example.com', {
        lookup: publicLookup(),
        fetch: mockFetch(async () => new Response(slowStream, { status: 200 })),
      }, { timeoutMs: 50 }),
      /Body read timeout/,
    )
  })
})

describe('dispatcherConnectOptions (issue #122)', () => {
  it('pins the connection to the validated address when connecting directly', () => {
    const options = dispatcherConnectOptions('93.184.216.34', 4)
    const lookup = (options.connect as { lookup: PinnedLookup } | undefined)?.lookup
    assert.ok(lookup, 'direct mode must install a pinned lookup')

    let seen: { address?: string; family?: number } = {}
    lookup('attacker-controlled.example.com', {}, (err, address, family) => {
      assert.equal(err, null)
      seen = { address: address as string, family }
    })
    assert.equal(seen.address, '93.184.216.34')
    assert.equal(seen.family, 4)
  })

  it('attaches no source pin when the request goes through a proxy', () => {
    // The tunnel target is resolved by the proxy, so the only guard left in
    // proxy mode is the pre-request check — see dispatcherConnectOptions docs.
    const options = dispatcherConnectOptions('93.184.216.34', 4, 'http://proxy.example:8080')
    assert.equal(options.connect, undefined)
  })
})

// RIVET_FETCH_PIN=0 关的是「把连接钉在预检过的地址上」，不该顺手把用户配置的代理一起
// 丢掉——代理是独立于 pin 的传输选择（此前 `pin ? resolveProxyForUrl(...) : undefined`
// 把两者绑在一起，关 pin 等于静默忽略代理配置）。
describe('buildDispatcher — pin 开关与代理解耦', () => {
  const addr = { address: '93.184.216.34', family: 4 }

  it('keeps the proxy even when pinning is disabled', () => {
    const d = buildDispatcher({ pin: false, ...addr, proxyUrl: 'http://proxy.example:8080' })
    assert.ok(d instanceof ProxyAgent, 'pin 关闭不得丢弃代理')
  })

  it('returns no dispatcher when pinning is off and no proxy is set', () => {
    assert.equal(buildDispatcher({ pin: false, ...addr }), undefined)
  })

  it('pins the connection when pinning is on and no proxy is set', () => {
    assert.ok(buildDispatcher({ pin: true, ...addr }) instanceof Agent)
  })

  it('uses a proxy agent without a source pin when a proxy is set', () => {
    const d = buildDispatcher({ pin: true, ...addr, proxyUrl: 'http://proxy.example:8080' })
    assert.ok(d instanceof ProxyAgent)
  })
})
