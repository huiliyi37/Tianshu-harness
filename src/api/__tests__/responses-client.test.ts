/**
 * ResponsesClient 测试（issue #239，protocol 'openai-responses'）。
 *
 * 覆盖三层契约：
 *   1. 请求体映射（instructions / function_call / function_call_output / 扁平
 *      tools / max_output_tokens / reasoning.effort 夹取 / 多模态 / json_object）；
 *   2. SSE 事件映射（思考→正文顺序缓冲、usage 缓存口径、工具调用、incomplete、
 *      failed）；
 *   3. 传输层（Bearer 鉴权头、/responses 路径、store/include 开关）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ResponsesClient } from '../responses-client.js'
import type { StreamCallbacks } from '../stream-client.js'

const BASE = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.6-sol',
  maxTokens: 64000,
}

/** 单块 SSE body → Response（测试只关心解析结果，不关心分块边界）。 */
function sseResponse(lines: string[]): Response {
  const body = lines.join('\n') + '\n'
  return { body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }) } as Response
}

interface Collected {
  text: string[]
  thinking: string[]
  blocks: Array<{ type: string; [k: string]: unknown }>
  stops: Array<{ reason: string; usage?: Record<string, unknown> }>
  seq: string[]
}

function collect(): { out: Collected; callbacks: StreamCallbacks } {
  const out: Collected = { text: [], thinking: [], blocks: [], stops: [], seq: [] }
  const callbacks: StreamCallbacks = {
    onTextDelta: (t) => { out.text.push(t); out.seq.push(`text:${t}`) },
    onThinkingDelta: (t) => { out.thinking.push(t); out.seq.push(`think:${t}`) },
    onContentBlock: (b) => { out.blocks.push(b as never); out.seq.push(`block:${(b as { type: string }).type}`) },
    onStopReason: (reason, usage) => { out.stops.push({ reason, usage: usage as Record<string, unknown> }); out.seq.push(`stop:${reason}`) },
    onError: (e) => { throw e },
  }
  return { out, callbacks }
}

describe('ResponsesClient — request body mapping', () => {
  it('system → instructions; user → input_text message; max_tokens → max_output_tokens', () => {
    const client = new ResponsesClient(BASE)
    const body = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: ' Be terse.' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 1234,
    })

    assert.equal(body.instructions, 'You are helpful. Be terse.')
    assert.equal(body.max_output_tokens, 1234)
    assert.equal(body.stream, true)
    assert.equal(body.store, false)
    assert.equal(body.parallel_tool_calls, true)
    assert.equal(body.reasoning, undefined, 'no effort configured → field omitted, relays never see it')
    assert.deepEqual(body.input, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ])
  })

  it('assistant tool_calls / tool results → top-level function_call items', () => {
    const client = new ResponsesClient(BASE)
    const body = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'user', content: 'do it' },
        {
          role: 'assistant',
          content: 'on it',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
      ],
      max_tokens: 1024,
    })

    // assistant text message → function_call → function_call_output
    assert.equal(body.input.length, 4)
    const call = body.input.find((i: Record<string, unknown>) => i.type === 'function_call')
    assert.equal(call.call_id, 'call_1')
    assert.equal(call.name, 'bash')
    assert.equal(call.arguments, '{"command":"ls"}')
    assert.deepEqual(body.input[3], { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' })
  })

  it('tools use the flat Responses shape; forced tool_choice disables parallel calls', () => {
    const client = new ResponsesClient(BASE)
    const body = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        type: 'function',
        function: {
          name: 'submit_result',
          description: 'finish',
          parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'submit_result' } },
      max_tokens: 1024,
    })

    assert.deepEqual(body.tools, [{
      type: 'function',
      name: 'submit_result',
      description: 'finish',
      parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      strict: false,
    }])
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'submit_result' })
    assert.equal(body.parallel_tool_calls, false)
  })

  it('multimodal user parts → input_text + input_image', () => {
    const client = new ResponsesClient(BASE)
    const body = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }],
      max_tokens: 1024,
    })

    assert.deepEqual(body.input[0].content, [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ])
  })

  it('reasoning effort: request wins over config, effortCap clamps', () => {
    const client = new ResponsesClient({ ...BASE, reasoningEffort: 'high', effortCap: { max: 'high' } })
    const body = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'x' }],
      reasoning_effort: 'max',
      max_tokens: 1024,
    })
    assert.deepEqual(body.reasoning, { effort: 'high' })

    client.setReasoningEffort('medium')
    const body2 = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1024,
    })
    assert.deepEqual(body2.reasoning, { effort: 'medium' })
  })

  it('json_object response_format → text.format', () => {
    const client = new ResponsesClient(BASE)
    const body = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'x' }],
      response_format: { type: 'json_object' },
      max_tokens: 1024,
    })
    assert.deepEqual(body.text, { format: { type: 'json_object' } })
  })

  it('temperature: request-level injected; provider default suppressed in thinking mode', () => {
    const thinking = new ResponsesClient({ ...BASE, temperature: 0.7, thinking: 'enabled' })
    const b1 = (thinking as any).buildRequestBody({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }], max_tokens: 1,
    })
    assert.equal(b1.temperature, undefined)

    const plain = new ResponsesClient({ ...BASE, temperature: 0.7, thinking: 'disabled' })
    const b2 = (plain as any).buildRequestBody({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }], max_tokens: 1,
    })
    assert.equal(b2.temperature, 0.7)

    const explicit = (plain as any).buildRequestBody({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, max_tokens: 1,
    })
    assert.equal(explicit.temperature, 0.2)
  })

  it('store / includeEncryptedReasoning switches', () => {
    const client = new ResponsesClient({ ...BASE, store: true, includeEncryptedReasoning: true })
    const body = (client as any).buildRequestBody({
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }], max_tokens: 1,
    })
    assert.equal(body.store, true)
    assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  })
})

describe('ResponsesClient — SSE mapping', () => {
  it('reasoning before buffered message: thinking→text order, end_turn stop', async () => {
    const client = new ResponsesClient(BASE)
    const { out, callbacks } = collect()
    await (client as any).processSSEStream(sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Final answer."}]}}',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think..."}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":15,"output_tokens":10}}}',
    ]), callbacks)

    const thinkIdx = out.seq.findIndex(s => s.startsWith('think:'))
    const textIdx = out.seq.findIndex(s => s.startsWith('text:'))
    assert.ok(thinkIdx >= 0 && textIdx >= 0, out.seq.join(','))
    assert.ok(thinkIdx < textIdx, 'thinking must precede buffered text')
    assert.equal(out.text.join(''), 'Final answer.')
    assert.equal(out.stops[0]?.reason, 'end_turn')
  })

  it('usage maps cached + reasoning tokens (cache-log would otherwise read 0)', async () => {
    const client = new ResponsesClient(BASE)
    const { out, callbacks } = collect()
    await (client as any).processSSEStream(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":64},"output_tokens_details":{"reasoning_tokens":7}}}}',
    ]), callbacks)

    const usage = out.stops[0]?.usage as Record<string, unknown>
    assert.equal(usage.input_tokens, 100)
    assert.equal(usage.output_tokens, 20)
    assert.equal(usage.cache_read_input_tokens, 64)
    assert.equal(usage.cache_creation_input_tokens, 0)
    assert.equal(usage.reasoning_tokens, 7)
  })

  it('function_call item → tool_use block with parsed args; empty args → {}', async () => {
    const client = new ResponsesClient(BASE)
    const { out, callbacks } = collect()
    await (client as any).processSSEStream(sseResponse([
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"a\\""}',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_10","name":"ping","arguments":""}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
    ]), callbacks)

    assert.deepEqual(out.blocks[0], { type: 'tool_use', id: 'call_9', name: 'bash', input: { command: 'ls' } })
    assert.deepEqual(out.blocks[1], { type: 'tool_use', id: 'call_10', name: 'ping', input: {} })
    assert.equal(out.stops[0]?.reason, 'tool_use')
  })

  it('malformed tool args get one repair pass instead of being dropped', async () => {
    const client = new ResponsesClient(BASE)
    const { out, callbacks } = collect()
    await (client as any).processSSEStream(sseResponse([
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"echo","arguments":"{\\"command\\":\\"echo \\"hi\\"\\"}"}}',
      'data: {"type":"response.completed","response":{}}',
    ]), callbacks)

    assert.deepEqual(out.blocks[0], { type: 'tool_use', id: 'call_1', name: 'echo', input: { command: 'echo "hi"' } })
  })

  it('response.incomplete(max_output_tokens) → max_tokens stop', async () => {
    const client = new ResponsesClient(BASE)
    const { out, callbacks } = collect()
    await (client as any).processSSEStream(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":9}}}',
    ]), callbacks)

    assert.equal(out.stops[0]?.reason, 'max_tokens')
  })

  it('response.failed throws the upstream error message', async () => {
    const client = new ResponsesClient(BASE)
    const { callbacks } = collect()
    await assert.rejects(
      (client as any).processSSEStream(sseResponse([
        'data: {"type":"response.failed","response":{"error":{"message":"model not found"}}}',
      ]), callbacks),
      /model not found/,
    )
  })

  it('completed-only gateways: full output array still yields text + tool calls', async () => {
    const client = new ResponsesClient(BASE)
    const { out, callbacks } = collect()
    await (client as any).processSSEStream(sseResponse([
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"done"}]},{"type":"function_call","call_id":"call_7","name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}],"usage":{"input_tokens":2,"output_tokens":3}}}',
    ]), callbacks)

    assert.deepEqual(out.text, ['done'])
    assert.deepEqual(out.blocks.find((b: { type: string }) => b.type === 'tool_use'), {
      type: 'tool_use', id: 'call_7', name: 'bash', input: { command: 'ls' },
    })
    assert.equal(out.stops[0]?.reason, 'tool_use')
  })

  it('does not emit text twice when both delta and output_item.done carry it', async () => {
    const client = new ResponsesClient(BASE)
    const { out, callbacks } = collect()
    await (client as any).processSSEStream(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Hello"}]}}',
      'data: {"type":"response.completed","response":{}}',
    ]), callbacks)

    assert.deepEqual(out.text, ['Hello'])
    assert.equal(out.blocks.filter(b => b.type === 'text').length, 1)
  })
})

describe('ResponsesClient — transport', () => {
  it('POSTs to /responses with Bearer auth', async () => {
    const client = new ResponsesClient({ ...BASE, baseUrl: 'https://relay.example.com/v1' })
    const captured: { url?: string; headers?: Record<string, string>; body?: string } = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      const req = init as { headers: Record<string, string>; body: string }
      captured.url = String(url)
      captured.headers = req.headers
      captured.body = req.body
      const text = [
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      ].join('\n') + '\n'
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const { out, callbacks } = collect()
      await client.stream({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }, callbacks)
      assert.equal(captured.url, 'https://relay.example.com/v1/responses')
      assert.equal(captured.headers?.Authorization, 'Bearer sk-test')
      assert.equal(JSON.parse(captured.body!).stream, true)
      assert.equal(out.stops[0]?.reason, 'end_turn')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('surfaces non-2xx with status + Retry-After for the retry classifier', async () => {
    const client = new ResponsesClient({ ...BASE, maxRetries: 0 })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { 'retry-after': '2' },
    })) as typeof fetch
    try {
      const { callbacks } = collect()
      let err: (Error & { status?: number; retryAfterMs?: number }) | undefined
      await client.stream({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }, callbacks)
        .catch((e) => { err = e })
      assert.ok(err, '429 must reject')
      assert.equal(err!.status, 429)
      assert.equal(err!.retryAfterMs, 2000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
