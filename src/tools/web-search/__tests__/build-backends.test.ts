import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchBackends, resolveSearchKey } from '../build-backends.js'
import type { Config, SearchConfig } from '../../../config/schema.js'

function cfg(search: Partial<SearchConfig>): Config {
  return {
    search: {
      backends: ['duckduckgo'],
      braveApiKeyEnv: 'BRAVE_API_KEY',
      tavilyApiKeyEnv: 'TAVILY_API_KEY',
      bochaApiKeyEnv: 'BOCHA_API_KEY',
      timeoutMs: 15_000,
      ...search,
    },
  } as unknown as Config
}

const noopFetch = async () => new Response('')

describe('buildSearchBackends', () => {
  it('builds the default DDG-only chain', () => {
    const backends = buildSearchBackends(cfg({ backends: ['duckduckgo'] }), { fetch: noopFetch, env: {} })
    assert.deepEqual(backends.map(b => b.name), ['duckduckgo'])
  })

  it('preserves config order for the fallback chain', () => {
    const backends = buildSearchBackends(
      cfg({ backends: ['brave', 'tavily', 'duckduckgo'] }),
      { fetch: noopFetch, env: { BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't' } },
    )
    assert.deepEqual(backends.map(b => b.name), ['brave', 'tavily', 'duckduckgo'])
  })

  it('constructs key-backed backends even without a key (availability decided later)', () => {
    const backends = buildSearchBackends(cfg({ backends: ['brave'] }), { fetch: noopFetch, env: {} })
    assert.deepEqual(backends.map(b => b.name), ['brave'])
    assert.equal(backends[0]!.isAvailable(), false, 'brave without key must report unavailable')
  })

  it('marks brave/tavily available when their env keys are present', () => {
    const backends = buildSearchBackends(
      cfg({ backends: ['brave', 'tavily'] }),
      { fetch: noopFetch, env: { BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't' } },
    )
    assert.equal(backends[0]!.isAvailable(), true)
    assert.equal(backends[1]!.isAvailable(), true)
  })

  it('constructs serply and resolves SERPLY_API_KEY', () => {
    const noKey = buildSearchBackends(cfg({ backends: ['serply', 'bing'] }), { fetch: noopFetch, env: {} })
    assert.deepEqual(noKey.map(b => b.name), ['serply', 'bing'])
    assert.equal(noKey[0]!.isAvailable(), false, 'serply without key must report unavailable')
    const withKey = buildSearchBackends(cfg({ backends: ['serply'] }), { fetch: noopFetch, env: { SERPLY_API_KEY: 's' } })
    assert.equal(withKey[0]!.isAvailable(), true)
  })

  it('respects custom env var names', () => {
    const backends = buildSearchBackends(
      cfg({ backends: ['brave'], braveApiKeyEnv: 'MY_BRAVE' }),
      { fetch: noopFetch, env: { MY_BRAVE: 'x' } },
    )
    assert.equal(backends[0]!.isAvailable(), true)
  })

  it('constructs bocha and reports availability by env key presence', () => {
    // 无 key —— 构造但不可用
    const noKey = buildSearchBackends(
      cfg({ backends: ['bocha', 'bing'] }),
      { fetch: noopFetch, env: {} },
    )
    assert.deepEqual(noKey.map(b => b.name), ['bocha', 'bing'])
    assert.equal(noKey[0]!.isAvailable(), false, 'bocha without key must report unavailable')

    // 有 key —— 可用
    const withKey = buildSearchBackends(
      cfg({ backends: ['bocha'] }),
      { fetch: noopFetch, env: { BOCHA_API_KEY: 'bk' } },
    )
    assert.equal(withKey[0]!.isAvailable(), true)

    // 自定义 env 变量名
    const custom = buildSearchBackends(
      cfg({ backends: ['bocha'], bochaApiKeyEnv: 'MY_BOCHA' }),
      { fetch: noopFetch, env: { MY_BOCHA: 'bk' } },
    )
    assert.equal(custom[0]!.isAvailable(), true)
  })

  it('skips unknown backend names', () => {
    const backends = buildSearchBackends(cfg({ backends: ['bogus', 'tavily'] }), { fetch: noopFetch, env: { TAVILY_API_KEY: 't' } })
    assert.deepEqual(backends.map(b => b.name), ['tavily'])
  })

  it('falls back to DDG when nothing valid is configured', () => {
    const backends = buildSearchBackends(cfg({ backends: ['bogus'] }), { fetch: noopFetch, env: {} })
    assert.deepEqual(backends.map(b => b.name), ['duckduckgo'])
  })
})

describe('search API key resolution (inline > apiKeyEnv > standard env)', () => {
  it('inline config key wins over env vars', () => {
    const config = cfg({
      backends: ['bocha'],
      bochaApiKey: 'sk-inline-secret',
      bochaApiKeyEnv: 'MY_BOCHA_ENV',
    })
    const env = { MY_BOCHA_ENV: 'env-value', BOCHA_API_KEY: 'standard-value' }
    assert.equal(resolveSearchKey(config, env, 'bocha'), 'sk-inline-secret')
  })

  it('falls back to apiKeyEnv-named variable when no inline key', () => {
    const config = cfg({ backends: ['brave'], braveApiKeyEnv: 'MY_BRAVE' })
    assert.equal(resolveSearchKey(config, { MY_BRAVE: 'env-value' }, 'brave'), 'env-value')
  })

  it('falls back to standard <BACKEND>_API_KEY when apiKeyEnv var missing', () => {
    // apiKeyEnv 字段存在但对应 env 没设 → 标准变量名回退
    const config = cfg({ backends: ['tavily'], tavilyApiKeyEnv: 'CUSTOM_UNSET' })
    assert.equal(resolveSearchKey(config, { TAVILY_API_KEY: 'standard' }, 'tavily'), 'standard')
  })

  it('returns undefined when no key anywhere', () => {
    const config = cfg({ backends: ['bocha'] })
    assert.equal(resolveSearchKey(config, {}, 'bocha'), undefined)
  })

  it('empty inline key string is ignored (falls through to env)', () => {
    // 空串视为未设置（UI 清空场景）
    const config = cfg({ backends: ['bocha'], bochaApiKey: '' })
    assert.equal(resolveSearchKey(config, { BOCHA_API_KEY: 'fallback' }, 'bocha'), 'fallback')
  })

  it('buildSearchBackends uses inline key → backend reports available', () => {
    const config = cfg({ backends: ['bocha'], bochaApiKey: 'sk-inline' })
    const backends = buildSearchBackends(config, { fetch: noopFetch, env: {} })
    assert.equal(backends[0]!.name, 'bocha')
    assert.equal(backends[0]!.isAvailable(), true, 'inline key should make bocha available')
  })
})
