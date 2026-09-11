import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, saveConfig, registerProvider, setupProvider, updateProviderTunables } from '../manager.js'
import { providerSchema } from '../schema.js'

describe('provider advanced config pipeline', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-advanced-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('registerProvider persists advanced fields, surviving zero values', () => {
    registerProvider({
      providerName: 'adv-test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      models: [{ id: 'm1' }],
      advanced: { requestTimeoutMs: 120_000, maxRetries: 0, temperature: 0, proxy: 'http://127.0.0.1:7890' },
    })
    const provider = loadConfig().provider.providers['adv-test']!
    assert.equal(provider.requestTimeoutMs, 120_000)
    // !== undefined guards: 0 is legal and must survive a truthy check.
    assert.equal(provider.maxRetries, 0)
    assert.equal(provider.temperature, 0)
    assert.equal(provider.proxy, 'http://127.0.0.1:7890')
  })

  it('registerProvider without advanced leaves the fields absent', () => {
    registerProvider({
      providerName: 'plain-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
    })
    const provider = loadConfig().provider.providers['plain-test']!
    assert.equal(provider.requestTimeoutMs, undefined)
    assert.equal(provider.maxRetries, undefined)
    assert.equal(provider.temperature, undefined)
    assert.equal(provider.proxy, undefined)
  })

  it('setupProvider merges advanced onto an existing preset provider', () => {
    setupProvider({ providerName: 'deepseek', advanced: { maxRetries: 1, temperature: 0.7 } })
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.maxRetries, 1)
    assert.equal(provider.temperature, 0.7)
    // Existing preset fields untouched.
    assert.ok(provider.models.length > 0)
  })

  it('advanced fields survive a load → save → load round trip', () => {
    registerProvider({
      providerName: 'rt-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
      advanced: { maxRetries: 3 },
    })
    const cfg = loadConfig()
    saveConfig(cfg)
    assert.equal(loadConfig().provider.providers['rt-test']!.maxRetries, 3)
  })

  it('schema still strips unknown provider fields (zod default unchanged)', () => {
    registerProvider({
      providerName: 'strip-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
    })
    const cfg = loadConfig()
    ;(cfg.provider.providers['strip-test'] as Record<string, unknown>).totallyUnknownField = 'x'
    saveConfig(cfg)
    const reloaded = loadConfig().provider.providers['strip-test'] as Record<string, unknown>
    assert.equal(reloaded.totallyUnknownField, undefined)
  })

  // --- retry block (issue #75) ---

  it('persists a retry block and round-trips every nested field', () => {
    registerProvider({
      providerName: 'retry-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
      advanced: {
        retry: {
          maxTotalDurationMs: 600_000,
          backoff: { baseDelayMs: 800, maxDelayMs: 20_000, jitterRatio: 0.25 },
          overrides: { rate_limit: { maxRetries: 8, retryDelayMs: 5000 } },
          rateLimit: { requestsPerSecond: 5, burst: 10 },
        },
      },
    })
    // load → save → load: the block must survive both the schema and the writer.
    saveConfig(loadConfig())
    const retry = loadConfig().provider.providers['retry-test']!.retry
    assert.equal(retry?.maxTotalDurationMs, 600_000)
    assert.equal(retry?.backoff?.baseDelayMs, 800)
    assert.equal(retry?.backoff?.maxDelayMs, 20_000)
    assert.equal(retry?.backoff?.jitterRatio, 0.25)
    assert.equal(retry?.overrides?.rate_limit?.maxRetries, 8)
    assert.equal(retry?.overrides?.rate_limit?.retryDelayMs, 5000)
    assert.equal(retry?.rateLimit?.requestsPerSecond, 5)
    assert.equal(retry?.rateLimit?.burst, 10)
  })

  it('accepts maxRetries 20 (raised ceiling) end-to-end', () => {
    registerProvider({
      providerName: 'ceiling-ok',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
      advanced: { maxRetries: 20 },
    })
    assert.equal(loadConfig().provider.providers['ceiling-ok']!.maxRetries, 20)
  })

  it('schema rejects maxRetries 21', () => {
    const result = providerSchema.safeParse({
      name: 'ceiling-over',
      baseUrl: 'https://api.example.com/v1',
      maxRetries: 21,
    })
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.error.issues.some(issue => issue.path.join('.').includes('maxRetries')))
    }
  })

  it('schema rejects an unknown retry override category (fail loud, not silent)', () => {
    const result = providerSchema.safeParse({
      name: 'bad-cat',
      baseUrl: 'https://api.example.com/v1',
      retry: { overrides: { not_a_category: { maxRetries: 1 } } },
    })
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.error.issues.some(issue => issue.path.join('.').includes('not_a_category')))
    }
  })

  it('schema rejects a non-positive requestsPerSecond', () => {
    const result = providerSchema.safeParse({
      name: 'bad-rps',
      baseUrl: 'https://api.example.com/v1',
      retry: { rateLimit: { requestsPerSecond: 0 } },
    })
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.error.issues.some(issue => issue.path.join('.').includes('requestsPerSecond')))
    }
  })

  // --- retry through updateProviderTunables (desktop config path, issue #75) ---

  it('sets retry.rateLimit through updateProviderTunables and persists it', () => {
    registerProvider({ providerName: 'tune-retry', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm1' }] })
    updateProviderTunables('tune-retry', { retry: { rateLimit: { requestsPerSecond: 5 } } })
    const retry = loadConfig().provider.providers['tune-retry']!.retry
    assert.equal(retry?.rateLimit?.requestsPerSecond, 5)
  })

  it('merges nested retry sub-keys instead of replacing the whole block', () => {
    // 用户在 config.json 手写过 backoff（重度调参）；桌面 UI 只写 rateLimit 时，
    // 整体替换会静默吃掉 backoff——子键级合并必须保留未提及的子键。
    registerProvider({ providerName: 'tune-merge', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm1' }] })
    updateProviderTunables('tune-merge', { retry: { backoff: { baseDelayMs: 800 } } })
    updateProviderTunables('tune-merge', { retry: { rateLimit: { requestsPerSecond: 3 } } })
    const retry = loadConfig().provider.providers['tune-merge']!.retry
    assert.equal(retry?.backoff?.baseDelayMs, 800, 'untouched sub-key must survive')
    assert.equal(retry?.rateLimit?.requestsPerSecond, 3)
  })

  it('removes a retry sub-key with null and the whole block with retry: null', () => {
    registerProvider({ providerName: 'tune-del', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm1' }] })
    updateProviderTunables('tune-del', { retry: { rateLimit: { requestsPerSecond: 4 }, backoff: { baseDelayMs: 500 } } })
    updateProviderTunables('tune-del', { retry: { rateLimit: null } })
    let retry = loadConfig().provider.providers['tune-del']!.retry
    assert.equal(retry?.rateLimit, undefined)
    assert.equal(retry?.backoff?.baseDelayMs, 500, 'untouched sub-key survives a sibling delete')
    updateProviderTunables('tune-del', { retry: null })
    retry = loadConfig().provider.providers['tune-del']!.retry
    assert.equal(retry, undefined)
  })

  it('rejects an invalid nested value without writing anything', () => {
    registerProvider({ providerName: 'tune-bad', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm1' }] })
    assert.throws(
      () => updateProviderTunables('tune-bad', { retry: { rateLimit: { requestsPerSecond: 0 } } }),
      /Invalid value for "retry"/,
    )
    assert.equal(loadConfig().provider.providers['tune-bad']!.retry, undefined, 'rejected write must not persist')
  })

  // --- 递归合并：第二层及更深子键必须保留（对抗审查 F1 的判别用例）---

  it('preserves nested sub-keys inside rateLimit when only requestsPerSecond is written', () => {
    // 用户照官方文档在 config.json 手写 burst（突发额度），桌面 UI 只改
    // requestsPerSecond——合并必须递归到 rateLimit 内层，否则 burst 被静默吃掉。
    registerProvider({ providerName: 'tune-burst', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm1' }] })
    updateProviderTunables('tune-burst', { retry: { rateLimit: { requestsPerSecond: 5, burst: 10 } } })
    updateProviderTunables('tune-burst', { maxRetries: 3, retry: { rateLimit: { requestsPerSecond: 5 } } })
    const provider = loadConfig().provider.providers['tune-burst']!
    assert.equal(provider.maxRetries, 3)
    assert.equal(provider.retry?.rateLimit?.requestsPerSecond, 5)
    assert.equal(provider.retry?.rateLimit?.burst, 10, 'burst 必须保留——只改兄弟子键不得吃掉它')
  })

  it('preserves untouched override categories (recursive merge covers overrides too)', () => {
    registerProvider({ providerName: 'tune-ovr', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm1' }] })
    updateProviderTunables('tune-ovr', { retry: { overrides: { timeout: { maxRetries: 4 } } } })
    updateProviderTunables('tune-ovr', { retry: { overrides: { rate_limit: { maxRetries: 8 } } } })
    const retry = loadConfig().provider.providers['tune-ovr']!.retry
    assert.equal(retry?.overrides?.timeout?.maxRetries, 4, '未提及的类别必须保留')
    assert.equal(retry?.overrides?.rate_limit?.maxRetries, 8)
  })
})
