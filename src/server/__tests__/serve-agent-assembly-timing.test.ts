import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createServeTimingLogger } from '../serve-timing.js'

type Caller = (...args: unknown[]) => Promise<unknown>
type Step = { name: string; args: unknown[] }
type FixtureOptions = { failAt?: string; holdPrefetch?: boolean }

function loadCaller(name: string, bindings: Record<string, unknown>): Caller {
  const file = name === 'buildGatewayAgent' ? 'serve.ts' : 'serve-agent.ts'
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let code = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      code = node.getText(parsed).replace(/^export /, '') + '\nconst caller = ' + name
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name && node.initializer) {
      code = 'const caller = ' + node.initializer.getText(parsed)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(code, 'must execute the production caller')
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return runInNewContext(compiled + '\ncaller', { ...bindings }) as Caller
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => { resolve = complete })
  return { promise, resolve }
}

function fixture(raw: string | undefined, options: FixtureOptions = {}) {
  let clock = 100
  let wallReads = 0
  const lines: string[] = []
  const steps: Step[] = []
  const failure = new Error('synthetic failure')
  const history = deferred<unknown[]>()
  const baselineRead = deferred<object>()
  const messages: unknown[] = []
  const baseline = {}
  const inputContext = { provider: {}, auth: {}, config: { agent: {} } }
  const context = { provider: {}, config: { agent: { recovery: { structuredTools: true } } } }
  const selection = { spec: { provider: {} } }
  const target = { context, spec: {}, ownedOfficialAuth: {} }
  const registry = {}
  const shared = {}
  const reload = () => inputContext
  const allowed = ['synthetic-tool']
  const result = {}
  const args = [inputContext, '/synthetic-workspace', 'synthetic-session', registry, 'ask', shared, reload, 'synthetic-model', allowed]
  const logger = (enabled: boolean) => createServeTimingLogger(enabled, () => clock, (line) => lines.push(line))
  const step = (name: string, inputs: unknown[], value: unknown) => {
    steps.push({ name, args: inputs })
    clock += 10
    if (options.failAt === name) throw failure
    return value
  }
  const persist = {
    loadOaiAsync: async (...inputs: unknown[]) => {
      step('history', inputs, undefined)
      return options.holdPrefetch ? history.promise : messages
    },
    loadMetadata: () => step('metadata', [], {}),
  }
  const bindings = {
    process: { env: { RIVET_SERVE_TIMING: raw }, cwd: () => '/synthetic-fallback' },
    performance: { now: () => clock },
    Date: { now: () => { wallReads++; return 1_700_000_000_000 + clock } },
    createServeTimingLogger: logger,
    prepareManagedTarget: async (...inputs: unknown[]) => step('target', inputs, target),
    isOfficialProvider: () => true,
    SessionPersist: function (...inputs: unknown[]) { step('persist', inputs, undefined); return persist },
    captureGitBaselineAsync: async (...inputs: unknown[]) => {
      step('baseline', inputs, undefined)
      return options.holdPrefetch ? baselineRead.promise : baseline
    },
    buildManagedAgent: (...inputs: unknown[]) => step('sync', inputs, result),
    shouldReconcileDisk: () => false,
    timing: logger(true),
    officialSessionContexts: new Map(),
    restoredSessions: new Set(),
    ctx: inputContext,
    specReload: reload,
    resolveManagedTargetSelection: (...inputs: unknown[]) => step('selection', inputs, selection),
    warmup: { fireNow: () => step('warmup', [], undefined) },
    loadServeAgent: async () => ({
      buildManagedAgentAsync: async (...inputs: unknown[]) => step('managed', inputs, result),
    }),
    pluginToolsWarmup: async () => undefined,
    setTimeout: () => ({ unref() {} }),
    PLUGIN_WARM_WAIT_CAP_MS: 1500,
    goalHandlesResolve: null,
    reviewGateResolve: null,
    searchResolve: null,
    storesForgetter: null,
    initializationError: undefined,
    recoveryJournal: { load: async (...inputs: unknown[]) => step('journal', inputs, { transcriptWatermark: 7 }) },
    sessionRegistry: registry,
    sharedRuntime: shared,
  }
  return {
    lines, steps, failure, args, result, context, selection, target, persist, messages, baseline,
    history, baselineRead,
    wallReads: () => wallReads,
    runManaged: loadCaller('buildManagedAgentAsync', bindings),
    runGateway: loadCaller('buildGatewayAgent', bindings),
  }
}

const managedPhases = [
  'managed-target-start', 'managed-target-ready', 'managed-prefetch-start',
  'managed-history-ready', 'managed-baseline-ready', 'managed-prefetch-ready',
  'managed-sync-build-start', 'managed-sync-build-ready',
]
const gatewayPhases = [
  'model-recovery-load-start', 'model-recovery-load-ready',
  'model-managed-build-start', 'model-managed-build-ready',
]

function phases(lines: string[]) {
  return lines.map((line) => /phase=([a-z-]+)/.exec(line)![1]!)
}

function assertNumeric(lines: string[]) {
  for (const line of lines) {
    assert.match(line, /^\[serve-timing\] phase=[a-z-]+ \+\d+ms elapsedMs=\d+ wallMs=\d+$/)
  }
}

test('actual async assembly emits numeric-only fixed boundaries with wall-clock anchors', async () => {
  const signal = new AbortController().signal
  const state = fixture('1')
  assert.equal(await state.runManaged(state.args, signal, 7, state.selection), state.result)
  assert.deepEqual(phases(state.lines), managedPhases)
  assertNumeric(state.lines)
  assert.match(state.lines[0]!, /elapsedMs=0 wallMs=1700000000100$/)
  assert.match(state.lines.at(-1)!, /elapsedMs=60 wallMs=1700000000160$/)
  assert.deepEqual(state.steps.map((entry) => entry.name), ['target', 'persist', 'history', 'baseline', 'metadata', 'sync'])
  assert.equal(state.steps[0]!.args[0], state.args[0])
  assert.equal(state.steps[0]!.args[6], state.selection)
  assert.equal(state.steps[0]!.args[5], signal)
  assert.equal(state.steps[2]!.args[0], signal)
  assert.equal(state.steps[3]!.args[1], signal)
  const inputs = state.steps.at(-1)!.args
  assert.equal(inputs[0], state.context)
  assert.deepEqual(inputs.slice(1, 9), state.args.slice(1))
  assert.equal(inputs[10], 7)
  const prepared = inputs[9] as Record<string, unknown>
  assert.equal(prepared.persist, state.persist)
  assert.equal(prepared.messages, state.messages)
  assert.equal(prepared.baseline, state.baseline)
  assert.equal(prepared.selectedSpec, state.target.spec)
  assert.equal(prepared.ownedOfficialAuth, state.target.ownedOfficialAuth)
})

test('actual gateway brackets journal load and async build without changing watermark or selection', async () => {
  const signal = new AbortController().signal
  const state = fixture('1')
  assert.equal(await state.runGateway(state.args[1], state.args[2], 'ask', state.args[7], state.args[8], signal), state.result)
  const detail = state.lines.filter((line) => /elapsedMs=/.test(line))
  assert.deepEqual(phases(detail), gatewayPhases)
  assertNumeric(detail)
  assert.deepEqual(state.steps.map((entry) => entry.name), ['selection', 'warmup', 'journal', 'managed'])
  const inputs = state.steps.at(-1)!.args
  assert.deepEqual(Array.from(inputs[0] as unknown[]), state.args)
  assert.equal(inputs[1], signal)
  assert.equal(inputs[2], 7)
  assert.equal(inputs[3], state.selection)
})

for (const raw of [undefined, '0', 'yes']) {
  test('new detail diagnostics stay silent unless explicitly enabled: ' + String(raw), async () => {
    const state = fixture(raw)
    assert.equal(await state.runManaged(state.args, undefined, 7, state.selection), state.result)
    assert.equal(await state.runGateway('/synthetic-workspace', 'synthetic-session'), state.result)
    assert.deepEqual(state.lines.filter((line) => /elapsedMs=|wallMs=|phase=managed-/.test(line)), [])
    assert.equal(state.wallReads(), 0)
  })
}

test('history and Git prefetch remain concurrent and completion phases identify the slower branch', async () => {
  const state = fixture('1', { holdPrefetch: true })
  const pending = state.runManaged(state.args, undefined, 7, state.selection)
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
  assert.ok(state.steps.some((entry) => entry.name === 'history'))
  assert.ok(state.steps.some((entry) => entry.name === 'baseline'))
  assert.ok(!state.steps.some((entry) => entry.name === 'sync'))
  state.baselineRead.resolve(state.baseline)
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
  assert.ok(phases(state.lines).includes('managed-baseline-ready'))
  assert.ok(!phases(state.lines).includes('managed-prefetch-ready'))
  state.history.resolve(state.messages)
  assert.equal(await pending, state.result)
  assert.deepEqual(phases(state.lines).slice(3, 6), [
    'managed-baseline-ready', 'managed-history-ready', 'managed-prefetch-ready',
  ])
})

for (const failAt of ['target', 'history', 'baseline', 'sync'] as const) {
  test('async assembly preserves original rejection with no false success phase: ' + failAt, async () => {
    const state = fixture('1', { failAt })
    await assert.rejects(state.runManaged(state.args), (error) => error === state.failure)
    assert.ok(!phases(state.lines).includes('managed-sync-build-ready'))
    const ready = { target: 'managed-target-ready', history: 'managed-history-ready', baseline: 'managed-baseline-ready', sync: 'managed-sync-build-ready' }[failAt]!
    assert.ok(!phases(state.lines).includes(ready))
    assert.equal(state.steps.filter((entry) => entry.name === failAt).length, 1)
  })
}

for (const failAt of ['journal', 'managed']) {
  test('gateway preserves original rejection with no false ready phase: ' + failAt, async () => {
    const state = fixture('1', { failAt })
    await assert.rejects(state.runGateway('/synthetic-workspace', 'synthetic-session'), (error) => error === state.failure)
    assert.ok(!phases(state.lines).includes('model-managed-build-ready'))
    if (failAt === 'journal') {
      assert.ok(!phases(state.lines).includes('model-recovery-load-ready'))
      assert.ok(!state.steps.some((entry) => entry.name === 'managed'))
    }
  })
}

test('aborted assembly still stops before persistence and forwards the original signal', async () => {
  const controller = new AbortController()
  const reason = new Error('synthetic abort')
  controller.abort(reason)
  const state = fixture('1')
  await assert.rejects(state.runManaged(state.args, controller.signal), (error) => error === reason)
  assert.equal(state.steps[0]!.args[5], controller.signal)
  assert.deepEqual(state.steps.map((entry) => entry.name), ['target'])
  assert.ok(!phases(state.lines).includes('managed-prefetch-start'))
})

test('cancellation during concurrent prefetch still prevents synchronous assembly', async () => {
  const controller = new AbortController()
  const state = fixture('1', { holdPrefetch: true })
  const pending = state.runManaged(state.args, controller.signal)
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
  const reason = new Error('synthetic pending abort')
  controller.abort(reason)
  state.history.resolve(state.messages)
  state.baselineRead.resolve(state.baseline)
  await assert.rejects(pending, (error) => error === reason)
  assert.ok(!state.steps.some((entry) => entry.name === 'sync'))
  assert.ok(!phases(state.lines).includes('managed-sync-build-start'))
})

test('each assembly invocation has its own elapsed origin and does not suppress later observations', async () => {
  const state = fixture('1')
  assert.equal(await state.runManaged(state.args), state.result)
  assert.equal(await state.runManaged(state.args), state.result)
  assert.deepEqual(phases(state.lines), [...managedPhases, ...managedPhases])
  assert.match(state.lines[0]!, /elapsedMs=0 wallMs=1700000000100$/)
  assert.match(state.lines[8]!, /elapsedMs=0 wallMs=1700000000160$/)
  assert.equal(state.steps.filter((entry) => entry.name === 'sync').length, 2)
})
