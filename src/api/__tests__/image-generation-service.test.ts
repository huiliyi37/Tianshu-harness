import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ImageGenerationService } from '../image-generation-service.js'
import { ImageGenerationStore, imageDirectory } from '../image-generation-store.js'
import { generateImage } from '../image-gen-client.js'
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
const result = { bytes: png, mimeType: 'image/png', source: 'b64_json' as const }
async function input() { return { cwd: await mkdtemp(join(tmpdir(), 'tianshu-generation-')), requestId: randomUUID(), origin: 'workbench' as const, parameters: { provider: 'image', model: 'model', prompt: 'garden', prefix: 'watercolor', size: '1024x1024', sizeField: 'image_size' as const }, connection: { baseUrl: 'https://example.com/v1', apiKey: 'not-a-real-key' } } }
test('concurrent submissions create one provider call, one image, and one record', async () => {
  let calls = 0, wirePrompt = '', sizeField: string | undefined
  const service = new ImageGenerationService(undefined, async options => { calls++; wirePrompt = options.prompt; sizeField = options.sizeField; return result })
  const request = await input(), records = await Promise.all([service.start(request), service.start(request), service.start(request)])
  assert.equal(new Set(records.map(record => record.id)).size, 1)
  const done = await service.wait(request.cwd, records[0]!.id)
  assert.equal(calls, 1); assert.equal(wirePrompt, 'watercolor，garden'); assert.equal(sizeField, 'image_size')
  assert.equal(done?.state, 'succeeded'); assert.equal(done?.width, 1); assert.equal(done?.height, 1)
  const files = await readdir(imageDirectory(request.cwd))
  assert.equal(files.filter(file => file.endsWith('.png')).length, 1)
  assert.equal(files.filter(file => file.endsWith('.json')).length, 1)
  const raw = await readFile(join(imageDirectory(request.cwd), `${done!.id}.json`), 'utf8')
  assert.equal(raw.includes(request.connection.apiKey), false); assert.equal(raw.includes('base64'), false)
  const restarted = new ImageGenerationService(undefined, async () => { throw new Error('must not generate twice') })
  assert.equal((await restarted.start(request)).id, done!.id)
  await assert.rejects(() => restarted.start({ ...request, parameters: { ...request.parameters, prompt: 'different' } }), /different parameters/)
})
test('request snapshot and originating workspace survive later configuration and navigation changes', async () => {
  let finish!: () => void
  const hold = new Promise<void>(resolve => { finish = resolve })
  const service = new ImageGenerationService(undefined, async () => { await hold; return result })
  const request = await input(), record = await service.start(request)
  request.parameters.prompt = 'changed'; request.parameters.model = 'other'; finish()
  const done = await service.wait(request.cwd, record.id)
  assert.equal(done?.parameters.prompt, 'garden'); assert.equal(done?.parameters.model, 'model')
  assert.ok(done?.path?.startsWith(await realpath(request.cwd))); assert.equal(await service.get((await input()).cwd, record.id), undefined)
})
test('network settings are snapshotted before asynchronous preparation and never written to image history', async () => {
  const request = { ...await input(), connection: { baseUrl: 'https://example.com/v1', apiKey: 'fixture-key', proxy: { proxyUrl: 'http://user:private-proxy-password@proxy.example:7890', noProxy: '.internal' }, trustProxyFakeIp: true } }
  let seen: string | undefined
  const service = new ImageGenerationService(undefined, async options => { seen = options.proxy?.proxyUrl; assert.equal(options.proxy?.noProxy, '.internal'); assert.equal(options.trustProxyFakeIp, true); return result })
  const pending = service.start(request)
  request.connection.proxy.proxyUrl = 'http://changed.example:7890'
  const record = await pending, done = await service.wait(request.cwd, record.id)
  assert.equal(seen, 'http://user:private-proxy-password@proxy.example:7890')
  assert.equal(done?.state, 'succeeded')
  const raw = await readFile(join(imageDirectory(request.cwd), `${record.id}.json`), 'utf8')
  assert.ok(!raw.includes('private-proxy-password') && !raw.includes('fixture-key') && !raw.includes('proxyUrl'))
})
test('cancel reaches provider signal and never writes an image', async () => {
  const service = new ImageGenerationService(undefined, options => new Promise((_resolve, reject) => {
    if (options.signal!.aborted) reject(options.signal!.reason)
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
  }))
  const request = await input(), record = await service.start(request)
  await service.cancel(request.cwd, record.id)
  const done = await service.wait(request.cwd, record.id)
  assert.equal(done?.state, 'cancelled'); assert.equal(done?.path, undefined)
})
test('record write failure preserves image, supports repair, and survives restart without another provider call', async () => {
  class FailingStore extends ImageGenerationStore {
    fail = true
    override async write(record: Parameters<ImageGenerationStore['write']>[0]) {
      if (record.state === 'succeeded' && this.fail) throw new Error('disk')
      return super.write(record)
    }
  }
  let calls = 0
  const store = new FailingStore(), service = new ImageGenerationService(store, async () => { calls++; return result })
  const request = await input(), record = await service.start(request), done = await service.wait(request.cwd, record.id)
  assert.equal(done?.state, 'succeeded'); assert.equal(done?.recordSaved, false)
  assert.deepEqual((await service.image(request.cwd, record.id)).bytes, Buffer.from(png))
  const restarted = new ImageGenerationService()
  const recovered = await restarted.get(request.cwd, record.id)
  assert.equal(recovered?.state, 'succeeded'); assert.equal(recovered?.recordSaved, false)
  assert.equal((await restarted.repair(request.cwd, record.id)).recordSaved, true)
  assert.equal(calls, 1)
})
test('failed requests do not regenerate on polling, replay, or history loading', async () => {
  let calls = 0
  const service = new ImageGenerationService(undefined, async () => { calls++; throw new Error('HTTP 429') })
  const request = await input(), record = await service.start(request), done = await service.wait(request.cwd, record.id)
  assert.equal(done?.state, 'failed'); assert.equal(done?.error?.stage, 'generating')
  await service.get(request.cwd, record.id); await service.list(request.cwd); await service.start(request)
  assert.equal(calls, 1)
})
test('unfinished persisted generation is interrupted after restart and is not resubmitted', async () => {
  const request = await input(), id = randomUUID(), store = new ImageGenerationStore()
  await store.write({ id, cwd: request.cwd, requestId: request.requestId, origin: 'workbench', parameters: request.parameters, state: 'generating', startedAt: Date.now() })
  const service = new ImageGenerationService(store, async () => { throw new Error('must not retry') })
  assert.equal((await service.start(request)).state, 'interrupted')
})
test('history paginates and imports old files without inventing descriptions', async () => {
  const request = await input(), service = new ImageGenerationService(undefined, async () => result)
  const record = await service.start(request); await service.wait(request.cwd, record.id)
  await writeFile(join(imageDirectory(request.cwd), 'generated-old.png'), png)
  const history = await service.list(request.cwd, '', 0, 1)
  assert.equal(history.total, 2); assert.equal(history.records.length, 1)
  const legacy = (await service.list(request.cwd)).records.find(record => record.origin === 'legacy')!
  assert.equal(legacy.parameters.prompt, ''); assert.deepEqual((await service.image(request.cwd, legacy.id)).bytes, Buffer.from(png))
  assert.equal((await service.list(request.cwd, 'garden')).total, 1)
})
test('cancellation reaches image download and is distinct from timeout', async () => {
  const controller = new AbortController()
  let downloading!: () => void
  const reached = new Promise<void>(resolve => { downloading = resolve })
  const running = generateImage({ baseUrl: 'https://example.com', model: 'model', prompt: 'garden', signal: controller.signal, lookupImpl: async () => ({ address: '93.184.216.34', family: 4 }), fetchImpl: (async (_url, init) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }))
    downloading()
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))
  }) as typeof fetch })
  await reached; controller.abort()
  await assert.rejects(running, error => error instanceof Error && error.name === 'AbortError' && !error.message.includes('timed out'))
})

test('a saved file is not overwritten; save failures do not retry the provider', async () => {
  const request = await input(), path = join(request.cwd, 'existing.png')
  await writeFile(path, 'original')
  let calls = 0
  const service = new ImageGenerationService(undefined, async () => { calls++; return result })
  const record = await service.start({ ...request, outputPath: path })
  const done = await service.wait(request.cwd, record.id)
  assert.equal(done?.state, 'failed'); assert.equal(done?.error?.stage, 'saving')
  assert.equal(await readFile(path, 'utf8'), 'original')
  assert.equal((await service.start({ ...request, outputPath: path })).id, record.id); assert.equal(calls, 1)
})
test('initial history write failure prevents any provider call and identifies the record stage', async () => {
  class FailingStore extends ImageGenerationStore { override async write() { throw new Error('permission denied') } }
  let calls = 0
  const service = new ImageGenerationService(new FailingStore(), async () => { calls++; return result })
  const request = await input(), record = await service.start(request), done = await service.wait(request.cwd, record.id)
  assert.equal(done?.state, 'failed'); assert.equal(done?.error?.stage, 'record'); assert.equal(calls, 0)
})
test('download failures retain stage and redact provider credentials from diagnostic records', async () => {
  const request = await input()
  const service = new ImageGenerationService(undefined, async options => { options.onStage?.('downloading'); throw new Error(`HTTP 503: ${request.connection.apiKey}`) })
  const record = await service.start(request), done = await service.wait(request.cwd, record.id)
  assert.equal(done?.error?.stage, 'downloading'); assert.ok(!JSON.stringify(done).includes(request.connection.apiKey))
  assert.equal((await service.list(request.cwd)).records[0]?.state, 'failed')
})
