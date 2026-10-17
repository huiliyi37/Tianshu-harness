import { it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../index.js'
import { createRoutes } from '../routes.js'
import { guardRuntimeRoutes } from '../runtime-route-guard.js'
import { proModulePresent, proRegistry, type ProPresetEntry } from '../../api/pro-registry.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { __setProGrantPublicKeyForTests } from '../../config/pro-license.js'
import { buildGrantPayload, makeTestSigner, signGrant } from '../../config/__tests__/grant-fixtures.js'
import type { Config } from '../../config/schema.js'

// Keep private integration coverage when src/pro is present; do not swallow loader failures.
it('authenticated native denial survives replay before any Node file observation, while Free tasks continue', { skip: !proModulePresent() && 'closed-source Pro modules are not distributed in public builds' }, async () => {
  const { register } = await import(new URL('../../pro/index.js', import.meta.url).href) as {
    register(registry: typeof proRegistry, config: Config): void
  }
  const { sparkPreset } = await import(new URL('../../pro/spark/preset.js', import.meta.url).href) as { sparkPreset: ProPresetEntry }
  const home = mkdtempSync(join(tmpdir(), 'native-pro-denial-'))
  const keys = ['RIVET_HOME', 'RIVET_DESKTOP', 'RIVET_PRO_GRANT', 'RIVET_PRO_DEVICE_ID']
  const previous = keys.map(key => process.env[key])
  const signer = makeTestSigner()
  const deviceId = 'synthetic-device-denial'
  const grant = signGrant(buildGrantPayload({ deviceId }), signer.privateKey)
  const path = join(home, 'license.json')
  const restore = () => writeFileSync(path, JSON.stringify({ token: grant, lastVerifiedAt: Date.now() }))
  Object.assign(process.env, { RIVET_HOME: home, RIVET_DESKTOP: '1', RIVET_PRO_GRANT: grant, RIVET_PRO_DEVICE_ID: deviceId })
  __setProGrantPublicKeyForTests(signer.publicKeyB64)
  restore()
  const config = {} as Config
  register(proRegistry, config)
  const makeClient = (name: string) => createProviderClient({ ...sparkPreset.provider, name, maxRetries: 0 }, resolveCapabilities(name), {
    apiKey: 'synthetic-key', model: 'deepseek-v4-flash', maxTokens: 128,
  })
  const paid = makeClient('deepseek-spark')
  const free = makeClient('deepseek')
  const transform = proRegistry.getWireTransform('deepseek-spark')!
  let sends = 0
  mock.method(globalThis, 'fetch', async () => {
    sends++
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const apiToken = 'synthetic-native-session'
  const state = { running: true, apiToken }
  let updatePreparing = false
  let ownsSessionStore = true
  const server = await startServer(0, guardRuntimeRoutes(createRoutes(state), () => ({ ownsSessionStore, updatePreparing })), apiToken)
  const post = (authorization?: string, body: unknown = {}) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.port, path: '/runtime/pro-deny', method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
  const task = { model: 'deepseek-v4-flash', messages: [{ role: 'user' as const, content: 'synthetic task' }], max_tokens: 128 }
  const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} }
  try {
    assert.equal((await post()).status, 401)
    assert.equal((await post('Bearer wrong')).status, 401)
    await paid.stream(task, callbacks)
    assert.equal(sends, 1)
    updatePreparing = true
    ownsSessionStore = false
    const ack = await post(`Bearer ${apiToken}`)
    unlinkSync(path)
    restore()
    await assert.rejects(paid.stream(task, callbacks), { name: 'ProAuthorizationError' })
    assert.equal(sends, 1)
    assert.deepEqual(ack, { status: 200, body: { denied: true } })
    assert.throws(() => transform({ messages: [] } as never, 'deepseek-v4-flash'), { name: 'ProAuthorizationError' })
    assert.equal(state.running, true)
    await free.stream(task, callbacks)
    assert.equal(sends, 2)
    assert.deepEqual(await post(`Bearer ${apiToken}`, { denied: false, grant, enabled: true }), ack)
    await assert.rejects(paid.stream(task, callbacks), { name: 'ProAuthorizationError' })
    assert.equal(sends, 2)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    mock.restoreAll()
    __setProGrantPublicKeyForTests(null)
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    rmSync(home, { recursive: true, force: true })
  }
})
