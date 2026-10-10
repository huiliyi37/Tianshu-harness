import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
const { generateImage } = await import(process.env.RIVET_IMAGE_NETWORK_TEST_MODULE ?? '../image-gen-client.js') as typeof import('../image-gen-client.js')
import { resolveImageGeneration, imageGenerationNetwork } from '../image-generation-parameters.js'
import { configSchema } from '../../config/schema.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const publicLookup = async () => ({ address: '93.184.216.34', family: 4 })
const options = { baseUrl: 'http://provider.example/v1', model: 'agnes-image-2.5-flash', prompt: 'garden', apiKey: 'provider-key', size: '1024x1024', lookupImpl: publicLookup, timeoutMs: 1500 }
const envKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'RIVET_NO_SYSTEM_PROXY']
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  process.env.RIVET_NO_SYSTEM_PROXY = '1'
})
afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
async function localServer(listener: RequestListener, run: (base: string) => Promise<void>) {
  const server = createServer(listener)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}
function imageUrl(res: Parameters<RequestListener>[1], url = 'http://cdn.example/image.png?signature=private-url') {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: [{ url }] }))
}

for (const route of ['configured', 'environment']) test(`real ${route} proxy handles generation and CDN download, without leaking authorization or regenerating`, async () => {
  const requests: { path: string; auth?: string; method?: string }[] = []
  await localServer((req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization, method: req.method })
    if (req.method === 'POST') imageUrl(res)
    else { res.setHeader('content-type', 'image/png'); res.end(png) }
  }, async proxyUrl => {
    if (route === 'environment') process.env.HTTP_PROXY = proxyUrl
    const image = await generateImage({ ...options, ...(route === 'configured' ? { proxy: { proxyUrl, noProxy: '' } } : {}) })
    assert.deepEqual(image.bytes, new Uint8Array(png))
    assert.equal(image.source, 'url')
    assert.equal(requests.length, 2)
    assert.equal(requests[0]!.method, 'POST')
    assert.equal(requests[0]!.auth, 'Bearer provider-key')
    assert.equal(requests[1]!.method, 'GET')
    assert.equal(requests[1]!.auth, undefined, 'A CDN must never receive the provider API key')
    assert.match(requests[1]!.path, /cdn\.example/)
  })
})

test('NO_PROXY is applied per host: local provider direct, external image through proxy', async () => {
  let generations = 0, downloads = 0
  await localServer((req, res) => { downloads++; assert.equal(req.headers.authorization, undefined); res.end(png) }, async proxyUrl => {
    await localServer((_req, res) => { generations++; imageUrl(res) }, async base => {
      const image = await generateImage({ ...options, baseUrl: `${base}/v1`, proxy: { proxyUrl, noProxy: '127.0.0.1' } })
      assert.deepEqual(image.bytes, new Uint8Array(png))
    })
  })
  assert.equal(generations, 1); assert.equal(downloads, 1)
})

test('redirects are checked before download and cannot reach a private address', async () => {
  let calls = 0
  await assert.rejects(() => generateImage({ ...options, fetchImpl: (async (_url, init) => {
    calls++
    return init?.method === 'POST'
      ? new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }))
      : new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/image' } })
  }) as typeof fetch }), /Access denied|reserved IP/i)
  assert.equal(calls, 2, 'Private redirect must be rejected before the third request')
})

test('cancel interrupts a real proxy download body and never repeats the paid request', { timeout: 4000 }, async () => {
  let generations = 0, downloads = 0
  const controller = new AbortController()
  const started = Date.now()
  await localServer((req, res) => {
    if (req.method === 'POST') { generations++; imageUrl(res) }
    else { downloads++; res.writeHead(200, { 'content-type': 'image/png' }); res.flushHeaders(); setTimeout(() => controller.abort(new DOMException('Cancelled by user', 'AbortError')), 30) }
  }, async proxyUrl => {
    await assert.rejects(() => generateImage({ ...options, proxy: { proxyUrl }, signal: controller.signal }), /Cancelled by user/)
  })
  assert.equal(generations, 1); assert.equal(downloads, 1)
  assert.ok(Date.now() - started < 600, 'Cancellation must reach the body immediately, instead of waiting for the download timeout')
})

test('network errors retain nested error codes and host, without the signed URL or credentials', async () => {
  let calls = 0
  await assert.rejects(() => generateImage({ ...options, fetchImpl: (async (_url, init) => {
    calls++
    if (init?.method === 'POST') return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png?signature=private-url' }] }))
    throw new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('sensitive internals'), { code: 'ECONNREFUSED' }), Object.assign(new Error(), { code: 'ETIMEDOUT' })]) })
  }) as typeof fetch }), error => {
    const message = (error as Error).message
    assert.match(message, /cdn\.example.*ECONNREFUSED.*ETIMEDOUT/)
    assert.ok(!message.includes('private-url') && !message.includes('provider-key') && !message.includes('sensitive internals'))
    return true
  })
  assert.equal(calls, 2)
})

test('HTTP errors show only the image host and status, never URL credentials or signed query', async () => {
  await assert.rejects(() => generateImage({ ...options, fetchImpl: (async (_url, init) => init?.method === 'POST'
    ? new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png?signature=private-url' }] }))
    : new Response('expired', { status: 403 })) as typeof fetch }), error => {
    assert.match((error as Error).message, /cdn\.example.*HTTP 403/)
    assert.ok(!(error as Error).message.includes('private-url'))
    return true
  })
})

test('provider proxy overrides global proxy; global NO_PROXY and fake-IP trust survive selection', () => {
  const config = configSchema.parse({ provider: { default: 'image', providers: { image: { name: 'image', baseUrl: 'https://provider.example/v1', apiKey: 'fixture-key', proxy: 'http://provider-proxy:1234', models: [{ id: 'image', supportsImageGen: true }] } } }, network: { proxy: 'http://global-proxy:2345', noProxy: '.internal', trustProxyFakeIp: true }, agent: { imageGenModel: { provider: 'image', model: 'image' } } })
  const selection = resolveImageGeneration({ prompt: 'garden' }, config)
  assert.deepEqual(selection.connection.proxy, { proxyUrl: 'http://provider-proxy:1234', noProxy: '.internal' })
  assert.equal(selection.connection.trustProxyFakeIp, true)
  assert.equal(imageGenerationNetwork(config).proxy.proxyUrl, 'http://global-proxy:2345', 'New service trials follow global network settings')
})
