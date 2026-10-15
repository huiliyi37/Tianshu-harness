import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

// Regression coverage for the GLM-5.2 streaming tool-call data loss: grep
// received an empty `pattern` (→ "pattern is required") even though the model
// streamed the full arguments. Root cause: `flushToolCalls` ran on
// `finish_reason` while GLM was still streaming trailing argument deltas, and
// the silent `catch { input = {} }` fed an empty object to the tool.
//
// These drive the real SSE reader (parseStreamFromReader), which performs both
// the finish_reason flush and the end-of-stream flush, so the deferral fix is
// exercised exactly as in production.

const GLM_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-5.2',
  maxTokens: 4096,
  providerName: 'glm',
  thinking: 'enabled',
}

// DeepSeek (deepseek-v4-flash) shares the same OpenAIClient tool-call parsing
// path as GLM — the cross-tool pollution fix must hold for both. This was the
// provider that 100%-reproduced in oh-my-pi/384919c7's reviewer workers.
const DEEPSEEK_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-v4-flash',
  maxTokens: 4096,
  providerName: 'deepseek',
  thinking: 'enabled',
}

// Both providers route through OpenAIClient (factory.ts:92), so the streaming
// parser is shared. Run the cross-tool pollution regression under each.
const POLLUTION_CONFIGS: Array<{ label: string; config: OpenAIClientConfig }> = [
  { label: 'GLM', config: GLM_CONFIG },
  { label: 'DeepSeek', config: DEEPSEEK_CONFIG },
]

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

async function collectToolUses(client: OpenAIClient, frames: string[]): Promise<any[]> {
  const blocks: any[] = []
  const response = new Response(sseStream([...frames, 'data: [DONE]\n\n']))
  await (client as any).parseStreamFromReader(
    response.body!.getReader(),
    { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
  )
  return blocks.filter(b => b.type === 'tool_use')
}

const FULL_PATTERN = 'export function switchAgentRuntime|function switchAgentRuntime'

describe('GLM-5.2 tool-call streaming — grep empty pattern regression', () => {
  it('baseline: reasoning, complete tool_call, separate finish_reason', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { reasoning_content: 'searching switchAgentRuntime' }, finish_reason: null }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'grep', arguments: `{"context_lines":15,"path":"src/bootstrap.ts","pattern":"${FULL_PATTERN}"}` } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].input.pattern, FULL_PATTERN)
  })

  it('finish_reason in the same chunk as complete args', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"path":"src","pattern":"switchAgentRuntime"}' } }] }, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].input.pattern, 'switchAgentRuntime')
  })

  it('REGRESSION: finish_reason arrives before the trailing args chunk', async () => {
    // GLM emits id + name + partial args, fires finish_reason, THEN streams the
    // rest of the arguments. The fix must defer the empty parse and complete it
    // at the end-of-stream flush.
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"context_lines":15,"path":"src/bootstrap.ts","pattern":"export function ' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'switchAgentRuntime|function switchAgentRuntime"}' } }] }, finish_reason: null }] }),
    ])
    assert.equal(tools.length, 1, 'exactly one tool_use block')
    assert.equal(typeof tools[0].input.pattern, 'string', 'pattern must survive')
    assert.equal(tools[0].input.pattern, FULL_PATTERN)
  })

  it('REGRESSION: tc.index omitted on continuation chunks', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"path":"src/bootstrap.ts",' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"pattern":"switchAgentRuntime"}' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].input.pattern, 'switchAgentRuntime')
  })

  it('REGRESSION: colliding call IDs cannot graft one call onto another', async () => {
    await assert.rejects(collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'grep', arguments: '{"path":"a","pattern":"foo"}' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"path":"b","pattern":"bar"}' } }] }, finish_reason: 'tool_calls' }] }),
    ]), { name: 'ToolNameProtocolError', reason: 'identity' })
  })

  it('genuine no-argument tool call still emits an empty-object input', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'list_tools', arguments: '' } }] }, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.deepEqual(tools[0].input, {})
  })
})

// ── Cross-tool parallel pollution regression (oh-my-pi/384919c7) ──────────────
// Run under every provider that shares the OpenAIClient streaming parser. The
// 100%-reproducing session used deepseek-v4-flash; GLM hits the same path.
for (const { label, config } of POLLUTION_CONFIGS) {
  describe(`cross-tool tool_call argument pollution [${label}]`, () => {
    // Root cause: a trailing-arguments chunk after finish_reason omitted `index`,
    // and `tc.index ?? 0` grafted it onto a DIFFERENT tool's buffer. With
    // read_section at index 0 and grep at index 1, grep's trailing args landed on
    // read_section's buffer → grep got `{}` and failed "pattern is required" in a
    // loop, draining the reviewer worker before it could emit JSON.

    it('read_section[0] + grep[1], grep trailing args omit index — grep keeps pattern', async () => {
      const tools = await collectToolUses(new OpenAIClient(config), [
        frame({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'c0', type: 'function', function: { name: 'read_section', arguments: '{"file_path":"agent-session.ts","section":"L1-L10"}' } },
        ] }, finish_reason: null }] }),
        frame({ choices: [{ delta: { tool_calls: [
          { index: 1, id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"path":"src",' } },
        ] }, finish_reason: null }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        // Trailing args chunk, NO index — must reattach to grep (c1), NOT pollute
        // read_section at index 0.
        frame({ choices: [{ delta: { tool_calls: [
          { function: { arguments: '"pattern":"checkCompaction"}' } },
        ] }, finish_reason: null }] }),
      ])
      const gr = tools.find(t => t.name === 'grep')
      assert.ok(gr, 'grep tool_use must be emitted')
      assert.equal(typeof gr!.input.pattern, 'string', `grep pattern lost to pollution: ${JSON.stringify(gr!.input)}`)
      assert.equal(gr!.input.pattern, 'checkCompaction')
      assert.equal(gr!.input.file_path, undefined, 'grep must not inherit read_section file_path')
      const rs = tools.find(t => t.name === 'read_section')
      if (rs) assert.equal(rs!.input.pattern, undefined, 'read_section must not inherit grep pattern')
    })

    it('trailing args omit index when only ONE buffer open — completes that call', async () => {
      // Single-call stream: finish_reason fires, then the tail of the arguments
      // arrives without an index. Must reattach to the sole open buffer.
      const tools = await collectToolUses(new OpenAIClient(config), [
        frame({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'c0', type: 'function', function: { name: 'grep', arguments: '{"path":"src","pattern":"export function ' } },
        ] }, finish_reason: null }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        frame({ choices: [{ delta: { tool_calls: [
          { function: { arguments: 'switchAgentRuntime"}' } },
        ] }, finish_reason: null }] }),
      ])
      assert.equal(tools.length, 1)
      assert.equal(tools[0].input.pattern, 'export function switchAgentRuntime')
    })

    it('ambiguous trailing args (no index, multiple open buffers) — no pollution block', async () => {
      // Two calls open, neither complete. A trailing fragment arrives with no
      // index and no id — we cannot know which it belongs to. The fix must DROP
      // it rather than graft onto index 0. The already-parseable call still emits
      // cleanly; the orphaned fragment does not corrupt the other tool.
      const tools = await collectToolUses(new OpenAIClient(config), [
        frame({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'c0', type: 'function', function: { name: 'read_section', arguments: '{"file_path":"a.ts","section":"L1-L10"}' } },
          { index: 1, id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"path":"src","pattern":"foo"}' } },
        ] }, finish_reason: null }] }),
        // Ambiguous trailing fragment, no index/id, both buffers still open.
        frame({ choices: [{ delta: { tool_calls: [
          { function: { arguments: ',"extra":"should-not-merge-anywhere"}' } },
        ] }, finish_reason: 'tool_calls' }] }),
      ])
      const rs = tools.find(t => t.name === 'read_section')
      const gr = tools.find(t => t.name === 'grep')
      assert.ok(rs, 'read_section must still emit')
      assert.ok(gr, 'grep must still emit')
      assert.equal(gr!.input.pattern, 'foo', `grep polluted: ${JSON.stringify(gr!.input)}`)
      assert.equal(rs!.input.extra, undefined, 'read_section must not absorb the orphan fragment')
      assert.equal(gr!.input.extra, undefined, 'grep must not absorb the orphan fragment')
    })
  })
}
