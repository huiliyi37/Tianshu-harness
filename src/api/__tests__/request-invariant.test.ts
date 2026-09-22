/**
 * 请求重建不变式测试。
 *
 * 两个方向都要证：
 * 1. **会响**——同一 request.messages 数组在两次派发之间被原地改写时，真实
 *    client 路径（stub fetch）必须抛出。这正是 2026-07-06 `content +=` 双追加
 *    事故的形状。
 * 2. **不误报**——合规代码（copy-on-write 产出新数组、侧路展开共享数组但字节
 *    不变、同一请求重放）必须一声不响。误报会把一次正常派发变成硬错误。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import {
  RequestInvariantMonitor,
  RequestInvariantError,
  resolveRequestInvariantPolicy,
  compare,
} from '../request-invariant.js'
import { classifyApiError } from '../error-classifier.js'
import type { OaiChatRequest, OaiMessage } from '../oai-types.js'

const CFG: OpenAIClientConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-v4-pro',
  maxTokens: 8192,
  providerName: 'deepseek',
}

/** 一次派发用的最小 request。 */
function req(messages: OaiChatRequest['messages']): OaiChatRequest {
  return { model: 'deepseek-v4-pro', messages, max_tokens: 1024 }
}

/** 用 stub fetch 走真实 client.stream() 路径；返回本次实际上线的消息数组。 */
async function dispatch(client: OpenAIClient, request: OaiChatRequest): Promise<Record<string, unknown>[]> {
  const orig = globalThis.fetch
  let captured: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const parsed = JSON.parse(init.body as string) as { messages: Record<string, unknown>[] }
    captured = parsed.messages
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  try {
    await client.stream(request, {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    })
  } finally {
    globalThis.fetch = orig
  }
  return captured
}

describe('request invariant · 策略解析', () => {
  test('未设 = enforce（缺省即强制）', () => {
    assert.equal(resolveRequestInvariantPolicy({}), 'enforce')
  })
  test('显式关闭的几种写法都落到 off', () => {
    for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
      assert.equal(resolveRequestInvariantPolicy({ RIVET_REQUEST_INVARIANT: v }), 'off', v)
    }
  })
  test('warn 只记不抛', () => {
    assert.equal(resolveRequestInvariantPolicy({ RIVET_REQUEST_INVARIANT: 'warn' }), 'warn')
  })
  test('无法识别的值 fail-closed 到 enforce', () => {
    assert.equal(resolveRequestInvariantPolicy({ RIVET_REQUEST_INVARIANT: 'yes-please' }), 'enforce')
  })
})

describe('request invariant · 监视器', () => {
  test('同一数组两次相同派发 → 静默', () => {
    const m = new RequestInvariantMonitor('enforce')
    const messages: OaiMessage[] = [{ role: 'user', content: 'hi' }]
    const request = req(messages)
    assert.equal(m.observe(request, messages), null)
    assert.equal(m.observe(request, messages), null)
    assert.deepEqual(m.drain(), [])
  })

  test('同一数组，第二次前原地改 content → 违规且归因到下标与角色', () => {
    const m = new RequestInvariantMonitor('warn')
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'bb' },
    ]
    const request = req(messages)
    m.observe(request, messages)
    messages[2]!.content = 'bb-APPENDED' // 原地改写：数组与对象身份都不变
    const violation = m.observe(request, messages)
    assert.ok(violation, '应判违规')
    assert.equal(violation.kind, 'identity_reentry_churn')
    assert.equal(violation.attribution?.index, 2)
    assert.equal(violation.attribution?.role, 'user')
    assert.equal(violation.attribution?.dispatches, 2)
    assert.match(violation.message, /copy-on-write/)
  })

  test('enforce 下抛 RequestInvariantError，带 code 与违规体', () => {
    const m = new RequestInvariantMonitor('enforce')
    const messages: OaiMessage[] = [{ role: 'user', content: 'a' }]
    const request = req(messages)
    m.observe(request, messages)
    messages[0]!.content = 'a-mutated'
    assert.throws(() => m.observe(request, messages), (err: unknown) => {
      assert.ok(err instanceof RequestInvariantError)
      assert.equal(err.code, 'REQUEST_INVARIANT')
      assert.equal(err.violation.attribution?.index, 0)
      return true
    })
  })

  test('合规的 copy-on-write（新数组）→ 静默', () => {
    const m = new RequestInvariantMonitor('enforce')
    const before: OaiMessage[] = [{ role: 'user', content: 'a' }]
    const after: OaiMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
    m.observe(req(before), before)
    assert.equal(m.observe(req(after), after), null)
  })

  test('同一数组被 append（条数变化）也算原地改写', () => {
    const m = new RequestInvariantMonitor('warn')
    const messages: OaiMessage[] = [{ role: 'user', content: 'a' }]
    const request = req(messages)
    m.observe(request, messages)
    messages.push({ role: 'assistant', content: 'b' })
    const violation = m.observe(request, messages)
    assert.ok(violation)
    assert.equal(violation.attribution?.index, 1)
  })

  test('tools 数组变化也被抓（消息级对比对它隐形）', () => {
    const m = new RequestInvariantMonitor('warn')
    const messages: OaiMessage[] = [{ role: 'user', content: 'a' }]
    const request = req(messages)
    m.observe(request, messages, [{ name: 'read_file' }])
    const violation = m.observe(request, messages, [{ name: 'read_file' }, { name: 'bash' }])
    assert.ok(violation)
    assert.match(violation.message, /tools/)
  })

  test('off 策略：不检查、不抛、不留痕', () => {
    const m = new RequestInvariantMonitor('off')
    const messages: OaiMessage[] = [{ role: 'user', content: 'a' }]
    const request = req(messages)
    m.observe(request, messages)
    messages[0]!.content = 'mutated'
    assert.equal(m.observe(request, messages), null)
    assert.deepEqual(m.drain(), [])
  })

  test('warn 策略：记录进 drain（不静默）且不抛', () => {
    const m = new RequestInvariantMonitor('warn')
    const messages: OaiMessage[] = [{ role: 'user', content: 'a' }]
    const request = req(messages)
    m.observe(request, messages)
    messages[0]!.content = 'mutated'
    const violation = m.observe(request, messages)
    assert.ok(violation, 'warn 仍要返回违规体')
    const drained = m.drain()
    assert.equal(drained.length, 1)
    assert.equal(drained[0]!.kind, 'identity_reentry_churn')
    assert.deepEqual(m.drain(), [], 'drain 是 consume-once')
  })

  test('compare 是纯函数：可直接喂两次观察结果', () => {
    const sig = (content: string) => ({ sig: content, len: content.length, role: 'user' })
    assert.equal(compare(
      { sigs: [sig('a')], toolsSig: 't', dispatches: 1 },
      { sigs: [sig('a')], toolsSig: 't', dispatches: 2 },
    ), null)
    const drift = compare(
      { sigs: [sig('a')], toolsSig: 't', dispatches: 1 },
      { sigs: [sig('b')], toolsSig: 't', dispatches: 2 },
    )
    assert.equal(drift?.attribution?.index, 0)
  })
})

describe('request invariant · 真实 client 路径', () => {
  test('同一 request 连发两次（未改写）→ 不抛（零误报基线）', async () => {
    const client = new OpenAIClient(CFG)
    const request = req([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }])
    await dispatch(client, request)
    await dispatch(client, request)
  })

  test('侧路形状（展开主请求、共享 messages 数组）→ 不抛', async () => {
    const client = new OpenAIClient(CFG)
    const main = req([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }])
    await dispatch(client, main)
    // llm-speculation 的真实形状：顶层新对象、messages 数组按引用共享
    const side = { ...main, prefixProbe: undefined } as OaiChatRequest
    assert.equal(side.messages, main.messages, '前提：侧路共享同一 messages 数组')
    await dispatch(client, side)
  })

  test('第二次派发前原地改写共享 messages → 走真实路径抛出', async () => {
    const client = new OpenAIClient(CFG)
    const request = req([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }])
    await dispatch(client, request)
    // 模拟 client 变换层忘了 copy-on-write：直接改共享对象
    const sys = request.messages[0] as { role: string; content: string }
    sys.content = sys.content + '\n\n重复追加的 system 后缀'
    await assert.rejects(
      () => dispatch(client, request),
      (err: unknown) => {
        assert.ok(err instanceof RequestInvariantError, `期望 RequestInvariantError，实际 ${String(err)}`)
        assert.equal(err.violation.attribution?.index, 0)
        assert.equal(err.violation.attribution?.role, 'system')
        return true
      },
    )
  })

  test('违规错误：独占 category、不可重试、不被故障转移接管', () => {
    const err = new RequestInvariantError({
      kind: 'identity_reentry_churn',
      message: 'test',
      attribution: null,
    })
    const classified = classifyApiError(err)
    // 独占 category：FallbackStreamClient.shouldFallback 只认五类上游错误，
    // 落进其中任何一类都会把「一次前缀损坏」变成「悄悄换个 provider 重发」。
    assert.equal(classified.category, 'request_invariant')
    // 不可重试：重试只会重复同一份已损坏的字节。
    assert.equal(classified.retryable, false)
    assert.equal(classified.maxRetries, 0)
  })

  test('不同 client 之间不互相比较（故障转移换 provider 不误判）', async () => {
    const primary = new OpenAIClient(CFG)
    const fallback = new OpenAIClient({ ...CFG, model: 'glm-4.6', providerName: 'glm', preservedThinkingProtocol: true, thinking: 'enabled' })
    const request = req([{ role: 'user', content: 'hi' }])
    await dispatch(primary, request)
    // 换 client = 换 system 后缀与缓存命名空间，属合法重建，不得判违规
    await dispatch(fallback, request)
  })
})
