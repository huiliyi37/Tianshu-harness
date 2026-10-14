import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { isModelSpecUsable } from '../serve.js'
import { SessionContext } from '../../agent/context.js'
import { attachSessionPersistListener } from '../../agent/session-persist-listener.js'
import type { SessionPersist } from '../../agent/session-persist.js'
import type { AgentLoop } from '../../agent/loop.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { withExecutionContinuity, prepareExecutionSend } from '../../api/execution-continuity.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'
import * as loopFactory from '../../agent/loop-factory.js'

function productionFacade(agent: AgentLoop, rebuild: (model: string) => AgentLoop, unconfigured: boolean): ManagedAgent {
  const source = readFileSync(new URL('../serve-agent.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('serve-agent.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === 'buildManagedAgent')
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
  const returned = declaration.body.statements.find(statement => ts.isReturnStatement(statement))
  assert.ok(returned && ts.isReturnStatement(returned) && returned.expression
    && ts.isObjectLiteralExpression(returned.expression))
  const expression = returned.expression.getText(parsed)
  const rebuildDeclaration = declaration.body.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(variable => variable.name.getText(parsed) === 'rebuildOnSpec'))
  assert.ok(rebuildDeclaration)
  const code = ts.transpileModule(`${rebuildDeclaration.getText(parsed)}; const facade = ${expression}; return facade`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const evaluate = new Function('agent', 'spec', 'stores', 'ctx', 'reload', 'shared', 'sessionId', 'isModelSpecUsable',
    'rewindAgentSession', 'waitForAgentRewind', 'resolveModelSpecWithReload', 'assembleAgentLoop',
    'cwd', 'registry', 'allowedTools', code)
  const resolve = (_context: unknown, model: string) => ({ apiKey: 'fixture', provider: { name: 'fixture' }, model: { id: model } })
  return evaluate(agent, { ...resolve({}, 'fixture'), apiKey: unconfigured ? '' : 'fixture' },
    { historyRestore: { restored: agent.session.getMessages().length }, refs: { coordinator: null },
      claimStore: { async flushWrites() {} }, persist: { updateMetadata() {}, appendModelSwitch() {} } },
    {}, () => ({}), undefined, 'rewind-fixture', isModelSpecUsable,
    Reflect.get(loopFactory, 'rewindAgentSession'), Reflect.get(loopFactory, 'waitForAgentRewind'), resolve,
    (_context: unknown, _cwd: string, _sessionId: string, _stores: unknown, spec: { model: { id: string } }) => rebuild(spec.model.id),
    '/controlled-fixture', undefined, undefined) as ManagedAgent
}

function syntheticHistory(engine: PromptEngine): OaiMessage[] {
  const history: OaiMessage[] = []
  const userPositions = new Set([0, 10, 38, 48, 58, 72])
  engine.setCrossSessionMemoryBlock('synthetic-appendix-'.repeat(150))
  for (let index = 0; index < 73; index++) {
    history.push({ role: userPositions.has(index) || index === 71 ? 'user' : 'assistant',
      content: index === 71 ? '<system-reminder>synthetic reminder</system-reminder>'
        : userPositions.has(index) ? `synthetic-task-${index}` : `synthetic-response-${index}` })
    if (userPositions.has(index)) engine.buildOaiRequest(history.slice())
  }
  return history
}

async function fixture(unconfigured = false) {
  const session = new SessionContext()
  const engine = new PromptEngine({ model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] },
    volatileCtx: { cwd: '/controlled-fixture', rivetMd: '# Fixture' } })
  const history = syntheticHistory(engine)
  session.replaceMessages(history.slice())
  const requests: OaiChatRequest[] = []
  const order: string[] = []
  const state = { writeError: undefined as Error | undefined, transportError: undefined as Error | undefined,
    durable: structuredClone(history), committedCounts: [] as number[],
    frozen: undefined as import('../../prompt/frozen-snapshot.js').FrozenSnapshotData | undefined,
    authorizations: [] as import('../../api/continuation-prefix.js').RewindGenerationAuthorization[] }
  let releaseWrite: () => void = () => {}
  const writeGate = { promise: new Promise<void>(resolve => { releaseWrite = resolve }), resolve: () => releaseWrite() }
  const transport: StreamClient = {
    stream: async (request, callbacks) => {
      await prepareExecutionSend('https://fixture.invalid/v1/chat/completions', {
        model: request.model, messages: request.messages, tools: request.tools ?? [], max_tokens: request.max_tokens,
      })
      if (state.transportError) throw state.transportError
      requests.push({ ...request, messages: structuredClone(request.messages) })
      callbacks.onStopReason('end_turn', { input_tokens: 1, output_tokens: 1 })
    },
    authorizeCacheGeneration: reason => { order.push(`client:${reason}`) },
  }
  const client = withExecutionContinuity(transport, { provider: 'fixture', model: 'fixture', sessionId: 'rewind-fixture' })
  const streamCallbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {},
    onStopReason() {}, onError(error) { throw error } }
  await client.stream(engine.buildOaiRequest(session.getMessages()), streamCallbacks)
  assert.equal(requests[0]!.messages.length, 74)
  const originalProof = client.getMainPrefixProof!()!
  const persist = {
    async commitFrozenSnapshot(snapshot: import('../../prompt/frozen-snapshot.js').FrozenSnapshotData) {
      state.frozen = structuredClone(snapshot)
      if (snapshot.rewindAuthorization) state.authorizations.push(structuredClone(snapshot.rewindAuthorization))
    },
    loadMetadata: () => ({}), updateMetadata() {}, async flushSessionBuffer() {},
    async appendOaiWithChecksum(message: OaiMessage) { state.durable.push(structuredClone(message)) },
    async compactOaiAsync(messages: OaiMessage[]) {
      if (messages.length === 58) await writeGate.promise
      if (state.writeError) throw state.writeError
      state.durable = structuredClone(messages)
      state.committedCounts.push(messages.length)
      order.push('history-committed')
    },
  } as unknown as SessionPersist
  const listener = attachSessionPersistListener({ session, persist })
  const authorizeFrozen = engine.authorizeCacheGeneration.bind(engine)
  const frozenMock = mock.method(engine, 'authorizeCacheGeneration', () => {
    order.push('engine-authorized')
    authorizeFrozen()
  })
  const agent = {
    session, persist, config: { client, promptEngine: engine }, drainPersistWrites: () => listener.drain(), abort() {},
    stopConfigWatcher() { order.push('shutdown-cleanup') }, async cancelIdleCompaction() {}, async drainPostSession() {},
    async run(prompt: string) {
      session.addUserMessage(prompt)
      await client.stream(engine.buildOaiRequest(session.getMessages()), streamCallbacks)
      session.addAssistantBlocks([{ type: 'text', text: 'synthetic answer' }])
      return 'completed' as const
    },
  } as unknown as AgentLoop
  const rebuilt: Array<{ client: StreamClient; engine: PromptEngine }> = []
  const restoreRebuildMocks: Array<() => void> = []
  const rebuild = (model: string): AgentLoop => {
    const nextEngine = new PromptEngine({ model, maxTokens: 4096, staticCtx: { tools: [] },
      volatileCtx: { cwd: '/controlled-fixture', rivetMd: '# Fixture' } })
    const nextClient = withExecutionContinuity({ ...transport,
      authorizeCacheGeneration: reason => { order.push(`rebuilt-client:${reason}`) },
    }, { provider: 'fixture', model, sessionId: 'rewind-fixture' })
    const nextListener = attachSessionPersistListener({ session, persist })
    const authorize = nextEngine.authorizeCacheGeneration.bind(nextEngine)
    const nextMock = mock.method(nextEngine, 'authorizeCacheGeneration', () => {
      order.push('rebuilt-engine-authorized')
      authorize()
    })
    restoreRebuildMocks.push(() => nextMock.mock.restore())
    rebuilt.push({ client: nextClient, engine: nextEngine })
    return { ...agent, config: { ...agent.config, client: nextClient, promptEngine: nextEngine },
      drainPersistWrites: () => nextListener.drain(),
      async run(prompt: string) {
        session.addUserMessage(prompt)
        await nextClient.stream(nextEngine.buildOaiRequest(session.getMessages()), streamCallbacks)
        session.addAssistantBlocks([{ type: 'text', text: 'synthetic rebuilt answer' }])
        return 'completed' as const
      },
    } as unknown as AgentLoop
  }
  const facade = productionFacade(agent, rebuild, unconfigured)
  const manager = new RuntimeSessionManager({ createAgent: () => facade, defaultCwd: '/controlled-fixture' })
  const record = manager.createSession()
  const managed = (manager as unknown as { sessions: Map<string, { agent: ManagedAgent | null }> }).sessions.get(record.id)
  assert.ok(managed)
  managed.agent = facade
  return { session, persist, engine, client, requests, order, state, writeGate, facade, manager, id: record.id,
    originalProof, frozenMock, streamCallbacks, rebuilt, restoreRebuildMocks }
}

test('explicit durable rewind preserves 74→60/index-1 shape, changes generation, and permits subsequent append', async context => {
  const setup = await fixture()
  context.after(() => setup.frozenMock.mock.restore())
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  assert.equal(setup.session.getMessages().length, 58)
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(setup.engine.getExecutionSnapshot()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(setup.order.length, 0)
  const firstRun = setup.facade.run('synthetic-edited-task', {} as AgentCallbacks)
  void firstRun.catch(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(setup.requests.length, 1, 'request cannot outrun rewind persistence')
  setup.writeGate.resolve()
  await firstRun
  assert.deepEqual(setup.order, ['history-committed', 'client:explicit_user_rewind', 'engine-authorized'])
  const rewound = setup.requests[1]!
  assert.equal(rewound.messages.length, 60)
  assert.equal(setup.requests[0]!.messages.findIndex((message, index) =>
    JSON.stringify(message) !== JSON.stringify(rewound.messages[index])), 1)
  assert.ok(JSON.stringify(rewound.messages[1]).length < JSON.stringify(setup.requests[0]!.messages[1]).length)
  assert.equal(setup.engine.consumeFrozenRestoreReason(), 'history_replaced')
  const rewoundProof = setup.client.getMainPrefixProof!()!
  assert.notEqual(rewoundProof.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(rewoundProof.generationReason, 'explicit_user_rewind')
  assert.equal(setup.engine.getExecutionSnapshot()!.cacheGenerationId, rewoundProof.cacheGenerationId)
  await setup.facade.run('synthetic follow-up', {} as AgentCallbacks)
  assert.equal(setup.requests.length, 3)
  assert.deepEqual(setup.requests[2]!.messages.slice(0, rewound.messages.length), rewound.messages)
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, rewoundProof.cacheGenerationId)
  assert.equal(setup.order.filter(entry => entry.startsWith('client:')).length, 1)
  await setup.facade.flushPersistence!()
})

test('rewind persistence failure propagates without authorizing either owner or sending a request', async context => {
  const setup = await fixture()
  context.after(() => setup.frozenMock.mock.restore())
  const errors: unknown[][] = []
  const errorMock = mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  context.after(() => errorMock.mock.restore())
  const failure = new Error('synthetic rewind persistence failure')
  setup.state.writeError = failure
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  setup.writeGate.resolve()
  await assert.rejects(setup.facade.flushPersistence!(), error => error === failure)
  await assert.rejects(setup.facade.run('must not send', {} as AgentCallbacks), error => error === failure)
  assert.equal(setup.order.length, 0)
  assert.equal(setup.requests.length, 1)
  assert.deepEqual(setup.client.getMainPrefixProof!(), setup.originalProof)
  assert.equal(setup.engine.getExecutionSnapshot()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(setup.state.durable.length, 73)
  assert.equal(errors.length, 1)
})

test('ordinary history replacement remains fail-closed and cannot authorize a generation', async context => {
  const setup = await fixture()
  context.after(() => setup.frozenMock.mock.restore())
  setup.writeGate.resolve()
  setup.facade.replaceMessages(setup.session.getMessages().map((message, index) =>
    index === 0 ? { ...message, content: 'unauthorized historical change' } : message))
  await setup.facade.flushPersistence!()
  await assert.rejects(setup.facade.run('continue', {} as AgentCallbacks), { name: 'ContinuationPrefixError' })
  assert.equal(setup.requests.length, 1)
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(setup.order.filter(entry => entry.includes('authorized') || entry.startsWith('client:')).length, 0)
})

test('ordinary transport errors never authorize a cache generation', async context => {
  const setup = await fixture()
  context.after(() => setup.frozenMock.mock.restore())
  setup.writeGate.resolve()
  const failure = new Error('synthetic ordinary transport error')
  setup.state.transportError = failure
  await assert.rejects(setup.facade.run('continue', {} as AgentCallbacks), error => error === failure)
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(setup.order.length, 0)
  await setup.facade.flushPersistence!()
})

test('history changed during rewind commit remains blocked rather than borrowing rewind authorization', async context => {
  const setup = await fixture()
  context.after(() => setup.frozenMock.mock.restore())
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  setup.session.getMessages()[0] = { role: 'user', content: 'unapproved concurrent historical change' }
  setup.writeGate.resolve()
  await assert.rejects(setup.facade.flushPersistence!(), /历史在回退提交期间发生变化/)
  await assert.rejects(setup.facade.run('must not send', {} as AgentCallbacks), /历史在回退提交期间发生变化/)
  assert.equal(setup.requests.length, 1)
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(setup.engine.getExecutionSnapshot()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(setup.order.filter(entry => entry.includes('authorized') || entry.startsWith('client:')).length, 0)
})

test('consecutive explicit rewinds persist in order and authorize only the final history once', async context => {
  const setup = await fixture()
  context.after(() => setup.frozenMock.mock.restore())
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  assert.equal(setup.manager.rewind(setup.id, 48), true)
  assert.equal(setup.session.getMessages().length, 48)
  const finalRun = setup.facade.run('synthetic-final-edited-task', {} as AgentCallbacks)
  void finalRun.catch(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(setup.requests.length, 1)
  assert.equal(setup.order.length, 0)
  setup.writeGate.resolve()
  await finalRun
  assert.deepEqual(setup.state.committedCounts, [58, 48])
  assert.deepEqual(setup.order, ['history-committed', 'history-committed', 'client:explicit_user_rewind', 'engine-authorized'])
  assert.equal(setup.requests[1]!.messages.length, 50)
  const finalProof = setup.client.getMainPrefixProof!()!
  assert.notEqual(finalProof.cacheGenerationId, setup.originalProof.cacheGenerationId)
  assert.equal(finalProof.generationReason, 'explicit_user_rewind')
  await setup.facade.run('synthetic final-history follow-up', {} as AgentCallbacks)
  assert.deepEqual(setup.requests[2]!.messages.slice(0, 50), setup.requests[1]!.messages)
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, finalProof.cacheGenerationId)
  assert.equal(setup.order.filter(entry => entry.startsWith('client:')).length, 1)
  await setup.facade.flushPersistence!()
})

test('shutdown waits for rewind persistence, cleans up, and propagates the original write failure', async context => {
  const setup = await fixture()
  context.after(() => setup.frozenMock.mock.restore())
  const errorMock = mock.method(console, 'error', () => {})
  context.after(() => errorMock.mock.restore())
  const failure = new Error('synthetic shutdown rewind write failure')
  setup.state.writeError = failure
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  let settled = false
  const shutdown = Promise.resolve(setup.facade.shutdown!()).then(result => {
    settled = true
    return result
  }, error => { settled = true; throw error })
  void shutdown.catch(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(setup.order.length, 0)
  setup.writeGate.resolve()
  await assert.rejects(shutdown, error => error === failure)
  assert.deepEqual(setup.order, ['shutdown-cleanup'])
  assert.equal(setup.requests.length, 1)
  assert.deepEqual(setup.client.getMainPrefixProof!(), setup.originalProof)
  assert.equal(setup.engine.getExecutionSnapshot()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
})

test('rewind followed by model switch keeps the durable barrier and authorizes the live runtime', async context => {
  const setup = await fixture()
  context.after(() => { setup.frozenMock.mock.restore(); setup.restoreRebuildMocks.forEach(restore => restore()) })
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  assert.equal(setup.facade.switchModel!('fixture-next'), 'fixture:fixture-next')
  assert.equal(setup.rebuilt.length, 1)
  const modelSwitchOrder = setup.order.slice()
  const run = setup.facade.run('synthetic switched-model task', {} as AgentCallbacks)
  void run.catch(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(setup.requests.length, 1, 'rebuilt runtime must not bypass rewind persistence')
  setup.writeGate.resolve()
  await run
  assert.deepEqual(setup.order, [...modelSwitchOrder, 'history-committed',
    'rebuilt-client:explicit_user_rewind', 'rebuilt-engine-authorized'])
  assert.equal(setup.requests[1]!.model, 'fixture-next')
  assert.equal(setup.requests[1]!.messages.length, 60)
  assert.equal(setup.rebuilt[0]!.client.getMainPrefixProof!()!.generationReason, 'explicit_user_rewind')
  assert.equal(setup.client.getMainPrefixProof!()!.cacheGenerationId, setup.originalProof.cacheGenerationId)
  await setup.facade.run('switched-model follow-up', {} as AgentCallbacks)
  assert.deepEqual(setup.requests[2]!.messages.slice(0, 60), setup.requests[1]!.messages)
  await setup.facade.flushPersistence!()
})

test('rewind write failure survives model switch across run, flush, and shutdown', async context => {
  const setup = await fixture()
  context.after(() => { setup.frozenMock.mock.restore(); setup.restoreRebuildMocks.forEach(restore => restore()) })
  const errorMock = mock.method(console, 'error', () => {})
  context.after(() => errorMock.mock.restore())
  const failure = new Error('synthetic switched-runtime rewind write failure')
  setup.state.writeError = failure
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  assert.equal(setup.facade.switchModel!('fixture-next'), 'fixture:fixture-next')
  const run = setup.facade.run('must not send after switch', {} as AgentCallbacks)
  void run.catch(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(setup.requests.length, 1)
  setup.writeGate.resolve()
  await assert.rejects(run, error => error === failure)
  await assert.rejects(setup.facade.flushPersistence!(), error => error === failure)
  await assert.rejects(Promise.resolve(setup.facade.shutdown!()), error => error === failure)
  assert.equal(setup.requests.length, 1)
  assert.ok(!setup.order.some(entry => entry.includes('explicit_user_rewind')))
  assert.ok(setup.order.includes('shutdown-cleanup'))
})

test('automatic model-spec healing cannot bypass an in-flight explicit rewind', async context => {
  const setup = await fixture(true)
  context.after(() => { setup.frozenMock.mock.restore(); setup.restoreRebuildMocks.forEach(restore => restore()) })
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  const run = setup.facade.run('synthetic healed-model task', {} as AgentCallbacks)
  void run.catch(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(setup.rebuilt.length, 1)
  assert.equal(setup.requests.length, 1)
  assert.equal(setup.order.length, 0)
  setup.writeGate.resolve()
  await run
  assert.deepEqual(setup.order, ['history-committed', 'rebuilt-client:explicit_user_rewind', 'rebuilt-engine-authorized'])
  assert.equal(setup.requests[1]!.messages.length, 60)
  await setup.facade.flushPersistence!()
})

test('consecutive rewinds across model rebuild serialize old and new persistence writes', async context => {
  const setup = await fixture()
  context.after(() => { setup.frozenMock.mock.restore(); setup.restoreRebuildMocks.forEach(restore => restore()) })
  assert.equal(setup.manager.rewind(setup.id, 58), true)
  assert.equal(setup.facade.switchModel!('fixture-next'), 'fixture:fixture-next')
  assert.equal(setup.manager.rewind(setup.id, 48), true)
  const run = setup.facade.run('synthetic twice-rewound switched-model task', {} as AgentCallbacks)
  void run.catch(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(setup.requests.length, 1, 'a fresh runtime write chain cannot acknowledge ahead of the older pending rewrite')
  assert.equal(setup.state.committedCounts.length, 0)
  setup.writeGate.resolve()
  await run
  assert.deepEqual(setup.state.committedCounts, [58, 48])
  assert.ok(setup.state.authorizations.at(-1), 'latest rewind across a model rebuild must retain the prior proof for durable authorization')
  assert.equal(setup.state.authorizations.at(-1)!.history.length, 48)
  assert.equal(setup.state.authorizations.at(-1)!.model, 'fixture-next')
  assert.equal(setup.state.frozen!.rewindAuthorization, undefined, 'authorization is consumed durably before the first HTTP send')
  assert.equal(setup.requests[1]!.messages.length, 50)
  assert.equal(setup.order.filter(entry => entry.includes('explicit_user_rewind')).length, 1)
  assert.equal(setup.rebuilt[0]!.client.getMainPrefixProof!()!.generationReason, 'explicit_user_rewind')
  await setup.facade.flushPersistence!()
  assert.equal(setup.state.durable.length, setup.session.getMessages().length)
  assert.deepEqual(setup.state.durable, setup.session.getMessages())
})

test('model rebuild during durable checkpoint I/O recommits authorization for the live runtime before sending', async context => {
  const setup = await fixture()
  context.after(() => { setup.frozenMock.mock.restore(); setup.restoreRebuildMocks.forEach(restore => restore()) })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const models: string[] = []
  const writer = mock.method(setup.persist, 'commitFrozenSnapshot', async (snapshot: import('../../prompt/frozen-snapshot.js').FrozenSnapshotData) => {
    if (snapshot.rewindAuthorization) {
      models.push(snapshot.rewindAuthorization.model)
      if (models.length === 1) await gate
    }
    setup.state.frozen = structuredClone(snapshot)
  })
  context.after(() => writer.mock.restore())
  assert.equal(setup.manager.rewind(setup.id, 48), true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(models, ['fixture'])
  assert.equal(setup.facade.switchModel!('fixture-next'), 'fixture:fixture-next')
  const run = setup.facade.run('checkpoint raced a model rebuild', {} as AgentCallbacks)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(setup.requests.length, 1)
  release()
  await run
  assert.deepEqual(models, ['fixture', 'fixture-next'])
  assert.equal(setup.state.frozen!.executionSnapshot!.model, 'fixture-next')
  assert.equal(setup.state.frozen!.rewindAuthorization, undefined)
  assert.equal(setup.rebuilt[0]!.client.getMainPrefixProof!()!.generationReason, 'explicit_user_rewind')
  await setup.facade.flushPersistence!()
})
