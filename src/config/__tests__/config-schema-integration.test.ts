import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { userConfigPath } from '../paths.js'
import { configSchema } from '../schema.js'
import { loadConfig } from '../manager.js'

describe('Config schema integration', () => {
  // 真实配置路径在 describe 收集期（env 设置前）捕获——前两个用例的「真实文件
  // 可解析」意图保留。loadConfig() 必须走隔离路径：它对真实配置有迁移回写
  // 副作用（2026-08-15 实证：migrateAnthropicProtocol 把 protocol:'anthropic'
  // 写进真实 config.json，dsh 旧 schema 会话 bash 全挂）。
  const configPath = userConfigPath()
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-schema-int-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json') // 不存在 → loadConfig 纯默认合并
  })
  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses full user config through Zod schema', () => {
    if (!existsSync(configPath)) return // skip if no user config
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    assert.ok(config)
    // Default provider must be one of the configured providers
    const defaultProvider = config.provider.default
    assert.ok(defaultProvider, 'default provider must be set')
    assert.ok(config.provider.providers[defaultProvider], `default provider '${defaultProvider}' not found in providers map`)
  })

  it('all configured providers parse with supported protocols', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    const providers = config.provider.providers
    for (const [name, provider] of Object.entries(providers)) {
      assert.match(provider.protocol, /^(anthropic|openai)$/, `${name} protocol should be supported`)
      assert.match(provider.baseUrl, /^https?:\/\//, `${name} baseUrl should be an HTTP(S) URL`)
      assert.ok(provider.models.length > 0, `${name} must have at least one model`)
      for (const model of provider.models) {
        assert.ok(model.contextWindow > 0, `${name}/${model.id} contextWindow must be positive`)
        assert.ok(model.maxTokens > 0, `${name}/${model.id} maxTokens must be positive`)
      }
    }
  })

  it('codex auth parsed as oauth when configured', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    const codex = config.provider.providers.codex
    if (!codex) return
    // auth is optional/nullable in the schema: either unconfigured (null/undefined)
    // or a well-formed oauth object. Both are valid; assert shape only when present.
    if (codex.auth) {
      assert.equal(codex.auth.type, 'oauth')
    }
  })

  it('workers config parsed correctly', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    // Worker profiles are user-configurable; assert structure, not pinned values.
    const profiles = config.workers.profiles
    const names = Object.keys(profiles)
    for (const name of names) {
      assert.ok(profiles[name]!.provider, `worker profile '${name}' must have a provider`)
      assert.ok(profiles[name]!.model, `worker profile '${name}' must have a model`)
    }
    // compaction is the main agent's own concern, never routed to a worker
    assert.equal(config.workers.routing.compaction, undefined)
  })

  it('resolveApiKey works for minimax with apiKeyEnv', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    // minimax uses apiKeyEnv, not apiKey
    assert.equal(config.provider.providers.minimax!.apiKeyEnv, 'MINIMAX_API_KEY')
    assert.equal(config.provider.providers.minimax!.apiKey, undefined)
  })

  it('hooks 块 parse：缺省为空对象，合法值通过，非法值拒绝', () => {
    // 缺省：hooks 恒存在且为空（loadConfig 走 DEFAULT 合并 + parse）
    const base = loadConfig()
    assert.deepEqual(base.hooks, {})

    // 合法值：在 DEFAULT 之上覆盖 hooks 块
    const withHooks = loadConfig({ sessionOverlay: { hooks: { disabled: ['dream', 'kick'], timeoutMs: 5000, slowMs: 1000 } } })
    assert.deepEqual(withHooks.hooks, { disabled: ['dream', 'kick'], timeoutMs: 5000, slowMs: 1000 })

    // 非法值：disabled 非数组 / timeoutMs 非正数
    assert.throws(() => configSchema.parse({ ...base, hooks: { disabled: 'dream' } }))
    assert.throws(() => configSchema.parse({ ...base, hooks: { timeoutMs: -1 } }))
    assert.throws(() => configSchema.parse({ ...base, hooks: { slowMs: 0 } }))
  })
})
