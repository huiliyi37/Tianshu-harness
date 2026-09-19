import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getFetchConfig, setFetchConfig, getSearchConfig, setSearchConfig, setSearchApiKey, getSearchKeyStatus } from '../manager.js'
import { readSecret, secretsPath } from '../secrets-store.js'
import { resolveSearchKey } from '../../tools/web-search/build-backends.js'
import type { Config } from '../schema.js'

describe('fetch config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-fetch-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getFetchConfig returns defaults when unset', () => {
    const cfg = getFetchConfig()
    assert.equal(cfg.timeoutMs, 15000)
    assert.equal(cfg.maxResponseBytes, 10485760)
    assert.equal(cfg.maxRedirects, 5)
    assert.equal(cfg.userAgent, 'Tianshu/1.0 (terminal coding agent)')
    assert.equal(cfg.extractMainContent, true)
  })

  it('persists custom timeout and round-trips', () => {
    const r = setFetchConfig({ timeoutMs: 30000 })
    assert.equal(r.timeoutMs, 30000)
    assert.equal(loadConfig().fetch.timeoutMs, 30000)
    assert.equal(getFetchConfig().timeoutMs, 30000)
  })

  it('merge: partial update preserves other fields', () => {
    setFetchConfig({ timeoutMs: 30000 })
    const r = setFetchConfig({ userAgent: 'TestAgent/2.0' })
    assert.equal(r.timeoutMs, 30000, 'timeoutMs should survive partial update')
    assert.equal(r.userAgent, 'TestAgent/2.0')
  })

  it('persists multiple fields at once', () => {
    const r = setFetchConfig({ timeoutMs: 10000, extractMainContent: false, userAgent: 'MyBot/1.0' })
    assert.equal(r.timeoutMs, 10000)
    assert.equal(r.extractMainContent, false)
    assert.equal(r.userAgent, 'MyBot/1.0')
  })

  it('empty/whitespace string clears optional fields', () => {
    setFetchConfig({ userAgent: 'MyBot/1.0' })
    const cleared = setFetchConfig({ userAgent: '' })
    // Clearing a field with a schema default resets it to the default, not undefined
    assert.equal(cleared.userAgent, 'Tianshu/1.0 (terminal coding agent)', 'should revert to default')
  })

  it('empty object is a no-op (not an error on the server route layer)', () => {
    const before = getFetchConfig()
    const r = setFetchConfig({})
    assert.deepEqual(r, before)
  })
})

describe('search config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-search-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getSearchConfig returns defaults when unset', () => {
    const cfg = getSearchConfig()
    assert.deepEqual(cfg.backends, ['bing', 'duckduckgo'])
    assert.equal(cfg.timeoutMs, 15000)
    assert.equal(cfg.braveApiKeyEnv, 'BRAVE_API_KEY')
    assert.equal(cfg.tavilyApiKeyEnv, 'TAVILY_API_KEY')
  })

  it('persists custom backends and round-trips', () => {
    const r = setSearchConfig({ backends: ['duckduckgo'] })
    assert.deepEqual(r.backends, ['duckduckgo'])
    assert.deepEqual(loadConfig().search.backends, ['duckduckgo'])
    assert.deepEqual(getSearchConfig().backends, ['duckduckgo'])
  })

  it('merge: partial update preserves other fields', () => {
    setSearchConfig({ backends: ['duckduckgo'] })
    const r = setSearchConfig({ timeoutMs: 30000 })
    assert.deepEqual(r.backends, ['duckduckgo'], 'backends should survive partial update')
    assert.equal(r.timeoutMs, 30000)
  })

  it('persists region when set', () => {
    const r = setSearchConfig({ region: 'zh-CN' })
    assert.equal(r.region, 'zh-CN')
  })

  it('empty/whitespace string clears optional fields', () => {
    setSearchConfig({ region: 'zh-CN' })
    const cleared = setSearchConfig({ region: '' })
    // Region is optional; clearing it resets to '' (matches NetworkConfig.proxy pattern)
    assert.equal(cleared.region, '')
    assert.equal(loadConfig().search.region, undefined)
  })

  it('empty object is a no-op', () => {
    const before = getSearchConfig()
    const r = setSearchConfig({})
    assert.deepEqual(r, before)
  })
})

describe('search API key (inline storage + masked status)', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-search-key-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    delete process.env.BOCHA_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.TAVILY_API_KEY
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('setSearchApiKey persists inline key and getSearchKeyStatus masks it', () => {
    const status = setSearchApiKey('bocha', 'sk-bocha-secret-12345')
    assert.equal(status.source, 'inline')
    assert.equal(status.ref, '***2345', 'should mask all but last 4 chars')
    // 持久化进 config
    assert.equal(loadConfig().search.bochaApiKey, 'sk-bocha-secret-12345')
    // getSearchKeyStatus 也返回掩码
    assert.equal(getSearchKeyStatus('bocha').source, 'inline')
    assert.equal(getSearchKeyStatus('bocha').ref, '***2345')
  })

  it('getSearchConfig never returns plaintext key (only keyStatus mask)', () => {
    setSearchApiKey('bocha', 'sk-plaintext-leak-test')
    const snap = getSearchConfig()
    // snapshot 不应有明文字段（key 只经 setSearchApiKey 写，不经 snapshot 读出）
    assert.equal((snap as unknown as Record<string, unknown>).bochaApiKey, undefined)
    // keyStatus 掩码存在
    const bochaStatus = snap.keyStatus.bocha!
    assert.equal(bochaStatus.source, 'inline')
    assert.match(bochaStatus.ref, /\*\*\*/)
  })

  it('empty key clears inline value', () => {
    setSearchApiKey('brave', 'sk-brave-key')
    assert.equal(loadConfig().search.braveApiKey, 'sk-brave-key')
    setSearchApiKey('brave', '')
    assert.equal(loadConfig().search.braveApiKey, undefined)
    assert.equal(getSearchKeyStatus('brave').source, 'none')
  })

  it('env-based key shows source:env with variable name', () => {
    process.env.BOCHA_API_KEY = 'env-provided-key'
    const status = getSearchKeyStatus('bocha')
    assert.equal(status.source, 'env')
    assert.equal(status.ref, 'BOCHA_API_KEY')
  })

  it('setSearchApiKey rejects non-keyed backends', () => {
    assert.throws(
      () => setSearchApiKey('bing', 'some-key'),
      /does not support API key/,
    )
    assert.throws(
      () => setSearchApiKey('duckduckgo', 'some-key'),
      /does not support API key/,
    )
  })

  it('setSearchConfig refuses to write inline *ApiKey fields (security filter)', () => {
    // 通用 PUT 端点不能写入明文 key —— 只能走 setSearchApiKey 专用端点
    setSearchConfig({ bochaApiKey: 'should-be-ignored' } as Record<string, unknown>)
    assert.equal(loadConfig().search.bochaApiKey, undefined, 'inline key must not leak through setSearchConfig')
  })

  it('setSearchConfig refuses to write *KeyRef fields (no secret repointing)', () => {
    setSearchConfig({ bochaKeyRef: 'provider:whatever' } as Record<string, unknown>)
    assert.equal(loadConfig().search.bochaKeyRef, undefined, 'keyRef must not be settable via generic endpoint')
  })
})

describe('search API key secrets-store migration (#220)', () => {
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-search-secret-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
    delete process.env.BOCHA_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.TAVILY_API_KEY
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  function rawConfig(): Record<string, any> {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  }

  it('new write: key goes to secrets.json, config.json keeps only the keyRef (no plaintext)', () => {
    const status = setSearchApiKey('bocha', 'sk-bocha-secret-12345')
    assert.equal(status.source, 'inline')
    assert.equal(status.ref, '***2345')

    const raw = rawConfig()
    assert.equal(raw.search.bochaApiKey, undefined, 'plaintext key must not be persisted')
    assert.equal(raw.search.bochaKeyRef, 'search:bocha', 'config.json must keep the keyRef pointer')

    const configText = readFileSync(configPath, 'utf-8')
    assert.ok(!configText.includes('sk-bocha-secret-12345'), 'config.json must not contain the raw key')

    assert.ok(existsSync(secretsPath()), 'secrets.json must be created')
    const secretsText = readFileSync(secretsPath(), 'utf-8')
    assert.ok(!secretsText.includes('sk-bocha-secret-12345'), 'secrets.json is an AES-256-GCM envelope, not the raw key')

    // 仍然能读回：loadConfig 按 keyRef 物化 + resolveSearchKey 经 keyRef 解析
    assert.equal(loadConfig().search.bochaApiKey, 'sk-bocha-secret-12345')
    assert.equal(resolveSearchKey(loadConfig(), {}, 'bocha'), 'sk-bocha-secret-12345')
  })

  it('legacy plaintext config is readable and migrated on first read (no key loss)', () => {
    // 升级前的 config.json：搜索 key 明文写在前端
    writeFileSync(configPath, JSON.stringify({ search: { bochaApiKey: 'legacy-plain-9876' } }, null, 2))

    const cfg = loadConfig()
    // 读取时明文照常可读 —— 升级后 key 不丢
    assert.equal(cfg.search.bochaApiKey, 'legacy-plain-9876')
    assert.equal(getSearchKeyStatus('bocha').source, 'inline')
    assert.equal(getSearchKeyStatus('bocha').ref, '***9876')

    // 首次读取即迁移：config.json 只留 keyRef，secret 落盘可复核
    const raw = rawConfig()
    assert.equal(raw.search.bochaApiKey, undefined, 'plaintext must be removed after migration')
    assert.equal(raw.search.bochaKeyRef, 'search:bocha')
    assert.equal(readSecret('search:bocha'), 'legacy-plain-9876', 'secret must hold the migrated key')
  })

  it('env-var path is unaffected by migration (no secret written)', () => {
    process.env.BOCHA_API_KEY = 'env-key-4321'
    const status = getSearchKeyStatus('bocha')
    assert.equal(status.source, 'env')
    assert.equal(status.ref, 'BOCHA_API_KEY')
    assert.equal(readSecret('search:bocha'), undefined, 'env path must not create a search secret')
    assert.equal(resolveSearchKey(loadConfig(), process.env, 'bocha'), 'env-key-4321')
  })

  it('clearing the key removes both the secret and the keyRef', () => {
    setSearchApiKey('bocha', 'sk-to-clear')
    assert.equal(readSecret('search:bocha'), 'sk-to-clear')
    setSearchApiKey('bocha', '')
    assert.equal(rawConfig().search.bochaKeyRef, undefined, 'keyRef must be cleared')
    assert.equal(readSecret('search:bocha'), undefined, 'secret must be reclaimed')
    assert.equal(getSearchKeyStatus('bocha').source, 'none')
  })

  it('resolveSearchKey resolves a keyRef pointer straight from secrets.json (unmaterialized config)', () => {
    setSearchApiKey('brave', 'sk-brave-ref-only')
    // 构造只带 keyRef、无物化 apiKey 的 Config（等价于磁盘形状，绕过 loadConfig 物化）
    const base = loadConfig().search
    const refOnly = { search: { ...base, braveApiKey: undefined } } as unknown as Config
    assert.equal(resolveSearchKey(refOnly, {}, 'brave'), 'sk-brave-ref-only')
  })
})
