import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema, providerSchema } from '../../config/schema.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'
import { createAgentConfig } from '../create-agent-config.js'
import { DelegationCoordinator } from '../coordinator.js'
import { ToolRegistry } from '../../tools/registry.js'
import { completionFromClient } from '../goal-criteria.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import type { ModelSubmission } from '../../models/model-runtime.js'
import { OfficialError } from '../../models/official-contract.js'
import type { StreamClient } from '../../api/stream-client.js'

test('async candidate metadata respects the current automatic rotation switch', async () => {
  const coordinator = new DelegationCoordinator({
    baseToolRegistry: new ToolRegistry(), modelCards: [], maxWorkers: 1,
    allowAutomaticModelRotation: () => false,
    getCandidateModels: () => [{ provider: 'fixture', model: 'fixture-model' }],
    runtimeFactory: () => { throw new Error('candidate inspection cannot dispatch') },
  })
  assert.deepEqual(await coordinator.resolveCandidateModels(), [])
})

test('mixed BYOK compaction keeps the root key when a managed submission exists', async () => {
  let authorization: string | undefined
  const server = createServer((request, response) => {
    authorization = request.headers.authorization
    request.resume()
    response.setHeader('content-type', 'text/event-stream')
    response.end('data: {"choices":[{"delta":{"content":"summary"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const home = mkdtempSync(join(tmpdir(), 'official-agent-boundary-'))
  const provider = providerSchema.parse({ name: 'byok', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'synthetic-root-key', models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 100 }] })
  const managed = providerSchema.parse({ name: 'official', auth: { type: 'tianshu-account' }, models: [{ id: 'managed-model' }] })
  const config = configSchema.parse({ provider: { default: 'byok', providers: { byok: provider, official: managed } } })
  try {
    const agent = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider, model: provider.models[0]!, apiKey: 'synthetic-root-key', cwd: home, sessionId: 'byok-summary', compact: config.compact, toolDefinitions: [], allProviders: config.provider.providers })
    await agent.prepareModelSubmission!(new AbortController().signal)
    const client = await agent.budgetSummaryClient!()
    assert.equal(await completionFromClient(client, 'byok-model')('summarize', 'fixture'), 'summary')
    assert.equal(authorization, 'Bearer synthetic-root-key')
    agent.runtimeSubmission!.settle()
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(home, { recursive: true, force: true })
  }
})

for (const refused of [false, true]) test(refused ? 'actual tool pipeline preserves the original official refusal without another main send' : 'actual tool consumer receives a captured submission that cannot follow the next user boundary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'official-tool-boundary-'))
  const provider = providerSchema.parse({ name: 'byok', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-root-key', models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 100 }] })
  const managed = providerSchema.parse({ name: 'official', auth: { type: 'tianshu-account' }, models: [{ id: 'managed-model' }] })
  const config = configSchema.parse({ provider: { default: 'byok', providers: { byok: provider, official: managed } } })
  const registry = new ToolRegistry()
  let captured: ModelSubmission | undefined
  const refusal = new OfficialError('pricing_changed', 409, false)
  registry.register({
    definition: { name: 'fixture_scope', description: 'Inspect the originating submission', input_schema: { type: 'object', properties: {} } },
    isEnabled: () => true, isConcurrencySafe: () => true, requiresApproval: () => false,
    execute: async params => {
      captured = params.modelSubmission
      assert.ok(captured)
      await captured.prepare(new AbortController().signal)
      if (refused) throw refusal
      return { content: 'scope retained' }
    },
  })
  const agentConfig = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider, model: provider.models[0]!, apiKey: 'synthetic-root-key', cwd: home, sessionId: 'tool-boundary', compact: config.compact, toolDefinitions: registry.getDefinitions(), allProviders: config.provider.providers, runtimeLean: true })
  let sends = 0
  const client: StreamClient = { stream: async (_request, callbacks) => {
    sends++
    if (sends === 1) {
      callbacks.onContentBlock({ type: 'tool_use', id: 'scope-call', name: 'fixture_scope', input: {} })
      callbacks.onStopReason('tool_use', {})
    } else {
      callbacks.onTextDelta('complete')
      callbacks.onContentBlock({ type: 'text', text: 'complete' })
      callbacks.onStopReason('end_turn', {})
    }
  } }
  const agent = new AgentLoop({ ...agentConfig, client, toolRegistry: registry, maxTurns: 3, compact: { ...config.compact, enabled: false }, approvalMode: 'dangerously-skip-permissions' }, new SessionContext(), home)
  const errors: Error[] = []
  try {
    await agent.run('Inspect the originating submission with fixture_scope.', {
      onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {}, onAbort() {},
      onError(error) { errors.push(error) }, onApprovalRequired: async () => true,
    })
    assert.equal(sends, refused ? 1 : 2)
    assert.deepEqual(errors, refused ? [refusal] : [])
    assert.ok(captured)
    assert.notEqual(captured, agentConfig.runtimeSubmission)
    await assert.rejects(captured.prepare(new AbortController().signal), /auth_required/)
    await agentConfig.prepareModelSubmission!(new AbortController().signal)
    await assert.rejects(captured.prepare(new AbortController().signal), /auth_required/)
    await agentConfig.runtimeSubmission!.capture().prepare(new AbortController().signal)
  } finally {
    agentConfig.runtimeSubmission!.settle()
    await agent.cancelIdleCompaction()
    await agent.drainPersistWrites()
    agent.stopFsWatcher()
    agent.stopConfigWatcher()
    rmSync(home, { recursive: true, force: true })
  }
})
