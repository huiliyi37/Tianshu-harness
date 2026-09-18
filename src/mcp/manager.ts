import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '../tools/types.js'
import type { McpConfig, McpServerConfig } from './config.js'
import type { McpConnectionState, McpTransportType } from './types.js'
import { createMcpToolWrapper, createMcpConnectorConsent, type McpConnectorConsent } from './wrapper.js'
import { readSubAgentWorkspacePolicy, subAgentScratchRoot, workspaceDeclarationFor } from './workspace-policy.js'
import { classifyMcpError } from './failure-classifier.js'
import { createTransport, type TransportResult } from './transport-factory.js'
import { LogRingBuffer } from './log-buffer.js'
import { getNetworkConfig } from '../config/manager.js'
import type { McpNetworkConfig } from './stdio-env.js'
import { HealthChecker, type HealthState } from './health-check.js'

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
  // 分类必须拿到 stderr——否则这里拼进去的是通用建议，而同一个 state 上的
  // errorHint 却是细分结果，两个字段对同一故障给出不同诊断。
  const classified = classifyMcpError(err, { ...context, stderr: stderrTail })
  const parts = [base]
  if (stderrTail) {
    const compact = stderrTail.replace(/\n+/g, ' | ').slice(0, 500)
    parts.push(`stderr: ${compact}`)
  }
  if (classified.suggestion) parts.push(classified.suggestion)
  return parts.join(' — ')
}

/**
 * 断连/崩溃的一句话诊断（issue #148 建议 2）。
 *
 * stdio 走分类器：stderr 决定它是环境问题、包问题还是未知，用户据此知道该改配置
 * 还是该报 bug。remote 是网络语义，不套 stderr。**空 stderr 不硬凑**——不知道就
 * 说不知道，编一个「可能是网络问题」只会把人带偏。
 */
function describeTransportLoss(transport: McpTransportType, stderrTail: string): string {
  if (transport !== 'stdio') return 'connection lost'
  const tail = stderrTail.trim()
  if (!tail) return 'server process exited (no stderr captured)'
  const classified = classifyMcpError(new Error('MCP server process exited'), {
    transport: 'stdio',
    stderr: tail,
  })
  const compact = tail.replace(/\n+/g, ' | ').slice(0, 300)
  return `server process exited; stderr: ${compact} — ${classified.suggestion}`
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
  /**
   * 正在被主动关闭的 server——重连钩子据此早退，避免 shutdown 与自己打架。
   * 用标记而不是把 transport.onclose 置空：置空会连带丢掉 Protocol 在
   * client.connect() 期间包的那层清理（reject 在途请求、翻 closed 标志），
   * 在途请求就悬挂了。标记在下一次 _connectServer 成功时清掉。
   */
  private suppressReconnect = new Set<string>()
  // Per-server reconnect attempt counter (both stdio and remote transports can drop).
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
  /**
   * 工具面变化通知——重连恢复后必须把新工具推给宿主。
   *
   * 为什么不能省：宿主侧（session-manager.injectMcpTools）是**主动推送**语义
   * ——已经有 live agent 的会话不会自己去 manager 拉工具面（只有新建 agent 才
   * 经 buildSessionStores 拉一次）。不推的话，重连的可见结果只是「状态变绿了，
   * 会话里的 mcp__* 工具依然不在」，等于白连。
   */
  private readonly onToolsChanged?: (tools: Tool[]) => void
  // Health checker for proactive monitoring (initialized in constructor)
  private healthChecker: HealthChecker

  constructor(config: McpConfig, opts: { onToolsChanged?: (tools: Tool[]) => void } = {}) {
    this.onToolsChanged = opts.onToolsChanged
    this.config = config
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS

    // Initialize health checker with config or defaults
    this.healthChecker = new HealthChecker({
      intervalMs: config.healthCheck?.intervalMs ?? 60_000,
      timeoutMs: config.healthCheck?.timeoutMs ?? 10_000,
      failureThreshold: config.healthCheck?.failureThreshold ?? 3,
      retryBackoffBaseMs: config.healthCheck?.retryBackoffBaseMs ?? 5_000,
      maxRetries: config.healthCheck?.maxRetries ?? 10,
    })
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
    // Stop all health checks first
    this.healthChecker.shutdown()

    // 抑制重连必须**先于** close：关 transport 会触发 onclose 钩子，不抑制的话
    // 钩子会把子进程重新拉起来——shutdown 反倒制造出一个新进程，把短命进程
    // （测试、CLI 的一次性连接）吊住不退出（实测：shutdown 后仍有
    // ChildProcess exitCode=null 活着 5 秒以上）。
    // 这个坑对 remote 同样存在（它的 onclose 一直是我们挂的），只是 stdio 接上
    // 重连之后才在测试里显形。
    for (const serverId of this.connections.keys()) this.suppressReconnect.add(serverId)
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

    // Stop health checks for this server
    this.healthChecker.unregister(serverId)

    const conn = this.connections.get(serverId)
    if (conn) {
      // 抑制重连用标记，而不是把 onclose 置空——置空会连带丢掉 Protocol 的
      // 清理（client.connect() 期间包的那层）。标记不在这里清：close() 之后的
      // onclose 是异步（子进程 'close' 事件）触发的，此处清掉它就等于没抑制。
      // 下一次 _connectServer 成功时会清。
      this.suppressReconnect.add(serverId)
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
                // 调用期崩掉时 stderr 是唯一能说明「为什么」的证据——PATH / 包 /
                // 未知三种根因在 err.message 上是同一句 -32000。
                stderr: server.stderrTail?.(),
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
          // issue #147 — 工作区处置：内置声明对已知 server 开箱生效（tianshu-mcp），
          // 用户配置可覆盖；策略取连接期快照（改配置后重连该 server 即生效）。
          const workspaceDeclaration = workspaceDeclarationFor(serverId, serverConfig.workspace)
          return createMcpToolWrapper(
            serverId,
            mcpDef,
            perToolCallFn,
            this.connectorConsent,
            serverConfig.policy?.tools[mcpDef.name],
            server.transportType === 'stdio' ? 'stdio' : 'remote',
            workspaceDeclaration
              ? {
                  declaration: workspaceDeclaration,
                  policy: readSubAgentWorkspacePolicy(),
                  scratchRoot: subAgentScratchRoot(),
                }
              : undefined,
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

        // Register for health monitoring after successful connection
        this.healthChecker.register(
          serverId,
          server.client,
          (sid, healthState) => this._handleHealthStateChange(sid, healthState),
        )

        return rivetTools
      } catch (err) {
        // Tool discovery failed — close the transport that was just opened
        try { await server.transport.close() } catch { /* best-effort */ }
        this.connections.delete(serverId)
        throw err
      }
    } catch (err) {
      // stderrTail 在上面 _connectServer 成功后就已取出（L259）——此前只喂给了
      // formatConnectError，没喂给分类器：于是 PATH 缺失 / 包不存在 / 缓存损坏
      // 三种根因全部回落成同一句通用提示（issue #149 要拆的正是这里）。
      const classified = classifyMcpError(err, {
        transport: transport === 'stdio' ? 'stdio' : 'remote',
        stderr: stderrTail,
      })
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

    // Register onclose handler for auto-reconnect — for BOTH transports.
    //
    // 这里曾对 stdio 短路（原注释：「stdio transport death is terminal」）。子进程
    // 退出确实是终态，但重启它并不难，而把它排除在外的代价是「一次崩溃 = 永久
    // 失效且无声」：杀掉子进程后十分钟无反应、UI 仍显示 Not connected（issue
    // #148）。重连机制本身一直是好的（remote 走通了 degraded → 重连成功），
    // 只是 stdio 从没接上它。
    //
    // 必须链式保留 prevOnclose：client.connect() 期间 Protocol 会把
    // transport.onclose 包一层（shared/protocol.js 里 `_onclose?.(); this._onclose();`
    // ——后者 reject 在途请求、翻 closed 标志）。直接覆盖等于把这套清理整段丢掉，
    // 在途请求会悬挂。这一点对 remote 同样成立，此前也是直接覆盖的。
    //
    // 新连接建立即清掉上一轮 shutdown 留下的抑制标记（否则重启后的新钩子会
    // 继承旧标记、再也不重连）。
    this.suppressReconnect.delete(serverId)
    if (process.env.RIVET_MCP_RECONNECT !== '0') {
      const prevOnclose = result.transport.onclose
      const stderrTail = result.stderrTail
      result.transport.onclose = () => {
        prevOnclose?.()
        if (this.suppressReconnect.has(serverId)) return
        this._onTransportClosed(serverId, cfg, {
          transport: result.transportType,
          stderrTail: stderrTail?.() ?? '',
        })
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
   * Auto-reconnect handler for transport disconnections — stdio 子进程退出与
   * remote 长连接断开走同一条路。指数退避 2s / 4s / 8s，至多
   * RECONNECT_MAX_ATTEMPTS 次；RIVET_MCP_RECONNECT=0 关闭。
   *
   * context 携带崩溃现场（哪个传输、stderr 尾部）。状态里光有
   * 「Reconnecting (attempt 1/3)…」不够——用户得知道**为什么**断的，否则
   * 「崩溃」与「配置写错了」在界面上长得一模一样（issue #148 建议 2）。
   */
  private _onTransportClosed(
    serverId: string,
    cfg: McpServerConfig,
    context?: { transport?: McpTransportType; stderrTail?: string },
  ): void {
    // transport 不能硬编码：stdio server 走这条路时状态里写 streamableHttp，
    // 设置页的「传输」列就显示错了。
    const transport = context?.transport ?? (cfg.command ? 'stdio' : 'streamableHttp')
    const attempts = this.reconnectAttempts.get(serverId) ?? 0
    const diag = describeTransportLoss(transport, context?.stderrTail ?? '')

    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      const current = this.states.get(serverId)
      this.states.set(serverId, {
        serverId,
        transport,
        status: 'error',
        toolCount: current?.toolCount ?? 0,
        error: `Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts — ${diag}`,
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
      transport,
      status: 'degraded',
      toolCount: current?.toolCount ?? 0,
      error: `Reconnecting (attempt ${attempts + 1}/${RECONNECT_MAX_ATTEMPTS})… — ${diag}`,
      lastConnectedAt: current?.lastConnectedAt,
      lastErrorAt: Date.now(),
    })

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(serverId)
      try {
        await this._connectAndDiscover(serverId, cfg, /*attempt*/ 0)
        // 重连成功后把工具面推给宿主：manager 这边恢复了，宿主那边的会话若还是
        // 崩之前的列表（或已清空），用户看到的仍是「工具没了」。
        this.onToolsChanged?.(this.getAllTools())
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

  /**
   * Handle health state changes from the health checker.
   * Maps health states to connection statuses and notifies UI.
   */
  private _handleHealthStateChange(serverId: string, healthState: HealthState): void {
    const current = this.states.get(serverId)
    if (!current) return

    // Map health states to connection statuses
    let newStatus: McpConnectionState['status']
    let errorMessage: string | undefined

    switch (healthState) {
      case 'healthy':
        newStatus = 'connected'
        break
      case 'degraded':
        newStatus = 'degraded'
        errorMessage = 'Health check degraded'
        break
      case 'retrying':
        newStatus = 'degraded'
        errorMessage = 'Health check retrying'
        break
      case 'failed':
        newStatus = 'error'
        errorMessage = 'Health check failed'
        break
    }

    // Update state and notify UI
    this.states.set(serverId, {
      ...current,
      status: newStatus,
      error: errorMessage ?? current.error,
      lastErrorAt: healthState === 'failed' ? Date.now() : current.lastErrorAt,
    })

    // If health recovered, notify that tools are available again
    if (healthState === 'healthy' && current.status !== 'connected') {
      this.onToolsChanged?.(this.tools)
    }
  }
}
