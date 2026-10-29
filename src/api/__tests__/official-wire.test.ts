import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountDeviceFingerprint } from '../../auth/account-device.js'
import { accountStore, checkDeviceOnce, saveAccountToken } from '../../auth/account.js'
import { createOfficialModelBroker } from '../../auth/official-model-auth.js'
import { createOfficialDirectAccess } from '../../auth/official-direct-access.js'
import { providerSchema, type Config } from '../../config/schema.js'
import { prepareModelRuntime, resolveModelRuntime, beginModelUserScope, prepareRuntimeContext, type ModelRuntimeDeps } from '../../models/model-runtime.js'
import { OfficialError, type Binding, type Catalog } from '../../models/official-contract.js'
import { createProviderClient } from '../factory.js'
import { DEFAULT_CAPABILITIES } from '../provider.js'
import { FallbackStreamClient } from '../fallback-client.js'
import { projectOfficialInferenceError } from '../request-authorization.js'
import type { StreamCallbacks } from '../stream-client.js'
import { withStructuredRetry } from '../retry-engine.js'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { generateImage } from '../image-gen-client.js'
import { createOfficialTransportFixture as fixture, wires } from './official-transport-fixture.js'
import { currentExecutionScope, withExecutionContinuity } from '../execution-continuity.js'
const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }
const request = () => ({ model: 'fixture-model', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 100 })

test('actual serve welcome dependency assembly carries direct authority into native HTTP dispatch', async () => {
  const owned = await fixture('openai', undefined, 'binding-1', true)
  try {
    owned.binding.billingMode = 'server'
    const identity = owned.deps.captureIdentity()!
    const source = readFileSync(new URL('../../server/serve.ts', import.meta.url), 'utf8')
    const parsed = ts.createSourceFile('serve.ts', source, ts.ScriptTarget.Latest, true)
    const expressions: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'prepareOfficialSession') {
        function collect(child: ts.Node): void {
          if (ts.isVariableDeclaration(child) && child.name.getText(parsed) === 'deps' && child.initializer) expressions.push(child.initializer.getText(parsed))
          ts.forEachChild(child, collect)
        }
        collect(node.initializer)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    assert.equal(expressions.length, 1)
    const compiled = ts.transpileModule('const deps = ' + expressions[0], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const deps = runInNewContext(compiled + '\ndeps', { identity, Date, defaultModelRuntimeDeps: owned.deps, getOfficialCatalog: owned.deps.getCatalog, getOfficialCredential: owned.deps.getCredential, getOfficialPriceQuote: owned.deps.getQuote, withCurrentOfficialIdentity: owned.deps.withIdentity }) as ModelRuntimeDeps
    const runtime = await resolveModelRuntime(owned.input, deps)
    const before = owned.destinations.length
    const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    let text = ''
    await client.stream(request(), { ...callbacks, onTextDelta(value) { text += value } })
    assert.equal(text, 'ok')
    assert.deepEqual(owned.destinations.slice(before), ['https://supplier.invalid/v1/chat/completions'])
    assert.equal(owned.calls[0]?.headers.authorization, 'Bearer sk-synthetic-direct-owned')
    assert.equal(owned.directGrants, 1)
    assert.equal(owned.quoteCount, 0)
  } finally { await owned.close() }
})

test('native direct stream stops delivering when background renewal confirms revocation', { timeout: 20000 }, async () => {
  const owned = await fixture('openai', undefined, 'binding-1', true)
  const identity = owned.deps.captureIdentity()!, grant = await owned.deps.getDirectAccess!(identity)
  let now = Date.now(), denied = false
  const access = createOfficialDirectAccess({ enabled: () => true, origins: () => ['https://supplier.invalid'], epoch: () => 0, now: () => now, exchange: async () => {
    if (denied) throw new OfficialError('credential_revoked')
    return grant
  } })
  Object.assign(owned.deps, { getDirectAccess: access.get, peekDirectAccess: access.peek, directSignal: access.signal, invalidateDirectAccess: access.invalidate })
  owned.binding.billingMode = 'server'
  let response: import('node:http').ServerResponse | undefined, stream: Promise<void> | undefined, output = '', streamError: unknown, first!: () => void
  const started = new Promise<void>(resolve => { first = resolve })
  try {
    owned.setResponse(current => { response = current; current.setHeader('content-type', 'text/event-stream'); current.write('data: {"choices":[{"delta":{"content":"before-denial"},"finish_reason":null}]}\n\n') })
    const runtime = await resolveModelRuntime(owned.input, owned.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    stream = client.stream(request(), { ...callbacks, onTextDelta(value) { output += value; first() }, onError(error) { streamError = error } }).catch(error => { streamError = error })
    await Promise.race([started, stream.then(() => { throw Error('stream ended before renewal') })])
    const signal = access.signal(identity)
    denied = true; now += 280000
    await access.get(identity); await new Promise<void>(resolve => setImmediate(resolve))
    response!.end('data: {"choices":[{"delta":{"content":"after-denial"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    await stream
    assert.equal(signal.aborted, true)
    assert.equal(output.includes('after-denial'), false)
    assert.ok(streamError)
    assert.equal(owned.calls.length, 1)
  } finally { response?.end(); access.clear(); await stream; await owned.close() }
})

test('a restarted AUTO client negotiates its legacy grant before pinning the first direct conversation', async () => {
  const owned = await fixture('openai', undefined, 'binding-1', false)
  owned.binding.billingMode = 'server'
  let negotiations = 0
  try {
    assert.equal((await owned.deps.getCredential(owned.deps.captureIdentity()!)).directAvailable, undefined)
    const broker = createOfficialModelBroker({ home: owned.home, configuration: { gatewayOrigin: 'https://gateway.invalid', gatewayOrigins: ['https://gateway.invalid'], supplierOrigins: ['https://supplier.invalid'] }, fetchImpl: async (url, init) => {
      const response = await owned.fetchImpl(url, init)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      if (String(url).endsWith('/tui-model-bootstrap') && body.transport !== 'direct') {
        negotiations++
        const envelope = await response.json()
        assert.ok(envelope && typeof envelope === 'object' && 'data' in envelope)
        assert.ok(envelope.data && typeof envelope.data === 'object')
        return Response.json({ ...envelope, data: { ...envelope.data, directAvailable: true } }, { status: response.status, headers: response.headers })
      }
      return response
    } })
    const deps = { ...owned.deps, captureIdentity: broker.captureOfficialIdentity, withIdentity: broker.withCurrentOfficialIdentity, getCatalog: broker.getOfficialCatalog, getQuote: broker.getOfficialPriceQuote, getCredential: broker.getOfficialCredential, getDirectAccess: broker.getOfficialDirectAccess, peekDirectAccess: broker.peekOfficialDirectAccess, directSignal: broker.getOfficialDirectSignal, invalidateDirectAccess: broker.invalidateOfficialDirectAccess }
    const prepared = await prepareModelRuntime(owned.input, deps)
    const afterStartup = owned.destinations.length, directGrants = owned.directGrants
    deps.getCatalog = async () => { throw Error('unexpected warm catalog lookup') }
    deps.getQuote = async () => { throw Error('unexpected warm quote lookup') }
    deps.getCredential = async () => { throw Error('unexpected warm credential lookup') }
    for (let turn = 0; turn < 2; turn++) {
      const runtime = await resolveModelRuntime({ ...owned.input, prepared }, deps)
      let output = ''
      await createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth }).stream(request(), { ...callbacks, onTextDelta(value) { output += value } })
      assert.equal(output, 'ok')
    }
    assert.equal(negotiations, 1)
    assert.equal(directGrants, 1)
    assert.equal(owned.directGrants, directGrants)
    assert.equal(owned.destinations.length, afterStartup + 2)
    assert.deepEqual(owned.destinations.slice(afterStartup), ['https://supplier.invalid/v1/chat/completions', 'https://supplier.invalid/v1/chat/completions'])
    assert.equal(owned.quoteCount, 0)
  } finally { await owned.close() }
})

test('prepared official policy and stable credential principal reach the real beforeSend through renewal', async () => {
  const owned = await fixture()
  try {
    owned.shortCredentials()
    owned.binding.thinkingPolicy = 'reasoning_effort'
    owned.setResponse(response => { owned.setResponse(undefined); response.statusCode = 429; response.end(JSON.stringify({ version: 1, requestId: 'rate', error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 1, scope: 'account' } })) })
    const runtime = await resolveModelRuntime(owned.input, owned.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth })
    const principals: Array<string | undefined> = []
    const traced = withExecutionContinuity({ async stream(input, handlers, signal) {
      const scope = currentExecutionScope()!
      const check = scope.beforeSend
      scope.beforeSend = (url, body, principal) => {
        assert.equal(body.reasoning_effort, 'high')
        principals.push(principal)
        check?.(url, body, principal)
      }
      await client.stream(input, handlers, signal)
    } }, { provider: 'official', model: runtime.modelId })
    await traced.stream({ ...request(), reasoning_effort: 'high', prefixProbe: true }, callbacks)
    assert.equal(principals.length, 2)
    assert.match(principals[0]!, /^[a-f0-9]{64}$/)
    assert.equal(principals[0], principals[1])
    assert.notEqual(owned.calls[0]!.headers.authorization, owned.calls[1]!.headers.authorization)
    assert.equal(owned.quoteCount, 1)
  } finally { await owned.close() }
})


test('server managed billing sends two turns without per-message directory or quote requests', async () => {
  const owned = await fixture()
  try {
    Object.assign(owned.binding, { billingMode: 'server' })
    const prepared = await prepareModelRuntime(owned.input, owned.deps)
    for (let turn = 0; turn < 2; turn++) {
      const runtime = await resolveModelRuntime({ ...owned.input, prepared }, owned.deps)
      const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, auth: runtime.auth, requestAuth: runtime.requestAuth })
      await client.stream(request(), callbacks)
      const directory = await owned.deps.getCatalog(owned.deps.captureIdentity()!, 'agent')
      assert.equal(directory.models[0]?.id, 'fixture-model')
    }
    assert.equal(owned.calls.length, 2)
    assert.equal(owned.catalogCount, 1)
    assert.equal(owned.quoteCount, 0)
    assert.notEqual(owned.calls[0]?.headers['x-request-id'], owned.calls[1]?.headers['x-request-id'])
    for (const call of owned.calls) {
      assert.match(String(call.headers['x-request-id']), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
      assert.equal(call.headers['x-tianshu-billing-mode'], 'server')
      assert.equal(call.headers['x-tianshu-binding-id'], 'binding-1')
      assert.equal(call.headers['x-tianshu-quote-id'], undefined)
      assert.equal(call.headers['x-tianshu-pricing-revision'], undefined)
      assert.equal(call.headers['x-tianshu-catalog-revision'], undefined)
    }
    await owned.replaceAccount()
    await assert.rejects(resolveModelRuntime({ ...owned.input, prepared }, owned.deps), OfficialError)
    assert.equal(owned.calls.length, 2)
  } finally { await owned.close() }
})

test('native direct inference bypasses gateway and every per-send control lookup while retaining account fences', async () => {
  const owned = await fixture('openai', undefined, 'binding-1', true)
  try {
    owned.binding.billingMode = 'server'
    const prepared = await prepareModelRuntime(owned.input, owned.deps)
    assert.equal(owned.directGrants, 1)
    const before = owned.destinations.length
    owned.deps.getCatalog = async () => { throw Error('per-send catalog must not run') }
    owned.deps.getQuote = async () => { throw Error('per-send quote must not run') }
    owned.deps.getCredential = async () => { throw Error('per-send gateway renewal must not run') }
    for (const turn of [1, 2]) {
      const runtime = await resolveModelRuntime({ ...owned.input, prepared }, owned.deps)
      assert.ok(!JSON.stringify(runtime).includes('sk-synthetic-direct'))
      const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
      let text = ''
      const traced = withExecutionContinuity({ async stream(input, handlers, signal) {
        assert.equal(currentExecutionScope()?.sessionId, 'synthetic-native-private-session')
        await client.stream(input, handlers, signal)
      } }, { provider: 'official', model: runtime.modelId, sessionId: 'synthetic-native-private-session' })
      await traced.stream({ ...request(), prefixProbe: true }, { ...callbacks, onTextDelta: value => { text += value } })
      assert.equal(text, 'ok', `actual SSE turn ${turn}`)
    }
    assert.deepEqual(owned.destinations.slice(before), ['https://supplier.invalid/v1/chat/completions', 'https://supplier.invalid/v1/chat/completions'])
    assert.equal(owned.directGrants, 1)
    assert.equal(owned.quoteCount, 0)
    for (const call of owned.calls) {
      assert.equal(call.headers.authorization, 'Bearer sk-synthetic-direct-owned')
      assert.ok(Object.keys(call.headers).every(name => !name.startsWith('x-tianshu-')))
      assert.equal(call.headers.cookie, undefined)
      assert.equal(call.headers['x-request-session'], undefined)
    }
    await owned.replaceAccount()
    await assert.rejects(resolveModelRuntime({ ...owned.input, prepared }, owned.deps), { code: 'account_changed' })
    assert.equal(owned.calls.length, 2)
  } finally { await owned.close() }
})

test('native direct errors and redirect failures never leak supplier diagnostics or retry unknown paid requests', async () => {
  for (const status of [401, 402, 403, 429, 500, 302]) {
    const owned = await fixture('openai', undefined, 'binding-1', true)
    try {
      owned.binding.billingMode = 'server'
      owned.setResponse(response => {
        response.statusCode = status
        if (status === 302) response.setHeader('Location', 'https://foreign.invalid/steal')
        response.end(JSON.stringify({ error: { code: status === 402 ? 'insufficient_quota' : 'unknown', message: 'sk-synthetic-direct-owned internal account trace' } }))
      })
      const runtime = await resolveModelRuntime(owned.input, owned.deps)
      const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
      await assert.rejects(client.stream(request(), callbacks), error => error instanceof OfficialError && !error.message.includes('synthetic') && error.retryable === false && error.code === (status === 401 ? 'credential_revoked' : status === 402 ? 'insufficient_balance' : status === 429 ? 'rate_limited' : 'service_error'))
      assert.equal(owned.calls.length, 1)
    } finally { await owned.close() }
  }
})

test('direct rollout leaves non-chat native protocols on their existing managed route without exporting an unrelated supplier key', async () => {
  const owned = await fixture('anthropic', undefined, 'binding-1', true)
  try {
    owned.binding.billingMode = 'server'
    const runtime = await resolveModelRuntime(owned.input, owned.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    let text = ''
    await client.stream(request(), { ...callbacks, onTextDelta: value => { text += value } })
    assert.equal(text, 'ok')
    assert.equal(owned.directGrants, 0)
    assert.ok(owned.destinations.every(url => !url.startsWith('https://supplier.invalid/')))
    assert.equal(owned.calls[0]?.headers['x-tianshu-billing-mode'], 'server')
    assert.equal(owned.quoteCount, 0)
  } finally { await owned.close() }
})

test('local account replacement cancels an already streaming direct response without sending another request', { timeout: 15000 }, async () => {
  const owned = await fixture('openai', undefined, 'binding-1', true)
  let response: import('node:http').ServerResponse | undefined
  let stream: Promise<void> | undefined
  try {
    owned.binding.billingMode = 'server'
    owned.setResponse(current => { response = current; current.setHeader('content-type', 'text/event-stream'); current.write('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n') })
    const runtime = await resolveModelRuntime(owned.input, owned.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    let first!: () => void
    const started = new Promise<void>(resolve => { first = resolve })
    stream = client.stream(request(), { ...callbacks, onTextDelta: first })
    void stream.catch(() => {})
    await Promise.race([started, stream.then(() => { throw Error('stream ended before logout') })])
    const denied = assert.rejects(stream, error => error instanceof Error && (error.name === 'AbortError' || error instanceof OfficialError))
    await owned.replaceAccount(); await denied
    assert.equal(owned.calls.length, 1)
  } finally { response?.end(); await stream?.catch(() => {}); await owned.close() }
})

test('official retries retain one logical request id while new sends receive a fresh id', async () => {
  const owned = await fixture()
  try {
    Object.assign(owned.binding, { billingMode: 'server' })
    owned.setResponse(response => {
      if (owned.calls.length === 1) {
        response.statusCode = 429
        response.setHeader('Retry-After', '1')
        response.end(JSON.stringify({ version: 1, requestId: 'synthetic-rate-limit', error: { code: 'rate_limited', message: 'rate_limited', retryable: true, retryAfterSeconds: 1, scope: 'account' } }))
        return
      }
      response.setHeader('content-type', 'text/event-stream')
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    const runtime = await resolveModelRuntime(owned.input, owned.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, auth: runtime.auth, requestAuth: runtime.requestAuth })
    await client.stream(request(), callbacks)
    assert.equal(owned.calls.length, 2)
    const logicalId = owned.calls[0]?.headers['x-request-id']
    assert.match(String(logicalId), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    assert.equal(owned.calls[1]?.headers['x-request-id'], logicalId)
    await client.stream(request(), callbacks)
    assert.equal(owned.calls.length, 3)
    assert.notEqual(owned.calls[2]?.headers['x-request-id'], logicalId)
    assert.equal(owned.quoteCount, 0)
    assert.equal(owned.catalogCount, 1)
  } finally { await owned.close() }
})

test('official OpenAI clean EOF without DONE is terminal and never retried', async () => {
  const owned = await fixture()
  try {
    Object.assign(owned.binding, { billingMode: 'server' })
    owned.setResponse(response => {
      response.setHeader('content-type', 'text/event-stream')
      response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n')
    })
    const runtime = await resolveModelRuntime(owned.input, owned.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, auth: runtime.auth, requestAuth: runtime.requestAuth })
    await assert.rejects(client.stream(request(), callbacks), (error: unknown) => error instanceof OfficialError && error.code === 'service_error' && !error.retryable)
    assert.equal(owned.calls.length, 1)
    assert.equal(owned.quoteCount, 0)
  } finally { await owned.close() }
})

for (const [protocol] of wires) test(`official_wire_matches_binding_on_all_protocols: ${protocol}`, async () => {
  const f = await fixture(protocol)
  try {
    const prepared = await prepareModelRuntime(f.input, f.deps)
    assert.equal(f.quoteCount, 0, 'startup never freezes a quote')
    const runtime = await resolveModelRuntime({ ...f.input, prepared }, f.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: 'static-must-not-send', maxTokens: 100, requestAuth: runtime.requestAuth })
    await client.stream(request(), callbacks)
    await client.stream({ ...request(), messages: [...request().messages, { role: 'assistant', content: 'tool done' }, { role: 'user', content: 'continue' }] }, callbacks)
    assert.equal(f.quoteCount, 1, 'tool continuations share user quote')
    assert.equal(f.calls.length, 2)
    for (const call of f.calls) {
      assert.equal(call.path, f.binding.path)
      assert.match(String(call.headers.authorization), /^Bearer sk-synthetic-/)
      assert.equal(call.headers['x-api-key'], undefined); assert.equal(call.headers['x-goog-api-key'], undefined); assert.equal(call.headers.cookie, undefined)
      assert.equal(call.headers['x-tianshu-binding-id'], 'binding-1'); assert.equal(call.headers['x-tianshu-catalog-revision'], 'catalog-1'); assert.equal(call.headers['x-tianshu-pricing-revision'], 'price-1'); assert.equal(call.headers['x-tianshu-quote-id'], 'quote-1')
      assert.equal(call.body.thinking, undefined); assert.equal(call.body.reasoning_effort, undefined)
    }
    f.advance(30001)
    await assert.rejects(client.stream(request(), callbacks), (e: unknown) => e instanceof OfficialError && e.code === 'pricing_changed')
    assert.equal(f.calls.length, 2); assert.equal(f.quoteCount, 1)
    f.advance(-30001)
    const next = await resolveModelRuntime({ ...f.input, prepared }, f.deps)
    await createProviderClient(next.provider, next.capabilities, { model: next.modelId, apiKey: '', maxTokens: 100, requestAuth: next.requestAuth }).stream(request(), callbacks)
    assert.equal(f.quoteCount, 2)
  } finally { await f.close() }
})

test('pricing_changed_never_retries_or_falls_back', async () => {
  const f = await fixture()
  try {
    f.setResponse(res => { res.statusCode = 409; res.end(JSON.stringify({ version: 1, requestId: 'safe', error: { code: 'pricing_changed', retryable: true, message: 'DO NOT EXPORT' } })) })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    let fallback = 0
    const client = new FallbackStreamClient(createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: 'must-not-send', maxTokens: 100, requestAuth: runtime.requestAuth }), 'official', [{ name: 'other', create: () => { fallback++; throw Error('fallback') } }])
    await assert.rejects(client.stream(request(), callbacks), (e: unknown) => e instanceof OfficialError && e.code === 'pricing_changed' && e.message === 'pricing_changed')
    assert.equal(f.calls.length, 1); assert.equal(fallback, 0); assert.equal(f.quoteCount, 1)
  } finally { await f.close() }
})

test('official_rate_limit_wait_is_bounded_and_abortable', async () => {
  const f = await fixture()
  try {
    f.setResponse(res => { res.statusCode = 429; res.setHeader('Retry-After', '1'); res.end(JSON.stringify({ version: 1, requestId: 'rate', error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 1, scope: 'account' } })) })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth })
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 100)
    try { await assert.rejects(client.stream(request(), callbacks, ac.signal), (e: unknown) => e instanceof Error && e.name === 'AbortError') } finally { clearTimeout(timer) }
    assert.equal(f.calls.length, 1)
    let attempts = 0
    await assert.rejects(withStructuredRetry(async () => { attempts++; throw new OfficialError('rate_limited', 429, true, 3600, 'account') }, undefined, { maxTotalRetries: 100 }), OfficialError)
    assert.equal(attempts, 1)
  } finally { await f.close() }
})

test('sealed original account cannot become the newly logged-in account; malformed envelopes stay terminal', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareModelRuntime(f.input, f.deps)
    await f.replaceAccount()
    await assert.rejects(beginModelUserScope(prepared), OfficialError)
    assert.equal(f.calls.length, 0)
    assert.equal(projectOfficialInferenceError({ version: 1, requestId: 'x', error: { code: '__proto__', retryable: true } }, 503, null).code, 'service_error')
    assert.equal(projectOfficialInferenceError({ type: 'error', error: { type: 'new_api_error', message: '余额不足 secret' } }, 403, null).code, 'service_error')
    assert.equal(projectOfficialInferenceError({ error: { type: 'new_api_error', code: 'insufficient_user_quota' } }, 403, null).code, 'service_error')
    assert.equal(projectOfficialInferenceError({ version: 1, requestId: 'x', error: { code: 'rate_limit_unavailable', retryable: true } }, 503, null).retryable, false)
  } finally { await f.close() }
})

test('image final requests use managed authorization without static keys', async () => {
  for (const operation of ['image-generation'] as const) {
    const f = await fixture('openai', operation)
    try {
      f.setResponse(res => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 1]).toString('base64') }] })) })
      const runtime = await resolveModelRuntime(f.input, f.deps)
      if (operation === 'image-generation') await generateImage({ baseUrl: runtime.provider.baseUrl, model: runtime.modelId, prompt: 'synthetic', requestAuth: runtime.requestAuth, fetchImpl: f.fetchImpl, lookupImpl: async hostname => { assert.equal(hostname, 'gateway.invalid'); return { address: '8.8.8.8', family: 4 } } })
      assert.equal(f.quoteCount, 1); assert.ok(f.calls.every(call => call.path === f.binding.path && call.headers['x-tianshu-quote-id'] === 'quote-1'))
    } finally { await f.close() }
  }
})

test('official factory rejects borrowed sealed authorizers and unprepared provider views', async () => {
  const a = await fixture()
  let old: Awaited<ReturnType<typeof resolveModelRuntime>>
  try { old = await resolveModelRuntime(a.input, a.deps) } finally { await a.close() }
  const b = await fixture('openai', undefined, 'binding-2')
  try {
    const fresh = await resolveModelRuntime(b.input, b.deps)
    const params = { model: fresh.modelId, apiKey: '', maxTokens: 100, requestAuth: old!.requestAuth }
    assert.throws(() => createProviderClient(fresh.provider, fresh.capabilities, params), OfficialError)
    assert.throws(() => createProviderClient({ ...fresh.provider }, fresh.capabilities, { ...params, requestAuth: fresh.requestAuth }), OfficialError)
    assert.equal(b.calls.length, 0)
  } finally { await b.close() }
})

for (const [protocol, policy, field, expected] of [
  ['openai', 'reasoning_effort', 'reasoning_effort', 'high'],
  ['openai-responses', 'reasoning_effort', 'reasoning', { effort: 'high' }],
  ['anthropic', 'thinking_budget', 'thinking', { type: 'enabled', budget_tokens: 3999 }],
  ['anthropic', 'adaptive', 'output_config', { effort: 'high' }],
  ['gemini', 'gemini_budget', 'generationConfig', { thinkingConfig: { thinkingBudget: 3999 } }],
  ['openai', 'preserved_reasoning', 'reasoning_effort', 'max'],
] as const) test(`published thinking policy reaches actual ${protocol} body: ${policy}`, async () => {
  const f = await fixture(protocol)
  try {
    f.binding.thinkingPolicy = policy
    const runtime = await resolveModelRuntime(f.input, f.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 4000, requestAuth: runtime.requestAuth, reasoningEffort: 'max' })
    const history = [{ role: 'user' as const, content: 'hello' }, { role: 'assistant' as const, content: '', reasoning_content: 'synthetic reasoning', tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'fixture_tool', arguments: '{}' } }] }, { role: 'tool' as const, tool_call_id: 'call-1', content: 'done' }]
    await client.stream({ ...request(), max_tokens: 4000, messages: history }, callbacks)
    const body = f.calls[0]!.body
    if (policy === 'gemini_budget') assert.deepEqual((body[field] as Record<string, unknown>).thinkingConfig, expected.thinkingConfig)
    else assert.deepEqual(body[field], expected)
    if (policy === 'preserved_reasoning') assert.ok(JSON.stringify(body.messages).includes('synthetic reasoning'))
    client.setThinking?.('disabled')
    await client.stream({ ...request(), max_tokens: 4000, messages: history }, callbacks)
    const off = f.calls[1]!.body
    if (policy === 'preserved_reasoning') { assert.deepEqual(off.thinking, { type: 'disabled' }); assert.equal(off.reasoning_effort, 'none'); assert.ok(JSON.stringify(off.messages).includes('synthetic reasoning')) }
    else { assert.equal(off.thinking, undefined); assert.equal(off.reasoning, undefined); assert.equal(off.reasoning_effort, undefined); assert.equal(off.output_config, undefined) }
    if (policy === 'gemini_budget') assert.deepEqual((off.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 0 })
    assert.equal(f.quoteCount, 1)
  } finally { await f.close() }
})

test('unknown or unverified official capability and endpoint overrides fail before inference', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.catalog.models[0]!.contextWindow = null },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.catalog.models[0]!.capabilities!.tools = null },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.binding.capabilities!.tools = false },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.binding.thinkingPolicy = 'invented' },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.binding.requiredHeaders = { Authorization: 'never-send' } },
  ]) {
    const f = await fixture()
    try { mutate(f); await assert.rejects(resolveModelRuntime(f.input, f.deps), OfficialError); assert.equal(f.calls.length, 0) } finally { await f.close() }
  }
  assert.equal(providerSchema.safeParse({ name: 'official', auth: { type: 'tianshu-account' }, apiKey: 'forbidden', baseUrl: 'https://evil.invalid' }).success, false)
})

test('accepted stream completes through quote expiry, while next submission stays closed', async () => {
  const f = await fixture()
  try {
    f.setResponse(res => { res.setHeader('content-type', 'text/event-stream'); res.write('data: {"choices":[{"delta":{"content":"accepted"},"finish_reason":null}]}\n\n'); f.advance(30001); res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth })
    let text = ''
    await client.stream(request(), { ...callbacks, onTextDelta(delta) { text += delta } })
    assert.equal(text, 'accepted')
    await assert.rejects(client.stream(request(), callbacks), OfficialError)
    assert.equal(f.calls.length, 1); assert.equal(f.quoteCount, 1)
  } finally { await f.close() }
})

test('official rate retry retains quote and rechecks identity while waiting', async () => {
  const f = await fixture()
  try {
    let replacing: Promise<void> | undefined
    f.setResponse(res => { res.statusCode = 429; res.end(JSON.stringify({ version: 1, requestId: 'rate', error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 1, scope: 'account' } })); replacing = f.replaceAccount() })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth })
    await assert.rejects(client.stream(request(), callbacks), OfficialError)
    await replacing
    assert.equal(f.calls.length, 1); assert.equal(f.quoteCount, 1)
  } finally { await f.close() }
})

test('official redirects never reach a second server and image downloads carry no inference credential', async () => {
  const secondCalls: IncomingMessage['headers'][] = []
  const second = createServer((req, res) => { secondCalls.push(req.headers); res.end('unexpected') })
  await new Promise<void>(resolve => second.listen(0, '127.0.0.1', resolve))
  const f = await fixture()
  try {
    f.setResponse(res => { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${(second.address() as { port: number }).port}/secret`); res.end() })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    await assert.rejects(createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth }).stream(request(), callbacks), OfficialError)
    assert.equal(secondCalls.length, 0); assert.equal(f.calls.length, 1)
  } finally { await f.close(); second.closeAllConnections(); await new Promise<void>(resolve => second.close(() => resolve())) }
  const img = await fixture('openai', 'image-generation')
  try {
    img.setResponse(res => res.end(JSON.stringify({ data: [{ url: 'https://download.invalid/image.png' }] })))
    const runtime = await resolveModelRuntime(img.input, img.deps)
    let downloads = 0
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).startsWith('https://download.invalid/')) { downloads++; const headers = new Headers(init?.headers); assert.equal(headers.get('authorization'), null); assert.equal(headers.get('x-tianshu-quote-id'), null); return new Response(new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]), { headers: { 'content-type': 'image/png' } }) }
      return img.fetchImpl(url, init)
    }
    const result = await generateImage({ baseUrl: runtime.provider.baseUrl, model: runtime.modelId, prompt: 'synthetic', requestAuth: runtime.requestAuth, fetchImpl, lookupImpl: async () => ({ address: '8.8.8.8', family: 4 }) })
    assert.equal(result.source, 'url'); assert.equal(downloads, 1)
  } finally { await img.close() }
})

for (const [protocol] of wires) test(`actual ${protocol} tool-call finish and tool-result continuation retain one quote`, async () => {
  const f = await fixture(protocol)
  try {
    const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
    const packets: Record<Binding['protocol'], string> = {
      openai: data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }] }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
      'openai-responses': data({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-1', name: 'fixture_tool', arguments: '{}' } }) + data({ type: 'response.completed', response: { status: 'completed', output: [] } }),
      anthropic: data({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'fixture_tool', input: {} } }) + data({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }) + data({ type: 'content_block_stop', index: 0 }) + data({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + data({ type: 'message_stop' }),
      gemini: data({ candidates: [{ content: { parts: [{ functionCall: { name: 'fixture_tool', args: {} } }], role: 'model' }, finishReason: 'STOP' }] }),
    }
    f.setResponse(res => { res.setHeader('content-type', 'text/event-stream'); res.end(packets[protocol]) })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth })
    const blocks: Array<{ type: string }> = [], stops: string[] = []
    await client.stream({ ...request(), tools: [{ type: 'function', function: { name: 'fixture_tool', description: 'Synthetic tool', parameters: { type: 'object', properties: {} } } }] }, { ...callbacks, onContentBlock(block) { blocks.push(block) }, onStopReason(reason) { stops.push(reason) } })
    assert.ok(blocks.some(block => block.type === 'tool_use'))
    assert.equal(stops.at(-1), 'tool_use')
    f.setResponse(undefined)
    await client.stream({ ...request(), messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'synthetic-tool-result' }] }, callbacks)
    assert.ok(JSON.stringify(f.calls[1]!.body).includes('synthetic-tool-result'))
    assert.equal(f.quoteCount, 1); assert.equal(f.calls[1]!.headers['x-tianshu-quote-id'], 'quote-1')
  } finally { await f.close() }
})

test('retry uses refreshed credential with the same accepted quote', async () => {
  const f = await fixture()
  try {
    f.shortCredentials()
    f.setResponse(res => { f.setResponse(undefined); res.statusCode = 429; res.end(JSON.stringify({ version: 1, requestId: 'rate', error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 1, scope: 'account' } })) })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    await createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth }).stream(request(), callbacks)
    assert.equal(f.calls.length, 2); assert.equal(f.quoteCount, 1)
    assert.notEqual(f.calls[0]!.headers.authorization, f.calls[1]!.headers.authorization)
    assert.equal(f.calls[0]!.headers['x-tianshu-quote-id'], f.calls[1]!.headers['x-tianshu-quote-id'])
  } finally { await f.close() }
})

test('delayed quote result from original account cannot authorize replacement account', async () => {
  const f = await fixture()
  let release!: () => void, arrived!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { arrived = resolve })
  try {
    const deps = { ...f.deps, async getQuote(...args: Parameters<ModelRuntimeDeps['getQuote']>) { const quote = await f.deps.getQuote(...args); arrived(); await gate; return quote } }
    const prepared = await prepareModelRuntime(f.input, deps)
    const pending = beginModelUserScope(prepared)
    const rejected = assert.rejects(pending, OfficialError)
    await ready; await f.replaceAccount(); release(); await rejected
    assert.equal(f.calls.length, 0)
  } finally { release(); await f.close() }
})

for (const [protocol] of wires) test(`official ${protocol} stream errors are terminal and diagnostics contain no raw body`, async () => {
  const f = await fixture(protocol)
  try {
    f.setResponse(res => { res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ type: 'error', error: { message: 'raw-private-upstream-value' } })}\n\n${protocol === 'openai' ? 'data: [DONE]\n\n' : ''}`) })
    const runtime = await resolveModelRuntime(f.input, f.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth })
    const diagnostics: unknown[] = []
    await assert.rejects(client.stream(request(), { ...callbacks, onStreamAttemptAborted(info) { diagnostics.push(info) } }), (error: unknown) => error instanceof OfficialError && error.message === 'service_error')
    assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(diagnostics).includes('raw-private-upstream-value'))
    await assert.rejects(client.stream(request(), callbacks), OfficialError)
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

test('native upstream wallet spoof is not authoritative; validated v1 wallet refusal is preserved', async () => {
  for (const trusted of [false, true]) {
    const f = await fixture()
    try {
      f.setResponse(res => { res.statusCode = trusted ? 402 : 403; res.end(JSON.stringify(trusted ? { version: 1, requestId: 'safe-wallet', error: { code: 'insufficient_balance', retryable: false } } : { error: { type: 'new_api_error', code: 'insufficient_user_quota', message: 'raw upstream impersonation' } })) })
      const runtime = await resolveModelRuntime(f.input, f.deps)
      let fallbacks = 0
      const client = new FallbackStreamClient(createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 100, requestAuth: runtime.requestAuth }), 'official', [{ name: 'other', create() { fallbacks++; throw Error('forbidden fallback') } }])
      await assert.rejects(client.stream(request(), callbacks), (error: unknown) => error instanceof OfficialError && error.code === (trusted ? 'insufficient_balance' : 'service_error') && !error.retryable && !error.message.includes('upstream'))
      assert.equal(f.calls.length, 1); assert.equal(fallbacks, 0)
    } finally { await f.close() }
  }
})


test('prepared official views do not share mutable caller authentication or model lists', async () => {
  const f = await fixture()
  try {
    const context = await prepareRuntimeContext(f.input, f.input.modelId, 'agent', f.deps)
    assert.notEqual(context.provider.auth, f.input.provider.auth)
    assert.ok(Object.isFrozen(context.provider.auth))
    const view = context.config.provider.providers.official!
    assert.ok(Object.isFrozen(view)); assert.ok(Object.isFrozen(view.models)); assert.ok(Object.isFrozen(view.auth))
    Object.assign(f.input.provider.auth!, { type: 'api-key' })
    assert.equal(context.provider.auth?.type, 'tianshu-account')
    assert.equal(view.auth?.type, 'tianshu-account')
    assert.throws(() => createProviderClient(view, DEFAULT_CAPABILITIES, { model: 'fixture-model', apiKey: 'caller-key', maxTokens: 100 }), OfficialError)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

for (const [protocol, policy] of [['anthropic', 'thinking_budget'], ['gemini', 'gemini_budget']] as const) {
  for (const effort of ['high', 'max'] as const) test(`budget cap ${protocol} ${effort} to low reaches final body and retains off`, async () => {
    const f = await fixture(protocol)
    try {
      f.binding.thinkingPolicy = policy
      if (effort === 'high') f.input.provider.capabilities.effortCap = { high: 'low' }
      else f.input.provider.models[0]!.capabilities = { effortCap: { max: 'low' } }
      const runtime = await resolveModelRuntime(f.input, f.deps)
      const client = createProviderClient(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: '', maxTokens: 4000, requestAuth: runtime.requestAuth, reasoningEffort: effort })
      await client.stream({ ...request(), max_tokens: 4000 }, callbacks)
      const body = f.calls[0]!.body
      if (protocol === 'anthropic') assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 })
      else assert.deepEqual((body.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 1024 })
      client.setThinking?.('disabled')
      await client.stream({ ...request(), max_tokens: 4000 }, callbacks)
      const off = f.calls[1]!.body
      if (protocol === 'anthropic') assert.equal(off.thinking, undefined)
      else assert.deepEqual((off.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 0 })
      assert.equal(f.quoteCount, 1)
    } finally { await f.close() }
  })
}
