import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { ContinuationPrefixError } from '../../api/continuation-prefix.js'
import { withExecutionContinuity } from '../../api/execution-continuity.js'
import { OpenAIClient } from '../../api/openai-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import { PromptEngine } from '../../prompt/engine.js'
import { wrapSystemReminder } from '../../prompt/system-reminder.js'
import { TurnCacheObservability } from '../cache-log-observability.js'
import { SessionContext } from '../context.js'
import { createTurnStreamController } from '../loop-factory.js'
import type { AgentLoop } from '../loop.js'

const projection = '<cognitive-mirror>fixture projection</cognitive-mirror>'
const toolContext = '<tool-context>fixture tool context</tool-context>'
const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onError() {} }

async function readRows(path: string, count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const rows = (await readFile(path, 'utf8')).trim().split('\n')
        .filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      if (rows.length >= count) return rows
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await setTimeout(10)
  }
  assert.fail(`cache-log did not persist ${count} rows`)
}

async function createFixture(context: TestContext, persistenceError?: string) {
  const root = await mkdtemp(join(tmpdir(), 'stream-abort-diagnostics-'))
  const previousHome = process.env.RIVET_HOME
  const previousSessionDir = process.env.RIVET_SESSION_DIR
  process.env.RIVET_HOME = root
  process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  context.after(async () => {
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    if (previousSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = previousSessionDir
    await rm(root, { recursive: true, force: true })
  })

  const sentBodies: Record<string, unknown>[] = []
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_cache_hit_tokens":90,"prompt_cache_miss_tokens":10}}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  })

  const session = new SessionContext()
  session.addUserMessage('initial fixture goal')
  session.addUserMessage(wrapSystemReminder('fixture hook reminder'), undefined, 'hook')
  session.addUserMessage('current fixture goal')
  const engine = new PromptEngine({
    model: 'fixture-model', maxTokens: 4096, appendixDelta: true,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: root, gitStatus: 'Current branch: fixture\nStatus:\nM fixture.ts', rivetMd: '# Fixture project' },
  })
  engine.setCognitiveProjection(projection)
  engine.setToolContext(toolContext)
  const client: StreamClient = withExecutionContinuity(new OpenAIClient({
    apiKey: 'fixture', baseUrl: 'https://fixture.test/v1', providerName: 'fixture',
    model: 'fixture-model', maxTokens: 4096,
  }), { provider: 'fixture', model: 'fixture-model', singleAttempt: true })
  const self = {
    cwd: root, session,
    config: { sessionId: 'fixture-session', client, promptEngine: engine, providerName: 'fixture', contextWindow: 200_000 },
    persist: { getFrozenSnapshotError: () => persistenceError },
    streamedText: '', lastPrewarmAt: 0, prewarm: new Map(),
    prewarmController: { maybePrewarm() {} },
    turnCacheObservability: new TurnCacheObservability(),
    prevMsgCount: 0, prevEstTokens: 0, prevHitRate: null,
    prevEngineStats: { volatileSwaps: 0, frozenClamps: 0, frozenFallbackRebuilds: 0, toolsUpdates: 0 },
    lastArchive: null, ttftTotalMs: 0, ttftSamples: 0,
  }
  const controller = createTurnStreamController(self as unknown as AgentLoop)
  const request = engine.buildOaiRequest(session.getMessages(), undefined, 200_000)
  const baseline = await controller.streamTurn({ request, turn: 1, lastTurnTextFingerprint: '', callbacks })
  assert.equal(baseline.streamError, null)
  const logPath = join(root, 'sessions', 'fixture-session', 'cache-log.jsonl')
  const [success] = await readRows(logPath, 1)
  assert.ok(success)
  assert.equal(success.status, 'complete')
  assert.equal(sentBodies.length, 1)
  return { self, session, engine, controller, request, logPath, sentBodies, success }
}

async function rejectFork(fixture: Awaited<ReturnType<typeof createFixture>>, turn: number) {
  const result = await fixture.controller.streamTurn({
    request: { ...fixture.request, messages: [{ role: 'system', content: 'forked fixture system' }, ...fixture.request.messages.slice(1)] },
    turn, lastTurnTextFingerprint: 'ok', callbacks,
  })
  assert.ok(result.streamError instanceof ContinuationPrefixError)
  assert.equal(fixture.sentBodies.length, 1, 'a rejected continuation must never reach fetch')
  const rows = await readRows(fixture.logPath, 2)
  const failed = rows.find(row => row.event === 'stream_attempt_aborted')
  assert.ok(failed)
  assert.equal(failed.status, 'aborted')
  assert.equal(failed.errorName, 'ContinuationPrefixError')
  assert.equal(failed.receivedChars, 0)
  assert.equal(fixture.session.getCacheHistory().length, 1, 'failed attempts are not successful main-turn cache samples')
  return failed
}

for (const turn of [0, 7]) {
  test(`rejected continuation persists stream input turn ${turn}, not the session message count`, async context => {
    const fixture = await createFixture(context)
    assert.equal(fixture.session.getTurnCount(), 3)
    const failed = await rejectFork(fixture, turn)
    assert.equal(failed.turn, turn)
  })
}

test('rejected continuation persists existing prompt metadata without claiming provider usage', async context => {
  const fixture = await createFixture(context, 'fixture snapshot unavailable')
  const anatomy = fixture.engine.getAppendixAnatomy()
  assert.ok(anatomy && anatomy.keepChars > 0)
  assert.equal(anatomy.cvmChars, projection.length + toolContext.length)
  const expected = {
    userMsgs: 3, injected: 1,
    projChars: projection.length,
    appendixChars: fixture.engine.getCachedAppendixLength(),
    appendixPartsChars: anatomy.partsChars,
    appendixCvmChars: projection.length + toolContext.length,
    appendixCvmBySource: { projection: projection.length, 'tool-context': toolContext.length },
    appendixKeepChars: anatomy.keepChars,
    frozenPersistence: 'fixture snapshot unavailable',
  }
  const selectMetadata = (row: Record<string, unknown>) => Object.fromEntries(Object.keys(expected).map(key => [key, row[key]]))
  assert.deepEqual(selectMetadata(fixture.success), expected)
  assert.equal(fixture.success.turn, 1)
  assert.equal(fixture.success.hitRate, '90.0%')
  const successfulState = {
    prevMsgCount: fixture.self.prevMsgCount, prevEstTokens: fixture.self.prevEstTokens,
    prevHitRate: fixture.self.prevHitRate, prevEngineStats: { ...fixture.self.prevEngineStats },
    usage: { ...fixture.session.getTotalUsage() },
  }

  const failed = await rejectFork(fixture, 7)
  assert.deepEqual(selectMetadata(failed), expected)
  assert.deepEqual(failed.usageFields, {}, 'placeholder zeros must not become observed provider fields')
  assert.equal(failed.classification, 'usage_unknown')
  for (const key of ['hitRate', 'responseId', 'responseModel', 'finishReason', 'estimated']) assert.equal(key in failed, false)
  assert.deepEqual({
    prevMsgCount: fixture.self.prevMsgCount, prevEstTokens: fixture.self.prevEstTokens,
    prevHitRate: fixture.self.prevHitRate, prevEngineStats: fixture.self.prevEngineStats,
    usage: fixture.session.getTotalUsage(),
  }, {
    ...successfulState,
    usage: { ...successfulState.usage, cacheCoverage: { input: 100, read: 90, observed: 1, unknown: 0, creationUnknown: 1 } },
  })
})

test('an abort with no usage retains prompt metadata and leaves billing fields absent', async context => {
  const fixture = await createFixture(context)
  fixture.self.config.client = { stream: async (_request, streamCallbacks) => {
    const error = new Error('fixture refused locally')
    streamCallbacks.onStreamAttemptAborted?.({
      provider: 'fixture', requestId: 'refused', attemptId: 'refused:0',
      receivedChars: 0, elapsedMs: 0, errorName: error.name, errorMessage: error.message,
    })
    throw error
  } }
  const controller = createTurnStreamController(fixture.self as unknown as AgentLoop)
  const result = await controller.streamTurn({ request: fixture.request, turn: 4, lastTurnTextFingerprint: 'ok', callbacks })
  assert.equal(result.streamError?.message, 'fixture refused locally')
  const rows = await readRows(fixture.logPath, 2)
  const failed = rows.find(row => row.attemptId === 'refused:0')
  assert.ok(failed)
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreate', 'usageFields', 'hitRate', 'estimated']) assert.equal(key in failed, false)
  assert.equal(failed.frozenPersistence, 'available')
  assert.equal(failed.projChars, projection.length)
  assert.equal(failed.turn, 4)
  assert.equal(fixture.sentBodies.length, 1)
})
