import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { refreshServeContext, resolveModelSpec, resolveServeContext, type ServeContext } from '../serve.js'
import { readSecret, writeSecret } from '../../config/secrets-store.js'

/**
 * 「key 不热生效」修复回归钉：
 *  A. provider :name 路由参数 percent-decode（前端 encodeURIComponent，中文自定义名）。
 *  B. provider/密钥写盘后 onProviderConfigChanged → refreshServeContext 原地刷新
 *     启动快照——替换 key / inline 压 env 对新解析即刻生效。
 */

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// 与 serve-switch-model.test.ts 同纪律：标准 env 不得泄漏进测试 provider。
const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_API_KEY

function stubProvider(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    baseUrl: 'https://api.example.com/v1',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    maxTokens: 8000,
    models: [{ id: 'm', contextWindow: 128000, maxTokens: 8000 }],
    userSaved: true,
    ...extra,
  }
}

describe('provider :name percent-decode', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-decode-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  function writeProviders(providers: Record<string, unknown>) {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: { default: 'deepseek', providers },
      pro: {},
    }, null, 2) + '\n')
  }

  it('DELETE /config/providers/:name 命中 percent-encoded 中文名', async () => {
    writeProviders({ '我的': stubProvider('我的') })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const del = await router('DELETE', `/config/providers/${encodeURIComponent('我的')}`, {}, AUTH)
    assert.equal(del.status, 200)
    assert.deepEqual(del.body, { ok: true, removed: '我的' })
    const list = await router('GET', '/config/providers', {}, AUTH)
    const names = (list.body as { providers: { name: string }[] }).providers.map(p => p.name)
    assert.ok(!names.includes('我的'))
  })

  it('POST /config/providers/:name/key 命中 percent-encoded 中文名', async () => {
    writeProviders({ '我的': stubProvider('我的') })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', `/config/providers/${encodeURIComponent('我的')}/key`, { apiKey: 'sk-cjk-1' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; keyStatus: { source: string } }
    assert.equal(body.ok, true)
    assert.equal(body.keyStatus.source, 'inline')
    assert.equal(readSecret('我的'), 'sk-cjk-1')
  })

  it('非法 % 序列 fail-open 回原值（400 而非崩溃）', async () => {
    writeProviders({})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('DELETE', '/config/providers/100%zz', {}, AUTH)
    assert.equal(res.status, 400)
  })
})

describe('provider 配置写盘后的启动快照热刷新', () => {
  const prevHome = process.env.RIVET_HOME
  const prevEnvKey = process.env.HOT_RELOAD_TEST_KEY
  let home: string
  let ctx: ServeContext

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-refresh-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevEnvKey === undefined) delete process.env.HOT_RELOAD_TEST_KEY
    else process.env.HOT_RELOAD_TEST_KEY = prevEnvKey
    if (ORIGINAL_DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_API_KEY
    rmSync(home, { recursive: true, force: true })
  })

  function writeConfigRaw(config: Record<string, unknown>) {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n')
  }

  function writeProviders(providers: Record<string, unknown>) {
    writeConfigRaw({ provider: { default: 'deepseek', providers }, pro: {} })
  }

  function routerWithRefresh() {
    return createRouter(buildConfigRoutes(TOKEN, { onProviderConfigChanged: () => refreshServeContext(ctx) }))
  }

  it('替换默认 provider 的 key：写盘后快照物化值与新解析即刻为新 key', async () => {
    writeProviders({
      deepseek: { keyRef: 'deepseek', models: [{ id: 'ds-m', contextWindow: 128000, maxTokens: 8000 }] },
    })
    writeSecret('deepseek', 'sk-OLD')
    ctx = resolveServeContext()
    assert.equal(ctx.apiKey, 'sk-OLD')
    assert.equal(resolveModelSpec(ctx, 'ds-m')?.apiKey, 'sk-OLD')

    const res = await routerWithRefresh()('POST', '/config/providers/deepseek/key', { apiKey: 'sk-NEW' }, AUTH)
    assert.equal(res.status, 200)
    assert.equal(ctx.apiKey, 'sk-NEW', 'ctx.apiKey（默认 provider 快照 key）应为新值')
    assert.equal(ctx.config.provider.providers['deepseek']?.apiKey, 'sk-NEW', '快照 config 物化 apiKey 应为新值')
    assert.equal(resolveModelSpec(ctx, 'ds-m')?.apiKey, 'sk-NEW', '快照命中路径应返回新 key（刷新前返回 sk-OLD）')
  })

  it('env 存在的 provider 保存 inline key 后：快照物化值压过 env（倒挂修复）', async () => {
    process.env.HOT_RELOAD_TEST_KEY = 'sk-env-old'
    writeProviders({
      deepseek: { keyRef: 'deepseek', models: [{ id: 'ds-m', contextWindow: 128000, maxTokens: 8000 }] },
      relaytest: stubProvider('relaytest', { apiKeyEnv: 'HOT_RELOAD_TEST_KEY', models: [{ id: 'rt-m', contextWindow: 128000, maxTokens: 8000 }] }),
    })
    writeSecret('deepseek', 'sk-OLD')
    ctx = resolveServeContext()
    assert.equal(resolveModelSpec(ctx, 'rt-m')?.apiKey, 'sk-env-old', '刷新前：无 keyRef → env 命中')

    const res = await routerWithRefresh()('POST', '/config/providers/relaytest/key', { apiKey: 'sk-inline-new' }, AUTH)
    assert.equal(res.status, 200)
    assert.equal(
      resolveModelSpec(ctx, 'rt-m')?.apiKey,
      'sk-inline-new',
      'inline 保存后快照物化 apiKey 应先于 env 命中（刷新前返回 sk-env-old）',
    )
    delete process.env.HOT_RELOAD_TEST_KEY
  })

  it('清除 key 触发刷新：快照同步失 key，resolveModelSpec 转 miss', async () => {
    writeProviders({
      deepseek: { keyRef: 'deepseek', models: [{ id: 'ds-m', contextWindow: 128000, maxTokens: 8000 }] },
    })
    writeSecret('deepseek', 'sk-OLD')
    ctx = resolveServeContext()
    assert.equal(resolveModelSpec(ctx, 'ds-m')?.apiKey, 'sk-OLD')

    const res = await routerWithRefresh()('DELETE', '/config/providers/deepseek/key', {}, AUTH)
    assert.equal(res.status, 200)
    assert.equal(ctx.configured, false, '默认 provider 失 key 后 configured 翻 false')
    assert.equal(resolveModelSpec(ctx, 'ds-m'), null, '清 key 后快照解析应 miss（刷新前仍命中 sk-OLD）')
  })

  it('快照刷新 fail-open：默认 provider 悬空时变更端点仍 200，ctx 保持旧快照', async () => {
    writeProviders({ relaytest: stubProvider('relaytest') })
    ctx = resolveServeContext()
    const prevProviderName = ctx.provider.name
    // default 悬空（'ghost' 不在 DEFAULT_CONFIG 也不在 providers）→ resolveServeContext 必抛。
    writeConfigRaw({ provider: { default: 'ghost', providers: { relaytest: stubProvider('relaytest') } }, pro: {} })

    const res = await routerWithRefresh()('POST', '/config/providers/relaytest/key', { apiKey: 'sk-x' }, AUTH)
    assert.equal(res.status, 200, '刷新失败不得让已落盘的变更端点失败')
    assert.equal(ctx.provider.name, prevProviderName, '刷新失败时 ctx 保持旧快照')
    assert.equal(readSecret('relaytest'), 'sk-x', '变更本身已落盘')
  })
})
