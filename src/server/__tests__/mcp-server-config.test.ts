import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildMcpRoutes } from '../mcp-api.js'

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
