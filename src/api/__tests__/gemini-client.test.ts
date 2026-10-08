import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiClient, type GeminiClientConfig, type GeminiRequestBody } from '../gemini-client.js'
import type { OaiChatRequest } from '../oai-types.js'
import type { ContentBlock, Usage } from '../types.js'

function makeClient(over: Partial<GeminiClientConfig> = {}) {
  return new GeminiClient({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    maxTokens: 65_536,
    ...over,
  })
}

function body(over: Partial<OaiChatRequest> = {}): OaiChatRequest {
  return { model: 'gemini-3.8-flash', messages: [], max_tokens: 1024, ...over }
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Run `stream()` against a stubbed fetch and collect every callback firing. */
async function runStream(
  client: GeminiClient,
  request: OaiChatRequest,
  chunks: string[],
): Promise<{
  url: string
  headers: Record<string, string>
  wireBody: Record<string, unknown>
  text: string
  thinking: string
  blocks: ContentBlock[]
  stopReason: string | undefined
  usage: Partial<Usage> | undefined
}> {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedHeaders: Record<string, string> = {}
  let wireBody: Record<string, unknown> = {}
  try {
    globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = (init.headers ?? {}) as Record<string, string>
      wireBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return sseResponse(chunks)
    }) as typeof fetch

    let text = ''
    let thinking = ''
    const blocks: ContentBlock[] = []
    let stopReason: string | undefined
    let usage: Partial<Usage> | undefined

    await client.stream(request, {
      onTextDelta: t => { text += t },
      onThinkingDelta: t => { thinking += t },
      onContentBlock: b => { blocks.push(b) },
      onStopReason: (reason, u) => { stopReason = reason; usage = u },
      onError: e => { throw e },
    })

    return { url: capturedUrl, headers: capturedHeaders, wireBody, text, thinking, blocks, stopReason, usage }
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('GeminiClient request mapping', () => {
  it('hoists system messages to top-level systemInstruction and keeps them out of contents', () => {
    const client = makeClient()
    const built: GeminiRequestBody = client.buildRequestBodyForTest(body({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
    }))
    // The native API has no `system` role — it is a separate top-level field.
    assert.equal(built.systemInstruction?.parts[0]!?.text, 'You are a helpful assistant.')
    assert.deepEqual(built.contents.map(c => c.role), ['user'])
  })

  it('concatenates multiple system messages rather than dropping the later ones', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [
        { role: 'system', content: '第一段。' },
        { role: 'system', content: '第二段。' },
      ],
    }))
    assert.equal(built.systemInstruction?.parts[0]!?.text, '第一段。第二段。')
    assert.equal(built.contents.length, 0)
  })

  it('maps user text to contents[].parts[{text}] under role user', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'user', content: 'Hello world' }],
    }))
    assert.equal(built.contents.length, 1)
    assert.equal(built.contents[0]!.role, 'user')
    assert.deepEqual(built.contents[0]!.parts, [{ text: 'Hello world' }])
  })

  it('converts a data: URL image part to native inlineData (camelCase, not image_url)', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
        ],
      }],
    }))
    assert.deepEqual(built.contents[0]!.parts, [
      { text: 'what is this' },
      { inlineData: { mimeType: 'image/png', data: 'AAAB' } },
    ])
  })

  it('converts a remote image URL to fileData instead of inlineData', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
      }],
    }))
    assert.deepEqual(built.contents[0]!.parts, [
      { fileData: { mimeType: 'image/png', fileUri: 'https://example.com/a.png' } },
    ])
  })

  it('maps assistant text to role model', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'assistant', content: 'Hi there!' }],
    }))
    assert.equal(built.contents[0]!.role, 'model')
    assert.deepEqual(built.contents[0]!.parts, [{ text: 'Hi there!' }])
  })

  it('maps assistant tool_calls to functionCall parts with parsed args', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'glob', arguments: '{"pattern":"*.md"}' },
        }],
      }],
    }))
    assert.equal(built.contents[0]!.role, 'model')
    assert.deepEqual(built.contents[0]!.parts[0]!.functionCall, {
      name: 'glob',
      args: { pattern: '*.md' },
    })
  })

  it('maps role:tool to role:user + functionResponse, resolving the name from the preceding call', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'glob', arguments: '{"pattern":"*.md"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'README.md' },
      ],
    }))
    // Native has no `tool` role: the result comes back as a user turn carrying
    // functionResponse, and it must name the function (OpenAI only carries the id).
    const last = built.contents[built.contents.length - 1]!
    assert.equal(last.role, 'user')
    assert.deepEqual(last.parts[0]!.functionResponse, {
      name: 'glob',
      response: { result: 'README.md' },
    })
  })

  it('emits functionDeclarations (not tools[].function)', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }],
    }))
    assert.equal(built.tools?.length, 1)
    assert.equal(built.tools![0]!.functionDeclarations[0]!.name, 'read_file')
    assert.deepEqual(built.tools![0]!.functionDeclarations[0]!.parameters, {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
  })

  it('maps a forced tool_choice to functionCallingConfig ANY + allowedFunctionNames', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
      }],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    }))
    assert.deepEqual(built.toolConfig, {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] },
    })
  })

  it("maps tool_choice 'none' to functionCallingConfig NONE", () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
      }],
      tool_choice: 'none',
    }))
    assert.deepEqual(built.toolConfig, { functionCallingConfig: { mode: 'NONE' } })
  })

  it('puts sampling params under generationConfig, not at the top level', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 2048,
      temperature: 0.3,
    }))
    assert.equal(built.generationConfig.maxOutputTokens, 2048)
    assert.equal(built.generationConfig.temperature, 0.3)
    assert.equal((built as unknown as Record<string, unknown>).max_tokens, undefined)
    assert.equal((built as unknown as Record<string, unknown>).temperature, undefined)
  })

  it('disables thinking with thinkingBudget 0 when thinking is off', () => {
    const client = makeClient({ thinking: 'disabled' })
    const built = client.buildRequestBodyForTest(body({ messages: [{ role: 'user', content: 'hi' }] }))
    assert.deepEqual(built.generationConfig.thinkingConfig, { thinkingBudget: 0 })
  })

  it('requests thoughts and a budget when thinking is on', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    }))
    assert.equal(built.generationConfig.thinkingConfig?.includeThoughts, true)
    assert.equal(built.generationConfig.thinkingConfig?.thinkingBudget, 32_768)
  })

  it("maps the internal 'off' effort to a zero thinking budget", () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }))
    assert.equal(built.generationConfig.thinkingConfig?.thinkingBudget, 0)
  })
})

describe('GeminiClient wire endpoint', () => {
  it('builds the native streamGenerateContent URL and does not double the version segment', async () => {
    const client = makeClient({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
    ])
    assert.equal(
      r.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
    )
  })

  it('appends the version when the base URL omits it', async () => {
    const client = makeClient({ baseUrl: 'https://generativelanguage.googleapis.com' })
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
    ])
    assert.equal(
      r.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
    )
  })

  it('accepts a model id that already carries the models/ prefix without doubling it', async () => {
    const client = makeClient({ model: 'models/gemini-3.5-flash' })
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
    ])
    assert.ok(r.url.includes('/models/gemini-3.5-flash:streamGenerateContent'), r.url)
    assert.ok(!r.url.includes('models/models/'), r.url)
  })

  it('authenticates with x-goog-api-key and keeps the key out of the URL', async () => {
    const client = makeClient({ apiKey: 'secret-key' })
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
    ])
    assert.equal(r.headers['x-goog-api-key'], 'secret-key')
    assert.ok(!r.url.includes('secret-key'), 'API key must not appear in the request line')
  })
})

describe('GeminiClient stream parsing', () => {
  it('routes thought parts to onThinkingDelta and plain parts to onTextDelta', async () => {
    const client = makeClient()
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
    ])
    assert.equal(r.thinking, 'thinking...')
    assert.equal(r.text, 'Hello')
    // Both are also surfaced as complete blocks for persistence.
    assert.deepEqual(
      r.blocks.map(b => b.type),
      ['thinking', 'text'],
    )
  })

  it('emits a tool_use block for a functionCall part and reports tool_use as the stop reason', async () => {
    const client = makeClient()
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"glob","args":{"pattern":"*.md"}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ])
    const toolUse = r.blocks.find(b => b.type === 'tool_use')
    assert.ok(toolUse && toolUse.type === 'tool_use')
    assert.equal(toolUse.name, 'glob')
    assert.deepEqual(toolUse.input, { pattern: '*.md' })
    // A stop reason of 'stop' on a tool turn would end the agent loop early.
    assert.equal(r.stopReason, 'tool_use')
  })

  it('maps usageMetadata onto the internal Usage shape', async () => {
    const client = makeClient()
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7,"cachedContentTokenCount":3,"thoughtsTokenCount":5}}\n\n',
    ])
    assert.equal(r.usage?.input_tokens, 11)
    assert.equal(r.usage?.output_tokens, 7)
    assert.equal(r.usage?.cache_read_input_tokens, 3)
    assert.equal(r.usage?.reasoning_tokens, 5)
  })

  it('translates MAX_TOKENS to the internal length stop reason', async () => {
    const client = makeClient()
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"trunc"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
    ])
    assert.equal(r.stopReason, 'length')
  })

  it('reassembles events split across chunk boundaries', async () => {
    const client = makeClient()
    // The JSON payload is cut mid-token across two network reads — a parser that
    // assumes one event per chunk drops the text entirely.
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel',
      'lo"}]}}]}\n\n',
    ])
    assert.equal(r.text, 'Hello')
  })

  it('tolerates a keepalive line that is not valid JSON', async () => {
    const client = makeClient()
    const r = await runStream(client, body({ messages: [{ role: 'user', content: 'hi' }] }), [
      ': keepalive\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
    ])
    assert.equal(r.text, 'ok')
  })
})

describe('GeminiClient thought-signature replay', () => {
  it('re-attaches the captured thoughtSignature when the tool call is replayed', async () => {
    const client = makeClient()

    // Turn 1 — the model returns a functionCall carrying a thought signature.
    // Capture the id this client generated for it; that id is the join key.
    let callId = ''
    let callMetadata: import('../oai-types.js').ToolCallProviderMetadata | undefined
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () => sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"glob","args":{"pattern":"*.md"}},"thoughtSignature":"SIG-1"}]}}]}\n\n',
      ])) as typeof fetch
      await client.stream(body({ messages: [{ role: 'user', content: 'list files' }] }), {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: b => { if (b.type === 'tool_use') { callId = b.id; callMetadata = b.providerMetadata } },
        onStopReason: () => {},
        onError: e => { throw e },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.ok(callId, 'turn 1 must emit a tool_use block carrying an id')

    // Turn 2 — replay the assistant tool call. Without the signature Gemini 3
    // rejects the whole request (reproduced against the live API as HTTP 400:
    // "Function call is missing a thought_signature in functionCall parts").
    const built = client.buildRequestBodyForTest(body({
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: callId,
            providerMetadata: callMetadata,
            type: 'function',
            function: { name: 'glob', arguments: '{"pattern":"*.md"}' },
          }],
        },
        { role: 'tool', tool_call_id: callId, content: 'README.md' },
      ],
    }))
    const modelTurn = built.contents.find(c => c.role === 'model')
    const call = modelTurn?.parts.find(p => p.functionCall)
    assert.equal(call?.thoughtSignature, 'SIG-1')
  })

  it('omits the signature when the call id was never seen (fresh process)', () => {
    const client = makeClient()
    const built = client.buildRequestBodyForTest(body({
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'unknown-call',
          type: 'function',
          function: { name: 'glob', arguments: '{}' },
        }],
      }],
    }))
    const call = built.contents[0]!.parts.find(p => p.functionCall)
    assert.ok(call)
    assert.equal('thoughtSignature' in call, false)
  })
})
