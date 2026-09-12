import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-test-'))
process.env.RIVET_HOME = testDir

import { loadMcpOAuthToken, revokeMcpOAuth, hasMcpOAuthToken, serveCallback, getMcpAccessToken } from '../connector.js'
import { findMcpOAuthProvider } from '../providers.js'
import { resolveOAuthEnv, resolveOAuthHeaders } from '../inject.js'
import { mcpServerConfigSchema } from '../../config.js'
import { TokenStore, type TokenData } from '../../../auth/token-store.js'

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function pickPort(): number {
  // Pick a high ephemeral port unlikely to collide with the fixed REDIRECT_PORT.
  return 15000 + Math.floor(Math.random() * 5000)
}

describe('findMcpOAuthProvider', () => {
  it('finds github provider', () => {
    const p = findMcpOAuthProvider('github')
    assert.ok(p)
    assert.equal(p!.id, 'github')
    assert.ok(p!.authorizeUrl.includes('github.com'))
  })

  it('returns undefined for unknown provider', () => {
    assert.equal(findMcpOAuthProvider('nonexistent'), undefined)
  })
})

// issue #123 — 回调页把 provider 提供的 error 查询参数裸插进 HTML：重定向到
// http://localhost:<port>/auth/callback?error=<svg/onload=…> 即可在 loopback
// 源上执行脚本（反射 XSS）。
describe('serveCallback error reflection', () => {
  it('escapes the error parameter in the callback page', async () => {
    const port = pickPort()
    const state = 'state-xss-1'
    const pending = serveCallback(port, state, 'https://example.com/authorize', 5_000)
    pending.catch(() => { /* error 分支会 reject，本用例只断言页面转义 */ })

    await new Promise(r => setTimeout(r, 200))

    const payload = '<svg/onload=alert(1)>'
    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}&error=${encodeURIComponent(payload)}`)
    const body = await res.text()

    assert.equal(res.status, 400)
    assert.ok(!body.includes('<svg/onload'), 'raw payload must not be reflected')
    assert.ok(body.includes('&lt;svg/onload'), 'payload must be escaped')

    await assert.rejects(pending)
  })
})

describe('resolveOAuthEnv', () => {
  const token = { accessToken: 'gh_token_abc', refreshToken: undefined, expiresAt: Date.now() + 3600_000, provider: 'github', scopes: ['repo'] }
  
  it('maps github token to GITHUB_PERSONAL_ACCESS_TOKEN', () => {
    const env = resolveOAuthEnv('github', token)
    assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, 'gh_token_abc')
  })

  it('maps linear token to LINEAR_API_KEY', () => {
    const env = resolveOAuthEnv('linear', { ...token, provider: 'linear' })
    assert.equal(env.LINEAR_API_KEY, 'gh_token_abc')
  })

  it('uses uppercase provider name for unknown provider', () => {
    const env = resolveOAuthEnv('unknown', token)
    assert.equal(env.UNKNOWN_API_KEY, 'gh_token_abc')
  })
})

describe('resolveOAuthHeaders', () => {
  it('returns Authorization Bearer', () => {
    const token = { accessToken: 'tok', refreshToken: undefined, expiresAt: Date.now() + 3600_000, provider: 'github', scopes: [] }
    const headers = resolveOAuthHeaders('github', token)
    assert.equal(headers.Authorization, 'Bearer tok')
  })
})

describe('mcpServerConfigSchema with auth', () => {
  it('accepts valid oauth config', () => {
    const result = mcpServerConfigSchema.safeParse({
      command: 'npx', args: ['-y', 'test'],
      auth: { type: 'oauth', provider: 'github', scopes: ['repo'] },
    })
    assert.ok(result.success)
  })

  it('rejects invalid auth type', () => {
    const result = mcpServerConfigSchema.safeParse({
      command: 'npx', args: ['-y', 'test'],
      auth: { type: 'invalid', provider: 'github' },
    })
    assert.ok(!result.success)
  })
})

describe('getMcpAccessToken', () => {
  const provider = {
    id: 'github',
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    defaultScopes: ['repo'],
    clientIdHelp: '',
  }

  it('refreshes an expired token and persists the new one', async () => {
    const serverId = 'refresh-test'
    const clientId = 'test-client'

    // Seed an expired token with a refresh token in the MCP OAuth store.
    const expired: TokenData = {
      accessToken: 'old-token',
      refreshToken: 'refresh-123',
      expiresAt: Date.now() - 1000,
    }
    new TokenStore(join(testDir, 'mcp-oauth'), serverId).save(expired)

    const origFetch = global.fetch
    global.fetch = async () => ({
      ok: true,
      text: async () => 'access_token=new-token&refresh_token=refresh-456&expires_in=3600',
    } as Response)

    try {
      const accessToken = await getMcpAccessToken(serverId, provider as any, clientId)
      assert.equal(accessToken, 'new-token')
      const stored = loadMcpOAuthToken(serverId)
      assert.equal(stored?.accessToken, 'new-token')
      assert.equal(stored?.refreshToken, 'refresh-456')
      assert.ok((stored?.expiresAt ?? 0) > Date.now(), 'new token should not be expired')
    } finally {
      global.fetch = origFetch
      revokeMcpOAuth(serverId)
    }
  })

  it('throws when no token exists and refresh is impossible', async () => {
    const serverId = 'missing-token'
    revokeMcpOAuth(serverId)
    await assert.rejects(
      getMcpAccessToken(serverId, provider as any, 'test-client'),
      /No OAuth token/,
    )
  })
})

describe('serveCallback shared redirect server', () => {
  it('multiplexes concurrent OAuth callbacks by state', async () => {
    const port = pickPort()
    const p1 = serveCallback(port, 'state-a', 'http://auth/a')
    const p2 = serveCallback(port, 'state-b', 'http://auth/b')

    // Callbacks may arrive in any order; each resolves its own flow.
    const resB = await fetch(`http://127.0.0.1:${port}/auth/callback?state=state-b&code=code-b`)
    assert.equal(resB.status, 200)
    const resA = await fetch(`http://127.0.0.1:${port}/auth/callback?state=state-a&code=code-a`)
    assert.equal(resA.status, 200)

    const [codeA, codeB] = await Promise.all([p1, p2])
    assert.equal(codeA, 'code-a')
    assert.equal(codeB, 'code-b')
  })

  it('rejects unknown state without disturbing a live flow', async () => {
    const port = pickPort()
    const p1 = serveCallback(port, 'state-only', 'http://auth/only')

    const resUnknown = await fetch(`http://127.0.0.1:${port}/auth/callback?state=unknown&code=code`)
    assert.equal(resUnknown.status, 400)

    const resOk = await fetch(`http://127.0.0.1:${port}/auth/callback?state=state-only&code=code-only`)
    assert.equal(resOk.status, 200)
    const code = await p1
    assert.equal(code, 'code-only')
  })

  it('times out and closes the shared server', async () => {
    const port = pickPort()
    await assert.rejects(
      serveCallback(port, 'state-timeout', 'http://auth/timeout', 50),
      /timed out/,
    )
    // After the last pending flow times out, the server should be closed.
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/auth/callback?state=state-timeout&code=x`),
      /fetch failed|ECONNREFUSED/i,
    )
  })
})
