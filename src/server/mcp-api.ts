/**
 * /mcp/* routes — MCP server management for the desktop settings UI.
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET    /mcp/status                  list all MCP servers + connection states
 *   POST   /mcp/servers                 add/update an MCP server
 *   DELETE /mcp/servers/:id             remove an MCP server
 *   POST   /mcp/servers/:id/restart     disconnect + reconnect a server
 *   GET    /mcp/servers/:id/tools       list tools for a specific server
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { loadConfig, saveConfig } from '../config/manager.js'
import type { McpManager } from '../mcp/manager.js'
import { mcpServerConfigSchema, type McpServerConfig } from '../mcp/config.js'
import { MCP_PRESETS } from '../mcp/presets.js'
import { serverLogger } from './logger.js'
import type { Tool } from '../tools/types.js'
import { findMcpOAuthProvider } from '../mcp/oauth/providers.js'
import { startMcpOAuth, loadMcpOAuthToken, revokeMcpOAuth } from '../mcp/oauth/connector.js'
import type { McpOAuthToken } from '../mcp/oauth/types.js'
import { isAbsolute } from 'node:path'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

function cloneMcpServers(): Record<string, McpServerConfig> {
  const cfg = loadConfig()
  return { ...cfg.mcp?.servers }
}

function persistMcpServers(servers: Record<string, McpServerConfig>): void {
  const cfg = loadConfig()
  cfg.mcp.servers = servers
  saveConfig(cfg)
}

export interface McpRouteDeps {
  getMcpManager: () => McpManager | null
  /** Late-bound: inject newly discovered tools into live sessions. */
  onToolsReady?: (tools: Tool[]) => void
  apiToken?: string
}

export function buildMcpRoutes(
  getMcpManager: (() => McpManager | null) | McpRouteDeps,
  apiToken?: string,
): Record<string, RouteHandler> {
  // Backward-compatible: (getMgr, token) OR ({ getMcpManager, onToolsReady, apiToken })
  const deps: McpRouteDeps = typeof getMcpManager === 'function'
    ? { getMcpManager, apiToken }
    : getMcpManager
  const getMgr = deps.getMcpManager
  const token = deps.apiToken
  const onToolsReady = deps.onToolsReady

  const notifyTools = (mgr: McpManager, serverId: string) => {
    try {
      const tools = mgr.getToolsForServer(serverId)
      if (tools.length > 0) onToolsReady?.(tools)
    } catch { /* best-effort */ }
  }

  return {
    // GET /mcp/status — live connection states from the running McpManager.
    'GET /mcp/status': withAuth(() => {
      const mgr = getMgr()
      const servers = mgr ? mgr.getStates() : []
      const configServers = cloneMcpServers()
      // Merge config entries for servers that haven't connected yet
      const seen = new Set(servers.map(s => s.serverId))
      for (const [id, cfg] of Object.entries(configServers)) {
        if (!seen.has(id)) {
          servers.push({
            serverId: id,
            status: cfg.disabled ? 'disconnected' : 'disconnected',
            transport: cfg.command ? 'stdio' : 'streamableHttp',
            toolCount: 0,
          })
        }
      }
      return {
        status: 200,
        body: {
          servers,
          totalTools: servers.reduce((s, c) => s + c.toolCount, 0),
          enabled: loadConfig().mcp?.enabled ?? true,
          /** True while the sidecar MCP manager is still booting (POST will
           *  persist config and be picked up by reconcile when ready). */
          managerReady: mgr != null,
        },
      }
    }, token),

    // GET /mcp/presets — curated one-click MCP catalog + which ids are already
    // configured (mirrors provider `unconfigured` so the UI can render add state).
    'GET /mcp/presets': withAuth(() => {
      const configuredIds = Object.keys(cloneMcpServers())
      return { status: 200, body: { presets: MCP_PRESETS, configuredIds } }
    }, token),

    // POST /mcp/servers — add or update an MCP server config.
    'POST /mcp/servers': withAuth((body) => {
      const input = body as Record<string, unknown>
      const serverId = typeof input.serverId === 'string' ? input.serverId : undefined
      if (!serverId) return { status: 400, body: { error: 'serverId is required' } }

      const configInput: Record<string, unknown> = {}
      if (typeof input.command === 'string') configInput.command = input.command
      if (Array.isArray(input.args)) configInput.args = input.args
      if (typeof input.url === 'string') configInput.url = input.url
      if (typeof input.disabled === 'boolean') configInput.disabled = input.disabled
      if (input.env && typeof input.env === 'object') configInput.env = input.env as Record<string, string>
      if (input.headers && typeof input.headers === 'object') configInput.headers = input.headers as Record<string, string>
      if (typeof input.cwd === 'string') configInput.cwd = input.cwd
      if (typeof input.transportHint === 'string') configInput.transportHint = input.transportHint
      if (input.auth && typeof input.auth === 'object') configInput.auth = input.auth
      if (input.policy && typeof input.policy === 'object') configInput.policy = input.policy

      const parsed = mcpServerConfigSchema.safeParse(configInput)
      if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.issues.map(i => i.message).join('; ') } }
      }

      // cwd must be absolute. The sidecar's working directory is not stable
      // (packaged desktop ≠ repo root), so a relative cwd resolves to an
      // unpredictable location — same bug class as the plugin-install path.
      // Route-level (not schema-level) so CLI config files keep relative cwd.
      if (parsed.data.cwd && !isAbsolute(parsed.data.cwd)) {
        return {
          status: 400,
          body: { error: `cwd must be an absolute path (got "${parsed.data.cwd}") — the sidecar working directory is not fixed, so a relative cwd would resolve unpredictably.` },
        }
      }

      const servers = cloneMcpServers()
      servers[serverId] = parsed.data
      persistMcpServers(servers)

      // If manager is live, try connecting immediately. If not yet ready, the
      // config is on disk and runServe's post-init reconcile will pick it up —
      // do NOT silently drop the connect forever.
      const mgr = getMgr()
      if (mgr && !parsed.data.disabled) {
        void mgr.connectAndDiscover(serverId, parsed.data).then((tools) => {
          if (tools.length > 0) onToolsReady?.(tools)
          else {
            // Connection may have failed — still surface nothing here; UI polls status.
            serverLogger.warn(`MCP auto-connect finished for ${serverId} with 0 tools`)
          }
        }).catch((err: Error) => {
          serverLogger.warn(`MCP auto-connect failed for ${serverId}: ${err.message}`)
        })
      } else if (!mgr) {
        serverLogger.warn(`MCP manager not ready — persisted ${serverId}; will reconcile after init`)
      }

      return {
        status: 200,
        body: {
          ok: true,
          serverId,
          pending: !mgr || parsed.data.disabled === true,
          managerReady: mgr != null,
        },
      }
    }, token),

    // GET /mcp/servers/:id — full stored config for the edit form. Issue #63:
    // connection states carry no command/args/env, so the settings UI had no
    // prefill source and custom servers could only be deleted and re-added.
    // env values are returned as stored — local sidecar, same trust domain as
    // the config file itself.
    'GET /mcp/servers/:id': withAuth((_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }
      const servers = cloneMcpServers()
      const cfg = servers[serverId]
      if (!cfg) return { status: 404, body: { error: `MCP server "${serverId}" not found` } }
      return { status: 200, body: { serverId, ...cfg } }
    }, token),

    // DELETE /mcp/servers/:id — remove an MCP server from config.
    'DELETE /mcp/servers/:id': withAuth(async (_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }

      const servers = cloneMcpServers()
      if (!servers[serverId]) {
        return { status: 404, body: { error: `MCP server "${serverId}" not found` } }
      }
      delete servers[serverId]
      persistMcpServers(servers)

      const mgr = getMgr()
      if (mgr) {
        await mgr.shutdownServer(serverId).catch(() => {})
      }

      return { status: 200, body: { ok: true, removed: serverId } }
    }, token),

    // POST /mcp/servers/:id/restart — disconnect and reconnect a server.
    'POST /mcp/servers/:id/restart': withAuth(async (_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }

      const mgr = getMgr()
      if (!mgr) return { status: 503, body: { error: 'MCP manager not initialized' } }

      try {
        await mgr.shutdownServer(serverId)
        const cfg = loadConfig().mcp?.servers[serverId]
        if (!cfg) return { status: 404, body: { error: `MCP server "${serverId}" not found in config` } }
        if (cfg.disabled) return { status: 400, body: { error: `MCP server "${serverId}" is disabled` } }
        const tools = await mgr.connectAndDiscover(serverId, cfg)
        notifyTools(mgr, serverId)
        const state = mgr.getStates().find((s) => s.serverId === serverId)
        if (state?.status === 'error') {
          return { status: 500, body: { error: state.error ?? 'connect failed', serverId, lastErrorClass: state.lastErrorClass } }
        }
        return { status: 200, body: { ok: true, serverId, toolCount: tools.length } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }, token),

    // GET /mcp/servers/:id/tools — list tools for a specific server.
    'GET /mcp/servers/:id/tools': withAuth((_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }

      const mgr = getMgr()
      if (!mgr) return { status: 503, body: { error: 'MCP manager not initialized' } }

      const allTools = mgr.getAllTools()
      const serverTools = allTools
        .filter(t => t.definition.name.startsWith(`mcp__${serverId}__`))
        .map(t => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.input_schema,
        }))

      return { status: 200, body: { tools: serverTools } }
    }, token),

    // GET /tools/disabled — read config-level disabled tools list (session startup reference).
    'GET /tools/disabled': withAuth(() => {
      const cfg = loadConfig()
      const disabledTools = cfg.agent?.toolGating?.disabledTools ?? []
      return { status: 200, body: { disabledTools } }
    }, token),

    // GET /mcp/servers/:id/logs — tail the stderr/event log buffer for a server.
    'GET /mcp/servers/:id/logs': withAuth((_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }
      const mgr = getMgr()
      if (!mgr) return { status: 503, body: { error: 'MCP manager not initialized' } }
      const tail = Number.parseInt((params as Record<string, string>).tail ?? '200', 10) || 200
      const lines = mgr.getLogs(serverId, tail)
      return { status: 200, body: { lines, serverId, truncated: lines.length >= tail } }
    }, token),

    // POST /mcp/servers/:id/oauth/start — initiate OAuth flow for a preset MCP server.
    'POST /mcp/servers/:id/oauth/start': withAuth(async (body, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }
      const clientId = typeof (body as Record<string, unknown>).clientId === 'string'
        ? (body as Record<string, unknown>).clientId as string : ''
      if (!clientId) return { status: 400, body: { error: 'clientId is required' } }
      const cfg = loadConfig().mcp?.servers[serverId]
      if (!cfg) return { status: 404, body: { error: `MCP server "${serverId}" not found` } }
      const preset = MCP_PRESETS.find(p => p.id === serverId)
      const authConfig = cfg.auth ?? preset?.auth
      if (!authConfig || authConfig.type !== 'oauth') {
        return { status: 400, body: { error: 'Server does not support OAuth' } }
      }
      const provider = findMcpOAuthProvider(authConfig.provider)
      if (!provider) {
        return { status: 400, body: { error: `Unknown OAuth provider: ${authConfig.provider}` } }
      }

      // startMcpOAuth blocks until the user completes browser auth — return authUrl
      // for the frontend to open, but the actual flow runs server-side.
      // For headless/CLI, the function handles localhost callback internally.
      try {
        const scopes = [...provider.defaultScopes, ...(authConfig.scopes ?? [])]
        const token = await startMcpOAuth(serverId, provider, clientId, scopes)
        return { status: 200, body: { ok: true, serverId, provider: token.provider, expiresAt: token.expiresAt } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }, token),

    // GET /mcp/servers/:id/oauth/status
    'GET /mcp/servers/:id/oauth/status': withAuth((_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }
      const token = loadMcpOAuthToken(serverId)
      return {
        status: 200,
        body: {
          connected: token !== null && token.expiresAt > Date.now(),
          provider: token?.provider,
          expiresAt: token?.expiresAt,
        },
      }
    }, token),

    // DELETE /mcp/servers/:id/oauth — revoke stored token
    'DELETE /mcp/servers/:id/oauth': withAuth((_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }
      revokeMcpOAuth(serverId)
      return { status: 200, body: { ok: true, serverId } }
    }, token),
  }
}
