import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicClient } from '../anthropic-client.js'
import type { ContentBlock } from '../types.js'

const start = (id: string, index = 0) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'bash', input: {} } })
const delta = (partial_json: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
const stop = (index = 0) => ({ type: 'content_block_stop', index })

async function collect(events: unknown[]) {
  const blocks: ContentBlock[] = []
  const client = new AnthropicClient({ baseUrl: 'x', apiKey: 'fictional', model: 'fictional', maxTokens: 100 })
  const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  await (client as any).processSSEStream(response, {
    onTextDelta() {}, onThinkingDelta() {}, onError() {}, onStopReason() {}, onContentBlock: (block: ContentBlock) => blocks.push(block),
  })
  return blocks.filter(block => block.type === 'tool_use')
}

test('Anthropic repeated tool headers do not erase partial arguments', async () => {
  const tools = await collect([start('a'), delta('{"command":'), start('a'), delta('"git status"}'), stop()])
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.argsTruncated, undefined)
  assert.deepEqual(tools[0]?.input, { command: 'git status' })
})

test('Anthropic completed call replay emits once while distinct IDs survive', async () => {
  const tools = await collect([start('a'), delta('{}'), stop(), start('a'), delta('{}'), stop(), start('b'), delta('{}'), stop()])
  assert.deepEqual(tools.map(tool => tool.id), ['a', 'b'])
})

test('Anthropic colliding identities cannot overwrite unfinished arguments', async () => {
  await assert.rejects(collect([start('a'), delta('{'), start('b'), delta('}'), stop()]), { name: 'ToolNameProtocolError', reason: 'identity' })
})
