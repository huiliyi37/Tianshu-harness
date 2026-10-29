import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

type Caller = (...args: unknown[]) => unknown
type Backend = 'in-process' | 'isolated'
type Origin = 'restored' | 'external' | 'new'

function loadCaller(name: string, bindings: Record<string, unknown>): Caller {
  const source = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('serve.ts', source, ts.ScriptTarget.Latest, true)
  const matches: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name && node.initializer) {
      matches.push(node.initializer.getText(parsed))
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === name
      && ts.isNewExpression(node.parent.parent)
      && node.parent.parent.expression.getText(parsed) === 'RuntimeSessionManager') {
      matches.push(node.initializer.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(matches.length, 1, `must execute the current production caller: ${name}`)
  const compiled = ts.transpileModule(`const caller = ${matches[0]}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return runInNewContext(`${compiled}\ncaller`, { ...bindings }) as Caller
}

class FixtureOfficialError extends Error {
  readonly status = 409
  constructor(readonly code: string) { super(code) }
}

function gatewayFixture(backend: Backend, origin: Origin, captured = false, selectedOfficial = false) {
  const calls: string[] = []
  const sessionId = 'synthetic-session'
  const model = { id: 'synthetic-model', maxTokens: 4096, contextWindow: 128000 }
  const provider = { name: 'synthetic-byok', models: [model] }
  const ctx = {
    provider, model, apiKey: '', configured: false,
    config: { provider: { default: provider.name, providers: { [provider.name]: provider } } },
  }
  const officialProvider = { ...provider, name: 'tianshu-official', auth: { type: 'tianshu-account' } }
  const capturedContext = { ...ctx, provider: officialProvider, auth: { isAuthenticated: () => true }, configured: true }
  const officialSessionContexts = new Map(captured ? [[sessionId, capturedContext]] : [])
  const restoredSessions = new Set(origin === 'restored' ? [sessionId] : [])
  const result = {}
  const selectionInputs: unknown[][] = []
  const buildInputs: unknown[][] = []
  const specReload = () => { calls.push('reload'); return ctx }
  const backendBuild = (...args: unknown[]) => {
    calls.push('backend-build')
    buildInputs.push(args)
    return result
  }
  const bindings = {
    process: { env: {}, cwd: () => '/synthetic-workspace' },
    performance: { now: () => 0 },
    timing: { mark() {} },
    ctx, officialSessionContexts, restoredSessions, specReload,
    officialProviderId: 'tianshu-official',
    OfficialError: FixtureOfficialError,
    isOfficialProvider: (candidate: typeof officialProvider) => candidate.auth?.type === 'tianshu-account',
    resolveManagedTargetSelection: (...args: unknown[]) => {
      calls.push('resolve')
      selectionInputs.push(args)
      specReload()
      return { context: args[0], spec: { provider: selectedOfficial ? officialProvider : (args[0] as typeof ctx).provider, model } }
    },
    warmup: { fireNow: () => { calls.push('warmup') } },
    loadServeAgent: async () => {
      calls.push('load-agent')
      return { buildManagedAgentAsync: async (...args: unknown[]) => {
        calls.push('build')
        buildInputs.push(args)
        return result
      } }
    },
    pluginToolsWarmup: async () => undefined,
    setTimeout: () => ({ unref() {} }),
    PLUGIN_WARM_WAIT_CAP_MS: 1500,
    goalHandlesResolve: null, reviewGateResolve: null, searchResolve: null, storesForgetter: null,
    initializationError: undefined, recoveryJournal: undefined,
    sessionRegistry: {}, sharedRuntime: {},
    knownSessions: new Set<string>(),
    sessions: {
      listAllSessions: () => [{ id: sessionId }],
      getSession: (id: string) => id === sessionId ? { id } : undefined,
    },
    serverEvents: { publish() {} },
    petActivity: undefined,
    executionBackend: { kind: backend, createAgent: backendBuild },
    agentBuilds: { createAgent: backendBuild },
  }
  if (origin === 'external') {
    loadCaller('onSessionsChanged', bindings)('external')
  }
  const caller = loadCaller(backend === 'in-process' ? 'buildGatewayAgent' : 'createAgent', bindings)
  return {
    calls, result, capturedContext, selectionInputs, buildInputs, restoredSessions,
    run: (modelId: string) => Promise.resolve().then(() => caller('/synthetic-workspace', sessionId, 'manual', modelId)),
  }
}

for (const backend of ['in-process', 'isolated'] as const) {
  for (const origin of ['restored', 'external'] as const) {
    test(`${backend} refuses ${origin} official sessions before ordinary-model fallback or agent loading`, async () => {
      const state = gatewayFixture(backend, origin)
      await assert.rejects(state.run('tianshu-official:synthetic-model'), (error: unknown) =>
        error instanceof FixtureOfficialError && error.code === 'account_changed' && error.status === 409)
      assert.deepEqual(state.calls, [])
    })

    test(`${backend} retains captured ownership for ${origin} official sessions without a public catalog provider`, async () => {
      const state = gatewayFixture(backend, origin, true)
      assert.equal(await state.run('tianshu-official:synthetic-model'), state.result)
      if (backend === 'in-process') {
        assert.equal(state.selectionInputs[0]?.[0], state.capturedContext)
        assert.equal((state.buildInputs[0]?.[0] as unknown[])[0], state.capturedContext)
        assert.equal(state.calls.filter(call => call === 'build').length, 1)
      } else {
        assert.deepEqual(state.calls, ['backend-build'])
      }
    })
  }

  test(`${backend} retains ordinary restored-session recovery`, async () => {
    const state = gatewayFixture(backend, 'restored')
    assert.equal(await state.run('ordinary-provider:missing-model'), state.result)
    assert.equal(state.calls.filter(call => call === (backend === 'in-process' ? 'build' : 'backend-build')).length, 1)
  })

  test(`${backend} never treats catalog resolution as restored-session authority`, async () => {
    const state = gatewayFixture(backend, 'restored', false, true)
    await assert.rejects(state.run('synthetic-model'), (error: unknown) =>
      error instanceof FixtureOfficialError && error.code === 'account_changed')
    assert.equal(state.calls.includes('build'), false)
    assert.equal(state.calls.includes('backend-build'), false)
  })
}

for (const reason of ['external', 'created']) {
  test(`actual ${reason} reconciliation uses one model view and never promotes adopted ownership`, () => {
    let modelReads = 0
    const kept = { id: 'synthetic-kept' }
    const archived = { id: 'synthetic-archived', archived: true }
    const adopted = { id: 'synthetic-adopted' }
    const manager = {
      listAllSessions() { modelReads++; return [kept, archived, adopted] },
      getSession() { throw new Error('reconciliation must reuse the list view, not enrich every record again') },
    }
      const knownSessions = new Set([kept.id, archived.id, 'missing'])
      const restoredSessions = new Set([kept.id, archived.id, 'missing'])
      const officialSessionContexts = new Map([
        [kept.id, { owner: 'kept' }],
        [archived.id, { owner: 'archived' }],
        ['missing', { owner: 'removed' }],
      ])
      const published: unknown[][] = []
      const callback = loadCaller('onSessionsChanged', {
        sessions: manager, knownSessions, restoredSessions, officialSessionContexts,
        serverEvents: { publish: (...args: unknown[]) => { published.push(args) } },
      })
      modelReads = 0

      callback(reason)

      assert.equal(modelReads, 1, 'presence reconciliation shares one catalog read across all records')
      assert.deepEqual([...knownSessions], [kept.id, archived.id, adopted.id])
      assert.deepEqual([...restoredSessions], reason === 'external' ? [kept.id, archived.id, adopted.id] : [kept.id, archived.id])
      assert.deepEqual([...officialSessionContexts.keys()], [kept.id, archived.id])
      assert.deepEqual(published, [['sessions_changed', reason]])
  })
}

test('an inactive official error callback cannot mark a replacement lifecycle as failed', () => {
  const source = readFileSync(new URL('../session-manager.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('session-manager.ts', source, ts.ScriptTarget.Latest, true)
  let callback: ts.PropertyAssignment | undefined
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === 'buildCallbacks') {
      function findCallback(child: ts.Node): void {
        if (ts.isPropertyAssignment(child) && child.name.getText(parsed) === 'onError') callback = child
        ts.forEachChild(child, findCallback)
      }
      findCallback(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(callback, 'must exercise the current lifecycle callback')
  const session = { record: { status: 'running' }, activeRunSettlement: {} as { officialFailure?: unknown } }
  const compiled = ts.transpileModule(`(${callback.initializer.getText(parsed)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const onError = runInNewContext(compiled, {
    session, OfficialError: FixtureOfficialError, isActive: () => false,
  }) as (error: Error) => void

  onError(new FixtureOfficialError('account_changed'))

  assert.equal(session.record.status, 'running')
  assert.equal(session.activeRunSettlement.officialFailure, undefined)
})
