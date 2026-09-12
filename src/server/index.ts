import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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
  /** 监听地址。默认 127.0.0.1；显式设 LAN IP / 0.0.0.0 开启远程访问。 */
  host?: string
  /** Host header allowlist（不带端口）。配置后非回环 Host 仅 allowlist 放行。 */
  allowedHosts?: string[]
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
): Promise<{ close: (cb?: (err?: Error) => void) => void; port: number }> {
  const router = createRouter(routes)

  // CORS：只反射已知 webview 来源（见 cors.ts——SSE/图片路由同源反射）。
  const corsOrigin = allowedCorsOrigin

  const bindHost = opts.host?.trim() || '127.0.0.1'
  // LAN 模式：显式绑定到非回环地址（0.0.0.0 / LAN IP / ::）。
  const lanMode = !isLoopbackBind(bindHost)
  const allowlist = (opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)
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
  // ③ 未配 allowlist 的 LAN 模式放行任意 Host——此时 Bearer 是唯一凭证
  // （auth 校验紧随其后强制执行），DNS-rebinding 取舍见 P1 Mobile Remote 文档。
  const isHostAllowed = (host: string | undefined, p: number): boolean => {
    if (host === undefined) return true
    const h = host.toLowerCase()
    if (isLoopbackHostHeader(h, p)) return true
    if (allowlistConfigured) return allowlist.includes(stripHostPort(h))
    return lanMode
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
    // Use startsWith so /health?foo=bar also bypasses auth.
    const isHealth = req.url?.startsWith('/health') ?? false
    if (!isHealth && !isAuthorizedRequest({ headers: reqHeaders }, apiToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const body = await readBody(req)
    if (body === BODY_TOO_LARGE) {
      res.writeHead(413, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
      res.end(JSON.stringify({ error: 'Request body too large' }))
      return
    }

    const result = await router(req.method ?? 'GET', req.url ?? '/', body, reqHeaders, res)
    if (result.handled) return
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...result.headers,
    }
    res.writeHead(result.status, headers)
    res.end(result.body ? JSON.stringify(result.body) : '')
  })

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
  return { close: (cb) => server.close(cb), port: boundPort }
}

const BODY_TOO_LARGE = Symbol('body-too-large')

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
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      req.destroy()
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
    return {}
  }
}
