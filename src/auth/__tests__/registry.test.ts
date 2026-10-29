import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthProvider } from '../registry.js'
import { ApiKeyAuth } from '../api-key.js'
import { OAuthAuth } from '../oauth-auth.js'

describe('createAuthProvider', () => {
  it('creates managed account auth without exposing legacy static credentials', async () => {
    const auth = createAuthProvider(
      { type: 'tianshu-account' },
      {},
      'synthetic-unusable-fallback',
    )
    try {
      assert.equal(auth instanceof ApiKeyAuth, false)
      assert.equal(auth.isAuthenticated(), false)
      await assert.rejects(auth.getHeaders(), /auth_required/)
      await assert.rejects(auth.authenticate(), /auth_required/)
    } finally { auth.dispose() }
  })

  it('creates ApiKeyAuth for api-key config', () => {
    const auth = createAuthProvider(
      { type: 'api-key', keyEnv: 'TEST_API_KEY' },
      { TEST_API_KEY: 'sk-test-123' },
    )
    assert.ok(auth instanceof ApiKeyAuth)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('creates ApiKeyAuth from legacy apiKey field', () => {
    const auth = createAuthProvider(
      undefined,
      {},
      'sk-legacy-key',
    )
    assert.ok(auth instanceof ApiKeyAuth)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('prefers authConfig keyEnv over legacy apiKey', async () => {
    const auth = createAuthProvider(
      { type: 'api-key', keyEnv: 'MY_KEY' },
      { MY_KEY: 'from-env' },
      'from-legacy',
    )
    const headers = await auth.getHeaders()
    assert.equal(headers['Authorization'], 'Bearer from-env')
  })

  it('throws when api-key env var is missing and no legacy key', () => {
    assert.throws(
      () => createAuthProvider(
        { type: 'api-key', keyEnv: 'MISSING_KEY' },
        {},
      ),
      /MISSING_KEY/,
    )
  })

  it('creates OAuthAuth for codex provider', () => {
    const auth = createAuthProvider(
      { type: 'oauth', provider: 'codex' },
      {},
    )
    assert.ok(auth instanceof OAuthAuth)
    // isAuthenticated depends on whether ~/.rivet/auth/codex.json exists
    assert.equal(typeof auth.isAuthenticated(), 'boolean')
  })

  it('throws for unknown oauth provider', () => {
    assert.throws(
      () => createAuthProvider(
        { type: 'oauth', provider: 'unknown' as 'codex' },
        {},
      ),
      /Unknown OAuth provider/,
    )
  })
})
