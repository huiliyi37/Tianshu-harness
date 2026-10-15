import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallName, ToolNameVocabulary, ToolNameProtocolError } from '../tool-call-name.js'
import { classifyApiError } from '../error-classifier.js'

for (const [label, parts, declared, expected] of [
  ['full echoes', ['bash', 'bash', 'bash'], ['bash'], 'bash'],
  ['git echoes', ['git', 'git', 'git'], ['git'], 'git'],
  ['standard fragments', ['ba', 'sh'], ['bash'], 'bash'],
  ['snapshots', ['b', 'ba', 'bash'], ['bash'], 'bash'],
  ['mixed forms', ['ba', 'sh', 'bash'], ['bash'], 'bash'],
  ['empty fragments', ['', 'bash', '', 'bash'], ['bash'], 'bash'],
  ['repeated genuine fragments', ['a', 'a'], ['aa'], 'aa'],
  ['double underscore', ['mcp_', '_repo'], ['mcp__repo'], 'mcp__repo'],
] as const) {
  test(`tool name: ${label}`, () => {
    const name = new ToolCallName(new ToolNameVocabulary(declared))
    for (const part of parts) name.append(part)
    assert.equal(name.resolve(true), expected)
  })
}

for (const [parts, declared, reason] of [
  [['bashbashbash'], ['bash'], 'unknown'],
  [['bash', 'git'], ['bash', 'git'], 'unknown'],
  [['a', 'a'], ['a', 'aa'], 'ambiguous'],
  [['ba'], ['bash'], 'incomplete'],
  [['read_', '_file'], ['read_file'], 'unknown'],
] as const) {
  test(`tool name rejects ${parts.join('/')} as ${reason}`, () => {
    const name = new ToolCallName(new ToolNameVocabulary(declared))
    assert.throws(() => {
      for (const part of parts) name.append(part)
      name.resolve(true)
    }, (error: unknown) => error instanceof ToolNameProtocolError && error.reason === reason)
  })
}

test('ambiguous intermediate states may still complete with later fragments', () => {
  const name = new ToolCallName(new ToolNameVocabulary(['a', 'aa', 'aab']))
  name.append('a'); name.append('a')
  assert.equal(name.hintName, undefined)
  name.append('b')
  assert.equal(name.resolve(true), 'aab')
})

test('hints wait for a unique name that cannot extend to another declared tool', () => {
  const name = new ToolCallName(new ToolNameVocabulary(['read', 'read_file']))
  name.append('read')
  assert.equal(name.hintName, undefined)
  name.append('_file')
  assert.equal(name.hintName, 'read_file')
})

test('name errors do not enter automatic retry or provider failover', () => {
  for (const reason of ['unknown', 'ambiguous', 'incomplete', 'identity'] as const) {
    const classified = classifyApiError(new ToolNameProtocolError(reason))
    assert.equal(classified.retryable, false)
    assert.equal(classified.maxRetries, 0)
    assert.equal(classified.category, 'client_error')
  }
})
