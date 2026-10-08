import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

// A prefix-only hash collision must never replace the earlier distinct file.
test('request dedup retains different equal-length tool output tails and removes exact duplicates', () => {
  const engine = new PromptEngine({ model: 'fictional', maxTokens: 100, staticCtx: { tools: [] }, volatileCtx: { cwd: '/fictional' } })
  const header = '// shared header\n'.repeat(200)
  const outputs = [header + 'AAAA', header + 'BBBB', header + 'AAAA']
  const messages: OaiMessage[] = [{ role: 'user', content: 'compare fictional files' }]
  for (const [index, content] of outputs.entries()) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `call_${index}`, content })
  }
  const request = engine.buildOaiRequest(messages, undefined, 128_000)
  const tools = request.messages.filter(m => m.role === 'tool')
  assert.equal(tools[0]?.content, '[duplicate content, see later tool result]')
  assert.equal(tools[1]?.content, header + 'BBBB')
  assert.equal(tools[2]?.content, header + 'AAAA')
  assert.equal(messages[2]?.content, header + 'AAAA', 'source history stays intact')
})
