import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema } from '../../config/schema.js'
import { trustProject } from '../../config/project-trust.js'
import { createUserInstructionsSnapshot } from '../../prompt/user-instructions.js'
import { SessionPersist } from '../../agent/session-persist.js'
import { createAgentRuntime } from '../../bootstrap.js'

test('production main assembly rejects missing snapshots before touching any runtime dependency', () => {
  assert.throws(() => createAgentRuntime({} as Parameters<typeof createAgentRuntime>[0]), /payload_invalid/)
})

test('real sidecar assembly isolates trusted projects, pins live rebuilds and revokes restored rules', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'user-instructions-server-'))
  const home = join(root, 'home'); mkdirSync(join(home, 'instructions'), { recursive: true })
  const before = { home: process.env.RIVET_HOME, config: process.env.RIVET_CONFIG_PATH, sessions: process.env.RIVET_SESSION_DIR }
  process.env.RIVET_HOME = home; process.env.RIVET_CONFIG_PATH = join(home, 'config.json'); process.env.RIVET_SESSION_DIR = join(root, 'sessions')
  const agents: import('../session-manager.js').ManagedAgent[] = []
  const source = join(home, 'instructions', 'rules.md')
  writeFileSync(source, 'PINNED_MAIN: preserve archives.')
  const cfg = configSchema.parse({ provider: { default: 'fixture', providers: { fixture: { name: 'fixture', apiKey: 'synthetic', baseUrl: 'https://instructions.fixture.test/v1',
    models: [{ id: 'model-a', contextWindow: 100000, maxTokens: 4096 }, { id: 'model-b', contextWindow: 100000, maxTokens: 4096 }] } } },
    agent: { userInstructions: { enabled: true, path: source }, hearthObserveEnabled: false, crossSessionEnabled: false } })
  writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify(cfg))
  writeFileSync(join(root, '.rivet-config.json'), JSON.stringify({ agent: { userInstructions: { enabled: false } } }))
  trustProject(root)
  const bodies: Array<{ messages: unknown[] }> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (body.messages?.[0]?.role === 'system') bodies.push(body)
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  t.after(async () => {
    for (const agent of agents) await agent.shutdown?.()
    if (before.home === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = before.home
    if (before.config === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = before.config
    if (before.sessions === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = before.sessions
    rmSync(root, { recursive: true, force: true })
  })
  const { buildManagedAgent, mergeProjectAgentConfig } = await import('../serve-agent.js')
  assert.deepEqual(mergeProjectAgentConfig(cfg, root).agent.userInstructions, cfg.agent.userInstructions)
  const provider = cfg.provider.providers.fixture!
  const ctx = { config: cfg, provider, model: provider.models[0]!, apiKey: 'synthetic', configured: true }
  const managed = buildManagedAgent(ctx, root, 'rules-sidecar', undefined, undefined)
  agents.push(managed)
  const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onTurnComplete() {}, onToolUse() {}, onToolResult() {}, onAbort() {}, onApprovalRequired: async () => true, onError(error: Error) { throw error } }
  await managed.run('hello', callbacks)
  assert.ok(JSON.stringify(bodies[0]).includes('PINNED_MAIN'))
  const persist = new SessionPersist('rules-sidecar', root)
  assert.equal(persist.readFrozenSnapshot()?.userInstructions?.state, 'active')
  writeFileSync(source, 'CHANGED_ON_DISK: only a fresh session may load this.')
  assert.ok(await managed.switchModel?.('fixture:model-b'))
  await managed.run('hello again', callbacks)
  assert.ok(JSON.stringify(bodies.at(-1)?.messages.at(-1)).includes('PINNED_MAIN'))
  assert.ok(!JSON.stringify(bodies.at(-1)).includes('CHANGED_ON_DISK'))
  await managed.shutdown?.(); agents.splice(agents.indexOf(managed), 1)
  cfg.agent.userInstructions = { enabled: false }
  const restored = buildManagedAgent(ctx, root, 'rules-sidecar', undefined, undefined)
  agents.push(restored)
  const calls = bodies.length
  await assert.rejects(restored.run('auto', callbacks, undefined, { origin: 'runtime_command' }), /boundary_required/)
  assert.equal(bodies.length, calls)
  await restored.run('hello after disabling', callbacks)
  assert.ok(JSON.stringify(bodies.at(-1)?.messages.at(-1)).includes('此前同名用户长期指令已停用'))
  assert.equal(persist.readFrozenSnapshot()?.userInstructions?.state, 'revoked')
  assert.ok(createUserInstructionsSnapshot('PINNED_MAIN: preserve archives.').state === 'active')
})

test('invalid new resume rules leave the outgoing runtime untouched', async t => {
  const root = mkdtempSync(join(tmpdir(), 'user-instructions-switch-'))
  const before = { home: process.env.RIVET_HOME, config: process.env.RIVET_CONFIG_PATH }
  process.env.RIVET_HOME = root; process.env.RIVET_CONFIG_PATH = join(root, 'config.json')
  writeFileSync(process.env.RIVET_CONFIG_PATH, JSON.stringify({ agent: { userInstructions: { enabled: true, path: join(root, 'instructions', 'missing.md') } } }))
  t.after(() => {
    if (before.home === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = before.home
    if (before.config === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = before.config
    rmSync(root, { recursive: true, force: true })
  })
  const { switchAgentSession } = await import('../../bootstrap.js')
  const current = { sessionId: 'old', cwd: root, agent: { stopFsWatcher() { throw new Error('outgoing runtime was touched') } } }
  const result = switchAgentSession(current as unknown as Parameters<typeof switchAgentSession>[0], 'new')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /source_invalid/)
  assert.equal(current.sessionId, 'old')
})
