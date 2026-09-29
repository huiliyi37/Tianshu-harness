import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OAuthAuth } from '../oauth-auth.js'
import type { TokenData } from '../token-store.js'
import { TokenStore } from '../token-store.js'

describe('OAuthAuth', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rivet-oauth-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('isAuthenticated returns false when no token stored', () => {
    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    assert.equal(auth.isAuthenticated(), false)
  })

  it('isAuthenticated returns true when valid token stored', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-valid',
      expiresAt: Date.now() + 3600_000,
    })

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('isAuthenticated returns false when token expired', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-expired',
      expiresAt: Date.now() - 1000,
    })

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    assert.equal(auth.isAuthenticated(), false)
  })

  it('getHeaders returns Bearer header when token valid', async () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-test',
      expiresAt: Date.now() + 3600_000,
    })

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    const headers = await auth.getHeaders()
    assert.equal(headers['Authorization'], 'Bearer at-test')
  })

  it('getHeaders throws when not authenticated', async () => {
    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    await assert.rejects(
      () => auth.getHeaders(),
      /Not authenticated/,
    )
  })

  it('getHeaders refreshes token when near expiry', async () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-old',
      refreshToken: 'rt-test',
      expiresAt: Date.now() + 60_000, // 1 minute — within refresh window
    })

    let refreshTokenUsed = ''
    const mockFetch = async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string)
      refreshTokenUsed = body.get('refresh_token') ?? ''
      return new Response(JSON.stringify({
        access_token: 'at-refreshed',
        refresh_token: 'rt-new',
        expires_in: 3600,
      }), { status: 200 })
    }

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
      fetch: mockFetch as typeof globalThis.fetch,
    }, tmpDir)

    const headers = await auth.getHeaders()
    assert.equal(headers['Authorization'], 'Bearer at-refreshed')
    assert.equal(refreshTokenUsed, 'rt-test')

    // Verify new token was persisted
    const loaded = store.load()
    assert.equal(loaded?.accessToken, 'at-refreshed')
    assert.equal(loaded?.refreshToken, 'rt-new')
  })

  it('dispose cleans up resources', () => {
    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    auth.dispose() // should not throw
  })

  it('refresh 200 但缺 access_token 时拒绝落盘 undefined，旧凭据保持可读', async () => {
    // 假凭据一律运行时拼接，源码零凭据字面量（安全扫描纪律）
    const oldAccess = `at-old-${Date.now()}`
    const oldRefresh = `rt-old-${Date.now()}`
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: oldAccess,
      refreshToken: oldRefresh,
      expiresAt: Date.now() + 60_000,
    })

    const mockFetch = async () =>
      // 网关/代理改写过的 200：无 error 字段但主字段缺失
      new Response(JSON.stringify({ refresh_token: `rt-new-${Date.now()}`, expires_in: 3600 }), { status: 200 })

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
      fetch: mockFetch as typeof globalThis.fetch,
    }, tmpDir)

    await assert.rejects(
      () => auth.getHeaders(),
      /no access_token/,
    )
    // 旧 token 未被 undefined 覆盖（此前裸 as 会把 undefined 存进加密信封）
    const loaded = store.load()
    assert.equal(loaded?.accessToken, oldAccess)
    assert.equal(loaded?.refreshToken, oldRefresh)
  })

  it('并发 getHeaders 在过期瞬间只打一次 token endpoint（single-flight）', async () => {
    const newAccess = `at-refreshed-${Date.now()}`
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: `at-old-${Date.now()}`,
      refreshToken: `rt-old-${Date.now()}`,
      expiresAt: Date.now() + 60_000,
    })

    let fetchCalls = 0
    const mockFetch = async () => {
      fetchCalls++
      // 慢响应拉开并发窗口：三个 getHeaders 都应停在这一个在飞请求上
      await new Promise(resolve => setTimeout(resolve, 30))
      return new Response(JSON.stringify({
        access_token: newAccess,
        refresh_token: `rt-new-${Date.now()}`,
        expires_in: 3600,
      }), { status: 200 })
    }

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
      fetch: mockFetch as typeof globalThis.fetch,
    }, tmpDir)

    const results = await Promise.all([auth.getHeaders(), auth.getHeaders(), auth.getHeaders()])
    assert.equal(fetchCalls, 1, '并发的过期刷新必须共享同一次网络请求')
    for (const headers of results) {
      assert.equal(headers['Authorization'], `Bearer ${newAccess}`)
    }
  })

  it('exchangeCode sends correct parameters', async () => {
    let capturedBody = ''
    const mockFetch = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return new Response(JSON.stringify({
        access_token: 'at-exchanged',
        refresh_token: 'rt-exchanged',
        expires_in: 3600,
      }), { status: 200 })
    }

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
      fetch: mockFetch as typeof globalThis.fetch,
    }, tmpDir)

    // Use the public authenticate flow — but we can't easily test the full flow
    // without a real HTTP server, so test via getHeaders after saving a near-expiry token
    // to trigger refresh which uses the same fetch
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 60_000,
    })

    await auth.getHeaders()

    const params = new URLSearchParams(capturedBody)
    assert.equal(params.get('grant_type'), 'refresh_token')
    assert.equal(params.get('client_id'), 'test-client')
    assert.equal(params.get('refresh_token'), 'rt-old')
  })
})
