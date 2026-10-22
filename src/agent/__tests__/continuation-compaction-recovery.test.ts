import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { open, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createProviderClient } from '../../api/factory.js'
import { currentExecutionScope, withExecutionContinuity } from '../../api/execution-continuity.js'
import { ContinuationPrefixError, proveRewindHistory } from '../../api/continuation-prefix.js'
import { resolveCapabilities } from '../../api/provider.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, MAX_SESSION_MESSAGE_JSON_CHARS } from '../../compact/constants.js'
import { estimateOaiTokens } from '../../compact/micro.js'
import { providerSchema } from '../../config/schema.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { FrozenSnapshotData } from '../../prompt/frozen-snapshot.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { AgentLoop, type AgentCallbacks } from '../loop.js'
import { SessionPersist, serializeOaiSessionMessage } from '../session-persist.js'
import { appendChecksum } from '../checksum.js'
import { encodeBatch } from '../session-transcript-codec.js'
import { buildContextBudget, genericBudgetPolicy } from '../../context/request-budget.js'
import { createBudgetedCompactionHistory, createCompactionPressureInput, isSnapshotDirectoryCollision } from './compaction-pressure-fixture.js'

async function verifyCompactionRecovery(context: TestContext, entry: 'automatic' | 'public' | 'official' | 'official-auto' | 'unknown' | 'persisted-unknown' | 'binding' | 'credential' | 'conflict' | 'object-conflict' | 'worker' | 'native-writer',
  persistence: 'none' | 'resume' | 'pending-old' | 'pending-new' | 'pending-other' | 'pending-old-append' | 'pending-new-append' | 'intent-append' | 'commit-append' | 'snapshot-failure' | 'snapshot-retry' | 'final-auth-failure' | 'serialized-mismatch' | 'cancel-tail' | 'consume-race' | 'consume-effort' | 'consume-native' | 'abort-intent' | 'legacy-projection' | 'legacy-corruption' | 'legacy-invalid-row' | 'legacy-unproven' | 'legacy-cold-resume' | 'legacy-readback' | 'legacy-readback-invalid-row' | 'legacy-live-change' | 'legacy-torn-frame' | 'legacy-readback-torn-frame' = 'none'): Promise<void> {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'continuation-compaction-recovery-'))
  const previousEnvironment = {
    RIVET_HOME: process.env.RIVET_HOME,
    RIVET_SESSION_DIR: process.env.RIVET_SESSION_DIR,
    RIVET_TOKEN_STORE: process.env.RIVET_TOKEN_STORE,
  }
  process.env.RIVET_HOME = join(root, 'home')
  process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  process.env.RIVET_TOKEN_STORE = 'local-key'
  mkdirSync(process.env.RIVET_HOME, { recursive: true })
  mkdirSync(process.env.RIVET_SESSION_DIR, { recursive: true })
  writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
  const agents: AgentLoop[] = []
  context.after(async () => {
    for (const active of agents) {
      await active.cancelIdleCompaction()
      await active.drainPostSession()
      await active.drainPersistWrites().catch(() => {})
      await active.persist?.drainFrozenSnapshots()
      active.stopFsWatcher()
      active.stopConfigWatcher()
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const summary = persistence === 'serialized-mismatch' ? 'status detail. '.repeat(24_000)
    : 'Earlier status exchanges are complete; preserve the current follow-up request.'
  const bodies: Array<{ messages: OaiMessage[] }> = []
  const summaryBodies: Array<{ messages: OaiMessage[] }> = []
  const summaryProofs: unknown[] = []
  const postCancellationBodies: unknown[] = []
  let cancelled = false
  const ceilingSnapshots: Array<{ messages: OaiMessage[]; estimatedTokens: number }> = []
  const native = entry === 'native-writer'
  context.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), `https://compaction.fixture.test/v1/${native ? 'messages' : 'chat/completions'}`)
    const body = JSON.parse(String(init.body)) as { messages: OaiMessage[]; response_format?: { type: string } }
    if (cancelled) postCancellationBodies.push(body)
    const lastContent = body.messages.at(-1)?.content
    const budgetSummary = Array.isArray(lastContent) && body.response_format?.type === 'json_object'
    const summaryText = native ? JSON.stringify(lastContent) : lastContent
    const isSummary = budgetSummary || (typeof summaryText === 'string'
      && (summaryText.includes('请总结上述对话的关键信息') || summaryText.includes('请总结以下对话片段')))
    if (isSummary) {
      summaryBodies.push(body)
      summaryProofs.push(structuredClone(client.getMainPrefixProof?.()))
      ceilingSnapshots.push({
        messages: structuredClone(session.getMessages()), estimatedTokens: session.getEstimatedTokens(),
      })
      if (entry === 'conflict') session.addUserMessage('A human request arriving during summary.')
      if (entry === 'object-conflict') session.getMessages()[3]!.content = 'A historical object changed during summary.'
    } else if (currentExecutionScope()?.beforeSend) bodies.push(body)
    const frame = {
      choices: [{ delta: { content: budgetSummary
        ? JSON.stringify({ version: 1, summary, facts: [], requirements: [], pendingApprovals: [] })
        : isSummary ? summary : 'The status is available.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: estimateOaiTokens(body.messages), completion_tokens: 20 },
    }
    if (native) {
      const events = [
        { type: 'message_start', message: { id: 'fixture-native-response', usage: { input_tokens: estimateOaiTokens(body.messages) } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: isSummary ? summary : 'The status is available.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  })

  const provider = providerSchema.parse({
    name: 'third-party', protocol: native ? 'anthropic' : 'openai', baseUrl: `https://compaction.fixture.test${native ? '' : '/v1'}`,
    maxTokens: 4096, maxRetries: 0, unsupported: [],
    models: [{ id: 'fixture-model', contextWindow: 1_000_000, maxTokens: 4096 }],
  })
  const makeClient = () => createProviderClient(provider, resolveCapabilities(provider.name), {
    apiKey: 'fixture', model: 'fixture-model', maxTokens: 4096,
  })
  const engineConfig = {
    model: 'fixture-model', maxTokens: 4096,
    staticCtx: { tools: [] }, volatileCtx: { cwd: root, gitStatus: '' },
    ...(entry.startsWith('official') ? { requestBudgetPolicy: { windowTokens: 1_000_000, maxOutputTokens: 4096, transportLimits: 'none' as const } } : {}),
  }
  let client = makeClient()
  if (entry === 'worker') client = withExecutionContinuity(client, { provider: provider.name, model: 'fixture-model', singleAttempt: true })
  let session = new SessionContext()
  const historyCount = persistence === 'snapshot-failure' || persistence === 'snapshot-retry' || persistence === 'cancel-tail' || persistence === 'abort-intent' || entry === 'official-auto' || native ? 230 : 160
  session.replaceMessages(createBudgetedCompactionHistory(historyCount, messages => {
    // Probe a separate engine: never prepare or publish a turn on the tested engine.
    const probe = new PromptEngine(structuredClone(engineConfig))
    const request = probe.buildOaiRequest([...messages, { role: 'user', content: 'What is the current status?' }], [], 1_000_000)
    const visible = client.previewContextRequest?.(request) ?? request
    return buildContextBudget(visible, engineConfig.requestBudgetPolicy ?? genericBudgetPolicy(1_000_000)!, {
      requestId: 'fixture-seed-calibration', revision: 0,
    })
  }))
  if (persistence.startsWith('legacy-')) session.getMessages()[3]!.content = 'published source. '.repeat(12_000)
  let engine = new PromptEngine(engineConfig)
  let persist = persistence === 'none' ? undefined : new SessionPersist('compaction-fixture', root)
  const snapshotPath = persist ? join(dirname(persist.getFilePath()), 'compaction-fixture.frozen.json') : undefined
  if (persist) {
    await persist.compactOaiAsync(session.getMessages(), true)
    const initialPersist = persist
    engine.setOnFrozenSnapshotChanged(() => initialPersist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
    engine.setOnFrozenSnapshotCommit(() => initialPersist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
  }
  const makeAgent = () => new AgentLoop({
    client, primaryClient: client, promptEngine: engine, providerName: provider.name,
    toolRegistry: new ToolRegistry(), headless: true, maxTurns: 2, contextWindow: 1_000_000,
    agentReconnect: { enabled: false, maxAttempts: 0 },
    compact: { enabled: true, model: 'fixture-model' },
    ...(persistence === 'cancel-tail' ? { interruptMarker: false } : {}),
    ...(entry.startsWith('official') ? { budgetSummaryClient: () => client } : {}),
    ...(entry === 'worker' ? { inputOrigin: 'worker_task' as const } : {}),
    ...(persist ? { sessionId: 'compaction-fixture', sessionPersist: persist } : {}),
  }, session, root)
  let agent = makeAgent()
  agents.push(agent)
  const errors: Error[] = []
  const callbacks: AgentCallbacks = {
    onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {},
    onError: error => { errors.push(error) }, onAbort() {},
    onApprovalRequired: async () => assert.fail('this fixture has no tools'),
  }
  if (entry.startsWith('official')) assert.ok(engine.getRequestBudgetPolicy())
  else assert.equal(engine.getRequestBudgetPolicy(), undefined)
  await agent.run('What is the current status?', callbacks)
  await agent.cancelIdleCompaction()
  await agent.drainPersistWrites()
  await persist?.drainFrozenSnapshots()
  assert.deepEqual(errors.map(error => error.message), [])
  const initialBudget = agent.getContextBudget()
  assert.ok(initialBudget)
  assert.equal(initialBudget.windowTokens, 1_000_000)
  assert.equal(initialBudget.outputReserve, 4096)
  assert.ok(initialBudget.inputTokens <= initialBudget.inputBudget, 'the first real request must fit before any recovery scenario begins')
  assert.equal(persist?.getFrozenSnapshotError(), undefined)
  assert.equal(bodies.length, 1, 'the initial history must reach the real provider transport')
  assert.equal(summaryBodies.length, 0, 'the initial normal run must not reach the context ceiling')
  const published = client.getMainPrefixProof!()!
  assert.ok(published.cacheGenerationId)
  const before = structuredClone(session.getMessages())
  const baselineSnapshot = persist?.readFrozenSnapshot()
  const occupancy = session.getEstimatedTokens()
  if (persistence.startsWith('legacy-')) {
    const projected = before.map(message => JSON.parse(serializeOaiSessionMessage(message, MAX_SESSION_MESSAGE_JSON_CHARS)) as OaiMessage)
    assert.ok(JSON.stringify(projected) !== JSON.stringify(before), 'the legacy projection must actually lose published source bytes')
    if (persistence === 'legacy-corruption') projected[3]!.content += '\nUNRELATED_CORRUPTION'
    const lines = projected.map(message => appendChecksum(JSON.stringify(message)))
    if (persistence === 'legacy-invalid-row') lines.push('{"role":"assistant","content":"hidden corruption"}|0000000000000000')
    writeFileSync(persist!.getFilePath(), encodeBatch(lines.join('\n') + '\n'))
    if (persistence === 'legacy-torn-frame') {
      writeFileSync(persist!.getFilePath(), Buffer.concat([readFileSync(persist!.getFilePath()), encodeBatch('unexplained tail\n').subarray(0, 7)]))
    }
    if (persistence === 'legacy-unproven') {
      engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: { ...baselineSnapshot!, publishedHistory: undefined } })
      agent.config.promptEngine = engine
      assert.equal(engine.assertPublishedHistory(before), false)
    }
    if (persistence === 'legacy-cold-resume') {
      engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: baselineSnapshot! })
      session = new SessionContext()
      session.replaceMessages(persist!.loadOai())
      agent = makeAgent()
      agents.push(agent)
    }
    let repairBoundaryReached = false
    if (persistence === 'legacy-readback' || persistence === 'legacy-readback-invalid-row' || persistence === 'legacy-live-change' || persistence === 'legacy-readback-torn-frame') {
      const rewrite = persist!.compactOaiAsync.bind(persist)
      context.mock.method(persist!, 'compactOaiAsync', async (messages: OaiMessage[], durable?: boolean) => {
        await rewrite(messages, durable)
        if (!repairBoundaryReached) {
          repairBoundaryReached = true
          if (persistence === 'legacy-live-change') session.getMessages()[3]!.content = 'A concurrent change to published source.'
          else if (persistence === 'legacy-readback-torn-frame') {
            writeFileSync(persist!.getFilePath(), Buffer.concat([readFileSync(persist!.getFilePath()), encodeBatch('unexplained tail\n').subarray(0, 7)]))
          }
          else if (persistence === 'legacy-readback-invalid-row') {
            const repairedLines = messages.map(message => appendChecksum(serializeOaiSessionMessage(message)))
            repairedLines.push('{"role":"assistant","content":"hidden corruption"}|0000000000000000')
            writeFileSync(persist!.getFilePath(), encodeBatch(repairedLines.join('\n') + '\n'))
          }
          else {
            const corrupted = structuredClone(messages)
            corrupted[3]!.content = 'Corrupted readback after the repair transaction.'
            await rewrite(corrupted, durable)
          }
        }
      })
    }
    if (persistence !== 'legacy-projection') {
      const original = readFileSync(persist!.getFilePath())
      await assert.rejects(agent.compaction.maybeCompact({ loopTurn: 0, failures: agent.compactFailures }), /历史.*变化|持久化历史不完整|prefix diverged/)
      assert.deepEqual(client.getMainPrefixProof!(), published)
      assert.equal(engine.getRewindAuthorization(), undefined)
      assert.equal(persist!.readFrozenSnapshot()!.pendingCompaction, undefined)
      assert.equal(bodies.length, 1)
      if (persistence === 'legacy-readback' || persistence === 'legacy-readback-invalid-row' || persistence === 'legacy-live-change' || persistence === 'legacy-readback-torn-frame') assert.equal(repairBoundaryReached, true)
      else assert.deepEqual(readFileSync(persist!.getFilePath()), original)
      return
    }
    const commit = agent.commitBudgetHistory.bind(agent)
    let repairs = 0
    context.mock.method(agent, 'commitBudgetHistory', async (source: OaiMessage[], target: OaiMessage[]) => {
      await commit(source, target)
      if (JSON.stringify(source) === JSON.stringify(target)) {
        repairs++
        assert.ok(JSON.stringify(persist!.loadOai()) === JSON.stringify(before), 'the existing transaction must durably restore the exact complete live history')
        assert.deepEqual(client.getMainPrefixProof!(), published)
        assert.equal(persist!.readFrozenSnapshot()!.rewindAuthorization, undefined)
      }
    })
    context.after(() => assert.equal(repairs, 1, 'the legacy projection must be repaired once before ordinary compaction'))
  }
  if (persistence === 'abort-intent') {
    const commit = persist!.commitFrozenSnapshot.bind(persist)
    let interrupted = false
    context.mock.method(persist!, 'commitFrozenSnapshot', async (snapshot: FrozenSnapshotData, cancel?: string) => {
      await commit(snapshot, cancel)
      if (!interrupted && snapshot.pendingCompaction) { interrupted = true; agent.abort() }
    })
    await agent.run(createCompactionPressureInput(session.getEstimatedTokens(), 1_000_000, 'Abort this user before its first main request.'), callbacks)
    assert.equal(interrupted, true)
    assert.equal(bodies.length, 1)
    await agent.drainPersistWrites()
    assert.equal(persist!.readFrozenSnapshot()!.pendingCompaction, undefined)
    await agent.run('C_AFTER_ABORTED_INTENT: this user must be protected once published.', callbacks)
    await agent.run('A second valid main request after cancelling the pending intent.', callbacks)
    await agent.drainPersistWrites()
    await persist!.drainFrozenSnapshots()
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(bodies.length, 3)
    const recovered = new SessionPersist('compaction-fixture', root).readFrozenSnapshot()!
    assert.equal(recovered.rewindAuthorization, undefined)
    assert.deepEqual(recovered.executionSnapshot, client.getMainPrefixProof!(),
      'cancelling an old-state intent must release the writer for later published requests')
    const altered = structuredClone(session.getMessages())
    altered.find(message => typeof message.content === 'string' && message.content.startsWith('C_AFTER_ABORTED_INTENT'))!.content = 'An unauthorized replacement of C.'
    await persist!.compactOaiAsync(altered, true)
    engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: recovered })
    client = makeClient()
    client.restoreExecutionSnapshot!(recovered.executionSnapshot!)
    session = new SessionContext()
    session.replaceMessages(persist!.loadOai())
    agent = makeAgent()
    agents.push(agent)
    await agent.run('Continue without rewriting C.', callbacks)
    assert.equal(bodies.length, 3)
    assert.ok(errors.some(error => error instanceof ContinuationPrefixError))
    return
  }
  if (persistence === 'cancel-tail') {
    const reset = engine.resetAppendixBaseline.bind(engine)
    const lateReminderText = 'LATE_FUNCTIONAL_SR_AFTER_COMPACTION: preserve this advisory after cancelling only the unsent input.'
    let lateReminder: OaiMessage | undefined
    context.mock.method(engine, 'resetAppendixBaseline', () => {
      reset()
      if (!cancelled && engine.getRewindAuthorization()?.reason === 'context_limit') {
        context.diagnostic(JSON.stringify({
          cancellationBoundary: true,
          activeIndex: session.getMessages().indexOf(agent.requestContext.activeUserMessage!),
          userCount: engine.getPublishedUserCount(),
          summaryContainsCancelledInput: summaryBodies.some(body => JSON.stringify(body).includes('UNSENT_B_CANCELLED')),
          messages: session.getMessages().map(message => ({ role: message.role,
            cancelledInput: typeof message.content === 'string' && message.content.includes('UNSENT_B_CANCELLED') })),
        }))
        cancelled = true
        session.appendSystemReminder(lateReminderText, 'functional')
        lateReminder = session.getMessages().at(-1)
        assert.ok(lateReminder?.role === 'user')
        assert.equal(lateReminder.origin, 'hook', 'the late functional SR must be an independent message after the active input')
        assert.notEqual(lateReminder, session.resolveUserInput(agent.requestContext.activeUserMessage))
        agent.abort()
      }
    })
    const input = createCompactionPressureInput(session.getEstimatedTokens(), 1_000_000, 'UNSENT_B_CANCELLED: new input to cancel before the main HTTP request.')
    await agent.run(input, callbacks)
    assert.equal(cancelled, true, 'cancellation must occur after the real committed compression authorization')
    assert.equal(bodies.length, 1, 'B must never reach the main HTTP boundary')
    assert.ok(!session.getMessages().some(message => message.content === input),
      'the real post-ceiling rollback must remove active B instead of popping its later functional SR')
    assert.ok(lateReminder && session.getMessages().includes(lateReminder),
      'cancelling active B must preserve the exact later functional SR occurrence')
    const forged = structuredClone(session.getMessages())
    forged[0]!.content = 'An unauthorized change to a protected historical anchor.'
    assert.throws(() => engine.assertPublishedHistory(forged), /历史/)
    await agent.drainPersistWrites()
    assert.ok(persist!.loadOai().some(message => typeof message.content === 'string' && message.content.includes(lateReminderText)),
      'the preserved late functional SR must also remain durable')
    await agent.run('Continue after cancelling the unsent user input.', callbacks)
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(bodies.length, 2)
    assert.ok(bodies[1]!.messages.some(message => typeof message.content === 'string' && message.content.includes(lateReminderText)),
      'the next real main HTTP request must retain the late functional SR')
    assert.ok(postCancellationBodies.every(body => !JSON.stringify(body).includes('UNSENT_B_CANCELLED')),
      'no later HTTP request may resurrect the cancelled user input')
    assert.ok(!JSON.stringify(session.getMessages()).includes('UNSENT_B_CANCELLED'),
      'the cancelled input must not remain in generated history after withdrawal')
    assert.ok(!JSON.stringify(persist!.loadOai()).includes('UNSENT_B_CANCELLED'))
    return
  }
  if (entry === 'official-auto') {
    const input = createCompactionPressureInput(session.getEstimatedTokens(), 1_000_000, 'Continue with this additional status evidence:',
      initialBudget.inputBudget - initialBudget.inputTokens + 2048)
    await agent.run(input, callbacks)
    await agent.drainPersistWrites()
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(bodies.length, 2)
    assert.ok(summaryBodies.length > 0, 'the real request budget must automatically summarize the oversized input')
    const proof = client.getMainPrefixProof!()!
    assert.equal(proof.generationReason, 'context_limit')
    assert.notEqual(proof.cacheGenerationId, published.cacheGenerationId)
    assert.ok(session.getMessages().includes(agent.requestContext.activeUserMessage!))
    const restartedPersist = new SessionPersist('compaction-fixture', root)
    const recovered = restartedPersist.readFrozenSnapshot()!
    engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: recovered })
    client = makeClient()
    client.restoreExecutionSnapshot!(recovered.executionSnapshot!)
    session = new SessionContext()
    session.replaceMessages(restartedPersist.loadOai())
    persist = restartedPersist
    agent = makeAgent()
    agents.push(agent)
    await agent.run('Continue after the automatic budget compaction restart.', callbacks)
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(bodies.length, 3)
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, proof.cacheGenerationId)
    assert.ok(session.getMessages().some(message => typeof message.content === 'string' && message.content.includes(input)))
    return
  }
  const lateInput = 'A legitimate human input appended at the durable commit boundary.'
  if (entry === 'binding' || entry === 'credential') {
    const changedProvider = entry === 'binding' ? { ...provider, baseUrl: 'https://changed.fixture.test/v1' } : provider
    client = createProviderClient(changedProvider, resolveCapabilities(provider.name), {
      apiKey: entry === 'credential' ? 'changed-fixture' : 'fixture', model: 'fixture-model', maxTokens: 4096,
    })
    client.restoreExecutionSnapshot!(published)
    agent.config.client = client
    await assert.rejects(agent.compaction.maybeCompact({ loopTurn: 0, failures: agent.compactFailures }), /binding|绑定/)
    assert.deepEqual(session.getMessages(), before)
    assert.deepEqual(client.getMainPrefixProof!(), published)
    await agent.run('Continue only under the original execution binding.', callbacks)
    assert.equal(bodies.length, 1)
    assert.ok(errors.some(error => error instanceof ContinuationPrefixError && error.changed === 'binding'))
    return
  }
  if (entry === 'persisted-unknown') {
    const altered = structuredClone(before)
    altered[3]!.content = 'Unknown historical content that was also written to disk.'
    session.replaceMessages(altered)
    await agent.drainPersistWrites()
    assert.deepEqual(persist!.loadOai(), session.getMessages())
    await assert.rejects(agent.compaction.maybeCompact({ loopTurn: 0, failures: agent.compactFailures }), /历史|prefix/)
    assert.deepEqual(client.getMainPrefixProof!(), published)
    assert.deepEqual(session.getMessages(), altered)
    assert.equal(bodies.length, 1)
    assert.equal(persist!.readFrozenSnapshot()!.pendingCompaction, undefined)
    return
  }
  if (persistence === 'final-auth-failure') {
    const commit = persist!.commitFrozenSnapshot.bind(persist)
    const frozenPath = join(dirname(persist!.getFilePath()), 'compaction-fixture.frozen.json')
    context.mock.method(persist!, 'commitFrozenSnapshot', async (snapshot: FrozenSnapshotData, cancel?: string) => {
      if (snapshot.rewindAuthorization && !snapshot.pendingCompaction) {
        renameSync(frozenPath, `${frozenPath}.pending`)
        mkdirSync(frozenPath)
        try { await commit(snapshot, cancel) }
        finally {
          rmSync(frozenPath, { recursive: true, force: true })
          renameSync(`${frozenPath}.pending`, frozenPath)
        }
      } else await commit(snapshot, cancel)
    })
  }
  if (persistence === 'intent-append') {
    const commit = persist!.commitFrozenSnapshot.bind(persist)
    let injected = false
    context.mock.method(persist!, 'commitFrozenSnapshot', async (snapshot: FrozenSnapshotData, cancel?: string) => {
      await commit(snapshot, cancel)
      if (snapshot.pendingCompaction && !injected) {
        injected = true
        session.addUserMessage(lateInput)
      }
    })
  }
  if (persistence === 'commit-append') {
    const commit = agent.commitBudgetHistory.bind(agent)
    context.mock.method(agent, 'commitBudgetHistory', async (source: OaiMessage[], target: OaiMessage[]) => {
      await commit(source, target)
      session.addUserMessage(lateInput)
    })
  }
  if (entry === 'conflict' || entry === 'object-conflict' || entry === 'worker') {
    await assert.rejects(agent.compaction.maybeCompact({ loopTurn: 0, failures: agent.compactFailures }),
      entry === 'worker' ? /执行策略/ : /历史.*变化/)
    assert.equal(bodies.length, 1, 'a rejected compaction must not dispatch a new main request')
    assert.deepEqual(client.getMainPrefixProof!(), published, 'a rejected compaction must retain its old execution proof')
    assert.equal(engine.getRewindAuthorization(), undefined)
    if (entry === 'conflict') {
      assert.ok(session.getMessages().some(message => message.role === 'user' && message.content === 'A human request arriving during summary.'))
    } else if (entry === 'object-conflict') {
      assert.equal(session.getMessages()[3]!.content, 'A historical object changed during summary.')
      return
    } else assert.deepEqual(session.getMessages(), before, 'a worker must reject before replacing any history')
    await agent.run('Continue with the original unmodified published prefix.', callbacks)
    assert.deepEqual(errors.map(error => error.message), [])
    assert.equal(bodies.length, 2)
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, published.cacheGenerationId)
    return
  }
  if (entry === 'unknown') {
    const altered = structuredClone(before)
    altered[3]!.content = 'An unauthorized replacement of published history.'
    session.replaceMessages(altered)
    await agent.run('Continue without authorizing any history rewrite.', callbacks)
    assert.equal(bodies.length, 1, 'unknown historical edits must remain blocked before HTTP')
    assert.equal(summaryBodies.length, 0)
    assert.ok(errors.some(error => error instanceof ContinuationPrefixError))
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, published.cacheGenerationId)
    return
  }
  const nextInput = entry === 'automatic'
    ? createCompactionPressureInput(occupancy, 1_000_000, 'Continue with this additional status evidence:')
    : 'Continue with the follow-up status.'
  const addedInputTokens = estimateOaiTokens([{ role: 'user', content: nextInput }])
  assert.ok(occupancy < 950_000)
  if (entry === 'automatic') {
    assert.ok(occupancy + addedInputTokens > 950_000 && occupancy + addedInputTokens < 1_000_000,
      'a legal new user input must naturally cross 95% without exceeding the context window')
  } else {
    assert.ok(occupancy >= 600_000 && occupancy < 750_000,
      `the public entry must naturally reach the legacy partial-LLM ladder (occupancy=${occupancy})`)
    const compact = () => entry === 'official' ? agent.compactContext('保留本次压缩重点')
      : agent.compaction.maybeCompact({ loopTurn: 0, failures: agent.compactFailures }).then(result => result.compacted)
    if (persistence === 'intent-append') {
      await assert.rejects(compact(), /历史.*变化/)
      await agent.drainPersistWrites()
      assert.deepEqual(client.getMainPrefixProof!(), published)
      assert.ok(session.getMessages().some(message => message.content === lateInput))
      const restartedPersist = new SessionPersist('compaction-fixture', root)
      const recovered = restartedPersist.readFrozenSnapshot()!
      assert.equal(recovered.rewindAuthorization, undefined)
      engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: recovered })
      client = makeClient()
      client.restoreExecutionSnapshot!(recovered.executionSnapshot!)
      session = new SessionContext()
      session.replaceMessages(restartedPersist.loadOai())
      persist = restartedPersist
      agent = makeAgent()
      agents.push(agent)
      await agent.run(nextInput, callbacks)
      assert.deepEqual(errors.map(error => error.message), [])
      assert.equal(bodies.length, 2)
      assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, published.cacheGenerationId)
      assert.ok(bodies[1]!.messages.some(message => String(message.content).includes(lateInput)))
      return
    }
    if (persistence === 'serialized-mismatch') {
      const rewrite = persist!.compactOaiAsync.bind(persist)
      context.mock.method(persist!, 'compactOaiAsync', async (messages: OaiMessage[], durable?: boolean) => {
        const corrupted = structuredClone(messages)
        const target = corrupted.find(message => typeof message.content === 'string')
        assert.ok(target && typeof target.content === 'string')
        target.content += '\nCORRUPTED_TRANSCRIPT_FIXTURE'
        await rewrite(corrupted, durable)
      })
      await assert.rejects(agent.compaction.maybeCompact({ loopTurn: 0, failures: agent.compactFailures }), /持久化历史不完整/)
      const frozenPath = join(dirname(persist!.getFilePath()), 'compaction-fixture.frozen.json')
      const journal = JSON.parse(readFileSync(frozenPath, 'utf8'))
      assert.ok(journal.pendingCompaction, 'the pending intent must be durable before committing the transcript')
      assert.equal(journal.pendingCompaction.authorization.reason, 'context_limit',
        'the durable intent must already exist when a post-transcript commit check fails')
      assert.deepEqual(journal.executionSnapshot, published)
      assert.throws(() => persist!.readFrozenSnapshot(), /历史.*压缩/,
        'a serialized transcript matching neither complete history must not recover any generation')
      await assert.rejects(agent.run('Continue only if the compacted history was safely authorized.', callbacks), /无法恢复|禁止继续/)
      assert.equal(bodies.length, 1)
      assert.deepEqual(client.getMainPrefixProof!(), published)
      return
    }
    if (persistence === 'final-auth-failure') {
      await assert.rejects(compact(), error => isSnapshotDirectoryCollision(error, snapshotPath!))
      assert.deepEqual(client.getMainPrefixProof!(), published)
      assert.throws(() => engine.buildOaiRequest(session.getMessages()), /prefix diverged at source/)
      await persist!.drainFrozenSnapshots()
      const frozenPath = join(dirname(persist!.getFilePath()), 'compaction-fixture.frozen.json')
      assert.ok(JSON.parse(readFileSync(frozenPath, 'utf8')).pendingCompaction,
        'an ordinary failed build must not overwrite the unresolved durable intent')
      assert.equal(bodies.length, 1)
    } else assert.equal(await compact(), true, 'the public controller must actually commit its own rewrite')
    assert.deepEqual(summaryProofs[0], published, 'the summary side path must not poison the main execution proof')
    if (persist) {
      const committed = persist.readFrozenSnapshot()!
      const expectedReason = entry === 'official' ? 'explicit_user_compact' : 'context_limit'
      assert.equal(committed.rewindAuthorization?.reason, expectedReason)
      if (entry === 'official') assert.ok(session.getMessages().includes(agent.requestContext.activeUserMessage!),
        'the protected active user must point to the actual cloned session object after commit')
      if (persistence === 'commit-append') assert.ok(session.getMessages().some(message => message.content === lateInput))
      assert.equal(committed.rewindAuthorization!.prior.cacheGenerationId, published.cacheGenerationId)
      assert.notEqual(committed.rewindAuthorization!.cacheGenerationId, published.cacheGenerationId)
      const authorizedGeneration = committed.rewindAuthorization!.cacheGenerationId
      if (persistence.startsWith('consume-')) {
        await persist.drainFrozenSnapshots()
        const staleAuthorization = engine.exportFrozenSnapshot()
        const handle = await open(join(root, 'sync-gate-probe'), 'w')
        const prototype = Object.getPrototypeOf(handle) as FileHandle
        const sync = prototype.sync
        await handle.close()
        let release!: () => void, reached!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const entered = new Promise<void>(resolve => { reached = resolve })
        let paused = false
        const syncMock = context.mock.method(prototype, 'sync', async function (this: FileHandle) {
          if (!paused) { paused = true; reached(); await gate }
          await sync.call(this)
        })
        context.after(() => { release(); syncMock.mock.restore() })
        const running = agent.run('C_PUBLISHED_AFTER_COMPACTION: retain this new user request exactly.', callbacks)
        await Promise.race([entered, running.then(() => assert.fail('the real authorization consumption must reach durable file sync'))])
        try {
          assert.equal(bodies.length, 1, 'the consuming HTTP request must wait for durable authorization storage')
          assert.equal(engine.exportFrozenSnapshot().rewindAuthorization?.cacheGenerationId, authorizedGeneration)
          persist.queueFrozenSnapshot(engine.exportFrozenSnapshot())
        } finally { release() }
        await running
        syncMock.mock.restore()
        await agent.drainPersistWrites()
        await persist.drainFrozenSnapshots()
        assert.deepEqual(errors.map(error => error.message), [])
        assert.equal(bodies.length, 2)
        const consumed = persist.readFrozenSnapshot()!
        assert.equal(consumed.rewindAuthorization, undefined,
          'a snapshot queued during durable consumption must not resurrect the old authorization')
        assert.equal(consumed.executionSnapshot!.cacheGenerationId, authorizedGeneration)
        persist.queueFrozenSnapshot(staleAuthorization)
        persist.queueFrozenSnapshot(baselineSnapshot!)
        await persist.drainFrozenSnapshots()
        assert.deepEqual(persist.readFrozenSnapshot()!.executionSnapshot, consumed.executionSnapshot,
          'late old authorization and old-generation snapshots must not replace the consumed proof')
        assert.equal(persist.readFrozenSnapshot()!.rewindAuthorization, undefined)
        await assert.rejects(persist.commitFrozenSnapshot(staleAuthorization), /已消费|替代/)
        if (persistence !== 'consume-race') {
          if (persistence === 'consume-effort') agent.setReasoningEffort('high')
          await agent.run('A legitimate later request after consuming the compaction authorization.', callbacks)
          await agent.drainPersistWrites()
          await persist.drainFrozenSnapshots()
          assert.deepEqual(errors.map(error => error.message), [])
          assert.equal(bodies.length, 3)
          const nextProof = client.getMainPrefixProof!()!
          if (persistence === 'consume-effort') {
            assert.notEqual(nextProof.cacheGenerationId, consumed.executionSnapshot!.cacheGenerationId)
            assert.equal(nextProof.generationReason, 'explicit_user_effort')
          } else {
            assert.equal(nextProof.cacheGenerationId, consumed.executionSnapshot!.cacheGenerationId)
            assert.ok(consumed.executionSnapshot!.messages.some((message, index) => nextProof.messages[index]?.hash !== message.hash),
              'the real native transport must rotate a cache breakpoint in an earlier native message')
          }
          assert.deepEqual(persist.readFrozenSnapshot()!.executionSnapshot, nextProof,
            'a genuinely published native roll or new generation must replace the old frozen proof')
        }
        const requestsBeforeTampering = bodies.length
        const altered = structuredClone(session.getMessages())
        const user = altered.find(message => typeof message.content === 'string' && message.content.startsWith('C_PUBLISHED_AFTER_COMPACTION'))!
        user.content = 'An unauthorized replacement of newly published C.'
        await persist.compactOaiAsync(altered, true)
        const restartedPersist = new SessionPersist('compaction-fixture', root)
        const recovered = restartedPersist.readFrozenSnapshot()!
        engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: recovered })
        client = makeClient()
        client.restoreExecutionSnapshot!(recovered.executionSnapshot!)
        session = new SessionContext()
        session.replaceMessages(restartedPersist.loadOai())
        persist = restartedPersist
        agent = makeAgent()
        agents.push(agent)
        await agent.run('Continue without rewriting published C.', callbacks)
        assert.equal(bodies.length, requestsBeforeTampering, 'tampered C must be rejected before any resumed HTTP request')
        assert.ok(errors.some(error => error instanceof ContinuationPrefixError))
        return
      }
      if (persistence.startsWith('pending-')) {
        const recoveryHistory = persistence.startsWith('pending-old') ? structuredClone(before) : structuredClone(session.getMessages())
        if (persistence.endsWith('-append')) recoveryHistory.push({ role: 'user', content: lateInput })
        if (persistence === 'pending-other') recoveryHistory[3]!.content = 'An unauthorized historical rewrite.'
        await persist.compactOaiAsync(recoveryHistory, true)
        await persist.commitFrozenSnapshot({
          ...baselineSnapshot!,
          pendingCompaction: { version: 1, priorHistory: proveRewindHistory(before), authorization: committed.rewindAuthorization! },
        })
      }
      const restartedPersist = new SessionPersist('compaction-fixture', root)
      if (persistence === 'pending-other') {
        assert.throws(() => restartedPersist.readFrozenSnapshot(), /压缩.*历史|历史.*压缩/)
        assert.equal(bodies.length, 1)
        return
      }
      const recovered = restartedPersist.readFrozenSnapshot()!
      assert.equal(recovered.pendingCompaction, undefined)
      assert.equal(recovered.rewindAuthorization?.reason, persistence.startsWith('pending-old') ? undefined : expectedReason)
      await agent.drainPostSession()
      engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: recovered })
      client = makeClient()
      if (recovered.rewindAuthorization) client.restoreRewindAuthorization!(recovered.rewindAuthorization)
      else client.restoreExecutionSnapshot!(recovered.executionSnapshot!)
      engine.setExecutionSnapshotCommit(snapshot => restartedPersist.commitFrozenSnapshot(snapshot))
      session = new SessionContext()
      session.replaceMessages(restartedPersist.loadOai())
      persist = restartedPersist
      agent = makeAgent()
      agents.push(agent)
      await agent.run(nextInput, callbacks)
      assert.deepEqual(errors.map(error => ({ name: error.name, message: error.message })), [])
      assert.equal(bodies.length, 2, 'a rebuilt engine/client must continue through the real HTTP transport')
      assert.equal(client.getMainPrefixProof!()!.cacheGenerationId,
        persistence.startsWith('pending-old') ? published.cacheGenerationId : authorizedGeneration)
      assert.equal(recovered.executionSnapshot!.cacheGenerationId, published.cacheGenerationId,
        'recovery must retain the prior proof instead of silently cold-starting')
      if (persistence.endsWith('-append') || persistence === 'commit-append') {
        assert.ok(bodies[1]!.messages.some(message => String(message.content).includes(lateInput)), 'recovery must preserve legitimate appended input')
      }
      if (!persistence.startsWith('pending-old')) {
        assert.equal(persist.readFrozenSnapshot()!.rewindAuthorization, undefined,
          'the first resumed HTTP request must durably consume the pending authorization')
      }
      return
    }
  }

  if (persistence === 'snapshot-failure' || persistence === 'snapshot-retry') {
    const frozenPath = join(dirname(persist!.getFilePath()), 'compaction-fixture.frozen.json')
    renameSync(frozenPath, `${frozenPath}.baseline`)
    mkdirSync(frozenPath)
  }
  await agent.run(nextInput, callbacks)
  await agent.cancelIdleCompaction()
  if (persistence === 'snapshot-failure' || persistence === 'snapshot-retry') {
    assert.equal(summaryBodies.length, 1)
    assert.equal(bodies.length, 1, 'failed authorization storage must prevent any new main HTTP request')
    assert.ok(errors.some(error => isSnapshotDirectoryCollision(error, snapshotPath!)),
      `the actual filesystem failure must surface: ${JSON.stringify(errors.map(error => ({ name: error.name, message: error.message })))}`)
    assert.deepEqual(client.getMainPrefixProof!(), published)
    assert.equal(engine.getRewindAuthorization(), undefined)
    assert.deepEqual(session.getMessages().slice(0, before.length), before,
      'a failed pending-intent write must not commit the candidate history')
    if (persistence === 'snapshot-retry') {
      const frozenPath = join(dirname(persist!.getFilePath()), 'compaction-fixture.frozen.json')
      const commit = persist!.commitFrozenSnapshot.bind(persist)
      let localRecoveryCommits = 0
      context.mock.method(persist!, 'commitFrozenSnapshot', async (snapshot: FrozenSnapshotData, cancel?: string) => {
        localRecoveryCommits++
        await commit(snapshot, cancel)
      })
      await assert.rejects(agent.run('Explicitly continue while the local storage is still unavailable.', callbacks), error => isSnapshotDirectoryCollision(error, snapshotPath!))
      assert.equal(localRecoveryCommits, 1, 'an explicit run may attempt local recovery only once while storage remains unavailable')
      assert.equal(summaryBodies.length, 1)
      assert.equal(bodies.length, 1)
      rmSync(frozenPath, { recursive: true })
      renameSync(`${frozenPath}.baseline`, frozenPath)
      errors.length = 0
      await agent.run('C_AFTER_REPAIRED_STORAGE: retain this input after the explicit recovery run.', callbacks)
      await agent.drainPersistWrites()
      await persist!.drainFrozenSnapshots()
      assert.deepEqual(errors.map(error => error.message), [], 'repairing storage must permit local transaction recovery without a process restart')
      assert.equal(localRecoveryCommits, 2, 'the repaired explicit run must attempt the known local transaction closure exactly once')
      assert.equal(summaryBodies.length, 1, 'local recovery must not retry the failed compaction model request')
      assert.equal(bodies.length, 2)
      assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, published.cacheGenerationId, 'old-state recovery must retain the original generation')
      await agent.run('Next.', callbacks)
      await agent.drainPersistWrites()
      await persist!.drainFrozenSnapshots()
      assert.deepEqual(errors.map(error => error.message), [])
      assert.equal(localRecoveryCommits, 2, 'a successful recovery must clear its failure marker')
      assert.equal(summaryBodies.length, 1)
      assert.equal(bodies.length, 3)
      const recovered = new SessionPersist('compaction-fixture', root).readFrozenSnapshot()!
      assert.equal(recovered.pendingCompaction, undefined)
      assert.equal(recovered.rewindAuthorization, undefined)
      assert.deepEqual(recovered.executionSnapshot, client.getMainPrefixProof!())
      const altered = structuredClone(session.getMessages())
      altered.find(message => typeof message.content === 'string' && message.content.startsWith('C_AFTER_REPAIRED_STORAGE'))!.content = 'An unauthorized replacement of C after local recovery.'
      engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: recovered })
      client = makeClient()
      client.restoreExecutionSnapshot!(recovered.executionSnapshot!)
      assert.throws(() => engine.assertPublishedHistory(altered), /已发布的源历史发生变化/,
        'the rebuilt engine must retain the published raw seal for C after local recovery')
      assert.equal(bodies.length, 3)
    }
    return
  }
  const after = structuredClone(session.getMessages())
  const changedIndex = before.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(after[index]))
  context.diagnostic(JSON.stringify({
    path: entry === 'automatic'
      ? 'AgentLoop.run(long new user input) -> TurnStepProducer -> enforceContextCeiling -> HTTP summary -> checkpoint -> guarded main request'
      : 'AgentLoop.run -> public maybeCompact -> tryPartialCompact -> HTTP summary -> AgentLoop.run',
    occupancyBeforeInput: occupancy, addedInputTokens,
    occupancyAtSummary: ceilingSnapshots[0]?.estimatedTokens,
    beforeMessages: before.length, messagesAtSummary: ceilingSnapshots[0]?.messages.length,
    afterMessages: after.length, changedSessionIndex: changedIndex,
    beforeRole: before[changedIndex]?.role, afterRole: after[changedIndex]?.role,
    summaryRequests: summaryBodies.length,
    mainRequestsAfter: bodies.length,
    errors: errors.map(error => ({
      name: error.name, message: error.message,
      ...(error instanceof ContinuationPrefixError ? {
        changed: error.changed,
        beforeWireMessages: error.previous.messages.length,
        afterWireMessages: error.next.messages.length,
        changedWireMessages: error.previous.messages.flatMap((message, index) => {
          const next = error.next.messages[index]
          return message.hash === next?.hash ? [] : [{
            index, beforeRole: message.role, afterRole: next?.role,
            beforeChars: message.chars, afterChars: next?.chars,
          }]
        }).slice(0, 4),
      } : {}),
    })),
  }))
  assert.equal(summaryBodies.length, 1, 'committed compaction must use the real provider summary transport')
  if (entry === 'automatic') {
    assert.ok(ceilingSnapshots[0]!.estimatedTokens > 950_000,
      'the live unmocked estimate must cross the actual 95% threshold')
  }
  assert.equal(changedIndex, CACHE_ANCHOR_MESSAGES)
  assert.ok(after.length < before.length, 'committed compaction must actually rewrite historical messages')
  assert.deepEqual(after.slice(0, CACHE_ANCHOR_MESSAGES), before.slice(0, CACHE_ANCHOR_MESSAGES))
  const summaryMarker = entry === 'automatic' ? '<compact-summary' : '<partial-compact-summary'
  assert.ok(String(after[changedIndex]!.content).includes(summaryMarker))
  assert.ok(String(after[changedIndex]!.content).includes(summary))
  assert.equal(before[changedIndex]!.role, 'user')
  assert.equal(after[changedIndex]!.role, 'assistant')
  if (entry === 'automatic') {
    assert.ok(after.some(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(nextInput)),
      'the automatic checkpoint must retain the new user input verbatim')
  }
  assert.deepEqual(errors.map(error => ({ name: error.name, message: error.message })), [],
    'committed legacy compaction must not block the next main HTTP request')
  assert.equal(bodies.length, 2, 'the second run must reach the real main HTTP boundary after committed compaction')
  assert.ok(bodies[1]!.messages.some(message => String(message.content).includes(summaryMarker)))
}

test('automatic legacy context-ceiling checkpoint permits the next main HTTP request',
  context => verifyCompactionRecovery(context, 'automatic'))

test('public legacy maybeCompact permits the next main HTTP request',
  context => verifyCompactionRecovery(context, 'public'))

test('unknown history replacement cannot authorize a new in-memory generation',
  context => verifyCompactionRecovery(context, 'unknown'))

for (const persistence of ['resume', 'pending-old', 'pending-new', 'pending-other', 'pending-old-append', 'pending-new-append', 'intent-append', 'commit-append'] as const) {
  test(`durable compaction recovery: ${persistence}`,
    context => verifyCompactionRecovery(context, 'public', persistence))
}

test('automatic compaction storage failure blocks the main HTTP request',
  context => verifyCompactionRecovery(context, 'automatic', 'snapshot-failure'))

test('a human input arriving in the real summary HTTP request prevents stale compaction',
  context => verifyCompactionRecovery(context, 'conflict'))

test('a real single-attempt worker rejects in-memory compaction without clearing its proof',
  context => verifyCompactionRecovery(context, 'worker'))

test('in-place historical mutation during summary is not hidden by a shallow source snapshot',
  context => verifyCompactionRecovery(context, 'object-conflict'))

test('post-transcript persistence mismatch retains the real pending intent and blocks HTTP',
  context => verifyCompactionRecovery(context, 'public', 'serialized-mismatch'))

test('official request-budget compaction durably resumes with the active user rebound',
  context => verifyCompactionRecovery(context, 'official', 'resume'))

test('official request-budget intent preserves a late human input across recovery',
  context => verifyCompactionRecovery(context, 'official', 'intent-append'))

test('durably stored unknown history cannot be laundered by compaction',
  context => verifyCompactionRecovery(context, 'persisted-unknown', 'resume'))

test('an exact legacy truncation projection is repaired from proven complete live history before compaction',
  context => verifyCompactionRecovery(context, 'public', 'legacy-projection'))

for (const mode of ['legacy-corruption', 'legacy-invalid-row', 'legacy-unproven', 'legacy-cold-resume', 'legacy-readback', 'legacy-readback-invalid-row', 'legacy-live-change', 'legacy-torn-frame', 'legacy-readback-torn-frame'] as const) {
  test(`legacy truncation repair fails closed for ${mode}`,
    context => verifyCompactionRecovery(context, 'public', mode))
}

test('a failed final authorization keeps the pending journal through ordinary prompt builds',
  context => verifyCompactionRecovery(context, 'public', 'final-auth-failure'))

for (const entry of ['binding', 'credential'] as const) {
  test(`in-memory compaction cannot clear a changed execution ${entry}`,
    context => verifyCompactionRecovery(context, entry))
}

test('automatic official request-budget compaction shares the durable recovery protocol',
  context => verifyCompactionRecovery(context, 'official-auto', 'resume'))

test('a real automatic compression commit cannot prematurely publish an unsent active user',
  context => verifyCompactionRecovery(context, 'automatic', 'cancel-tail'))

test('durable authorization consumption rejects queued and late stale snapshots',
  context => verifyCompactionRecovery(context, 'public', 'consume-race'))

test('a real explicit effort generation remains persistable after compaction consumption',
  context => verifyCompactionRecovery(context, 'public', 'consume-effort'))

test('real native cache-breakpoint rolling remains persistable after compaction consumption',
  context => verifyCompactionRecovery(context, 'native-writer', 'consume-native'))

test('a real abort after the durable intent releases the old-state writer before later main requests',
  context => verifyCompactionRecovery(context, 'automatic', 'abort-intent'))

test('an explicit run recovers a failed local compaction transaction after actual storage repair',
  context => verifyCompactionRecovery(context, 'automatic', 'snapshot-retry'))
