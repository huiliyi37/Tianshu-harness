/**
 * Sidecar CORS 白名单——只反射已知 webview 来源。
 *
 * 通配 `*` 在 Bearer token 泄入网页可达上下文时会移除最后一道跨源刹车；
 * 未知 Origin 不发 CORS 头（浏览器默认拒绝跨源读）。非浏览器调用方
 * （Rust 桌面壳 / Node CLI）无 Origin 头，同样无 CORS 头。
 */

export const ALLOWED_CORS_ORIGINS: ReadonlySet<string> = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:5273',
])

/**
 * 开发用追加口：`RIVET_DEV_CORS_ORIGINS`（逗号分隔）。
 *
 * 存在的理由：白名单里写死了 vite 的默认端口 5273，于是「另起一个端口的 dev」
 * 会被 CORS 全拒——想避开正在运行的桌面端就只能改源码。未设置该变量时行为与
 * 从前完全一致（fail-closed 不变）；设置后才额外反射所列来源，且仍要求完整
 * 匹配（不接受通配，避免把 token 交给任意站点）。
 */
export function extraAllowedCorsOrigins(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const raw = env.RIVET_DEV_CORS_ORIGINS?.trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

/** 请求 Origin 在白名单内则返回原值（反射），否则 undefined（不下发 CORS 头）。 */
export function allowedCorsOrigin(
  reqHeaders: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const origin = reqHeaders['origin']
  if (!origin) return undefined
  if (ALLOWED_CORS_ORIGINS.has(origin)) return origin
  return extraAllowedCorsOrigins(env).has(origin) ? origin : undefined
}
