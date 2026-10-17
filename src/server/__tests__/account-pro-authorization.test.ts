import { it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { buildAccountRoutes, type AccountApi } from '../account-routes.js'
import * as account from '../../auth/account.js'
import { cachedAccountSync, type AccountSnapshot } from '../../auth/account-sync.js'
import { __setProGrantPublicKeyForTests, resolveProLicense } from '../../config/pro-license.js'
import { buildGrantPayload, makeTestSigner, signGrant } from '../../config/__tests__/grant-fixtures.js'
import { proModulePresent, proRegistry, type ProPresetEntry } from '../../api/pro-registry.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import type { Config } from '../../config/schema.js'

// Keep private integration coverage when src/pro is present; do not swallow loader failures.
it('real account refresh, encrypted store and failed device restore preserve an independent signed Pro grant and Free auth', { skip: !proModulePresent() && 'closed-source Pro modules are not distributed in public builds' }, async () => {
  const { register } = await import(new URL('../../pro/index.js', import.meta.url).href) as {
    register(registry: typeof proRegistry, config: Config): void
  }
  const { sparkPreset } = await import(new URL('../../pro/spark/preset.js', import.meta.url).href) as { sparkPreset: ProPresetEntry }
  const home = mkdtempSync(join(tmpdir(), 'account-pro-authorization-'))
  const keys = ['RIVET_HOME', 'RIVET_DESKTOP', 'RIVET_PRO_GRANT', 'RIVET_PRO_DEVICE_ID']
  const previous = keys.map(key => process.env[key])
  const signer = makeTestSigner()
  const deviceId = 'synthetic-device-01'
  const grant = signGrant(buildGrantPayload({ deviceId }), signer.privateKey)
  const licensePath = join(home, 'license.json')
  const original = JSON.stringify({ token: grant, lastVerifiedAt: Date.now() })
  Object.assign(process.env, { RIVET_HOME: home, RIVET_DESKTOP: '1', RIVET_PRO_GRANT: grant, RIVET_PRO_DEVICE_ID: deviceId })
  writeFileSync(licensePath, original)
  writeFileSync(join(home, '.device-id'), deviceId)
  __setProGrantPublicKeyForTests(signer.publicKeyB64)
  const credential = `fixture.${Buffer.from(JSON.stringify({ sub: 'synthetic-owner' })).toString('base64url')}.fixture`
  const store = account.accountStore(home)
  store.save({ accessToken: credential, expiresAt: Date.now() + 3_600_000 })
  let snapshot: AccountSnapshot
  let restores = 0
  const api: AccountApi = {
    ...account,
    fetchAccountSnapshot: async access => {
      assert.equal(access, credential)
      return { code: 'ok', elapsedMs: 0, snapshot }
    },
    activateAccountLicense: async (access, licenseId, fingerprint) => {
      assert.equal(access, credential)
      assert.equal(licenseId, 'free-fixture')
      assert.equal(fingerprint, deviceId)
      restores++
      return { code: 'service_error' }
    },
  }
  const router = createRouter(buildAccountRoutes({ apiToken: 'synthetic-account-api', rivetHome: home, account: api }))
  const auth = { authorization: 'Bearer synthetic-account-api' }
  const config = {} as Config
  register(proRegistry, config)
  const client = (name: string) => createProviderClient({ ...sparkPreset.provider, name, maxRetries: 0 }, resolveCapabilities(name), {
    apiKey: 'synthetic-key', model: 'deepseek-v4-flash', maxTokens: 128,
  })
  const paid = client('deepseek-spark')
  const free = client('deepseek')
  let sends = 0
  mock.method(globalThis, 'fetch', async () => {
    sends++
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const task = { model: 'deepseek-v4-flash', messages: [{ role: 'user' as const, content: 'synthetic task' }], max_tokens: 128 }
  const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} }
  try {
    assert.equal((await router('POST', '/account/identity/refresh', {}, {})).status, 401)
    for (const mode of ['unconfirmed', 'free'] as const) {
      const now = Date.now()
      snapshot = {
        version: 1, userId: 'synthetic-owner', deviceBinding: { state: 'bound', licenseId: 'free-fixture' },
        profile: mode === 'unconfirmed' ? { status: 'service_error' } : { status: 'ok', fetchedAt: now, data: {
          avatarUrl: null, founding: null, fetchedAt: now, account: { userId: 'synthetic-owner', email: null, displayName: 'Free fixture' },
        } },
        identity: mode === 'unconfirmed' ? { status: 'service_error' } : { status: 'empty', fetchedAt: now, data: null },
        entitlements: { status: 'ok', fetchedAt: now, data: [
          ...(mode === 'unconfirmed' ? [{ id: 'paid-fixture', plan: 'pro' as const, name: 'Pro', expiresAt: now - 86_400_000,
            status: 'unconfirmed' as const, restorable: false, reason: 'service_error', deviceLimit: null, devicesUsed: null }] : []),
          { id: 'free-fixture', plan: 'basic', name: 'Free', expiresAt: null, status: 'active', restorable: false, reason: 'ok', deviceLimit: 1, devicesUsed: 1 },
        ] },
      }
      const refreshed = await router('POST', '/account/identity/refresh', {}, auth)
      assert.equal(refreshed.status, 200)
      const persisted = cachedAccountSync(account.accountStore(home).load())!
      assert.equal(persisted.snapshot?.deviceBinding?.licenseId, 'free-fixture')
      assert.equal(persisted.snapshot?.profile.status, mode === 'unconfirmed' ? 'service_error' : 'ok')
      assert.equal(persisted.snapshot?.entitlements.data?.at(-1)?.plan, 'basic')
      const status = await router('GET', '/account/status', undefined, auth)
      assert.equal((status.body as { loggedIn: boolean }).loggedIn, true)
      assert.equal(JSON.stringify(status.body).includes(credential), false)
      const restored = await router('POST', '/account/activate-device', { licenseId: 'free-fixture', deviceId }, auth)
      assert.equal(restored.status, 502)
      assert.deepEqual(restored.body, { error: 'service_error' })
      assert.equal(readFileSync(licensePath, 'utf8'), original)
      assert.equal(resolveProLicense(config).enabled, true)
      await paid.stream(task, callbacks)
      await free.stream(task, callbacks)
    }
    assert.equal(restores, 2)
    assert.equal(sends, 4)
  } finally {
    mock.restoreAll()
    __setProGrantPublicKeyForTests(null)
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    rmSync(home, { recursive: true, force: true })
  }
})
