import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpManager } from '../manager.js'
import { approveMcpServer, checkMcpServerApproval, resolveMcpApproval } from '../server-approval.js'
import type { McpServerConfig, McpConfig } from '../config.js'

// issue #215：连接级审批门与既有用例表达的「连接」语义正交。既有用例统一固定为
// headless fail-open（等价 always-approve 桩），避免「跑在 TTY 里就变红」的非确定性；
// 审批门本身由文件末尾的 issue #215 用例专门覆盖。
process.env.RIVET_MCP_APPROVAL = 'open'

function makeConfig(servers: Record<string, McpServerConfig> = {}): McpConfig {
  return { enabled: true, servers }
}

function wait(ms: number): Promise<'hung'> {
  return new Promise(resolve => setTimeout(() => resolve('hung'), ms))
}

describe('McpManager', () => {
  it('starts with no connections', () => {
    const mgr = new McpManager(makeConfig())
    assert.deepEqual(mgr.getStates(), [])
    assert.deepEqual(mgr.getAllTools(), [])
  })

  it('skip initialization when disabled', async () => {
    const mgr = new McpManager({ enabled: false, servers: {} })
    await mgr.initialize()
    assert.deepEqual(mgr.getStates(), [])
  })

  it('registers discovered tools via mock', async () => {
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo-server.js'] },
    }))

    mgr['_connectServer'] = async () => ({
      client: { listTools: async () => ({ tools: [] }) } as any,
      transport: { close: async () => {} }, transportType: 'stdio',
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => [{
      name: 'echo',
      description: 'Echo input',
      inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
    }]

    await mgr.initialize()
    const tools = mgr.getAllTools()
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.definition.name, 'mcp__echo__echo')
  })

  it('skips disabled servers', async () => {
    const mgr = new McpManager(makeConfig({
      off: { command: 'node', args: ['off.js'], disabled: true },
    }))

    let connected = false
    mgr['_connectServer'] = async () => {
      connected = true
      return { client: {} as any, transport: { close: async () => {} }, transportType: 'stdio', serverId: 'off' }
    }

    await mgr.initialize()
    assert.equal(connected, false)
  })

  it('reports connection states', async () => {
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))

    mgr['_connectServer'] = async () => ({
      client: {} as any,
      transport: { close: async () => {} }, transportType: 'stdio',
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => [{
      name: 'test', description: 'Test', inputSchema: { type: 'object' as const, properties: {} },
    }]

    await mgr.initialize()
    const states = mgr.getStates()
    assert.equal(states.length, 1)
    assert.equal(states[0]!.serverId, 'echo')
    assert.equal(states[0]!.status, 'connected')
    assert.equal(states[0]!.toolCount, 1)
  })

  it('handles connection failure gracefully', async () => {
    const mgr = new McpManager(makeConfig({
      broken: { command: 'nonexistent-binary' },
    }))

    mgr['_connectServer'] = async () => {
      throw new Error('spawn nonexistent-binary ENOENT')
    }

    await mgr.initialize()
    const states = mgr.getStates()
    assert.equal(states.length, 1)
    assert.equal(states[0]!.status, 'error')
    assert.ok(states[0]!.error!.includes('ENOENT'))
  })

  it('marks server error when tool discovery times out', async () => {
    class HangingManager extends McpManager {
      async _connectServer(serverId: string): Promise<any> {
        return {
          serverId,
          transport: { close: async () => {} }, transportType: 'stdio',
          client: { listTools: () => new Promise(() => {}) },
        }
      }
    }

    const mgr = new HangingManager({
      enabled: true,
      servers: { slow: { command: 'node', args: ['slow.js'] } },
      timeoutMs: 10,
    } as any)

    const outcome = await Promise.race([mgr.initialize().then(() => 'done' as const), wait(2000)])

    assert.equal(outcome, 'done')
    const state = mgr.getStates().find(s => s.serverId === 'slow')
    assert.equal(state?.status, 'error')
    assert.match(state?.error ?? '', /timed out/i)
  })

  it('marks connected server degraded when callTool times out', async () => {
    const mgr = new McpManager({
      enabled: true,
      servers: { slow: { command: 'node', args: ['slow.js'] } },
      timeoutMs: 10,
    } as any)

    mgr['_connectServer'] = async (serverId: string) => ({
      serverId,
      transport: { close: async () => {} }, transportType: 'stdio',
      client: {
        listTools: async () => ({ tools: [{ name: 'slowTool', description: 'Slow', inputSchema: { type: 'object' as const, properties: {} } }] }),
        callTool: () => new Promise(() => {}),
      } as any,
    })

    await mgr.initialize()
    const tool = mgr.getAllTools()[0]!
    const outcome = await Promise.race([
      tool.execute({ input: {}, toolUseId: 'mcp-call-timeout', cwd: process.cwd() }).then(result => ({ status: 'done' as const, result })),
      wait(100).then(() => ({ status: 'hung' as const })),
    ])

    assert.equal(outcome.status, 'done')
    if (outcome.status !== 'done') return
    assert.equal(outcome.result.isError, true)
    assert.match(outcome.result.content, /timed out/i)
    const state = mgr.getStates().find(s => s.serverId === 'slow')
    assert.equal(state?.status, 'degraded')
    assert.match(state?.error ?? '', /timed out/i)
  })

  it('shuts down all connections', async () => {
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))

    let closed = false
    mgr['_connectServer'] = async () => ({
      client: {} as any,
      transport: { close: async () => { closed = true } }, transportType: 'stdio',
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => []

    await mgr.initialize()
    await mgr.shutdown()
    assert.equal(closed, true)
    assert.deepEqual(mgr.getStates(), [])
  })

  it('connects to SSE server via URL config', async () => {
    let connectedUrl = ''
    let connectedHeaders: Record<string, string> = {}

    const mgr = new McpManager(makeConfig({
      remote: { url: 'http://localhost:3001/mcp', headers: { Authorization: 'Bearer test' } },
    }))

    // Override connect & discover — mock SSE connection
    mgr['_connectServer'] = async (serverId, config) => {
      if (config && 'url' in config && config.url) {
        connectedUrl = config.url
        connectedHeaders = (config as any).headers ?? {}
        return {
          client: {} as any,
          transport: { close: async () => {} }, transportType: 'stdio',
          serverId,
        }
      }
      throw new Error('not sse')
    }
    mgr['_discoverTools'] = async () => [{
      name: 'remote_tool',
      description: 'Remote tool via SSE',
      inputSchema: { type: 'object' as const, properties: {} },
    }]

    await mgr.initialize()
    assert.equal(connectedUrl, 'http://localhost:3001/mcp')
    assert.equal(connectedHeaders['Authorization'], 'Bearer test')
    assert.equal(mgr.getAllTools().length, 1)
    assert.equal(mgr.getAllTools()[0]!.definition.name, 'mcp__remote__remote_tool')
  })

  it('killChildrenSync force-kills MCP child pids and clears connections', async () => {
    // Regression guard (root-cause analysis 2026-06-05, Thread 1A): MCP children
    // are spawned by the SDK, not via process-tracker, so the exit path must
    // SIGKILL them by pid inline — the async shutdown() is abandoned by
    // process.exit before transport.close() runs.
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))
    mgr['_connectServer'] = async () => ({
      client: {} as any,
      transport: { close: async () => {}, pid: 4242 }, transportType: 'stdio',
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => []
    await mgr.initialize()

    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
    const origKill = process.kill
    // Spy on process.kill; swallow the call (pid 4242 doesn't exist).
    ;(process as any).kill = (pid: number, signal: NodeJS.Signals | number) => {
      killed.push({ pid, signal })
      return true
    }
    try {
      mgr.killChildrenSync()
    } finally {
      process.kill = origKill
    }

    // Process-group kill first (negative pid), SIGKILL.
    assert.ok(killed.some(k => k.pid === -4242 && k.signal === 'SIGKILL'), 'should SIGKILL the child process group')
    // Connections cleared so a later shutdown() is a no-op.
    assert.deepEqual([...(mgr as any).connections.keys()], [])
  })

  it('reconcileFromConfig connects servers added after init snapshot', async () => {
    const mgr = new McpManager(makeConfig())
    await mgr.initialize()
    assert.deepEqual(mgr.getStates(), [])

    mgr['_connectServer'] = async (serverId) => ({
      client: {} as any,
      transport: { close: async () => {} }, transportType: 'stdio',
      serverId,
    })
    mgr['_discoverTools'] = async () => [{
      name: 'late',
      description: 'Late tool',
      inputSchema: { type: 'object' as const, properties: {} },
    }]

    const added = await mgr.reconcileFromConfig(makeConfig({
      late: { command: 'node', args: ['late.js'] },
    }))
    assert.equal(added.length, 1)
    assert.equal(added[0]!.definition.name, 'mcp__late__late')
    assert.equal(mgr.getStates().find((s) => s.serverId === 'late')?.status, 'connected')
  })

  it('reconcileFromConfig skips already-connected servers', async () => {
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))
    let connects = 0
    mgr['_connectServer'] = async (serverId) => {
      connects++
      return { client: {} as any, transport: { close: async () => {} }, transportType: 'stdio', serverId }
    }
    mgr['_discoverTools'] = async () => []
    await mgr.initialize()
    const afterInit = connects
    await mgr.reconcileFromConfig(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))
    assert.equal(connects, afterInit)
  })

  it('folds stderr into error state on connect failure', async () => {
    const mgr = new McpManager(makeConfig({
      broken: { command: 'node', args: ['broken.js'] },
    }))
    mgr['_connectServer'] = async (serverId) => {
      const err: any = new Error('spawn failed')
      // Simulate a ConnectedServer that never succeeds — throw after attach
      throw Object.assign(err, {
        /* connect fails before return — stderr captured in real path */
      })
    }
    await mgr.initialize()
    const state = mgr.getStates().find((s) => s.serverId === 'broken')
    assert.equal(state?.status, 'error')
    assert.ok(state?.errorHint, 'should carry classifier suggestion')
    assert.ok(state?.lastErrorClass)
  })

  it('connectAndDiscover returns newly registered tools', async () => {
    const mgr = new McpManager(makeConfig())
    mgr['_connectServer'] = async (serverId) => ({
      client: {} as any,
      transport: { close: async () => {} }, transportType: 'stdio',
      serverId,
    })
    mgr['_discoverTools'] = async () => [{
      name: 't', description: 'T', inputSchema: { type: 'object' as const, properties: {} },
    }]
    const tools = await mgr.connectAndDiscover('x', { command: 'node', args: ['x.js'] })
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.definition.name, 'mcp__x__t')
  })

  it('serializes concurrent connectAndDiscover for the same serverId', async () => {
    const mgr = new McpManager(makeConfig())
    let calls = 0
    mgr['_connectServer'] = async (serverId) => {
      calls++
      await new Promise(r => setTimeout(r, 20))
      return { client: {} as any, transport: { close: async () => {} }, transportType: 'stdio', serverId }
    }
    mgr['_discoverTools'] = async () => []

    const [a, b] = await Promise.all([
      mgr.connectAndDiscover('same', { command: 'node', args: ['same.js'] }),
      mgr.connectAndDiscover('same', { command: 'node', args: ['same.js'] }),
    ])
    assert.equal(calls, 1, 'only one connect attempt should run')
    assert.equal(a.length, 0)
    assert.equal(b.length, 0)
  })

  it('releases connect lock after failure so retry can proceed', async () => {
    const mgr = new McpManager(makeConfig())
    let calls = 0
    mgr['_connectServer'] = async () => {
      calls++
      throw new Error('boom')
    }

    await mgr.connectAndDiscover('same', { command: 'node', args: ['same.js'] })
    await mgr.connectAndDiscover('same', { command: 'node', args: ['same.js'] })
    assert.equal(calls, 2)
  })
})

// ── issue #215: 连接级审批门（spawn 之前） ──────────────────────────

/** 隔离的审批 home + 强制门生效（RIVET_MCP_APPROVAL=gate）。 */
function withApprovalHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-approval-'))
  const prevHome = process.env.RIVET_HOME
  const prevMode = process.env.RIVET_MCP_APPROVAL
  process.env.RIVET_HOME = dir
  process.env.RIVET_MCP_APPROVAL = 'gate'
  return fn().finally(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevMode === undefined) delete process.env.RIVET_MCP_APPROVAL
    else process.env.RIVET_MCP_APPROVAL = prevMode
    rmSync(dir, { recursive: true, force: true })
  })
}

function mockConnectedServer(serverId: string, onSpawn?: () => void): any {
  onSpawn?.()
  return { client: {} as any, transport: { close: async () => {} }, transportType: 'stdio', serverId }
}

describe('McpManager connection-level approval gate (issue #215)', () => {
  it('未批时未 spawn，并标记 awaiting-approval + 待批列表', async () => {
    await withApprovalHome(async () => {
      const cfg = { command: 'node', args: ['evil.js'], env: { TOKEN: 'secret-value' } }
      const mgr = new McpManager(makeConfig({ evil: cfg }))
      let spawned = false
      mgr['_connectServer'] = async (serverId) => mockConnectedServer(serverId, () => { spawned = true })
      mgr['_discoverTools'] = async () => []

      await mgr.initialize()

      assert.equal(spawned, false, '未获批的 server 绝不能被 spawn')
      const state = mgr.getStates().find(s => s.serverId === 'evil')
      assert.equal(state?.status, 'awaiting-approval')
      const pending = mgr.getPendingApprovals()
      assert.equal(pending.length, 1)
      assert.equal(pending[0]!.serverId, 'evil')
      assert.equal(pending[0]!.command, 'node')
      assert.deepEqual(pending[0]!.args, ['evil.js'])
      assert.deepEqual(pending[0]!.envKeys, ['TOKEN'], '只暴露 env 键名')
      assert.ok(!JSON.stringify(pending[0]).includes('secret-value'), 'env 值必须遮蔽')
    })
  })

  it('批准后连接（指纹持久化）', async () => {
    await withApprovalHome(async () => {
      const cfg = { command: 'node', args: ['ok.js'] }
      const mgr = new McpManager(makeConfig({ ok: cfg }))
      let spawns = 0
      mgr['_connectServer'] = async (serverId) => mockConnectedServer(serverId, () => { spawns++ })
      mgr['_discoverTools'] = async () => [{
        name: 't', description: 'T', inputSchema: { type: 'object' as const, properties: {} },
      }]

      await mgr.initialize()
      assert.equal(spawns, 0)
      assert.equal(mgr.getPendingApprovals().length, 1)

      const tools = await mgr.approveServerConnection('ok', cfg)
      assert.equal(spawns, 1, '批准后应连接')
      assert.equal(tools.length, 1)
      assert.equal(mgr.getStates().find(s => s.serverId === 'ok')?.status, 'connected')
      assert.equal(mgr.getPendingApprovals().length, 0, '批准后清空待批')
    })
  })

  it('改 command 需重新审批（指纹键控，不是 serverId）', async () => {
    await withApprovalHome(async () => {
      const original = { command: 'node', args: ['a.js'] }
      approveMcpServer(original)
      assert.equal(checkMcpServerApproval(original), 'approved')
      assert.equal(checkMcpServerApproval({ command: 'node', args: ['b.js'] }), 'awaiting')
      assert.equal(checkMcpServerApproval({ command: 'evil', args: ['a.js'] }), 'awaiting')
    })
  })

  it('拒绝后保持未连接并标记 denied', async () => {
    await withApprovalHome(async () => {
      const cfg = { command: 'node', args: ['no.js'] }
      const mgr = new McpManager(makeConfig({ no: cfg }))
      let spawned = false
      mgr['_connectServer'] = async (serverId) => mockConnectedServer(serverId, () => { spawned = true })
      await mgr.initialize()

      await mgr.denyServerConnection('no', cfg)
      assert.equal(spawned, false)
      assert.equal(mgr.getStates().find(s => s.serverId === 'no')?.status, 'denied')
      assert.equal(mgr.getPendingApprovals().length, 0)

      // 拒绝后再次连接仍不 spawn（门以 store 为准）。
      await mgr.connectAndDiscover('no', cfg)
      assert.equal(spawned, false)
    })
  })

  it('headless / fail-open 路径照跑不拦', async () => {
    const prev = process.env.RIVET_MCP_APPROVAL
    process.env.RIVET_MCP_APPROVAL = 'open'
    try {
      // 无批准记录，但 headless → 直接放行。
      assert.equal(resolveMcpApproval({ command: 'node', args: ['x.js'] }), 'approved')
      const mgr = new McpManager(makeConfig({ h: { command: 'node', args: ['h.js'] } }))
      let spawned = false
      mgr['_connectServer'] = async (serverId) => mockConnectedServer(serverId, () => { spawned = true })
      mgr['_discoverTools'] = async () => []
      await mgr.initialize()
      assert.equal(spawned, true, 'headless 必须 fail-open 照跑')
      assert.equal(mgr.getStates().find(s => s.serverId === 'h')?.status, 'connected')
      assert.equal(mgr.getPendingApprovals().length, 0)
    } finally {
      if (prev === undefined) delete process.env.RIVET_MCP_APPROVAL
      else process.env.RIVET_MCP_APPROVAL = prev
    }
  })
})
