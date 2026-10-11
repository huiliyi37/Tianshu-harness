import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskConfigSecrets } from '../../config/manager.js'
import { configSchema, type Config } from '../../config/schema.js'
import { readTokenLedgerSettings, updateTokenLedgerSettings, DEFAULT_FORUM_ENDPOINT } from '../settings.js'

function fixture() {
  let config = configSchema.parse({ provider: { default: 'deepseek', providers: {} } })
  let writes = 0
  return { deps: { load: () => structuredClone(config), save: (next: Config) => { config = next; writes++ } }, get: () => config, writes: () => writes }
}

test('defaults to local only with a formal endpoint offered and no key echoed', () => {
  const fx = fixture()
  const dto = readTokenLedgerSettings(fx.get())
  assert.equal(dto.enabled, true)
  assert.equal(dto.forum.endpoint, 'https://tianshuharness.com/token/v1/token-usage')
  assert.equal(dto.forum.autoSync, false)
  assert.equal(dto.forum.intervalMinutes, 30)
  assert.equal(dto.forum.apiKeyConfigured, false)
  assert.equal(fx.writes(), 0)
})

test('write-only key, omitted fields preserve key, clear explicitly stops upload', () => {
  const fx = fixture()
  const key = 'tsu_fixture_not_a_real_credential'
  let next = updateTokenLedgerSettings({ forum: { apiKey: key } }, fx.deps)
  assert.equal(next.tokenLedger.forum?.endpoint, DEFAULT_FORUM_ENDPOINT)
  assert.equal(next.tokenLedger.forum?.autoSync, false)
  assert.equal(JSON.stringify(readTokenLedgerSettings(next)).includes(key), false)
  next = updateTokenLedgerSettings({ forum: { autoSync: true, intervalMinutes: 45 } }, fx.deps)
  assert.equal(next.tokenLedger.forum?.apiKey, key)
  assert.equal(next.tokenLedger.forum?.autoSync, true)
  next = updateTokenLedgerSettings({ forum: { apiKey: '' } }, fx.deps)
  assert.equal(next.tokenLedger.forum?.apiKey, undefined)
  assert.equal(next.tokenLedger.forum?.autoSync, false)
})

test('reject invalid input without persisting or exposing candidate key', () => {
  const fx = fixture()
  for (const patch of [{ forum: { intervalMinutes: 0 } }, { forum: { autoSync: true } }, { forum: { endpoint: 'https://user:pass@example.com/' } }, { forum: { apiKey: '***' } }, { forum: { endpoint: 'http://example.com/' } }, { enabled: 'yes' }, { unexpected: true }]) {
    assert.throws(() => updateTokenLedgerSettings(patch, fx.deps))
  }
  assert.equal(fx.writes(), 0)
})


test('generic config show also masks the forum sync credential', () => {
  const config = configSchema.parse({ provider: { default: 'deepseek', providers: {} }, tokenLedger: { forum: { apiKey: 'tsu_fixture_not_real' } } })
  const shown = JSON.stringify(maskConfigSecrets(config))
  assert.equal(shown.includes('tsu_fixture_not_real'), false)
  assert.equal(config.tokenLedger.forum?.apiKey, 'tsu_fixture_not_real')
})


test('bare personal sync keys are redacted from ordinary event text', async () => {
  const { redactText } = await import('../../server/redact.js')
  const key = 'tsu_' + 'a'.repeat(32)
  assert.equal(redactText('pasted ' + key).includes(key), false)
})


test('repository configuration cannot opt into uploads or redirect a personal sync key', async () => {
  const { stripProjectSafetyKeys, findForbiddenProjectSafetyKeys } = await import('../../config/project-trust.js')
  const raw = { tokenLedger: { enabled: true, forum: { endpoint: 'https://attacker.example/upload', autoSync: true } } }
  const stripped = stripProjectSafetyKeys(raw)
  assert.equal((stripped.tokenLedger as { forum?: unknown }).forum, undefined)
  assert.ok(findForbiddenProjectSafetyKeys(raw).includes('tokenLedger.forum'))
  assert.equal(raw.tokenLedger.forum.autoSync, true)
})


test('settings DTO cannot expose credentials from legacy or overridden endpoint URLs', () => {
  const config = configSchema.parse({ provider: { default: 'deepseek', providers: {} }, tokenLedger: { forum: { endpoint: 'https://example.com/upload?key=fixture-secret' } } })
  assert.equal(JSON.stringify(readTokenLedgerSettings(config)).includes('fixture-secret'), false)
  const fx = fixture()
  assert.throws(() => updateTokenLedgerSettings({ forum: { endpoint: 'https://example.com/upload?key=fixture-secret' } }, fx.deps))
})


test('config show masks credential-bearing legacy endpoint URLs without changing storage', () => {
  for (const endpoint of ['https://user:fixture-password@example.com/', 'https://example.com/?key=fixture-secret', 'https://example.com/#fixture-secret', 'invalid-fixture-secret']) {
    const config = configSchema.parse({ provider: { default: 'deepseek', providers: {} }, tokenLedger: { forum: { endpoint } } })
    assert.equal(maskConfigSecrets(config).tokenLedger.forum?.endpoint, '***')
    assert.equal(config.tokenLedger.forum?.endpoint, endpoint)
  }
  const config = configSchema.parse({ provider: { default: 'deepseek', providers: {} }, tokenLedger: { forum: { endpoint: DEFAULT_FORUM_ENDPOINT } } })
  assert.equal(maskConfigSecrets(config).tokenLedger.forum?.endpoint, DEFAULT_FORUM_ENDPOINT)
})
