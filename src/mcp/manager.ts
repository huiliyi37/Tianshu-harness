import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '../tools/types.js'
import type { McpConfig, McpServerConfig } from './config.js'
import type { McpConnectionState, McpTransportType } from './types.js'
import { createMcpToolWrapper, createMcpConnectorConsent, type McpConnectorConsent } from './wrapper.js'
import {
  approveMcpServer,
  denyMcpServer,
  mcpApprovalInteractive,
  mcpServerFingerprint,
  resolveMcpApproval,
  type McpApprovalDecision,
  type McpPendingApproval,
} from './server-approval.js'
import { armInventoryApproval, evaluateInventoryGate, formatInventoryNotice, type InventoryPendingPayload } from './tool-inventory.js'
import { readSubAgentWorkspacePolicy, subAgentScratchRoot, workspaceDeclarationFor } from './workspace-policy.js'
import { classifyMcpError, describeTransportLoss } from './failure-classifier.js'
import { createTransport, StdioConnectError, type TransportResult } from './transport-factory.js'
import { LogRingBuffer } from './log-buffer.js'
import type { McpNetworkConfig } from './stdio-env.js'
import { readNetworkConfigSafe, withTimeout, formatConnectError } from './connection-utils.js'
import { HealthChecker, type HealthState } from './health-check.js'

const DEFAULT_MCP_TIMEOUT_MS = 60_000

// issue #215 — 连接级审批命中但未获批时的两个运行时状态（已登记进
// McpConnectionState['status'] 联合，消费端可类型安全地分支）。
const AWAITING_APPROVAL: McpConnectionState['status'] = 'awaiting-approval'
const APPROVAL_DENIED: McpConnectionState['status'] = 'denied'

const NETWORK_RETRY_DELAY_MS = 800
const RECONNECT_MAX_ATTEMPTS = 3
const RECONNECT_BACKOFF_BASE_MS = 2_000

// 断连诊断 describeTransportLoss 已迁至 failure-classifier.ts（沿接缝拆分，守行数红线）。

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
  private connectionGenerations = new Map<string, number>()
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
  // issue #215 — 待用户批准连接的 server（连接级审批门命中 awaiting 时登记）。
  private pendingApprovals: Map<string, McpPendingApproval> = new Map()

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

  /** issue #215 — 待批准连接的 server 列表（供 GET /mcp/status 消费）。 */
  getPendingApprovals(): McpPendingApproval[] {
    return Array.from(this.pendingApprovals.values())
  }

  /**
   * issue #215 — 连接级审批判定。委托到 server-approval.resolveMcpApproval
   * （无交互 UI 时 fail-open）。抽成方法是为了给测试一个 always-approve 桩接缝。
   * @internal Overridable for testing
   */
  _mcpApprovalDecision(cfg: McpServerConfig): McpApprovalDecision {
    return resolveMcpApproval(cfg)
  }

  /** issue #215 — 记录/清除待批登记，并把连接状态置为 awaiting-approval / denied。
   *  inventory 缺省 = 连接级审批；传入 = 清单快照门拦截（①，附加 diff 摘要）。 */
  private _recordApprovalHold(
    serverId: string,
    cfg: McpServerConfig,
    decision: 'awaiting' | 'denied',
    inventory?: InventoryPendingPayload,
  ): void {
    const transport: McpTransportType = cfg.command ? 'stdio' : 'streamableHttp'
    if (decision === 'awaiting') {
      this.pendingApprovals.set(serverId, {
        serverId,
        fingerprint: mcpServerFingerprint(cfg),
        source: cfg.command ? 'stdio' : 'remote',
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        envKeys: cfg.env ? Object.keys(cfg.env).sort() : [],
        url: cfg.url,
        reason: inventory?.reason,
        inventoryHash: inventory?.inventoryHash,
        inventoryDiff: inventory?.inventoryDiff,
        changedAt: inventory?.changedAt,
      })
    } else {
      this.pendingApprovals.delete(serverId)
    }
    this.states.set(serverId, {
      serverId,
      status: decision === 'awaiting' ? AWAITING_APPROVAL : APPROVAL_DENIED,
      transport,
      toolCount: 0,
      error: decision === 'awaiting'
        ? `MCP server "${serverId}" is awaiting approval — not started. Approve via POST /mcp/servers/${serverId}/approve`
        : `MCP server "${serverId}" was denied — not started. Re-approve to connect.`,
    })
  }

  /**
   * issue #215 — 批准某 server 的连接：持久化指纹 + 立即连接 + 返回新工具。
   * 供 REST `POST /mcp/servers/:id/approve` 使用。
   */
  async approveServerConnection(serverId: string, cfg?: McpServerConfig): Promise<Tool[]> {
    const c = cfg ?? this.config.servers[serverId]
    if (!c) return []
    approveMcpServer(c)
    // 清单门待批（①）：把「被展示的那版 hash」arm 下来——重拉精确匹配才消费放行
    // （用户批准的是他看到的版本；批准期间二次换毒拦得住，见 tool-inventory.ts）。
    const held = this.pendingApprovals.get(serverId)
    if (held?.inventoryHash) armInventoryApproval(mcpServerFingerprint(c), held.inventoryHash)
    this.pendingApprovals.delete(serverId)
    return this.connectAndDiscover(serverId, c)
  }

  /**
   * issue #215 — 拒绝某 server 的连接：持久化拒绝 + 断开已连连接 + 置 denied 状态。
   * 供 REST `POST /mcp/servers/:id/deny` 使用。
   */
  async denyServerConnection(serverId: string, cfg?: McpServerConfig): Promise<void> {
    const c = cfg ?? this.config.servers[serverId]
    if (c) denyMcpServer(c)
    await this.shutdownServer(serverId).catch(() => { /* best-effort */ })
    if (c) this._recordApprovalHold(serverId, c, 'denied')
    else this.pendingApprovals.delete(serverId)
  }

  async shutdown(): Promise<void> {
    // Stop all health checks first
    this.healthChecker.shutdown()
    for (const serverId of this.connectLocks.keys()) {
      this.connectionGenerations.set(serverId, (this.connectionGenerations.get(serverId) ?? 0) + 1)
      this.suppressReconnect.add(serverId)
    }
    await Promise.allSettled(this.connectLocks.values())

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
    this.pendingApprovals.clear()
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
        // 退出/注销路径零 spawn（issue #398）：注销阶段会话拆除中 spawn taskkill
        // 会撞 0xC0000142 加载器硬错误框阻塞关机。改为进程内直杀（TerminateProcess，
        // 不 spawn）；MCP stdio server 的孙进程在注销场景由会话拆除收余。
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch {
          try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        }
      }
    }
    this.connections.clear()
  }

  /**
   * Close a transport and deregister it — but only drop the registration once
   * the close actually succeeded. killChildrenSync() (the process-exit path)
   * discovers child pids by iterating `connections`; deleting the entry before
   * (or despite) a failed close leaves the still-running child unreachable and
   * orphaned. On close failure we keep the entry so the exit path can still
   * SIGKILL it, and suppress reconnect.
   */
  private async _closeAndDeregister(serverId: string, server: ConnectedServer): Promise<void> {
    try {
      await server.transport.close()
      this.connections.delete(serverId)
    } catch {
      // close threw — the child may still be alive; keep it registered so
      // killChildrenSync() can reap it, and don't let onclose reconnect it.
      this.suppressReconnect.add(serverId)
    }
  }

  /** Shut down a single server by id — for the REST API restart/remove flow. */
  async shutdownServer(serverId: string): Promise<void> {
    this.connectionGenerations.set(serverId, (this.connectionGenerations.get(serverId) ?? 0) + 1)
    this.suppressReconnect.add(serverId)
    const connecting = this.connectLocks.get(serverId)
    if (connecting) await connecting.catch(() => {})
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
      await this._closeAndDeregister(serverId, conn)
    }
    this.reconnectAttempts.delete(serverId)
    this.pendingApprovals.delete(serverId)
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
    if (serverConfig.disabled) return []
    const existing = this.connectLocks.get(serverId)
    if (existing) return existing

    const generation = this.connectionGenerations.get(serverId) ?? 0
    const promise = this._connectAndDiscover(serverId, serverConfig, /*attempt*/ 0, generation).finally(() => {
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
    generation: number,
  ): Promise<Tool[]> {
    const isCurrent = () => (this.connectionGenerations.get(serverId) ?? 0) === generation
    if (!isCurrent()) return []
    const transport: McpTransportType = serverConfig.command ? 'stdio' : 'streamableHttp'
    // issue #215 — 连接级审批门：拦在 **spawn 之前**。三个连接入口
    // （initialize / reconcileFromConfig / REST 热加）都经 _connectAndDiscover，
    // 因此共用这一道门；未获批时不建立连接、不拉子进程，只登记待批。
    const approval = this._mcpApprovalDecision(serverConfig)
    if (approval !== 'approved') {
      this._recordApprovalHold(serverId, serverConfig, approval)
      return []
    }
    // 已获批 → 清掉可能残留的待批登记（先 awaiting、后 approve 的路径）。
    this.pendingApprovals.delete(serverId)
    this.states.set(serverId, {
      serverId,
      status: 'connecting',
      transport,
      toolCount: 0,
    })

    let stderrTail = ''
    try {
      const server = await this._connectServer(serverId, serverConfig)
      if (!isCurrent()) {
        this.suppressReconnect.add(serverId)
        // 子进程已 spawn 但 generation 过期——close 失败时把它登记进 connections
        // （而非放任孤儿），让退出路径的 killChildrenSync 仍能回收。
        try {
          await server.transport.close()
        } catch {
          this.connections.set(serverId, server)
        }
        return []
      }
      stderrTail = server.stderrTail?.() ?? ''
      this.connections.set(serverId, server)

      try {
        // Drop prior tools for this server (restart / re-reconcile path).
        const prefix = `mcp__${serverId}__`
        this.tools = this.tools.filter((t) => !t.definition.name.startsWith(prefix))

        const mcpTools = await this._discoverTools(serverId, server)
        if (!isCurrent()) {
          this.suppressReconnect.add(serverId)
          await this._closeAndDeregister(serverId, server)
          return []
        }

        // 清单快照门（rug pull 防线 ①，见 tool-inventory.ts）：注册前 diff——变更在
        // gate 宿主拦截待批（断开+不注册）；fail-open 宿主放行 + 变更标记（③）。
        const inventory = evaluateInventoryGate({
          fingerprint: mcpServerFingerprint(serverConfig),
          serverId,
          tools: mcpTools,
          interactive: mcpApprovalInteractive(),
        })
        if (inventory.action === 'block') {
          this.suppressReconnect.add(serverId) // 防 close→onclose→自动重连→再拦 循环
          await this._closeAndDeregister(serverId, server)
          this._recordApprovalHold(serverId, serverConfig, 'awaiting', inventory.pending)
          return []
        }
        const inventoryNotice = inventory.changed
          ? formatInventoryNotice(inventory.changed.diff, inventory.changed.changedAt)
          : undefined

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
            inventoryNotice,
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
        await this._closeAndDeregister(serverId, server)
        throw err
      }
    } catch (err) {
      if (!isCurrent()) return []
      if (err instanceof StdioConnectError) {
        stderrTail = err.stderrTail
        if (stderrTail) this.logBuffers.get(serverId)?.push({ ts: Date.now(), stream: 'stderr', text: stderrTail })
      }
      const classified = classifyMcpError(err, {
        transport: transport === 'stdio' ? 'stdio' : 'remote',
        stderr: stderrTail,
      })
      // One automatic backoff retry for transient/network failures.
      if (classified.retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS))
        return this._connectAndDiscover(serverId, serverConfig, attempt + 1, generation)
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
        } else {
          // fail-closed：`auth.oauth` 声明了 token 来源，token 缺失/过期时必须在发起
          // 请求**之前**失败。此前这里静默跳过鉴权注入、把裸请求发出去——用户看到的
          // 是服务端的 "missing required Authorization header"，排查方向被带偏到命令
          // /网络，而真正该做的是重新授权。
          throw new Error(
            `OAuth token for MCP server "${serverId}" is missing or expired — `
            + `re-authorize this server (run \`/mcp auth ${serverId}\`, or reconnect from settings)`,
          )
        }
      } else {
        // 同一不变量：声明了 auth.oauth 就必须能解析出凭据来源。provider 未注册时
        // 同样不发裸请求（否则与 token 缺失一样静默裸连）。
        throw new Error(
          `MCP server "${serverId}" declares OAuth provider "${cfg.auth.provider}" `
          + `but no such provider is registered — fix the server's auth.provider config`,
        )
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
        await this.connectAndDiscover(serverId, cfg)
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
