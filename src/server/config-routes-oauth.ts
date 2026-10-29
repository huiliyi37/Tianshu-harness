/**
 * /config/providers/:name/oauth/* — OAuth 型 provider（codex 订阅制）的登录/登出。
 * Bearer 守卫与 config-routes.ts 同式（fail-closed）。
 *
 *   POST /config/providers/:name/oauth/login   发起 PKCE 登录（开浏览器 + 回环监听），立即返回
 *   POST /config/providers/:name/oauth/logout  登出（清 token store + 立导入抑制标记）
 *
 * 子模块化原因：config-routes.ts 是点名巨石（source-budgets ceiling），按接缝外提
 * ——同 config-routes-keys.ts（多 key 池）/ config-routes-zen.ts 先例。
 */
import { decodeRouteParam, type RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { loadConfig } from '../config/manager.js'
import { createAuthProvider, clearOAuthLogin } from '../auth/registry.js'
import { runOAuthLogin, openInBrowser } from '../auth/login-flow.js'
import type { ProviderConfig } from '../config/schema.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

/** 同 provider 的 PKCE 登录单飞表（重复点「登录」不再起第二个回环监听）。 */
const oauthLoginInflight = new Map<string, Promise<unknown>>()

/** OAuth 型 provider 的登录态判定——与 serve.ts providerHasUsableAuth 的 oauth
 *  分支同一条链（createAuthProvider + isAuthenticated）。 */
function isOAuthAuthenticated(p: ProviderConfig): boolean {
  try {
    return createAuthProvider(p.auth ?? undefined, process.env, p.apiKey).isAuthenticated()
  } catch {
    return false
  }
}

/** GET /config/providers 列表项的 oauth 维度：codex 等订阅型没有 API key 概念
 *  （keyStatus 恒 none），登录态走 oauthAuthenticated——UI 据 authType 分叉。 */
export function oauthListFields(p: ProviderConfig): { authType?: 'oauth' | 'tianshu-account'; officialAvailable?: boolean; oauthAuthenticated?: boolean } {
  if (p.auth?.type === 'tianshu-account') return { authType: 'tianshu-account', officialAvailable: false }
  if (p.auth?.type !== 'oauth') return {}
  return { authType: 'oauth', oauthAuthenticated: isOAuthAuthenticated(p) }
}

export function buildOAuthRoutes(apiToken?: string, onChanged?: () => void): Record<string, RouteHandler> {
  return {
    // 登录是长动作（用户要在浏览器里点授权）：路由立即返回 started，登录态落盘
    // 由前端轮询 GET /config/providers 的 oauthAuthenticated 确认。
    'POST /config/providers/:name/oauth/login': withAuth(async (_body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      const prov = loadConfig().provider.providers[name]
      if (!prov) return { status: 404, body: { error: `provider "${name}" not found` } }
      if (prov.auth?.type !== 'oauth') return { status: 400, body: { error: `provider "${name}" is not OAuth-based` } }
      if (!oauthLoginInflight.has(name)) {
        const p = runOAuthLogin(name, (url) => openInBrowser(url))
          .then((res) => {
            if (res.ok) onChanged?.()
            else console.warn(`[oauth] login for ${name} failed: ${res.message}`)
          })
          .catch((err) => console.warn(`[oauth] login for ${name} error: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => { oauthLoginInflight.delete(name) })
        oauthLoginInflight.set(name, p)
      }
      return { status: 200, body: { ok: true, started: true } }
    }, apiToken),

    // 登出语义（清 store + 立导入抑制标记）见 auth/registry.ts 的 clearOAuthLogin。
    'POST /config/providers/:name/oauth/logout': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      const prov = loadConfig().provider.providers[name]
      if (!prov) return { status: 404, body: { error: `provider "${name}" not found` } }
      if (prov.auth?.type !== 'oauth') return { status: 400, body: { error: `provider "${name}" is not OAuth-based` } }
      const cleared = clearOAuthLogin(prov.auth.provider)
      onChanged?.()
      return { status: 200, body: { ok: cleared } }
    }, apiToken),
  }
}
