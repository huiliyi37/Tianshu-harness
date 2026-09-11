import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildMcpProxyEnv, buildStdioChildEnv } from '../stdio-env.js'

describe('buildMcpProxyEnv', () => {
  it('无既有代理时，注入 network.proxy 到 HTTPS_PROXY/HTTP_PROXY', () => {
    const out = buildMcpProxyEnv({ PATH: '/usr/bin' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
    })
  })

  it('已有 HTTPS_PROXY 时不覆盖（用户显式配置优先）', () => {
    const out = buildMcpProxyEnv({ HTTPS_PROXY: 'http://user:8080' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {})
  })

  it('小写 https_proxy 同样视为已设置', () => {
    const out = buildMcpProxyEnv({ https_proxy: 'http://user:8080' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {})
  })

  it('已有 HTTP_PROXY 时也不再注入（与 whisper 相同的保守判定）', () => {
    const out = buildMcpProxyEnv({ HTTP_PROXY: 'http://user:8080' }, { proxy: 'http://127.0.0.1:7890' })
    assert.deepEqual(out, {})
  })

  it('noProxy 注入；已有 NO_PROXY 时不覆盖', () => {
    assert.deepEqual(
      buildMcpProxyEnv({}, { noProxy: 'localhost,127.0.0.1' }),
      { NO_PROXY: 'localhost,127.0.0.1' },
    )
    assert.deepEqual(buildMcpProxyEnv({ NO_PROXY: 'example.com' }, { noProxy: 'localhost' }), {})
  })

  it('未配置 / 空白配置 → 不注入任何键', () => {
    assert.deepEqual(buildMcpProxyEnv({}, undefined), {})
    assert.deepEqual(buildMcpProxyEnv(undefined, null), {})
    assert.deepEqual(buildMcpProxyEnv({}, { proxy: '   ', noProxy: '' }), {})
  })
})

describe('buildStdioChildEnv', () => {
  const deps = {
    execPath: '/opt/node/bin/node',
    platform: 'linux' as NodeJS.Platform,
    existsSync: () => false,
    getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
  }

  it('合并 static + dynamic env，并注入 Node 目录到 PATH 与应用代理', () => {
    const env = buildStdioChildEnv(
      { FOO: 'bar' },
      { OAUTH_TOKEN: 'tok' },
      { proxy: 'http://127.0.0.1:7890' },
      deps,
    )
    assert.equal(env.FOO, 'bar')
    assert.equal(env.OAUTH_TOKEN, 'tok')
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
    assert.equal(env.PATH, '/opt/node/bin:/usr/bin')
  })

  it('server 显式 HTTPS_PROXY 优先于应用代理设置', () => {
    const env = buildStdioChildEnv(
      { HTTPS_PROXY: 'http://explicit:3128' },
      {},
      { proxy: 'http://127.0.0.1:7890' },
      deps,
    )
    assert.equal(env.HTTPS_PROXY, 'http://explicit:3128')
    assert.equal('HTTP_PROXY' in env, false)
  })

  it('未配置代理时不产生代理键（不污染子进程环境）', () => {
    const env = buildStdioChildEnv(undefined, {}, undefined, deps)
    assert.equal('HTTPS_PROXY' in env, false)
    assert.equal('HTTP_PROXY' in env, false)
    assert.equal('NO_PROXY' in env, false)
  })
})
