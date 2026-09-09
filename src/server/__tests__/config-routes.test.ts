import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { readSecret, writeSecret } from '../../config/secrets-store.js'
import { PROVIDER_PRESETS, type ProviderPresetKey } from '../../config/provider-presets.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function writeConfig(home: string, pro: Record<string, unknown>) {
  const configPath = join(home, 'config.json')
  const cfg = {
    provider: { default: 'deepseek', providers: {} },
    pro,
  }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
}

describe('GET /config/computer-use', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('reports proRequired=true when platform supports but Pro is disabled', async () => {
    writeConfig(home, { enabled: false, features: { computerUse: false, chatGateway: false } })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/computer-use', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { available: boolean; proRequired: boolean; platform: string; permissions: unknown; grants: unknown[] }
    assert.equal(body.available, false)
    // proRequired 只在平台支持时成立；Linux 等平台不支持时两者皆 false。
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal(body.proRequired, true)
    } else {
      assert.equal(body.proRequired, false)
    }
    assert.equal(body.platform, process.platform)
    assert.equal(body.permissions, null)
  })

  it('reports available=true when platform supports and Pro is enabled', async () => {
    writeConfig(home, { enabled: true, features: { computerUse: true, chatGateway: true } })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/computer-use', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { available: boolean; proRequired: boolean; permissions: unknown; grants: unknown[] }
    // available follows platform + Pro; on unsupported platforms it stays false.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal(body.available, true)
      assert.equal(body.proRequired, false)
    } else {
      assert.equal(body.available, false)
      assert.equal(body.proRequired, false)
    }
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/computer-use', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('GET /config/vision-model', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-vision-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns null when the bridge is unset', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/vision-model', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { config: unknown }
    assert.equal(body.config, null)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/vision-model', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('PUT /config/vision-model', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-vision-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('persists a vision model config and returns it', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router(
      'PUT',
      '/config/vision-model',
      { config: { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 512 } },
      AUTH,
    )
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; config: { provider: string; model: string; maxTokens: number } }
    assert.equal(body.ok, true)
    assert.deepEqual(body.config, { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 512 })
  })

  it('clears the bridge when config is null', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    await router('PUT', '/config/vision-model', { config: { provider: 'minimax', model: 'MiniMax-M3' } }, AUTH)
    const res = await router('PUT', '/config/vision-model', { config: null }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; config: unknown }
    assert.equal(body.config, null)
  })

  it('rejects an invalid payload', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router(
      'PUT',
      '/config/vision-model',
      { config: { provider: 'minimax', maxTokens: 512 } },
      AUTH,
    )
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/vision-model', { config: null }, {})
    assert.equal(res.status, 401)
  })
})

describe('GET /config/mirrors', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-mirror-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns the default mirror config (disabled, default preset) on a fresh install', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/mirrors', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { enabled: boolean; preset: string; github: string }
    assert.equal(body.enabled, false)
    assert.equal(body.preset, 'default')
    assert.equal(body.github, 'default')
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/mirrors', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('PUT /config/mirrors', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-mirror-put-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('enables the china preset and returns the updated config', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { enabled: true, preset: 'china' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; mirrors: { enabled: boolean; preset: string } }
    assert.equal(body.ok, true)
    assert.equal(body.mirrors.enabled, true)
    assert.equal(body.mirrors.preset, 'china')
  })

  it('persists across requests (a follow-up GET sees the change)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    await router('PUT', '/config/mirrors', { enabled: true, github: 'gitcode', npm: 'taobao' }, AUTH)
    const res = await router('GET', '/config/mirrors', {}, AUTH)
    const body = res.body as { enabled: boolean; github: string; npm: string }
    assert.equal(body.enabled, true)
    assert.equal(body.github, 'gitcode')
    assert.equal(body.npm, 'taobao')
  })

  it('rejects an invalid preset value (schema validation)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { preset: 'bogus' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects an invalid github mirror enum', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { github: 'not-a-real-mirror' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/mirrors', { enabled: true }, {})
    assert.equal(res.status, 401)
  })
})

describe('GET /config/pr-defaults', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-pr-defaults-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns the default PR defaults on a fresh install', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/pr-defaults', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { mergeMethod: string; autoFix: boolean; autoMerge: boolean; ciPollSeconds: number }
    assert.equal(body.mergeMethod, 'squash')
    assert.equal(body.autoFix, false)
    assert.equal(body.autoMerge, false)
    assert.equal(body.ciPollSeconds, 10)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/pr-defaults', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('PUT /config/pr-defaults', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-pr-defaults-put-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('updates mergeMethod + toggles and returns the updated config', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { mergeMethod: 'rebase', autoFix: true }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; prDefaults: { mergeMethod: string; autoFix: boolean; autoMerge: boolean } }
    assert.equal(body.ok, true)
    assert.equal(body.prDefaults.mergeMethod, 'rebase')
    assert.equal(body.prDefaults.autoFix, true)
    assert.equal(body.prDefaults.autoMerge, false)
  })

  it('persists across requests (a follow-up GET sees the change)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    await router('PUT', '/config/pr-defaults', { mergeMethod: 'merge', ciPollSeconds: 30 }, AUTH)
    const res = await router('GET', '/config/pr-defaults', {}, AUTH)
    const body = res.body as { mergeMethod: string; ciPollSeconds: number }
    assert.equal(body.mergeMethod, 'merge')
    assert.equal(body.ciPollSeconds, 30)
  })

  it('rejects an invalid mergeMethod value (schema validation)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { mergeMethod: 'fast-forward' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects an out-of-range ciPollSeconds', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { ciPollSeconds: 1 }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/pr-defaults', { autoFix: true }, {})
    assert.equal(res.status, 401)
  })
})

describe('/config/default-domain', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-domain-routes-'))
    process.env.RIVET_HOME = home
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('GET returns the defaults (qiming pinned + keyword routing on) with the domain list', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/default-domain', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { defaultDomain: string; domainKeywordRouting: boolean; domains: { id: string; name: string }[] }
    assert.equal(body.defaultDomain, 'qiming')
    assert.equal(body.domainKeywordRouting, true)
    assert.ok(body.domains.some(d => d.id === 'tianshu'), 'domain list includes tianshu')
    assert.ok(body.domains.some(d => d.id === 'kaiyang'), 'domain list includes kaiyang')
  })

  it('PUT pins a domain and a follow-up GET sees it', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const put = await router('PUT', '/config/default-domain', { defaultDomain: 'tianshu' }, AUTH)
    assert.equal(put.status, 200)
    const res = await router('GET', '/config/default-domain', {}, AUTH)
    const body = res.body as { defaultDomain: string }
    assert.equal(body.defaultDomain, 'tianshu')
  })

  it('PUT accepts auto + keyword routing toggle', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const put = await router('PUT', '/config/default-domain', { defaultDomain: 'auto', domainKeywordRouting: false }, AUTH)
    assert.equal(put.status, 200)
    const body = put.body as { ok: boolean; defaultDomain: string; domainKeywordRouting: boolean }
    assert.equal(body.ok, true)
    assert.equal(body.defaultDomain, 'auto')
    assert.equal(body.domainKeywordRouting, false)
  })

  it('PUT rejects an unknown domain id', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/default-domain', { defaultDomain: 'not-a-domain' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('PUT rejects an empty payload', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/default-domain', {}, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/default-domain', {}, {})
    assert.equal(res.status, 401)
  })
})

// 桌面端要能自己开关自动选桥：只装桌面端的用户没有 TUI 面板可用，缺这两条路由
// 他们就只能手改 config.json。
describe('/config/vision-auto-bridge', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-vision-auto-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('defaults to off — 不替用户决定把图片发给未选中的 provider', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/vision-auto-bridge', {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { enabled: false })
  })

  it('round-trips the opt-in through PUT + GET', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const put = await router('PUT', '/config/vision-auto-bridge', { enabled: true }, AUTH)
    assert.equal(put.status, 200)
    assert.deepEqual(put.body, { ok: true, enabled: true })
    const get = await router('GET', '/config/vision-auto-bridge', {}, AUTH)
    assert.deepEqual(get.body, { enabled: true })

    const off = await router('PUT', '/config/vision-auto-bridge', { enabled: false }, AUTH)
    assert.deepEqual(off.body, { ok: true, enabled: false })
  })

  it('rejects a non-boolean payload instead of coercing it', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/vision-auto-bridge', { enabled: 'yes' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    assert.equal((await router('GET', '/config/vision-auto-bridge', {}, {})).status, 401)
    assert.equal((await router('PUT', '/config/vision-auto-bridge', { enabled: true }, {})).status, 401)
  })
})

describe('POST /config/providers model vision round-trip', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('persists supportsVision=true on an added model and returns it in the list', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const setup = await router('POST', '/config/providers', {
      providerName: 'deepseek',
      model: { id: 'vis-roundtrip', contextWindow: 128000, maxTokens: 32000, supportsVision: true },
    }, AUTH)
    assert.equal(setup.status, 200)

    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { providers: { name: string; models: { id: string; supportsVision?: boolean }[] }[] }
    const ds = body.providers.find(p => p.name === 'deepseek')!
    assert.equal(ds.models.find(m => m.id === 'vis-roundtrip')?.supportsVision, true)
  })

  it('explicit supportsVision=false on a preset vision model survives (no backfill re-fill)', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    // glm-5.2 是 preset 视觉模型：显式 false 必须写盘，且 GET 返回 false
    const setup = await router('POST', '/config/providers', {
      providerName: 'glm',
      model: { id: 'glm-5.2', contextWindow: 1000000, maxTokens: 131072, supportsVision: false },
    }, AUTH)
    assert.equal(setup.status, 200)

    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { providers: { name: string; models: { id: string; supportsVision?: boolean }[] }[] }
    const glm = body.providers.find(p => p.name === 'glm')!
    assert.equal(glm.models.find(m => m.id === 'glm-5.2')?.supportsVision, false)
  })

  it('rejects a malformed model payload', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers', {
      providerName: 'deepseek',
      model: { id: 'bad', contextWindow: -1, maxTokens: 32000 },
    }, AUTH)
    assert.equal(res.status, 400)
  })
})

describe('provider delete: preset-name deadlock', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('POST /config/providers/custom rejects built-in preset names', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/custom', {
      providerName: 'zhipu-vision',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk',
      model: { id: 'm', contextWindow: 128000, maxTokens: 32000 },
    }, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /built-in preset name/i)
  })

  it('DELETE /config/providers/:name removes a legacy custom entry whose name collides with a preset', async () => {
    // 历史死锁存量：setupCustomProvider 曾允许用预设名创建条目，删除被按名字拦截。
    // 直接写盘构造存量条目（zhipu-vision 不在 DEFAULT_CONFIG，删除后不回填）。
    const configPath = join(home, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          'zhipu-vision': {
            name: 'zhipu-vision',
            baseUrl: 'https://custom.example.com/v1',
            apiKey: 'sk-legacy',
            protocol: 'openai',
            capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
            thinking: 'enabled',
            maxTokens: 8000,
            allowProFallback: false,
            models: [{ id: 'custom-model', contextWindow: 128000, maxTokens: 8000 }],
            unsupported: [],
          },
        },
      },
      pro: {},
    }, null, 2) + '\n')

    const router = createRouter(buildConfigRoutes(TOKEN))
    const del = await router('DELETE', '/config/providers/zhipu-vision', {}, AUTH)
    assert.equal(del.status, 200)
    assert.deepEqual(del.body, { ok: true, removed: 'zhipu-vision' })

    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { providers: { name: string }[] }
    assert.equal(body.providers.find(p => p.name === 'zhipu-vision'), undefined)
  })

  it('GET /config/providers returns presetKeys for frontend name-collision validation', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const body = list.body as { presetKeys: string[] }
    assert.ok(Array.isArray(body.presetKeys))
    assert.ok(body.presetKeys.includes('deepseek'))
    assert.ok(body.presetKeys.includes('zhipu-vision'))
  })

  it('GET /config/providers sorts configured providers by recommended preset order (deepseek first)', async () => {
    // 故意用非推荐序写盘：glm → minimax → deepseek，断言响应重排为 deepseek 第一。
    const stub = {
      name: 'x',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      thinking: 'enabled',
      maxTokens: 8000,
      models: [{ id: 'm', contextWindow: 128000, maxTokens: 8000 }],
      unsupported: [],
    }
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          glm: { ...stub, name: 'glm' },
          minimax: { ...stub, name: 'minimax' },
          deepseek: { ...stub, name: 'deepseek' },
        },
      },
      pro: {},
    }, null, 2) + '\n')

    const router = createRouter(buildConfigRoutes(TOKEN))
    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const names = (list.body as { providers: { name: string }[] }).providers.map(p => p.name)
    assert.equal(names[0], 'deepseek', `deepseek 必须排第一（got ${names.join(',')}）`)
    assert.ok(names.indexOf('glm') < names.indexOf('minimax'), 'glm 应排在 minimax 前（preset 原序）')
  })

  it('DELETE /config/providers/:name still refuses the default provider', async () => {
    writeConfig(home, {})
    const router = createRouter(buildConfigRoutes(TOKEN))
    // deepseek 是默认 provider（writeConfig 的 default 字段）——default 保护仍在
    const res = await router('DELETE', '/config/providers/deepseek', {}, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /default provider/i)
  })

  it('DELETE /config/providers/:name also clears the keyRef secret from secrets.json', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          'relay-gone': {
            name: 'relay-gone',
            baseUrl: 'https://relay.example.com/v1',
            keyRef: 'relay-gone',
            protocol: 'openai',
            capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
            maxTokens: 8000,
            models: [{ id: 'm', contextWindow: 128000, maxTokens: 8000 }],
            userSaved: true,
          },
        },
      },
      pro: {},
    }, null, 2) + '\n')
    writeSecret('relay-gone', 'sk-route-delete')
    assert.equal(readSecret('relay-gone'), 'sk-route-delete')

    const router = createRouter(buildConfigRoutes(TOKEN))
    const del = await router('DELETE', '/config/providers/relay-gone', {}, AUTH)
    assert.equal(del.status, 200)
    assert.deepEqual(del.body, { ok: true, removed: 'relay-gone' })
    assert.equal(readSecret('relay-gone'), undefined)
  })
})

describe('DELETE /config/providers/:name/key — 清除 key 保留 provider', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-clearkey-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  function writeProviderConfig(providers: Record<string, unknown>) {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: { default: 'deepseek', providers },
      pro: {},
    }, null, 2) + '\n')
  }

  function keylessProvider(name: string) {
    return {
      name,
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      maxTokens: 8000,
      models: [{ id: 'm', contextWindow: 128000, maxTokens: 8000 }],
      userSaved: true,
    }
  }

  it('清除默认 provider 的 key：secret 删除、provider 保留、default 不变', async () => {
    // 首次安装形态：用户的第一个 key 落在默认 provider 上——清除必须被允许。
    writeProviderConfig({ deepseek: { ...keylessProvider('deepseek'), keyRef: 'deepseek' } })
    writeSecret('deepseek', 'sk-first-install')
    const router = createRouter(buildConfigRoutes(TOKEN))

    const res = await router('DELETE', '/config/providers/deepseek/key', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; keyStatus: { source: string; ref: string }; secretDeleted: boolean }
    assert.equal(body.ok, true)
    assert.equal(body.secretDeleted, true)
    assert.notEqual(body.keyStatus.source, 'inline')
    assert.equal(readSecret('deepseek'), undefined)

    // provider 本体仍在列表里（keyless），default 仍是 deepseek。
    const list = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(list.status, 200)
    const names = (list.body as { providers: { name: string }[] }).providers.map(p => p.name)
    assert.ok(names.includes('deepseek'))
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.equal(cfg.provider.default, 'deepseek')
  })

  it('共享 keyRef 时保留 secret，最后一个引用清除才删', async () => {
    writeProviderConfig({
      deepseek: { ...keylessProvider('deepseek'), keyRef: 'shared-key' },
      relay: { ...keylessProvider('relay'), keyRef: 'shared-key' },
    })
    writeSecret('shared-key', 'sk-shared')

    const router = createRouter(buildConfigRoutes(TOKEN))
    const first = await router('DELETE', '/config/providers/relay/key', {}, AUTH)
    assert.equal(first.status, 200)
    assert.equal((first.body as { secretDeleted: boolean }).secretDeleted, false)
    assert.equal(readSecret('shared-key'), 'sk-shared')

    const second = await router('DELETE', '/config/providers/deepseek/key', {}, AUTH)
    assert.equal(second.status, 200)
    assert.equal((second.body as { secretDeleted: boolean }).secretDeleted, true)
    assert.equal(readSecret('shared-key'), undefined)
  })

  it('provider 不存在返回 400；未授权返回 401', async () => {
    writeProviderConfig({})
    const router = createRouter(buildConfigRoutes(TOKEN))
    const missing = await router('DELETE', '/config/providers/nope/key', {}, AUTH)
    assert.equal(missing.status, 400)
    const anon = await router('DELETE', '/config/providers/nope/key', {}, {})
    assert.equal(anon.status, 401)
  })
})

describe('POST /config/providers/tunables', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  async function createCustomProvider(router: ReturnType<typeof createRouter>) {
    writeConfig(home, {})
    const res = await router('POST', '/config/providers/custom', {
      providerName: 'my-spark',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: { id: 'm1', contextWindow: 128000, maxTokens: 32000 },
      slowThinking: true,
    }, AUTH)
    assert.equal(res.status, 200)
  }

  it('updates whitelisted tunables and reports them', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    await createCustomProvider(router)

    const res = await router('POST', '/config/providers/tunables', {
      providerName: 'my-spark',
      fields: { slowThinking: false, firstByteTimeoutMs: 120_000 },
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; tunables: { slowThinking: boolean; firstByteTimeoutMs: number } }
    assert.equal(body.ok, true)
    assert.equal(body.tunables.slowThinking, false)
    assert.equal(body.tunables.firstByteTimeoutMs, 120_000)

    // 落盘生效：GET 列表透出 slowThinking（三态）
    const list = await router('GET', '/config/providers', {}, AUTH)
    const providers = (list.body as { providers: { name: string; slowThinking?: boolean }[] }).providers
    const spark = providers.find(p => p.name === 'my-spark')!
    assert.equal(spark.slowThinking, false)
  })

  it('undefined field value deletes the key (restore heuristic)', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    await createCustomProvider(router)

    const res = await router('POST', '/config/providers/tunables', {
      providerName: 'my-spark',
      fields: { slowThinking: undefined },
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { tunables: { slowThinking: unknown } }
    assert.equal(body.tunables.slowThinking, undefined)

    const list = await router('GET', '/config/providers', {}, AUTH)
    const providers = (list.body as { providers: { name: string; slowThinking?: boolean }[] }).providers
    const spark = providers.find(p => p.name === 'my-spark')!
    assert.equal('slowThinking' in spark, false, '删键后 GET 不应再透出 slowThinking')
  })

  it('null survives JSON serialization and deletes the key (transport-safe)', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    await createCustomProvider(router)

    // 真实 HTTP 传输：JSON.stringify 丢弃 undefined 属性但保留 null。
    // 前端「取消勾选 → 恢复启发式」必须以 null 编码删键，否则服务端收到空 fields
    // 静默 200 不删键（提交后审查 HIGH-1）。
    const wire = JSON.parse(JSON.stringify({ providerName: 'my-spark', fields: { slowThinking: null } }))
    const res = await router('POST', '/config/providers/tunables', wire, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { tunables: { slowThinking: unknown } }
    assert.equal(body.tunables.slowThinking, undefined)

    const list = await router('GET', '/config/providers', {}, AUTH)
    const spark = (list.body as { providers: { name: string; slowThinking?: boolean }[] }).providers.find(p => p.name === 'my-spark')!
    assert.equal('slowThinking' in spark, false)
  })

  it('undefined is dropped by JSON serialization — key stays (semantic guard)', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    await createCustomProvider(router)

    // 固化语义：undefined 属性过不了 JSON.stringify，服务端收到空 fields。
    // 若未来有人试图用 undefined 表达删键，此用例打红——删键必须显式传 null。
    const wire = JSON.parse(JSON.stringify({ providerName: 'my-spark', fields: { slowThinking: undefined } }))
    const res = await router('POST', '/config/providers/tunables', wire, AUTH)
    assert.equal(res.status, 200)
    const list = await router('GET', '/config/providers', {}, AUTH)
    const spark = (list.body as { providers: { name: string; slowThinking?: boolean }[] }).providers.find(p => p.name === 'my-spark')!
    assert.equal(spark.slowThinking, true, 'JSON 往返丢 undefined → 键必须保持（createCustomProvider 设了 true）')
  })

  it('rejects missing providerName / fields', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    writeConfig(home, {})
    const noName = await router('POST', '/config/providers/tunables', { fields: { slowThinking: true } }, AUTH)
    assert.equal(noName.status, 400)
    assert.match((noName.body as { error: string }).error, /providerName is required/)

    const noFields = await router('POST', '/config/providers/tunables', { providerName: 'deepseek' }, AUTH)
    assert.equal(noFields.status, 400)
    assert.match((noFields.body as { error: string }).error, /fields object is required/)

    const badFields = await router('POST', '/config/providers/tunables', { providerName: 'deepseek', fields: [] }, AUTH)
    assert.equal(badFields.status, 400)
  })

  it('rejects unknown fields and unknown providers with 400', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    await createCustomProvider(router)

    const unknownField = await router('POST', '/config/providers/tunables', {
      providerName: 'my-spark',
      fields: { apiKey: 'sk-x' },
    }, AUTH)
    assert.equal(unknownField.status, 400)
    assert.match((unknownField.body as { error: string }).error, /Unknown tunable field "apiKey"/)

    const unknownProvider = await router('POST', '/config/providers/tunables', {
      providerName: 'nope',
      fields: { slowThinking: true },
    }, AUTH)
    assert.equal(unknownProvider.status, 400)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/tunables', { providerName: 'deepseek', fields: { slowThinking: true } }, {})
    assert.equal(res.status, 401)
  })
})

describe('GET /config/providers — unconfigured 预设透传 keyUrl（获取 API Key 直链）', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-keyurl-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  // 不钉死「deepseek 必须出现在 unconfigured」——RIVET_HOME 指向的临时目录缺
  // config.json 时 loadConfig 会兜底读真实 ~/.rivet（开发者本机多半已配置主流
  // 预设），环境相关断言会飘。改为与预设表对照：凡出现在 unconfigured 且预设
  // 带 keyUrl 的，透传值必须与预设一致（CI 干净环境下覆盖全部预设）。
  it('静态预设的 keyUrl 原样透传；keyless / 中转站不带', async () => {
    writeConfig(home, { enabled: false, features: {} })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { unconfigured: { key: string; keyUrl?: string }[] }
    assert.ok(body.unconfigured.length > 0, 'empty providers config must surface unconfigured presets')
    const byKey = new Map(body.unconfigured.map((u) => [u.key, u]))
    for (const [key, u] of byKey) {
      const preset = PROVIDER_PRESETS[key as ProviderPresetKey]
      if (!preset) continue
      assert.equal(u.keyUrl, preset.keyUrl, `${key} keyUrl must pass through from the preset`)
    }
    // keyless（ollama）无 keyUrl 可透传——无论配置与否，预设本身不携带。
    if (byKey.has('ollama')) {
      assert.equal(byKey.get('ollama')?.keyUrl, undefined)
    }
  })
})

describe('POST /config/providers — models 批量回填（「每行一个」/ 拉取勾选导入）', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-routes-models-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('一次落盘多个模型，读回全部可见', async () => {
    writeConfig(home, { enabled: false, features: {} })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const add = await router('POST', '/config/providers', {
      providerName: 'deepseek',
      models: [
        { id: 'batch-model-a', contextWindow: 64_000, maxTokens: 8_000 },
        { id: 'batch-model-b', contextWindow: 128_000, maxTokens: 16_000 },
      ],
    }, AUTH)
    assert.equal(add.status, 200)

    const get = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(get.status, 200)
    const providers = (get.body as { providers: { name: string; models: { id: string }[] }[] }).providers
    const ds = providers.find((p) => p.name === 'deepseek')
    assert.ok(ds, 'deepseek provider must exist after batch add')
    const ids = ds.models.map((m) => m.id)
    assert.ok(ids.includes('batch-model-a'), 'batch-model-a must persist')
    assert.ok(ids.includes('batch-model-b'), 'batch-model-b must persist')
  })

  it('重复 id 合并不产生重复条目', async () => {
    writeConfig(home, { enabled: false, features: {} })
    const router = createRouter(buildConfigRoutes(TOKEN))
    await router('POST', '/config/providers', {
      providerName: 'kimi',
      models: [{ id: 'dup-model', contextWindow: 64_000, maxTokens: 8_000 }],
    }, AUTH)
    await router('POST', '/config/providers', {
      providerName: 'kimi',
      models: [{ id: 'dup-model', contextWindow: 128_000, maxTokens: 16_000 }],
    }, AUTH)

    const get = await router('GET', '/config/providers', {}, AUTH)
    const providers = (get.body as { providers: { name: string; models: { id: string; contextWindow: number }[] }[] }).providers
    const kimi = providers.find((p) => p.name === 'kimi')
    const dup = kimi?.models.filter((m) => m.id === 'dup-model') ?? []
    assert.equal(dup.length, 1, 'same id must merge, not duplicate')
    assert.equal(dup[0]?.contextWindow, 128_000, 'merge keeps the latest value')
  })

  it('非法条目整单 400——批量路径不做部分落盘', async () => {
    writeConfig(home, { enabled: false, features: {} })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers', {
      providerName: 'glm',
      models: [
        { id: 'would-partially-save', contextWindow: 64_000, maxTokens: 8_000 },
        // schema 的 id 只是 z.string()（无 min(1)），空串可过——用类型错误构造真非法项
        { id: 'bad-entry', contextWindow: 'not-a-number', maxTokens: 8_000 },
      ],
    }, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /Invalid model in models\[\]/)

    const get = await router('GET', '/config/providers', {}, AUTH)
    const providers = (get.body as { providers: { name: string; models: { id: string }[] }[] }).providers
    const glm = providers.find((p) => p.name === 'glm')
    assert.ok(!glm?.models.some((m) => m.id === 'would-partially-save'), 'rejected batch must not persist anything')
  })
})

describe('PUT /config/approval — 全局档位变更广播 hook', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-approval-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('档位落盘成功后以新档触发 onApprovalConfigChanged', async () => {
    writeConfig(home, {})
    const seen: string[] = []
    const router = createRouter(buildConfigRoutes(TOKEN, {
      onApprovalConfigChanged: (approval) => { seen.push(approval) },
    }))
    const res = await router('PUT', '/config/approval', { approval: 'dangerously-skip-permissions' }, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(seen, ['dangerously-skip-permissions'])
  })

  it('非法档位 400 时 hook 不触发；未传 hook 的调用方行为不变', async () => {
    writeConfig(home, {})
    const seen: string[] = []
    const router = createRouter(buildConfigRoutes(TOKEN, {
      onApprovalConfigChanged: (approval) => { seen.push(approval) },
    }))
    const bad = await router('PUT', '/config/approval', { approval: 'nope' }, AUTH)
    assert.equal(bad.status, 400)
    assert.equal(seen.length, 0)

    const plain = createRouter(buildConfigRoutes(TOKEN))
    const ok = await plain('PUT', '/config/approval', { approval: 'manual' }, AUTH)
    assert.equal(ok.status, 200)
  })
})

// ── POST /config/providers/test（completion 级「测试模型调用」真测）─────────
// 与 test-key（GET /models 零 token 探测）区分：本端点发最小 chat completion，
// 验证模型真能对话。probeProvider 请求打到本进程本地 http server（127.0.0.1），
// 无外部网络依赖。本地 server 校验显式 apiKey 是否真的随 completion 请求发出。
function startProbeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

function sseProbeBody(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n'
}

describe('POST /config/providers/test (completion probe)', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  let server: { baseUrl: string; close: () => Promise<void> } | undefined

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-provider-test-'))
    process.env.RIVET_HOME = home
  })

  after(async () => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('400 when provider is missing', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/test', { apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:1/v1' }, AUTH)
    assert.equal(res.status, 400)
    assert.match((res.body as { error: string }).error, /provider is required/)
  })

  it('400 when no apiKey given and provider has no stored key', async () => {
    writeConfig(home, { enabled: false })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/test', { provider: 'nope' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('runs a real minimal completion against the endpoint and reports ok', async () => {
    let seenAuth: string | undefined
    server = await startProbeServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'my-model' }, { id: 'other-model' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        seenAuth = req.headers.authorization
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sseProbeBody([JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })]))
        return
      }
      res.writeHead(404).end()
    })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/test', {
      provider: 'custom', baseUrl: server.baseUrl, apiKey: 'sk-test', protocol: 'openai', model: 'my-model',
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; completionOk: boolean; probedModel?: string; latencyMs?: number; models?: string[] }
    assert.equal(body.ok, true, 'ok 以 completionOk 为准')
    assert.equal(body.completionOk, true)
    assert.equal(body.probedModel, 'my-model')
    assert.deepEqual(body.models, ['my-model', 'other-model'])
    assert.equal(typeof body.latencyMs, 'number')
    assert.equal(seenAuth, 'Bearer sk-test', 'completion 请求应带显式 apiKey 的鉴权头')
    await server.close()
    server = undefined
  })

  it('reports ok=false when the completion endpoint rejects the key', async () => {
    server = await startProbeServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm' }] }))
        return
      }
      res.writeHead(401).end()
    })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/test', {
      provider: 'custom', baseUrl: server.baseUrl, apiKey: 'sk-bad', protocol: 'openai', model: 'm',
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; completionOk: boolean; error?: string }
    assert.equal(body.ok, false)
    assert.equal(body.completionOk, false)
    assert.ok(body.error && body.error.length > 0, '失败应带可读 error')
    await server.close()
    server = undefined
  })

  // 2026-09-09 用户反馈「能对话但测试没用」：UI 测试按钮在模型 id 输入框之前，
  // 用户只填 URL+key 就点测试；网关不实现 /models 时无模型名 → completion 无法
  // 发起 → 旧实现一律 ok:false 误报（实际对话完全可用）。
  it('ok=true + completionSkipped when no model id and gateway has no /models (URL+key verified only)', async () => {
    server = await startProbeServer((req, res) => {
      // 网关不实现 /models（自建中转常见）——404
      res.writeHead(404).end()
    })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/test', {
      provider: 'custom', baseUrl: server.baseUrl, apiKey: 'sk-live', protocol: 'openai',
      // model 未传——「只测 URL 连接」场景
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; completionOk: boolean; completionSkipped?: boolean; modelsOk: boolean; error?: string }
    assert.equal(body.completionSkipped, true, '未提供模型 id → completion 未发起')
    assert.equal(body.completionOk, false)
    assert.equal(body.modelsOk, false, '网关无 /models')
    assert.equal(body.ok, false, '/models 也失败 → 连接有效性无法验证，仍为失败')
    assert.ok(body.error && body.error.length > 0, '失败带 /models 失败原因')
    await server.close()
    server = undefined
  })

  it('ok=true + completionSkipped when no model id but /models works (connection verified)', async () => {
    server = await startProbeServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'listed-model' }] }))
        return
      }
      res.writeHead(404).end()
    })
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/test', {
      provider: 'custom', baseUrl: server.baseUrl, apiKey: 'sk-live', protocol: 'openai',
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean; completionSkipped?: boolean; modelsOk: boolean; error?: string }
    assert.equal(body.ok, true, 'URL+key 经 /models 验证 → 连接有效')
    assert.equal(body.completionSkipped, true)
    assert.equal(body.modelsOk, true)
    assert.equal(body.error, undefined, '成功路径不带 error（UI 走「未测」提示）')
    await server.close()
    server = undefined
  })

  it('vision: false suppresses the model-name vision heuristic (plain-text probe)', async () => {
    let seenContent: unknown
    server = await startProbeServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'glm-4v-flash' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          seenContent = JSON.parse(Buffer.concat(chunks).toString()).messages?.[0]?.content
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sseProbeBody([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })]))
        })
        return
      }
      res.writeHead(404).end()
    })
    const router = createRouter(buildConfigRoutes(TOKEN))
    // 模型名带视觉词 + vision:false → 必须纯文本（string content，非图片 parts 数组）
    const res = await router('POST', '/config/providers/test', {
      provider: 'custom', baseUrl: server.baseUrl, apiKey: 'sk-x', protocol: 'openai', model: 'glm-4v-flash', vision: false,
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { ok: boolean }
    assert.equal(body.ok, true)
    assert.equal(typeof seenContent, 'string', 'vision:false 压制启发 → 纯文本 content')
    await server.close()
    server = undefined
  })
})
