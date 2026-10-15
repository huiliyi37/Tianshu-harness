import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAIClient } from '../openai-client.js'
import type { OaiChatRequest } from '../oai-types.js'
import type { StreamCallbacks } from '../stream-client.js'
import type { ContentBlock } from '../types.js'
import { TurnStreamController } from '../../agent/turn-stream.js'

type Chunk = Parameters<OpenAIClient['processDelta']>[0]
type Call = NonNullable<NonNullable<NonNullable<Chunk['choices']>[number]['delta']['tool_calls']>[number]>
const config = { baseUrl: 'http://127.0.0.1:1', apiKey: 'fictional', model: 'fictional', maxTokens: 100,
  maxRetries: 3, retry: { backoff: { baseDelayMs: 1, jitterRatio: 0 } }, sessionId: 'name-fixture' }
let cwd: string
let dir: string
before(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), 'rivet-tool-names-')); process.chdir(dir) })
after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })

const delta = (calls: Call[], finish_reason: string | null = null): Chunk => ({ choices: [{ delta: { tool_calls: calls }, finish_reason }] })
const call = (name: string, args: string, index = 0, id?: string): Call => ({ index, ...(id ? { id, type: 'function' } : {}), function: { name, arguments: args } })
const request = (names: readonly string[]): OaiChatRequest => ({ model: 'fictional', messages: [{ role: 'user', content: 'fictional task' }],
  tools: names.map(name => ({ type: 'function', function: { name, description: 'fixture', parameters: { type: 'object', properties: {} } } })) })

function response(chunks: Chunk[]): Response {
  const text = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  // Byte boundaries deliberately do not align with SSE events.
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}

async function run(names: readonly string[], chunks: Chunk[], client = new OpenAIClient(config)) {
  const originalFetch = globalThis.fetch
  const blocks: ContentBlock[] = []
  const hints: string[] = []
  let attempts = 0
  let aborted = 0
  let error: unknown
  const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onError() {}, onStopReason() {},
    onContentBlock: block => blocks.push(block), onToolCallHint: name => hints.push(name), onStreamAttemptAborted: () => { aborted++ } }
  try {
    globalThis.fetch = (async () => { attempts++; return response(chunks) }) as typeof fetch
    await client.stream(request(names), callbacks)
  } catch (caught) { error = caught }
  finally { globalThis.fetch = originalFetch }
  return { tools: blocks.filter(block => block.type === 'tool_use'), hints, attempts, aborted, error }
}

for (const [label, parts, names, expected] of [
  ['repeated full names', ['bash', 'bash', 'bash'], ['bash'], 'bash'],
  ['standard fragments', ['ba', 'sh'], ['bash'], 'bash'],
  ['cumulative names', ['b', 'ba', 'bash'], ['bash'], 'bash'],
  ['mixed echoes and fragments', ['ba', 'sh', 'bash'], ['bash'], 'bash'],
  ['legitimate repeated fragment', ['a', 'a'], ['aa'], 'aa'],
  ['adjacent underscores', ['mcp_', '_repo'], ['mcp__repo'], 'mcp__repo'],
] as const) {
  test(`public stream preserves ${label}`, async () => {
    const chunks = parts.map((name, index) => delta([call(name,
      index === 0 ? '{"command":' : index === parts.length - 1 ? '"git status"}' : '', 0, index === 0 ? 'fixture' : undefined)]))
    chunks.push(delta([], 'tool_calls'))
    const result = await run(names, chunks)
    assert.equal(result.error, undefined)
    assert.equal(result.tools.length, 1)
    assert.equal(result.tools[0]?.name, expected)
    assert.equal(result.tools[0]?.id, 'fixture')
    assert.deepEqual(result.tools[0]?.input, { command: 'git status' })
    assert.deepEqual(result.hints, [expected])
  })
}

for (const [label, names, chunks] of [
  ['unknown single name', ['bash'], [delta([call('bashbashbash', '{}', 0, 'bad')], 'tool_calls')]],
  ['undeclared tool', ['read_file'], [delta([call('bash', '{}', 0, 'bad')], 'tool_calls')]],
  ['no declared tools', [], [delta([call('bash', '{}', 0, 'bad')], 'tool_calls')]],
  ['ambiguous echo', ['a', 'aa'], [delta([call('a', '{', 0, 'bad')]), delta([call('a', '}')], 'tool_calls')]],
  ['incomplete name', ['bash'], [delta([call('ba', '{}', 0, 'bad')], 'tool_calls')]],
  ['same-index identity collision', ['bash'], [delta([call('bash', '{', 0, 'first')]), delta([call('bash', '}', 0, 'second')], 'tool_calls')]],
  ['foreign identity continuation', ['bash'], [delta([call('bash', '{', 0, 'first')]), delta([{ id: 'second', function: { arguments: '}' } }], 'tool_calls')]],
] satisfies Array<[string, string[], Chunk[]]>) {
  test(`public stream rejects ${label} without automatic retries`, async () => {
    const result = await run(names, chunks)
    assert.equal((result.error as Error)?.name, 'ToolNameProtocolError')
    assert.equal(result.attempts, 1)
    assert.equal(result.aborted, 1)
    assert.deepEqual(result.tools, [])
    assert.deepEqual(result.hints, [])
  })
}

test('parallel calls and repeated names remain independent, including index-less headers', async () => {
  const result = await run(['bash', 'git'], [
    delta([call('bash', '{"command":', 0, 'a')]),
    delta([{ id: 'b', function: { name: 'git', arguments: '{"action":' } }]),
    delta([{ id: 'a', function: { name: 'bash', arguments: '"git status"}' } }, { id: 'b', function: { name: 'git', arguments: '"status"}' } }], 'tool_calls'),
  ])
  assert.equal(result.error, undefined)
  assert.deepEqual(result.tools.map(tool => [tool.id, tool.name, tool.input]), [
    ['a', 'bash', { command: 'git status' }], ['b', 'git', { action: 'status' }],
  ])
})

test('index-less identity headers may precede names without mixing parallel calls', async () => {
  const result = await run(['bash', 'git'], [
    delta([{ id: 'a', type: 'function', function: { name: '', arguments: '' } },
      { id: 'b', type: 'function', function: { name: '', arguments: '' } }]),
    delta([{ id: 'a', function: { name: 'bash', arguments: '{}' } },
      { id: 'b', function: { name: 'git', arguments: '{}' } }], 'tool_calls'),
  ])
  assert.equal(result.error, undefined)
  assert.deepEqual(result.tools.map(tool => [tool.id, tool.name]), [['a', 'bash'], ['b', 'git']])
})

test('completed call replay emits once; another ID with the same tool executes separately', async () => {
  const result = await run(['bash'], [
    delta([call('bash', '{}', 0, 'first')], 'tool_calls'),
    delta([call('bash', '{}', 0, 'first')], 'tool_calls'),
    delta([call('bash', '{}', 1, 'second')], 'tool_calls'),
  ])
  assert.equal(result.error, undefined)
  assert.deepEqual(result.tools.map(tool => tool.id), ['first', 'second'])
  assert.deepEqual(result.hints, ['bash', 'bash'])
})

test('a call may reuse a flushed slot with a new ID and receives its own hint', async () => {
  const result = await run(['bash'], [delta([call('bash', '{}', 0, 'first')], 'tool_calls'), delta([call('bash', '{}', 0, 'second')], 'tool_calls')])
  assert.equal(result.error, undefined)
  assert.deepEqual(result.tools.map(tool => tool.id), ['first', 'second'])
  assert.deepEqual(result.hints, ['bash', 'bash'])
})

test('name and arguments can finish after finish_reason without losing fragments', async () => {
  const result = await run(['bash'], [delta([call('ba', '{"command":', 0, 'late')], 'tool_calls'), delta([call('sh', '"git status"}')])])
  assert.equal(result.error, undefined)
  assert.equal(result.tools[0]?.name, 'bash')
  assert.deepEqual(result.tools[0]?.input, { command: 'git status' })
})

test('short registered prefixes never fire a premature hint', async () => {
  const result = await run(['read', 'read_file'], [delta([call('read', '{}', 0, 'prefix')]), delta([call('_file', '')], 'tool_calls')])
  assert.equal(result.error, undefined)
  assert.deepEqual(result.hints, ['read_file'])
  assert.equal(result.tools[0]?.name, 'read_file')
})

test('a premature finish_reason cannot commit a short tool-name prefix', async () => {
  const result = await run(['read', 'read_file'], [delta([call('read', '{}', 0, 'prefix')], 'tool_calls'), delta([call('_file', '')])])
  assert.equal(result.error, undefined)
  assert.deepEqual(result.tools.map(tool => tool.name), ['read_file'])
  assert.deepEqual(result.hints, ['read_file'])
})

test('an actual short tool name still commits at the final stream boundary', async () => {
  const result = await run(['read', 'read_file'], [delta([call('read', '{}', 0, 'short')], 'tool_calls')])
  assert.equal(result.error, undefined)
  assert.deepEqual(result.tools.map(tool => tool.name), ['read'])
  assert.deepEqual(result.hints, ['read'])
})

test('name vocabulary, partial candidates and completed IDs reset between requests', async () => {
  const client = new OpenAIClient(config)
  const failed = await run(['bash'], [delta([call('ba', '{}', 0, 'reused')], 'tool_calls')], client)
  assert.equal((failed.error as Error)?.name, 'ToolNameProtocolError')
  const first = await run(['git'], [delta([call('git', '{}', 0, 'reused')], 'tool_calls')], client)
  const second = await run(['bash'], [delta([call('bash', '{}', 0, 'reused')], 'tool_calls')], client)
  assert.equal(first.error, undefined); assert.equal(second.error, undefined)
  assert.equal(first.tools[0]?.name, 'git'); assert.equal(second.tools[0]?.name, 'bash')
})

test('protocol rejection discards tools already collected in this attempt before execution', async () => {
  const originalFetch = globalThis.fetch
  let notifications = 0
  try {
    globalThis.fetch = (async () => response([
      delta([call('bash', '{}', 0, 'good')], 'tool_calls'),
      delta([call('bashbash', '{}', 1, 'bad')], 'tool_calls'),
    ])) as typeof fetch
    const controller = new TurnStreamController({ client: new OpenAIClient(config), getAbortSignal: () => new AbortController().signal,
      getStreamedTextLength: () => 0, appendStreamedText() {}, truncateStreamedText() {}, getLastPrewarmAt: () => 0,
      setLastPrewarmAt() {}, maybePrewarm() {}, addUsage() {}, recordTurnCache() {}, recordStreamAttemptAborted() {} })
    const result = await controller.streamTurn({ request: request(['bash']), turn: 1, lastTurnTextFingerprint: '',
      callbacks: { onTextDelta() {}, onThinkingDelta() {}, onError() {}, onToolUse() { notifications++ } } })
    assert.equal(result.streamError?.name, 'ToolNameProtocolError')
    assert.deepEqual(result.toolUses, [])
    assert.equal(notifications, 0)
  } finally { globalThis.fetch = originalFetch }
})

test('name diagnostics record lengths without argument content', async () => {
  await run(['bash'], [delta([call('bash', '{"command":"fixture-do-not-log"}', 0, 'log')]), delta([call('bash', '')], 'tool_calls')])
  const text = readFileSync(join(dir, '.rivet', 'tool-stream-name-fixture.jsonl'), 'utf8')
  assert.ok(text.includes('name-repeat'))
  assert.ok(!text.includes('fixture-do-not-log'))
})

test('repeated-name diagnostics are bounded per call', async () => {
  const client = new OpenAIClient({ ...config, sessionId: 'bounded-name-log' })
  const chunks = [delta([call('bash', '{}', 0, 'bounded')]),
    ...Array.from({ length: 50 }, () => delta([call('bash', '')])), delta([], 'tool_calls')]
  const result = await run(['bash'], chunks, client)
  assert.equal(result.error, undefined)
  assert.equal(result.tools.length, 1)
  const events = readFileSync(join(dir, '.rivet', 'tool-stream-bounded-name-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.filter(event => event.phase === 'name-repeat').length, 1)
})
