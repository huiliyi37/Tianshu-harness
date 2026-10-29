import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindConnectEndpointPolicy, persistConnectCommit, resolveConnectRuntimeSelection } from '../connect-apply.js'
import { PROVIDER_PRESETS } from '../../config/provider-presets.js'
import { registerProvider, loadConfig } from '../../config/manager.js'
import { addProviderKey } from '../../config/provider-key-store.js'
import { contractModels } from '../../config/contract-models.js'
import type { ConnectCommit } from '../connect-flow.js'

it('the CLI commit callback persists and switches through the provider-aware helpers', () => {
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.match(main, /persistConnectCommit\(commit\)/)
  assert.match(main, /resolveConnectRuntimeSelection\(commit, fresh,\s*\{\s*provider: ctx\.provider\.name, model: ctx\.agent\.config\.promptEngine\.getModel\(\)/)
  assert.match(main, /await switchPreparedAgentRuntime\(ctx, selection\.model, selection\.provider\)/)
  const bootstrap = readFileSync(new URL('../../bootstrap.ts', import.meta.url), 'utf8')
  assert.match(bootstrap, /import \{ resolveProviderForModel,.* from '\.\/bootstrap\/model-resolution\.js'/)
})

describe('connect commits across custom gateways and active providers', () => {
  let dir = ''
  let previousPath: string | undefined
  const card = (id: string) => ({ id, contextWindow: 128_000, maxTokens: 8_000 })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tianshu-connect-apply-'))
    previousPath = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    registerProvider({ providerName: 'relay-a', baseUrl: 'https://a.example.test/v1', apiKeyEnv: 'TIANSHU_TEST_RELAY_A', models: [card('shared'), card('active')] })
    registerProvider({ providerName: 'relay-b', baseUrl: 'https://b.example.test/v1', apiKeyEnv: 'TIANSHU_TEST_RELAY_B', models: [card('shared')] })
    loadConfig()
  })

  afterEach(() => {
    if (previousPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = previousPath
    rmSync(dir, { recursive: true, force: true })
  })

  const custom = (makeDefault: boolean): Extract<ConnectCommit, { mode: 'custom' }> => ({
    mode: 'custom', providerName: 'relay-b', baseUrl: 'https://b.example.test/v1', protocol: 'openai', models: [card('shared')], makeDefault,
  })

  it('reconnecting a custom gateway replaces only default-key models and credentials', () => {
    const second = addProviderKey('relay-b', { apiKey: 'fixture-secondary-key', models: [card('secondary')] })
    persistConnectCommit({ ...custom(false), mode: 'custom', updateExisting: true, apiKey: 'fixture-new-key', baseUrl: 'https://new.example.test/v1', protocol: 'anthropic', models: [card('new')] })
    const p = loadConfig().provider.providers['relay-b']!
    assert.deepEqual(contractModels(p).map(m => m.id), ['new', 'secondary'])
    assert.equal(p.protocol, 'anthropic')
    assert.equal(p.baseUrl, 'https://new.example.test/v1')
    assert.equal(p.keys!.find(k => k.id === 'default')!.keyRef, 'relay-b')
    assert.equal(p.keys!.find(k => k.id === second.id)!.keyRef, `relay-b:${second.id}`)
  })

  it('optional connection leaves an unrelated active provider untouched', () => {
    assert.equal(resolveConnectRuntimeSelection(custom(false), loadConfig(), { provider: 'relay-a', model: 'active' }), undefined)
  })

  it('default selection pins the chosen provider even when another provider has the same ID', () => {
    assert.deepEqual(resolveConnectRuntimeSelection(custom(true), loadConfig(), { provider: 'relay-a', model: 'active' }), { provider: 'relay-b', model: 'shared' })
  })

  it('add-model applies its exact new ID on the matching active provider', () => {
    const commit: ConnectCommit = { mode: 'add-model', providerName: 'relay-b', model: card('org/new:edition') }
    persistConnectCommit(commit)
    assert.deepEqual(resolveConnectRuntimeSelection(commit, loadConfig(), { provider: 'relay-b', model: 'shared' }), { provider: 'relay-b', model: 'org/new:edition' })
    assert.equal(resolveConnectRuntimeSelection(commit, loadConfig(), { provider: 'relay-a', model: 'active' }), undefined)
  })

  it('reconfiguring the active provider preserves its selected model when still available', () => {
    const commit: ConnectCommit = { mode: 'preset', setup: { providerName: 'relay-a', makeDefault: false } }
    assert.deepEqual(resolveConnectRuntimeSelection(commit, loadConfig(), { provider: 'relay-a', model: 'active' }), { provider: 'relay-a', model: 'active' })
  })
})

it('connect consent reaches preset persistence even when its default URL was not overridden', () => {
  const commit = { mode: 'preset' as const, setup: { providerName: 'ollama', preset: 'ollama' as const } }
  const dir = mkdtempSync(join(tmpdir(), 'connect-policy-')), previous = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  try {
    bindConnectEndpointPolicy(commit, PROVIDER_PRESETS.ollama.provider.baseUrl, { allowPrivateNetwork: true })
    persistConnectCommit(commit)
    assert.equal(loadConfig().provider.providers.ollama!.endpointNetworkPolicy?.allowPrivateNetwork, true)
  } finally {
    if (previous === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previous
    rmSync(dir, { recursive: true, force: true })
  }
  const app = readFileSync(new URL('../engine/app.ts', import.meta.url), 'utf8')
  assert.match(app, /bindConnectEndpointPolicy\(result.commit, commitUrl, commitUrl \? this.connectFlow\?\.endpointAccess\(commitUrl\)/)
})
