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
  vm.runInNewContext(output.outputFiles[0]!.text, { module, exports: module.exports, require: (id: string) => id in mocks ? mocks[id] : require(id), console, process, Buffer, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...globals })
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
  const mod = await load('webview-ui/src/App.tsx', { react, 'react/jsx-runtime': jsx }, { auditSend: (m: any) => { sent.push(m) }, auditOnHost: (f: any) => { handlers.add(f); return () => handlers.delete(f) }, FileReader: Reader, window: { confirm: () => true }, document: { addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: () => {} }, '\nexport { Composer, PlanCard, TokenLedgerPanel };', { './bridge.js': 'export const send=m=>globalThis.auditSend(m); export const onHostMessage=f=>globalThis.auditOnHost(f);', './markdown.js': 'export const renderMarkdown=s=>s;' })
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


const ledgerFixtureSettings = { enabled: true, deviceName: 'Fixture device', forum: { endpoint: 'https://tianshuharness.com/token/v1/token-usage', apiKeyConfigured: true, autoSync: false, intervalMinutes: 30 } }
const ledgerFixtureTotals = { requests: 2, input: 12000, output: 450, cacheRead: 9000, cacheCreate: 300, cost: 1.25 }
const ledgerFixtureStatus = { enabled: true, endpointConfigured: true, autoSync: false, autoSyncConfigured: false, deviceId: 'fixture-device', deviceName: 'Fixture device', totals: ledgerFixtureTotals, dayCount: 1, pending: true, lastPushAt: '2026-10-10T12:00:00Z', lastPushResult: { ok: false, code: 'timeout', at: '2026-10-11T12:00:00Z' }, statePath: '/fixture/local-ledger' }
const ledgerFixtureSummary = { enabled: true, deviceId: 'fixture-device', deviceName: 'Fixture device', windowDays: 30, totals: ledgerFixtureTotals, allTime: ledgerFixtureTotals, days: [], pending: true }

async function ledgerHostFixture(key: string | undefined = undefined) {
  const messages: any[] = [], calls: any[] = [], prompts: any[] = []
  const { CockpitProvider } = await load('src/views/cockpit-provider.ts', { vscode: { window: { showInputBox: async (options: any) => { prompts.push(options); return key } } } })
  const client = {
    getTokenLedgerSummary: async (days: number) => { calls.push(['summary', days]); return ledgerFixtureSummary },
    getTokenLedgerStatus: async () => { calls.push(['status']); return ledgerFixtureStatus },
    getTokenLedgerSettings: async (settings?: any) => { calls.push(['settings']); return ledgerFixtureSettings },
    setTokenLedgerSettings: async (settings: any) => { calls.push(['save', settings]); return ledgerFixtureSettings },
    syncTokenLedger: async () => { calls.push(['sync']); return { ok: true, skipped: 'unchanged' } },
  }
  const provider = new CockpitProvider({}, async () => client, '/fixture')
  provider.panel = { webview: { postMessage: (message: any) => { messages.push(message) } } }
  return { provider, client, messages, calls, prompts }
}

test('Token ledger reads local summary/settings/status without uploading and strips raw error details', async () => {
  const f = await ledgerHostFixture()
  f.client.getTokenLedgerStatus = async () => ({ ...ledgerFixtureStatus, lastPushResult: { ...ledgerFixtureStatus.lastPushResult, error: 'untrusted-private-detail' } })
  await f.provider.onMessage({ type: 'getTokenLedger', requestId: 1 })
  assert.equal(f.messages.at(-1)?.type, 'tokenLedger')
  assert.equal(f.messages.at(-1)?.settings.forum.autoSync, false)
  assert.equal(f.messages.at(-1)?.summary.totals.input, 12000)
  assert(!f.calls.some(([action]) => action === 'sync'))
  assert(!JSON.stringify(f.messages).includes('untrusted-private-detail'))
})

test('Token ledger key is entered in a host password prompt and never returned to the webview', async () => {
  const key = 'fixture-ledger-input'
  const f = await ledgerHostFixture(key)
  await f.provider.onMessage({ type: 'setTokenLedgerKey', requestId: 2 })
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0].password, true)
  assert.equal(f.prompts[0].ignoreFocusOut, true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(([action]) => action === 'save'))), ['save', { forum: { apiKey: key } }])
  assert(!JSON.stringify(f.messages).includes(key))
  assert.equal(f.messages.at(-1)?.type, 'tokenLedgerResult')
  assert.equal(f.messages.at(-1)?.ok, true)
})

test('Token ledger cancelled password prompt preserves key and clear requires an explicit action', async () => {
  const f = await ledgerHostFixture()
  await f.provider.onMessage({ type: 'setTokenLedgerKey', requestId: 3 })
  assert(!f.calls.some(([action]) => action === 'save'))
  assert.equal(f.messages.at(-1)?.cancelled, true)
  await f.provider.onMessage({ type: 'clearTokenLedgerKey', requestId: 4 })
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(([action]) => action === 'save'))), ['save', { forum: { apiKey: '' } }])
})

test('Token ledger normal settings cannot smuggle a key and failed sync reports a controlled error', async () => {
  const f = await ledgerHostFixture()
  await f.provider.onMessage({ type: 'saveTokenLedgerSettings', requestId: 5, forum: { autoSync: true, intervalMinutes: 30, apiKey: 'webview-key-must-be-ignored' } })
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(([action]) => action === 'save'))), ['save', { forum: { autoSync: true, intervalMinutes: 30 } }])
  f.client.syncTokenLedger = async () => { throw new Error('POST /token-ledger/sync → 502: untrusted-private-detail') }
  await f.provider.onMessage({ type: 'syncTokenLedger', requestId: 6 })
  assert.equal(f.messages.at(-1)?.ok, false)
  assert(!JSON.stringify(f.messages).includes('untrusted-private-detail'))
})

test('settings drawer exposes the local Token ledger without changing conversation usage', async () => {
  const f = await webviewFixture(), app = f.runner(f.App)
  const tree = app.render()
  find(tree, 'Header').props.onSettings()
  const settings = find(app.render(), 'SettingsPanel')
  assert(settings)
  const panel = settings.type(settings.props)
  assert(find(panel, 'TokenLedgerPanel'), 'settings should offer a local Token ledger card')
  app.unmount()
})


function ledgerSnapshotMessage(requestId: number, overrides: any = {}) {
  return { type: 'tokenLedger', requestId, settings: ledgerFixtureSettings, status: ledgerFixtureStatus, summary: ledgerFixtureSummary, ...overrides }
}
function button(tree: any, label: string) { return nodes(tree).find(n => n.type === 'button' && n.props.children === label) }
function text(tree: any): string {
  if (tree === null || tree === undefined) return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  return text(tree.props?.children)
}

test('Token ledger card reads locally, totals input plus output, and retains the last successful push after failure', async () => {
  const f = await webviewFixture(), card = f.runner(f.TokenLedgerPanel)
  card.render()
  assert.deepEqual(f.sent.map(m => m.type), ['getTokenLedger'])
  const requestId = f.sent.at(-1).requestId
  f.deliver(ledgerSnapshotMessage(requestId))
  const tree = card.render(), visible = text(tree)
  assert.match(visible, /12,450/)
  assert.match(visible, /9,000/)
  assert(!visible.includes('21,750'))
  assert.match(visible, /已含在输入/)
  assert.match(visible, /连接超时/)
  assert.match(visible, /最近成功/)
  assert.match(visible, /默认只保存在本机/)
  assert.doesNotMatch(visible, /[$¥]/)
  assert.match(visible, /可能混合币种/)
  assert.equal(nodes(tree).find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === false).props.checked, false)
  card.unmount()
})

test('Token ledger card saves opt-in settings without a key, validates interval and prevents duplicate sync clicks', async () => {
  const f = await webviewFixture(), card = f.runner(f.TokenLedgerPanel)
  card.render(); f.deliver(ledgerSnapshotMessage(f.sent.at(-1).requestId)); let tree = card.render()
  const checkboxes = nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')
  checkboxes[1].props.onChange({ target: { checked: true } })
  const intervalInput = nodes(tree).find(n => n.type === 'input' && n.props.inputMode === 'numeric')
  intervalInput.props.onChange({ target: { value: '0' } })
  tree = card.render(); button(tree, '保存账本设置').props.onClick(); tree = card.render()
  assert.match(text(tree), /正整数/)
  assert.equal(f.sent.length, 1)
  nodes(tree).find(n => n.type === 'input' && n.props.inputMode === 'numeric').props.onChange({ target: { value: '30' } })
  tree = card.render(); button(tree, '保存账本设置').props.onClick()
  assert.equal(f.sent.at(-1).type, 'saveTokenLedgerSettings')
  assert.equal(f.sent.at(-1).forum.autoSync, true)
  assert.equal(f.sent.at(-1).forum.intervalMinutes, 30)
  assert(!('apiKey' in f.sent.at(-1).forum))
  const requestId = f.sent.at(-1).requestId
  f.deliver(ledgerSnapshotMessage(requestId)); f.deliver({ type: 'tokenLedgerResult', requestId, ok: true, message: '已保存' })
  tree = card.render(); const sync = button(tree, '立即同步')
  sync.props.onClick(); sync.props.onClick()
  assert.equal(f.sent.filter(m => m.type === 'syncTokenLedger').length, 1)
  assert.equal(button(card.render(), '立即同步').props.disabled, true)
  card.unmount()
})

test('Token ledger card key buttons send only intents and outdated results cannot overwrite a new card', async () => {
  const f = await webviewFixture(), card = f.runner(f.TokenLedgerPanel)
  card.render(); const original = f.sent.at(-1).requestId
  f.deliver(ledgerSnapshotMessage(original)); let tree = card.render()
  button(tree, '设置同步密钥').props.onClick()
  assert.equal(f.sent.at(-1).type, 'setTokenLedgerKey')
  assert.deepEqual(Object.keys(f.sent.at(-1)).sort(), ['requestId', 'type'])
  const setting = f.sent.at(-1).requestId
  f.deliver({ type: 'tokenLedgerResult', requestId: setting, ok: true, cancelled: true, message: '已取消' })
  tree = card.render(); button(tree, '清除同步密钥').props.onClick()
  assert.equal(f.sent.at(-1).type, 'clearTokenLedgerKey')
  assert.deepEqual(Object.keys(f.sent.at(-1)).sort(), ['requestId', 'type'])
  card.unmount()
  const fresh = f.runner(f.TokenLedgerPanel); fresh.render(); const current = f.sent.at(-1).requestId
  assert.notEqual(current, original)
  f.deliver(ledgerSnapshotMessage(original)); assert(!text(fresh.render()).includes('12,450'))
  f.deliver(ledgerSnapshotMessage(current)); assert(text(fresh.render()).includes('12,450'))
  fresh.unmount()
})

test('Token ledger legacy API failure leaves the card retryable and never enables sync without a key', async () => {
  const f = await webviewFixture(), card = f.runner(f.TokenLedgerPanel)
  card.render(); let requestId = f.sent.at(-1).requestId
  f.deliver({ type: 'tokenLedgerResult', requestId, ok: false, unavailable: true, message: '当前内核暂不支持 Token 账本，请升级内核。' })
  let tree = card.render()
  assert.match(text(tree), /其他设置仍可正常使用/)
  assert.equal(button(tree, '刷新账本').props.disabled, false)
  button(tree, '刷新账本').props.onClick(); requestId = f.sent.at(-1).requestId
  f.deliver(ledgerSnapshotMessage(requestId, { settings: { ...ledgerFixtureSettings, forum: { ...ledgerFixtureSettings.forum, apiKeyConfigured: false } } }))
  tree = card.render(); assert.equal(button(tree, '立即同步').props.disabled, true)
  assert(!nodes(tree).some(n => n.type === 'input' && n.props.type === 'password'))
  card.unmount()
})

test('Token ledger host discards a password entered after the panel was closed', async () => {
  const messages: any[] = [], saves: any[] = []
  let resolvePrompt: any
  const { CockpitProvider } = await load('src/views/cockpit-provider.ts', { vscode: { window: { showInputBox: () => new Promise(resolve => { resolvePrompt = resolve }) } } })
  const provider = new CockpitProvider({}, async () => ({ setTokenLedgerSettings: async (patch: any) => { saves.push(patch) } }), '/fixture')
  provider.panel = { webview: { postMessage: (msg: any) => messages.push(msg) } }
  const operation = provider.onMessage({ type: 'setTokenLedgerKey', requestId: 55 })
  for (let n = 0; n < 20 && !resolvePrompt; n++) await tick()
  provider.panel = undefined
  resolvePrompt('fixture-ledger-input')
  await operation
  assert.equal(saves.length, 0)
  assert.equal(messages.length, 0)
})


test('Token ledger host allows only one in-flight upload and reads the receipt again afterwards', async () => {
  const f = await ledgerHostFixture()
  let release: any, pushes = 0
  f.client.syncTokenLedger = async () => { pushes++; return await new Promise(resolve => { release = resolve }) }
  const first = f.provider.onMessage({ type: 'syncTokenLedger', requestId: 101 })
  for (let n = 0; n < 20 && !release; n++) await tick()
  await f.provider.onMessage({ type: 'syncTokenLedger', requestId: 102 })
  assert.equal(pushes, 1)
  release({ ok: true, skipped: 'unchanged' }); await first
  assert(f.messages.some(msg => msg.requestId === 101 && msg.type === 'tokenLedger'))
  assert.match(f.messages.at(-1).message, /无新数据/)
})

test('Token ledger bridge drops unexpected response properties including keys in nested totals and day rows', async () => {
  const f = await ledgerHostFixture()
  const privateValue = 'fixture-never-in-webview'
  f.client.getTokenLedgerSettings = async () => ({ ...ledgerFixtureSettings, forum: { ...ledgerFixtureSettings.forum, apiKey: privateValue } })
  f.client.getTokenLedgerSummary = async () => ({ ...ledgerFixtureSummary, totals: { ...ledgerFixtureTotals, apiKey: privateValue }, days: [{ ...ledgerFixtureTotals, date: '2026-10-11', model: 'fixture-model', apiKey: privateValue }] })
  await f.provider.onMessage({ type: 'getTokenLedger', requestId: 103 })
  assert(!JSON.stringify(f.messages).includes(privateValue))
})

test('Token ledger user can turn auto sync off even when the effective key disappeared', async () => {
  const f = await webviewFixture(), card = f.runner(f.TokenLedgerPanel)
  card.render(); const requestId = f.sent.at(-1).requestId
  f.deliver(ledgerSnapshotMessage(requestId, { settings: { ...ledgerFixtureSettings, forum: { ...ledgerFixtureSettings.forum, apiKeyConfigured: false, autoSync: true } } }))
  const checks = nodes(card.render()).filter(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(checks[1].props.disabled, false)
  checks[1].props.onChange({ target: { checked: false } })
  assert.equal(nodes(card.render()).filter(n => n.type === 'input' && n.props.type === 'checkbox')[1].props.checked, false)
  card.unmount()
})

test('Token ledger HTTP client uses authorized local endpoints and never sends a key on reads or ordinary settings', async () => {
  const requests: any[] = []
  const { SidecarClient } = await load('src/sidecar/client.ts', {}, { fetch: async (url: string, init: any) => { requests.push({ url, ...init }); return { ok: true, json: async () => ledgerFixtureSettings } } })
  const client = new SidecarClient('http://127.0.0.1:9000', 'fixture-sidecar-auth')
  await client.getTokenLedgerSummary(30); await client.getTokenLedgerStatus(); await client.getTokenLedgerSettings()
  await client.setTokenLedgerSettings({ forum: { autoSync: true, intervalMinutes: 30 } })
  await client.syncTokenLedger()
  assert.deepEqual(requests.map(r => [r.method, new URL(r.url).pathname]), [
    ['GET', '/token-ledger/summary'], ['GET', '/token-ledger/status'], ['GET', '/token-ledger/settings'], ['PUT', '/token-ledger/settings'], ['POST', '/token-ledger/sync'],
  ])
  assert.equal(new URL(requests[0].url).searchParams.get('days'), '30')
  assert(requests.every(r => r.headers.authorization === 'Bearer fixture-sidecar-auth'))
  assert(requests.slice(0, 3).every(r => r.body === undefined))
  assert(!requests[3].body.includes('apiKey'))
})


test('Token ledger settings reject insecure remote endpoints and sync intervals beyond one day before saving', async () => {
  const f = await webviewFixture(), card = f.runner(f.TokenLedgerPanel)
  card.render(); f.deliver(ledgerSnapshotMessage(f.sent.at(-1).requestId)); let tree = card.render()
  const input = nodes(tree).find(n => n.type === 'input' && n.props.value === ledgerFixtureSettings.forum.endpoint)
  input.props.onChange({ target: { value: 'http://remote.example.com/token-usage' } })
  tree = card.render(); button(tree, '保存账本设置').props.onClick()
  assert.equal(f.sent.length, 1)
  tree = card.render()
  nodes(tree).find(n => n.type === 'input' && n.props.value === 'http://remote.example.com/token-usage').props.onChange({ target: { value: ledgerFixtureSettings.forum.endpoint } })
  nodes(tree).find(n => n.type === 'input' && n.props.inputMode === 'numeric').props.onChange({ target: { value: '1441' } })
  tree = card.render(); button(tree, '保存账本设置').props.onClick()
  assert.equal(f.sent.length, 1)
  card.unmount()
})
