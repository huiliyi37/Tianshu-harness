import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { probeForTestKey, matchModelDefaults } from '../provider-probe-adapter.js'

/** 用 Response 模拟 fetch 返回。node:24 Response 全局可用。 */
function fetchResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })
}

describe('probeForTestKey', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns ok with models and alias-backfilled descriptors on a successful /models', async () => {
    global.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      assert.ok(u.endsWith('/v1/models'), `unexpected url: ${u}`)
      // deepseek-v4-pro + 未知模型：前者回填元数据，后者裸骨架。
      return fetchResponse(200, { data: [{ id: 'deepseek-v4-pro' }, { id: 'custom-unknown-model' }] })
    }) as typeof fetch

    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['deepseek-v4-pro', 'custom-unknown-model'])
    assert.ok(result.descriptors, 'descriptors 必须存在')
    assert.equal(result.descriptors!.length, 2)
    const deepseek = result.descriptors![0]!
    assert.equal(deepseek.id, 'deepseek-v4-pro')
    assert.ok(typeof deepseek.contextWindow === 'number', '已知模型回填 contextWindow')
    const unknown = result.descriptors![1]!
    assert.equal(unknown.id, 'custom-unknown-model')
    assert.equal(unknown.contextWindow, undefined, '未知模型不臆造元数据')
  })

  it('treats a 200 with empty/unparseable model list as ok — empty is data, not failure', async () => {
    global.fetch = mock.fn(async () => fetchResponse(200, { data: [] })) as typeof fetch
    const empty = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' })
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.models, [])
    assert.equal(empty.error, undefined)
    assert.equal(empty.keyless, undefined, '有凭据探测不带 keyless 标记')

    global.fetch = mock.fn(async () => fetchResponse(200, {})) as typeof fetch
    const shapeless = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' })
    assert.equal(shapeless.ok, true)
    assert.deepEqual(shapeless.models, [])

    // keyless 探测的空列表带 keyless 标记——前端据此不显示权限提示。
    const keylessEmpty = await probeForTestKey({ baseUrl: 'https://api.example.com/v1' })
    assert.equal(keylessEmpty.ok, true)
    assert.deepEqual(keylessEmpty.models, [])
    assert.equal(keylessEmpty.keyless, true)
  })

  it('classifies 401 as auth-failed', async () => {
    global.fetch = mock.fn(async () => fetchResponse(401, { error: 'invalid api key' })) as typeof fetch
    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'bad' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'auth-failed')
    assert.equal(result.status, 401)
  })

  it('classifies quota-exhausted 403 as quota (not auth-failed)', async () => {
    global.fetch = mock.fn(async () => fetchResponse(403, { code: 'AllocationQuota.FreeTierOnly' })) as typeof fetch
    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-ok' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'quota')
    assert.equal(result.status, 403)
  })

  it('classifies a 404 with code http-404', async () => {
    global.fetch = mock.fn(async () => fetchResponse(404, { error: 'not found' })) as typeof fetch
    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'http-404')
    assert.equal(result.status, 404)
  })

  // issue #272：该端点不提供 GET /models，但 chat 端点活着——放行并带标记，
  // 让用户能继续配置（前端据此引导手填模型 ID），而不是被硬挡在门外。
  it('404 /models + a live chat endpoint yields ok with modelsUnavailable (issue #272)', async () => {
    global.fetch = mock.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/models')) return fetchResponse(404, { error: 'not found' })
      return new Response('', { status: 405 })
    }) as typeof fetch

    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-live' })
    assert.equal(result.ok, true, '端点存在但不提供 /models —— 不该判失败')
    assert.deepEqual(result.models, [])
    assert.equal(result.modelsUnavailable, true)
    assert.equal(result.error, undefined, '成功路径不带 error')
  })

  it('404 on both /models and the chat endpoint stays http-404 (wrong base path)', async () => {
    global.fetch = mock.fn(async () => fetchResponse(404, { error: 'not found' })) as typeof fetch
    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-live' })
    assert.equal(result.ok, false, '两个端点都不可达 → 连接有效性无法验证')
    assert.equal(result.error, 'http-404')
    assert.equal(result.modelsUnavailable, undefined)
  })

  it('classifies a 5xx with code http-500', async () => {
    global.fetch = mock.fn(async () => fetchResponse(500, { error: 'boom' })) as typeof fetch
    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'http-500')
    assert.equal(result.status, 500)
  })

  it('classifies a network error as network-error', async () => {
    global.fetch = mock.fn(async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    const result = await probeForTestKey({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'network-error')
    assert.equal(result.status, undefined)
  })

  it('probes keyless (no apiKey): no Authorization header is sent and local endpoints pass', async () => {
    let sentAuthorization: string | undefined
    global.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      sentAuthorization = headers.authorization ?? headers.Authorization
      return fetchResponse(200, { data: [{ id: 'local-model' }] })
    }) as typeof fetch

    const result = await probeForTestKey({ baseUrl: 'http://127.0.0.1:11434/v1' })
    assert.equal(result.ok, true, '本地无鉴权端点应探测通过')
    assert.deepEqual(result.models, ['local-model'])
    assert.equal(result.keyless, true, 'keyless 探测应携带 keyless 标记')
    assert.equal(sentAuthorization, undefined, 'keyless 探测不得携带 Authorization 头')
    const calls = (global.fetch as unknown as ReturnType<typeof mock.fn>).mock.calls
    assert.ok(calls.length >= 1)
  })
})

describe('matchModelDefaults（纯本地，零网络）', () => {
  it('精确命中：回填别名表元数据，不计入 inferredIds', () => {
    const { descriptors, inferredIds } = matchModelDefaults(['deepseek-v4-pro'])
    assert.equal(descriptors.length, 1)
    const d = descriptors[0]!
    assert.equal(d.id, 'deepseek-v4-pro')
    assert.ok(typeof d.contextWindow === 'number' && d.contextWindow > 0, '精确命中回填 contextWindow')
    assert.ok(typeof d.maxTokens === 'number' && d.maxTokens > 0, '精确命中回填 maxTokens')
    assert.deepEqual(inferredIds, [], '精确命中不是推断')
  })

  it('fuzzy 高置信命中：回填推断值并列入 inferredIds（rawId 保留）', () => {
    const { descriptors, inferredIds } = matchModelDefaults(['deepseek-v4-flash-0731'])
    const d = descriptors[0]!
    assert.equal(d.id, 'deepseek-v4-flash-0731', 'rawId 必须原样保留（落库 id 要可调用）')
    assert.ok(typeof d.contextWindow === 'number', 'fuzzy 命中回填推断值')
    assert.deepEqual(inferredIds, ['deepseek-v4-flash-0731'], 'fuzzy 命中须透出供 UI 提示复核')
  })

  it('未知模型：裸 { id } 骨架、不臆造元数据、不入 inferredIds', () => {
    const { descriptors, inferredIds } = matchModelDefaults(['zz-definitely-unknown-xyz'])
    const d = descriptors[0]!
    assert.equal(d.id, 'zz-definitely-unknown-xyz')
    assert.equal(d.contextWindow, undefined)
    assert.equal(d.maxTokens, undefined)
    assert.deepEqual(inferredIds, [])
  })

  it('保序且一一对应', () => {
    const ids = ['deepseek-v4-pro', 'zz-unknown-1', 'deepseek-v4-flash-0731']
    const { descriptors } = matchModelDefaults(ids)
    assert.deepEqual(descriptors.map((d) => d.id), ids)
  })

  it('不发起任何网络请求（纯本地能力）', () => {
    const originalFetch = global.fetch
    let called = false
    global.fetch = (async () => { called = true; throw new Error('should not fetch') }) as typeof fetch
    try {
      matchModelDefaults(['deepseek-v4-pro', 'zz-unknown'])
      assert.equal(called, false, 'matchModelDefaults 不得触网')
    } finally {
      global.fetch = originalFetch
    }
  })
})
