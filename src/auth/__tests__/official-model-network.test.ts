import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as forwardRequest } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { test } from 'node:test'
import { Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici'
import { createOfficialRuntimeFixture } from '../../__tests__/helpers/official-runtime-fixture.js'
import { setNetworkConfig } from '../../config/manager.js'
import { createOfficialModelBroker } from '../official-model-auth.js'
import { accountStore } from '../account.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureConfiguration, officialFixture } from './official-model-auth.test.js'
import { resolveModelRuntime } from '../../models/model-runtime.js'
import { createProviderClient } from '../../api/factory.js'

test('native official sends honor saved routing and bypass a global proxy only for the configured host', async context => {
  const fixture = await createOfficialRuntimeFixture()
  const originalDispatcher = getGlobalDispatcher()
  const sockets = new Set<Socket>()
  let tunnels = 0
  const proxy = createServer((request, response) => {
    const destination = new URL(request.url!)
    assert.equal(destination.origin, fixture.endpoint)
    tunnels++
    const forwarded = forwardRequest(destination, { method: request.method, headers: request.headers, agent: false }, upstream => {
      response.writeHead(upstream.statusCode!, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', () => { response.statusCode = 502; response.end() })
    request.pipe(forwarded)
  })
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const localize = (options: Dispatcher.DispatchOptions): Dispatcher.DispatchOptions => String(options.origin) === 'https://gateway.invalid' ? { ...options, origin: fixture.endpoint } : options
  const proxyDispatch = ProxyAgent.prototype.dispatch, directDispatch = Agent.prototype.dispatch
  context.mock.method(ProxyAgent.prototype, 'dispatch', function (this: ProxyAgent, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) { return proxyDispatch.call(this, localize(options), handler) })
  context.mock.method(Agent.prototype, 'dispatch', function (this: Agent, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) { return directDispatch.call(this, localize(options), handler) })
  let globalProxy: ProxyAgent | undefined
  try {
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    fixture.writeConfig()
    setNetworkConfig({ proxy: proxyUrl, noProxy: '' })
    Object.assign(fixture.binding, { billingMode: 'server' })
    const runtime = await resolveModelRuntime(fixture.input, fixture.deps)
    const client = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    const send = async () => {
      let output = ''
      await client.stream({ model: runtime.modelId, messages: [{ role: 'user', content: 'synthetic-routing' }] }, { onTextDelta(text) { output += text }, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } })
      assert.equal(output, 'ok')
    }
    await send()
    assert.equal(tunnels, 1, 'the actual native inference POST must use the saved proxy')
    globalProxy = new ProxyAgent(proxyUrl)
    setGlobalDispatcher(globalProxy)
    setNetworkConfig({ noProxy: 'gateway.invalid' })
    await send()
    assert.equal(tunnels, 1, 'saved host-specific direct routing must override the global dispatcher')
    setNetworkConfig({ noProxy: 'unrelated.invalid' })
    await send()
    assert.equal(tunnels, 2, 'an unrelated bypass must not change this model route')
    assert.equal(fixture.calls.length, 3)
    assert.equal(fixture.catalogCount, 1)
    assert.equal(fixture.quoteCount, 0)
    for (const call of fixture.calls) {
      assert.equal(call.path, '/v1/chat/completions')
      assert.match(String(call.headers.authorization), /^Bearer sk-synthetic-/)
      assert.equal(call.body.model, runtime.modelId)
    }
  } finally {
    setGlobalDispatcher(originalDispatcher)
    await globalProxy?.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await fixture.close()
  }
})

test('default broker renewal honors a saved proxy independently of bootstrap traffic', async context => {
  const fixture = await officialFixture()
  const previousHome = process.env.RIVET_HOME
  const previousConfig = process.env.RIVET_CONFIG_PATH
  const sockets = new Set<Socket>()
  let renewalRequests = 0
  const proxy = createServer((request, response) => {
    const destination = new URL(request.url!)
    assert.equal(destination.origin, fixture.endpoint)
    if (destination.pathname.endsWith('/tui-auth-refresh')) renewalRequests++
    const forwarded = forwardRequest(destination, { method: request.method, headers: request.headers, agent: false }, upstream => {
      response.writeHead(upstream.statusCode!, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', () => { response.statusCode = 502; response.end() })
    request.pipe(forwarded)
  })
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const localize = (options: Dispatcher.DispatchOptions): Dispatcher.DispatchOptions => ['https://account-fixture.invalid', 'https://gateway.invalid'].includes(String(options.origin)) ? { ...options, origin: fixture.endpoint } : options
  const proxyDispatch = ProxyAgent.prototype.dispatch, directDispatch = Agent.prototype.dispatch
  context.mock.method(ProxyAgent.prototype, 'dispatch', function (this: ProxyAgent, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) { return proxyDispatch.call(this, localize(options), handler) })
  context.mock.method(Agent.prototype, 'dispatch', function (this: Agent, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) { return directDispatch.call(this, localize(options), handler) })
  try {
    await fixture.install('A')
    accountStore(fixture.home).transaction(state => { state.token!.expiresAt = 1; return { value: undefined, write: true } })
    process.env.RIVET_HOME = fixture.home
    process.env.RIVET_CONFIG_PATH = join(fixture.home, 'config.json')
    writeFileSync(process.env.RIVET_CONFIG_PATH, '{}')
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    setNetworkConfig({ proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, noProxy: '' })
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: fixtureConfiguration })
    assert.ok((await broker.getOfficialCredential(broker.captureOfficialIdentity()!)).credential)
    assert.equal(renewalRequests, 1, 'renewal itself must use the saved proxy, not just subsequent model bootstrap')
    assert.equal(fixture.rotations, 1)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    if (previousConfig === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = previousConfig
    await fixture.close()
  }
})

test('default official broker follows saved proxy, environment proxy and live NO_PROXY changes', async (context) => {
  const fixture = await createOfficialRuntimeFixture()
  const localize = (options: Dispatcher.DispatchOptions): Dispatcher.DispatchOptions => {
    const origin = String(options.origin)
    return ['https://account.invalid', 'https://gateway.invalid'].includes(origin) ? { ...options, origin: fixture.endpoint } : options
  }
  const proxyDispatch = ProxyAgent.prototype.dispatch, directDispatch = Agent.prototype.dispatch
  context.mock.method(ProxyAgent.prototype, 'dispatch', function (this: ProxyAgent, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) { return proxyDispatch.call(this, localize(options), handler) })
  context.mock.method(Agent.prototype, 'dispatch', function (this: Agent, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) { return directDispatch.call(this, localize(options), handler) })
  const keys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'RIVET_NO_SYSTEM_PROXY']
  const previous = keys.map(key => process.env[key])
  const sockets = new Set<Socket>()
  let tunnels = 0
  const proxy = createServer()
  proxy.on('request', (request, response) => {
    const destination = new URL(request.url!)
    assert.equal(destination.origin, fixture.endpoint)
    tunnels++
    const forwarded = forwardRequest(destination, { method: request.method, headers: request.headers, agent: false }, upstream => {
      response.writeHead(upstream.statusCode!, upstream.headers)
      upstream.pipe(response)
    })
    forwarded.on('error', () => { response.statusCode = 502; response.end() })
    request.pipe(forwarded)
  })
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  proxy.on('connect', (request, client, head) => {
    assert.equal(request.url, new URL(fixture.endpoint).host)
    tunnels++
    const destination = new URL(fixture.endpoint)
    const target = connect(Number(destination.port), destination.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      client.pipe(target); target.pipe(client)
    })
    sockets.add(target)
    target.on('error', () => client.destroy())
    client.on('error', () => target.destroy())
    target.on('close', () => sockets.delete(target))
  })
  try {
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    process.env.RIVET_NO_SYSTEM_PROXY = '1'
    process.env.NO_PROXY = ''; process.env.no_proxy = ''
    process.env.HTTPS_PROXY = ''; process.env.https_proxy = ''
    fixture.writeConfig()
    setNetworkConfig({ proxy: proxyUrl, noProxy: '' })
    const broker = createOfficialModelBroker({ home: fixture.home })
    const identity = broker.captureOfficialIdentity()!
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models[0]!.id, 'fixture-model')
    assert.ok(tunnels > 0, 'default model listing must use the saved proxy, like quota reads')
    const beforeBypass = tunnels
    setNetworkConfig({ noProxy: '*' })
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models.length, 1)
    assert.equal(tunnels, beforeBypass, 'live NO_PROXY must override the proxy without a restart')
    setNetworkConfig({ proxy: '', noProxy: '' })
    process.env.HTTPS_PROXY = proxyUrl
    assert.equal((await broker.getOfficialCatalog(identity, 'agent')).models.length, 1)
    assert.ok(tunnels > beforeBypass, 'environment proxy must also apply to an existing default broker')
    assert.equal(fixture.calls.length, 0, 'metadata validation must never perform inference')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    await fixture.close()
  }
})

test('explicit official broker transport remains authoritative over saved proxy settings', async () => {
  const fixture = await createOfficialRuntimeFixture()
  try {
    fixture.writeConfig()
    setNetworkConfig({ proxy: 'http://invalid:1', noProxy: '' })
    const broker = createOfficialModelBroker({ home: fixture.home, fetchImpl: fixture.fetchImpl })
    assert.equal((await broker.getOfficialCatalog(broker.captureOfficialIdentity()!, 'agent')).models[0]!.id, 'fixture-model')
    assert.equal(fixture.calls.length, 0)
  } finally { await fixture.close() }
})
