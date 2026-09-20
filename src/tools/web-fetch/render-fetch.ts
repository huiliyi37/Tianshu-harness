/**
 * render-fetch — 用本地 headless chromium 渲染 SPA 页面并转 Markdown。
 *
 * web_fetch 三级降级的中间层：本地 turndown 质量差时，本地渲染拿 JS 执行
 * 后的真实 DOM（无外发请求、不受网络封锁影响），仍失败才走 Jina 兜底。
 *
 * SSRF 防护（渲染执行页面 JS，引入了 web_fetch 直连路径没有的新攻击面——必做、不可裁剪）：
 *   1. goto 前 resolveAndAssertPublic 预检主 URL（DNS 失败按渲染不可用降级 Jina）。
 *   2. 进程内 pin 代理：chromium 以 --proxy-server 挂上 createPinningProxy，浏览器把
 *      目标 hostname 交给代理（自己不解析），代理解析一次后即用 buildPinnedLookup
 *      把 socket 钉死在预校验过的 IP 上——预检与真实连接之间没有第二个解析点，
 *      DNS rebinding 窗口由此关闭（issue #212，复用 http-fetch.ts 的 pin 机制）。
 *      ⚠ 能力边界：仅当**未**配置上游代理时生效。配了 config.network.proxy /
 *      HTTPS_PROXY / 系统代理时，chromium 直连上游、目标由上游解析，本层 pin 不到，
 *      退回「预检 + route 拦截」——与 http-fetch.ts 代理模式同一条边界
 *      （见其 dispatcherConnectOptions 注释）。
 *   3. page.route 逐请求拦截（主文档 + 全部子资源）：广告域名直接掐；私网/保留地址
 *      与非 http(s) scheme 一律 abort。depth-in-depth，是 pin 之外的第二道网，
 *      而非唯一防线。
 *   4. domcontentloaded 后复检 final URL（防客户端跳转带出域）。
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect as netConnect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { resolveAndAssertPublic, SSRFError, type LookupFn, type ResolvedAddress } from '../net/ssrf.js'
import { buildPinnedLookup, isConnectionPinningEnabled, type PinnedLookup } from '../net/http-fetch.js'
import { resolveProxyForUrl, type ProxyResolverOptions } from '../net/proxy-resolver.js'
import type { PwPage } from '../net/playwright-driver.js'
import { htmlToMarkdownSmart, extractLinks } from './extract.js'
import { executeRenderActions, type ActionResult, type RenderAction } from './render-actions.js'
import { getDefaultRenderPool, type RenderPool } from './render-pool.js'

const DEFAULT_RENDER_TIMEOUT_MS = 30_000

/** 广告/追踪域名清单（firecrawl playwright-service AD_SERVING_DOMAINS 同款）。 */
const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com',
]

function isAdHost(hostname: string): boolean {
  return AD_SERVING_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))
}

/**
 * pin 代理的 socket 连接参数。host 仍是原 hostname（http/net 用它写 Host 头与
 * SNI），但把 lookup 换成 buildPinnedLookup：无论被问什么名字，都返回预校验过的
 * 地址。与 http-fetch.ts 直连路径同一套机制，不另起一套。
 */
export function pinnedConnectOptions(
  hostname: string,
  port: number,
  resolved: ResolvedAddress,
): { host: string; port: number; lookup: PinnedLookup } {
  return { host: hostname, port, lookup: buildPinnedLookup(resolved.address, resolved.family) }
}

type ProxyDial = (
  opts: { host: string; port: number; lookup: PinnedLookup },
  onConnect: (err: Error | null, socket: Duplex | null) => void,
) => void

const defaultProxyDial: ProxyDial = (opts, onConnect) => {
  const socket = netConnect({ host: opts.host, port: opts.port, lookup: opts.lookup as never })
  socket.once('connect', () => onConnect(null, socket))
  socket.once('error', (err) => onConnect(err, null))
}

export interface PinningProxyOptions {
  lookup?: LookupFn
  /** 测试注入：替换真实 socket 连接。 */
  dial?: ProxyDial
}

export interface PinningProxy {
  /** 形如 http://127.0.0.1:<port>，作为 chromium 的 --proxy-server。 */
  readonly url: string
  close(): Promise<void>
}

/**
 * 仅监听回环的进程内 pin 代理。交给 chromium 作 --proxy-server 后，浏览器的每个
 * 出站连接都先到此：resolveAndAssertPublic 校验一次 → 用 buildPinnedLookup 把
 * socket 钉死在预校验 IP。私网/保留地址、DNS 失败一律 403（fail-closed）。
 * 这不是开放代理——只绑 127.0.0.1 的随机端口。
 */
export async function createPinningProxy(opts: PinningProxyOptions = {}): Promise<PinningProxy> {
  const lookup: LookupFn = opts.lookup ?? ((hostname) => dnsLookup(hostname))
  const dial = opts.dial ?? defaultProxyDial

  const server = createHttpServer((req, res) => {
    void handlePlainProxyRequest(req, res, lookup)
  })
  server.on('connect', (req, clientSocket, head) => {
    handleConnectProxyRequest(req, clientSocket, head, lookup, dial)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** https/ws 的 CONNECT 隧道：校验后把 socket 钉到预校验 IP，双向透传（TLS 端到端）。 */
function handleConnectProxyRequest(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  lookup: LookupFn,
  dial: ProxyDial,
): void {
  clientSocket.on('error', () => {
    /* 客户端提前断开——忽略 */
  })
  const raw = req.url ?? ''
  const sep = raw.lastIndexOf(':')
  const hostname = (sep >= 0 ? raw.slice(0, sep) : raw).replace(/^\[|\]$/g, '')
  const port = sep >= 0 ? Number.parseInt(raw.slice(sep + 1), 10) || 443 : 443
  void resolveAndAssertPublic(hostname, lookup).then(
    (resolved) => {
      dial(pinnedConnectOptions(hostname, port, resolved), (err, socket) => {
        if (err || !socket) {
          clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          return
        }
        socket.on('error', () => clientSocket.destroy())
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) socket.write(head)
        socket.pipe(clientSocket)
        clientSocket.pipe(socket)
      })
    },
    () => {
      // 私网/保留地址或 DNS 失败——fail-closed。
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    },
  )
}

/** 普通 http 请求（chromium 走代理时会发 absolute-URI 形式）：预检后钉到预校验 IP。 */
async function handlePlainProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  lookup: LookupFn,
): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(req.url ?? '')
  } catch {
    res.writeHead(400).end('bad request')
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(400).end('bad request')
    return
  }
  let resolved: ResolvedAddress
  try {
    resolved = await resolveAndAssertPublic(parsed.hostname, lookup)
  } catch {
    res.writeHead(403).end('blocked')
    return
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  const headers: Record<string, string | string[] | undefined> = { ...req.headers }
  delete headers['proxy-connection']
  const upstream = httpRequest(
    {
      ...pinnedConnectOptions(parsed.hostname, port, resolved),
      method: req.method,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
    } as never,
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(upstream)
}

let pinningProxy: Promise<PinningProxy | undefined> | null = null

/** 进程内 pin 代理单例。RIVET_FETCH_PIN=0 或启动失败 → undefined（退回旧行为）。 */
function getPinningProxy(): Promise<PinningProxy | undefined> {
  if (!isConnectionPinningEnabled()) return Promise.resolve(undefined)
  if (!pinningProxy) pinningProxy = createPinningProxy().catch(() => undefined)
  return pinningProxy
}

/**
 * 选渲染池。配了上游代理就交给上游（目标由上游解析，本层 pin 不到——见文件头）；
 * 否则挂上进程内 pin 代理，让 chromium 把解析交给它。
 */
async function resolveRenderPool(upstreamProxy?: string): Promise<RenderPool> {
  if (upstreamProxy) return getDefaultRenderPool({ proxy: { server: upstreamProxy } })
  const pinProxy = await getPinningProxy()
  return getDefaultRenderPool(pinProxy ? { proxy: { server: pinProxy.url } } : {})
}

export interface RenderFetchResult {
  markdown: string
  /** 被 SSRF 拦截的子请求数（>0 说明页面试图触达内网/非 http 资源）。 */
  blockedRequests: number
  /** 被广告域名清单拦截的子请求数。 */
  blockedAds: number
  /** 动作序列执行结果（仅带 actions 时存在；含失败中止记录）。 */
  actionResults?: ActionResult[]
  /** 渲染后 DOM 提取的绝对链接（crawl 发现源）。 */
  links?: string[]
}

export interface RenderFetchOptions {
  /** 渲染超时（默认 30s，独立于 web_fetch 的 15s 请求超时）。 */
  timeoutMs?: number
  /** domcontentloaded 后的额外等待 ms（SPA 水合用，默认 0；上限由 build-options 钳制 ≤ timeoutMs/2）。 */
  waitMs?: number
  /** 渲染动作序列（goto + waitMs 之后、取内容之前按序执行）。 */
  actions?: RenderAction[]
  proxy?: ProxyResolverOptions
  lookup?: LookupFn
  /** 与主链路一致的 extractMainContent 开关（默认 true）。 */
  extractMainContent?: boolean
  /** 测试注入：替换默认渲染池。 */
  pool?: Pick<RenderPool, 'acquirePage' | 'releasePage'>
}

/** data:/blob:/about: 不产生网络请求，放行；其余非 http(s) scheme 一律阻断。 */
function isLocalScheme(protocol: string): boolean {
  return protocol === 'data:' || protocol === 'blob:' || protocol === 'about:'
}

/**
 * 渲染抓取。返回 undefined 表示渲染路径失败（chromium 缺失/启动失败/导航
 * 超时等），调用方应继续走 Jina 兜底；SSRFError 上抛（安全拦截不可静默降级）。
 */
export async function fetchViaPlaywright(
  rawUrl: string,
  opts: RenderFetchOptions = {},
): Promise<RenderFetchResult | undefined> {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return undefined
  }

  const lookup: LookupFn = opts.lookup ?? ((hostname) => dnsLookup(hostname))
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS

  // 第一层：主 URL 预检。DNS 失败（非 SSRFError）按渲染不可用处理，降级 Jina。
  try {
    await resolveAndAssertPublic(target.hostname, lookup)
  } catch (err) {
    if (err instanceof SSRFError) throw err
    return undefined
  }

  const proxyServer = resolveProxyForUrl(rawUrl, opts.proxy)
  const pool: Pick<RenderPool, 'acquirePage' | 'releasePage'> =
    opts.pool ?? (await resolveRenderPool(proxyServer))

  let page: PwPage
  try {
    page = await pool.acquirePage()
  } catch {
    return undefined
  }

  let blockedRequests = 0
  let blockedAds = 0
  try {
    // 第三层：逐请求拦截（主文档 + 全部子资源）——pin 之外的第二道网
    await page.route('**/*', async (route, request) => {
      const reqUrl = request.url()
      let parsed: URL
      try {
        parsed = new URL(reqUrl)
      } catch {
        blockedRequests += 1
        await route.abort()
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        if (isLocalScheme(parsed.protocol)) {
          await route.continue()
          return
        }
        blockedRequests += 1
        await route.abort()
        return
      }
      // 广告/追踪域名直接掐（省带宽省渲染时间，对正文无影响）
      if (isAdHost(parsed.hostname)) {
        blockedAds += 1
        await route.abort()
        return
      }
      try {
        await resolveAndAssertPublic(parsed.hostname, lookup)
        await route.continue()
      } catch {
        // 私网目标或 DNS 失败一律阻断（fail-closed）
        blockedRequests += 1
        await route.abort()
      }
    })

    await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

    // SPA 水合等待（firecrawl wait_after_load 同款）
    if (opts.waitMs && opts.waitMs > 0) {
      await new Promise((r) => setTimeout(r, opts.waitMs))
    }

    // 动作序列：goto + 水合等待之后、取内容之前（单步失败即中止并记录）
    let actionResults: ActionResult[] | undefined
    if (opts.actions && opts.actions.length > 0) {
      actionResults = await executeRenderActions(page, opts.actions)
    }

    // 第四层：final URL 复检（客户端跳转/动作导航可能把页面带出已验证的域）
    const finalUrl = page.url()
    if (finalUrl.startsWith('http:') || finalUrl.startsWith('https:')) {
      const finalHost = new URL(finalUrl).hostname
      if (finalHost !== target.hostname) {
        await resolveAndAssertPublic(finalHost, lookup)
      }
    }

    const html = await page.content()
    const pageUrl = finalUrl.startsWith('http') ? finalUrl : rawUrl
    const markdown = await htmlToMarkdownSmart(html, {
      pageUrl,
      onlyMainContent: opts.extractMainContent !== false,
    })
    return {
      markdown,
      blockedRequests,
      blockedAds,
      ...(actionResults ? { actionResults } : {}),
      links: extractLinks(html, pageUrl),
    }
  } catch (err) {
    // SSRF 拦截必须显式上抛；其余失败（导航超时、Browser 崩溃等）降级 Jina
    if (err instanceof SSRFError) throw err
    return undefined
  } finally {
    await pool.releasePage(page)
  }
}
