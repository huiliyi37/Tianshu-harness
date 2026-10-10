import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ImageGenerationRecord } from '../protocol.js'
import { createRouter } from '../index.js'
import { buildImageGenerationRoutes } from '../image-generation-routes.js'
import { buildConfigRoutes } from '../config-routes.js'
import { ImageGenerationService } from '../../api/image-generation-service.js'
import { loadConfig, saveConfig } from '../../config/manager.js'
import { configSchema } from '../../config/schema.js'
import { generateImage } from '../../api/image-gen-client.js'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('authenticated async routes preserve one paid request, actual size, bytes, workspace isolation and cancellation', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'image-routes-')), other = await mkdtemp(join(tmpdir(), 'image-other-'))
  const previous = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_CONFIG_PATH = join(cwd, 'config.json')
  t.after(() => { if (previous === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previous })
  let calls = 0, payload: Record<string, unknown> = {}, hanging = false, aborted = false
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    payload = JSON.parse(body); calls++
    if (hanging) { res.on('close', () => { aborted = true }); return }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png }] }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  const service = new ImageGenerationService()
  const router = createRouter(buildImageGenerationRoutes('local-test', () => [cwd, other], service))
  const app = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const result = await router(req.method!, req.url!, body ? JSON.parse(body) : undefined, req.headers as Record<string, string>, res)
    if (!result.handled) { res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result.body)) }
  })
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  t.after(() => { app.closeAllConnections(); app.close() })
  const address = app.address() as { port: number }, up = upstream.address() as { port: number }
  const call = (path: string, body?: unknown, auth = true) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(auth ? { Authorization: 'Bearer local-test' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const request = { cwd, requestId: randomUUID(), origin: 'test', draft: { baseUrl: `http://127.0.0.1:${up.port}/v1`, modelId: 'flux', sizeField: 'image_size', size: '1536x1024' } }
  assert.equal((await call('/image-generations', request, false)).status, 401)
  assert.equal((await call('/image-generations', { ...request, cwd: tmpdir() })).status, 403)
  assert.equal((await call('/image-generations', { ...request, draft: { ...request.draft, size: '0x1' } })).status, 400)
  const responses = await Promise.all([call('/image-generations', request), call('/image-generations', request)])
  assert.ok(responses.every(response => response.status === 202))
  const [first, second] = await Promise.all(responses.map(async response => await response.json() as ImageGenerationRecord))
  assert.ok(first && second)
  assert.equal(first!.id, second!.id)
  const done = await service.wait(cwd, first.id)
  assert.equal(calls, 1); assert.equal(payload.image_size, '1536x1024'); assert.equal(payload.size, undefined)
  assert.equal(done?.width, 1); assert.equal(done?.height, 1)
  const bytes = await call(`/image-generations/${first.id}/image?cwd=${encodeURIComponent(cwd)}`)
  assert.equal(bytes.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), Buffer.from(png, 'base64'))
  assert.equal((await call(`/image-generations/${first.id}/image?cwd=${encodeURIComponent(cwd)}`, undefined, false)).status, 401)
  assert.equal((await call(`/image-generations/${first.id}?cwd=${encodeURIComponent(other)}`)).status, 404)
  const history = await (await call(`/image-generations?cwd=${encodeURIComponent(cwd)}`)).json() as { total: number; records: ImageGenerationRecord[] }
  assert.equal(history.total, 1); assert.equal(history.records[0]!.origin, 'test')
  assert.equal(JSON.stringify(history).includes('Authorization'), false)
  hanging = true
  const pending = await (await call('/image-generations', { ...request, requestId: randomUUID() })).json() as ImageGenerationRecord
  await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 3000; const timer = setInterval(() => { if (calls === 2) { clearInterval(timer); resolve() } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Provider was never called')) } }, 10) })
  await call(`/image-generations/${pending.id}/cancel`, { cwd })
  assert.equal((await service.wait(cwd, pending.id))?.state, 'cancelled')
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(aborted, true)
  assert.equal(calls, 2)
  assert.equal((await readFile(done!.path!)).length, Buffer.from(png, 'base64').length)
})

test('workbench, draft trial and legacy trial consume network settings at the actual generation and download requests', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'image-proxy-routes-')), previous = process.env.RIVET_CONFIG_PATH
  const previousKey = process.env.FIXTURE_IMAGE_TEST_KEY
  process.env.FIXTURE_IMAGE_TEST_KEY = 'fixture-key'
  process.env.RIVET_CONFIG_PATH = join(cwd, 'config.json')
  t.after(() => { if (previous === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previous; if (previousKey === undefined) delete process.env.FIXTURE_IMAGE_TEST_KEY; else process.env.FIXTURE_IMAGE_TEST_KEY = previousKey })
  const requests: { route: string; method: string; auth?: string }[] = []
  const makeProxy = async (route: string) => {
    const proxy = createServer((req, res) => {
      requests.push({ route, method: req.method!, auth: req.headers.authorization })
      if (req.method === 'POST') res.end(JSON.stringify({ data: [{ url: 'http://93.184.216.34/generated.png' }] }))
      else res.end(Buffer.from(png, 'base64'))
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    t.after(() => { proxy.closeAllConnections(); proxy.close() })
    return `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  }
  const globalProxy = await makeProxy('global'), providerProxy = await makeProxy('provider')
  saveConfig(configSchema.parse({ provider: { default: 'fixture', providers: { fixture: { name: 'fixture', baseUrl: 'http://provider.example/v1', apiKeyEnv: 'FIXTURE_IMAGE_TEST_KEY', proxy: providerProxy, models: [{ id: 'image', supportsImageGen: true }] } } }, agent: { imageGenModel: { provider: 'fixture', model: 'image' } }, network: { proxy: globalProxy, noProxy: '' } }))
  const service = new ImageGenerationService(undefined, options => generateImage({ ...options, lookupImpl: async () => ({ address: '93.184.216.34', family: 4 }) }))
  const router = createRouter(buildImageGenerationRoutes('fixture', () => [cwd], service)), auth = { authorization: 'Bearer fixture' }
  const workbench = await router('POST', '/image-generations', { cwd, requestId: randomUUID(), parameters: { prompt: 'garden' } }, auth)
  assert.equal(workbench.status, 202, JSON.stringify(workbench.body))
  assert.equal((await service.wait(cwd, (workbench.body as ImageGenerationRecord).id))?.state, 'succeeded')
  const trial = await router('POST', '/image-generations', { cwd, requestId: randomUUID(), origin: 'test', draft: { baseUrl: 'http://trial.example/v1', modelId: 'image', apiKey: 'trial-key' } }, auth)
  assert.equal(trial.status, 202)
  assert.equal((await service.wait(cwd, (trial.body as ImageGenerationRecord).id))?.state, 'succeeded')
  assert.deepEqual(requests.map(req => [req.route, req.method]), [['provider', 'POST'], ['provider', 'GET'], ['global', 'POST'], ['global', 'GET']])
  assert.ok(requests.filter(req => req.method === 'GET').every(req => !req.auth), 'Provider keys must not reach the image CDN')
  const legacy = await createRouter(buildConfigRoutes('fixture'))('POST', '/config/image-gen-model/test', { baseUrl: 'http://trial.example/v1', modelId: 'image', apiKey: 'trial-key' }, auth)
  assert.equal(legacy.status, 200)
  assert.deepEqual(requests.slice(-2).map(req => [req.route, req.method]), [['global', 'POST'], ['global', 'GET']])
})

test('saving without a trial and saving after a trial never call generation; model switching validates its own size', async t => {
  const root = await mkdtemp(join(tmpdir(), 'image-config-'))
  const previous = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_CONFIG_PATH = join(root, 'config.json')
  t.after(() => { if (previous === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previous })
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.end(JSON.stringify({ data: [{ b64_json: png }] })) })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  const address = upstream.address() as { port: number }, baseUrl = `http://127.0.0.1:${address.port}/v1`
  const configRouter = createRouter(buildConfigRoutes('test-config'))
  const saved = await configRouter('POST', '/config/image-gen-model/onboard', { providerName: 'image-test', baseUrl, modelId: 'model', skipTest: false, apiKey: 'mock-key' }, { authorization: 'Bearer test-config' })
  assert.equal(saved.status, 200); assert.equal(calls, 0, 'Saving is not a billable operation, including older callers')
  const cfg = loadConfig(); cfg.provider.providers['image-test']!.models[0]!.imageGen = { sizeField: 'image_size', sizes: ['1536x1024'], defaultSize: '1536x1024' }; saveConfig(cfg)
  const service = new ImageGenerationService(), router = createRouter(buildImageGenerationRoutes('test-config', () => [root], service))
  const params = { provider: 'image-test', model: 'model', prompt: 'garden' }
  assert.equal((await router('POST', '/image-generations', { cwd: root, requestId: randomUUID(), parameters: { ...params, size: '512x512' } }, { authorization: 'Bearer test-config' })).status, 400)
  assert.equal(calls, 0)
  const job = await router('POST', '/image-generations', { cwd: root, requestId: randomUUID(), parameters: params }, { authorization: 'Bearer test-config' })
  assert.equal(job.status, 202)
  assert.equal((await service.wait(root, (job.body as { id: string }).id))?.state, 'succeeded'); assert.equal(calls, 1)
  assert.equal((await configRouter('PUT', '/config/image-gen-model', { config: { provider: 'image-test', model: 'model' } }, { authorization: 'Bearer test-config' })).status, 200)
  assert.equal(calls, 1)
  const legacy = loadConfig(); delete legacy.provider.providers['image-test']!.models[0]!.supportsImageGen; saveConfig(legacy)
  const legacyJob = await router('POST', '/image-generations', { cwd: root, requestId: randomUUID(), parameters: params }, { authorization: 'Bearer test-config' })
  assert.equal(legacyJob.status, 202, 'An explicitly configured old image slot remains compatible')
  assert.equal((await service.wait(root, (legacyJob.body as { id: string }).id))?.state, 'succeeded')
  delete legacy.agent.imageGenModel; saveConfig(legacy)
  assert.equal((await router('POST', '/image-generations', { cwd: root, requestId: randomUUID(), parameters: params }, { authorization: 'Bearer test-config' })).status, 400, 'Vision or missing capability alone does not permit generation')
})
