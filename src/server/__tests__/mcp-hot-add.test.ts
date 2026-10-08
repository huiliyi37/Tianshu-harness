import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildMcpRoutes } from '../mcp-api.js'
import { McpManager } from '../../mcp/manager.js'
import type { Tool } from '../../tools/types.js'

function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-hot-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = dir
  return fn(dir).finally(() => {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

/**
 * Race: POST /mcp/servers while manager is still null must persist config
 * (so post-init reconcile can connect). Covers the old silent-skip bug.
 */
test('POST /mcp/servers persists even when manager is null (startup race)', async () => {
  await withTempHome(async () => {
    const routes = buildMcpRoutes({
      getMcpManager: () => null,
      apiToken: 'tok',
    })
    const res = await routes['POST /mcp/servers']!(
      {
        serverId: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' },
      },
      undefined,
      { authorization: 'Bearer tok' },
      undefined,
    )
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; pending?: boolean; managerReady?: boolean }
    assert.equal(body.ok, true)
    assert.equal(body.managerReady, false)
    assert.equal(body.pending, true)

    const { loadConfig } = await import('../../config/manager.js')
    const live = loadConfig().mcp
    assert.ok(live.servers['github'], 'server must be on disk')

    const mgr = new McpManager({ enabled: true, servers: {} })
    let connected = false
    mgr['_connectServer'] = async (serverId) => {
      connected = true
      return { client: {} as any, transport: { close: async () => {} }, transportType: 'stdio', serverId }
    }
    mgr['_discoverTools'] = async () => [{
      name: 'search', description: 'Search', inputSchema: { type: 'object' as const, properties: {} },
    }]
    await mgr.initialize()
    const added = await mgr.reconcileFromConfig(live)
    assert.equal(connected, true)
    assert.equal(added.length, 1)
  })
})

test('POST /mcp/servers preserves transport, auth, and tool policy config', async () => {
  await withTempHome(async () => {
    const routes = buildMcpRoutes({
      getMcpManager: () => null,
      apiToken: 'tok',
    })
    const res = await routes['POST /mcp/servers']!(
      {
        serverId: 'remote',
        url: 'https://mcp.example.com/sse',
        transportHint: 'sse',
        auth: { type: 'oauth', provider: 'github', scopes: ['repo'] },
        policy: {
          tools: {
            search: { capability: 'read' },
            mutate: { capability: 'write', requireApproval: true },
          },
        },
      },
      undefined,
      { authorization: 'Bearer tok' },
      undefined,
    )
    assert.equal(res.status, 200, JSON.stringify(res.body))

    const { loadConfig } = await import('../../config/manager.js')
    assert.deepEqual(loadConfig().mcp.servers['remote'], {
      url: 'https://mcp.example.com/sse',
      transportHint: 'sse',
      auth: { type: 'oauth', provider: 'github', scopes: ['repo'] },
      policy: {
        tools: {
          search: { capability: 'read' },
          mutate: { capability: 'write', requireApproval: true },
        },
      },
    })
  })
})

test('POST /mcp/servers hot-connects and notifies onToolsReady when manager live', async () => {
  await withTempHome(async () => {
    const mgr = new McpManager({ enabled: true, servers: {} })
    mgr['_connectServer'] = async (serverId) => ({
      client: {} as any,
      transport: { close: async () => {} }, transportType: 'stdio',
      serverId,
    })
    mgr['_discoverTools'] = async () => [{
      name: 't', description: 'T', inputSchema: { type: 'object' as const, properties: {} },
    }]

    let notified: Tool[] = []
    const routes = buildMcpRoutes({
      getMcpManager: () => mgr,
      onToolsReady: (tools) => { notified = tools },
      apiToken: 'tok',
    })
    const res = await routes['POST /mcp/servers']!(
      { serverId: 'echo', command: 'node', args: ['echo.js'] },
      undefined,
      { authorization: 'Bearer tok' },
      undefined,
    )
    assert.equal(res.status, 200)
    // Fire-and-forget connect — wait for microtask + promise settlement.
    for (let i = 0; i < 20 && notified.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(notified.length >= 1, 'onToolsReady should fire with discovered tools')
    assert.equal(notified[0]!.definition.name, 'mcp__echo__t')
  })
})

test('GET /mcp/status reports managerReady', async () => {
  const routesNull = buildMcpRoutes({ getMcpManager: () => null, apiToken: 'tok' })
  const res1 = await routesNull['GET /mcp/status']!({}, undefined, { authorization: 'Bearer tok' }, undefined)
  assert.equal((res1.body as { managerReady: boolean }).managerReady, false)

  const mgr = new McpManager({ enabled: true, servers: {} })
  const routesReady = buildMcpRoutes({ getMcpManager: () => mgr, apiToken: 'tok' })
  const res2 = await routesReady['GET /mcp/status']!({}, undefined, { authorization: 'Bearer tok' }, undefined)
  assert.equal((res2.body as { managerReady: boolean }).managerReady, true)
})

test('POST /mcp/servers rejects a relative cwd (sidecar CWD is not fixed)', async () => {
  await withTempHome(async () => {
    const routes = buildMcpRoutes({ getMcpManager: () => null, apiToken: 'tok' })
    const res = await routes['POST /mcp/servers']!(
      { serverId: 'rel-cwd', command: 'npx', args: ['-y', 'some-mcp'], cwd: 'relative/dir' },
      undefined,
      { authorization: 'Bearer tok' },
      undefined,
    )
    assert.equal(res.status, 400)
    const body = res.body as { error: string }
    assert.ok(body.error.includes('absolute'), `got: ${body.error}`)

    const { loadConfig } = await import('../../config/manager.js')
    assert.ok(!loadConfig().mcp.servers['rel-cwd'], 'rejected server must not persist')
  })
})

test('POST /mcp/servers accepts an absolute cwd', async () => {
  await withTempHome(async (home) => {
    const routes = buildMcpRoutes({ getMcpManager: () => null, apiToken: 'tok' })
    const res = await routes['POST /mcp/servers']!(
      { serverId: 'abs-cwd', command: 'npx', args: ['-y', 'some-mcp'], cwd: home },
      undefined,
      { authorization: 'Bearer tok' },
      undefined,
    )
    assert.equal(res.status, 200, JSON.stringify(res.body))
  })
})

for (const connecting of [false, true]) {
  test(`POST /mcp/servers disables a ${connecting ? 'connecting' : 'connected'} server before acknowledging`, async () => {
    await withTempHome(async () => {
      const mgr = new McpManager({ enabled: true, servers: {} })
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let closed = 0
      mgr['_connectServer'] = async serverId => {
        if (connecting) await gate
        return { client: {} as any, transport: { close: async () => { closed++ } }, transportType: 'stdio', serverId }
      }
      mgr['_discoverTools'] = async () => [{ name: 'fixture', description: 'Fictional', inputSchema: { type: 'object' as const, properties: {} } }]
      try {
        const connection = mgr.connectAndDiscover('fixture', { command: 'fictional' })
        if (!connecting) await connection
        const routes = buildMcpRoutes({ getMcpManager: () => mgr, apiToken: 'fixture-auth' })
        const disable = routes['POST /mcp/servers']!({ serverId: 'fixture', command: 'fictional', disabled: true }, undefined, { authorization: 'Bearer fixture-auth' })
        release()
        const response = await disable
        await connection
        assert.equal(response.status, 200)
        assert.equal(mgr.getConnection('fixture'), undefined)
        assert.equal(mgr.getToolsForServer('fixture').length, 0)
        assert.ok(closed > 0, 'the fictional external transport was closed')
        assert.equal((response.body as { pending: boolean }).pending, false)
        const { loadConfig } = await import('../../config/manager.js')
        assert.equal(loadConfig().mcp.servers.fixture?.disabled, true)
      } finally {
        release()
        await mgr.shutdown()
      }
    })
  })
}
