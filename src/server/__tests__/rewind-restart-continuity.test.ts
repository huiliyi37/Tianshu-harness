import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { SessionContext } from '../../agent/context.js'
import { SessionPersist } from '../../agent/session-persist.js'
import { attachSessionPersistListener } from '../../agent/session-persist-listener.js'
import { rewindAgentSession, waitForAgentRewind } from '../../agent/loop-factory.js'
import { PromptEngine } from '../../prompt/engine.js'
import { withExecutionContinuity } from '../../api/execution-continuity.js'
import { OpenAIClient } from '../../api/openai-client.js'
import { FallbackStreamClient } from '../../api/fallback-client.js'
import type { AgentLoop } from '../../agent/loop.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { ManagedAgent } from '../session-manager.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { executeFrontendRewind } from '../../tui/frontend-session-provider.js'
import type { TuiApp } from '../../tui/engine/app.js'
import type { BootstrapContext } from '../../bootstrap.js'

function facadeFor(agent: AgentLoop): Pick<ManagedAgent, 'rewindToMessages' | 'flushPersistence' | 'shutdown'> {
  const source = readFileSync(new URL('../serve-agent.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('serve-agent.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'buildManagedAgent')
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
  const returned = declaration.body.statements.find(statement => ts.isReturnStatement(statement))
  assert.ok(returned && ts.isReturnStatement(returned) && returned.expression && ts.isObjectLiteralExpression(returned.expression))
  const properties = returned.expression.properties.filter(property => property.name && ['rewindToMessages', 'flushPersistence', 'shutdown'].includes(property.name.getText(parsed)))
  assert.equal(properties.length, 3)
  const code = ts.transpileModule(`return {${properties.map(property => property.getText(parsed)).join(',')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('agent', 'stores', 'shared', 'sessionId', 'rewindAgentSession', 'waitForAgentRewind', code)(agent,
    { claimStore: { async flushWrites() {} }, refs: {} }, undefined, 'rewind-restart', rewindAgentSession, waitForAgentRewind)
}

test('committed rewind survives a fresh persistence, engine and transport without accepting altered history or binding', async context => {
  const workspace = mkdtempSync(join(tmpdir(), 'rivet-rewind-restart-'))
  const previousDirectory = process.env['RIVET_SESSION_DIR']
  process.env['RIVET_SESSION_DIR'] = join(workspace, 'sessions')
  context.after(() => { if (previousDirectory === undefined) delete process.env['RIVET_SESSION_DIR']; else process.env['RIVET_SESSION_DIR'] = previousDirectory; rmSync(workspace, { recursive: true, force: true }) })
  let sends = 0
  context.mock.method(globalThis, 'fetch', async () => {
    sends++
    return new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const makeClient = (baseUrl = 'https://fixture.invalid/v1') => withExecutionContinuity(new OpenAIClient({ providerName: 'fixture', baseUrl, apiKey: 'fixture', model: 'fixture-model', maxTokens: 2048, maxRetries: 0, thinking: 'disabled' }), { provider: 'fixture', model: 'fixture-model', credentialScope: 'fixture:default' })
  const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} }
  const configuration = { model: 'fixture-model', maxTokens: 2048, staticCtx: { tools: [] }, volatileCtx: { cwd: workspace, rivetMd: '# Fixture' } }
  const persist = new SessionPersist('rewind-restart', workspace)
  persist.initMetadata({ model: 'fixture-model' })
  const session = new SessionContext()
  const listener = attachSessionPersistListener({ session, persist })
  session.addUserMessage('first task')
  session.addAssistantBlocks([{ type: 'text', text: 'first answer' }])
  session.addUserMessage('second task')
  session.addAssistantBlocks([{ type: 'text', text: 'second answer' }])
  const engine = new PromptEngine(configuration)
  engine.setOnFrozenSnapshotChanged(() => persist.queueFrozenSnapshot(engine.exportFrozenSnapshot()))
  const client = new FallbackStreamClient(makeClient(), 'fixture', [])
  client.setThinking('enabled')
  client.setReasoningEffort('high')
  const agent = { session, persist, config: { client, promptEngine: engine }, async drainPersistWrites() { await listener.drain(); await persist.drainFrozenSnapshots() }, stopConfigWatcher() {}, async cancelIdleCompaction() {}, async drainPostSession() {} } as unknown as AgentLoop
  await client.stream(engine.buildOaiRequest(session.getMessages()), callbacks)
  await agent.drainPersistWrites()
  const previousProof = client.getMainPrefixProof!()!
  const facade = facadeFor(agent)
  facade.rewindToMessages!(session.getMessages().slice(0, 2))
  await facade.flushPersistence!()
  assert.equal(await facade.shutdown!(), true)
  const restartedPersist = new SessionPersist('rewind-restart', workspace)
  const snapshot = restartedPersist.readFrozenSnapshot()!
  assert.equal(restartedPersist.loadOai().length, 2)
  const retainedHistory = restartedPersist.loadOai()
  await restartedPersist.compactOaiAsync([{ role: 'user', content: 'changed pending authorization' }, ...retainedHistory.slice(1)])
  assert.throws(() => restartedPersist.readFrozenSnapshot(), /回退授权.*历史/)
  await restartedPersist.compactOaiAsync(retainedHistory)
  const resumedEngine = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot })
  resumedEngine.setExecutionSnapshotCommit(snapshot => restartedPersist.commitFrozenSnapshot(snapshot))
  const resumedClient = makeClient()
  const authorization = Reflect.get(resumedEngine, 'getRewindAuthorization')?.call(resumedEngine)
  if (authorization) Reflect.get(resumedClient, 'restoreRewindAuthorization')!(authorization)
  else resumedClient.restoreExecutionSnapshot!(resumedEngine.getExecutionSnapshot()!)
  assert.ok(authorization)
  const resumedSession = new SessionContext()
  resumedSession.replaceMessages(restartedPersist.loadOai())
  resumedSession.addUserMessage('edited second task')
  await resumedClient.stream(resumedEngine.buildOaiRequest(resumedSession.getMessages()), callbacks)
  assert.equal(sends, 2)
  const resumedProof = resumedClient.getMainPrefixProof!()!
  assert.notEqual(resumedProof.cacheGenerationId, previousProof.cacheGenerationId)
  assert.equal(resumedProof.generationReason, 'explicit_user_rewind')
  assert.equal(resumedProof.credentialScope, previousProof.credentialScope)
  assert.equal(resumedProof.optionsHash, previousProof.optionsHash)
  assert.equal(resumedProof.toolsHash, previousProof.toolsHash)
  resumedSession.addUserMessage('follow up')
  await resumedClient.stream(resumedEngine.buildOaiRequest(resumedSession.getMessages()), callbacks)
  assert.equal(sends, 3)
  const alteredEngine = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot })
  const alteredHistory = restartedPersist.loadOai()
  alteredHistory[0] = { role: 'user', content: 'unauthorized replacement' }
  assert.throws(() => alteredEngine.buildOaiRequest(alteredHistory), /回退授权.*历史/)
  const changedClient = makeClient('https://other.invalid/v1')
  Reflect.get(changedClient, 'restoreRewindAuthorization')!(authorization)
  const changedEngine = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot })
  await assert.rejects(changedClient.stream(changedEngine.buildOaiRequest(resumedSession.getMessages()), callbacks), /prefix diverged at binding/)
  assert.equal(sends, 3)
  const mutatedRequest = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot }).buildOaiRequest(resumedSession.getMessages())
  mutatedRequest.messages[1] = { role: 'user', content: 'changed after construction' }
  const mutationClient = makeClient()
  mutationClient.restoreRewindAuthorization!(authorization)
  await assert.rejects(mutationClient.stream(mutatedRequest, callbacks), /回退授权.*历史/)
  assert.equal(sends, 3)
  for (const missing of ['validateRewindRequest', 'onExecutionSnapshot', 'rewindAuthorizationId'] as const) {
    const incompleteRequest = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot }).buildOaiRequest(resumedSession.getMessages())
    delete incompleteRequest[missing]
    const incompleteClient = makeClient()
    incompleteClient.restoreRewindAuthorization!(authorization)
    await assert.rejects(incompleteClient.stream(incompleteRequest, callbacks), /回退授权缺少匹配/)
    assert.equal(sends, 3)
  }
  const sealedRequest = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot }).buildOaiRequest(resumedSession.getMessages())
  const clonedRequest = { ...sealedRequest, messages: structuredClone(sealedRequest.messages) }
  clonedRequest.messages[1] = { role: 'user', content: 'changed only in the clone' }
  const cloneClient = makeClient()
  cloneClient.restoreRewindAuthorization!(authorization)
  await assert.rejects(cloneClient.stream(clonedRequest, callbacks), /回退授权.*历史/)
  assert.notEqual(sealedRequest.messages[1]!.content, clonedRequest.messages[1]!.content)
  assert.equal(sends, 3)
  const deniedEngine = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot })
  deniedEngine.setExecutionSnapshotCommit(async () => { throw new Error('checkpoint consumption denied') })
  const deniedClient = makeClient()
  deniedClient.restoreRewindAuthorization!(authorization)
  await assert.rejects(deniedClient.stream(deniedEngine.buildOaiRequest(resumedSession.getMessages()), callbacks), /回退授权耐久提交失败/)
  assert.equal(deniedClient.getMainPrefixProof!(), undefined)
  assert.ok(deniedEngine.getRewindAuthorization())
  assert.equal(sends, 3)
  for (const mutation of ['options', 'tools', 'credential'] as const) {
    const guarded = makeClient()
    Reflect.get(guarded, 'restoreRewindAuthorization')!(authorization)
    const guardedEngine = new PromptEngine({ ...configuration, inheritFrozenFrom: snapshot })
    const request = guardedEngine.buildOaiRequest(resumedSession.getMessages())
    if (mutation === 'options') request.max_tokens = 128
    if (mutation === 'tools') request.tools = [{ type: 'function', function: { name: 'unauthorized', description: 'fixture', parameters: {} } }]
    if (mutation === 'credential') authorization.prior.credentialScope = 'different-principal'
    await assert.rejects(guarded.stream(request, callbacks), /prefix diverged at (options|tools|binding)/)
    assert.equal(sends, 3)
  }
  const savedHistory = restartedPersist.loadOai()
  await restartedPersist.compactOaiAsync([{ role: 'user', content: 'changed on disk' }, ...savedHistory.slice(1)])
  const alteredSnapshot = restartedPersist.readFrozenSnapshot()!
  const alteredClient = makeClient()
  alteredClient.restoreExecutionSnapshot!(alteredSnapshot.executionSnapshot!)
  const alteredDiskEngine = new PromptEngine({ ...configuration, inheritFrozenFrom: alteredSnapshot })
  await assert.rejects(alteredClient.stream(alteredDiskEngine.buildOaiRequest(restartedPersist.loadOai()), callbacks), /prefix diverged/)
  assert.equal(sends, 3)
  await restartedPersist.compactOaiAsync(savedHistory)
  const durableAfterSend = restartedPersist.readFrozenSnapshot()!
  assert.equal(durableAfterSend.rewindAuthorization, undefined)
  assert.equal(durableAfterSend.executionSnapshot!.cacheGenerationId, resumedProof.cacheGenerationId)
  const beforeFailure = engine.getRewindAuthorization()!.cacheGenerationId
  context.mock.method(persist, 'commitFrozenSnapshot', async () => { throw new Error('durable checkpoint write denied') })
  facade.rewindToMessages!([])
  await assert.rejects(facade.flushPersistence!(), /durable checkpoint write denied/)
  assert.equal(engine.getRewindAuthorization()!.cacheGenerationId, beforeFailure)
  assert.equal(sends, 3)
})

test('real desktop assembly and terminal rewind use the same durable authorization on restart', async context => {
  const workspace = mkdtempSync(join(tmpdir(), 'rivet-rewind-assembly-'))
  const oldHome = process.env['RIVET_HOME']
  const oldDirectory = process.env['RIVET_SESSION_DIR']
  process.env['RIVET_HOME'] = join(workspace, 'home')
  process.env['RIVET_SESSION_DIR'] = join(workspace, 'sessions')
  const agents: AgentLoop[] = []
  context.after(async () => {
    for (const agent of agents) { agent.abort(); await agent.cancelIdleCompaction(); await agent.drainPersistWrites(); agent.stopConfigWatcher(); agent.config.coordinatorRef?.()?.shutdown() }
    if (oldHome === undefined) delete process.env['RIVET_HOME']; else process.env['RIVET_HOME'] = oldHome
    if (oldDirectory === undefined) delete process.env['RIVET_SESSION_DIR']; else process.env['RIVET_SESSION_DIR'] = oldDirectory
    rmSync(workspace, { recursive: true, force: true })
  })
  let sends = 0
  context.mock.method(globalThis, 'fetch', async () => { sends++; return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) })
  const { buildAgentLoop } = await import('../serve-agent.js')
  const config = structuredClone(DEFAULT_CONFIG)
  const provider = { ...config.provider.providers.deepseek!, name: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', models: [{ id: 'fixture', name: 'fixture', contextWindow: 100000, maxTokens: 4096 }] }
  config.provider = { default: 'fixture', providers: { fixture: provider } }
  const assembly = { config, provider, model: provider.models[0]!, apiKey: 'fixture', configured: true }
  const first = buildAgentLoop(assembly, workspace, 'rewind-assembly').agent
  agents.push(first)
  const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }
  first.session.addUserMessage('first')
  first.session.addAssistantBlocks([{ type: 'text', text: 'answer' }])
  first.session.addUserMessage('second')
  await first.config.client.stream(first.config.promptEngine.buildOaiRequest(first.session.getMessages()), callbacks)
  await first.drainPersistWrites()
  const previousGeneration = first.config.client.getMainPrefixProof!()!.cacheGenerationId
  const notices: string[] = []
  const app = { markUIHistoryBoundary(text: string) { notices.push(text) }, commitStatic(text: string) { notices.push(text) }, setInput(text: string) { notices.push(text) } } as unknown as TuiApp
  executeFrontendRewind(app, { session: first.session, agent: first } as unknown as BootstrapContext, 2, 'convo')
  await waitForAgentRewind(first)
  await first.drainPersistWrites()
  assert.equal(first.session.getMessages().length, 2)
  assert.ok(notices.includes('second'))
  const second = buildAgentLoop(assembly, workspace, 'rewind-assembly').agent
  agents.push(second)
  second.session.addUserMessage('edited second')
  await second.config.client.stream(second.config.promptEngine.buildOaiRequest(second.session.getMessages()), callbacks)
  assert.equal(sends, 2)
  const resumedProof = second.config.client.getMainPrefixProof!()!
  assert.notEqual(resumedProof.cacheGenerationId, previousGeneration)
  assert.equal(resumedProof.generationReason, 'explicit_user_rewind')
  await second.drainPersistWrites()
  const saved = new SessionPersist('rewind-assembly', workspace).readFrozenSnapshot()!
  assert.equal(saved.rewindAuthorization, undefined)
  assert.equal(saved.executionSnapshot!.cacheGenerationId, resumedProof.cacheGenerationId)
})
