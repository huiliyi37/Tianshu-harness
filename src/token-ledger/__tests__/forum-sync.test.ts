/**
 * forum-sync 推送客户端测试：结果码联合、重试策略、鉴权头、载荷契约。
 * fetch 全部经注入打桩，不出网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushTokenUsageSnapshot, type FetchLike } from '../forum-sync.js'
import type { TokenUsageSnapshot } from '../types.js'

const SNAPSHOT: TokenUsageSnapshot = {
  version: 1,
  deviceId: 'dev-1',
  deviceName: 'test-machine',
  sentAt: '2026-10-11T00:00:00.000Z',
  totals: { requests: 3, input: 1700, output: 150, cacheRead: 800, cacheCreate: 0, cost: 0.5 },
  days: [{
    date: '2026-10-10', model: 'deepseek-flash', provider: 'deepseek',
    requests: 3, input: 1700, output: 150, cacheRead: 800, cacheCreate: 0, cost: 0.5,
  }],
}

interface Call { url: string; init?: { headers?: Record<string, string>; body?: string } }

function stubFetch(sequence: Array<{ status?: number; throw?: Error }>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const step = sequence[Math.min(i++, sequence.length - 1)]!
    if (step.throw) throw step.throw
    return { status: step.status ?? 200, text: async () => '{"ok":true,"stale":false}' }
  }
  return { fetchImpl, calls }
}

test('未配置 endpoint：no_endpoint，不发请求', async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 200 }])
  const res = await pushTokenUsageSnapshot(SNAPSHOT, { fetchImpl })
  assert.deepEqual(res, { ok: false, code: 'no_endpoint' })
  assert.equal(calls.length, 0)
})

test('2xx：ok；POST JSON + Bearer 头 + 快照载荷', async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 200 }])
  const res = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://forum.example.com/api/token-usage',
    apiKey: 'secret-key',
    fetchImpl,
  })
  assert.deepEqual(res, { ok: true, status: 200 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.init?.headers?.['Content-Type'], 'application/json')
  assert.equal(calls[0]!.init?.headers?.Authorization, 'Bearer secret-key')
  const body = JSON.parse(calls[0]!.init?.body ?? '{}')
  assert.equal(body.version, 1)
  assert.equal(body.deviceId, 'dev-1')
  assert.equal(body.totals.input, 1700)
  assert.equal(body.days.length, 1)
})

test('4xx（非 429）：http_4xx，不重试', async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 401 }, { status: 200 }])
  const res = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://forum.example.com/x', fetchImpl,
  })
  assert.deepEqual(res, { ok: false, code: 'http_4xx', status: 401 })
  assert.equal(calls.length, 1)
})

test('5xx → 重试一次后成功', async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 500 }, { status: 200 }])
  const res = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://forum.example.com/x', fetchImpl, backoffMs: 1,
  })
  assert.deepEqual(res, { ok: true, status: 200 })
  assert.equal(calls.length, 2)
})

test('网络异常 → 重试一次后成功；持续失败返回 network', async () => {
  const boom = new Error('connect ECONNREFUSED')
  const recover = stubFetch([{ throw: boom }, { status: 200 }])
  const res = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://forum.example.com/x', fetchImpl: recover.fetchImpl, backoffMs: 1,
  })
  assert.deepEqual(res, { ok: true, status: 200 })
  assert.equal(recover.calls.length, 2)

  const down = stubFetch([{ throw: boom }])
  const res2 = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://forum.example.com/x', fetchImpl: down.fetchImpl, backoffMs: 1,
  })
  assert.equal(res2.ok, false)
  if (!res2.ok) {
    assert.equal(res2.code, 'network')
    assert.equal(res2.error, undefined)
  }
  assert.equal(down.calls.length, 2) // 1 次尝试 + 1 次重试
})

test('超时（AbortError/TimeoutError）归类为 timeout', async () => {
  const timeoutErr = new Error('The operation timed out')
  timeoutErr.name = 'TimeoutError'
  const { fetchImpl } = stubFetch([{ throw: timeoutErr }])
  const res = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://forum.example.com/x', fetchImpl, retries: 0,
  })
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'timeout')
})

test('429 属瞬态：重试后成功', async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 429 }, { status: 200 }])
  const res = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://forum.example.com/x', fetchImpl, backoffMs: 1,
  })
  assert.deepEqual(res, { ok: true, status: 200 })
  assert.equal(calls.length, 2)
})


test('HTML / empty / rejected JSON cannot confirm usage', async () => {
  for (const receipt of ['<html>login</html>', '{}', '{"ok":false}', '{"ok":true,"stale":true}']) {
    const result = await pushTokenUsageSnapshot(SNAPSHOT, {
      endpoint: 'https://tianshuharness.com/token/v1/token-usage', retries: 0,
      fetchImpl: async () => ({ status: 200, text: async () => receipt }),
    })
    assert.equal(result.ok, false, receipt)
  }
})

test('does not follow redirects or echo credential-bearing transport errors', async () => {
  let redirect: unknown
  const key = 'tsu_fixture_only_not_real'
  const result = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'https://tianshuharness.com/token/v1/token-usage', apiKey: key, retries: 0,
    fetchImpl: async (_url, init) => {
      redirect = (init as { redirect?: string })?.redirect
      throw new Error(`transport failed with Bearer ${key}`)
    },
  })
  assert.equal(redirect, 'error')
  assert.equal(JSON.stringify(result).includes(key), false)
})

test('rejects insecure non-loopback endpoints before sending a key', async () => {
  let calls = 0
  const result = await pushTokenUsageSnapshot(SNAPSHOT, {
    endpoint: 'http://forum.example.com/token', apiKey: 'fixture',
    fetchImpl: async () => { calls++; return { status: 200, text: async () => '{"ok":true,"stale":false}' } },
  })
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
})
