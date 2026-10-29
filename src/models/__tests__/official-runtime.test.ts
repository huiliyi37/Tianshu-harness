import { useFixtureHome } from '../../server/__tests__/fixture-home.js'
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderForModel } from '../../bootstrap/model-resolution.js'
import { providerSchema, type Config } from '../../config/schema.js'
import { createAgentConfig } from '../../agent/create-agent-config.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'

it('official_runtime_preserves_model_capabilities through selection and actual agent construction', () => {
  const provider = providerSchema.parse({ name: 'synthetic', baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-only', models: [{ id: 'model', contextWindow: 32000, maxTokens: 4000, supportsVision: true, capabilities: { thinking: true, effortFormat: 'reasoning_effort', effortCap: { max: 'high' } } }] })
  const selected = resolveProviderForModel({ config: { provider: { providers: { synthetic: provider } } } as unknown as Config, provider, apiKey: 'synthetic-only' }, 'model')
  assert.ok(selected && !('error' in selected))
  const model = (selected as typeof selected & { model?: typeof provider.models[number] }).model
  assert.deepEqual(model, provider.models[0], 'the complete model must survive the shared selection boundary')
  assert.ok(model)
  const config = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: selected.provider, apiKey: selected.apiKey, model, cwd: '/tmp', sessionId: 'synthetic-only', compact: { enabled: false, autoThreshold: 20000, autoFloor: 10000, model: 'model' }, toolDefinitions: [] })
  assert.equal(config.contextWindow, 32000)
  assert.ok(config.primaryClient)
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema } from '../../config/schema.js'
import { createAgentRuntime, type RuntimeRefs } from '../../bootstrap.js'
import { SessionPersist } from '../../agent/session-persist.js'
import { SessionContext } from '../../agent/context.js'
import { FileHistory } from '../../agent/file-history.js'
import { DomainKnowledgeStore } from '../../agent/domain-knowledge-store.js'
import { ToolRegistry } from '../../tools/registry.js'
import { TodoStore } from '../../tools/todo-store.js'
import { buildConfigRoutes } from '../../server/config-routes.js'
import { createRouter } from '../../server/index.js'
import { loadConfig, setupProvider, upsertProviderModel } from '../../config/manager.js'

it('actual bootstrap preserves model policy and invokes preparation at the guarded user boundary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'r2-bootstrap-'))
  const restoreFixtureHome = useFixtureHome(home)
  const provider = providerSchema.parse({ name: 'synthetic', baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-only', models: [{ id: 'model', contextWindow: 32000, maxTokens: 4000, supportsVision: true, capabilities: { thinkingBlock: 'enabled', effortFormat: 'reasoning_effort', preservedThinkingProtocol: true, effortCap: { medium: 'high', max: 'high' } } }] })
  const config = configSchema.parse({ provider: { default: 'synthetic', providers: { synthetic: provider } }, compact: { enabled: false } })
  writeFileSync(join(home, 'config.json'), JSON.stringify(config))
  const persist = new SessionPersist('r2-bootstrap', home), claimStore = persist.createClaimStore(), fileHistory = new FileHistory(persist.getBackupDir(), 'r2-bootstrap')
  const refs: RuntimeRefs = { coordinator: null, fileHistory, claimStore, sessionId: 'r2-bootstrap', sessionRegistry: null, taskLedger: null, ownershipLedger: null, verificationSnapshotManager: null, deliveryGate: null, meridianIndexer: null, mcpManager: null, lspManager: null, banditState: null, promptEngine: null, goalTrackerRef: { current: null }, reviewGateRef: { current: 'off' }, pluginHooks: [], pluginCommands: [], todoStore: new TodoStore() }
  const { agent } = createAgentRuntime({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider, apiKey: 'synthetic-only', auth: undefined, config, sessionId: 'r2-bootstrap', cwd: home, toolRegistry: new ToolRegistry(), persist, claimStore, fileHistory, refs, domainKnowledgeStore: new DomainKnowledgeStore(join(home, 'knowledge')), modelId: 'model', session: new SessionContext() })
  try {
    const native = agent.config.primaryClient as unknown as { config: { preservedThinkingProtocol: boolean; effortCap: Record<string, string> } }
    assert.equal(native.config.preservedThinkingProtocol, true)
    assert.deepEqual(native.config.effortCap, { medium: 'high', max: 'high' })
    assert.equal(agent.config.supportsVision, true)
    let preparations = 0
    agent.config.prepareModelSubmission = async signal => { preparations++; assert.equal(signal.aborted, false); throw new Error('synthetic-boundary-stop') }
    const forbidden = () => { throw new Error('model work ran before request preparation') }
    ;(agent as unknown as { _runInner(): Promise<void> })._runInner = async () => forbidden()
    await assert.rejects(agent.run('hello', { onTextDelta: forbidden, onThinkingDelta: forbidden, onToolUse: forbidden, onToolResult: forbidden, onTurnComplete: forbidden, onError: forbidden, onAbort: forbidden, onApprovalRequired: async () => false }), /synthetic-boundary-stop/)
    assert.equal(preparations, 1)
    assert.equal(agent.isRunning(), false)
  } finally {
    agent.abort(); agent.stopFsWatcher(); agent.stopConfigWatcher(); await agent.cancelIdleCompaction(); await refs.coordinator?.shutdownAndWait(); agent.flushStigmergySync(); await persist.flushSessionBuffer()
    restoreFixtureHome()
    rmSync(home, { recursive: true, force: true })
  }
})

it('actual setup/upsert/config route preserve omitted and nested model semantics', async () => {
  const home = mkdtempSync(join(tmpdir(), 'r2-merge-'))
  const restoreFixtureHome = useFixtureHome(home)
  const provider = providerSchema.parse({ name: 'fixture-custom', baseUrl: 'http://localhost:12345/v1', models: [{ id: 'model', contextWindow: 32000, maxTokens: 4000, supportsVision: true, capabilities: { thinkingBlock: 'enabled', effortFormat: 'reasoning_effort', effortCap: { medium: 'high', max: 'high' } }, pricing: { input: 1, output: 2 } }] })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ provider: { default: provider.name, providers: { [provider.name]: provider } } }))
  try {
    setupProvider({ providerName: provider.name, model: { id: 'model', capabilities: { effortCap: { max: 'medium' } } } as unknown as typeof provider.models[number] })
    upsertProviderModel(provider.name, { id: 'model', contextWindow: 16000, maxTokens: 3000, capabilities: { thinkingBudgetField: 'budget_tokens' } } as unknown as typeof provider.models[number])
    const response = await createRouter(buildConfigRoutes('synthetic'))('POST', '/config/providers', { providerName: provider.name, model: { id: 'model', alias: 'changed' } }, { authorization: 'Bearer synthetic' })
    assert.equal(response.status, 200)
    const model = loadConfig().provider.providers[provider.name]!.models[0]!
    assert.equal(model.contextWindow, 16000); assert.equal(model.maxTokens, 3000); assert.equal(model.supportsVision, true)
    assert.equal(model.capabilities?.thinkingBlock, 'enabled'); assert.equal(model.capabilities?.effortFormat, 'reasoning_effort'); assert.equal(model.capabilities?.thinkingBudgetField, 'budget_tokens')
    assert.deepEqual(model.capabilities?.effortCap, { medium: 'high', max: 'medium' })
  } finally {
    restoreFixtureHome()
    rmSync(home, { recursive: true, force: true })
  }
})
