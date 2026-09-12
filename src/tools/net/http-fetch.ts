import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent, ProxyAgent, fetch as undiciFetch, type Response as UndiciResponse, type RequestInit as UndiciRequestInit } from 'undici'
import { isPrivateIP, resolveAndAssertPublic, SSRFError, type LookupFn } from './ssrf.js'
import { resolveProxyForUrl, type ProxyResolverOptions } from './proxy-resolver.js'

export type FetchLike = (url: string, init?: UndiciRequestInit) => Promise<UndiciResponse>

export interface HttpFetchDeps {
  lookup?: LookupFn
  /** 可注入自定义 fetch（测试用）。注入后会关闭 SSRF pin + proxy 路径。 */
  fetch?: FetchLike
}

export interface HttpFetchOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  maxRedirects?: number
  userAgent?: string
  /**
   * Proxy 解析选项。传入 config.network.proxy / noProxy；未传则回退到
   * HTTPS_PROXY/HTTP_PROXY 环境变量。每跳（含重定向）独立解析。
   */
  proxy?: ProxyResolverOptions
}

export interface HttpFetchResult {
  status: number
  finalUrl: string
  contentType: string
  bytes: Uint8Array
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10_485_760
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT = 'Tianshu/1.0 (terminal coding agent)'

/** Default on; set RIVET_FETCH_PIN=0 / false to fall back to undici's own DNS. */
export function isConnectionPinningEnabled(): boolean {
  const v = process.env.RIVET_FETCH_PIN
  return v !== '0' && v !== 'false'
}

export type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void

/**
 * Build a DNS lookup that always resolves to the pre-validated public IP,
 * ignoring the hostname it is called with. This is the anti-rebinding pin:
 * undici connects to the exact address we SSRF-checked instead of resolving
 * the name a second time (which an attacker could flip to a private IP between
 * our check and the socket connect). Exported for unit testing without sockets.
 */
export function buildPinnedLookup(address: string, family: number | undefined): PinnedLookup {
  const fam: 4 | 6 = family === 6 ? 6 : 4
  return (hostname, options, callback) => {
    // Defence in depth: never hand a private IP to the socket layer.
    if (isPrivateIP(address)) {
      callback(new SSRFError(hostname, address) as unknown as NodeJS.ErrnoException, '', 0)
      return
    }
    if (options && typeof options === 'object' && (options as { all?: boolean }).all) {
      callback(null, [{ address, family: fam }])
    } else {
      callback(null, address, fam)
    }
  }
}

/**
 * Connect options for the per-request dispatcher.
 *
 * 直连：`connect.lookup` 钉死为 SSRF 预检过的地址，undici Agent 会把它透传给
 * buildConnector，socket 只能连到该地址——DNS 重绑定窗口关闭。
 *
 * 代理（issue #122）：**不**传任何 connect。undici 8.7.0 的 ProxyAgent 根本不读
 * `opts.connect`：连代理用 `proxyTls`（lib/dispatcher/proxy-agent.js:147）、隧道内
 * TLS 用 `requestTls`（:149），隧道自身则由内部 `[kAgent].connect` 先经代理客户端
 * CONNECT、再对返回的 socket 做 TLS（:199-255）——**目标主机名由代理解析**，客户端
 * 拿不到隧道对端的 IP，因此不存在 post-CONNECT 校验点（ProxyAgent.Options 只有
 * uri/token/headers/requestTls/proxyTls/clientFactory/proxyTunnel/connectTimeout；
 * interceptor 只有 cache/decompress/deduplicate/dns/dump/redirect/response-error/
 * retry）。既然钉不住，就不要传一个被忽略的 connect 让读者以为目标已被钉住。
 *
 * 结果：代理模式下目标**只有**请求前的一次性 `resolveAndAssertPublic` 预检——攻击者
 * 让 DNS 在预检与代理实际解析之间翻转为私网地址即可穿透，代理模式的 SSRF 保证弱于
 * 直连。这是能力边界而不是已修复项，不要在别处当作强保证使用。
 */
export function dispatcherConnectOptions(
  address: string,
  family: number | undefined,
  proxyUrl?: string,
): Agent.Options {
  if (proxyUrl) return {}
  return { connect: { lookup: buildPinnedLookup(address, family) } as never }
}

/** 每次请求的 undici dispatcher。pin 与代理是**两个独立维度**：
 *  - 配了代理 → ProxyAgent（隧道目标由代理解析，pin 无意义，见 dispatcherConnectOptions）；
 *  - 无代理且 pin 开 → Agent，连接钉死在预检过的地址上；
 *  - 无代理且 pin 关 → undefined（交给 undici 默认解析）。
 *  此前 `pin ? … : undefined` 把两者绑在一起：RIVET_FETCH_PIN=0 会静默丢掉用户配的代理。 */
export function buildDispatcher(opts: {
  pin: boolean
  address: string
  family: number | undefined
  proxyUrl?: string
}): Agent | ProxyAgent | undefined {
  if (opts.proxyUrl) return new ProxyAgent({ uri: opts.proxyUrl })
  if (!opts.pin) return undefined
  return new Agent(dispatcherConnectOptions(opts.address, opts.family))
}

export async function httpFetchGuarded(
  url: string,
  deps: HttpFetchDeps = {},
  opts: HttpFetchOptions = {},
): Promise<HttpFetchResult> {
  const lookup = deps.lookup ?? dnsLookup
  // Use npm undici's fetch (not globalThis.fetch) so it shares the same version
  // as the Agent/ProxyAgent we construct below. Node's builtin undici may be an
  // older major (e.g. Node 24 ships undici 7.x) whose dispatch handler protocol
  // is incompatible with our npm undici 8.x dispatchers — passing a custom
  // dispatcher to the builtin fetch raises "invalid onRequestStart method".
  const fetchImpl = deps.fetch ?? undiciFetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.`)
  }

  // pin 只管「直连时是否把连接钉在预检地址上」；dispatcher 是否存在另由 deps.fetch
  // 决定（注入的自定义 fetch 不走 undici，dispatcher 对它无意义）。
  const pin = isConnectionPinningEnabled()
  const useDispatcher = !deps.fetch

  const headers: Record<string, string> = { 'User-Agent': userAgent }
  let currentUrl = parsed.href
  let response: UndiciResponse | undefined
  // Dispatcher of the terminal (non-redirect) response, kept alive until its
  // streaming body has been fully read, then destroyed in the outer finally.
  let activeDispatcher: Agent | ProxyAgent | undefined

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let hopUrl: URL
      try {
        hopUrl = new URL(currentUrl)
      } catch {
        throw new Error(`Invalid redirect URL: ${currentUrl}`)
      }
      if (hopUrl.protocol !== 'http:' && hopUrl.protocol !== 'https:') {
        throw new Error(`Redirect to unsupported protocol: ${hopUrl.protocol}`)
      }
      const resolved = await resolveAndAssertPublic(hopUrl.hostname, lookup)
      const proxyUrl = useDispatcher ? resolveProxyForUrl(currentUrl, opts.proxy) : undefined
      const dispatcher = useDispatcher
        ? buildDispatcher({ pin, address: resolved.address, family: resolved.family, proxyUrl })
        : undefined

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      const init: UndiciRequestInit = {
        signal: controller.signal,
        headers,
        redirect: 'manual',
      }
      // `dispatcher` is an undici extension; mock fetches ignore it.
      if (dispatcher) (init as { dispatcher?: unknown }).dispatcher = dispatcher
      try {
        response = await fetchImpl(currentUrl, init)
      } catch (err) {
        if (dispatcher) await dispatcher.destroy().catch(() => {})
        throw err
      } finally {
        clearTimeout(timeout)
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        // Release this hop's connection before following the redirect.
        try { await response.body?.cancel() } catch { /* ignore */ }
        if (dispatcher) await dispatcher.destroy().catch(() => {})
        if (!location) {
          throw new Error(`Redirect ${response.status} with no Location header`)
        }
        currentUrl = new URL(location, currentUrl).href
        continue
      }

      // Terminal response — its body is read below; keep the dispatcher alive.
      activeDispatcher = dispatcher
      break
    }

    if (!response || (response.status >= 300 && response.status < 400)) {
      throw new Error(`Too many redirects (>${maxRedirects}) for ${url}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    const bytes = await readBody(response, maxBytes, timeoutMs)

    return {
      status: response.status,
      finalUrl: currentUrl,
      contentType,
      bytes,
    }
  } finally {
    if (activeDispatcher) await activeDispatcher.destroy().catch(() => {})
  }
}

async function readBody(response: UndiciResponse, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const timeoutPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error('Body read timeout'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
  })

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeoutPromise])
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel(`response body exceeds ${maxBytes} bytes`)
          throw new Error(`Response body exceeds maximum allowed size (${maxBytes} bytes)`)
        }
        chunks.push(value)
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  } finally {
    clearTimeout(timeout)
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
