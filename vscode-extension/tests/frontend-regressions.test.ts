import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
async function load(relative: string, mocks: Record<string, any> = {}, globals: Record<string, any> = {}, extras = '', stubs: Record<string, string> = {}) {
  const output = await build({ entryPoints: [resolve(root, relative)], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['vscode', 'react', 'react/jsx-runtime'], plugins: [{ name: 'test-boundaries', setup(b) {
    if (extras) b.onLoad({ filter: /App\.tsx$/ }, async args => ({ contents: await readFile(args.path, 'utf8') + extras, loader: 'tsx' }))
    for (const suffix of Object.keys(stubs)) b.onResolve({ filter: new RegExp(suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }, () => ({ path: suffix, namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: stubs[args.path]!, loader: 'ts' }))
  } }] })
  const module = { exports: {} as any }
  vm.runInNewContext(output.outputFiles[0]!.text, { module, exports: module.exports, require: (id: string) => id in mocks ? mocks[id] : require(id), console, process, Buffer, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, ...globals })
  return module.exports
}
const tick = () => new Promise<void>(r => setImmediate(r))

test('native chat restores pending approval snapshots once, including frames before the turn is armed', async () => {
  let handler: any, callback: any, cancel: any
  const shown: string[] = []
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: { chat: { createChatParticipant: (_id: string, fn: any) => { handler = fn; return { dispose() {} } } } } })
  const frame = { seq: 0, ts: 1, type: 'approval_snapshot', data: { approvals: [{ requestId: 'pending-a', toolName: 'write_file', input: { file_path: 'fixture.ts' } }], lastSeq: 55 } }
  const client = {
    getSession: async () => ({ lastSeq: 55, approvalMode: 'manual' }),
    subscribe: (_id: string, since: number, fn: any) => { assert.equal(since, 55); callback = fn; fn(frame); return () => {} },
    queue: async () => ({ laneId: 'followup' }), abort: async () => {},
  }
  const participant = new TianshuChatParticipant(async () => client, () => {}, { handleApproval: (_session: string, id: string) => { shown.push(id) } })
  try {
    const pending = handler({ prompt: 'followup' }, { history: [{ participant: 'tianshu.default', result: { metadata: { tianshuSessionId: 'A' } } }] }, { markdown() {}, progress() {} }, { onCancellationRequested: (fn: any) => { cancel = fn; return { dispose() {} } } })
    for (let n = 0; n < 20 && !callback; n++) await tick()
    callback(frame)
    assert.deepEqual(shown, ['pending-a'])
    cancel(); await pending
  } finally { participant.dispose() }
})

test('question answers return to the originating session instead of the currently open native chat', async () => {
  for (const steerResult of ['queued', 'idle', 'lane_gone']) {
    const sent: unknown[] = [], notices: string[] = []
    let select: any
    const { ChatHumanInteraction } = await load('src/chat/human-interaction.ts', { vscode: {
      window: { showQuickPick: () => new Promise(resolve => { select = resolve }), showInformationMessage: async (text: string) => { notices.push(text) } },
      commands: { executeCommand: async (...args: unknown[]) => { sent.push(['global-chat', ...args]) } },
    } })
    const client = { steer: async (id: string, text: string) => { sent.push(['steer', id, text]); return steerResult }, prompt: async (id: string, text: string) => { sent.push(['prompt', id, text]) } }
    const human = new ChatHumanInteraction(async () => client, () => {})
    try {
      human.handleQuestion('original-A', 'question-A', [{ id: 'q', prompt: 'Fixture?', options: ['selected'], allowMultiple: false }])
      for (let n = 0; n < 20 && !select; n++) await tick()
      select('selected')
      await human.queue
      assert.deepEqual(sent, steerResult === 'queued' ? [['steer', 'original-A', 'selected']] : [['steer', 'original-A', 'selected'], ['prompt', 'original-A', 'selected']])
      assert.deepEqual(notices, ['回答已发送至原会话，请在天枢座舱查看后续结果。'])
    } finally { human.dispose() }
  }
})

test('dismissed or disposed question dialogs never send an answer', async () => {
  for (const disposed of [false, true]) {
    let select: any, deliveries = 0
    const { ChatHumanInteraction } = await load('src/chat/human-interaction.ts', { vscode: {
      window: { showQuickPick: () => new Promise(resolve => { select = resolve }), showInformationMessage: async () => { deliveries++ } },
      commands: { executeCommand: async () => { deliveries++ } },
    } })
    const human = new ChatHumanInteraction(async () => { deliveries++; return {} }, () => {})
    try {
      human.handleQuestion('A', 'q', [{ id: 'q', prompt: 'Fixture?', options: ['selected'], allowMultiple: false }])
      for (let n = 0; n < 20 && !select; n++) await tick()
      if (disposed) human.dispose()
      select(disposed ? 'selected' : undefined)
      await human.queue
      assert.equal(deliveries, 0)
    } finally { human.dispose() }
  }
})

// The VS Code host is external. These document doubles retain text/version and
// apply the real executor's edits so assertions cover its observable file result.
async function executorFixture() {
  let text = 'before\n', version = 1
  const answers: any[] = [], warnings: string[] = [], terminals: any[] = []
  class Uri { fsPath: string; constructor(p: string) { this.fsPath = p } static file(p: string) { return new Uri(p) } }
  class Range { constructor(..._args: any[]) {} }
  class WorkspaceEdit { edits: any[] = []; replace(uri: any, range: any, value: string) { this.edits.push({ uri, range, value }) } createFile() {} }
  const document = { uri: Uri.file('/fixture/file.txt'), get version() { return version }, getText: () => text, positionAt: (n: number) => ({ line: 0, character: n }) }
  const vscode = { Uri, Range, WorkspaceEdit, ThemeColor: class {}, OverviewRulerLane: { Left: 1 }, EventEmitter: class { event() {} fire() {} dispose() {} }, window: {
    createTextEditorDecorationType: () => ({ dispose() {} }), visibleTextEditors: [], showTextDocument: async () => ({ setDecorations() {} }),
    showInformationMessage: async (s: string) => { warnings.push(s) }, showWarningMessage: async (s: string) => { warnings.push(s) },
    createTerminal: (options: any) => { const t = { ...options, exitStatus: undefined, shellIntegration: { cwd: Uri.file(options.cwd) }, dispose() { this.exitStatus = { code: 0 } } }; terminals.push(t); return t },
  }, workspace: { fs: { stat: async () => ({}) }, openTextDocument: async () => document, applyEdit: async (edit: WorkspaceEdit) => { for (const e of edit.edits) text = e.value; version++; return true } } }
  const { DelegationExecutor } = await load('src/delegation/executor.ts', { vscode })
  const client = { answerDelegation: async (_s: string, _r: string, answer: any) => { answers.push(answer) } }
  const executor = new DelegationExecutor(async () => client, '/fixture')
  Object.assign(executor, { client, sessionId: 'A' })
  return { executor, document, answers, warnings, terminals, getText: () => text, change: (t: string) => { text = t; version++ }, origin: { client, sessionId: 'A', generation: executor.sessionGeneration } }
}

test('rejecting a delegated edit preserves subsequent user edits and reports a conflict', async () => {
  const f = await executorFixture()
  try {
    const done = f.executor.handleApplyEdit('edit', { path: 'file.txt', oldContent: 'before\n', newContent: 'agent\n' }, f.origin)
    for (let n = 0; n < 20 && !f.executor.pendingDecisions.size; n++) await tick()
    assert.equal(f.getText(), 'agent\n')
    f.change('agent\nUSER_ADDITION\n')
    await f.executor.decide(f.document.uri, 'rejected'); await done
    assert.equal(f.getText(), 'agent\nUSER_ADDITION\n')
    assert.equal(f.answers.at(-1).isError, true)
    assert.match(f.answers.at(-1).content, /changed|conflict/i)
  } finally { f.executor.dispose() }
})

test('rejecting an unchanged delegated edit restores the original text', async () => {
  const f = await executorFixture()
  try {
    const done = f.executor.handleApplyEdit('edit', { path: 'file.txt', oldContent: 'before\n', newContent: 'agent\n' }, f.origin)
    for (let n = 0; n < 20 && !f.executor.pendingDecisions.size; n++) await tick()
    await f.executor.decide(f.document.uri, 'rejected'); await done
    assert.equal(f.getText(), 'before\n')
    assert.equal(f.answers.at(-1).status, 'rejected')
  } finally { f.executor.dispose() }
})

test('delegated terminals follow requested cwd and replace a terminal moved by the user', async () => {
  const f = await executorFixture()
  try {
    const a = f.executor.ensureTerminal('/fixture/subA')
    const b = f.executor.ensureTerminal('/fixture/subB')
    assert.notEqual(a, b)
    assert.equal(b.cwd, resolve('/fixture/subB'))
    b.shellIntegration.cwd.fsPath = '/fixture/user-directory'
    const restored = f.executor.ensureTerminal('/fixture/subB')
    assert.notEqual(restored, b)
    assert.equal(restored.cwd, resolve('/fixture/subB'))
  } finally { f.executor.dispose() }
})

test('native chat restores A from result metadata after creating B and isolates overlapping creates', async () => {
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: { chat: { createChatParticipant: () => ({ dispose() {} }) }, workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] } } })
  let created = 0
  const client = { createSession: async () => ({ id: `native-${++created}` }) }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {})
  try {
    const [a, b] = await Promise.all([participant.resolveSession(client, { history: [] }), participant.resolveSession(client, { history: [] })])
    assert.notEqual(a, b)
    const resumed = await participant.resolveSession(client, { history: [{ participant: 'tianshu.default', result: { metadata: { tianshuSessionId: a } }, response: [] }] })
    assert.equal(resumed, a)
    const legacy = await participant.resolveSession(client, { history: [{ prompt: 'legacy conversation' }] })
    assert.notEqual(legacy, b, 'history without identity must not inherit the last chat')
  } finally { participant.dispose() }
})

test('failed permission restore is retried before a chat request can proceed', async () => {
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: { chat: { createChatParticipant: () => ({ dispose() {} }) } } })
  const modes: string[] = []
  let rejectRestore = true
  const client = { getSession: async () => ({ approvalMode: 'manual' }), setApprovalMode: async (_id: string, mode: string) => { modes.push(mode); if (mode === 'manual' && rejectRestore) throw Error('offline') } }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {})
  try {
    await participant.syncPermissionLevel(client, 'A', 'autopilot')
    await assert.rejects(participant.syncPermissionLevel(client, 'A', 'default'), /offline/)
    rejectRestore = false
    await participant.syncPermissionLevel(client, 'A', 'default')
    assert.deepEqual(modes, ['dangerously-skip-permissions', 'manual', 'manual'])
  } finally { participant.dispose() }
})

test('native request results carry session identity and route an A-B-A conversation correctly', async () => {
  let handler: any, created = 0
  const routes: string[] = [], callbacks = new Map<string, any>()
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: {
    chat: { createChatParticipant: (_id: string, callback: any) => { handler = callback; return { dispose() {} } } },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
  } })
  const client = {
    createSession: async () => ({ id: `session-${++created}` }),
    getSession: async () => ({ lastSeq: 0, approvalMode: 'manual' }),
    subscribe: (id: string, _seq: number, callback: any) => { callbacks.set(id, callback); return () => callbacks.delete(id) },
    queue: async () => 'idle',
    prompt: async (id: string) => { routes.push(id); callbacks.get(id)({ seq: 1, ts: 1, type: 'done', data: { status: 'completed' } }) },
  }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {})
  const stream = { markdown() {}, progress() {} }, token = { onCancellationRequested: () => ({ dispose() {} }) }
  try {
    const a = await handler({ prompt: 'A' }, { history: [] }, stream, token)
    const b = await handler({ prompt: 'B' }, { history: [] }, stream, token)
    assert.equal(a.metadata.tianshuSessionId, 'session-1'); assert.equal(b.metadata.tianshuSessionId, 'session-2')
    const resumed = await handler({ prompt: 'A again' }, { history: [{ participant: 'tianshu.default', result: a, response: [] }] }, stream, token)
    assert.equal(resumed.metadata.tianshuSessionId, 'session-1')
    assert.deepEqual(routes, ['session-1', 'session-2', 'session-1'])
  } finally { participant.dispose() }
})

test('failed permission acknowledgement displays a send failure and leaves the prompt unsent', async () => {
  let handler: any, sent = 0
  const messages: string[] = []
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: {
    chat: { createChatParticipant: (_id: string, callback: any) => { handler = callback; return { dispose() {} } } },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
  } })
  const client = { createSession: async () => ({ id: 'session' }), getSession: async () => ({ approvalMode: 'manual' }),
    setApprovalMode: async () => { throw Error('offline') }, queue: async () => { sent++; return 'idle' }, prompt: async () => { sent++ } }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {})
  try {
    const result = await handler({ prompt: 'task', permissionLevel: 'autopilot' }, { history: [] }, { progress() {}, markdown: (s: string) => messages.push(s) }, { onCancellationRequested: () => ({ dispose() {} }) })
    assert.equal(sent, 0); assert.equal(result.metadata.tianshuSessionId, 'session')
    assert(messages.some(s => s.includes('消息尚未发送')))
  } finally { participant.dispose() }
})

test('native request reservation rejects B while A is still preparing and keeps the A stream', async () => {
  let handler: any, releaseA: (() => void) | undefined, created = 0
  const routes: string[] = [], cancelled: string[] = [], callbacks = new Map<string, any>(), timers: any[] = [], aText: string[] = [], bText: string[] = []
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: {
    chat: { createChatParticipant: (_id: string, callback: any) => { handler = callback; return { dispose() {} } } }, workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
  } }, { setTimeout: (fn: any) => { timers.push(fn); return timers.length }, clearTimeout() {} })
  const client = { createSession: async () => { created++; if (created === 1) return new Promise(r => { releaseA = () => r({ id: 'A' }) }); return { id: 'B' } },
    getSession: async () => ({ lastSeq: 0 }), subscribe: (id: string, _seq: number, callback: any) => { callbacks.set(id, callback); return () => cancelled.push(id) },
    queue: async () => 'idle', prompt: async (id: string) => { routes.push(id) } }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {}), token = { onCancellationRequested: () => ({ dispose() {} }) }
  const a = handler({ prompt: 'A' }, { history: [] }, { progress() {}, markdown: (s: string) => aText.push(s) }, token)
  const b = handler({ prompt: 'B' }, { history: [] }, { progress() {}, markdown: (s: string) => bText.push(s) }, token)
  try {
    for (let n = 0; n < 20 && !releaseA; n++) await tick()
    assert.equal(created, 1)
    assert(bText.some(s => s.includes('上一个回答')))
    releaseA!()
    for (let n = 0; n < 20 && !routes.length; n++) await tick()
    assert.deepEqual(routes, ['A']); assert.deepEqual(cancelled, [])
    callbacks.get('A')({ seq: 1, ts: 1, type: 'text_delta', data: { text: 'REPLY A' } })
    callbacks.get('A')({ seq: 2, ts: 2, type: 'done', data: { status: 'completed' } })
    const result = await a; await b
    assert.equal(result.metadata.tianshuSessionId, 'A'); assert(aText.includes('REPLY A'))
  } finally {
    releaseA?.(); for (let n = 0; n < 5; n++) await tick()
    for (const callback of callbacks.values()) callback({ seq: 9, ts: 9, type: 'done', data: { status: 'completed' } })
    for (const timer of timers) timer()
    await Promise.allSettled([a, b]); participant.dispose()
  }
})

test('native preparation failure releases request reservation for the next request', async () => {
  let handler: any, fail = true
  const routes: string[] = [], callbacks = new Map<string, any>()
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: {
    chat: { createChatParticipant: (_id: string, callback: any) => { handler = callback; return { dispose() {} } } }, workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
  } })
  const client = { createSession: async () => { if (fail) throw Error('create failed'); return { id: 'B' } }, getSession: async () => ({ lastSeq: 0 }),
    subscribe: (id: string, _seq: number, callback: any) => { callbacks.set(id, callback); return () => {} }, queue: async () => 'idle',
    prompt: async (id: string) => { routes.push(id); callbacks.get(id)({ seq: 1, ts: 1, type: 'done', data: { status: 'completed' } }) } }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {}), token = { onCancellationRequested: () => ({ dispose() {} }) }, stream = { progress() {}, markdown() {} }
  try {
    await handler({ prompt: 'A' }, { history: [] }, stream, token); fail = false
    const b = await handler({ prompt: 'B' }, { history: [] }, stream, token)
    assert.deepEqual(routes, ['B']); assert.equal(b.metadata.tianshuSessionId, 'B')
  } finally { participant.dispose() }
})

test('native session lookup failure retries the missing subscription on the same conversation', async () => {
  let handler: any, fail = true
  const callbacks = new Map<string, any>(), routes: string[] = [], timers: any[] = []
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: {
    chat: { createChatParticipant: (_id: string, callback: any) => { handler = callback; return { dispose() {} } } },
  } }, { setTimeout: (fn: any) => { timers.push(fn); return timers.length }, clearTimeout() {} })
  const client = { getSession: async () => { if (fail) throw Error('lookup failed'); return { lastSeq: 0 } },
    subscribe: (id: string, _seq: number, callback: any) => { callbacks.set(id, callback); return () => {} }, queue: async () => 'idle',
    prompt: async (id: string) => { routes.push(id); callbacks.get(id)?.({ seq: 1, ts: 1, type: 'done', data: { status: 'completed' } }) } }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {}), token = { onCancellationRequested: () => ({ dispose() {} }) }, stream = { progress() {}, markdown() {} }
  const context = { history: [{ participant: 'tianshu.default', result: { metadata: { tianshuSessionId: 'A' } }, response: [] }] }
  let next: any
  try {
    await handler({ prompt: 'first' }, context, stream, token); fail = false
    next = handler({ prompt: 'retry' }, context, stream, token)
    for (let n = 0; n < 20 && !routes.length; n++) await tick()
    assert.equal(callbacks.has('A'), true)
    assert.equal((await next).metadata.tianshuSessionId, 'A')
  } finally {
    for (const timer of timers) timer()
    await next; participant.dispose()
  }
})

test('native cancellation releases a preparing request and late preparation cannot steal B', async () => {
  let handler: any, releaseA: (() => void) | undefined, created = 0, cancelledA = false
  const routes: string[] = [], callbacks = new Map<string, any>(), timers: any[] = [], cancels = new Set<any>()
  const { TianshuChatParticipant } = await load('src/chat/participant.ts', { vscode: {
    chat: { createChatParticipant: (_id: string, callback: any) => { handler = callback; return { dispose() {} } } }, workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }] },
  } }, { setTimeout: (fn: any) => { timers.push(fn); return timers.length }, clearTimeout() {} })
  const client = { createSession: async () => { created++; if (created === 1) return new Promise(r => { releaseA = () => r({ id: 'A' }) }); return { id: 'B' } },
    getSession: async () => ({ lastSeq: 0 }), subscribe: (id: string, _seq: number, callback: any) => { callbacks.set(id, callback); return () => callbacks.delete(id) },
    queue: async () => 'idle', prompt: async (id: string) => { routes.push(id) }, abort: async () => {} }
  const participant = new TianshuChatParticipant(async () => client, () => {}, {}), stream = { progress() {}, markdown() {} }
  const aToken = { get isCancellationRequested() { return cancelledA }, onCancellationRequested: (fn: any) => { cancels.add(fn); return { dispose: () => cancels.delete(fn) } } }
  const a = handler({ prompt: 'A' }, { history: [] }, stream, aToken)
  let b: any
  try {
    for (let n = 0; n < 20 && !releaseA; n++) await tick()
    cancelledA = true; for (const cancel of [...cancels]) cancel()
    b = handler({ prompt: 'B' }, { history: [] }, stream, { onCancellationRequested: () => ({ dispose() {} }) })
    for (let n = 0; n < 20 && !routes.length; n++) await tick()
    assert.deepEqual(routes, ['B'])
    releaseA!(); for (let n = 0; n < 5; n++) await tick()
    assert.deepEqual(routes, ['B']); assert.equal(callbacks.has('A'), false)
    callbacks.get('B')({ seq: 1, ts: 1, type: 'done', data: { status: 'completed' } })
    const result = await b; await a; assert.equal(result.metadata.tianshuSessionId, 'B')
  } finally {
    releaseA?.(); for (let n = 0; n < 5; n++) await tick()
    for (const callback of callbacks.values()) callback({ seq: 9, ts: 9, type: 'done', data: { status: 'completed' } })
    for (const timer of timers) timer()
    await Promise.allSettled([a, b]); participant.dispose()
  }
})

test('cockpit replaces active SSE together with REST and ignores the old stream', async () => {
  const { CockpitProvider } = await load('src/views/cockpit-provider.ts', { vscode: {} })
  const messages: any[] = [], subscriptions: any[] = []
  let cancelled = false
  const makeClient = (name: string) => ({ listProviders: async () => ({ providers: [] }), listRewindPoints: async () => ({ points: [] }), subscribe: (id: string, since: number, event: any) => { subscriptions.push({ name, id, since, event }); return () => { if (name === 'old') cancelled = true } } })
  const old = makeClient('old'), fresh = makeClient('fresh')
  const provider = new CockpitProvider({}, async () => fresh, '/fixture')
  provider.panel = { webview: { postMessage: (msg: any) => { messages.push(msg) } } }; provider.client = old
  try {
    provider.attachSession('A'); await provider.onMessage({ type: 'listProviders' })
    assert.equal(cancelled, true)
    assert.equal(subscriptions.at(-1).name, 'fresh')
    const count = messages.length
    subscriptions[0].event({ seq: 1, type: 'text_delta', data: { text: 'old' } })
    assert.equal(messages.length, count)
    subscriptions.at(-1).event({ seq: 1, type: 'text_delta', data: { text: 'fresh' } })
    assert.equal(messages.at(-1).event.data.text, 'fresh')
  } finally { provider.teardownBridge() }
})

// React/clipboard interfaces are external; state updates/effects and component
// callbacks run the production App/Composer without a VS Code browser process.
async function webviewFixture() {
  let current: any
  const react: any = {
    useState(initial: any) { const r = current, i = r.index++; if (!(i in r.slots)) r.slots[i] = typeof initial === 'function' ? initial() : initial; return [r.slots[i], (value: any) => { r.slots[i] = typeof value === 'function' ? value(r.slots[i]) : value }] },
    useReducer(reducer: any, initial: any) { const [s, set] = react.useState(initial); return [s, (a: any) => set((old: any) => reducer(old, a))] },
    useRef(initial: any) { const r = current, i = r.index++; return r.slots[i] ??= { current: initial } },
    useEffect(fn: any, deps: any[]) { const r = current, i = r.index++, old = r.slots[i]; if (!old || !deps || deps.some((v, j) => v !== old.deps[j])) r.pending.push(() => { old?.off?.(); r.slots[i] = { deps, off: fn() } }) },
    useMemo(fn: any, deps: any[]) { const r = current, i = r.index++, old = r.slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) r.slots[i] = { deps, value: fn() }; return r.slots[i].value },
    useCallback(fn: any, deps: any[]) { return react.useMemo(() => fn, deps) },
  }
  const jsx = { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }), Fragment: 'fragment' }
  const handlers = new Set<any>(), sent: any[] = [], readers: any[] = []
  class Reader { result: string | null = null; onload: any; onloadend: any; onerror: any; aborted = false; constructor() { readers.push(this) } readAsDataURL() {} abort() { this.aborted = true } }
  const mod = await load('webview-ui/src/App.tsx', { react, 'react/jsx-runtime': jsx }, { auditSend: (m: any) => { sent.push(m) }, auditOnHost: (f: any) => { handlers.add(f); return () => handlers.delete(f) }, FileReader: Reader, window: { confirm: () => true }, document: { addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: () => {} }, '\nexport { Composer, PlanCard };', { './bridge.js': 'export const send=m=>globalThis.auditSend(m); export const onHostMessage=f=>globalThis.auditOnHost(f);', './markdown.js': 'export const renderMarkdown=s=>s;' })
  const runner = (fn: any) => ({ slots: [] as any[], pending: [] as any[], index: 0, render(props?: any) { current = this; this.index = 0; const tree = fn(props); this.pending.splice(0).forEach(f => f()); return tree }, unmount() { this.slots.forEach(s => s?.off?.()) } })
  return { ...mod, sent, readers, runner, deliver: (msg: any) => [...handlers].forEach(f => f(msg)) }
}
function nodes(node: any): any[] { if (node == null || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)] }
const find = (tree: any, name: string) => nodes(tree).find(n => typeof n.type === 'function' && n.type.name === name)
const composerProps = { running: false, disabled: false, fileHits: [], onQueryFiles() {}, onClearFiles() {}, onSubmit() {}, onAbort() {}, onResume() {}, canResume: false, history: [], sessionKey: 'A' }
function paste(tree: any) { nodes(tree).find(n => n.type === 'textarea').props.onPaste({ clipboardData: { items: [{ type: 'image/png', getAsFile: () => ({}) }] }, preventDefault() {} }) }

test('resubmission invalidates plan decisions/body and same-slug sessions remain isolated', async () => {
  const f = await webviewFixture(), app = f.runner(f.App)
  app.render(); f.deliver({ type: 'sessionAttached', sessionId: 'A' }); app.render()
  const event = (seq: number, title: string) => ({ type: 'event', sessionId: 'A', event: { seq, ts: seq, type: 'plan_submitted', data: { slug: 'p', title, status: 'submitted' } } })
  f.deliver(event(1, 'First')); f.deliver({ type: 'plan', sessionId: 'A', plan: { slug: 'p', content: 'OLD' } }); f.deliver({ type: 'planDecisionResult', sessionId: 'A', slug: 'p', decision: 'reject', ok: true }); app.render()
  f.deliver(event(2, 'Revised')); let item = find(app.render(), 'Item')
  assert.equal(item.props.planDecisions.p, undefined); assert.equal(item.props.plans.p, undefined)
  f.deliver({ type: 'plan', sessionId: 'A', revision: 1, plan: { slug: 'p', content: 'OLD-LATE' } })
  item = find(app.render(), 'Item'); assert.equal(item.props.plans.p, undefined)
  f.deliver({ type: 'sessionAttached', sessionId: 'B' }); f.deliver({ ...event(1, 'B'), sessionId: 'B' }); item = find(app.render(), 'Item')
  assert.equal(item.props.plans.p, undefined); assert.equal(item.props.planDecisions.p, undefined)
  app.unmount()
})

test('a running composer keeps its image draft until idle and sends the attachment then', async () => {
  const f = await webviewFixture(), composer = f.runner(f.Composer), submits: any[] = []
  const props = { ...composerProps, running: true, onSubmit: (...args: any[]) => { submits.push(args) } }
  let tree = composer.render(props); paste(tree)
  const reader = f.readers.at(-1); reader.result = 'data:image/png;base64,aGVsbG8='; reader.onload()
  tree = composer.render(props); nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'look' } }); tree = composer.render(props)
  const button = nodes(tree).find(n => n.type === 'button' && n.props.children === '排队')
  button.props.onClick(); tree = composer.render(props)
  assert.equal(submits.length, 0); assert(nodes(tree).some(n => n.props.className === 'image-chips'))
  tree = composer.render({ ...props, running: false }); nodes(tree).find(n => n.type === 'button' && n.props.children === '发送').props.onClick()
  assert.equal(submits[0][0], 'look'); assert.equal(submits[0][1][0], 'data:image/png;base64,aGVsbG8='); composer.unmount()
})

test('late image reads are discarded on session switches, submission and unmount', async () => {
  const f = await webviewFixture(), composer = f.runner(f.Composer)
  let tree = composer.render(composerProps); paste(tree)
  const reader = f.readers.at(-1)
  composer.render({ ...composerProps, sessionKey: 'B' }); reader.result = 'data:image/png;base64,aGVsbG8='; reader.onload?.()
  tree = composer.render({ ...composerProps, sessionKey: 'B' })
  assert(!nodes(tree).some(n => n.props.className === 'image-chips'))
  nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'send' } })
  tree = composer.render({ ...composerProps, sessionKey: 'B' }); paste(tree)
  const submitted = f.readers.at(-1)
  submitted.result = 'data:image/png;base64,aGVsbG8='; submitted.onload?.()
  tree = composer.render({ ...composerProps, sessionKey: 'B' })
  nodes(tree).find(n => n.type === 'button' && n.props.children === '发送').props.onClick()
  submitted.onload?.()
  tree = composer.render({ ...composerProps, sessionKey: 'B' })
  assert(!nodes(tree).some(n => n.props.className === 'image-chips'))
  paste(tree); const unmounted = f.readers.at(-1); composer.unmount()
  assert.equal(unmounted.aborted, true)
})

for (const running of [false, true]) {
  test(`pending image read blocks ${running ? 'running' : 'idle'} submit and retains the completed image`, async () => {
    const f = await webviewFixture(), composer = f.runner(f.Composer), submits: any[] = []
    const props = { ...composerProps, running, onSubmit: (...args: any[]) => submits.push(args) }
    let tree = composer.render(props)
    nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'look' } }); tree = composer.render(props)
    paste(tree)
    const reader = f.readers.at(-1)
    // Same-event submission must also observe the synchronous pending-reader ref.
    nodes(tree).find(n => n.type === 'button' && n.props.children === (running ? '排队' : '发送')).props.onClick()
    tree = composer.render(props)
    assert.equal(submits.length, 0); assert.equal(reader.aborted, false)
    assert.equal(nodes(tree).find(n => n.type === 'button' && n.props.children === (running ? '排队' : '发送')).props.disabled, true)
    assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, 'look')
    reader.result = 'data:image/png;base64,aGVsbG8='; reader.onload()
    nodes(tree).find(n => n.type === 'button' && n.props.children === (running ? '排队' : '发送')).props.onClick()
    assert.equal(submits.length, 0, 'wait for completed image state to commit before submitting')
    tree = composer.render({ ...props, running: false })
    nodes(tree).find(n => n.type === 'button' && n.props.children === '发送').props.onClick()
    assert.equal(submits[0][1][0], 'data:image/png;base64,aGVsbG8='); composer.unmount()
  })
}

test('pending images block slash submit and error/abort completion unlocks the draft', async () => {
  const f = await webviewFixture(), composer = f.runner(f.Composer), submits: any[] = []
  const props = { ...composerProps, onSubmit: (...args: any[]) => submits.push(args) }
  let tree = composer.render(props)
  nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: '/ask' } }); tree = composer.render(props)
  paste(tree); const reader = f.readers.at(-1)
  nodes(tree).find(n => n.props.className?.startsWith('mention-item')).props.onClick()
  assert.equal(submits.length, 0); assert.equal(reader.aborted, false)
  reader.onerror(); tree = composer.render(props)
  assert.equal(nodes(tree).find(n => n.type === 'button' && n.props.children === '发送').props.disabled, false)
  paste(tree); const aborted = f.readers.at(-1)
  aborted.onabort(); tree = composer.render(props)
  assert.equal(nodes(tree).find(n => n.type === 'button' && n.props.children === '发送').props.disabled, false)
  paste(tree); composer.render({ ...props, sessionKey: 'B' }); tree = composer.render({ ...props, sessionKey: 'B' })
  nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'B draft' } }); tree = composer.render({ ...props, sessionKey: 'B' })
  assert.equal(nodes(tree).find(n => n.type === 'button' && n.props.children === '发送').props.disabled, false)
  composer.unmount()
})

test('queue restart cancellation retains the queued text and explains its terminal state', async () => {
  const { initialChatState, reduceEvent } = await load('webview-ui/src/model.ts')
  let state = reduceEvent(initialChatState, { seq: 1, ts: 1, type: 'queue_pending', data: { laneId: 'lane', text: 'queued draft' } })
  state = reduceEvent(state, { seq: 2, ts: 2, type: 'queue_status', data: { laneId: 'lane', status: 'retracted', reason: 'sidecar-restart' } })
  assert.equal(state.items[0]?.text, 'queued draft')
  assert.equal(state.items[0]?.status, 'cancelled')
  const f = await webviewFixture(), app = f.runner(f.App)
  app.render(); f.deliver({ type: 'sessionAttached', sessionId: 'A' }); app.render()
  f.deliver({ type: 'event', sessionId: 'A', event: { seq: 1, ts: 1, type: 'queue_pending', data: { laneId: 'lane', text: 'queued draft' } } })
  f.deliver({ type: 'event', sessionId: 'A', event: { seq: 2, ts: 2, type: 'queue_status', data: { laneId: 'lane', status: 'retracted', reason: 'sidecar-restart' } } })
  const item = find(app.render(), 'Item')
  const card = item.type(item.props)
  assert.equal(nodes(card).find(n => n.props.className === 'queue-status').props.children, '内核重启，排队已取消')
  assert(!nodes(card).some(n => n.type === 'button'), 'cancelled queue cannot be steered again')
  app.unmount()
})
