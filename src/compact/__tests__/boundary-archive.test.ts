import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OaiMessage } from '../../api/oai-types.js'
import { collectStaleArchiveCandidates, collectMicroArchiveCandidates } from '../boundary-archive.js'
import { compactStaleRoundsOai } from '../stale-round.js'
import { microCompactOai } from '../micro.js'

// W1-A3: compact-boundary archive adapter. Pure transforms receive an
// index→artifactId map; marker-less messages are only truncated when archived,
// otherwise kept intact (fail-open).

function toolMsg(content: string, id = 'read_file_1'): OaiMessage {
  return { role: 'tool', tool_call_id: id, content }
}

/** Tool message content is always a string; narrow it for assertions. */
function text(msg: OaiMessage | undefined): string {
  return (msg?.content ?? '') as string
}

function baseline(): OaiMessage[] {
  // 2 anchors + stale middle + recent tail (recentToKeep=4 at 64K window)
  return [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'ack' },
    toolMsg('x'.repeat(5_000), 'read_file_stale1'), // stale, no marker → candidate
    toolMsg(`y`.repeat(5_000) + '\n[artifact:already_here]', 'bash_stale2'), // stale, has marker
    toolMsg('short', 'grep_stale3'), // below preview
    { role: 'assistant', content: 'mid' },
    { role: 'user', content: 'follow' },
    { role: 'assistant', content: 'tail1' },
    { role: 'user', content: 'tail2' },
  ]
}

describe('collectStaleArchiveCandidates', () => {
  it('collects only stale, marker-less, over-preview tool messages', () => {
    const msgs = baseline()
    const candidates = collectStaleArchiveCandidates(msgs, 64_000, 1_200)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]!.index, 2)
    assert.equal(candidates[0]!.toolCallId, 'read_file_stale1')
  })

  it('returns empty when history is shorter than anchors + recent', () => {
    const msgs = baseline().slice(0, 4)
    assert.equal(collectStaleArchiveCandidates(msgs, 64_000, 1_200).length, 0)
  })
})

describe('compactStaleRoundsOai with recoveryRefs', () => {
  it('attaches the archived artifact marker to marker-less truncations', () => {
    const msgs = baseline()
    const refs = new Map([[2, 'compact_archive_7']])
    const out = compactStaleRoundsOai(msgs, 64_000, 1_200, refs)
    const truncated = text(out[2])
    assert.ok(truncated.includes('<stale-compacted'), 'must be truncated')
    assert.match(truncated, /\[artifact:compact_archive_7\]\s*$/, 'archived ref must be the tail marker')
  })

  it('fail-open: marker-less message with NO ref is kept intact', () => {
    const msgs = baseline()
    const out = compactStaleRoundsOai(msgs, 64_000, 1_200, new Map())
    assert.equal(text(out[2]), text(msgs[2]), 'unarchived original must be kept intact')
    // The marker-bearing message still truncates normally.
    assert.ok(text(out[3]).includes('<stale-compacted'))
    assert.match(text(out[3]), /\[artifact:already_here\]\s*$/)
  })

  it('legacy callers (no refs map) keep the old truncate-without-ref behavior', () => {
    const msgs = baseline()
    const out = compactStaleRoundsOai(msgs, 64_000, 1_200)
    assert.ok(text(out[2]).includes('<stale-compacted'), 'legacy behavior truncates')
    assert.ok(!text(out[2]).includes('[artifact:'), 'no invented marker')
  })
})

describe('microCompactOai with recoveryRefs', () => {
  function microMsgs(): OaiMessage[] {
    // Big marker-less tool result in the same (only) turn — turnAge stays low
    // so the truncation stub path (not collapse) fires.
    return [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'ack' },
      toolMsg('z'.repeat(60_000), 'read_file_big'),
      { role: 'assistant', content: 'done' },
      { role: 'assistant', content: 'more' },
      { role: 'assistant', content: 'more2' },
      { role: 'assistant', content: 'more3' },
    ]
  }

  it('collectMicroArchiveCandidates finds marker-less over-preview tool messages', () => {
    const candidates = collectMicroArchiveCandidates(microMsgs(), 64_000)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]!.index, 2)
  })

  it('attaches archived marker to the microcompacted stub', () => {
    const refs = new Map([[2, 'compact_archive_9']])
    const { messages } = microCompactOai(microMsgs(), 64_000, 10_000, refs)
    const stub = text(messages[2])
    assert.ok(stub.includes('<microcompacted'), 'must be truncated')
    assert.match(stub, /\[artifact:compact_archive_9\]\s*$/, 'archived ref must be the tail marker')
  })

  it('fail-open: marker-less message with no ref stays intact when archive pass ran', () => {
    const { messages } = microCompactOai(microMsgs(), 64_000, 10_000, new Map())
    assert.equal(text(messages[2]).length, 60_000, 'unarchived original kept intact')
  })

  it('preserves an existing trailing marker in the stub (previously dropped)', () => {
    const msgs = microMsgs()
    msgs[2] = toolMsg('w'.repeat(60_000) + '\n[artifact:pre_existing]', 'bash_big')
    const { messages } = microCompactOai(msgs, 64_000, 10_000)
    const stub = text(messages[2])
    assert.ok(stub.includes('<microcompacted'))
    assert.match(stub, /\[artifact:pre_existing\]\s*$/, 'existing marker must survive micro truncation')
  })

  it('legacy behavior without refs map: truncates marker-less content (no invented marker)', () => {
    const { messages } = microCompactOai(microMsgs(), 64_000, 10_000)
    assert.ok(text(messages[2]).includes('<microcompacted'))
    assert.ok(!text(messages[2]).includes('[artifact:'))
  })
})

describe('semantic micro-compaction archive boundary', () => {
  function oldTool(content: string): OaiMessage[] {
    const messages: OaiMessage[] = [{ role: 'user', content: 'initial task' }, { role: 'assistant', content: 'ack' }, toolMsg(content)]
    for (let i = 0; i < 5; i++) messages.push({ role: 'user', content: `next ${i}` }, { role: 'assistant', content: 'ack' })
    return messages
  }
  const medium = 'first observation\n' + 'fictional details\n'.repeat(30) + 'UNIQUE_MIDDLE_OBSERVATION\n' + 'tail\n'.repeat(30)

  // A collector that only considers truncation length misses this semantic loss.
  it('archives medium old observations before semantic collapse', () => {
    const input = oldTool(medium)
    assert.deepEqual(collectMicroArchiveCandidates(input, 64_000), [{ index: 2, content: medium, toolCallId: 'read_file_1' }])
    const out = microCompactOai(input, 64_000, 1000, new Map([[2, 'semantic_fixture']]))
    assert.match(text(out.messages[2]), /\[artifact:semantic_fixture\]$/)
    assert.ok(text(out.messages[2]).length < medium.length)
  })
  // Moving the guard after semantic collapse must make these originals disappear.
  for (const content of [medium, medium.repeat(100)]) {
    it('retains old original observations when their recovery archive failed', () => {
      const input = oldTool(content)
      const out = microCompactOai(input, 64_000, 1000, new Map())
      assert.equal(text(out.messages[2]), content)
      assert.equal(out.truncated, 0)
    })
  }
  it('does not archive unchanged short or current-turn medium results', () => {
    assert.deepEqual(collectMicroArchiveCandidates(oldTool('short'), 64_000), [])
    assert.deepEqual(collectMicroArchiveCandidates([{ role: 'user', content: 'task' }, toolMsg(medium)], 64_000), [])
  })
})

// Tier2 cannot retire an observation and its only recovery pointer together.
it('micro round eviction keeps tool observation rounds when a recovery pass is specified', () => {
  const messages: OaiMessage[] = [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'ack' }]
  for (let i = 0; i < 20; i++) messages.push({ role: 'assistant', content: null, tool_calls: [{
    id: `fixture_${i}`, type: 'function', function: { name: 'glob', arguments: '{}' },
  }] }, { role: 'tool', tool_call_id: `fixture_${i}`, content: i === 2 ? 'UNIQUE_OBSERVATION [artifact:fictional_ref]' : 'small result' })
  const out = microCompactOai(messages, 1000, 100000, new Map())
  assert.equal(out.messages.filter(m => m.role === 'tool').length, 20)
  assert.ok(out.messages.some(m => m.role === 'tool' && m.content.includes('UNIQUE_OBSERVATION [artifact:fictional_ref]')))
})
