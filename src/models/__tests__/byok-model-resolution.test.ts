import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerSchema, type Config } from '../../config/schema.js'
import { useFixtureHome } from '../../server/__tests__/fixture-home.js'
import { resolveProviderForModel } from '../model-runtime.js'

test('partial server snapshots preserve unauthenticated OAuth scanning and keyed BYOK resolution without network settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'official-byok-resolution-'))
  const restore = useFixtureHome(home)
  const previous = process.env.RIVET_CODEX_CLI_AUTH
  process.env.RIVET_CODEX_CLI_AUTH = join(home, 'absent-cli-auth.json')
  try {
    const oauth = providerSchema.parse({ name: 'oauth', auth: { type: 'oauth', provider: 'codex' }, baseUrl: 'https://oauth.invalid', models: [{ id: 'shared' }] })
    const byok = providerSchema.parse({ name: 'byok', apiKey: 'synthetic-byok', baseUrl: 'https://byok.invalid', models: [{ id: 'shared' }] })
    const config = { provider: { default: 'byok', providers: { oauth, byok } } } as unknown as Config
    const context = { config, provider: byok, apiKey: 'synthetic-byok' }
    const oauthTarget = resolveProviderForModel(context, 'shared', 'oauth')
    assert.ok(oauthTarget && !('error' in oauthTarget))
    assert.equal(oauthTarget.auth?.isAuthenticated(), false)
    const byokTarget = resolveProviderForModel(context, 'shared', 'byok')
    assert.ok(byokTarget && !('error' in byokTarget))
    assert.equal(byokTarget.providerName, 'byok')
    assert.equal(byokTarget.apiKey, 'synthetic-byok')
  } finally {
    if (previous === undefined) delete process.env.RIVET_CODEX_CLI_AUTH
    else process.env.RIVET_CODEX_CLI_AUTH = previous
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})
