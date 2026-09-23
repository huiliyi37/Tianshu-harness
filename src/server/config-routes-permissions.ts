import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import { getBashPermissions, setBashPermissions } from '../config/bash-permissions.js'
import { listPersistedGrants, revokeGrant } from '../tools/path-grants.js'

/**
 * 授权/权限类路由外提模块：
 *   - GET/PUT    /config/bash-permissions   bash 命令白/黑名单（持久层）
 *   - GET/DELETE /config/path-grants        审批时记住的出界目录授权
 *
 * bash 白名单的定位：会话内审批学习的前缀只活在当次会话（`src/agent/permissions.ts`
 * 的 overlay 注释：apply only to the current session），而自动化任务每次触发都是
 * 新会话——这份 config 才是跨会话生效的那一份。保存对之后启动的会话生效（存活
 * 会话保留启动时构建的 overlay）。
 *
 * 子模块化原因：`config-routes.ts` 是点名巨石（source-budgets ceiling），按接缝
 * 外提——与 workspace / zen / provider-keys 同一处理方式。
 */
export function buildPermissionRoutes(apiToken?: string): Record<string, RouteHandler> {
  const withAuth = (handler: RouteHandler): RouteHandler =>
    async (body, params, headers, res) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      return handler(body, params, headers, res)
    }

  return {
    'GET /config/bash-permissions': withAuth(() => {
      return { status: 200, body: getBashPermissions() }
    }),

    'PUT /config/bash-permissions': withAuth((body) => {
      const { allowlist, denylist } = (body ?? {}) as { allowlist?: unknown; denylist?: unknown }
      if (allowlist === undefined && denylist === undefined) {
        return { status: 400, body: { error: 'allowlist or denylist is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setBashPermissions({ allowlist, denylist }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }),

    // Approval-time directory grants the user chose to remember. Keyed by
    // workspace (a grant for project A must never surface under project B), so
    // `cwd` is required rather than defaulting to the sidecar's own directory.
    'GET /config/path-grants': withAuth((_body, params) => {
      const cwd = params?.cwd
      if (!cwd || !isAbsolute(cwd)) {
        return { status: 400, body: { error: 'cwd (absolute path) is required' } }
      }
      return {
        status: 200,
        body: {
          grants: listPersistedGrants(cwd).map(g => ({
            path: g.root,
            mode: g.mode,
            grantedAt: g.grantedAt,
            exists: existsSync(g.root),
          })),
        },
      }
    }),

    // Revoke is fail-safe (it only ever narrows access), and takes effect in
    // this running sidecar rather than at the next start — see revokeGrant.
    'DELETE /config/path-grants': withAuth((_body, params) => {
      const cwd = params?.cwd
      const path = params?.path
      if (!cwd || !isAbsolute(cwd)) {
        return { status: 400, body: { error: 'cwd (absolute path) is required' } }
      }
      if (!path) return { status: 400, body: { error: 'path is required' } }
      const removed = revokeGrant(path, { cwd })
      return { status: 200, body: { ok: true, removed } }
    }),
  }
}
