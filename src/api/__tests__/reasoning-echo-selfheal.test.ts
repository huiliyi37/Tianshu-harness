/**
 * issue #258 ②：网关要求回传 reasoning_content 时的自愈（端到端）。
 *
 * 场景：陌生供应商（无 preservedThinkingProtocol 声明）+ 托管 DeepSeek 思考模型的
 * 网关。客户端默认剥离历史里的思考内容 → 第二轮起被 400 拒收：
 *   The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * 自愈契约：
 *   ① 首次仍按剥离语义发（不猜）→ 被拒；
 *   ② 分类器判 reasoning_echo（可重试一次）→ 重试**保留**思考内容重发；
 *   ③ 重试成功后把 preservedThinkingProtocol 粘到该 client 实例上——同一会话后续
 *      轮次不再白吃一次 400；下一次 stream() 的**第一次**尝试就该带上 reasoning_content；
 *   ④ 降级可见：onReasoningEchoRecovered 必须被调用（wire 形态中途变了）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import type { StreamCallbacks } from '../stream-client.js'
import type { OaiChatRequest } from '../oai-types.js'

const REJECTION = 'OpenAI API error (invalid_request_error): The `reasoning_content` in the thinking mode must be passed back to the API.'

const GATEWAY: OpenAIClientConfig = {
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: 'sk-test',
  model: 'deepseek-v4.1-flash',
  maxTokens: 8192,
  providerName: 'opencode-go',
  thinking: 'enabled',
  thinkingBlockType: 'none',
  effortFormat: 'reasoning_effort',
  // 刻意不声明 preservedThinkingProtocol：模拟「陌生供应商」的默认剥离语义
}

function sseOk(): Response {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n'))
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function errorBody(message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}

/** 两轮历史的会话：第一轮 assistant 带思考内容 + 工具调用。 */
const HISTORY: OaiChatRequest = {
  model: 'deepseek-v4.1-flash',
  max_tokens: 8192,
  messages: [
    { role: 'user', content: '读一下这个文件' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: '我需要先读取文件内容再回答',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'export const a = 1' },
    { role: 'user', content: '继续' },
  ],
}

async function withFetch(handler: (attempt: number) => Response) {
  const orig = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  let attempt = 0
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    return handler(attempt++)
  }) as unknown as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = orig } }
}

function assistantOf(body: Record<string, unknown>): Record<string, unknown> {
  const msgs = body.messages as Array<Record<string, unknown>>
  return msgs.find(m => m.role === 'assistant')!
}

test('陌生网关：先被拒 → 重试保留 reasoning_content → 成功后再粘住实例', async () => {
  // 第 1 次 400（缺 reasoning_content），第 2 次起 200
  const m = await withFetch(attempt => (attempt === 0 ? errorBody(REJECTION) : sseOk()))
  let recovered = 0
  const callbacks = {
    onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {},
    onStopReason: () => {}, onError: () => {},
    onReasoningEchoRecovered: () => { recovered++ },
  } as unknown as StreamCallbacks
  try {
    const client = new OpenAIClient(GATEWAY)
    await client.stream(HISTORY, callbacks)

    assert.equal(m.bodies.length, 2, '应恰好重试一次')
    assert.ok(
      !('reasoning_content' in assistantOf(m.bodies[0]!)),
      '首次不得擅自保留（不猜陌生供应商的协议要求）',
    )
    assert.equal(
      assistantOf(m.bodies[1]!).reasoning_content,
      '我需要先读取文件内容再回答',
      '重试必须把思考内容原样回传',
    )
    assert.equal(recovered, 1, 'wire 形态变了必须上报（静默降级是最贵的 bug 形状）')

    // 下一轮对话（生产形状：每轮 buildOaiRequest 产出**新** messages 数组）：
    // 实例已粘住 preservedThinkingProtocol → 第一次尝试就带 reasoning_content。
    await client.stream({ ...HISTORY, messages: [...HISTORY.messages] }, callbacks)
    assert.equal(m.bodies.length, 3, '新一轮不该再多一次 400 重试')
    assert.equal(
      assistantOf(m.bodies[2]!).reasoning_content,
      '我需要先读取文件内容再回答',
      '后续轮次的首发就该保留思考内容',
    )
  } finally { m.restore() }
})

test('同一 messages 数组再次派发：不得翻转形态（request invariant 硬门禁）', async () => {
  // 侧路复用主请求数组 / 故障转移重放同一 request 都会走这条形状。粘性开关若在
  // 再次派发时改变字节，会撞 REQ-INVARIANT（2026-07-06 事故类）——粘性因此只在
  // 「首次派发这份历史」时生效，同一数组的第二次派发保持剥离语义。
  const m = await withFetch(attempt => (attempt % 2 === 0 ? errorBody(REJECTION) : sseOk()))
  const callbacks = {
    onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {},
    onStopReason: () => {}, onError: () => {},
  } as unknown as StreamCallbacks
  try {
    const client = new OpenAIClient(GATEWAY)
    await client.stream(HISTORY, callbacks)   // 首次派发（array 会被登记）
    // 同一数组再派发一次：必须仍以**剥离**形态首发，且不抛 REQUEST_INVARIANT
    await client.stream(HISTORY, callbacks)
    assert.equal(m.bodies.length, 4, '两次派发各自 400+重试，各 2 发')
    assert.ok(!('reasoning_content' in assistantOf(m.bodies[2]!)), '再次派发的首发不得翻转形态')
  } finally { m.restore() }
})

test('已声明 preservedThinkingProtocol 的 provider：一次成功，零重试零上报', async () => {
  const m = await withFetch(() => sseOk())
  let recovered = 0
  const callbacks = {
    onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {},
    onStopReason: () => {}, onError: () => {},
    onReasoningEchoRecovered: () => { recovered++ },
  } as unknown as StreamCallbacks
  try {
    const client = new OpenAIClient({ ...GATEWAY, preservedThinkingProtocol: true })
    await client.stream(HISTORY, callbacks)
    assert.equal(m.bodies.length, 1)
    assert.equal(assistantOf(m.bodies[0]!).reasoning_content, '我需要先读取文件内容再回答')
    assert.equal(recovered, 0)
  } finally { m.restore() }
})

test('重试仍失败：不粘住假设（保持剥离语义，下轮重新判断）', async () => {
  const m = await withFetch(() => errorBody(REJECTION))
  const callbacks = {
    onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {},
    onStopReason: () => {}, onError: () => {},
  } as unknown as StreamCallbacks
  try {
    const client = new OpenAIClient(GATEWAY)
    await assert.rejects(() => client.stream(HISTORY, callbacks), /reasoning_content/)
    assert.equal(m.bodies.length, 2, '一次性语义：不无限重试')
    // 下一次调用仍是「先剥离」——未经证实的协议要求不固化
    await assert.rejects(() => client.stream(HISTORY, callbacks), /reasoning_content/)
    assert.ok(!('reasoning_content' in assistantOf(m.bodies[2]!)), '第二轮首发仍剥离')
  } finally { m.restore() }
})
