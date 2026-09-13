import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { requestTimeCollapse, computeCollapseBoundary } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

function makeToolResult(toolCallId: string, content: string): OaiMessage {
  return { role: 'tool', tool_call_id: toolCallId, content }
}

function makeAssistantWithToolCall(callId: string, fnName: string, args = '{}'): OaiMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: callId, type: 'function', function: { name: fnName, arguments: args } }],
  }
}

function makeUser(content: string): OaiMessage {
  return { role: 'user', content }
}

describe('computeCollapseBoundary', () => {
  it('returns 0 when no message is old enough', () => {
    const messages: OaiMessage[] = [
      makeUser('task 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('task 2'),
    ]
    assert.equal(computeCollapseBoundary(messages, 4), 0)
  })

  it('covers messages whose turn age >= collapseAge', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),                       // idx 0, age 5
      makeAssistantWithToolCall('c1', 'grep'),  // idx 1, age 5
      makeToolResult('c1', 'x'.repeat(500)),    // idx 2, age 5
      makeUser('turn 2'),                       // idx 3, age 4
      makeUser('turn 3'),                       // idx 4, age 3
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    // age >= 4 holds through idx 3 (turn 2, age 4) → boundary 4
    assert.equal(computeCollapseBoundary(messages, 4), 4)
  })
})

describe('requestTimeCollapse', () => {
  it('does not collapse recent tool results (below-boundary only)', () => {
    const messages: OaiMessage[] = [
      makeUser('task 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('task 2'),
    ]
    const original = messages[2]!.content
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[2]!.content, original)
  })

  it('collapses old tool results below the boundary', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', Array.from({ length: 50 }, (_, i) => `src/file${i}.ts:10: match`).join('\n')),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    const originalLen = (messages[2]! as { content: string }).content.length
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    const collapsed = (messages[2]! as { content: string }).content
    assert.ok(collapsed.length < originalLen)
    assert.ok(collapsed.startsWith('[collapsed grep:'))
  })

  it('skips already-collapsed results', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', '[collapsed grep: already done]'),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[2]!.content, '[collapsed grep: already done]')
  })

  it('skips small tool results (< 200 chars)', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'small result'),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[2]!.content, 'small result')
  })

  it('does not mutate non-tool messages', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[0]!.content, 'turn 1')
    assert.equal(messages[3]!.content, 'turn 2')
  })

  it('does not touch tool results at or above the boundary even if old', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),   // idx 2: below boundary 3 → collapsed
      makeAssistantWithToolCall('c2', 'grep'),
      makeToolResult('c2', 'y'.repeat(500)),   // idx 4: above boundary 3 → untouched
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 3, 1_000_000)
    assert.notEqual(messages[2]!.content, 'x'.repeat(500))
    assert.equal(messages[4]!.content, 'y'.repeat(500))
  })

  it('strips reasoning_content from assistant messages below the boundary', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'long old thinking '.repeat(100),
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }],
      },
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 3, 1_000_000)
    assert.equal('reasoning_content' in messages[1]!, false)
    // tool_calls preserved — only the reasoning is dropped
    assert.ok((messages[1] as { tool_calls?: unknown[] }).tool_calls?.length)
  })

  it('keeps reasoning_content on assistant messages at or above the boundary', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'recent thinking',
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'grep', arguments: '{}' } }],
      },
      makeToolResult('c2', 'y'.repeat(500)),
      makeUser('turn 2'),
    ]
    requestTimeCollapse(messages, 3, 1_000_000)
    assert.equal((messages[3] as { reasoning_content?: string }).reasoning_content, 'recent thinking')
  })

  it('ensures content exists after stripping reasoning from a no-tool-call assistant message', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      { role: 'assistant', content: null, reasoning_content: 'thinking only' },
      makeUser('turn 2'),
    ]
    requestTimeCollapse(messages, 2, 1_000_000)
    assert.equal('reasoning_content' in messages[1]!, false)
    assert.equal(messages[1]!.content, '')
  })

  it('frozen boundary produces byte-identical collapse output across repeated calls', () => {
    const build = (): OaiMessage[] => [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', Array.from({ length: 50 }, (_, i) => `src/file${i}.ts:10: match`).join('\n')),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    const a = build()
    requestTimeCollapse(a, 3, 1_000_000)
    const b = [...build(), makeUser('turn 7')]
    requestTimeCollapse(b, 3, 1_000_000)
    assert.equal(a[2]!.content, b[2]!.content)
  })

  it('folds superseded grep results (same pattern re-searched)', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep', JSON.stringify({ pattern: 'foo' })),
      makeToolResult('c1', Array.from({ length: 20 }, (_, i) => `src/f${i}.ts:1: foo`).join('\n')),
      makeAssistantWithToolCall('c2', 'grep', JSON.stringify({ pattern: 'foo' })),
      makeToolResult('c2', Array.from({ length: 20 }, (_, i) => `src/f${i}.ts:1: foo updated`).join('\n')),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 5, 1_000_000)
    assert.match(messages[2]!.content as string, /superseded/)
    assert.doesNotMatch(messages[4]!.content as string, /superseded/)
  })

  it('folds duplicate read_file results (same file re-read)', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'read_file', JSON.stringify({ path: 'src/app.ts' })),
      makeToolResult('c1', 'x'.repeat(500)),
      makeAssistantWithToolCall('c2', 'read_file', JSON.stringify({ path: 'src/app.ts' })),
      makeToolResult('c2', 'y'.repeat(500)),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 5, 1_000_000)
    assert.match(messages[2]!.content as string, /superseded/)
    assert.doesNotMatch(messages[4]!.content as string, /superseded/)
  })

  it('lightOnly mode strips reasoning and folds dedup but skips semantic collapse', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'old thinking',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }],
      },
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 3, 1_000_000, true)
    // reasoning stripped
    assert.equal('reasoning_content' in messages[1]!, false)
    // non-dedup tool result NOT collapsed in lightOnly mode
    assert.equal(messages[2]!.content, 'x'.repeat(500))
  })

  it('dedups parallel tool calls from a single assistant message via the prebuilt index (issue #138)', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'foo' }) } },
          { id: 'c2', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'foo' }) } },
        ],
      },
      makeToolResult('c1', Array.from({ length: 20 }, (_, i) => `src/f${i}.ts:1: foo`).join('\n')),
      makeToolResult('c2', Array.from({ length: 20 }, (_, i) => `src/f${i}.ts:1: foo updated`).join('\n')),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 5, 1_000_000)
    assert.match(messages[2]!.content as string, /superseded/)
    assert.doesNotMatch(messages[4]!.content as string, /superseded/)
  })

  it('treats tool results without matching assistant calls as unknown (index miss → no dedup)', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeToolResult('ghost-call', 'x'.repeat(500)),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 3, 1_000_000)
    // 未找到 assistant tool_call → name unknown：不参与 dedup，但语义折叠照旧
    // （与旧直线回溯一致：inferToolName 同样返回 unknown）。
    assert.doesNotMatch(messages[1]!.content as string, /superseded/)
    assert.match(messages[1]!.content as string, /^\[collapsed unknown:/)
  })
})
