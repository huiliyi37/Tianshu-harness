import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeminiClient } from '../gemini-client.js'
import { OpenAIClient } from '../openai-client.js'
import { SessionContext } from '../../agent/context.js'
import { SessionPersist, serializeOaiSessionMessage } from '../../agent/session-persist.js'
import { microCompactOai } from '../../compact/micro.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { ContentBlock, ContentBlockToolUse } from '../types.js'
import type { OaiMessage } from '../oai-types.js'

const config = { baseUrl: 'http://127.0.0.1:1', apiKey: 'fictional-fixture', model: 'fictional-model', maxTokens: 100, maxRetries: 0 }
const metadata = { gemini: { thoughtSignature: 'fictional-signature' } }
const signedBlock = { type: 'tool_use', id: 'fictional_call', name: 'glob', input: { pattern: '*.md' }, providerMetadata: metadata } as ContentBlockToolUse

// Dropping metadata at stream, context, disk, compaction or prompt boundaries loses this current-turn replay.
test('Gemini current tool turn retains signatures across context, durable checkpoint, fresh client and more than 128 calls', async () => {
  const originalFetch = globalThis.fetch
  const previousDir = process.env.RIVET_SESSION_DIR
  const dir = mkdtempSync(join(tmpdir(), 'gemini-signature-fixture-'))
  process.env.RIVET_SESSION_DIR = dir
  try {
    globalThis.fetch = (async () => new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [
      { functionCall: { name: 'glob', args: { pattern: '*.md' } }, thoughtSignature: 'fictional-first-signature' },
    ] }, finishReason: 'STOP' }] }) + '\n\n')) as typeof fetch
    const blocks: ContentBlock[] = []
    await new GeminiClient(config).stream({ model: config.model, messages: [{ role: 'user', content: 'fictional task' }] }, {
      onTextDelta() {}, onThinkingDelta() {}, onContentBlock: block => blocks.push(block), onStopReason() {}, onError() {},
    })
    const ctx = new SessionContext()
    ctx.addUserMessage('fictional task')
    ctx.addAssistantBlocks(blocks)
    const first = blocks.find(b => b.type === 'tool_use')!
    assert.equal(first.type, 'tool_use')
    ctx.addToolResults([{ type: 'tool_result', tool_use_id: first.id, content: 'first result' }])
    for (let i = 0; i < 130; i++) {
      ctx.addAssistantBlocks([{ ...signedBlock, id: `later_${i}`, providerMetadata: { gemini: { thoughtSignature: `fictional-later-${i}` } } } as ContentBlockToolUse])
      ctx.addToolResults([{ type: 'tool_result', tool_use_id: `later_${i}`, content: 'fixture result' }])
    }
    const compacted = microCompactOai(ctx.getMessages(), 64_000, 1000, new Map()).messages
    const persist = new SessionPersist('fictional-signatures', dir)
    await persist.compactOaiAsync(compacted, true)
    const restored = new SessionPersist('fictional-signatures', dir).loadOai()
    const engine = new PromptEngine({ model: config.model, maxTokens: 100, staticCtx: { tools: [] }, volatileCtx: { cwd: dir } })
    const request = engine.buildOaiRequest(restored, undefined, 1_000_000)
    const calls = new GeminiClient(config).buildRequestBodyForTest(request).contents.flatMap(c => c.parts).filter(p => p.functionCall)
    assert.equal(calls.length, 131)
    assert.equal(calls[0]?.thoughtSignature, 'fictional-first-signature')
    assert.equal(calls[130]?.thoughtSignature, 'fictional-later-129')
  } finally {
    globalThis.fetch = originalFetch
    if (previousDir === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previousDir
    rmSync(dir, { recursive: true, force: true })
  }
})

// Old legacy rows also convert ContentBlockToolUse into the same durable field.
test('legacy assistant block transcripts preserve Gemini signature during migration', async () => {
  const previousDir = process.env.RIVET_SESSION_DIR
  const dir = mkdtempSync(join(tmpdir(), 'gemini-legacy-fixture-'))
  process.env.RIVET_SESSION_DIR = dir
  try {
    const persist = new SessionPersist('fictional-legacy', dir)
    await persist.append({ role: 'user', content: 'task' })
    await persist.append({ role: 'assistant', content: [signedBlock] })
    await persist.append({ role: 'user', content: [{ type: 'tool_result', tool_use_id: signedBlock.id, content: 'result' }] })
    await persist.flushSessionBuffer()
    const calls = new GeminiClient(config).buildRequestBodyForTest({ model: config.model, messages: new SessionPersist('fictional-legacy', dir).loadOai() }).contents.flatMap(c => c.parts)
    assert.equal(calls.find(p => p.functionCall)?.thoughtSignature, 'fictional-signature')
  } finally {
    if (previousDir === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previousDir
    rmSync(dir, { recursive: true, force: true })
  }
})

const signedMessage: OaiMessage = { role: 'assistant', content: null, tool_calls: [{
  id: signedBlock.id, type: 'function', function: { name: signedBlock.name, arguments: '{"pattern":"*.md"}' }, providerMetadata: metadata,
}] } as OaiMessage

// Clipping an opaque signature or its associated arguments makes it unreplayable.
test('signed assistant protocol data survives session size cap unchanged', () => {
  const message = { ...signedMessage, content: 'x'.repeat(5000) } as OaiMessage
  assert.deepEqual(JSON.parse(serializeOaiSessionMessage(message, 1000)), message)
})

// Cross-provider requests must never send the local Gemini metadata field.
test('OpenAI transport strips Gemini metadata without changing stored history', async () => {
  const originalFetch = globalThis.fetch
  let wire: any
  try {
    globalThis.fetch = (async (_url: any, init: RequestInit) => {
      wire = JSON.parse(String(init.body))
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    await new OpenAIClient(config).stream({ model: config.model, messages: [{ role: 'user', content: 'task' }, signedMessage,
      { role: 'tool', tool_call_id: signedBlock.id, content: 'result' }] }, {
      onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {},
    })
    assert.equal(wire.messages[1].tool_calls[0].providerMetadata, undefined)
    assert.deepEqual((signedMessage as any).tool_calls[0].providerMetadata, metadata)
  } finally { globalThis.fetch = originalFetch }
})

// Micro removal cannot discard earlier tool steps within the signed current user turn.
test('micro round eviction retains the signed current tool turn under pressure', () => {
  const messages: OaiMessage[] = [{ role: 'user', content: 'task' }]
  for (let i = 0; i < 20; i++) messages.push({ ...signedMessage, tool_calls: [{ ...(signedMessage as any).tool_calls[0], id: `signed_${i}` }] } as OaiMessage,
    { role: 'tool', tool_call_id: `signed_${i}`, content: 'fixture result '.repeat(100) })
  const compacted = microCompactOai(messages, 1000, 100000, new Map()).messages
  assert.equal(compacted.filter(m => m.role === 'assistant').length, 20)
})

// Post-processing signed arguments invalidates the model's opaque replay data.
test('signed tool arguments remain intact while unsigned calls can still become pointers', () => {
  const input = { file_path: 'fictional.txt', old_string: 'old'.repeat(3000), new_string: 'new'.repeat(3000) }
  const ctx = new SessionContext()
  ctx.addAssistantBlocks([{ ...signedBlock, name: 'edit_file', input }])
  ctx.addAssistantBlocks([{ type: 'tool_use', id: 'unsigned', name: 'edit_file', input }])
  const messages = ctx.getMessages()
  assert.deepEqual(JSON.parse((messages[0] as any).tool_calls[0].function.arguments), input)
  assert.notEqual(JSON.parse((messages[1] as any).tool_calls[0].function.arguments).old_string, input.old_string)
})
