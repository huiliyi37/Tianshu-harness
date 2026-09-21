/**
 * PR-3 多 key 服务端契约：/config/providers/:name/keys* 与 ProviderListItem.keys。
 *
 * 契约形状按原实现：POST /keys 必须真探测（无绕过开关），每个变更路由都回带
 * `keys` 全量池供客户端重渲染；label 由 PUT .../key 的 label/labelClear 承载，
 * 模型增删是 key 级而非 provider 级。
 *
 * 探测路径不 mock 中间层——起一个本地 http server，真的走 probeProvider 的
 * /models 请求，断言请求头里的 Authorization 确实是那把 key。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { loadConfig } from '../../config/manager.js'
import { readSecret, writeSecret } from '../../config/secrets-store.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }
// 非预设名：'relay' 是内置预设 key，会被 migratePresetModelBackfill 回流模型，
// 掩盖本用例真正要测的 keys 语义。
const RELAY = 'acme-relay'

interface RouterResult { status: number; body: unknown }
type Router = (method: string, path: string, body: unknown, headers: Record<string, string>) => Promise<RouterResult>

interface KeyListItem {
  id: string
  label?: string
  keyStatus: { source: string; ref: string }
  models: Array<{ id: string }>
}

function writeConfig(home: string, providers: Record<string, unknown>, defaultName: string): void {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ provider: { default: defaultName, providers } }, null, 2) + '\n',
  )
  // A′ 后 keys 池的权威源是 provider-keys.json——每个用例重建 config.json 时必须
  // 同时清掉 keys 文件，否则上一个用例落下的池会跨用例存活（隔离假设随落盘形态更新）。
  rmSync(join(home, 'provider-keys.json'), { force: true })
}

function startModelsServer(goodKey: string): Promise<{
  baseUrl: string
  seenAuth: () => string | undefined
  close: () => Promise<void>
}> {
  let seen: string | undefined
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/v1/models') {
        seen = req.headers.authorization
        if (seen !== `Bearer ${goodKey}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid key' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'probing-model-a' }, { id: 'probing-model-b' }] }))
        return
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        seenAuth: () => seen,
        close: () => new Promise((done) => {
          server.close(() => done())
          server.closeAllConnections()
        }),
      })
    })
  })
}

describe('multi-key server contract', () => {
  const prevHome = process.env.RIVET_HOME
  let home = ''
  let server: Awaited<ReturnType<typeof startModelsServer>> | undefined
  let router: Router

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-multikey-routes-'))
    process.env.RIVET_HOME = home
  })

  after(async () => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  })

  // 每个用例起的 models server 就地关闭：beforeEach 会把引用重置为 undefined，
  // 旧 server 从此不可达——泄漏的 listening handle 会让文件级进程不退出
  // （node:test 判 pending，runner 看门狗 fail-closed 判红，2026-09-13 实测复现）。
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** 每次重建 router——config 走 loadConfig()，必须读的是本用例刚写下的文件。
   *  baseUrl 默认指向本用例起的探测 server；未起 server 的用例落黑洞端口，
   *  任何「本不该发网」的路径失效都会以 network-error 暴露。 */
  function withProvider(provider: Record<string, unknown>, defaultName = RELAY): void {
    const baseUrl = server?.baseUrl ?? 'http://127.0.0.1:1/v1'
    writeConfig(home, { [RELAY]: { name: RELAY, baseUrl, protocol: 'openai', ...provider } }, defaultName)
    router = createRouter(buildConfigRoutes(TOKEN)) as Router
  }

  beforeEach(() => {
    server = undefined
    writeConfig(home, { [RELAY]: { name: RELAY, baseUrl: 'http://127.0.0.1:1/v1' } }, RELAY)
    router = createRouter(buildConfigRoutes(TOKEN)) as Router
  })

  function keysOf(body: unknown): KeyListItem[] {
    return (body as { keys: KeyListItem[] }).keys
  }

  it('reports the migrated key pool on GET /config/providers', async () => {
    writeSecret(RELAY, 'sk-legacy-7788')
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }, { id: 'legacy-b' }] })
    const res = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(res.status, 200)
    const listed = (res.body as { providers: Array<Record<string, unknown>> }).providers.find(p => p.name === RELAY)!
    const keys = listed.keys as KeyListItem[]
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.id, 'default')
    assert.deepEqual(keys[0]!.models.map(m => m.id), ['legacy-a', 'legacy-b'])
    assert.deepEqual(keys[0]!.keyStatus, { source: 'inline', ref: '***7788' })
    // 顶层 models 走 contractModels（= keys 池）——两条口径一致
    assert.deepEqual((listed.models as Array<{ id: string }>).map(m => m.id), ['legacy-a', 'legacy-b'])
  })

  // M5 三层之②（合并收口）：keys 池的模型视图必须透出 supportsImageGen——投影丢旗标
  // 会让桌面端 keys 分支的过滤永远不触发（字段根本没下发），生图模型混进主会话列表。
  it('keys 池模型视图透出 supportsImageGen（M5 三层在 keys 路径不丢旗标）', async () => {
    writeConfig(home, {
      [RELAY]: {
        name: RELAY,
        baseUrl: 'http://127.0.0.1:1/v1',
        keys: [
          {
            id: 'default',
            models: [
              { id: 'flux-pro', supportsImageGen: true },
              { id: 'qwen-8b' },
            ],
          },
        ],
        models: [],
      },
    }, RELAY)
    router = createRouter(buildConfigRoutes(TOKEN)) as Router

    const res = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(res.status, 200)
    const listed = (res.body as { providers: Array<Record<string, unknown>> }).providers.find(p => p.name === RELAY)!
    const keys = listed.keys as Array<{ models: Array<Record<string, unknown>> }>
    const flux = keys[0]!.models.find(m => m.id === 'flux-pro')
    assert.equal(flux?.['supportsImageGen'], true, 'keys 池路径必须透出 supportsImageGen（M5 三层之②）')
    const qwen = keys[0]!.models.find(m => m.id === 'qwen-8b')
    assert.equal(qwen?.['supportsImageGen'], undefined, '普通模型不虚标该旗标')
  })

  it('does not invent a key pool for a provider the user never configured', async () => {
    withProvider({ models: [{ id: 'preset-a' }] })
    const res = await router('GET', '/config/providers', {}, AUTH)
    const listed = (res.body as { providers: Array<Record<string, unknown>> }).providers.find(p => p.name === RELAY)!
    assert.deepEqual(listed.keys, [], '无用户凭证 → 无 keys 池，消费端回退顶层')
    assert.deepEqual((listed.models as Array<{ id: string }>).map(m => m.id), ['preset-a'])
  })

  it('adds a key through a real /models probe and returns the whole pool', async () => {
    server = await startModelsServer('sk-second-key')
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }] })
    writeSecret(RELAY, 'sk-first-key')

    const res = await router('POST', `/config/providers/${RELAY}/keys`, {
      apiKey: 'sk-second-key',
      label: '备用号',
      models: [{ id: 'explicit-model' }],
    }, AUTH)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const body = res.body as { ok: boolean; key: { id: string; keyStatus: unknown; models: Array<{ id: string }> }; keys: KeyListItem[] }
    assert.equal(body.ok, true)
    assert.equal(server.seenAuth(), 'Bearer sk-second-key', '探测请求必须带上新 key')
    // models 由前端显式给定，不把探测到的全部 descriptors 落盘
    assert.deepEqual(body.key.models.map(m => m.id), ['explicit-model'])
    assert.deepEqual(keysOf(body).map(k => k.id), ['default', body.key.id])
    assert.equal(keysOf(body)[1]!.label, '备用号')
    assert.equal(readSecret(`${RELAY}:${body.key.id}`), 'sk-second-key')
  })

  it('refuses to add a key whose probe fails, and writes nothing', async () => {
    server = await startModelsServer('sk-right-key')
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }] })
    writeSecret(RELAY, 'sk-first-key')

    const res = await router('POST', `/config/providers/${RELAY}/keys`, { apiKey: 'sk-wrong-key' }, AUTH)
    assert.equal(res.status, 400)
    assert.match(JSON.stringify(res.body), /auth|401|invalid/i)
    assert.equal(loadConfig().provider.providers[RELAY]!.keys!.length, 1, '探测失败不得落库')
  })

  it('validates the add-key payload', async () => {
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }] })
    const blank = await router('POST', `/config/providers/${RELAY}/keys`, { apiKey: '  ' }, AUTH)
    assert.equal(blank.status, 400)
    const noProvider = await router('POST', '/config/providers/nope/keys', { apiKey: 'sk-x' }, AUTH)
    assert.equal(noProvider.status, 404)
  })

  it('deletes a key and its unshared secret, but keeps the last one', async () => {
    server = await startModelsServer('sk-second')
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }] })
    writeSecret(RELAY, 'sk-first-key')
    const added = await router('POST', `/config/providers/${RELAY}/keys`, { apiKey: 'sk-second' }, AUTH)
    const id = (added.body as { key: { id: string } }).key.id

    const removed = await router('DELETE', `/config/providers/${RELAY}/keys/${id}`, {}, AUTH)
    assert.equal(removed.status, 200)
    const body = removed.body as { id: string; secretDeleted: boolean; keys: KeyListItem[] }
    assert.equal(body.id, id)
    assert.equal(body.secretDeleted, true)
    assert.deepEqual(keysOf(body).map(k => k.id), ['default'])
    assert.equal(readSecret(`${RELAY}:${id}`), undefined)

    const last = await router('DELETE', `/config/providers/${RELAY}/keys/default`, {}, AUTH)
    assert.equal(last.status, 400)
    assert.match(String((last.body as { error: string }).error), /last key/)
  })

  it('keeps a secret still referenced by another provider', async () => {
    writeSecret('shared-ref', 'sk-shared')
    writeConfig(home, {
      [RELAY]: {
        name: RELAY,
        baseUrl: 'http://127.0.0.1:1/v1',
        keys: [{ id: 'k1', keyRef: 'shared-ref', models: [] }, { id: 'k2', models: [] }],
        models: [],
      },
      relay2: { name: 'relay2', baseUrl: 'http://127.0.0.1:1/v1', keyRef: 'shared-ref' },
    }, RELAY)
    router = createRouter(buildConfigRoutes(TOKEN)) as Router

    const res = await router('DELETE', `/config/providers/${RELAY}/keys/k1`, {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { secretDeleted: boolean; keyRefSharedWith: string[] }
    assert.equal(body.secretDeleted, false)
    assert.ok(body.keyRefSharedWith.includes('relay2'), `expected relay2 in ${JSON.stringify(body.keyRefSharedWith)}`)
    assert.equal(readSecret('shared-ref'), 'sk-shared')
  })

  it('rotates a key credential through a real probe and rejects a failing one', async () => {
    server = await startModelsServer('sk-rotated')
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }] })
    writeSecret(RELAY, 'sk-first-key')

    const res = await router('PUT', `/config/providers/${RELAY}/keys/default/key`, { apiKey: 'sk-rotated' }, AUTH)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(readSecret(RELAY), 'sk-rotated')
    assert.equal(server.seenAuth(), 'Bearer sk-rotated')
    assert.equal((res.body as { key: KeyListItem }).key.keyStatus.source, 'inline')

    const failed = await router('PUT', `/config/providers/${RELAY}/keys/default/key`, { apiKey: 'sk-stale' }, AUTH)
    assert.equal(failed.status, 400)
    assert.equal(readSecret(RELAY), 'sk-rotated', '探测失败不得覆盖已有凭据')
  })

  it('sets and clears a key label through the credential route', async () => {
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }] })
    const set = await router('PUT', `/config/providers/${RELAY}/keys/default/key`, { label: ' 工作号 ' }, AUTH)
    assert.equal(set.status, 200, JSON.stringify(set.body))
    assert.equal((set.body as { key: KeyListItem }).key.label, '工作号')
    const cleared = await router('PUT', `/config/providers/${RELAY}/keys/default/key`, { label: '' }, AUTH)
    assert.equal((cleared.body as { key: KeyListItem }).key.label, undefined)
    const empty = await router('PUT', `/config/providers/${RELAY}/keys/default/key`, {}, AUTH)
    assert.equal(empty.status, 400)
  })

  it('adds models key-scoped (single and bulk) and rejects duplicates', async () => {
    writeConfig(home, {
      [RELAY]: {
        name: RELAY,
        baseUrl: 'http://127.0.0.1:1/v1',
        keys: [{ id: 'default', models: [] }, { id: 'k2', models: [] }],
        models: [],
      },
    }, RELAY)
    router = createRouter(buildConfigRoutes(TOKEN)) as Router

    const single = await router('POST', `/config/providers/${RELAY}/keys/k2/models`, { model: { id: 'one' } }, AUTH)
    assert.equal(single.status, 200, JSON.stringify(single.body))
    assert.deepEqual((single.body as { added: string[] }).added, ['one'])
    const bulk = await router('POST', `/config/providers/${RELAY}/keys/k2/models`, { models: [{ id: 'two' }, { id: 'three' }] }, AUTH)
    assert.deepEqual((bulk.body as { added: string[] }).added, ['two', 'three'])
    assert.deepEqual(keysOf(bulk.body)[1]!.models.map(m => m.id), ['one', 'two', 'three'])
    assert.deepEqual(keysOf(bulk.body)[0]!.models, [], '另一个 key 不受影响')

    const dup = await router('POST', `/config/providers/${RELAY}/keys/k2/models`, { model: { id: 'one' } }, AUTH)
    assert.equal(dup.status, 400)
    assert.match(String((dup.body as { error: string }).error), /already exists/)
    const missing = await router('POST', `/config/providers/${RELAY}/keys/k2/models`, {}, AUTH)
    assert.equal(missing.status, 400)
  })

  it('批量新增整单校验：含冲突项时整批不落盘（no partial write）', async () => {
    writeConfig(home, {
      [RELAY]: {
        name: RELAY,
        baseUrl: 'http://127.0.0.1:1/v1',
        keys: [{ id: 'k2', models: [{ id: 'existing' }] }],
        models: [],
      },
    }, RELAY)
    router = createRouter(buildConfigRoutes(TOKEN)) as Router

    const mixed = await router('POST', `/config/providers/${RELAY}/keys/k2/models`, {
      models: [{ id: 'existing' }, { id: 'brand-new' }],
    }, AUTH)
    assert.equal(mixed.status, 400)
    assert.match(String((mixed.body as { error: string }).error), /already exists/)
    assert.deepEqual(
      loadConfig().provider.providers[RELAY]!.keys![0]!.models.map(m => m.id),
      ['existing'],
      '冲突批次不得部分落盘 brand-new',
    )

    const intraDup = await router('POST', `/config/providers/${RELAY}/keys/k2/models`, {
      models: [{ id: 'twice' }, { id: 'twice' }],
    }, AUTH)
    assert.equal(intraDup.status, 400)
    assert.deepEqual(
      loadConfig().provider.providers[RELAY]!.keys![0]!.models.map(m => m.id),
      ['existing'],
      '批内重复同样整批拒绝、零落盘',
    )
  })

  it('upserts and deletes a model within the addressed key only', async () => {
    writeConfig(home, {
      [RELAY]: {
        name: RELAY,
        baseUrl: 'http://127.0.0.1:1/v1',
        keys: [
          { id: 'default', models: [{ id: 'k1-a' }, { id: 'k1-b' }] },
          { id: 'k2', models: [{ id: 'k2-a', contextWindow: 1000 }, { id: 'k2-b' }] },
        ],
        models: [{ id: 'k1-a' }, { id: 'k1-b' }],
      },
    }, RELAY)
    router = createRouter(buildConfigRoutes(TOKEN)) as Router

    const upsert = await router('PUT', `/config/providers/${RELAY}/keys/k2/models/k2-a`, { model: { id: 'k2-a', contextWindow: 262144 } }, AUTH)
    assert.equal(upsert.status, 200, JSON.stringify(upsert.body))
    const cfg = loadConfig().provider.providers[RELAY]!
    assert.equal(cfg.keys![1]!.models.find(m => m.id === 'k2-a')!.contextWindow, 262144)
    assert.deepEqual(cfg.keys![0]!.models.map(m => m.id), ['k1-a', 'k1-b'], '另一个 key 不受影响')
    // 顶层是迁移快照：key 级编辑不回写它
    assert.deepEqual(cfg.models.map(m => m.id), ['k1-a', 'k1-b'])

    const mismatch = await router('PUT', `/config/providers/${RELAY}/keys/k2/models/k2-b`, { model: { id: 'other' } }, AUTH)
    assert.equal(mismatch.status, 400)

    const removed = await router('DELETE', `/config/providers/${RELAY}/keys/k2/models/k2-a`, {}, AUTH)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.deepEqual(keysOf(removed.body)[1]!.models.map(m => m.id), ['k2-b'])
    const unknown = await router('DELETE', `/config/providers/${RELAY}/keys/nope/models/k1-a`, {}, AUTH)
    assert.equal(unknown.status, 400)
  })

  it('still gates every new route behind the bearer token', async () => {
    withProvider({ keyRef: RELAY, models: [{ id: 'legacy-a' }] })
    const res = await router('POST', `/config/providers/${RELAY}/keys`, { apiKey: 'sk-x' }, {})
    assert.equal(res.status, 401)
  })
})
