import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripOaiImageParts,
  oaiMessagesHaveImageParts,
  STRIPPED_IMAGE_PLACEHOLDER,
  type OaiMessage,
} from '../oai-types.js'

// ---------------------------------------------------------------------------
// oaiMessagesHaveImageParts
// ---------------------------------------------------------------------------

describe('oaiMessagesHaveImageParts', () => {
  it('is false for text-only messages', () => {
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    assert.equal(oaiMessagesHaveImageParts(msgs), false)
  })

  it('is true when a user message carries an image_url part', () => {
    const msgs: OaiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]
    assert.equal(oaiMessagesHaveImageParts(msgs), true)
  })

  it('is false for empty message arrays', () => {
    assert.equal(oaiMessagesHaveImageParts([]), false)
  })
})

// ---------------------------------------------------------------------------
// stripOaiImageParts
// ---------------------------------------------------------------------------

describe('stripOaiImageParts', () => {
  it('returns the same reference when no image part exists (cheap no-op)', () => {
    const msgs: OaiMessage[] = [{ role: 'user', content: 'text only' }]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 0)
    assert.equal(result.messages, msgs, 'must not copy when nothing changed')
  })

  it('removes image_url parts, preserving text and other messages', () => {
    const msgs: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'keep me' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 2)
    assert.notEqual(result.messages, msgs, 'must return a copy after stripping')
    const user = result.messages[1]!
    assert.equal(user.role, 'user')
    assert.deepEqual(user.content, [{ type: 'text', text: 'keep me' }])
    assert.deepEqual(result.messages[0], msgs[0], 'system message untouched')
    assert.deepEqual(result.messages[2], msgs[2], 'assistant message untouched')
  })

  it('replaces an image-only user message with a text placeholder', () => {
    const msgs: OaiMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      },
    ]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 1)
    assert.deepEqual(result.messages[0]!.content, [
      { type: 'text', text: STRIPPED_IMAGE_PLACEHOLDER },
    ])
  })

  it('does not mutate the input array', () => {
    const msgs: OaiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 't' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]
    stripOaiImageParts(msgs)
    assert.equal(
      (msgs[0]!.content as unknown[]).length,
      2,
      'input content parts must be untouched',
    )
  })
})
