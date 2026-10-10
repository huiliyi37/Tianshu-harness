import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type ServerOptions as TlsServerOptions } from 'node:https'
import { assertSecureBind, resolveLanDirect } from './serve-transport.js'
import { defaultLanHosts } from './host-policy.js'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep, extname } from 'node:path'
import { isAuthorizedRequest } from './auth.js'
import { allowedCorsOrigin } from './cors.js'
import { errorContext, serverLogger } from './logger.js'
import { isLoopbackBind, isLoopbackHostHeader, stripHostPort } from './host-policy.js'

// 64MB — the prompt route carries up to 4 base64 image data URLs at up to
// 10MB decoded each (~14MB base64), so 4 images ≈ 56MB plus prompt JSON
// must fit. The server is a localhost-bound, token-gated sidecar, so a
// larger ceiling is acceptable.
const MAX_BODY_BYTES = 64 * 1024 * 1024

export interface RouteResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
  /** Handler already took ownership of the ServerResponse (e.g. SSE). */
  handled?: boolean
}

export type RouteHandler = (
  body: unknown,
  params?: Record<string, string>,
  headers?: Record<string, string>,
  res?: ServerResponse,
) => RouteResponse | Promise<RouteResponse>

/**
 * 路径参数 percent-decode（`/config/providers/:name`、skills `:name` 等）：
 * 前端对自定义名一律 encodeURIComponent（中文供应商/技能名），下方路由匹配
 * 原样捕获不还原（params[paramNames[i]] = match[i+1]），handler 统一经此还原。
 * 单层 decode——调用方不得对已 decode 的值二次使用（:modelId 维持 handler 内
 * 既有 decode，不走这里）。非法 % 序列 fail-open 回原值（保持旧行为，不 500）。
 */
export function decodeRouteParam(raw: string | undefined): string | undefined {
  if (!raw || !raw.includes('%')) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function createRouter(routes: Record<string, RouteHandler>) {
  // Build exact match map + parameterized routes
  const exact = new Map<string, RouteHandler>()
  const parameterized: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: RouteHandler }> = []

  for (const [key, handler] of Object.entries(routes)) {
    const parts = key.split(' ')
    const method = parts[0]!
    const path = parts.slice(1).join(' ')
    if (path.includes(':')) {
      // Parameterized route: /tasks/:id → capture group
      const paramNames: string[] = []
      const regexStr = path.replace(/:(\w+)/g, (_, name) => {
        paramNames.push(name)
        return '([^/]+)'
      })
      parameterized.push({
        method,
        pattern: new RegExp('^' + regexStr + '$'),
        paramNames,
        handler,
      })
    } else {
      exact.set(key, handler)
    }
  }

  return async (
    method: string,
    path: string,
    body: unknown,
    reqHeaders?: Record<string, string>,
    res?: ServerResponse,
  ): Promise<RouteResponse> => {
    // Strip query string from path, but surface query params to handlers so
    // routes like `GET /sessions/:id/events?since=N` can read them.
    const qIdx = path.indexOf('?')
    const cleanPath = qIdx >= 0 ? path.slice(0, qIdx) : path
    const query: Record<string, string> = {}
    if (qIdx >= 0) {
      for (const [k, v] of new URLSearchParams(path.slice(qIdx + 1))) query[k] = v
    }

    // Try exact match first
    const exactKey = method + ' ' + cleanPath
    const exactHandler = exact.get(exactKey)
    if (exactHandler) return await exactHandler(body, query, reqHeaders, res)

    // Try parameterized routes. Match on BOTH method and path so a GET and a
    // POST can share the same parameterized path (e.g. GET/POST
    // /sessions/:id/skills) without the first-registered one shadowing the other.
    for (const { method: routeMethod, pattern, paramNames, handler } of parameterized) {
      if (routeMethod !== method) continue
      const match = cleanPath.match(pattern)
      if (match) {
        const params: Record<string, string> = { ...query }
        for (let i = 0; i < paramNames.length; i++) {
          params[paramNames[i]!] = match[i + 1]!
        }
        return await handler(body, params, reqHeaders, res)
      }
    }

    return { status: 404, body: { error: 'Not found' } }
  }
}

export interface StartServerOptions {
  tls?: TlsServerOptions
  /** 监听地址。默认 127.0.0.1；显式设 LAN IP / 0.0.0.0 开启远程访问。 */
  host?: string
  /** Host header allowlist（不带端口）。配置后非回环 Host 仅 allowlist 放行。 */
  allowedHosts?: string[]
  /**
   * LAN Direct 显式 opt-in（设计 §5.3 Wave 1）：允许「非回环 + 无 TLS」的局域网
   * 明文监听，并把默认 Host allowlist 收窄到私网（见 host-policy 的
   * `filterLanDirectHosts`）。缺省读 env `RIVET_SERVE_LAN_DIRECT`（仅 `'1'` 开启）；
   * 未 opt-in 时行为与历史完全一致。
   */
  lanDirect?: boolean
  /** Explicit HTTPS proxy host registered by the authenticated desktop settings. */
  additionalAllowedHosts?: () => string[]
  /**
   * P2 Mobile Remote — /mobile 静态挂载目录。配置后 GET /mobile 与 /mobile/* 在
   * auth 门前直接服务该目录内的前端资产（免 Bearer）；未配置则 /mobile 一律 404。
   * Host 校验与 API Bearer 门禁不受影响。
   */
  mobileDir?: string
}

// 回环判定（绑定地址 / Host 头 / 去端口）见 host-policy.ts——单一真源，与
// remote-info-routes.ts 共用。此处曾各持一份副本，两份都把 '::'（IPv6 通配）
// 误判为回环，导致 LAN 绑定下非回环 Host 全 403。

// ---- /mobile 静态挂载（P2 Mobile Remote）----
// 挂载点固定前缀 '/mobile'：GET /mobile、/mobile/、/mobile/* 在 auth 门前由
// serveMobileTarget 直接响应（免 Bearer——前端资产需手机浏览器免 token 可达），
// 其余路径（API/健康检查）管线不变。路径解析：decode 后归一，拒绝逃逸出
// mobileRoot 的形态（含编码 `..`），目录根请求回退 mobile.html。

const MOBILE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 把 /mobile 前缀的请求路径解析为 mobileRoot 内的文件。无法解析 / 逃逸 / 含
 * 空字节 → null（调用方按 404 处理）。decode 在 resolve 之前——编码 `..` 同样被
 * 包含性检查拦下。
 * realRoot（root 的 realpath，启动时解析一次）存在时再做符号链接防护：词法
 * 包含性挡不住 root 内指向外部的 symlink（readFileSync 跟随）——realpath 后
 * 仍须落在 root 真身内，否则 null（审查 2026-09-12：实测唯一可穿的逃逸面）。
 */
function resolveMobileTarget(root: string, urlPath: string, realRoot?: string): string | null {
  let sub = urlPath
  if (sub.startsWith('/mobile/')) sub = sub.slice('/mobile/'.length)
  else if (sub === '/mobile') sub = ''
  else return null
  let resolved: string
  if (sub === '' || sub === '/') {
    resolved = join(root, 'mobile.html')
  } else {
    let decoded: string
    try {
      decoded = decodeURIComponent(sub)
    } catch {
      return null // 畸形 percent 编码
    }
    if (decoded.includes('\0')) return null
    resolved = resolve(root, decoded)
    const prefix = root.endsWith(sep) ? root : root + sep
    if (resolved !== root && !resolved.startsWith(prefix)) return null
  }
  if (realRoot) {
    let real: string
    try {
      real = realpathSync(resolved)
    } catch {
      return null // 不存在/断链——与 readFileSync 失败同归 404
    }
    const realPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
    if (real !== realRoot && !real.startsWith(realPrefix)) return null
    return real
  }
  return resolved
}

/** 静态文件响应：直接接管 res，成功返回 true（调用方 return 结束请求）。 */
function serveMobileTarget(root: string, urlPath: string, res: ServerResponse, origin?: string, realRoot?: string): boolean {
  const target = resolveMobileTarget(root, urlPath, realRoot)
  if (!target) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
    return true
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(target)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
    return true
  }
  const ct = MOBILE_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': ct,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-cache',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  })
  res.end(bytes)
  return true
}

export async function startServer(
  port: number,
  routes: Record<string, RouteHandler>,
  apiToken?: string,
  opts: StartServerOptions = {},
): Promise<{
  close: (cb?: (err?: Error) => void) => void
  /** 立即关闭 keep-alive 空闲连接（Node ≥18.2）。SSE 清场（closeAll 的
   *  done+end）后 socket 转入空闲态、仍阻塞 server.close(cb)——实测要等 5s
   *  keepAliveTimeout，关停链用它在 close() 之后即时回收（见 serve.ts）。 */
  closeIdleConnections: () => void
  port: number
}> {
  const router = createRouter(routes)

  // CORS：只反射已知 webview 来源（见 cors.ts——SSE/图片路由同源反射）。
  const corsOrigin = allowedCorsOrigin

  const bindHost = opts.host?.trim() || '127.0.0.1'
  // LAN Direct opt-in：显式 opts > env（RIVET_SERVE_LAN_DIRECT=1）。单一真源见
  // serve-transport.resolveLanDirect——与 runServe 同源，避免两处判定漂移。
  const lanDirect = resolveLanDirect(opts.lanDirect)
  assertSecureBind(bindHost, opts.tls, { lanDirect })
  // LAN 模式：显式绑定到非回环地址（0.0.0.0 / LAN IP / ::）。
  const lanMode = !isLoopbackBind(bindHost)
  const allowlist = (opts.allowedHosts ?? (lanMode ? defaultLanHosts(bindHost, { lanDirect }) : [])).map((h) => h.trim().toLowerCase()).filter(Boolean)
  const allowlistConfigured = allowlist.length > 0
  const mobileRoot = opts.mobileDir?.trim() ? resolve(opts.mobileDir.trim()) : undefined
  // root 的 realpath 启动时解析一次——逐请求符号链接防护的比较基准（root 自身
  // 路径也可能含 symlink，如 macOS /tmp → /private/tmp）。解析失败（目录不存在）
  // 时退化为纯词法检查——该目录下任何读取本就 404。
  let mobileRootReal: string | undefined
  if (mobileRoot) {
    try {
      mobileRootReal = realpathSync(mobileRoot)
    } catch {
      mobileRootReal = undefined
    }
  }

  // Host 校验三分支：DNS rebinding 让浏览器带着攻击者域名的 Host 直连本机端口。
  // ① 无 Host（HTTP/1.0 工具客户端）与回环形态恒放行（默认行为，回归保护）；
  // ② allowlist 配置后非回环 Host 仅精确匹配（去端口比较）；
  // ③ 未配置时，TLS LAN 绑定仅接受本机接口地址；其余 Host 拒绝。
  const isHostAllowed = (host: string | undefined, p: number): boolean => {
    if (host === undefined) return true
    const h = host.toLowerCase()
    if (isLoopbackHostHeader(h, p)) return true
    if (opts.additionalAllowedHosts?.().includes(stripHostPort(h))) return true
    if (allowlistConfigured) return allowlist.includes(stripHostPort(h))
    return false
  }

  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    // P0-5 路由异常兜底：此前回调体是裸 async——任一 handler 抛错（现场：
    // POST /project-templates/apply 对已被删除的目录抛 ENOENT）都会变成无人
    // catch 的 rejected promise，Node 默认 --unhandled-rejections=throw 直接
    // 终结整个 sidecar（两次真实崩溃）。这里只兜「单次请求」：未发响应头 →
    // 500 JSON；已开始流式输出（SSE 等）→ 状态行已出、无法再改 500，直接断开
    // 该连接。**不**设 process 级 unhandledRejection 网——路由之外的异常仍应
    // 暴露（吞掉会把真实缺陷变成静默）。
    try {
      const reqHeaders = normalizeHeaders(req)

      if (!isHostAllowed(req.headers.host, boundPort)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: Host not allowed' }))
        return
      }

      const origin = corsOrigin(reqHeaders)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        })
        res.end()
        return
      }

      // P2 Mobile Remote：/mobile 静态挂载在 auth 门前（health 特判旁）。已配
      // mobileDir → GET/HEAD 免 Bearer 服务前端资产；未配 → 任何 /mobile* 请求
      // 404（不暴露「未配置」之外的任何信息）。Host 校验在其上已执行——LAN/allowlist
      // 语义统一适用。API 与 SSE 路径不含 /mobile 前缀，不受此分支影响。
      const rawUrl = req.url ?? '/'
      const qIdx = rawUrl.indexOf('?')
      const cleanUrl = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl
      const isMobilePath = cleanUrl === '/mobile' || cleanUrl.startsWith('/mobile/')
      if (isMobilePath) {
        if (!mobileRoot) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          // 无尾斜杠的 /mobile → 302 到 /mobile/（保留 query）：mobile.html 的资源
          // 引用是相对路径（./assets/…），无斜杠 URL 下浏览器把相对路径解析到站点根
          // （/assets/* 落 API 管线 → 401 白屏）。规范化后相对解析留在 /mobile/ 前缀内。
          // 审查 2026-09-12 修复；与 alpha 上游行为有意偏差（上游直接 200 返回 HTML）。
          if (cleanUrl === '/mobile') {
            const search = qIdx >= 0 ? rawUrl.slice(qIdx) : ''
            res.writeHead(302, { Location: `/mobile/${search}`, 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          serveMobileTarget(mobileRoot, cleanUrl, res, origin, mobileRootReal)
          return
        }
      }

      // Health endpoint is intentionally not auth-gated — the desktop shell and
      // Rust monitor probe it from cold-start / token-rotation windows where the
      // Bearer token may not be available yet. No user data is exposed.
      // 精确匹配 cleanUrl（2026-10-07 审计加固）：/health 与 /health?foo=bar 免鉴权
      // 行为不变；/healthfoo、/health/../sessions 等前缀变体落回 Bearer 校验。
      const isHealth = cleanUrl === '/health'
      if (!isHealth && !isAuthorizedRequest({ headers: reqHeaders }, apiToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      const body = await readBody(req)
      if (body === BODY_TOO_LARGE) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
        res.end(JSON.stringify({ error: 'Request body too large' }))
        return
      }
      if (body === INVALID_JSON) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
        res.end(JSON.stringify({ error: 'Invalid JSON request body' }))
        return
      }

      const result = await router(req.method ?? 'GET', req.url ?? '/', body, reqHeaders, res)
      if (result.handled) return
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
        ...result.headers,
      }
      // 2026-10-04 收编 PR #350：序列化提前到 writeHead 之前——cyclic body 等
      // stringify 失败时 headersSent 仍为 false，走 500 JSON 而非断连。
      const responseBody = result.body ? JSON.stringify(result.body) : ''
      res.writeHead(result.status, headers)
      res.end(responseBody)
    } catch (error) {
      serverLogger.error('[server] request handler error', {
        method: req.method,
        url: req.url,
        ...errorContext(error),
      })
      if (res.headersSent) {
        // 流式响应（SSE）已开始：状态行已发出，500 无法替换——断开该连接，
        // 让客户端立刻看到中断而非永远挂在半条流上。
        res.destroy()
        return
      }
      let origin: string | undefined
      try { origin = corsOrigin(normalizeHeaders(req)) } catch { origin = undefined }
      // 2026-10-04 收编 PR #350：malformed URL encoding（decodeURIComponent 等
      // 抛 URIError）是客户端错误——返回 400 而非 500（现场：provider-key 路由
      // 的路径参数解码）。dev 的 P0-5 兜底只覆盖了 500/destroy/cors 面。
      const malformedUrl = error instanceof URIError
      try {
        res.writeHead(malformedUrl ? 400 : 500, {
          'Content-Type': 'application/json',
          ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
        })
        res.end(JSON.stringify({ error: malformedUrl ? 'Malformed URL encoding' : 'Internal server error' }))
      } catch {
        // 客户端已断开/套接字已失效——写响应失败本身不再逃逸。
        res.destroy()
      }
    }
  }

  const server = opts.tls ? createHttpsServer({ ...opts.tls, minVersion: 'TLSv1.2' }, listener) : createServer(listener)
  let boundPort = port
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bindHost, () => {
      server.removeListener('error', reject)
      // port 0 → 系统分配，回显实际端口（真实 HTTP 测试与横幅依赖它）。
      const addr = server.address()
      if (addr && typeof addr === 'object') boundPort = addr.port
      resolve()
    })
  })
  return {
    close: (cb) => server.close(cb),
    closeIdleConnections: () => server.closeIdleConnections(),
    port: boundPort,
  }
}

const BODY_TOO_LARGE = Symbol('body-too-large')
const INVALID_JSON = Symbol('invalid-json')

type ReadBodyResult = unknown | typeof BODY_TOO_LARGE

function normalizeHeaders(req: IncomingMessage): Record<string, string> {
  const reqHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') reqHeaders[k.toLowerCase()] = v
    else if (Array.isArray(v)) reqHeaders[k.toLowerCase()] = v[0] ?? ''
  }
  return reqHeaders
}

async function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  const chunks: Buffer[] = []
  let total = 0
  // Leaving an ordinary async iterator destroys its stream. Keep the response
  // channel alive long enough to deliver 413, then close that HTTP connection.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      req.resume()
      return BODY_TOO_LARGE
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (err) {
    serverLogger.warn('Invalid JSON request body', { ...errorContext(err) })
    return INVALID_JSON
  }
}
