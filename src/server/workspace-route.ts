import { validateWorkspaceRoots } from './workspace-roots.js'
/**
 * /config/workspace — 工作区策略（默认工作区 + 临时会话隔离根，issue #147）。
 * All routes are Bearer-gated (fail-closed), mirroring buildConfigRoutes.
 *
 *   GET /config/workspace   读 defaultDir / scratchDir / 生效的 scratchRoot
 *   PUT /config/workspace   写回 config.json 的 workspace 段（null/空串 = 清除）
 *
 * 子模块化原因：config-routes.ts 是点名巨石（source-budgets ceiling，零缓冲）——
 * 与 buildZenRoutes 同一接缝外提方式，本模块只依赖 auth.js 与 config 侧读写器。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { rivetHome } from '../config/paths.js'
import { getWorkspaceConfig, setWorkspaceConfig } from '../config/workspace-config.js'
import { sessionScratchRoot } from './workspace.js'
import { buildFileContextRoutes } from './file-context-routes.js'
import { buildSkillManagementRoutes } from './skill-management-routes.js'
import { buildWorkspaceSkillsRoutes } from './workspace-skills-route.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

/** 读快照：附上「临时会话实际会落到哪」——桌面端不能自己拼这条约定。 */
function workspaceSnapshot(): { defaultDir: string | null; scratchDir: string | null; scratchRoot: string } {
  const ws = getWorkspaceConfig()
  return { ...ws, scratchRoot: ws.scratchDir ?? sessionScratchRoot(rivetHome()) }
}

export function buildWorkspaceRoutes(
  apiToken?: string,
  knownWorkspaces: () => string[] = () => [],
): Record<string, RouteHandler> {
  return {
    ...buildFileContextRoutes(apiToken, knownWorkspaces),
    ...buildWorkspaceSkillsRoutes(apiToken),
    ...buildSkillManagementRoutes(apiToken),
    'POST /workspace/validate-roots': withAuth(body => {
      try { return { status: 200, body: { roots: validateWorkspaceRoots((body as { roots?: unknown })?.roots) } } }
      catch (error) { return { status: 400, body: { error: (error as Error).message } } }
    }, apiToken),
    'GET /config/workspace': withAuth(() => {
      return { status: 200, body: workspaceSnapshot() }
    }, apiToken),

    'PUT /config/workspace': withAuth((body) => {
      const data = (body ?? {}) as { defaultDir?: unknown; scratchDir?: unknown }
      try {
        setWorkspaceConfig(data)
        return { status: 200, body: workspaceSnapshot() }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),
  }
}
