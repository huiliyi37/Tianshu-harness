import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildMcpRoutes, detectStrippedProjectMcp } from '../mcp-api.js'

function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = dir
  return fn(dir).finally(() => {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

const AUTH = { authorization: 'Bearer tok' }

/** Seed a config with one stdio server + one url server, return the routes. */
async function setupWithServers() {
  const routes = buildMcpRoutes({ getMcpManager: () => null, apiToken: 'tok' })
  const add = (body: Record<string, unknown>) =>
    routes['POST /mcp/servers']!(body, undefined, AUTH, undefined)
  const r1 = await add({ serverId: 'local', command: 'npx', args: ['-y', '@x/server', 'C:\\My Documents\\dir'], env: { KEY: 'val' } })
  const r2 = await add({ serverId: 'remote', url: 'https://mcp.example.com/sse', transportHint: 'sse' })
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  return routes
}

test('GET /mcp/servers/:id returns the full stored config (issue #63 edit prefill)', async () => {
  await withTempHome(async () => {
    const routes = await setupWithServers()
    const res = await routes['GET /mcp/servers/:id']!({}, { id: 'local' }, AUTH, undefined)
    assert.equal(res.status, 200)
    const body = res.body as {
      serverId: string
      command?: string
      args?: string[]
      env?: Record<string, string>
    }
    assert.equal(body.serverId, 'local')
    assert.equal(body.command, 'npx')
    // args round-trip exactly — the edit form re-joins this into one line
    assert.deepEqual(body.args, ['-y', '@x/server', 'C:\\My Documents\\dir'])
    assert.deepEqual(body.env, { KEY: 'val' })

    const res2 = await routes['GET /mcp/servers/:id']!({}, { id: 'remote' }, AUTH, undefined)
    assert.equal(res2.status, 200)
    const body2 = res2.body as { serverId: string; url?: string; transportHint?: string }
    assert.equal(body2.url, 'https://mcp.example.com/sse')
    assert.equal(body2.transportHint, 'sse')
  })
})

test('GET /mcp/servers/:id returns 404 for an unknown id', async () => {
  await withTempHome(async () => {
    const routes = await setupWithServers()
    const res = await routes['GET /mcp/servers/:id']!({}, { id: 'nope' }, AUTH, undefined)
    assert.equal(res.status, 404)
  })
})

test('GET /mcp/servers/:id is auth-gated (fail-closed)', async () => {
  await withTempHome(async () => {
    const routes = await setupWithServers()
    const res = await routes['GET /mcp/servers/:id']!({}, { id: 'local' }, {}, undefined)
    assert.equal(res.status, 401)
  })
})

// ── 项目信任门剥离的可见性（终端用户反馈「MCP 全都没了」但 UI 无解释）──────

/** 在临时目录造一个带 mcp.servers 的项目配置，并在给定信任态下回调。 */
async function withProjectConfig(
  servers: Record<string, unknown> | undefined,
  trusted: boolean,
  fn: (projectDir: string) => void | Promise<void>,
): Promise<void> {
  await withTempHome(async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'untrusted-mcp-proj-'))
    writeFileSync(
      join(projectDir, '.rivet-config.json'),
      JSON.stringify(servers === undefined ? { agent: { approval: 'auto' } } : { mcp: { enabled: true, servers } }),
    )
    const prev = process.env.RIVET_TRUST_PROJECT
    process.env.RIVET_TRUST_PROJECT = trusted ? '1' : '0'
    try {
      await fn(projectDir)
    } finally {
      if (prev === undefined) delete process.env.RIVET_TRUST_PROJECT
      else process.env.RIVET_TRUST_PROJECT = prev
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
}

test('detectStrippedProjectMcp：未授信项目 + 项目级 MCP → 报出实情（含条数与路径）', async () => {
  await withProjectConfig(
    { local: { command: 'npx' }, remote: { url: 'https://mcp.example.com/sse' } },
    false,
    (projectDir) => {
      const hit = detectStrippedProjectMcp(projectDir)
      assert.ok(hit, '未授信项目里的项目级 MCP 被剥离时必须报出，否则 UI 只能是空列表')
      assert.equal(hit.serverCount, 2)
      assert.ok(hit.projectPath.endsWith('.rivet-config.json'), `projectPath 应指向项目配置：${hit.projectPath}`)
    },
  )
})

test('detectStrippedProjectMcp：已授信项目 → null（配置正常生效，无需提示）', async () => {
  await withProjectConfig(
    { local: { command: 'npx' } },
    true,
    (projectDir) => {
      assert.equal(detectStrippedProjectMcp(projectDir), null)
    },
  )
})

test('detectStrippedProjectMcp：项目配置里没有 mcp 段 → null（无可剥离内容）', async () => {
  await withProjectConfig(undefined, false, (projectDir) => {
    assert.equal(detectStrippedProjectMcp(projectDir), null)
  })
})

test('detectStrippedProjectMcp：没有项目配置 → null', async () => {
  await withTempHome(async () => {
    const bare = mkdtempSync(join(tmpdir(), 'no-project-config-'))
    try {
      assert.equal(detectStrippedProjectMcp(bare), null)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

test('GET /mcp/status 带上 configStripped 字段（桌面端据此解释空列表）', async () => {
  await withProjectConfig(
    { local: { command: 'npx' } },
    false,
    async (projectDir) => {
      const routes = buildMcpRoutes({ getMcpManager: () => null, apiToken: 'tok' })
      // cwd 走 query 传入——sidecar 进程的 cwd 未必是用户项目。
      const res = await routes['GET /mcp/status']!({}, { cwd: projectDir }, AUTH, undefined)
      assert.equal(res.status, 200)
      const body = res.body as { configStripped?: { serverCount: number } | null }
      assert.ok(body.configStripped, '未授信项目下应带上剥离实情')
      assert.equal(body.configStripped.serverCount, 1)
    },
  )
})
