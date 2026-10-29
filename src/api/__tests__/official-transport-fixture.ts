import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountDeviceFingerprint } from '../../auth/account-device.js'
import { accountStore, checkDeviceOnce, saveAccountToken } from '../../auth/account.js'
import { createOfficialModelBroker } from '../../auth/official-model-auth.js'
import { providerSchema, type Config } from '../../config/schema.js'
import { prepareModelRuntime, resolveModelRuntime, beginModelUserScope, prepareRuntimeContext, type ModelRuntimeDeps } from '../../models/model-runtime.js'
import { OfficialError, type Binding, type Catalog } from '../../models/official-contract.js'

const runtimeFixtureFetch = globalThis.fetch.bind(globalThis)
function installRuntimeFixtureEnvironment(values: Record<string, string | undefined>, fetchImpl: typeof fetch): () => void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  const previousFetch = globalThis.fetch
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = fetchImpl
  return () => {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export const wires = [
  ['openai', 'chat', '/v1/chat/completions'], ['openai-responses', 'responses', '/v1/responses'], ['anthropic', 'messages', '/v1/messages'], ['gemini', 'generate-content', '/v1beta/models/fixture-model:streamGenerateContent'],
] as const

export async function createOfficialTransportFixture(protocol: Binding['protocol'] = 'openai', operation?: 'image-generation' | 'embedding', bindingId = 'binding-1', directAccess = false) {
  const home = mkdtempSync(join(tmpdir(), 'r2-wire-'))
  writeFileSync(join(home, 'config.json'), '{}')
  const originalFetch = runtimeFixtureFetch
  const secret = randomUUID(), device = 'r2-fixture-device', subject = '11111111-1111-4111-8111-111111111111'
  let sid = randomUUID(), grants = 0, quoteCount = 0, catalogCount = 0, now = Date.now(), expiresIn = 300000, directGrants = 0
  const destinations: string[] = []
  const credentials = new Set<string>(), tokens = new Set<string>()
  const wire = wires.find(w => w[0] === protocol)!
  const binding: Binding = { id: bindingId, modelId: 'fixture-model', protocol, operation: operation ?? wire[1], origin: 'https://gateway.invalid', path: operation === 'image-generation' ? '/v1/images/generations' : operation === 'embedding' ? '/v1/embeddings' : wire[2], stream: !operation, capabilities: { tools: true, vision: true, thinking: true }, requiredHeaders: { 'anthropic-version': '2023-06-01' }, thinkingPolicy: '', pricingRevision: 'price-1' }
  const catalog: Catalog = { revision: 'catalog-1', models: [{ id: 'fixture-model', displayName: 'Fixture', provider: 'Fixture', status: 'available', contextWindow: 32000, maxOutputTokens: 4000, capabilities: { tools: true, vision: true, thinking: true }, bindings: [binding], costStatus: 'unavailable' }] }
  const calls: Array<{ path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = []
  let response: ((res: import('node:http').ServerResponse, call: typeof calls[number]) => void) | undefined
  const signedToken = () => { const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'); const p = Buffer.from(JSON.stringify({ sub: subject, session_id: sid, role: 'authenticated', type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'); const token = `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`; tokens.add(token); return token }
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += String(chunk)
      const body = JSON.parse(raw || '{}') as Record<string, unknown>, bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '', path = req.url!
      let data: unknown
      if (path.endsWith('/tui-auth-check')) data = { status: 'approved', accessToken: signedToken(), refreshToken: 'synthetic-refresh', expiresIn: 3600 }
      else if (path.endsWith('/tui-model-bootstrap')) {
        assert.ok(tokens.has(bearer)); const parts = bearer.split('.'); assert.equal(parts[2], createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url'))
        assert.deepEqual(Object.keys(body).sort(), body.transport === 'direct' ? ['deviceId', 'requestId', 'transport'] : ['deviceId', 'requestId']); assert.equal(body.deviceId, device)
        if (body.transport === 'direct') {
          directGrants++; const credential = 'sk-synthetic-direct-owned'; credentials.add(credential)
          data = { credential, subject, accountSessionId: sid, expiresAt: new Date(Date.now() + expiresIn).toISOString(), catalogRevision: catalog.revision, bindingId: binding.id, modelId: binding.modelId, protocol: 'openai', origin: 'https://supplier.invalid', path: '/v1/chat/completions' }
        } else {
          const credential = `sk-synthetic-${++grants}`; credentials.add(credential)
          data = { credential, subject, accountSessionId: sid, generation: grants, expiresAt: new Date(Date.now() + expiresIn).toISOString(), catalogRevision: catalog.revision }
        }
      } else if (path.endsWith('/catalog')) { assert.ok(credentials.has(bearer)); catalogCount++; data = catalog }
      else if (path.endsWith('/model-quote')) {
        assert.ok(credentials.has(bearer)); assert.deepEqual(Object.keys(body).sort(), ['bindingId', 'catalogRevision', 'pricingRevision', 'requestId']); assert.equal(body.bindingId, binding.id); assert.equal(body.catalogRevision, catalog.revision); assert.equal(body.pricingRevision, binding.pricingRevision)
        data = { quoteId: `quote-${++quoteCount}`, modelId: binding.modelId, bindingId: binding.id, pricingRevision: binding.pricingRevision, calendarRevision: 'calendar-1', tier: 'standard', period: 'fixed', timezone: 'Asia/Shanghai', asOf: new Date(now).toISOString(), validUntil: new Date(now + 30000).toISOString(), kind: 'opaque', costStatus: 'unavailable' }
      } else {
        assert.ok(credentials.has(bearer)); const call = { path, headers: req.headers, body }; calls.push(call)
        if (response) { response(res, call); return }
        res.setHeader('content-type', 'text/event-stream')
        if (protocol === 'openai') res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        if (protocol === 'openai-responses') res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"synthetic","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
        if (protocol === 'anthropic') res.end('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
        if (protocol === 'gemini') res.end('data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n')
        return
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(path.endsWith('/tui-auth-check') ? data : { version: path.includes('/api/official/v2/customer/') ? 2 : 1, requestId: body.requestId ?? 'catalog', data }))
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: String(error) } })) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const fetchImpl: typeof fetch = async (url, init) => { const u = new URL(String(url)); destinations.push(u.href); assert.equal(u.protocol, 'https:'); assert.equal(init?.redirect, u.pathname.includes('/images/') ? 'manual' : 'error'); return originalFetch(endpoint + u.pathname, init) }
  const releaseEnvironment = installRuntimeFixtureEnvironment({ HTTP_PROXY: undefined, http_proxy: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, ALL_PROXY: undefined, all_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined, RIVET_NO_SYSTEM_PROXY: '1', RIVET_OFFICIAL_GATEWAY_ORIGIN: 'https://gateway.invalid', RIVET_HOME: home, RIVET_CONFIG_PATH: join(home, 'config.json'), RIVET_ACCOUNT_API: 'https://account.invalid', RIVET_ACCOUNT_ANON_KEY: 'sb_publishable_synthetic', RIVET_TOKEN_STORE: 'local-key' }, fetchImpl)
  accountDeviceFingerprint(home, device)
  const install = async () => { const store = accountStore(home); const intent = store.beginLogin(device); const poll = await checkDeviceOnce('synthetic', { fetchImpl }); saveAccountToken(store, poll, { intent, deviceId: device }) }
  await install()
  const broker = createOfficialModelBroker({ home, configuration: { gatewayOrigin: 'https://gateway.invalid', gatewayOrigins: ['https://gateway.invalid'], checkoutOrigins: ['https://pay.invalid'], directAccess, supplierOrigins: ['https://supplier.invalid'] }, fetchImpl })
  const deps: ModelRuntimeDeps = { captureIdentity: broker.captureOfficialIdentity, withIdentity: broker.withCurrentOfficialIdentity, getCatalog: broker.getOfficialCatalog, getQuote: broker.getOfficialPriceQuote, getCredential: broker.getOfficialCredential, getDirectAccess: broker.getOfficialDirectAccess, peekDirectAccess: broker.peekOfficialDirectAccess, directSignal: broker.getOfficialDirectSignal, invalidateDirectAccess: broker.invalidateOfficialDirectAccess, now: () => now }
  const provider = providerSchema.parse({ name: 'official', auth: { type: 'tianshu-account' }, models: [{ id: 'fixture-model', managed: { bindingId: binding.id }, maxTokens: 4000 }] })
  const config = { provider: { default: 'official', providers: { official: provider } } } as unknown as Config
  const input = { config, provider, apiKey: '', modelId: 'fixture-model', purpose: operation ?? 'agent' as const }
  return { writeConfig() { writeFileSync(join(home, 'config.json'), JSON.stringify(config)) }, home, input, deps, binding, catalog, calls, destinations, fetchImpl, get directGrants() { return directGrants }, get catalogCount() { return catalogCount }, get quoteCount() { return quoteCount }, setResponse(fn: typeof response) { response = fn }, advance(ms: number) { now += ms }, shortCredentials() { expiresIn = 5500 }, async replaceAccount() { accountStore(home).clear(); sid = randomUUID(); await install() }, async close() { releaseEnvironment(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }) } }
}
