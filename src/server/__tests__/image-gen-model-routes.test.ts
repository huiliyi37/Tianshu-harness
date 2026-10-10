import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { loadConfig } from '../../config/manager.js'
import { getImageGenModelConfig } from '../../config/image-gen-model.js'

// 1×1 透明 PNG。
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const TOKEN = 'image-gen-route-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let home = ''
let upstream: ReturnType<typeof createServer>
let baseUrl = ''
let generationCount = 0
let sawSizeField: string | undefined
let upstreamFails = false

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'rivet-image-gen-routes-'))
  process.env.RIVET_CONFIG_PATH = join(home, 'config.json')
  upstream = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/images/generations')) {
      generationCount += 1
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const payload = JSON.parse(body) as Record<string, unknown>
      // 记住用的是哪个尺寸字段名——这正是 SiliconFlow 与 OpenAI 的分歧点。
      sawSizeField = Object.hasOwn(payload, 'image_size') ? 'image_size' : (Object.hasOwn(payload, 'size') ? 'size' : undefined)
      if (upstreamFails) {
        res.statusCode = 429
        res.end(JSON.stringify({ message: 'TPM limit reached.' }))
        return
      }
      // 用 b64 形状：url 形状会让客户端再发一次下载请求，而这里只关心「真测确实
      // 发了一次生图请求」。images[].url 的解析已由 client 单元测试覆盖。
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

after(async () => {
  delete process.env.RIVET_CONFIG_PATH
  await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  rmSync(home, { recursive: true, force: true })
})

test('image-gen routes require auth', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const res = await router('GET', '/config/image-gen-model', undefined, {})
  assert.equal(res.status, 401)
})

test('GET returns null when the slot is unset (fail-closed baseline)', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const res = await router('GET', '/config/image-gen-model', undefined, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { config: unknown }).config, null)
})

test('onboard registers a dedicated provider and selects it, without touching the default', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const defaultBefore = loadConfig().provider.default
  const defaultModelBefore = loadConfig().agent.defaultModel

  const res = await router('POST', '/config/image-gen-model/onboard', {
    providerName: 'imagegen-route',
    baseUrl,
    modelId: 'flux-pro',
    apiKey: 'sk-test',
    sizeField: 'image_size',
    skipTest: true,
  }, AUTH)

  assert.equal(res.status, 200, JSON.stringify(res.body))
  const after = loadConfig()
  assert.equal(after.provider.default, defaultBefore, 'provider.default 必须不变')
  assert.equal(after.agent.defaultModel, defaultModelBefore, 'agent.defaultModel 必须不变')
  assert.equal(getImageGenModelConfig()?.model, 'flux-pro')
  assert.equal(getImageGenModelConfig()?.sizeField, 'image_size')
  // 模型卡打 supportsImageGen，而不是 supportsVision（方向反对称）。
  assert.equal(after.provider.providers['imagegen-route']?.models[0]?.supportsImageGen, true)
  assert.equal(after.provider.providers['imagegen-route']?.models[0]?.supportsVision, undefined)
})

// M5（issue #8 §7.2 建议 2 的**上游环节**）：桌面端靠 supportsImageGen 把生图模型挡在
// 主会话列表外，而那个字段要经 GET /config/providers 下发——不透出的话，桌面端的过滤
// 单元测试全绿、生产里却永远不触发。
test('GET /config/providers 透出 supportsImageGen', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const res = await router('GET', '/config/providers', undefined, AUTH)
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const body = res.body as {
    providers: Array<{ name: string; models: Array<{ id: string; supportsImageGen?: boolean }> }>
  }
  const registered = body.providers.find(p => p.name === 'imagegen-route')
  assert.ok(registered, '前一个用例注册的 provider 应出现在列表里')
  const model = registered.models.find(m => m.id === 'flux-pro')
  assert.equal(model?.supportsImageGen, true, '字段必须下发——否则桌面端拿不到判据')
})

// issue #8 闭环：配置落盘后要广播给存活 agent 重算工具表。没有这一环，用户注册完生图
// provider 后当前会话依然看不到 generate_image ——「配置成功但工具不出现」的静默失效。
test('生图配置落盘后触发 onImageGenConfigChanged', async () => {
  const broadcasts: string[] = []
  const router = createRouter(buildConfigRoutes(TOKEN, {
    onImageGenConfigChanged: () => { broadcasts.push('fired') },
  }))

  const put = await router('PUT', '/config/image-gen-model', { config: null }, AUTH)
  assert.equal(put.status, 200)
  assert.equal(broadcasts.length, 1, 'PUT 成功后必须广播')

  const onboard = await router('POST', '/config/image-gen-model/onboard', {
    providerName: 'imagegen-hook',
    baseUrl,
    modelId: 'flux-pro',
    apiKey: 'sk-test',
    skipTest: true,
  }, AUTH)
  assert.equal(onboard.status, 200, JSON.stringify(onboard.body))
  assert.equal(broadcasts.length, 2, 'onboard 成功后必须广播')
})

// 反证：写入失败时不能广播。发一个假信号比不发更糟——agent 会重算一次工具表，
// 而配置根本没变，排障时这条日志会把方向带偏。
test('配置写入失败时不广播', async () => {
  const broadcasts: string[] = []
  const router = createRouter(buildConfigRoutes(TOKEN, {
    onImageGenConfigChanged: () => { broadcasts.push('fired') },
  }))

  const res = await router('PUT', '/config/image-gen-model', {
    config: { provider: 'ghost-provider', model: 'ghost-model' },
  }, AUTH)
  assert.equal(res.status, 400)
  assert.equal(broadcasts.length, 0, '失败路径不该发广播')
})

test('test route really generates (not just probes /models) and reports the size field used', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const before = generationCount
  const res = await router('POST', '/config/image-gen-model/test', {
    baseUrl,
    modelId: 'flux-pro',
    apiKey: 'sk-test',
    sizeField: 'image_size',
    size: '1024x1024',
  }, AUTH)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(generationCount, before + 1, '真测必须真的发一次生图请求')
  assert.equal(sawSizeField, 'image_size', 'sizeField 必须透传到线上字段名')
})

test('test route surfaces upstream failures with the actionable classified message', async () => {
  upstreamFails = true
  try {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/image-gen-model/test', {
      baseUrl, modelId: 'flux-pro', apiKey: 'sk-test',
    }, AUTH)
    assert.equal(res.status, 400)
    assert.match(String((res.body as { error: string }).error), /429|Rate limited/)
  } finally {
    upstreamFails = false
  }
})

test('PUT clears the slot and leaves providers untouched', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const providersBefore = JSON.stringify(loadConfig().provider.providers)
  const res = await router('PUT', '/config/image-gen-model', { config: null }, AUTH)
  assert.equal(res.status, 200)
  assert.equal(getImageGenModelConfig(), undefined)
  assert.equal(JSON.stringify(loadConfig().provider.providers), providersBefore)
})

test('PUT rejects a provider that is not configured', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const res = await router('PUT', '/config/image-gen-model', {
    config: { provider: 'ghost', model: 'ghost' },
  }, AUTH)
  assert.equal(res.status, 400)
  assert.match(String((res.body as { error: string }).error), /不在已配置的 provider 列表里/)
})
