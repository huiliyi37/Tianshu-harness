import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { connect as netConnect, createServer as netCreateServer, type AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { createPinningProxy, fetchViaPlaywright, pinnedConnectOptions } from '../render-fetch.js'
import { SSRFError } from '../../net/ssrf.js'
import type { PinnedLookup } from '../../net/http-fetch.js'
import type { PwPage, PwRouteHandler } from '../../net/playwright-driver.js'

interface FakeScript {
  /** goto 期间"浏览器"会发出的请求（逐个过 route 拦截器）。 */
  requests?: string[]
  html?: string
  finalUrl?: string
  gotoError?: Error
}

function makeFakePage(script: FakeScript = {}) {
  let handler: PwRouteHandler | undefined
  const calls: string[] = []
  const page: PwPage = {
    route: async (_pattern, h) => {
      handler = h
    },
    goto: async (_url, _opts) => {
      calls.push('goto')
      if (script.gotoError) throw script.gotoError
      for (const reqUrl of script.requests ?? []) {
        await handler!(
          { abort: async () => {}, continue: async () => {} },
          { url: () => reqUrl },
        )
      }
    },
    url: () => script.finalUrl ?? '',
    content: async () => {
      calls.push('content')
      return script.html ?? '<html><body><main><p>真实 README 内容</p></main></body></html>'
    },
    close: async () => {},
    click: async (selector) => {
      calls.push(`click:${selector}`)
    },
    fill: async (selector, text) => {
      calls.push(`fill:${selector}=${text}`)
    },
    press: async (selector, key) => {
      calls.push(`press:${selector}:${key}`)
    },
    evaluate: async (script) => {
      calls.push(`eval:${script.slice(0, 30)}`)
      return undefined
    },
    waitForSelector: async (selector) => {
      calls.push(`waitFor:${selector}`)
    },
  }
  const pool = {
    acquirePage: async () => page,
    releasePage: async (_p: PwPage) => {},
  }
  return { page, pool, calls }
}

/** 公网地址；IP 字面量主机名原样返回（模拟 dns.lookup 对 IP 的行为）。 */
function makeLookup(privateHosts: string[] = []) {
  return async (hostname: string) => ({
    address: privateHosts.includes(hostname) ? hostname : '93.184.216.34',
  })
}

describe('fetchViaPlaywright', () => {
  it('主 URL 预检命中私网 → 抛 SSRFError（不可降级）', async () => {
    const { pool } = makeFakePage()
    await assert.rejects(
      fetchViaPlaywright('http://169.254.169.254/latest/meta-data', {
        pool,
        lookup: makeLookup(['169.254.169.254']),
      }),
      (err) => err instanceof SSRFError,
    )
  })

  it('内网子请求被逐一拦截，渲染流程不中断', async () => {
    const { pool } = makeFakePage({
      requests: [
        'https://cdn.example.com/app.js',
        'http://169.254.169.254/latest/meta-data',
        'http://127.0.0.1:8080/admin',
        'http://10.0.0.5/internal',
      ],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(['169.254.169.254', '127.0.0.1', '10.0.0.5']),
    })
    assert.ok(result)
    assert.equal(result.blockedRequests, 3)
    assert.ok(result.markdown.includes('真实 README 内容'))
  })

  it('data:/blob:/about: 无网络请求，放行不计拦截', async () => {
    const { pool } = makeFakePage({
      requests: ['data:text/html,<p>x</p>', 'about:blank', 'blob:https://example.com/uuid'],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.equal(result.blockedRequests, 0)
  })

  it('file:/ftp: 等非 http(s) scheme 一律阻断', async () => {
    const { pool } = makeFakePage({
      requests: ['file:///etc/passwd', 'ftp://internal.example/secret'],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.equal(result.blockedRequests, 2)
  })

  it('广告/追踪域名子请求被拦截，单独计数', async () => {
    const { pool } = makeFakePage({
      requests: [
        'https://cdn.example.com/app.js',
        'https://www.googlesyndication.com/ads.js',
        'https://sub.doubleclick.net/track',
      ],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.equal(result.blockedAds, 2)
    assert.equal(result.blockedRequests, 0)
  })

  it('waitMs 水合等待生效', async () => {
    const { pool } = makeFakePage()
    const started = Date.now()
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
      waitMs: 60,
    })
    assert.ok(result)
    assert.ok(Date.now() - started >= 50, `等待应生效（实际 ${Date.now() - started}ms）`)
  })

  it('final URL 跳转到私网主机 → 抛 SSRFError', async () => {
    const { pool } = makeFakePage({ finalUrl: 'http://169.254.169.254/landing' })
    await assert.rejects(
      fetchViaPlaywright('https://example.com/', {
        pool,
        lookup: makeLookup(['169.254.169.254']),
      }),
      (err) => err instanceof SSRFError,
    )
  })

  it('页面重定向到私网主机 → 重定向请求被拦截，渲染继续', async () => {
    const { pool } = makeFakePage({
      requests: ['https://example.com/start', 'http://169.254.169.254/redirected'],
      finalUrl: 'https://example.com/',
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(['169.254.169.254']),
    })
    assert.ok(result)
    assert.equal(result.blockedRequests, 1)
  })

  it('导航超时/失败 → 返回 undefined（交 Jina 兜底）', async () => {
    const { pool } = makeFakePage({ gotoError: new Error('Timeout 30000ms exceeded') })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.equal(result, undefined)
  })

  it('chromium 不可用（acquire 失败）→ 返回 undefined', async () => {
    const pool = {
      acquirePage: async (): Promise<PwPage> => {
        throw new Error('chromium 未安装')
      },
      releasePage: async (_p: PwPage) => {},
    }
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.equal(result, undefined)
  })

  it('主 URL DNS 解析失败（非 SSRF）→ 返回 undefined', async () => {
    const { pool } = makeFakePage()
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: async () => {
        throw new Error('getaddrinfo ENOTFOUND example.com')
      },
    })
    assert.equal(result, undefined)
  })

  it('渲染后 HTML 经 extractMainContent + htmlToMarkdown 转换', async () => {
    const { pool } = makeFakePage({
      html: '<html><body><nav>导航噪音</nav><main><h1>标题</h1><p>正文段落</p></main></body></html>',
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.ok(result.markdown.includes('标题'))
    assert.ok(result.markdown.includes('正文段落'))
  })

  it('actions 在 goto 之后、取内容之前执行，结果随 actionResults 返回', async () => {
    const { pool, calls } = makeFakePage()
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
      actions: [
        { type: 'click', selector: '.tab' },
        { type: 'execute_js', script: 'document.title' },
      ],
    })
    assert.ok(result)
    assert.deepEqual(calls, ['goto', 'click:.tab', 'eval:document.title', 'content'])
    assert.equal(result.actionResults?.length, 2)
    assert.ok(result.actionResults!.every((r) => r.ok))
  })
})

function proxyPort(proxy: { url: string }): number {
  return Number(new URL(proxy.url).port)
}

/** 原始 CONNECT 客户端：拿到代理响应首行（截至空行）即返回并断开。 */
function rawConnect(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', (chunk: string) => {
      buf += chunk
      if (buf.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(buf)
      }
    })
    socket.on('connect', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
  })
}

/** 经代理发一个 absolute-URI 形式的普通 http 请求（chromium 走代理时的形状），返回状态码。 */
function proxyGet(port: number, absoluteUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(absoluteUrl)
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'GET', path: absoluteUrl, headers: { host: u.host } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// issue #212 —— 渲染路径的 SSRF 钉死。route.continue() 把请求交回 chromium，而
// chromium 用**自己的**网络栈二次解析 DNS，应用钉不住 → TOCTOU 重绑定。修法是让
// chromium 把解析交给进程内 pin 代理（--proxy-server），代理 resolveAndAssertPublic
// 一次后用 buildPinnedLookup 把 socket 钉死在预校验 IP。下面直接测这个代理：
// 单测里跑不了真实 chromium 的解析，但代理是 pin 的落点，用可注入的 lookup/dial
// 钩子能把它测到 socket 层（dial 收到的 lookup 就是 http-fetch 那套 buildPinnedLookup）。
describe('createPinningProxy（issue #212 — 渲染路径钉死解析）', () => {
  it('CONNECT 到私网/保留地址 → 403，且不发起任何连接', async () => {
    let dialed = false
    const proxy = await createPinningProxy({
      // 字面量原样返回，模拟 dns.lookup 对 IP 的行为
      lookup: async (hostname) => ({ address: hostname }),
      dial: (_opts, cb) => {
        dialed = true
        cb(null, new PassThrough())
      },
    })
    try {
      const line = await rawConnect(proxyPort(proxy), '169.254.169.254:80')
      assert.match(line, /^HTTP\/1\.1 403/)
      assert.equal(dialed, false, '私网目标不得发起连接')
    } finally {
      await proxy.close()
    }
  })

  it('CONNECT 到公网目标 → dial 用 buildPinnedLookup 钉死预校验 IP', async () => {
    let captured: { host: string; port: number; lookup: PinnedLookup } | undefined
    const proxy = await createPinningProxy({
      lookup: async () => ({ address: '93.184.216.34', family: 4 }),
      dial: (opts, cb) => {
        captured = opts
        cb(null, new PassThrough())
      },
    })
    try {
      const line = await rawConnect(proxyPort(proxy), 'attacker.test:443')
      assert.match(line, /^HTTP\/1\.1 200/)
      assert.ok(captured, 'dial 应被调用')
      assert.equal(captured.host, 'attacker.test')
      assert.equal(captured.port, 443)
      // socket 层无论被问什么名字，都返回预校验地址——预检到连接之间没有第二次解析
      let addr = ''
      captured.lookup('rebind.test', {}, (_err, a) => {
        addr = a as string
      })
      assert.equal(addr, '93.184.216.34')
    } finally {
      await proxy.close()
    }
  })

  it('普通 http 的 absolute-URI 私网目标 → 403', async () => {
    const proxy = await createPinningProxy({
      lookup: async (hostname) => ({ address: hostname }),
    })
    try {
      assert.equal(await proxyGet(proxyPort(proxy), 'http://127.0.0.1/admin'), 403)
    } finally {
      await proxy.close()
    }
  })

  it('保留地址字面量（metadata 服务）→ 403', async () => {
    const proxy = await createPinningProxy({
      lookup: async (hostname) => ({ address: hostname }),
    })
    try {
      assert.equal(await proxyGet(proxyPort(proxy), 'http://169.254.169.254/latest/meta-data'), 403)
    } finally {
      await proxy.close()
    }
  })

  it('CONNECT 成功后真实透传字节（真 socket 端到端隧道）', async () => {
    // 本机 echo 服务器冒充隧道对端；dial 接上它（pin 的 lookup 另行单测）。
    const echo = netCreateServer((socket) => socket.pipe(socket))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
    const echoPort = (echo.address() as AddressInfo).port
    const proxy = await createPinningProxy({
      lookup: async () => ({ address: '93.184.216.34', family: 4 }),
      dial: (_opts, cb) => cb(null, netConnect({ host: '127.0.0.1', port: echoPort })),
    })
    try {
      const socket = netConnect({ host: '127.0.0.1', port: proxyPort(proxy) })
      socket.setEncoding('utf8')
      const received = await new Promise<string>((resolve, reject) => {
        let buf = ''
        let established = false
        socket.on('error', reject)
        socket.on('data', (chunk: string) => {
          buf += chunk
          if (!established && buf.includes('\r\n\r\n')) {
            established = true
            socket.write('ping')
          } else if (established && buf.endsWith('ping')) {
            resolve(buf)
          }
        })
        socket.on('connect', () => {
          socket.write('CONNECT tunnel.test:443 HTTP/1.1\r\nHost: tunnel.test\r\n\r\n')
        })
      })
      assert.match(received, /^HTTP\/1\.1 200/)
      assert.ok(received.endsWith('ping'), '隧道应把客户端字节原样送回')
      socket.destroy()
    } finally {
      await proxy.close()
      await new Promise<void>((r) => echo.close(() => r()))
    }
  })
})

describe('pinnedConnectOptions（issue #212 — 复用 buildPinnedLookup）', () => {
  it('host 保留原 hostname，lookup 钉死在预校验 IP', () => {
    const opts = pinnedConnectOptions('attacker.test', 443, { address: '93.184.216.34', family: 4 })
    assert.equal(opts.host, 'attacker.test')
    assert.equal(opts.port, 443)
    let addr = ''
    opts.lookup('rebind.test', {}, (_err, a) => {
      addr = a as string
    })
    assert.equal(addr, '93.184.216.34')
  })
})
