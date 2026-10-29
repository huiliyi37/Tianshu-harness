import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildProviderKeyRoutes } from '../config-routes-keys.js'

test('all Key-pool mutations reject managed official providers before probing or writing', async () => {
  const previous = process.env.RIVET_HOME
  const home = mkdtempSync(join(tmpdir(), 'official-key-boundary-'))
  process.env.RIVET_HOME = home
  const path = join(home, 'config.json')
  const original = JSON.stringify({ provider: { default: 'official', providers: { official: { name: 'official', auth: { type: 'tianshu-account' }, models: [{ id: 'published' }] } } } })
  writeFileSync(path, original)
  try {
    const routes = buildProviderKeyRoutes('fixture-runtime-auth')
    for (const [route, handler] of Object.entries(routes)) {
      const response = await handler({ apiKey: 'fixture-not-a-real-key', model: { id: 'published' } }, { name: 'official', keyId: 'missing', modelId: 'published' }, { authorization: 'Bearer fixture-runtime-auth' })
      assert.equal(response?.status, 403, route)
      assert.deepEqual(response.body, { error: 'official_provider_read_only' })
    }
    assert.equal(readFileSync(path, 'utf8'), original)
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
