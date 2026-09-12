/**
 * Tianshu Update Mirror — Cloudflare Worker
 *
 * 反代 GitHub release, 让国内用户走 Cloudflare 全球 CDN 拿 latest.json + 安装包,
 * 避免火山引擎/运营商拦截 + GitHub 直连慢。
 *
 * 路由:
 *   /tianshu/latest.json                        → GitHub releases/latest/download/latest.json
 *   /tianshu/releases/download/<tag>/<asset>     → GitHub releases/download/<tag>/<asset>
 *
 * 部署: wrangler deploy (见同目录 wrangler.toml)
 * 域名: 默认 <worker-name>.<account>.workers.dev, 也可绑自有域名。
 *
 * 安全: 只代理 huiliyi37/Tianshu-harness 这个仓库的 release 资产, path 白名单校验,
 * 不开放任意 GitHub URL 转发 (防被盗用当通用代理)。
 */

const GITHUB_OWNER = 'huiliyi37'
// 2026-09 仓库改名 Tianshu-Tui → Tianshu-harness。manifest 资产 url 已用新名，
// 改写探针不同步会整串不匹配 → 镜像只代理入口、资产仍直连 GitHub（3.19.0 实证）。
const GITHUB_REPO = 'Tianshu-harness'
const GITHUB_BASE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

// 资产名前缀白名单——只允许天枢安装包 + 插件自包含运行时 + latest.json + sig,
// 拒绝其他文件名。防止 Worker 被当通用 GitHub 代理盗用。
// tianshu-runtime-*：VS Code 插件 E2 ②级自举包（.tar.gz + .sha256 校验文件）。
// AppImage 自 3.16 起进入 Linux 线资产（2026-09-13 补入白名单）。
const ASSET_NAME_PATTERN = /^(Tianshu_.+\.(exe|exe\.sig|msi|msi\.sig|app\.tar\.gz|app\.tar\.gz\.sig|dmg|appimage|appimage\.sig)|tianshu-runtime-.+\.tar\.gz(\.sha256)?)$/i

// Cloudflare 边缘缓存时长。release 资产不可变 (每个 tag 的文件内容固定),
// 可以放心长缓存; latest.json 走短缓存 (它随最新 release 切换而变)。
const CACHE_LONG = 'public, max-age=86400, s-maxage=2592000' // 30 天
// latest.json 不缓存——它是 updater 的"有没有新版本"判据, 缓存旧值会导致
// 用户检测不到刚发布的新版本 (Tauri updater 拿到第一个有效响应就停)。
// 安装包缓存 30 天 (不可变资产, 按 tag 唯一)。
const CACHE_SHORT = 'no-cache, no-store, must-revalidate'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    // /pay/* → 履约服（Service Binding 直连，同账号 workers.dev 子请求会被拦）。
    // 2026-08-10：pay.plotstudio.cn 独立域名路由在边缘侧始终不激活（DNS/路由/证书
    // 全部正常但 TLS 握手被重置），购买页改挂到本已验证可用的主机名路径下。
    if (path === '/pay' || path.startsWith('/pay/')) {
      if (!env.FULFILL_SERVICE) return new Response('fulfill not bound\n', { status: 502 })
      const inner = path === '/pay' ? '/' : path.slice(4) // '/pay/x' → '/x'
      const headers = new Headers(request.headers)
      headers.set('x-pay-prefix', '/pay') // 履约服据此把 returnUrl 拼成镜像路径
      return env.FULFILL_SERVICE.fetch(new Request(`https://fulfill.internal${inner}${url.search}`, { method: request.method, headers, body: request.body }))
    }

    // 健康检查
    if (path === '/' || path === '/health') {
      return new Response('tianshu-update-mirror ok\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    // /tianshu/latest.json → GitHub releases/latest/download/latest.json
    // 关键：manifest 内嵌的资产 url 必须改写到本 worker 的资产路由——否则
    // 客户端只经镜像拿了入口，下载仍直连 GitHub（2026-07-31 前一直如此）。
    if (path === '/tianshu/latest.json') {
      return proxyManifest(`${GITHUB_BASE}/releases/latest/download/latest.json`, url.origin)
    }

    // /tianshu/releases/download/<tag>/<asset> → GitHub releases/download/<tag>/<asset>
    const m = path.match(/^\/tianshu\/releases\/download\/([^/]+)\/(.+)$/)
    if (m) {
      const [, tag, assetName] = m
      if (!ASSET_NAME_PATTERN.test(assetName)) {
        return new Response('asset not allowed\n', { status: 403 })
      }
      return proxyAndCache(`${GITHUB_BASE}/releases/download/${tag}/${assetName}`, request, ctx, CACHE_LONG, 'application/octet-stream')
    }

    return new Response('not found\n', { status: 404 })
  },
}

/**
 * 拉取 latest.json 并把内嵌资产 url 从 github.com 改写到本 worker 的资产路由
 * （/tianshu/releases/download/<tag>/<asset>），manifest 很小，整体读入无压力。
 * latest.json 不缓存（CACHE_SHORT）——它是 updater 的"有没有新版本"判据。
 */
async function proxyManifest(targetUrl, origin) {
  try {
    const upstream = await fetch(targetUrl, {
      headers: { 'User-Agent': 'tianshu-update-mirror/1.0 (Cloudflare Worker)' },
      redirect: 'follow',
    })
    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}\n`, { status: upstream.status })
    }
    const text = await upstream.text()
    const rewritten = text.replaceAll(
      `${GITHUB_BASE}/releases/download/`,
      `${origin}/tianshu/releases/download/`,
    )
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Cache-Control': CACHE_SHORT,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err) {
    return new Response(`proxy error: ${err.message}\n`, { status: 502 })
  }
}

/**
 * Fetch GitHub, stream back, let Cloudflare edge cache it.
 * GitHub release 资产走 302 重定向到 objects.githubusercontent.com——必须 follow。
 */
async function proxyAndCache(targetUrl, request, ctx, cacheControl, contentType) {
  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      // GitHub release download 不需要鉴权 (public repo), 但带 UA 更稳。
      headers: { 'User-Agent': 'tianshu-update-mirror/1.0 (Cloudflare Worker)' },
      redirect: 'follow',
    })

    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}\n`, { status: upstream.status })
    }

    // 流式回传, 让 Cloudflare 边缘节点自动缓存 (Cache API + cf.cache).
    // body 直接 pipe, 不缓冲到 Worker 内存 (大文件 ~100MB 安装包不会撑爆 128MB 限制).
    const headers = new Headers(upstream.headers)
    headers.set('Cache-Control', cacheControl)
    headers.set('Content-Type', contentType)
    // CORS: 桌面端 webview 跨域请求需要
    headers.set('Access-Control-Allow-Origin', '*')

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  } catch (err) {
    return new Response(`proxy error: ${err.message}\n`, { status: 502 })
  }
}
