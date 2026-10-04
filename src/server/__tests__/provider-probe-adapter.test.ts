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

  // ── issue #272：无 /models 端点（火山方舟 Agent Plan）必须能验证 Key ─────────
  function sseResponse(): Response {
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }

  it('models-unavailable 端点带模型 id 时改走最小补全，ok 反映补全结果', async () => {
    const urls: string[] = []
    global.fetch = mock.fn(async (url: string | URL | Request) => {
      urls.push(String(url))
      return sseResponse()
    }) as typeof fetch

    const result = await probeForTestKey({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      apiKey: 'sk-plan',
      providerName: 'volc-plan',
      probeModel: 'ark-code-latest',
    })
    assert.equal(result.ok, true)
    assert.equal(result.modelsUnavailable, true, '标明端点没有模型列表（前端显示专用指引）')
    assert.deepEqual(result.models, [])
    assert.equal(result.probedModel, 'ark-code-latest')
    assert.equal(urls.some(u => u.includes('/models')), false, `不得请求 /models：${urls.join(', ')}`)
    assert.ok(urls.some(u => u.endsWith('/chat/completions')), '必须向补全端点发请求')
  })

  it('models-unavailable 端点没有模型 id 时返回 models-unavailable（不拿 404 冒充 baseUrl 错）', async () => {
    global.fetch = mock.fn(async () => {
      throw new Error('should not fetch')
    }) as typeof fetch

    const result = await probeForTestKey({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      apiKey: 'sk-plan',
      providerName: 'volc-plan',
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'models-unavailable')
    assert.equal((global.fetch as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 0)
  })

  it('未知端点 /models 404 且带模型 id：回落最小补全，成功即连接有效', async () => {
    const urls: string[] = []
    global.fetch = mock.fn(async (url: string | URL | Request) => {
      const u = String(url)
      urls.push(u)
      return u.endsWith('/models') ? fetchResponse(404, { error: 'not found' }) : sseResponse()
    }) as typeof fetch

    const result = await probeForTestKey({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-x',
      providerName: 'my-relay',
      probeModel: 'some-model',
    })
    assert.equal(result.ok, true)
    assert.equal(result.modelsUnavailable, true)
    assert.equal(result.probedModel, 'some-model')
    assert.deepEqual(urls.map(u => u.replace('https://relay.example.com/v1', '')), ['/models', '/chat/completions'])
  })

  it('回落补全失败时返回补全层的结构化错误（auth-failed），不误报 404 baseUrl', async () => {
    global.fetch = mock.fn(async (url: string | URL | Request) => {
      return String(url).endsWith('/models') ? fetchResponse(404, { error: 'not found' }) : fetchResponse(401, { error: 'invalid key' })
    }) as typeof fetch

    const result = await probeForTestKey({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'bad',
      providerName: 'my-relay',
      probeModel: 'some-model',
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'auth-failed')
    assert.equal(result.status, 401)
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

  it('L3 fuzzy 命中透出 inferredIds 供 UI 标注——推断值不得静默流入默认值（issue #324）', async () => {
    global.fetch = mock.fn(async () =>
      fetchResponse(200, {
        data: [
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-v4-flash-0731' },
          { id: 'zz-definitely-unknown-xyz' },
        ],
      }),
    ) as typeof fetch

    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' })
    assert.equal(result.ok, true)
    // L3 仍在 descriptors 里回填（放行），但必须被点名——消费端据此显示「推断值，请确认」。
    assert.deepEqual(
      result.inferredIds,
      ['deepseek-v4-flash-0731'],
      'fuzzy 命中须透出 rawId，否则推断值会被静默当实测值用',
    )
  })

  it('无 fuzzy 命中时 inferredIds 为空数组——精确命中与未知模型都不算推断（issue #324）', async () => {
    global.fetch = mock.fn(async () =>
      fetchResponse(200, { data: [{ id: 'deepseek-v4-pro' }, { id: 'zz-definitely-unknown-xyz' }] }),
    ) as typeof fetch

    const result = await probeForTestKey({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' })
    assert.deepEqual(result.inferredIds, [], '没有推断值时透出空数组，而非省略字段')
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
