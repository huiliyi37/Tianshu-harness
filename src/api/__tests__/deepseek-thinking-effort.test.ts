/**
 * DeepSeek thinking-mode 请求体契约测试。
 *
 * 官方文档 (https://api-docs.deepseek.com/zh-cn/guides/thinking_mode) curl 样例：
 *   { "model": "deepseek-v4-pro", "thinking": {"type":"enabled"}, "reasoning_effort": "high" }
 * 即思考模式下 thinking 块与 reasoning_effort **并存**，effort 控制思考强度
 * (high 默认 / max)。
 *
 * BUG（修复前）：openai-client 的 thinking dispatch 对 usesThinkingBlock 提供商
 * (DeepSeek thinkingBlockType='enabled') 只发 body.thinking，**漏发 reasoning_effort**
 * —— 配置的 reasoningEffort='max' 被静默丢弃，DeepSeek 退回服务端默认 effort。
 * reasoning_effort 仅在 else 分支(纯 OpenAI)或 request.reasoning_effort 存在时才发，
 * 而 buildOaiRequest 从不填 request.reasoning_effort。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import type { OaiChatRequest } from '../oai-types.js'

const DEEPSEEK_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-v4-pro',
  maxTokens: 8192,
  providerName: 'deepseek',
  thinking: 'enabled',
  thinkingBlockType: 'enabled',
  effortFormat: 'reasoning_effort',
  reasoningEffort: 'max',
  preservedThinkingProtocol: true,
}

// 捕获 stream() 实际发出的请求体（mock fetch 返回一个立即结束的 SSE 流）。
async function captureBody(config: OpenAIClientConfig, request: OaiChatRequest): Promise<Record<string, unknown>> {
  const orig = globalThis.fetch
  let captured: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  try {
    const client = new OpenAIClient(config)
    const noop: import('../stream-client.js').StreamCallbacks = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }
    await client.stream(request, noop)
  } finally {
    globalThis.fetch = orig
  }
  return captured
}

const baseRequest: OaiChatRequest = {
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 8192,
}

test('DeepSeek thinking 模式：thinking 块与 reasoning_effort 必须并存', async () => {
  const body = await captureBody(DEEPSEEK_CONFIG, baseRequest)

  // thinking 块正确（这部分修复前就对）
  assert.deepEqual(body.thinking, { type: 'enabled' }, 'thinking 块应为 {type:enabled}')

  // 核心契约：配置 reasoningEffort='max' 必须落到线上 body.reasoning_effort
  assert.equal(
    body.reasoning_effort,
    'max',
    `reasoning_effort 应为 'max'（配置值），实际=${JSON.stringify(body.reasoning_effort)} —— 漏发会让 DeepSeek 退回默认 effort`,
  )
})

test('DeepSeek thinking disabled：不发 thinking 块也不发 reasoning_effort', async () => {
  const body = await captureBody(
    { ...DEEPSEEK_CONFIG, thinking: 'disabled' },
    baseRequest,
  )
  assert.equal(body.thinking, undefined, 'disabled 时不应发 thinking 块')
  assert.equal(body.reasoning_effort, undefined, 'disabled 时不应发 reasoning_effort')
})

test('DeepSeek tool-call assistant without reasoning gets empty reasoning_content on wire', async () => {
  const body = await captureBody(DEEPSEEK_CONFIG, {
    ...baseRequest,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
    ],
  })
  const asst = (body.messages as Array<Record<string, unknown>>).find(m => m.role === 'assistant')
  assert.ok(asst, 'assistant message present')
  assert.ok('reasoning_content' in asst!, 'tool-call turn must include reasoning_content field')
  assert.equal(asst!.reasoning_content, '')
})

test('DeepSeek tool-call assistant with reasoning preserves content on wire', async () => {
  const body = await captureBody(DEEPSEEK_CONFIG, {
    ...baseRequest,
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'planning read',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
    ],
  })
  const asst = (body.messages as Array<Record<string, unknown>>).find(m => m.role === 'assistant')
  assert.equal(asst!.reasoning_content, 'planning read')
})

// ── issue #258 ①：内部档位 'off' 不得原样上线 ────────────────────────────────
// 网关（opencode zen 等）的 reasoning_effort 合法枚举是
// none|minimal|low|medium|high|xhigh|ultra|max——没有 'off'。auto-reasoning 对
// 琐碎轮降档到内部值 'off'，旧代码在「无 thinking 块」与「request 级覆盖」两条
// 路径上漏判，把 off 直发后被 serde 枚举校验拒收：
//   invalid_request_error: unknown variant `off`, expected one of none|...|max
// 正确表达：provider 声明 effortCap 时按声明值发，否则**省略该字段**。

const GATEWAY_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: 'sk-test',
  model: 'deepseek-v4.1-flash',
  maxTokens: 8192,
  providerName: 'opencode-go',
  thinking: 'enabled',
  // 网关型：不发 thinking 块，只走 reasoning_effort
  thinkingBlockType: 'none',
  effortFormat: 'reasoning_effort',
  reasoningEffort: 'off',
}

test('网关型 provider：档位 off 未声明映射 → 省略 reasoning_effort（不发 off）', async () => {
  const body = await captureBody(GATEWAY_CONFIG, baseRequest)
  assert.equal(
    body.reasoning_effort,
    undefined,
    `off 是内部档位，不得原样上线（实际=${JSON.stringify(body.reasoning_effort)}）`,
  )
  assert.equal(body.thinking, undefined, 'blockType=none 时不发 thinking 块')
})

test('网关型 provider：effortCap 声明 {off:"none"} → 按声明值发 none', async () => {
  const body = await captureBody({ ...GATEWAY_CONFIG, effortCap: { off: 'none' } }, baseRequest)
  assert.equal(body.reasoning_effort, 'none')
})

test('网关型 provider：effortCap {off:"low"} → 按 provider 事实映射（不硬编码 none）', async () => {
  const body = await captureBody({ ...GATEWAY_CONFIG, effortCap: { off: 'low' } }, baseRequest)
  assert.equal(body.reasoning_effort, 'low')
})

test('request 级 off（auto-reasoning 逐轮降档）：覆盖 provider 默认档并省略字段', async () => {
  const body = await captureBody(
    { ...GATEWAY_CONFIG, reasoningEffort: 'max' },   // provider 默认高档
    { ...baseRequest, reasoning_effort: 'off' },      // 本轮降到 off
  )
  assert.equal(
    body.reasoning_effort,
    undefined,
    '显式 off 必须清掉上面写入的 provider 默认档，否则降档静默失效',
  )
})

test('request 级高档仍照常覆盖（off 的省略语义不误伤正常档位）', async () => {
  const body = await captureBody(
    { ...GATEWAY_CONFIG, reasoningEffort: 'off' },
    { ...baseRequest, reasoning_effort: 'high' },
  )
  assert.equal(body.reasoning_effort, 'high')
})

test('thinking-block 型 provider（DeepSeek）：off 同样省略，max 正常发送', async () => {
  const offBody = await captureBody({ ...DEEPSEEK_CONFIG, reasoningEffort: 'off' }, baseRequest)
  assert.equal(offBody.reasoning_effort, undefined)
  const maxBody = await captureBody(DEEPSEEK_CONFIG, baseRequest)
  assert.equal(maxBody.reasoning_effort, 'max')
})

test('effortCap 夹取在三条写入路径上依然生效（旧独立 clamp 块已并入解析器）', async () => {
  const withBlock = await captureBody(
    { ...DEEPSEEK_CONFIG, effortCap: { max: 'xhigh' } }, baseRequest,
  )
  assert.equal(withBlock.reasoning_effort, 'xhigh', 'thinking-block 路径夹取')

  const gateway = await captureBody(
    { ...GATEWAY_CONFIG, reasoningEffort: 'max', effortCap: { max: 'xhigh' } }, baseRequest,
  )
  assert.equal(gateway.reasoning_effort, 'xhigh', '网关路径夹取')

  const requestLevel = await captureBody(
    { ...GATEWAY_CONFIG, reasoningEffort: 'low' },
    { ...baseRequest, reasoning_effort: 'max' },
  )
  assert.equal(requestLevel.reasoning_effort, 'max', 'request 级不夹取时保持原值')
})

test('生产路径复现：setReasoningEffort("off")（auto-reasoning 的运行期注入）不上线', async () => {
  // config 的静态类型写作 `reasoningEffort?: string`，而 auto-reasoning 是通过
  // setReasoningEffort(effort: string) 在运行期注入的——这条路径没有编译期护栏，
  // 正是 issue #258 里 off 逃到 wire 上的真实入口。此处按该路径复现。
  const orig = globalThis.fetch
  let captured: Record<string, unknown> = {}
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string)
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close() },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  try {
    const client = new OpenAIClient({ ...GATEWAY_CONFIG, reasoningEffort: 'high' })
    client.setReasoningEffort('off')     // ← 琐碎轮：auto-reasoning 降档
    await client.stream(baseRequest, {
      onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {},
      onStopReason: () => {}, onError: () => {},
    } as import('../stream-client.js').StreamCallbacks)
  } finally { globalThis.fetch = orig }
  assert.equal(captured.reasoning_effort, undefined, '运行期降档到 off 后不得把 off 发上线')
})
