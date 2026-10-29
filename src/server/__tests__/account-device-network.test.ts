import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect, type Socket, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestDeviceCode } from '../../auth/account.js'
import { buildAccountRoutesFor } from '../account-routes.js'
import { createRouter } from '../index.js'
import { setNetworkConfig } from '../../config/manager.js'
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'

test('actual account route follows saved proxy changes and NO_PROXY without restarting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'account-network-'))
  const keys = ['RIVET_HOME', 'RIVET_CONFIG_PATH', 'RIVET_ACCOUNT_API', 'RIVET_NO_SYSTEM_PROXY', 'NO_PROXY', 'no_proxy']
  const previous = keys.map(key => process.env[key])
  const previousDispatcher = getGlobalDispatcher()
  let globalProxy: ProxyAgent | undefined
  const sockets = new Set<Socket>()
  let tunnels = 0, requests = 0, upstreamStatus = 200
  const upstream = createServer((req, res) => {
    requests++
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = upstreamStatus
    if (upstreamStatus !== 200) { res.end(JSON.stringify({ error: 'private upstream details' })); return }
    res.end(JSON.stringify(req.url?.endsWith('tui-auth-create')
      ? { deviceCode: 'fixture-code', userCode: 'DEMO', verifyUrl: 'https://example.com/auth' } : { ok: true }))
  })
  const proxy = createServer()
  // Undici forwards plain HTTP; HTTPS uses the CONNECT handler below.
  proxy.on('request', (req, res) => {
    tunnels++
    const destination = new URL(req.url!)
    const forwarded = request(destination, { method: req.method, headers: req.headers, agent: false }, response => {
      res.writeHead(response.statusCode!, response.headers)
      response.pipe(res)
    })
    forwarded.on('error', () => { res.statusCode = 502; res.end() })
    req.pipe(forwarded)
  })
  for (const server of [upstream, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  proxy.on('connect', (req, client, head) => {
    tunnels++
    const [host, port] = req.url!.split(':')
    const target = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      client.pipe(target); target.pipe(client)
    })
    sockets.add(target)
    target.on('error', () => client.destroy())
    target.on('close', () => sockets.delete(target))
  })
  try {
    upstream.listen(0, '127.0.0.1'); proxy.listen(0, '127.0.0.1')
    await Promise.all([once(upstream, 'listening'), once(proxy, 'listening')])
    process.env.RIVET_HOME = home
    process.env.RIVET_CONFIG_PATH = join(home, 'config.json')
    process.env.RIVET_ACCOUNT_API = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    process.env.RIVET_NO_SYSTEM_PROXY = '1'
    process.env.NO_PROXY = ''
    process.env.no_proxy = ''
    const cfg = { network: { proxy: 'http://', noProxy: '' } }
    writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify(cfg))
    const route = createRouter(buildAccountRoutesFor('fixture-auth', cfg))
    const auth = { authorization: 'Bearer fixture-auth' }
    const invalid = await route('POST', '/account/device', {}, auth)
    assert.equal(invalid.status, 502)
    assert.deepEqual(invalid.body, { error: 'account-device-proxy-config' })
    assert.equal(requests, 0, 'invalid explicit proxy must not silently send directly')
    cfg.network.proxy = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    setNetworkConfig({ proxy: cfg.network.proxy.replace('http://', '') })
    const result = await route('POST', '/account/device', {}, auth)
    assert.equal(result.status, 200, JSON.stringify({ body: result.body, tunnels, requests }))
    assert.equal(tunnels, 1, 'must use the newly saved proxy')
    cfg.network.noProxy = '*'
    writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify(cfg))
    globalProxy = new ProxyAgent(cfg.network.proxy)
    setGlobalDispatcher(globalProxy)
    assert.equal((await route('POST', '/account/device', {}, auth)).status, 200)
    assert.equal(tunnels, 1, 'updated bypass must apply to cancellation and the new request')
    upstreamStatus = 401
    const failed = await route('POST', '/account/device', {}, auth)
    assert.equal(failed.status, 502)
    assert.deepEqual(failed.body, { error: 'account-device-service-auth' })
  } finally {
    setGlobalDispatcher(previousDispatcher)
    await globalProxy?.destroy()
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
    rmSync(home, { recursive: true, force: true })
  }
})

test('device creation preserves error categories without exposing upstream responses', async () => {
  for (const [status, code] of [[401, 'account-device-service-auth'], [403, 'account-device-forbidden'], [404, 'account-device-endpoint'], [503, 'account-device-service']] as const) {
    await assert.rejects(requestDeviceCode({ fetchImpl: async () => new Response('private upstream details', { status }) }),
      (error: unknown) => error instanceof Error && error.message === code && !error.message.includes('private'))
  }
  for (const [error, code] of [
    [Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), 'account-device-tls'],
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'account-device-timeout'],
  ] as const) {
    await assert.rejects(requestDeviceCode({ fetchImpl: async () => { throw error } }), { message: code })
  }
  await assert.rejects(requestDeviceCode({ fetchImpl: async () => new Response('{}') }), { message: 'account-device-protocol' })
})
