import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, parseOpenAIError, type OpenAIClientConfig } from '../openai-client.js'
import { classifyApiError } from '../error-classifier.js'

const TEST_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 4096,
}

describe('OpenAIClient', () => {
  it('implements StreamClient interface', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    assert.equal(typeof client.stream, 'function')
    assert.equal(client.stream.length, 3)
  })
})

describe('parseStream / SSE parsing', () => {
  it('parses text deltas and stop reason', async () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    const response = new Response(stream)

    const textParts: string[] = []
    let stopReason: string | undefined

    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      {
        onTextDelta: (text: string) => textParts.push(text),
        onStopReason: (reason: string) => { stopReason = reason },
      },
    )

    assert.equal(textParts.join(''), 'Hello world')
    assert.equal(stopReason, 'end_turn')
  })

  it('handles empty stream', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const response = new Response(stream)

    const textParts: string[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: (text: string) => textParts.push(text) },
    )

    assert.equal(textParts.length, 0)
  })

  it('skips malformed SSE lines', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('not-sse-data\n'))
        controller.enqueue(encoder.encode('data: {invalid json\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const response = new Response(stream)

    const textParts: string[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: (text: string) => textParts.push(text) },
    )

    assert.equal(textParts.join(''), 'OK')
  })
})

describe('final text content block emission', () => {
  function sseStream(frames: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f))
        controller.close()
      },
    })
  }

  it('emits a text content block at stream end for text-only replies', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const response = new Response(sseStream([
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    const textBlocks = blocks.filter(b => b.type === 'text')
    assert.equal(textBlocks.length, 1, 'exactly one text content block must be emitted')
    assert.equal(textBlocks[0].text, 'Hello world')
  })

  it('emits text block alongside tool_use when text precedes tool calls', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const response = new Response(sseStream([
      'data: {"choices":[{"delta":{"content":"Checking weather. "},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    assert.equal(blocks.filter(b => b.type === 'tool_use').length, 1)
    const textBlocks = blocks.filter(b => b.type === 'text')
    assert.equal(textBlocks.length, 1)
    assert.equal(textBlocks[0].text, 'Checking weather. ')
  })

  it('does NOT emit text block when content was consumed as tool JSON (hasToolJsonInContentBug)', async () => {
    const client = new OpenAIClient({
      ...TEST_CONFIG,
      capabilities: { hasToolJsonInContentBug: true },
    })
    const toolJson = '{"name":"read_file","arguments":{"file_path":"/tmp/x"}}'
    const response = new Response(sseStream([
      `data: {"choices":[{"delta":{"content":${JSON.stringify(toolJson)}},"index":0,"finish_reason":"stop"}]}\n\n`,
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    assert.equal(blocks.filter(b => b.type === 'tool_use').length, 1, 'tool JSON must be parsed into tool_use')
    assert.equal(blocks.filter(b => b.type === 'text').length, 0, 'tool JSON must not also persist as text')
  })

  it('emits text block from promoted reasoning for GLM thinking-only replies', async () => {
    const client = new OpenAIClient({ ...TEST_CONFIG, providerName: 'glm' })
    const response = new Response(sseStream([
      'data: {"choices":[{"delta":{"reasoning_content":"The answer is 4."},"index":0,"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    const texts: string[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      {
        onTextDelta: (t: string) => texts.push(t),
        onContentBlock: (b: any) => blocks.push(b),
      },
    )

    assert.equal(texts.join(''), 'The answer is 4.', 'reasoning promoted to visible text')
    const textBlocks = blocks.filter(b => b.type === 'text')
    assert.equal(textBlocks.length, 1, 'promoted text must persist as a text block')
    assert.equal(textBlocks[0].text, 'The answer is 4.')
  })

  it('does not emit a text block when no content arrived', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const response = new Response(sseStream(['data: [DONE]\n\n']))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    assert.equal(blocks.filter(b => b.type === 'text').length, 0)
  })
})

describe('tool_calls delta buffering', () => {
  it('emits an observability signal on the first tool delta before JSON arguments complete', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const events: string[] = []
    const callbacks = {
      onToolCallDelta: () => { events.push('delta') },
      onToolCallHint: () => { events.push('hint') },
      onContentBlock: () => { events.push('complete') },
    }

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_slow', type: 'function', function: { name: 'bash', arguments: '' } }] }, finish_reason: null }] },
      callbacks,
    )
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }, finish_reason: null }] },
      callbacks,
    )

    assert.deepEqual(events, ['delta', 'delta'])

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"printf done"}' } }] }, finish_reason: 'tool_calls' }] },
      callbacks,
    )
    assert.deepEqual(events, ['delta', 'delta', 'delta', 'hint', 'complete'])
  })

  it('accumulates fragmented tool_calls deltas into complete tool_use', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const contentBlocks: any[] = []
    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onContentBlock: (block: any) => contentBlocks.push(block),
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 0)

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }, finish_reason: null }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 0)

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ation": "NYC"}' } }] }, finish_reason: 'tool_calls' }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].type, 'tool_use')
    assert.equal(contentBlocks[0].id, 'call_abc')
    assert.equal(contentBlocks[0].name, 'get_weather')
    assert.deepEqual(contentBlocks[0].input, { location: 'NYC' })
    assert.equal(stopReason, undefined)

    client.processDelta(
      { usage: { prompt_tokens: 100, completion_tokens: 20 } },
      callbacks,
    )

    assert.equal(stopReason, 'tool_use')
    assert.equal(stopUsage.input_tokens, 100)
    assert.equal(stopUsage.output_tokens, 20)
  })

  it('handles multiple tool calls in one turn', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const contentBlocks: any[] = []

    client.processDelta(
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } },
              { index: 1, id: 'call_2', type: 'function', function: { name: 'get_date', arguments: '{"tz":"UTC"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
      { onContentBlock: (block: any) => contentBlocks.push(block) },
    )

    assert.equal(contentBlocks.length, 2)
    assert.equal(contentBlocks[0].name, 'get_time')
    assert.equal(contentBlocks[1].name, 'get_date')
  })

  it('handles text content before tool calls', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const texts: string[] = []
    const contentBlocks: any[] = []

    client.processDelta(
      { choices: [{ delta: { content: 'Let me check the weather' }, finish_reason: null }] },
      { onTextDelta: (t: string) => texts.push(t), onContentBlock: (block: any) => contentBlocks.push(block) },
    )
    assert.equal(texts.join(''), 'Let me check the weather')

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { onTextDelta: (t: string) => texts.push(t), onContentBlock: (block: any) => contentBlocks.push(block) },
    )
    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].name, 'get_weather')
  })

  it('emits stop reason with usage from final chunk', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    client.processDelta(
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      callbacks,
    )
    assert.equal(stopReason, undefined)

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )
    assert.equal(stopReason, undefined)

    client.processDelta(
      { usage: { prompt_tokens: 50, completion_tokens: 10 } },
      callbacks,
    )
    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.input_tokens, 50)
    assert.equal(stopUsage.output_tokens, 10)
  })

  it('falls back to empty usage when no usage chunk arrives', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )

    assert.equal(stopReason, undefined)
  })
})

describe('error handling', () => {
  it('formats OpenAI API error with code and message', () => {
    const status = 400
    const body = JSON.stringify({
      error: { code: 'invalid_api_key', message: 'Incorrect API key provided' },
    })
    assert.equal(
      parseOpenAIError(status, body),
      'OpenAI API error (invalid_api_key): Incorrect API key provided',
    )
  })

  it('formats error with type when code is missing', () => {
    const status = 429
    const body = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    })
    assert.equal(
      parseOpenAIError(status, body),
      'OpenAI API error (rate_limit_error): Rate limit exceeded',
    )
  })

  it('falls back to HTTP status when error body is unparseable', () => {
    assert.equal(
      parseOpenAIError(500, 'Internal Server Error'),
      'OpenAI API error (HTTP 500): Internal Server Error',
    )
  })

  it('appends billing hint with recharge url for DeepSeek insufficient balance', () => {
    const body = JSON.stringify({
      error: { code: 'invalid_request_error', message: 'Insufficient Balance' },
    })
    const out = parseOpenAIError(402, body, { providerName: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })
    assert.ok(out.startsWith('OpenAI API error (invalid_request_error): Insufficient Balance\n'))
    assert.ok(out.includes('DeepSeek 账户余额不足'))
    assert.ok(out.includes('https://platform.deepseek.com/top_up'))
    assert.ok(out.includes('/model'))
  })

  it('detects balance errors by baseUrl when providerName is absent', () => {
    const body = JSON.stringify({
      error: { code: 'insufficient_balance', message: 'Insufficient balance' },
    })
    const out = parseOpenAIError(402, body, { baseUrl: 'https://api.siliconflow.cn/v1' })
    assert.ok(out.includes('SiliconFlow 账户余额不足'))
    assert.ok(out.includes('https://cloud.siliconflow.cn'))
  })

  it('falls back to generic billing hint when provider is unknown', () => {
    const body = JSON.stringify({
      error: { code: 'invalid_request_error', message: 'Insufficient Balance' },
    })
    const out = parseOpenAIError(402, body)
    assert.ok(out.includes('账户余额不足'))
    assert.ok(!out.includes('platform.deepseek.com'))
  })

  it('does not append billing hint for unrelated errors (401 gets the auth hint instead)', () => {
    const body = JSON.stringify({
      error: { code: 'invalid_api_key', message: 'Incorrect API key provided' },
    })
    assert.equal(
      parseOpenAIError(401, body, { providerName: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }),
      'OpenAI API error (invalid_api_key): Incorrect API key provided'
      + '\n提示：鉴权失败（HTTP 401）——请检查 API key 是否正确，或用 /connect 重新配置。',
    )
  })
})

describe('retry-after parsing (parseRetryAfterMs)', () => {
  it('parseRetryAfterMs is imported from error-classifier, not a private local', async () => {
    const mod = await import('../openai-client.js')
    assert.ok(mod.OpenAIClient, 'OpenAIClient loads successfully with shared parseRetryAfterMs')
    // parseRetryAfterMs was removed from this module in 119dd49
    assert.equal(typeof (mod as Record<string, unknown>).parseRetryAfterMs, 'undefined',
      'parseRetryAfterMs must not exist on openai-client exports — it lives in error-classifier')
  })

  it('HTTP-date via Date.parse works for future timestamp', () => {
    const futureDate = new Date(Date.now() + 30_000).toUTCString()
    const parsed = Date.parse(futureDate)
    assert.ok(Number.isFinite(parsed), 'Date.parse handles HTTP-date format')
    const delta = parsed - Date.now()
    assert.ok(delta > 0 && delta < 60_000, 'delta from now should be ~30s')
  })
})

describe('DeepSeek-specific features', () => {
  it('1: calls onThinkingDelta for reasoning_content delta', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const thoughts: string[] = []

    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Let me think about this...' } }] },
      { onThinkingDelta: (t: string) => thoughts.push(t) },
    )

    assert.equal(thoughts.join(''), 'Let me think about this...')
  })

  it('5: extracts DeepSeek cache stats from usage chunk', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )

    client.processDelta(
      { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } },
      callbacks,
    )

    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.cache_read_input_tokens, 60)
    assert.equal(stopUsage.cache_creation_input_tokens, 40)
    assert.equal(stopUsage.input_tokens, 100)
    assert.equal(stopUsage.output_tokens, 20)
  })

  it('5a: extracts DeepSeek cache stats from COMBINED chunk (finish_reason + usage in one frame)', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    // Single combined chunk: finish_reason AND usage in the same SSE frame.
    // This is the DeepSeek behavior — unlike OpenAI which sends usage as a
    // separate trailing chunk.
    client.processDelta(
      {
        choices: [{ delta: { content: 'final text' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
      },
      callbacks,
    )

    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.cache_read_input_tokens, 60)
    assert.equal(stopUsage.cache_creation_input_tokens, 40)
    assert.equal(stopUsage.input_tokens, 100)
    assert.equal(stopUsage.output_tokens, 20)
  })

  it('5b: threads reasoning_tokens from completion_tokens_details (separate usage chunk)', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    let stopUsage: any = null
    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (_reason: string, usage: any) => { stopUsage = usage },
    }

    client.processDelta({ choices: [{ delta: {}, finish_reason: 'stop' }] }, callbacks)
    client.processDelta(
      { usage: { prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 150 } } },
      callbacks,
    )

    assert.equal(stopUsage.output_tokens, 200)
    assert.equal(stopUsage.reasoning_tokens, 150)
  })

  it('5c: threads reasoning_tokens from COMBINED chunk; undefined when absent', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    let stopUsage: any = null
    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (_reason: string, usage: any) => { stopUsage = usage },
    }

    client.processDelta(
      {
        choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 80 } },
      },
      callbacks,
    )
    assert.equal(stopUsage.reasoning_tokens, 80)

    // Provider without the split → reasoning_tokens undefined, not zero.
    const client2 = new OpenAIClient(TEST_CONFIG)
    let usage2: any = null
    client2.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { onTextDelta: () => {}, onContentBlock: () => {}, onStopReason: (_r: string, u: any) => { usage2 = u } },
    )
    client2.processDelta({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, {
      onTextDelta: () => {}, onContentBlock: () => {}, onStopReason: (_r: string, u: any) => { usage2 = u },
    })
    assert.equal(usage2.reasoning_tokens, undefined)
  })

  it('6: maps insufficient_system_resource finish_reason to end_turn', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'insufficient_system_resource' }] },
      callbacks,
    )

    client.processDelta(
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      callbacks,
    )

    assert.equal(stopReason, 'end_turn')
  })

  it('7: thinking-only turn — onThinkingDelta called, onTextDelta not called', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const texts: string[] = []
    const thoughts: string[] = []
    let stopReason: string | undefined

    const callbacks = {
      onTextDelta: (t: string) => texts.push(t),
      onThinkingDelta: (t: string) => thoughts.push(t),
      onContentBlock: () => {},
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Step 1: analyze' }, finish_reason: null }] },
      callbacks,
    )
    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Step 2: conclude' }, finish_reason: null }] },
      callbacks,
    )

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )

    client.processDelta(
      { usage: { prompt_tokens: 50, completion_tokens: 0 } },
      callbacks,
    )

    assert.equal(texts.length, 0, 'onTextDelta should not be called for thinking-only')
    assert.equal(thoughts.length, 2, 'onThinkingDelta should be called for each reasoning_content delta')
    assert.equal(thoughts.join(''), 'Step 1: analyzeStep 2: conclude')
    assert.equal(stopReason, 'end_turn')
  })

  it('8: thinking plus tool call is actionable and not text-only', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const texts: string[] = []
    const thoughts: string[] = []
    const blocks: any[] = []
    let stopReason: string | undefined

    const callbacks = {
      onTextDelta: (t: string) => texts.push(t),
      onThinkingDelta: (t: string) => thoughts.push(t),
      onContentBlock: (block: any) => blocks.push(block),
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Need to submit the plan.' }, finish_reason: null }] },
      callbacks,
    )
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_plan', type: 'function', function: { name: 'plan_submit', arguments: '{"title":"Stepwise Document Writing","plan":"Do it."}' } }] }, finish_reason: 'tool_calls' }] },
      callbacks,
    )
    client.processDelta(
      { usage: { prompt_tokens: 100, completion_tokens: 20 } },
      callbacks,
    )

    assert.deepEqual(texts, [])
    assert.deepEqual(thoughts, ['Need to submit the plan.'])
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].name, 'plan_submit')
    assert.equal(stopReason, 'tool_use')
  })
})

describe('usage calibration (GLM prompt_tokens inflation)', () => {
  // Helper: create client with given calibration factor and pre-set messages
  function makeClient(factor: number | undefined, messages?: object[]): OpenAIClient {
    const client = new OpenAIClient({
      ...TEST_CONFIG,
      usageCalibrationFactor: factor,
      providerName: factor === 0 ? 'glm' : undefined,
    })
    // processDelta reads this.lastRequestMessages for estimation
    ;(client as any).lastRequestMessages = messages ?? []
    return client
  }

  function getUsage(client: OpenAIClient): any {
    let usage: any = null
    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { onStopReason: (_r: string, u: any) => { usage = u } },
    )
    client.processDelta(
      { usage: { prompt_tokens: 1_970_432, completion_tokens: 500, prompt_cache_hit_tokens: 1_778_816, prompt_cache_miss_tokens: 0 } },
      { onStopReason: (_r: string, u: any) => { usage = u } },
    )
    return usage
  }

  it('GLM factor=0: replaces input_tokens with local estimate', () => {
    // 1000 chars of content → ~250 tokens estimated
    const bigText = 'x'.repeat(1000)
    const client = makeClient(0, [{ role: 'user', content: bigText }])

    const usage = getUsage(client)

    // Should NOT be 1,970,432 (the inflated GLM value)
    assert.ok(usage.input_tokens < 1_000_000,
      `input_tokens should be estimated, not 1.97M (got ${usage.input_tokens})`)
    assert.equal(usage.input_tokens, 250, '1000 chars / 4 = 250 tokens')
  })

  it('default (no factor): trusts API prompt_tokens as-is', () => {
    const client = makeClient(undefined, [{ role: 'user', content: 'hi' }])

    const usage = getUsage(client)

    assert.equal(usage.input_tokens, 1_970_432,
      'without calibration, API value should pass through')
  })

  it('factor=1: trusts API prompt_tokens as-is', () => {
    const client = makeClient(1, [{ role: 'user', content: 'hi' }])

    const usage = getUsage(client)

    assert.equal(usage.input_tokens, 1_970_432)
  })

  it('GLM factor=0: scales cache_read proportionally', () => {
    const bigText = 'x'.repeat(1000)
    const client = makeClient(0, [{ role: 'user', content: bigText }])

    const usage = getUsage(client)

    // apiRatio = 250 / 1_970_432 ≈ 0.000127
    // cache_read = round(1_778_816 * 0.000127) ≈ 226
    assert.ok(usage.cache_read_input_tokens < usage.input_tokens,
      'cache_read should be scaled down proportionally')
    assert.ok(usage.cache_read_input_tokens > 0,
      'cache_read should be non-zero after proportional scaling')
  })
})

describe('system suffix copy-on-write (2026-07-06 double-append regression)', () => {
  // Preserved-thinking protocol + thinking enabled → non-empty systemSuffix at construction.
  const SUFFIX_CONFIG: OpenAIClientConfig = {
    ...TEST_CONFIG,
    providerName: 'deepseek',
    thinking: 'enabled',
    preservedThinkingProtocol: true,
  }

  const NOOP_CALLBACKS = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: () => {},
    onError: () => {},
  }

  function makeSuffixClient(): { client: OpenAIClient; bodies: any[] } {
    const client = new OpenAIClient(SUFFIX_CONFIG)
    const bodies: any[] = []
    // Intercept just before the network — everything in stream() (reasoning
    // strip, suffix append, sanitize, wire probe) has already run on `body`.
    ;(client as any).sendStream = async (body: any) => { bodies.push(body) }
    return { client, bodies }
  }

  it('re-streaming the same request object does not double-append the suffix', async () => {
    const { client, bodies } = makeSuffixClient()
    const suffix = (client as any).systemSuffix as string
    assert.ok(suffix.length > 0, 'test premise: suffix must be non-empty')

    // llm-speculation reuses the main request's message objects by reference;
    // FallbackStreamClient replays the same request object on failover. Both
    // re-enter stream() with an already-suffixed system message.
    const request: any = {
      model: 'deepseek-v4',
      stream: true,
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'SYSTEM PROMPT' },
        { role: 'user', content: 'hi' },
      ],
    }

    await client.stream(request, NOOP_CALLBACKS as any)
    await client.stream(request, NOOP_CALLBACKS as any)

    const sys1 = bodies[0].messages[0].content as string
    const sys2 = bodies[1].messages[0].content as string
    assert.equal(sys1, 'SYSTEM PROMPT' + suffix)
    assert.equal(sys2, sys1, 'wire bytes must be identical across re-entry (no double suffix)')
    // caller's request object must stay untouched
    assert.equal(request.messages[0].content, 'SYSTEM PROMPT')
  })

  it('wire probe sees stable system bytes across consecutive probed requests', async () => {
    const { client } = makeSuffixClient()
    const makeRequest = (extraUser?: string): any => ({
      model: 'deepseek-v4',
      stream: true,
      max_tokens: 100,
      prefixProbe: true,
      messages: [
        { role: 'system', content: 'SYSTEM PROMPT' },
        { role: 'user', content: 'hi' },
        ...(extraUser ? [{ role: 'user', content: extraUser }] : []),
      ],
    })

    await client.stream(makeRequest(), NOOP_CALLBACKS as any)
    await client.stream(makeRequest('follow-up'), NOOP_CALLBACKS as any)

    // Pure append with byte-stable system → no divergence recorded.
    assert.equal(client.consumeWireDivergence(), null)
  })
})

describe('wire message normalization', () => {
  const NOOP_CALLBACKS = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: () => {},
    onError: () => {},
  }

  it('omits empty assistant tool_calls before sending a resumed request', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    let body: any
    ;(client as any).sendStream = async (next: any) => { body = next }
    const request: any = {
      model: 'gpt-4o',
      stream: true,
      messages: [
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'already answered', tool_calls: [] },
      ],
    }

    await client.stream(request, NOOP_CALLBACKS as any)

    assert.deepStrictEqual(body.messages[1], { role: 'assistant', content: 'already answered' })
    assert.deepStrictEqual(request.messages[1], { role: 'assistant', content: 'already answered', tool_calls: [] })
  })
})

describe('content→reasoning channel ordering (C→R 折叠防护)', () => {
  const CODE = '```html\n<div class="record-id-doc">\n  <span>No ID</span>\n</div>\n```'
  const CONCLUSION = '代码已经完整给出，复制后可直接运行。'

  function frame(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ choices: [{ delta, index: 0, ...extra }] })}\n\n`
  }

  function runSse(client: OpenAIClient, frames: string[]) {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (const f of frames) controller.enqueue(enc.encode(f))
        controller.close()
      },
    })
    const response = new Response(stream)
    const textParts: string[] = []
    const thinkingParts: string[] = []
    const blocks: Array<{ type: string; text?: string; thinking?: string }> = []
    const promise = (client as any).parseStreamFromReader(
      response.body!.getReader(),
      {
        onTextDelta: (t: string) => textParts.push(t),
        onThinkingDelta: (t: string) => thinkingParts.push(t),
        onContentBlock: (b: { type: string; text?: string; thinking?: string }) => blocks.push(b),
      },
    )
    return { textParts, thinkingParts, blocks, promise }
  }

  it('C→R 异常顺序：content 已开始后 reasoning 不得折叠为 thinking', async () => {
    const client = new OpenAIClient({ ...TEST_CONFIG, providerName: 'deepseek', thinking: 'enabled' })
    const { textParts, thinkingParts, blocks, promise } = runSse(client, [
      frame({ content: CODE }),
      frame({ reasoning_content: CONCLUSION }),
      frame({}, { finish_reason: 'stop' }),
      'data: [DONE]\n\n',
    ])
    await promise
    const full = textParts.join('')
    assert.ok(full.includes('record-id-doc'), '代码块应留在正式文本')
    assert.ok(full.includes(CONCLUSION), '结论不得被折叠——应出现在正式文本')
    assert.ok(!thinkingParts.join('').includes(CONCLUSION), '结论不得进入 thinking 通道')
    assert.ok(!blocks.some(b => b.type === 'thinking' && b.thinking?.includes(CONCLUSION)), '流末 thinking 块不得含结论')
  })

  it('R→C 正常基线：reasoning 保持 thinking、content 保持 text', async () => {
    const client = new OpenAIClient({ ...TEST_CONFIG, providerName: 'deepseek', thinking: 'enabled' })
    const { textParts, thinkingParts, promise } = runSse(client, [
      frame({ reasoning_content: '先分析一下需求…' }),
      frame({ content: CONCLUSION }),
      frame({}, { finish_reason: 'stop' }),
      'data: [DONE]\n\n',
    ])
    await promise
    assert.ok(thinkingParts.join('').includes('先分析一下需求…'), '先行 reasoning 仍走 thinking')
    assert.ok(textParts.join('').includes(CONCLUSION), '结论留在正式文本')
  })

  it('同一 chunk 双字段：reasoning 与 content 均不丢失', async () => {
    const client = new OpenAIClient({ ...TEST_CONFIG, providerName: 'deepseek', thinking: 'enabled' })
    const { textParts, thinkingParts, promise } = runSse(client, [
      frame({ reasoning_content: '推理片段', content: '正文片段' }),
      frame({}, { finish_reason: 'stop' }),
      'data: [DONE]\n\n',
    ])
    await promise
    assert.ok(thinkingParts.join('').includes('推理片段'), '同 chunk reasoning 进 thinking')
    assert.ok(textParts.join('').includes('正文片段'), '同 chunk content 进 text')
  })

  it('tool-call turn：tool_calls 前的 reasoning 不泄露为 text', async () => {
    const client = new OpenAIClient({ ...TEST_CONFIG, providerName: 'deepseek', thinking: 'enabled' })
    const { textParts, thinkingParts, promise } = runSse(client, [
      frame({ reasoning_content: '内部推理…' }),
      frame({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] }),
      frame({}, { finish_reason: 'tool_calls' }),
      'data: [DONE]\n\n',
    ])
    await promise
    assert.ok(thinkingParts.join('').includes('内部推理…'), 'tool-call 轮 reasoning 走 thinking')
    assert.ok(!textParts.join('').includes('内部推理…'), 'tool-call 轮 reasoning 不泄露为 text')
  })
})

// ---------------------------------------------------------------------------
// image_strip 恢复：413 / 图片拒绝 → 剥图重发一次（issue #94）
//
// 分类器承诺 stripImages 后剥图重发，但全链路从未消费该字段：重试调用同一个
// fn、发送逐字节相同的请求体，413 必然复现。这一组测试锁定修复后的行为。
// ---------------------------------------------------------------------------
describe('image_strip recovery', () => {
  const originalFetch = globalThis.fetch

  const NOOP_CALLBACKS = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: () => {},
    onError: () => {},
  }

  /** fetch mock：按序消费 statuses（非 2xx），耗尽后回一段 SSE 成功流。
   *  传对象可自定义错误体 message（图片处理错误走 message 匹配而非状态码）。 */
  function mockFetchSequence(statuses: Array<number | { status: number; message: string }>): Array<{ body: string }> {
    const calls: Array<{ body: string }> = []
    let idx = 0
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      calls.push({ body: String(init.body ?? '') })
      const step = statuses[idx++]
      if (step !== undefined) {
        const status = typeof step === 'number' ? step : step.status
        const message = typeof step === 'number' ? 'Request too large' : step.message
        return new Response(JSON.stringify({ error: { message } }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }
      const enc = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(
            'data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":"stop"}]}\n\n'
            + 'data: [DONE]\n\n',
          ))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    return calls
  }

  function restoreFetch(): void {
    globalThis.fetch = originalFetch
  }

  const IMAGE_REQUEST = {
    model: 'gpt-4o',
    stream: true,
    max_tokens: 10,
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  }

  /** 第 2 条消息（用户消息）的 content parts。 */
  function userContent(body: string): Array<{ type: string; text?: string }> {
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
    return parsed.messages[1]!.content as Array<{ type: string; text?: string }>
  }

  it('413 → 剥掉 image_url 重发一次 → 恢复成功', async () => {
    const calls = mockFetchSequence([413])
    try {
      const client = new OpenAIClient(TEST_CONFIG)
      const strippedCounts: number[] = []
      let stopReason = ''
      await client.stream(IMAGE_REQUEST as never, {
        ...NOOP_CALLBACKS,
        onStopReason: (r: string) => { stopReason = r },
        onImageStripped: (info: { removedCount: number }) => { strippedCounts.push(info.removedCount) },
      })

      assert.equal(calls.length, 2, '一次带图尝试 + 一次剥图重发')
      assert.ok(userContent(calls[0]!.body).some(p => p.type === 'image_url'), '首次必须原样带图')
      const second = userContent(calls[1]!.body)
      assert.ok(!second.some(p => p.type === 'image_url'), '重发必须已剥图')
      assert.ok(second.some(p => p.type === 'text' && p.text === 'describe this'), '文本必须保留')
      assert.equal(stopReason, 'end_turn')
      assert.deepEqual(strippedCounts, [1], '剥离必须通知调用方（用户可见提示）')
    } finally {
      restoreFetch()
    }
  })

  it('无图 413 → 不重发，直接失败（省掉一次注定失败的网络往返）', async () => {
    const calls = mockFetchSequence([413, 413, 413])
    try {
      const client = new OpenAIClient(TEST_CONFIG)
      const textOnly = {
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: 'text only' }],
      }
      await assert.rejects(
        () => client.stream(textOnly as never, NOOP_CALLBACKS),
        (err: unknown) => {
          assert.equal(
            classifyApiError(err).category,
            'context_overflow',
            '无图的 413 是上下文超限，不该承诺剥图',
          )
          return true
        },
      )
      assert.equal(calls.length, 1, '无图 413 不得重发')
    } finally {
      restoreFetch()
    }
  })

  it('剥图后仍 413 → 不再重发，错误改按上下文超限表述', async () => {
    const calls = mockFetchSequence([413, 413, 413])
    try {
      const client = new OpenAIClient(TEST_CONFIG)
      await assert.rejects(
        () => client.stream(IMAGE_REQUEST as never, NOOP_CALLBACKS),
        (err: unknown) => {
          assert.equal(
            classifyApiError(err).category,
            'context_overflow',
            '剥了图还是超限说明不是图片的锅，不该再指点用户删图',
          )
          return true
        },
      )
      assert.equal(calls.length, 2, '带图一次 + 剥图一次；第三次必然重复已剥的体')
      assert.ok(!userContent(calls[1]!.body).some(p => p.type === 'image_url'), '重发体已剥图')
    } finally {
      restoreFetch()
    }
  })

  it('剥图只作用于本次请求体，不污染调用方的 messages（会话历史仍保图）', async () => {
    const calls = mockFetchSequence([413])
    try {
      const client = new OpenAIClient(TEST_CONFIG)
      await client.stream(IMAGE_REQUEST as never, NOOP_CALLBACKS)
      const original = (IMAGE_REQUEST.messages[1] as { content: Array<{ type: string }> }).content
      assert.equal(original.length, 2, '原始请求的 content parts 数量不变')
      assert.ok(original.some(p => p.type === 'image_url'), '会话历史里的图片必须还在')
      assert.equal(calls.length, 2)
    } finally {
      restoreFetch()
    }
  })

  it('图片处理 400（image_strip 的第二条来源）→ 同样剥图重发', async () => {
    // 分类器对「Could not process image」这类 400/500 也给 image_strip——
    // 那条路径不带 413 标记，剥图同样必须真的发生。
    const calls = mockFetchSequence([{ status: 400, message: 'Could not process image: bad format' }])
    try {
      const client = new OpenAIClient(TEST_CONFIG)
      let stopReason = ''
      await client.stream(IMAGE_REQUEST as never, {
        ...NOOP_CALLBACKS,
        onStopReason: (r: string) => { stopReason = r },
      })

      assert.equal(calls.length, 2, '一次带图尝试 + 一次剥图重发')
      const second = userContent(calls[1]!.body)
      assert.ok(!second.some(p => p.type === 'image_url'), '图片拒绝后重发必须已剥图')
      assert.ok(second.some(p => p.type === 'text'), '文本必须保留')
      assert.equal(stopReason, 'end_turn')
    } finally {
      restoreFetch()
    }
  })
})
