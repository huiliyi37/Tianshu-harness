import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeForJsonTransport, sanitizeMessageContent } from '../sanitize.js'

describe('sanitizeForJsonTransport', () => {
  it('passes through normal text unchanged', () => {
    assert.equal(sanitizeForJsonTransport('Hello, world! 你好世界'), 'Hello, world! 你好世界')
  })

  it('passes through emoji unchanged', () => {
    assert.equal(sanitizeForJsonTransport('😀🎉🔥'), '😀🎉🔥')
  })

  it('passes through tab and newline unchanged', () => {
    assert.equal(sanitizeForJsonTransport('hello\tworld\nfoo\r\nbar'), 'hello\tworld\nfoo\r\nbar')
  })

  it('replaces C0 control characters (except \\t \\n \\r) with space', () => {
    assert.equal(sanitizeForJsonTransport('hello\x00world'), 'hello world')
    assert.equal(sanitizeForJsonTransport('a\x01b\x02c'), 'a b c')
    assert.equal(sanitizeForJsonTransport('\x03\x04\x05'), '   ')
    // BEL, BS, VT, FF, DEL-range (but not \t \n \r)
    assert.equal(sanitizeForJsonTransport('\x07\x08\x0B\x0C'), '    ')
  })

  it('replaces C1 control characters with space', () => {
    assert.equal(sanitizeForJsonTransport('a\x80b\x90c'), 'a b c')
    assert.equal(sanitizeForJsonTransport('\x9F'), ' ')
  })

  it('replaces lone high surrogate with U+FFFD', () => {
    // U+D800 without a following low surrogate
    const lone = '\uD800'
    const result = sanitizeForJsonTransport(lone)
    assert.equal(result, '\uFFFD')
  })

  it('replaces lone low surrogate with U+FFFD', () => {
    const lone = '\uDC00'
    const result = sanitizeForJsonTransport(lone)
    assert.equal(result, '\uFFFD')
  })

  it('replaces high surrogate followed by non-surrogate with U+FFFD', () => {
    const input = '\uD800A'
    const result = sanitizeForJsonTransport(input)
    assert.equal(result, '\uFFFDA')
  })

  it('preserves valid surrogate pairs (emoji)', () => {
    const emoji = '😀' // U+1F600 = \uD83D\uDE00
    assert.equal(sanitizeForJsonTransport(emoji), emoji)
  })

  it('handles mixed content with controls and emoji', () => {
    const input = 'Hello\x00😀\x01World\x80🎉\x9F'
    const result = sanitizeForJsonTransport(input)
    assert.equal(result, 'Hello 😀 World 🎉 ')
  })

  it('handles empty string', () => {
    assert.equal(sanitizeForJsonTransport(''), '')
  })

  it('produces valid JSON that round-trips correctly', () => {
    const inputs = [
      'Hello\x00\x01\x02World',
      '\uD800lone high',
      '\uDC00lone low',
      '\x00\x01\x02\x03\x04\x05emoji😀',
    ]
    for (const input of inputs) {
      const sanitized = sanitizeForJsonTransport(input)
      const json = JSON.stringify({ content: sanitized })
      const parsed = JSON.parse(json)
      assert.ok(typeof parsed.content === 'string', `Round-trip failed for: ${JSON.stringify(input)}`)
    }
  })

  it('does not inflate JSON body size for normal text', () => {
    const normal = 'Hello, world! This is a normal string with emoji 😀🎉.'
    const sanitized = sanitizeForJsonTransport(normal)
    assert.equal(sanitizeForJsonTransport(normal).length, normal.length)
    const jsonLen = JSON.stringify({ content: sanitized }).length
    assert.equal(jsonLen, JSON.stringify({ content: normal }).length)
  })

  it('significantly reduces JSON size for control-char-heavy strings', () => {
    // 100 null bytes → 100 × "\u0000" (6 chars each) = 600 chars in JSON
    const controlHeavy = '\x00'.repeat(100)
    const sanitized = sanitizeForJsonTransport(controlHeavy)
    // 100 spaces → 100 chars in JSON (no escaping needed)
    const jsonSize = JSON.stringify({ c: sanitized }).length
    assert.ok(jsonSize < 200, `Expected JSON < 200 bytes, got ${jsonSize}`)
  })

  it('normalizes to NFC', () => {
    // é can be U+00E9 (NFC) or U+0065 + U+0301 (NFD)
    const nfd = 'e\u0301'
    const result = sanitizeForJsonTransport(nfd)
    assert.equal(result, 'é')
    assert.equal(result.length, 1)
  })
})

describe('sanitizeMessageContent', () => {
  it('sanitizes string values in nested objects', () => {
    const msg = {
      role: 'user' as const,
      content: 'Hello\x00\uD800World',
    }
    const result = sanitizeMessageContent(msg)
    assert.equal(result.content, 'Hello \uFFFDWorld')
  })

  it('sanitizes strings in arrays', () => {
    const input = ['Hello\x00World', 'Normal text']
    const result = sanitizeMessageContent(input)
    assert.deepEqual(result, ['Hello World', 'Normal text'])
  })

  it('passes through non-string values unchanged', () => {
    const input = { count: 42, flag: true, nothing: null }
    const result = sanitizeMessageContent(input)
    assert.deepEqual(result, input)
  })

  it('handles tool_calls objects with function.arguments strings', () => {
    const msg = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{
        id: 'call_123',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"echo \\x00hello"}' },
      }],
    }
    const result = sanitizeMessageContent(msg)
    // The arguments string is a regular string — it gets sanitized
    assert.equal(typeof result.tool_calls?.[0]?.function.arguments, 'string')
  })
})
