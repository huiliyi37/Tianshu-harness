import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountStore } from '../account.js'
import { providerSchema } from '../../config/schema.js'
import { runOfficialModelCLI } from '../../cli/official-model-cli.js'
import { fixtureCatalog, officialFixture } from './official-model-auth.test.js'

test('a fresh upgraded CLI account discovers published models and selects a default without saved official configuration or launcher overrides', async () => {
  const fixture = await officialFixture()
  const keys = ['RIVET_HOME', 'RIVET_CONFIG_PATH', 'RIVET_OFFICIAL_GATEWAY_ORIGIN', 'RIVET_OFFICIAL_GATEWAY_ORIGINS', 'RIVET_OFFICIAL_PORTAL_ORIGIN'] as const
  const previous = keys.map(name => process.env[name])
  const originalFetch = globalThis.fetch
  const configPath = join(fixture.home, 'config.json')
  const requested: string[] = []
  try {
    process.env.RIVET_HOME = fixture.home
    process.env.RIVET_CONFIG_PATH = configPath
    for (const name of keys.slice(2)) delete process.env[name]
    const byok = providerSchema.parse({ name: 'kept-byok', userSaved: true, baseUrl: 'https://byok.invalid/v1', apiKeyEnv: 'OFFICIAL_CLI_FIXTURE_KEY', models: [{ id: 'kept-model', contextWindow: 32000, maxTokens: 4000 }] })
    const saved = { provider: { default: byok.name, providers: { [byok.name]: byok } } }
    writeFileSync(configPath, JSON.stringify(saved))
    await fixture.install('A')
    const catalog = structuredClone(fixtureCatalog)
    catalog.models[0]!.bindings[0]!.origin = 'https://tianshuharness.com'
    fixture.setOverride(path => path.endsWith('/catalog') ? { data: catalog } : undefined)
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.protocol, 'https:')
      assert.equal(['https://tianshuharness.com', 'https://account-fixture.invalid'].includes(url.origin), true)
      requested.push(url.href)
      return originalFetch(fixture.endpoint + url.pathname, init)
    }
    const listed = await runOfficialModelCLI(['model', 'list'])
    assert.equal(listed.exitCode, 0, listed.output)
    assert.match(listed.output, /tianshu-official:fixture-model · 天枢官方/)
    assert.match(listed.output, /kept-byok:kept-model/)
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), saved, 'discovery cannot rewrite saved BYOK configuration')
    assert.ok(requested.includes('https://tianshuharness.com/api/official/v2/customer/catalog'))
    const selected = await runOfficialModelCLI(['model', 'use', 'tianshu-official:fixture-model'])
    assert.equal(selected.exitCode, 0, selected.output)
    const after = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(after.agent.defaultModel, 'tianshu-official:fixture-model')
    assert.deepEqual(after.provider.providers['tianshu-official'].auth, { type: 'tianshu-account' })
    assert.equal(after.provider.providers['tianshu-official'].models[0].managed.bindingId, 'chat-1')
    for (const field of ['apiKey', 'apiKeyEnv', 'keyRef', 'keys']) assert.equal(after.provider.providers['tianshu-official'][field], undefined)
    assert.deepEqual(after.provider.providers[byok.name], byok)
    assert.equal(readFileSync(configPath, 'utf8').includes('sk-fixture-'), false)
    accountStore(fixture.home).clearAccount()
    const signedOut = await runOfficialModelCLI(['model', 'use', 'tianshu-official:fixture-model'])
    assert.equal(signedOut.exitCode, 1)
    assert.match(signedOut.output, /auth_required/)
  } finally {
    globalThis.fetch = originalFetch
    for (const [index, name] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    }
    await fixture.close()
  }
})
