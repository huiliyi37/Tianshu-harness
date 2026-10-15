import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexClient } from '../codex-client.js'
import { ResponsesClient } from '../responses-client.js'
import type { ContentBlock } from '../types.js'
import type { StreamCallbacks } from '../stream-client.js'

function response(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
}
const item = (id: string, args = '{}') => ({ type: 'function_call', call_id: id, name: 'bash', arguments: args })
const done = (value: unknown) => ({ type: 'response.output_item.done', item: value })
const completed = (output: unknown[] = []) => ({ type: 'response.completed', response: { output } })

for (const Client of [CodexClient, ResponsesClient]) {
  const client = () => new Client({ baseUrl: 'http://127.0.0.1:1', apiKey: 'fictional', model: 'fictional', maxTokens: 100 })
  const collect = () => {
    const blocks: ContentBlock[] = []
    const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onError() {}, onStopReason() {}, onContentBlock: block => blocks.push(block) }
    return { blocks, callbacks }
  }

  test(`${Client.name} emits a completed tool once per call ID, not per event`, async () => {
    const { blocks, callbacks } = collect()
    await (client() as any).processSSEStream(response([done(item('a')), done(item('a')), done(item('b')), completed([item('a'), item('b')])]), callbacks)
    assert.deepEqual(blocks.filter(block => block.type === 'tool_use').map(block => block.id), ['a', 'b'])
  })

  test(`${Client.name} tool completion IDs reset for each response`, async () => {
    const { blocks, callbacks } = collect()
    const sameClient = client()
    await (sameClient as any).processSSEStream(response([done(item('a')), completed()]), callbacks)
    await (sameClient as any).processSSEStream(response([done(item('a')), completed()]), callbacks)
    assert.deepEqual(blocks.filter(block => block.type === 'tool_use').map(block => block.id), ['a', 'a'])
  })

  test(`${Client.name} uses item identity when call_id is absent`, async () => {
    const { blocks, callbacks } = collect()
    const value = { type: 'function_call', id: 'item-a', name: 'bash', arguments: '{}' }
    await (client() as any).processSSEStream(response([done(value), done(value), completed([value])]), callbacks)
    assert.deepEqual(blocks.filter(block => block.type === 'tool_use').map(block => block.id), ['item-a'])
  })

  test(`${Client.name} gives independent unidentified calls distinct fallback IDs`, async () => {
    const { blocks, callbacks } = collect()
    const now = Date.now
    try {
      Date.now = () => 1000
      const value = { type: 'function_call', name: 'bash', arguments: '{}' }
      await (client() as any).processSSEStream(response([done(value), done(value), completed()]), callbacks)
    } finally { Date.now = now }
    const tools = blocks.filter(block => block.type === 'tool_use')
    assert.equal(tools.length, 2)
    assert.equal(new Set(tools.map(tool => tool.id)).size, 2)
  })
}

test('Responses valid completed snapshot can recover an earlier malformed item', async () => {
  const blocks: ContentBlock[] = []
  await (new ResponsesClient({ baseUrl: 'x', apiKey: 'fictional', model: 'fictional', maxTokens: 100 }) as any).processSSEStream(
    response([done(item('a', '{')), completed([item('a', '{"command":"git status"}')])]),
    { onTextDelta() {}, onThinkingDelta() {}, onError() {}, onStopReason() {}, onContentBlock: (block: ContentBlock) => blocks.push(block) },
  )
  assert.deepEqual(blocks.filter(block => block.type === 'tool_use').map(block => block.input), [{ command: 'git status' }])
})

test('Codex tool consumers errors propagate instead of being swallowed by JSON parsing', async () => {
  const expected = new Error('fixture consumer failure')
  await assert.rejects((new CodexClient({ baseUrl: 'x', model: 'fictional', maxTokens: 100 }) as any).processSSEStream(
    response([done(item('a')), completed()]),
    { onTextDelta() {}, onThinkingDelta() {}, onError() {}, onStopReason() {}, onContentBlock() { throw expected } },
  ), error => error === expected)
})
