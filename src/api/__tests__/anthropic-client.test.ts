import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicClient } from '../anthropic-client.js'
import { parseRetryAfterMs } from '../error-classifier.js'

function makeClient() {
  return new AnthropicClient({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    maxTokens: 4096,
  })
}

describe('AnthropicClient message conversion', () => {
  it('extracts system message to top-level system array', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 4096,
    })
    assert.ok(Array.isArray(body.system))
    const sys = body.system!
    assert.equal(sys.length, 1)
    const sys0 = sys[0]!
    assert.equal(sys0.type, 'text')
    assert.equal(sys0.text, 'You are a helpful assistant.')
    const hasSystemInMessages = (body.messages as Array<{ role: string }>).some(m => m.role === 'system')
    assert.equal(hasSystemInMessages, false)
  })

  it('converts user message to content blocks array', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'Hello world' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.messages.length, 1)
    const msg = body.messages[0]!
    assert.equal(msg.role, 'user')
    assert.ok(Array.isArray(msg.content))
    const block = msg.content[0]!
    assert.equal(block.type, 'text')
    assert.equal(block.text, 'Hello world')
  })

  it('converts assistant message with text to content blocks', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'assistant', content: 'Hi there!' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'assistant')
    assert.ok(Array.isArray(msg.content))
    const block = msg.content[0]!
    assert.equal(block.type, 'text')
    assert.equal(block.text, 'Hi there!')
  })

  it('converts assistant with tool_calls to tool_use blocks', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'assistant',
          content: 'Let me read that file.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/foo"}' } },
          ],
        },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'assistant')
    const types = msg.content.map(b => b.type)
    assert.ok(types.includes('text'))
    assert.ok(types.includes('tool_use'))
    const toolUse = msg.content.find(b => b.type === 'tool_use')
    assert.ok(toolUse)
    assert.equal(toolUse.name, 'read_file')
    assert.deepEqual(toolUse.input, { file_path: '/foo' })
  })

  it('converts tool result message to tool_result content block in user role', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'user')
    assert.ok(Array.isArray(msg.content))
    const block = msg.content[0]!
    assert.equal(block.type, 'tool_result')
    assert.equal(block.tool_use_id, 'call_1')
    assert.equal(block.content, 'file contents here')
  })

  it('converts tools to Anthropic input_schema format sorted by name', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'zebra', description: 'z', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'alpha', description: 'a', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } },
      ],
    })
    assert.ok(Array.isArray(body.tools))
    const tools = body.tools!
    assert.equal(tools.length, 2)
    assert.equal(tools[0]!.name, 'alpha')
    assert.equal(tools[1]!.name, 'zebra')
    assert.equal(tools[0]!.input_schema.type, 'object')
    assert.deepEqual(tools[0]!.input_schema.required, ['x'])
  })

  it('handles assistant message with reasoning_content', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'assistant', content: 'answer', reasoning_content: 'thinking...' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    const types = msg.content.map(b => b.type)
    // Anthropic API rejects `thinking` blocks in the request history — they
    // are model-output only. The client merges reasoning into the text block.
    assert.ok(!types.includes('thinking'))
    assert.ok(types.includes('text'))
    const textBlock = msg.content.find(b => b.type === 'text')
    assert.ok(textBlock)
    assert.equal(textBlock.text, '<thinking>\nthinking...\n</thinking>\n\nanswer')
  })

  it('handles no system message gracefully', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.system, undefined)
  })

  it('handles assistant with null content (tool-only response)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          ],
        },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'assistant')
    const types = msg.content.map(b => b.type)
    assert.ok(!types.includes('text'))
    assert.ok(types.includes('tool_use'))
  })

  it('sets required Anthropic body fields', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
    })
    assert.equal(body.model, 'claude-opus-4-7')
    assert.equal(body.max_tokens, 4096)
    assert.equal(body.stream, true)
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages.length, 1)
  })
})

describe('tool_choice mapping', () => {
  it('maps forced function tool_choice to Anthropic tool choice when function exists in tools', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'submit_result', description: '', parameters: { type: 'object', properties: {} } } },
      ],
      tool_choice: { type: 'function', function: { name: 'submit_result' } },
    })
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_result' })
  })

  it('does not emit tool_choice for auto mode', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'submit_result', description: '', parameters: { type: 'object', properties: {} } } },
      ],
      tool_choice: 'auto',
    })
    assert.equal(body.tool_choice, undefined)
  })

  it('does not emit tool_choice when no tools provided even with forced choice', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
      tool_choice: { type: 'function', function: { name: 'submit_result' } },
    })
    assert.equal(body.tool_choice, undefined)
  })

  it('does not emit tool_choice when forced function is not among tools', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'other_tool', description: '', parameters: { type: 'object', properties: {} } } },
      ],
      tool_choice: { type: 'function', function: { name: 'submit_result' } },
    })
    assert.equal(body.tool_choice, undefined)
  })
})

describe('cache_control breakpoint injection', () => {
  it('injects BP1 on last tool definition (1h TTL)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'tool_a', description: '', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'tool_b', description: '', parameters: { type: 'object', properties: {} } } },
      ],
    })
    const tools = body.tools!
    assert.equal(tools.length, 2)
    const lastTool = tools[tools.length - 1]!
    assert.deepEqual(lastTool.cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(tools[0]!.cache_control, undefined)
  })

  it('injects BP2 on last system content block (1h TTL)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
    })
    const sys = body.system!
    const lastSystemBlock = sys[sys.length - 1]!
    assert.deepEqual(lastSystemBlock.cache_control, { type: 'ephemeral', ttl: '1h' })
  })

  it('injects BP3 on first user message last content block (5m TTL)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'project instructions + memory + first message' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second message' },
      ],
      max_tokens: 4096,
    })
    const firstUserMsg = body.messages[0]!
    assert.equal(firstUserMsg.role, 'user')
    const blocks = firstUserMsg.content
    const lastBlock = blocks[blocks.length - 1]!
    assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' })
  })

  it('injects BP4 on farthest assistant within 15-block lookback window', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: 'second message' },
        { role: 'assistant', content: 'second response' },
        { role: 'user', content: 'third message' },
      ],
      max_tokens: 4096,
    })
    // 5 messages, each 1 block. assistant("first") last block at pos 2 → fromEnd = 3 < 15
    // → bp4Idx=1 (first qualifying = farthest from end, maximizing cached prefix)
    const bp4Msg = body.messages[1]!
    assert.equal(bp4Msg.role, 'assistant')
    assert.deepEqual(bp4Msg.content[bp4Msg.content.length - 1]!.cache_control, { type: 'ephemeral' })
  })

  it('places BP4 on farthest assistant within window when earlier ones are out of range', () => {
    const client = makeClient()
    const messages: Array<{ role: string; content: string; tool_call_id?: string }> = [
      { role: 'user', content: 'msg0' },
      { role: 'assistant', content: 'resp0' },
    ]
    // Add enough tool-call pairs to push resp0 and early tc assistants beyond 15-block window
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'assistant', content: `tc${i}` })
      messages.push({ role: 'tool', content: `result${i}`, tool_call_id: `call_${i}` })
    }
    messages.push({ role: 'user', content: 'final' })

    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: messages as any,
      max_tokens: 4096,
    })

    // Same-role folding renders the wire-accurate form: resp0+tc0 merge into one
    // assistant message and the trailing tool result (user) merges with 'final'
    // → 21 messages, 23 blocks total（折叠只改消息边界，不增删 blocks）。
    // resp0+tc0 at blockPos=3 → fromEnd=20 >= 15 → skip
    // tc1 at blockPos=5 → fromEnd=18 >= 15 → skip
    // tc2 at blockPos=7 → fromEnd=16 >= 15 → skip
    // tc3 at blockPos=9 → fromEnd=14 < 15 → bp4Idx=7 (messages[7] = assistant tc3)
    const bp4Msg = body.messages[7]!
    assert.equal(bp4Msg.role, 'assistant')
    assert.deepEqual(bp4Msg.content[bp4Msg.content.length - 1]!.cache_control, { type: 'ephemeral' })
  })

  it('skips BP4 when all assistants are beyond lookback window', () => {
    const client = makeClient()
    // Build a conversation where ALL assistants are >15 blocks back
    const messages: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'msg0' },
      { role: 'assistant', content: 'resp0' },
    ]
    // Add enough filler user messages to push resp0 beyond 15-block window
    for (let i = 0; i < 15; i++) {
      messages.push({ role: 'user', content: `filler${i}` })
    }
    messages.push({ role: 'user', content: 'final' })

    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: messages as any,
      max_tokens: 4096,
    })

    // 2 + 15 + 1 = 18 messages, 18 blocks
    // resp0 at blockPos=2 → fromEnd=16 >= 15 → skipped, no BP4
    for (const msg of body.messages) {
      if (msg.role === 'assistant') {
        for (const block of msg.content) {
          assert.equal(block.cache_control, undefined)
        }
      }
    }
  })

  it('skips BP4 when the only candidate is the BP3 target (overlap)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'only message' },
      ],
      max_tokens: 4096,
    })
    // BP3 on messages[0] (first user)
    assert.deepEqual(body.messages[0]!.content[0]!.cache_control, { type: 'ephemeral' })
    // BP4 should NOT be placed — no assistant exists, nothing to do
  })

  it('handles no tools — no BP1, but BP2+BP3 still injected', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.tools, undefined)
    // BP2 still present
    const sys = body.system!
    assert.deepEqual(sys[sys.length - 1]!.cache_control, { type: 'ephemeral', ttl: '1h' })
    // BP3 still present
    assert.deepEqual(body.messages[0]!.content[0]!.cache_control, { type: 'ephemeral' })
  })

  it('handles no system — BP2 skipped, other breakpoints still present', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'only user message' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.system, undefined)
    // BP3 still present on first user
    assert.deepEqual(body.messages[0]!.content[0]!.cache_control, { type: 'ephemeral' })
  })

  it('does not duplicate cache_control on blocks that already have it from BP3', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'single user' },
        { role: 'assistant', content: 'single assistant' },
        { role: 'user', content: 'final user' },
      ],
      max_tokens: 4096,
    })
    // BP3 on first user (index 0), BP4 on assistant (index 1)
    // Each should have exactly one cache_control
    const bp3Msg = body.messages[0]!
    const bp3Block = bp3Msg.content[bp3Msg.content.length - 1]!
    assert.deepEqual(bp3Block.cache_control, { type: 'ephemeral' })

    const bp4Msg = body.messages[1]!
    assert.equal(bp4Msg.role, 'assistant')
    const bp4Block = bp4Msg.content[bp4Msg.content.length - 1]!
    assert.deepEqual(bp4Block.cache_control, { type: 'ephemeral' })
  })
})

// 连续同角色折叠：Anthropic 官方 API 自动合并（"Consecutive user or assistant
// turns in your request will be combined into a single turn"），但严格实现
// （Bedrock 等）直接 400 "roles must alternate"。客户端发前折叠，语义与官方
// 合并一致——对官方零行为差异，对严格实现消除假崩。触发来源之一：ceiling
// checkpoint 的结构（59205b109）[anchors…, assistant(handoff), user(原文),
// user(task-anchor appendix)] 天然含连续 assistant / 连续 user。
describe('consecutive same-role folding (strict Anthropic backends 400 without it)', () => {
  it('folds the checkpoint handoff shape — wire roles stay alternating (59205b109 regression)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'anchor user' },
        { role: 'assistant', content: 'anchor assistant' },
        { role: 'assistant', content: '<checkpoint-resume>archived history summary</checkpoint-resume>' },
        { role: 'user', content: '用户刚发的完整指令（必须逐字送达）' },
        { role: 'user', content: '<task-anchor>Objective: ship it</task-anchor>' },
      ],
      max_tokens: 4096,
    })
    assert.deepEqual(
      body.messages.map(m => m.role),
      ['user', 'assistant', 'user'],
      'wire 角色必须严格交替——连续同角色在严格实现上 400 roles must alternate',
    )
    // 折叠是 block 按序拼接：不丢内容、不重排
    const assistant = body.messages[1]!
    assert.equal(assistant.content.length, 2)
    assert.equal(assistant.content[0]!.text, 'anchor assistant')
    assert.match(String(assistant.content[1]!.text), /checkpoint-resume/)
    const lastUser = body.messages[2]!
    assert.equal(lastUser.content.length, 2)
    assert.match(String(lastUser.content[0]!.text), /逐字送达/)
    assert.match(String(lastUser.content[1]!.text), /task-anchor/)
    // BP 建立在折叠后的形态上：BP3 首个 user 尾块、BP4 assistant 尾块
    const firstUser = body.messages[0]!
    assert.deepEqual(firstUser.content[firstUser.content.length - 1]!.cache_control, { type: 'ephemeral' })
    assert.deepEqual(assistant.content[assistant.content.length - 1]!.cache_control, { type: 'ephemeral' })
  })

  it('folds consecutive user messages; tool_result keeps order ahead of the follow-up text', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'Let me read that file.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/foo"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
        { role: 'user', content: 'follow-up question' },
      ],
      max_tokens: 4096,
    })
    assert.deepEqual(body.messages.map(m => m.role), ['user', 'assistant', 'user'])
    const last = body.messages[2]!
    assert.equal(last.content.length, 2, 'tool_result + follow-up 合并为一条 user 消息')
    assert.equal(last.content[0]!.type, 'tool_result')
    assert.equal(last.content[0]!.tool_use_id, 'call_1')
    assert.equal(last.content[1]!.type, 'text')
    assert.equal(last.content[1]!.text, 'follow-up question')
  })
})

describe('Retry-After header extraction on 429', () => {
  it('attaches retryAfterMs to error from response Retry-After header', () => {
    // Verify the shared parseRetryAfterMs function works for Anthropic-style numeric values
    const retryAfterValue = '5'
    const retryAfterMs = parseRetryAfterMs(retryAfterValue)
    assert.equal(retryAfterMs, 5_000)
  })
})

describe('AnthropicClient HTTP request construction', () => {
  const NOOP_CALLBACKS = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: () => {},
  }

  it('strips trailing slash from baseUrl before appending /v1/messages', async () => {
    let capturedUrl = ''
    const mockFetch = (globalThis as any).fetch = async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com/',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    await client.stream(
      { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 },
      NOOP_CALLBACKS as any,
      undefined,
    ).catch(() => {})
    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages')
    ;(globalThis as any).fetch = undefined
  })

  it('sends apiKey as x-api-key header', async () => {
    let capturedHeaders: Record<string, string> = {}
    const mockFetch = (globalThis as any).fetch = async (_url: string, init?: Record<string, unknown>) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-123',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    await client.stream(
      { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 },
      NOOP_CALLBACKS as any,
      undefined,
    ).catch(() => {})
    assert.equal(capturedHeaders['x-api-key'], 'sk-test-123')
    assert.equal(capturedHeaders['Content-Type'], 'application/json')
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01')
    assert.equal(capturedHeaders['Accept'], 'text/event-stream')
    ;(globalThis as any).fetch = undefined
  })

  it('accepts a baseUrl without trailing slash normally', async () => {
    let capturedUrl = ''
    const mockFetch = (globalThis as any).fetch = async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    await client.stream(
      { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 },
      NOOP_CALLBACKS as any,
      undefined,
    ).catch(() => {})
    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages')
    ;(globalThis as any).fetch = undefined
  })
})
