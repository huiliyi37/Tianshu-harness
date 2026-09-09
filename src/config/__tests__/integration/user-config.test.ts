import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { userConfigPath } from '../../paths.js'

function loadConfig() {
  const configPath = userConfigPath()
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

function hasProvider(config: any, name: string): boolean {
  return config?.provider?.providers?.[name] !== undefined
}

describe('User config validation', () => {
  const config = loadConfig()

  it('config file exists', () => {
    assert.ok(config !== null, `Config not found at ${userConfigPath()}`)
  })

  it('config has required providers', () => {
    if (!config) return
    const providers = Object.keys(config.provider.providers)
    // Minimum viable set: at least one provider configured
    assert.ok(providers.length >= 1, `expected >= 1 providers, got ${providers.length}: ${providers.join(', ')}`)
  })

  it('codex auth is null or a well-formed oauth object', () => {
    if (!hasProvider(config, 'codex')) return
    const codex = config.provider.providers.codex
    // auth is user-configurable: unconfigured (null/undefined) or oauth. Both valid.
    if (codex.auth) {
      assert.equal(codex.auth.type, 'oauth')
    }
    assert.equal(codex.protocol, 'openai')
  })

  it('minimax uses openai protocol with api-key', () => {
    if (!hasProvider(config, 'minimax')) return
    const minimax = config.provider.providers.minimax
    assert.equal(minimax.protocol, 'openai')
    assert.equal(minimax.apiKeyEnv, 'MINIMAX_API_KEY')
  })

  it('mimo uses openai protocol with api-key', () => {
    if (!hasProvider(config, 'mimo')) return
    const mimo = config.provider.providers.mimo
    assert.equal(mimo.protocol, 'openai')
    assert.equal(mimo.apiKeyEnv, 'MIMO_API_KEY')
  })

  it('worker routing maps tasks to profiles', () => {
    if (!config?.workers?.routing) return
    const { routing, profiles } = config.workers
    // Routing targets must resolve to a defined profile; profile providers
    // are user-configurable, so assert resolvability, not pinned vendor names.
    for (const target of Object.values(routing) as string[]) {
      if (target) assert.ok(profiles?.[target], `routing target '${target}' must have a matching profile`)
    }
    for (const name of Object.keys(profiles ?? {})) {
      assert.ok(profiles[name].provider, `profile '${name}' must have a provider`)
    }
  })
})
