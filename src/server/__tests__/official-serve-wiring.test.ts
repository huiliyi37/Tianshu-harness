import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { configSchema } from '../../config/schema.js'
import { runServe } from '../serve.js'

test('actual serve route assembly registers official status behind Bearer while preserving account and quota routes', async () => {
  const config = configSchema.parse({ provider: { default: 'synthetic-local', providers: {
    'synthetic-local': { name: 'synthetic-local', baseUrl: 'http://127.0.0.1:1', protocol: 'openai', models: [{ id: 'synthetic-model', maxTokens: 4096, contextWindow: 128000 }] },
  } } })
  const provider = config.provider.providers['synthetic-local']!
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      assert.ok(address && typeof address !== 'string')
      listener.close(() => resolve(address.port))
    })
  })
  const server = await runServe({ port, host: '127.0.0.1', token: 'synthetic-sidecar', ephemeral: true,
    context: { config, provider, model: provider.models[0]!, apiKey: '', configured: false },
  })
  const url = `http://127.0.0.1:${server.port}`
  try {
    const rejected = await fetch(url + '/official-model/status')
    assert.equal(rejected.status, 401)
    const status = await fetch(url + '/official-model/status', { headers: { authorization: 'Bearer synthetic-sidecar' } })
    assert.equal(status.status, 200)
    assert.equal(status.headers.get('cache-control'), 'no-store')
    assert.equal((await status.json() as { version: number }).version, 2)
    for (const path of ['/account/status', '/config/provider-usage']) {
      const response = await fetch(url + path, { headers: { authorization: 'Bearer synthetic-sidecar' } })
      assert.equal(response.status, 200)
    }
    assert.equal(server.sessions.listAllSessions().length, 0)
  } finally {
    await new Promise<void>(resolve => server.close(resolve))
  }
})
