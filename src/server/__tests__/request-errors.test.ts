import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { setImmediate as nextTick } from 'node:timers/promises'
import { startServer, type RouteHandler } from '../index.js'
import { buildProviderKeyRoutes } from '../config-routes-keys.js'

const apiToken = 'dummy-local-test-auth'
const headers = { Authorization: `Bearer ${apiToken}` }

test('real HTTP errors stay within the request, including malformed provider-key paths', async t => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const server = await startServer(0, {
    ...buildProviderKeyRoutes(apiToken),
    'GET /health': () => ({ status: 200, body: { ok: true } }),
    'GET /sync-error': () => { throw new Error('dummy-private-error-detail') },
    'GET /async-error': async () => { await nextTick(); throw new Error('dummy-private-error-detail') },
    'GET /serialization-error': () => ({ status: 200, body: cyclic }),
  }, apiToken)
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${server.port}`
  for (const path of ['/sync-error', '/async-error', '/serialization-error']) {
    const response = await fetch(base + path, { headers })
    assert.equal(response.status, 500, path)
    assert.deepEqual(await response.json(), { error: 'Internal server error' })
  }
  const badPath = await fetch(base + '/config/providers/dummy/keys/%E0%A4%A', { method: 'DELETE', headers })
  assert.equal(badPath.status, 400)
  assert.deepEqual(await badPath.json(), { error: 'Malformed URL encoding' })
  const health = await fetch(base + '/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })
})

test('a handler that throws after starting a response closes that stream without crashing the server', async t => {
  const streamError: RouteHandler = (_body, _params, _headers, res) => {
    res!.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res!.write('data: started\n\n')
    throw new Error('dummy-stream-error')
  }
  const server = await startServer(0, {
    'GET /stream-error': streamError,
    'GET /health': () => ({ status: 200, body: { ok: true } }),
  }, apiToken)
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  await assert.rejects(async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/stream-error`, { headers })
    await response.text()
  })
  const health = await fetch(`http://127.0.0.1:${server.port}/health`)
  assert.equal(health.status, 200)
  await health.text()
})

test('aborting an incomplete request body does not leave an unhandled read rejection', async t => {
  let routed = false
  const server = await startServer(0, {
    'POST /body': () => { routed = true; return { status: 200 } },
    'GET /health': () => ({ status: 200, body: { ok: true } }),
  }, apiToken)
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  await new Promise<void>(resolve => {
    const client = request({ host: '127.0.0.1', port: server.port, path: '/body', method: 'POST',
      headers: { ...headers, 'Content-Length': '1000' } })
    client.on('error', () => resolve())
    client.write('{')
    client.on('socket', socket => socket.on('connect', () => setTimeout(() => client.destroy(new Error('cancel test body')), 20)))
  })
  await nextTick()
  assert.equal(routed, false)
  const health = await fetch(`http://127.0.0.1:${server.port}/health`)
  assert.equal(health.status, 200)
  await health.text()
})
