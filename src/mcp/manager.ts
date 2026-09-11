import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '../tools/types.js'
import type { McpConfig, McpServerConfig } from './config.js'
import type { McpConnectionState, McpTransportType } from './types.js'
import { createMcpToolWrapper, createMcpConnectorConsent, type McpConnectorConsent } from './wrapper.js'
import { classifyMcpError } from './failure-classifier.js'
import { createTransport, type TransportResult } from './transport-factory.js'
import { LogRingBuffer } from './log-buffer.js'
import { getNetworkConfig } from '../config/manager.js'
import type { McpNetworkConfig } from './stdio-env.js'

const DEFAULT_MCP_TIMEOUT_MS = 60_000

/** network 配置读取失败（坏 config.json）不应阻断 MCP 连接——配置错误由
 *  配置加载自己的报错通道负责，这里降级为「无应用代理」。 */
function readNetworkConfigSafe(): McpNetworkConfig | undefined {
  try {
    const net = getNetworkConfig()
    return { proxy: net.proxy || undefined, noProxy: net.noProxy || undefined }
  } catch {
    return undefined
  }
}
const NETWORK_RETRY_DELAY_MS = 800
const RECONNECT_MAX_ATTEMPTS = 3
const RECONNECT_BACKOFF_BASE_MS = 2_000

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function formatConnectError(err: unknown, stderrTail: string, context?: { transport?: 'stdio' | 'remote' }): string {
  const base = err instanceof Error ? err.message : String(err)
  const classified = classifyMcpError(err, context)
  const parts = [base]
  if (stderrTail) {
    const compact = stderrTail.replace(/\n+/g, ' | ').slice(0, 500)
    parts.push(`stderr: ${compact}`)
  }
  if (classified.suggestion) parts.push(classified.suggestion)
  return parts.join(' — ')
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export interface ConnectedServer {
  client: Client
  transport: TransportResult['transport']
  serverId: string
  transportType: McpTransportType
  /** Last stdio stderr bytes captured (for error attribution). */
  stderrTail?: () => string
}

export class McpManager {
  private config: McpConfig
  private connections: Map<string, ConnectedServer> = new Map()
  private states: Map<string, McpConnectionState> = new Map()
  private tools: Tool[] = []
  private timeoutMs: number
  // Per-server reconnect attempt counter (for remote transports).
  private reconnectAttempts: Map<string, number> = new Map()
  // Reconnect timer handles — cleared on shutdown to prevent reconnect-after-close.
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  // Per-server stderr/event log buffers (ring buffer, 64KB default).
  private logBuffers: Map<string, LogRingBuffer> = new Map()
  // In-flight connect promises per serverId — prevents concurrent connect attempts
  // for the same server (e.g. reconcile + REST API hot-add racing).
  private connectLocks: Map<string, Promise<Tool[]>> = new Map()
  // Shared across all wrappers: first use of each connector requires explicit opt-in.
  private connectorConsent: McpConnectorConsent = createMcpConnectorConsent()

  constructor(config: McpConfig) {
    this.config = config
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) return

    const entries = Object.entries(this.config.servers)
      .filter(([, cfg]) => !cfg.disabled)

    await Promise.allSettled(
      entries.map(([serverId, serverConfig]) =>
        this.connectAndDiscover(serverId, serverConfig),
      ),
    )
  }

  /**
   * Re-read a live config snapshot and connect any servers that are missing
   * from the in-memory manager — used after fire-and-forget init so a POST
   * that landed while mgr was still null still gets a connect attempt.
   * Skips currently connected/connecting entries; retries error/disconnected.
   * @returns newly registered tools from this reconcile pass
   */
  async reconcileFromConfig(live: McpConfig): Promise<Tool[]> {
    this.config = live
    this.timeoutMs = live.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
    if (!live.enabled) return []

    const added: Tool[] = []
    for (const [serverId, cfg] of Object.entries(live.servers)) {
      if (cfg.disabled) continue
      const state = this.states.get(serverId)
      if (state?.status === 'connected' || state?.status === 'connecting') continue
      if (this.connections.has(serverId)) continue
      const before = new Set(this.tools.map((t) => t.definition.name))
      await this.connectAndDiscover(serverId, cfg)
      for (const tool of this.tools) {
        if (!before.has(tool.definition.name) && tool.definition.name.startsWith(`mcp__${serverId}__`)) {
          added.push(tool)
        }
      }
    }
    return added
  }

  getAllTools(): Tool[] {
    return this.tools
  }

  /** Tools belonging to one server (by `mcp__{id}__` prefix). */
  getToolsForServer(serverId: string): Tool[] {
    const prefix = `mcp__${serverId}__`
    return this.tools.filter((t) => t.definition.name.startsWith(prefix))
  }

  getConnection(serverId: string): ConnectedServer | undefined {
    return this.connections.get(serverId)
  }

  /** Get log entries for a server's stderr + transport events (ring buffer tail). */
  getLogs(serverId: string, tail = 200): import('./log-buffer.js').LogEntry[] {
    const buf = this.logBuffers.get(serverId)
    return buf ? buf.tail(tail) : []
  }

  getStates(): McpConnectionState[] {
    return Array.from(this.states.values())
  }

  async shutdown(): Promise<void> {
    // Clear pending reconnect timers before closing transports.
    for (const [, timer] of this.reconnectTimers) clearTimeout(timer)
    this.reconnectTimers.clear()
    const closePromises = Array.from(this.connections.values()).map(async (conn) => {
      try {
        await conn.transport.close()
      } catch {
        // Best-effort close
      }
    })
    await Promise.all(closePromises)
    this.connections.clear()
    this.states.clear()
    this.logBuffers.clear()
    this.tools = []
  }

  /**
   * Synchronous force-kill of MCP child processes — for the process-exit path.
   *
   * `shutdown()` is async (`await transport.close()`); on `process.exit(0)` that
   * promise is abandoned before it runs, so the spawned MCP server only receives
   * stdin-EOF. Well-behaved servers exit on EOF, but misbehaving ones (e.g.
   * lark-mcp) linger as PPID=1 orphans. StdioClientTransport exposes the child
   * pid, so we SIGKILL the process group inline before exiting.
   * (root-cause analysis 2026-06-05, Thread 1A)
   */
  killChildrenSync(): void {
    const isWindows = process.platform === 'win32'
    for (const conn of this.connections.values()) {
      const pid = (conn.transport as { pid?: number | null }).pid
      if (typeof pid !== 'number' || pid <= 0) continue
      if (isWindows) {
        // Windows has no process-group kill; taskkill /T terminates the whole
        // subtree (child + grand-children) matching the spawned pid.
        try {
          execSync(`taskkill /T /F /PID ${pid}`, { windowsHide: true, stdio: 'ignore' })
        } catch { /* already gone */ }
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch {
          try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        }
      }
    }
    this.connections.clear()
  }

  /** Shut down a single server by id — for the REST API restart/remove flow. */
  async shutdownServer(serverId: string): Promise<void> {
    // Clear pending reconnect timer for this server.
    const timer = this.reconnectTimers.get(serverId)
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(serverId) }
    const conn = this.connections.get(serverId)
    if (conn) {
      // Remove onclose handler to avoid reconnect fighting with shutdown.
      conn.transport.onclose = undefined
      try { await conn.transport.close() } catch { /* best-effort */ }
      this.connections.delete(serverId)
    }
    this.reconnectAttempts.delete(serverId)
    // Remove the server's tools from the tool list
    const prefix = `mcp__${serverId}__`
    this.tools = this.tools.filter(t => !t.definition.name.startsWith(prefix))
    this.states.delete(serverId)
  }

  /**
   * Connect and discover tools for a single server. Public so the REST API can
   * hot-add servers without a full restart.
   * @returns tools newly registered for this server (empty on failure)
   */
  async connectAndDiscover(serverId: string, serverConfig: McpServerConfig): Promise<Tool[]> {
    const existing = this.connectLocks.get(serverId)
    if (existing) return existing

    const promise = this._connectAndDiscover(serverId, serverConfig, /*attempt*/ 0).finally(() => {
      // Release the lock once the attempt completes (success or failure).
      this.connectLocks.delete(serverId)
    })
    this.connectLocks.set(serverId, promise)
    return promise
  }

  private async _connectAndDiscover(
    serverId: string,
    serverConfig: McpServerConfig,
    attempt: number,
  ): Promise<Tool[]> {
    const transport: McpTransportType = serverConfig.command ? 'stdio' : 'streamableHttp'
    this.states.set(serverId, {
      serverId,
      status: 'connecting',
      transport,
      toolCount: 0,
    })

    let stderrTail = ''
    try {
      const server = await this._connectServer(serverId, serverConfig)
      stderrTail = server.stderrTail?.() ?? ''
      this.connections.set(serverId, server)

      try {
        // Drop prior tools for this server (restart / re-reconcile path).
        const prefix = `mcp__${serverId}__`
        this.tools = this.tools.filter((t) => !t.definition.name.startsWith(prefix))

        const mcpTools = await this._discoverTools(serverId, server)

        const rivetTools = mcpTools.map(mcpDef => {
          const perToolCallFn = async (input: Record<string, unknown>) => {
            if (!this.connections.has(serverId)) {
              throw new Error(`MCP server "${serverId}" is disconnected`)
            }
            try {
              const result = await withTimeout(
                server.client.callTool({ name: mcpDef.name, arguments: input }),
                `MCP callTool ${serverId}/${mcpDef.name}`,
                this.timeoutMs,
              )
              const textContent = (result.content as Array<{ type: string; text?: string }>)
                .filter((c): c is { type: 'text'; text: string } =>
                  c.type === 'text' && typeof c.text === 'string')
              return {
                content: textContent,
                isError: result.isError as boolean | undefined,
              }
            } catch (err) {
              const classified = classifyMcpError(err, {
                transport: server.transportType === 'stdio' ? 'stdio' : 'remote',
              })
              const current = this.states.get(serverId)
              this.states.set(serverId, {
                serverId,
                transport: server.transportType,
                status: 'degraded',
                toolCount: current?.toolCount ?? 0,
                error: formatConnectError(err, '', {
                  transport: server.transportType === 'stdio' ? 'stdio' : 'remote',
                }),
                errorHint: classified.suggestion,
                lastConnectedAt: current?.lastConnectedAt,
                lastErrorClass: classified.class,
                lastErrorAt: Date.now(),
              })
              throw err
            }
          }
          return createMcpToolWrapper(
            serverId,
            mcpDef,
            perToolCallFn,
            this.connectorConsent,
            serverConfig.policy?.tools[mcpDef.name],
            server.transportType === 'stdio' ? 'stdio' : 'remote',
          )
        })

        this.tools.push(...rivetTools)
        this.states.set(serverId, {
          serverId,
          transport: server.transportType,
          status: 'connected',
          toolCount: mcpTools.length,
          lastConnectedAt: Date.now(),
        })
        // Reset reconnect counter on successful connect.
        this.reconnectAttempts.delete(serverId)
        return rivetTools
      } catch (err) {
        // Tool discovery failed — close the transport that was just opened
        try { await server.transport.close() } catch { /* best-effort */ }
        this.connections.delete(serverId)
        throw err
      }
    } catch (err) {
      const classified = classifyMcpError(err, { transport: transport === 'stdio' ? 'stdio' : 'remote' })
      // One automatic backoff retry for transient/network failures.
      if (classified.retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS))
        return this._connectAndDiscover(serverId, serverConfig, attempt + 1)
      }
      this.states.set(serverId, {
        serverId,
        transport,
        status: 'error',
        toolCount: 0,
        error: formatConnectError(err, stderrTail, { transport: transport === 'stdio' ? 'stdio' : 'remote' }),
        errorHint: classified.suggestion,
        lastErrorClass: classified.class,
        lastErrorAt: Date.now(),
      })
      return []
    }
  }

  /** @internal Overridable for testing */
  async _connectServer(serverId: string, config?: McpServerConfig): Promise<ConnectedServer> {
    const cfg = config ?? this.config.servers[serverId]!

    // Create a ring buffer for this server's logs (stderr + transport events).
    if (!this.logBuffers.has(serverId)) {
      this.logBuffers.set(serverId, new LogRingBuffer())
    }
    const logBuf = this.logBuffers.get(serverId)!

    const transportOpts: {
      getHeaders?: () => Promise<Record<string, string>>
      getEnv?: () => Promise<Record<string, string>>
      timeoutMs?: number
      network?: McpNetworkConfig
    } = { timeoutMs: this.timeoutMs, network: readNetworkConfigSafe() }
    if (cfg.headers) {
      transportOpts.getHeaders = async () => cfg.headers as Record<string, string>
    }

    // Wire OAuth token to transport if configured.
    // Prefer getMcpAccessToken because it refreshes expired tokens; fall back
    // to the cached snapshot when refresh is unavailable or fails.
    if (cfg.auth?.type === 'oauth') {
      const { findMcpOAuthProvider } = await import('./oauth/providers.js')
      const { loadMcpOAuthToken, getMcpAccessToken } = await import('./oauth/connector.js')
      const { resolveOAuthEnv, resolveOAuthHeaders } = await import('./oauth/inject.js')
      const provider = findMcpOAuthProvider(cfg.auth.provider)
      if (provider) {
        let token: import('./oauth/types.js').McpOAuthToken | null = null
        const clientId = process.env.RIVET_MCP_OAUTH_CLIENT_ID?.trim() ?? ''
        if (clientId) {
          try {
            await getMcpAccessToken(serverId, provider, clientId)
            token = loadMcpOAuthToken(serverId)
          } catch {
            // Refresh failed — fall back to the cached token (may be expired).
            token = loadMcpOAuthToken(serverId)
          }
        } else {
          token = loadMcpOAuthToken(serverId)
        }
        if (token) {
          // For stdio: merge OAuth env with static env.
          // For remote (URL): merge OAuth Authorization header with static headers.
          if (cfg.command) {
            const staticEnv = cfg.env as Record<string, string> | undefined
            const oauthEnv = resolveOAuthEnv(provider.id, token)
            transportOpts.getEnv = async () => ({ ...staticEnv, ...oauthEnv })
          } else {
            const staticHeaders = cfg.headers as Record<string, string> | undefined
            const oauthHeaders = resolveOAuthHeaders(provider.id, token)
            transportOpts.getHeaders = async () => ({ ...staticHeaders, ...oauthHeaders })
          }
        }
      }
    }

    // Factory handles Client creation, transport construction, and connect.
    const result = await withTimeout(
      createTransport(cfg, transportOpts),
      `MCP connect ${serverId}`,
      this.timeoutMs,
    )

    // Wire persistent stderr capture for stdio transports.
    if (result.transportType === 'stdio') {
      const stderrStream = (result.transport as { stderr?: { on?(event: string, cb: (chunk: Buffer | string) => void): void } }).stderr
      if (stderrStream && typeof stderrStream.on === 'function') {
        stderrStream.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          logBuf.push({ ts: Date.now(), stream: 'stderr', text })
        })
      }
    }

    // Register onclose handler for auto-reconnect on remote transports.
    // stdio transport death is terminal (process exited).
    if (result.transportType !== 'stdio' && process.env.RIVET_MCP_RECONNECT !== '0') {
      result.transport.onclose = () => {
        this._onTransportClosed(serverId, cfg)
      }
    }

    return {
      client: result.client,
      serverId,
      transport: result.transport,
      transportType: result.transportType,
      stderrTail: result.stderrTail,
    }
  }

  /**
   * Auto-reconnect handler for remote (URL-based) transport disconnections.
   * Uses exponential backoff: 2s, 4s, 8s, up to RECONNECT_MAX_ATTEMPTS.
   * Disabled when RIVET_MCP_RECONNECT=0.
   */
  private _onTransportClosed(serverId: string, cfg: McpServerConfig): void {
    const attempts = this.reconnectAttempts.get(serverId) ?? 0
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      const current = this.states.get(serverId)
      this.states.set(serverId, {
        serverId,
        transport: 'streamableHttp',
        status: 'error',
        toolCount: current?.toolCount ?? 0,
        error: `Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts`,
        lastConnectedAt: current?.lastConnectedAt,
        lastErrorAt: Date.now(),
      })
      return
    }

    this.reconnectAttempts.set(serverId, attempts + 1)
    this.connections.delete(serverId)

    const delay = RECONNECT_BACKOFF_BASE_MS * Math.pow(2, attempts)
    const current = this.states.get(serverId)
    this.states.set(serverId, {
      serverId,
      transport: 'streamableHttp',
      status: 'degraded',
      toolCount: current?.toolCount ?? 0,
      error: `Reconnecting (attempt ${attempts + 1}/${RECONNECT_MAX_ATTEMPTS})…`,
      lastConnectedAt: current?.lastConnectedAt,
      lastErrorAt: Date.now(),
    })

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(serverId)
      try {
        await this._connectAndDiscover(serverId, cfg, /*attempt*/ 0)
      } catch {
        // Error already recorded by _connectAndDiscover.
      }
    }, delay)
    this.reconnectTimers.set(serverId, timer)
  }

  /** @internal Overridable for testing */
  async _discoverTools(serverId: string, server?: ConnectedServer): Promise<McpToolDef[]> {
    const conn = server ?? this.connections.get(serverId)
    if (!conn) return []
    const result = await withTimeout(conn.client.listTools(), `MCP listTools ${serverId}`, this.timeoutMs)
    return result.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: 'object' as const, properties: {} }) as McpToolDef['inputSchema'],
    }))
  }
}
