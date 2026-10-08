import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { spawn as spawnProcess } from 'node:child_process'
import { transformSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('Node CLI source entries use the current runtime and preserve arguments on every platform', () => {
  const { resolveCliCommand } = load('src/sidecar/cli-command.ts')
  const args = ['serve', '--port', '1234', '中文 & path']
  for (const name of ['main.js', 'entry.mjs', 'entry.cjs']) {
    const entry = join('源码 路径', name)
    const command = resolveCliCommand(entry, args, process.cwd())
    assert.equal(command.command, process.execPath)
    assert.deepEqual(Array.from(command.args), [resolve(entry), ...args])
  }
})

// The extension host API is unavailable in Node; keep the production modules real.
function load(relative: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const cache = new Map<string, { exports: any }>()
  function visit(filename: string): any {
    if (cache.has(filename)) return cache.get(filename)!.exports
    const module = { exports: {} as any }
    cache.set(filename, module)
    const code = transformSync(readFileSync(filename, 'utf8'), {
      loader: filename.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'node18', jsx: 'automatic',
    }).code
    vm.runInNewContext(code, {
      module, exports: module.exports,
      require(id: string) {
        if (id in mocks) return mocks[id]
        if (!id.startsWith('.')) return require(id)
        const stem = resolve(dirname(filename), id.replace(/\.js$/, '.ts'))
        return visit(existsSync(stem) ? stem : stem.replace(/\.ts$/, '.tsx'))
      },
      process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
      fetch, AbortController, AbortSignal, TextDecoder, TextEncoder, ...globals,
    }, { filename })
    return module.exports
  }
  return visit(resolve(root, relative))
}

function event(seq: number, text: string) {
  return { seq, ts: seq, type: 'text_delta', data: { text } }
}

const npmCmdShim = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\tianshu-harness\\dist\\cli\\entry.js" %*', '',
].join('\r\n')

for (const code of [0, 1, undefined]) {
  test(`terminal delegation uses matching end event exit ${code}`, async () => {
    const listeners = new Set<(e: any) => void>()
    const answers: any[] = []
    const execution = { commandLine: { value: 'false', confidence: 2, isTrusted: true }, cwd: undefined,
      async *read() { yield 'command output' } }
    const shellIntegration = { cwd: { fsPath: root }, executeCommand: () => execution }
    const terminal = { exitStatus: undefined, shellIntegration, show() {} }
    const { DelegationExecutor } = load('src/delegation/executor.ts', {
      vscode: { window: {
        onDidEndTerminalShellExecution(cb: (e: any) => void) {
          listeners.add(cb); return { dispose: () => listeners.delete(cb) }
        },
        onDidCloseTerminal: () => ({ dispose() {} }),
      } },
      './diff-decorations.js': { DiffDecorationController: class {} },
      './codelens.js': { DelegateCodeLensProvider: class {} },
    })
    const executor = new DelegationExecutor(async () => undefined, root)
    Object.assign(executor, { hasShellIntegration: true, sessionId: 'A', terminal, terminalCwd: root,
      client: { answerDelegation: async (_id: string, _request: string, answer: unknown) => answers.push(answer) } })
    const done = executor.onEvent({ type: 'tool_delegate', data: { requestId: 'request', kind: 'terminal_exec', payload: { command: 'false' } } })
    await tick()
    assert.equal(answers.length, 0, 'must wait for shell completion, not infer success from a drained reader')
    for (const cb of listeners) cb({ terminal, shellIntegration, execution: {}, exitCode: 0 })
    await tick()
    assert.equal(answers.length, 0, 'unrelated command must not settle this command')
    for (const cb of listeners) cb({ terminal, shellIntegration, execution, exitCode: code })
    await done
    assert.equal(answers[0].isError, code !== 0)
    assert.match(answers[0].content, code === undefined ? /unknown/i : /command output/)
    assert.equal(listeners.size, 0)
  })
}

function delegationFixture(edit = false) {
  const answers: any[] = [], executed: string[] = [], pending: any[] = []
  const changes = new Set<(event: any) => void>(), ends = new Set<(event: any) => void>()
  let documentReady!: (doc: any) => void, applied = 0
  const document = new Promise((resolve) => { documentReady = resolve })
  const execution = { async *read() { yield 'origin output' } }
  const shellIntegration = { cwd: { fsPath: root }, executeCommand(command: string) { executed.push(command); return execution } }
  const terminal = { exitStatus: undefined, show() {} }
  const { DelegationExecutor } = load('src/delegation/executor.ts', {
    vscode: {
      Uri: { file: (path: string) => ({ fsPath: path }) }, WorkspaceEdit: class { createFile() {} replace() {} }, Range: class {},
      workspace: { fs: { stat: async () => ({}) }, openTextDocument: () => document,
        applyEdit: async () => { applied++; return true } },
      window: { showInformationMessage() {},
        onDidChangeTerminalShellIntegration(cb: any) { changes.add(cb); return { dispose: () => changes.delete(cb) } },
        onDidEndTerminalShellExecution(cb: any) { ends.add(cb); return { dispose: () => ends.delete(cb) } },
        onDidCloseTerminal: () => ({ dispose() {} }),
      },
    },
    './diff-decorations.js': { computeLineRanges: () => ({ added: [], removed: [] }),
      DiffDecorationController: class { clear() {} async show(value: any) { pending.push(value) } } },
    './codelens.js': { DelegateCodeLensProvider: class { refresh() {} } },
  })
  const client = (name: string) => ({ answerDelegation: async (sessionId: string, requestId: string, answer: any) => answers.push({ name, sessionId, requestId, answer }) })
  const a = client('A'), b = client('B')
  const executor = new DelegationExecutor(async () => a, root)
  Object.assign(executor, { hasShellIntegration: true, terminal, terminalCwd: root, client: a, sessionId: 'A' })
  return { executor, a, b, answers, executed, pending, execution, applied: () => applied,
    switchSession(id: string) { executor.detach(); Object.assign(executor, { client: id === 'A' ? a : b, sessionId: id }) },
    ready() { for (const cb of changes) cb({ terminal, shellIntegration }) },
    end() { for (const cb of ends) cb({ execution, exitCode: 0 }) },
    openDocument() { documentReady({ positionAt: (i: number) => i, getText: () => 'old' }) },
    request() { return executor.onEvent({ type: 'tool_delegate', data: { requestId: edit ? 'edit-A' : 'request-A', kind: edit ? 'apply_edit' : 'terminal_exec',
      payload: edit ? { path: 'fixture.txt', oldContent: 'old', newContent: 'new' } : { command: 'old-command' } } }) },
  }
}

for (const destination of ['B', 'A']) {
  test(`terminal awaiting Shell Integration cannot execute after A -> B -> ${destination}`, async () => {
    const f = delegationFixture()
    const done = f.request()
    await tick()
    f.switchSession('B')
    if (destination === 'A') f.switchSession('A')
    f.ready()
    await tick()
    f.end()
    await done
    assert.deepEqual(f.executed, [])
    assert.equal(f.answers.length, 1)
    assert.equal(f.answers[0].name, 'A')
    assert.equal(f.answers[0].sessionId, 'A')
    assert.equal(f.answers[0].answer.isError, true)
  })
}

test('already executing terminal answers its original session after switching', async () => {
  const f = delegationFixture()
  const done = f.request()
  f.ready()
  await tick()
  f.switchSession('B')
  f.end()
  await done
  assert.deepEqual(f.executed, ['old-command'])
  assert.equal(f.answers[0].name, 'A')
  assert.equal(f.answers[0].sessionId, 'A')
  assert.equal(f.answers[0].answer.isError, false)
})

test('edit awaiting document does not land or answer in the replacement session', async () => {
  const f = delegationFixture(true)
  const done = f.request()
  await tick()
  f.switchSession('B')
  f.openDocument()
  await tick()
  // Settle the old implementation's incorrectly recreated waiter so RED cannot hang.
  f.executor.pendingDecisions.get('edit-A')?.resolve('ok')
  await done
  assert.equal(f.applied(), 0)
  assert.equal(f.pending.length, 0)
  assert.equal(f.answers[0].name, 'A')
  assert.equal(f.answers[0].answer.isError, true)
})

test('landed edit is accepted on detach and answers its original session', async () => {
  const f = delegationFixture(true)
  const done = f.request()
  f.openDocument()
  await tick()
  assert.equal(f.pending[0].sessionId, 'A')
  f.switchSession('B')
  await done
  assert.equal(f.applied(), 1)
  assert.equal(f.answers[0].name, 'A')
  assert.equal(f.answers[0].sessionId, 'A')
  assert.equal(f.answers[0].answer.status, 'ok')
})

test('delayed attach A cannot overwrite the new A subscription after A -> B -> A', async () => {
  let resolveOld!: (client: any) => void
  const old = new Promise((resolve) => { resolveOld = resolve })
  const subscriptions: any[] = [], answers: any[] = []
  const client = { probeProtocolVersion: async () => 1, registerDelegateCapabilities: async () => {}, getSession: async () => ({ lastSeq: 0 }),
    subscribe: (sessionId: string, _since: number, callback: any) => { subscriptions.push({ sessionId, callback }); return () => {} },
    answerDelegation: async (sessionId: string) => answers.push(sessionId) }
  let calls = 0
  const { DelegationExecutor } = load('src/delegation/executor.ts', {
    vscode: {}, './diff-decorations.js': { DiffDecorationController: class { clear() {} } },
    './codelens.js': { DelegateCodeLensProvider: class { refresh() {} } },
  }, { setInterval: () => 1, clearInterval() {} })
  const executor = new DelegationExecutor(() => ++calls === 1 ? old : Promise.resolve(client), root)
  executor.detectShellIntegration = async () => false
  try {
    const attachOld = executor.attachSession('A')
    await executor.attachSession('B')
    await executor.attachSession('A')
    resolveOld(client)
    await attachOld
    assert.deepEqual(subscriptions.map((s) => s.sessionId), ['B', 'A'])
    subscriptions[0].callback({ type: 'tool_delegate', data: { requestId: 'obsolete-B', kind: 'apply_edit', payload: { path: '../bad' } } })
    await tick()
    assert.deepEqual(answers, [])
  } finally { executor.detach() }
})

test('detached edit decoration does not reopen the old document after its delayed load', async () => {
  let ready!: (doc: any) => void, shown = 0
  const document = new Promise((resolve) => { ready = resolve })
  const { DiffDecorationController } = load('src/delegation/diff-decorations.ts', {
    vscode: { window: { createTextEditorDecorationType: () => ({ dispose() {} }), visibleTextEditors: [],
      showTextDocument: async () => { shown++; return { setDecorations() {} } } },
      workspace: { openTextDocument: () => document }, ThemeColor: class {}, OverviewRulerLane: { Left: 1 } },
  })
  const decorations = new DiffDecorationController()
  const showing = decorations.show({ uri: { fsPath: 'fixture.txt' }, added: [], removed: [] })
  decorations.clear()
  ready({})
  await showing
  assert.equal(shown, 0)
  assert.equal(decorations.list().length, 0)
})

test('SSE cancellation aborts the active reader and rejects a delayed old frame', async () => {
  let deliver!: (value: any) => void
  let signal: AbortSignal | undefined
  let cancelled = 0
  let released = 0
  const received: unknown[] = []
  const states: boolean[] = []
  const body = { getReader: () => ({
    read: () => new Promise((resolve) => { deliver = resolve }),
    cancel: async () => { cancelled++ }, releaseLock: () => { released++ },
  }) }
  const { SidecarClient } = load('src/sidecar/client.ts', {}, {
    fetch: async (_url: string, init: RequestInit) => { signal = init.signal!; return { ok: true, body } },
  })
  const off = new SidecarClient('http://fixture', 'fixture-auth').subscribe('A', 0,
    (ev: unknown) => received.push(ev), (live: boolean) => states.push(live))
  await tick()
  off()
  deliver({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(event(100, 'old A'))}\n\n`) })
  await tick()
  assert.deepEqual(received, [])
  assert.equal(signal?.aborted, true)
  assert.equal(cancelled, 1)
  assert.equal(released, 1)
  assert.deepEqual(states, [true])
})

test('SSE cancellation while fetch is pending suppresses ready state and frames', async () => {
  let resolveFetch!: (response: any) => void
  let signal: AbortSignal | undefined
  let closed = 0
  const states: boolean[] = []
  const received: unknown[] = []
  const { SidecarClient } = load('src/sidecar/client.ts', {}, {
    fetch: (_url: string, init: RequestInit) => {
      signal = init.signal!; return new Promise((resolve) => { resolveFetch = resolve })
    },
  })
  const off = new SidecarClient('http://fixture', 'fixture-auth').subscribe('A', 0,
    (ev: unknown) => received.push(ev), (live: boolean) => states.push(live))
  off()
  resolveFetch({ ok: true, body: { cancel: async () => { closed++ }, getReader() { throw new Error('must not read') } } })
  await tick()
  assert.equal(signal?.aborted, true)
  assert.equal(closed, 1)
  assert.deepEqual(received, [])
  assert.deepEqual(states, [])
})

test('SSE cancellation closes a real localhost transport without reconnecting', async () => {
  let requests = 0
  let notifyClosed!: () => void
  const closed = new Promise<void>((resolve) => { notifyClosed = resolve })
  const server = createServer((_req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(event(1, 'current'))}\n\n`)
    res.on('close', notifyClosed)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const { SidecarClient } = load('src/sidecar/client.ts')
  let off = () => {}
  try {
    await new Promise<void>((resolve) => {
      off = new SidecarClient(`http://127.0.0.1:${address.port}`, 'fixture-auth').subscribe('A', 0, () => resolve())
    })
    off()
    await closed
    assert.equal(requests, 1)
  } finally {
    off()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('cockpit A→B→A rejects callbacks owned by both previous subscriptions', async () => {
  const subscriptions: any[] = []
  const messages: any[] = []
  const activities: any[] = []
  const handled: any[] = []
  const client = { subscribe: (id: string, _since: number, onEvent: unknown, onState: unknown) => {
    subscriptions.push({ id, onEvent, onState }); return () => {}
  }, listRewindPoints: async () => ({ points: [] }) }
  const { CockpitProvider } = load('src/views/cockpit-provider.ts', { vscode: {} })
  const provider = new CockpitProvider({}, async () => client, root)
  Object.assign(provider, { client, panel: { webview: { postMessage: (msg: unknown) => messages.push(msg) } },
    onSessionEvent: (ev: unknown) => handled.push(ev),
    onSessionActivity: (kind: string, id: string) => activities.push([kind, id]) })
  provider.attachSession('A'); provider.attachSession('B'); provider.attachSession('A')
  await tick()
  messages.length = 0; activities.length = 0
  subscriptions[0].onEvent(event(100, 'old A')); subscriptions[0].onState(false)
  subscriptions[1].onEvent(event(100, 'old B')); subscriptions[1].onState(false)
  subscriptions[2].onEvent(event(1, 'current A')); subscriptions[2].onState(true)
  assert.deepEqual(messages.map((m) => [m.type, m.sessionId]), [['event', 'A'], ['streamState', 'A']])
  assert.equal(handled.length, 1)
  provider.closeActive()
  messages.length = 0
  subscriptions[2].onEvent(event(2, 'closed A'))
  assert.deepEqual(messages, [])
})

for (const transition of ['A-B-A', 'same-session']) {
  for (const outcome of ['success', 'failure']) {
    test(`rewind lists discard ${outcome} from an older ${transition} request`, async () => {
      const messages: any[] = []
      const pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = []
      const client = { subscribe: () => () => {}, listRewindPoints: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }
      const { CockpitProvider } = load('src/views/cockpit-provider.ts', { vscode: {} })
      const provider = new CockpitProvider({}, async () => client, root)
      Object.assign(provider, { client, activeSessionId: 'A', panel: { webview: { postMessage: (msg: unknown) => messages.push(msg) } } })
      if (transition === 'A-B-A') {
        provider.attachSession('A'); provider.attachSession('B'); provider.attachSession('A')
        pending[1]!.resolve({ points: [{ label: 'retired B' }] })
      } else {
        void provider.pushRewindPoints(client, 'A'); void provider.pushRewindPoints(client, 'A')
      }
      pending.at(-1)!.resolve({ points: [{ label: 'fresh A' }] })
      await tick()
      if (outcome === 'success') pending[0]!.resolve({ points: [{ label: 'stale A' }] })
      else pending[0]!.reject(new Error('retired request failed'))
      await tick()
      assert.deepEqual(messages.filter((m) => m.type === 'rewindPoints').map((m) => [m.sessionId, m.points[0]?.label]), [['A', 'fresh A']])
    })
  }
}

test('rewind list awaiting the client cannot restart an obsolete A request after A-B-A', async () => {
  const requested: string[] = []
  let release!: (client: unknown) => void
  const clientReady = new Promise((resolve) => { release = resolve })
  const client = { subscribe: () => () => {}, listRewindPoints: async (id: string) => { requested.push(id); return { points: [] } } }
  const { CockpitProvider } = load('src/views/cockpit-provider.ts', { vscode: {} })
  const provider = new CockpitProvider({}, () => clientReady, root)
  Object.assign(provider, { client, activeSessionId: 'A' })
  const firstA = provider.onMessage({ type: 'listRewindPoints', sessionId: 'A' })
  provider.attachSession('B'); provider.attachSession('A')
  await tick()
  release(client)
  await firstA
  assert.deepEqual(requested, ['B', 'A'])
})

test('rewind refresh after a delayed operation cannot overwrite a reattached session', async () => {
  const requested: string[] = []
  let release!: () => void
  const operation = new Promise<void>((resolve) => { release = resolve })
  const client = { subscribe: () => () => {}, rewind: () => operation,
    listRewindPoints: async (id: string) => { requested.push(id); return { points: [] } } }
  const { CockpitProvider } = load('src/views/cockpit-provider.ts', { vscode: {} })
  const provider = new CockpitProvider({}, async () => client, root)
  Object.assign(provider, { client, activeSessionId: 'A' })
  const firstA = provider.onMessage({ type: 'rewind', sessionId: 'A', messageIndex: 1 })
  await tick()
  provider.attachSession('B'); provider.attachSession('A')
  await tick()
  release()
  await firstA
  assert.deepEqual(requested, ['B', 'A'])
})

test('current rewind list failure still clears the current list', async () => {
  const messages: any[] = []
  const client = { listRewindPoints: async () => { throw new Error('current failure') } }
  const { CockpitProvider } = load('src/views/cockpit-provider.ts', { vscode: {} })
  const provider = new CockpitProvider({}, async () => client, root)
  Object.assign(provider, { client, activeSessionId: 'A', panel: { webview: { postMessage: (msg: unknown) => messages.push(msg) } } })
  await provider.pushRewindPoints(client, 'A')
  assert.deepEqual(messages.map((m) => [m.type, m.sessionId, m.points.length]), [['rewindPoints', 'A', 0]])
})

for (const outcome of ['success', 'failure']) {
  test(`a retired client rewind cannot invalidate the current client's ${outcome} response`, async () => {
    const messages: any[] = []
    let releaseRewind!: () => void
    let resolveList!: (result: unknown) => void
    let rejectList!: (error: Error) => void
    let oldLists = 0
    const operation = new Promise<void>((resolve) => { releaseRewind = resolve })
    const oldClient = { rewind: () => operation, listRewindPoints: async () => { oldLists++; return { points: [] } } }
    const currentClient = { subscribe: () => () => {}, listRewindPoints: () => new Promise((resolve, reject) => { resolveList = resolve; rejectList = reject }) }
    let selectedClient: unknown = oldClient
    const { CockpitProvider } = load('src/views/cockpit-provider.ts', { vscode: {} })
    const provider = new CockpitProvider({}, async () => selectedClient, root)
    Object.assign(provider, { client: oldClient, activeSessionId: 'A', panel: { webview: { postMessage: (msg: unknown) => messages.push(msg) } } })
    const oldRewind = provider.onMessage({ type: 'rewind', sessionId: 'A', messageIndex: 1 })
    await tick()
    selectedClient = currentClient
    const currentList = provider.onMessage({ type: 'listRewindPoints', sessionId: 'A' })
    await tick()
    releaseRewind()
    await oldRewind
    if (outcome === 'success') resolveList({ points: [{ label: 'current client' }] })
    else rejectList(new Error('current failure'))
    await currentList
    assert.deepEqual(messages.filter(m => m.type === 'rewindPoints').map((m) => [m.type, m.sessionId, m.points[0]?.label]), [['rewindPoints', 'A', outcome === 'success' ? 'current client' : undefined]])
    assert.equal(oldLists, 0)
  })
}

test('closing history ownership invalidates rewind responses even when the session id remains', async () => {
  const messages: any[] = []
  let release!: (result: unknown) => void
  const client = { listRewindPoints: () => new Promise((resolve) => { release = resolve }) }
  const { CockpitProvider } = load('src/views/cockpit-provider.ts', { vscode: {} })
  const provider = new CockpitProvider({}, async () => client, root)
  Object.assign(provider, { client, activeSessionId: 'A', panel: { webview: { postMessage: (msg: unknown) => messages.push(msg) } } })
  const loading = provider.pushRewindPoints(client, 'A')
  provider.teardownBridge()
  release({ points: [{ label: 'closed A' }] })
  await loading
  assert.deepEqual(messages, [])
})

test('webview rejects old session events even before React renders the new active id', () => {
  let listener!: (msg: any) => void
  let chat: any
  const effects: Array<() => void> = []
  const sends: any[] = []
  const { App } = load('webview-ui/src/App.tsx', {
    react: {
      useState: (initial: any) => [initial, () => {}], useRef: (current: any) => ({ current }),
      useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
      useReducer: (reduce: any, initial: any) => { chat = initial; return [chat, (a: unknown) => { chat = reduce(chat, a) }] },
      useEffect: (fn: () => void) => { effects.push(fn) },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) },
    './bridge.js': { send: (msg: unknown) => sends.push(msg), onHostMessage: (cb: any) => { listener = cb; return () => {} } },
    './markdown.js': { renderMarkdown: () => '' },
  })
  const ui = App(); effects[0]!()
  listener({ type: 'sessionAttached', sessionId: 'A' })
  listener({ type: 'sessionAttached', sessionId: 'B' })
  listener({ type: 'event', sessionId: 'A', event: event(100, 'old A') })
  listener({ type: 'event', sessionId: 'B', event: event(1, 'current B') })
  assert.deepEqual(JSON.parse(JSON.stringify(chat.items)), [{ kind: 'assistant', text: 'current B' }])
  sends.length = 0
  listener({ type: 'event', sessionId: 'A', event: { ...event(101, ''), type: 'turn_complete' } })
  assert.deepEqual(sends, [])
  ui.props.children[0].props.onNew()
  listener({ type: 'event', sessionId: 'B', event: event(2, 'previous B') })
  assert.deepEqual(JSON.parse(JSON.stringify(chat.items)), [])
  listener({ type: 'sessionAttached', sessionId: 'B' })
  listener({ type: 'sessionClosed' })
  listener({ type: 'event', sessionId: 'B', event: event(2, 'closed B') })
  assert.deepEqual(JSON.parse(JSON.stringify(chat.items)), [])
})

function extensionFixture(opts: { runtime?: string; delayedHealth?: boolean; delayedRuntimeFailure?: boolean; realPort?: number; realShim?: string; failTaskkill?: boolean; noStorageUri?: boolean } = {}) {
  const commands = new Map<string, () => Promise<void>>()
  const states: string[] = []
  const children: any[] = []
  const launchedPaths: string[] = []
  // 每次 sidecar spawn 的 env 快照（P0-3：断言 RIVET_DESKTOP_DIR 确实传给了子进程）。
  const spawnEnvs: Array<Record<string, string | undefined>> = []
  const logs: string[] = []
  const nodePids: number[] = []
  const workerPids: number[] = []
  let listening!: () => void
  const firstListening = new Promise<void>((resolve) => { listening = resolve })
  let runtimeResolutions = 0
  let resolveHealth!: (res: any) => void
  let rejectRuntime!: (error: Error) => void
  let getCliPath!: () => Promise<string>
  let getClient!: () => Promise<unknown>
  const childApi = { spawn: (cli: string, args: string[], options: any) => {
    if (/taskkill(?:\.exe)?$/i.test(cli)) {
      if (opts.failTaskkill) {
        const killer = new EventEmitter()
        queueMicrotask(() => killer.emit('close', 1))
        return killer
      }
      return spawnProcess(cli, args, { ...options, windowsHide: true })
    }
    launchedPaths.push(cli)
    spawnEnvs.push(options.env ?? {})
    if (opts.realPort) {
      const toy = 'const http=require("node:http");const s=http.createServer((q,r)=>{if(q.headers.authorization!=="Bearer "+process.env.RIVET_SERVER_TOKEN){r.writeHead(401);r.end();return}setTimeout(()=>r.end("ok"),Number(process.env.FIXTURE_DELAY))});s.on("error",e=>{console.error(e.code);process.exit(1)});s.listen(Number(process.argv[1]),"127.0.0.1",()=>console.log("LISTENING"))'
      const child = spawnProcess(opts.realShim ? cli : process.execPath, opts.realShim ? args : ['-e', toy, args[2]!], {
        ...(opts.realShim ? options : {}),
        cwd: root, env: { ...options.env, FIXTURE_DELAY: children.length === 0 ? '1000' : '0' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      child.stdout.on('data', (chunk) => {
        const pid = String(chunk).match(/NODE_PID=(\d+)/)
        if (pid) nodePids.push(Number(pid[1]))
        const worker = String(chunk).match(/WORKER_PID=(\d+)/)
        if (worker) workerPids.push(Number(worker[1]))
        if (children.length === 1 && String(chunk).includes('LISTENING')) listening()
      })
      children.push(child)
      return child
    }
    const child: any = new EventEmitter()
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
      kill: () => { queueMicrotask(() => child.emit('exit', 0)); return true } })
    children.push(child); return child
  } }
  const launcher = load('src/sidecar/launcher.ts', { 'node:child_process': childApi }, {
    fetch: opts.realPort ? fetch : async () => {
      if (opts.delayedHealth && children.length === 1) return new Promise((resolve) => { resolveHealth = resolve })
      return { ok: true }
    },
  })
  const extension = load('src/extension.ts', {
    vscode: {
      EventEmitter: class { event() { return { dispose() {} } } fire() {} },
      lm: { registerLanguageModelChatProvider: () => ({ dispose() {} }) },
      window: { createOutputChannel: () => ({ appendLine: (line: string) => logs.push(line) }), showInformationMessage: async () => {}, showErrorMessage: async (message: string) => logs.push(message) },
      workspace: { workspaceFolders: [{ uri: { fsPath: root } }], getConfiguration: () => ({ get: (key: string) => key === 'serverPort' ? opts.realPort ?? 12345 : key === 'cliPath' ? opts.realShim : undefined }) },
      commands: { registerCommand: (key: string, cb: any) => { commands.set(key, cb); return { dispose() {} } } },
    },
    './sidecar/launcher.js': launcher, './sidecar/client.js': { SidecarClient: class {} },
    './views/cockpit-provider.js': { CockpitProvider: class {
      constructor(_uri: unknown, get: any) { getClient = get }
      replaceClient() {}
      notifySidecarState(state: string) { states.push(state) }
    } },
    './views/changes-view.js': { registerChangesView: () => ({}) }, './views/launcher-view.js': { registerLauncherView() {} },
    './delegation/executor.js': { DelegationExecutor: class { register() {} detach() {} } },
    './views/status-bar.js': { StatusBarController: class { setSidecarState() {} } },
    './scm/commit-message.js': { registerCommitMessageCommand(_context: unknown, resolve: any) { getCliPath = resolve } },
    './scm/source-control.js': { TianshuSourceControl: class {} },
    './chat/human-interaction.js': { ChatHumanInteraction: class {} },
    './chat/participant.js': { TianshuChatParticipant: class {} },
    './sidecar/runtime-downloader.js': {
      rivetOnPath: async () => !opts.runtime,
      ensureRuntime: async () => {
        runtimeResolutions++
        if (opts.delayedRuntimeFailure && runtimeResolutions === 1) return new Promise((_resolve, reject) => { rejectRuntime = reject })
        return opts.runtime
      },
    },
  })
  extension.activate({
    globalStorageUri: { fsPath: 'fixture-storage' },
    storageUri: opts.noStorageUri ? undefined : { fsPath: 'fixture-storage/ws' },
    extensionUri: {}, subscriptions: [],
  })
  return { extension, commands, states, children, launchedPaths, logs, spawnEnvs, nodePids, workerPids, firstListening, getClient: () => getClient(),
    getCliPath: () => getCliPath(), runtimeResolutions: () => runtimeResolutions,
    resolveHealth: () => resolveHealth({ ok: true }), rejectRuntime: () => rejectRuntime(new Error('obsolete resolution failed')) }
}

test('manual restart does not suppress the replacement sidecar crash', async () => {
  const fixture = extensionFixture()
  try {
    await fixture.getClient()
    await fixture.commands.get('tianshu.restartSidecar')!()
    fixture.children[1].exitCode = 1
    fixture.children[1].emit('exit', 1)
    assert.equal(fixture.states.at(-1), 'starting')
  } finally { fixture.extension.deactivate() }
})

function windowsRuntimeFixture(spaces: boolean) {
  const artifacts = process.env.RIVET_TEST_ARTIFACT_DIR || tmpdir()
  mkdirSync(artifacts, { recursive: true })
  const dir = mkdtempSync(join(artifacts, spaces ? 'cmd-中文 space-' : 'cmd-runtime-'))
  const shim = join(dir, 'rivet.cmd')
  const entry = join(dir, 'entry.mjs')
  const argv = join(dir, 'argv.json')
  writeFileSync(entry, `import http from 'node:http';import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';const args=process.argv.slice(2);if(args[0]==='-p'){writeFileSync(new URL('argv.json',import.meta.url),JSON.stringify(args));console.log(JSON.stringify({success:true,text:args[1]}))}else{const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});const s=http.createServer((q,r)=>{if(q.headers.authorization!=='Bearer '+process.env.RIVET_SERVER_TOKEN){r.writeHead(401);r.end();return}setTimeout(()=>r.end('ok'),Number(process.env.FIXTURE_DELAY||0))});s.on('error',e=>{console.error(e.code);worker.kill();process.exit(1)});s.listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1',()=>console.log('LISTENING NODE_PID='+process.pid+' WORKER_PID='+worker.pid))}`)
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
  return { dir, shim, argv, cleanup() {
    if (!process.env.RIVET_TEST_ARTIFACT_DIR) {
      for (const file of [shim, entry, argv]) rmSync(file, { force: true })
      rmdirSync(dir)
    }
  } }
}

test('Windows cmd shim restart reaps its Node process before reusing a fixed port', { skip: process.platform !== 'win32' }, async () => {
  const files = windowsRuntimeFixture(false)
  const portServer = createServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const fixture = extensionFixture({ realPort: address.port, realShim: files.shim })
  try {
    const cancelled = assert.rejects(fixture.getClient(), /启动已取消/)
    await fixture.firstListening
    await fixture.commands.get('tianshu.restartSidecar')!()
    await cancelled
    assert.equal(fixture.states.at(-1), 'ready')
    assert.deepEqual(fixture.logs.filter((line) => /EADDRINUSE|重启失败/.test(line)), [])
    assert.equal(fixture.nodePids.length, 2)
    assert.equal(fixture.workerPids.length, 2)
    assert.throws(() => process.kill(fixture.nodePids[0]!, 0))
    assert.throws(() => process.kill(fixture.workerPids[0]!, 0))
  } finally {
    await fixture.extension.deactivate()
    for (const pid of [...fixture.nodePids, ...fixture.workerPids]) { try { process.kill(pid) } catch {} }
    for (const child of fixture.children) child.kill()
    files.cleanup()
  }
})

test('Windows runtime dp0 shim resolves bundled Node and preserves literal argv', () => {
  const shim = 'C:\\中文 space\\bin\\rivet.cmd'
  const node = 'C:\\中文 space\\node\\node.exe'
  const entry = 'C:\\中文 space\\dist\\cli\\entry.js'
  const { resolveCliCommand } = load('src/sidecar/cli-command.ts', {
    'node:path': win32,
    'node:fs': {
      existsSync: (file: string) => [node, entry].includes(file),
      readFileSync: () => '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\dist\\cli\\entry.js" %*\r\n',
    },
  }, { process: { platform: 'win32', env: { PATH: '' } } })
  const result = resolveCliCommand(shim, ['-p', '"quoted" & echo\n%PATH%', '--json'], 'C:\\work')
  assert.equal(result.command, node)
  assert.deepEqual(JSON.parse(JSON.stringify(result.args)), [entry, '-p', '"quoted" & echo\n%PATH%', '--json'])
})

test('Windows npm rivet cmd wins over npm POSIX shim and resolves its Node entry', () => {
  const shim = 'C:\\npm\\rivet.cmd'
  const node = 'C:\\node\\node.exe'
  const entry = 'C:\\npm\\node_modules\\tianshu-harness\\dist\\cli\\entry.js'
  const { resolveCliCommand } = load('src/sidecar/cli-command.ts', {
    'node:path': win32,
    'node:fs': {
      existsSync: (file: string) => ['C:\\npm\\rivet', shim, node, entry].includes(file),
      readFileSync: () => npmCmdShim,
    },
  }, { process: { platform: 'win32', env: { PATH: 'C:\\npm;C:\\node' } } })
  const result = resolveCliCommand('rivet', ['serve', '--port', '1234'], 'C:\\work')
  assert.equal(result.command, node)
  assert.deepEqual(JSON.parse(JSON.stringify(result.args)), [entry, 'serve', '--port', '1234'])
})

test('unknown complex rivet cmd is rejected even beside an installed npm entry', () => {
  const { resolveCliCommand } = load('src/sidecar/cli-command.ts', {
    'node:path': win32,
    'node:fs': { existsSync: () => true, readFileSync: () => '@echo off\r\nset CUSTOM_SETTING=required\r\necho custom wrapper\r\n' },
  }, { process: { platform: 'win32', env: { PATH: 'C:\\node' } } })
  assert.throws(() => resolveCliCommand('C:\\npm\\rivet.cmd', ['serve'], 'C:\\work'), /无法安全解析/)
})

test('Windows bare npm CLI launches with three shims and Electron-like execPath', { skip: process.platform !== 'win32' }, async () => {
  const files = windowsRuntimeFixture(true)
  const pkg = join(files.dir, 'node_modules', 'tianshu-harness')
  const entryDir = join(pkg, 'dist', 'cli')
  mkdirSync(entryDir, { recursive: true })
  const npmEntry = join(entryDir, 'entry.js')
  writeFileSync(npmEntry, readFileSync(join(files.dir, 'entry.mjs')))
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}')
  writeFileSync(join(files.dir, 'rivet'), '#!/bin/sh\nexec node script "$@"\n')
  writeFileSync(files.shim, npmCmdShim)
  writeFileSync(join(files.dir, 'rivet.ps1'), '# npm PowerShell shim fixture\r\n')
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: (cli: string, args: string[], opts: any) => spawnProcess(cli, args, { ...opts, windowsHide: true }) },
  }, { process: { ...process, execPath: 'C:\\editor\\Code.exe', env: { ...process.env, PATH: files.dir + ';' + dirname(process.execPath) + ';' + process.env.PATH } } })
  let handle: any
  try {
    handle = await launchSidecar({ cwd: files.dir, cliPath: 'rivet' })
    assert.equal((await fetch(handle.baseUrl + '/health', { headers: { authorization: 'Bearer ' + handle.token } })).ok, true)
  } finally {
    await handle?.dispose()
    if (!process.env.RIVET_TEST_ARTIFACT_DIR) {
      for (const file of [npmEntry, join(pkg, 'package.json'), join(files.dir, 'rivet'), join(files.dir, 'rivet.ps1')]) rmSync(file, { force: true })
      for (const dir of [entryDir, dirname(entryDir), pkg, dirname(pkg)]) rmdirSync(dir)
    }
    files.cleanup()
  }
})

test('taskkill failure during pending launch blocks replacement and presents dead state', { skip: process.platform !== 'win32' }, async () => {
  const portServer = createServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const fixture = extensionFixture({ realPort: address.port, failTaskkill: true })
  try {
    const failed = assert.rejects(fixture.getClient(), /进程树回收失败/)
    await fixture.firstListening
    await fixture.commands.get('tianshu.restartSidecar')!()
    await failed
    assert.equal(fixture.children.length, 1)
    assert.equal(fixture.states.at(-1), 'dead')
    assert.ok(fixture.logs.some((line) => /进程树回收失败/.test(line)))
  } finally {
    await fixture.extension.deactivate().catch(() => {})
    for (const child of fixture.children) child.kill()
  }
})

test('natural child exit racing taskkill is successful disposal', () => {
  const child: any = new EventEmitter()
  Object.assign(child, { pid: 2147483000, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} })
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: (cli: string) => {
      if (!/taskkill(?:\.exe)?$/i.test(cli)) return child
      const killer = new EventEmitter()
      queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); killer.emit('close', 128) })
      return killer
    } },
    'node:os': { platform: () => 'win32' },
  }, { fetch: async () => ({ ok: true }) })
  return launchSidecar({ cwd: root, cliPath: 'rivet.exe', port: 12345 }).then((handle: any) => handle.dispose())
})

test('Windows Chinese and space cmd paths serve and pass SCM metacharacters as argv', { skip: process.platform !== 'win32' }, async () => {
  const files = windowsRuntimeFixture(true)
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: (cli: string, args: string[], opts: any) => spawnProcess(cli, args, { ...opts, windowsHide: true }) },
  })
  let handle: any
  try {
    handle = await launchSidecar({ cwd: files.dir, cliPath: files.shim })
    assert.equal((await fetch(handle.baseUrl + '/health', { headers: { authorization: 'Bearer ' + handle.token } })).ok, true)
    await handle.dispose()
    let command!: () => Promise<void>
    const repo = { rootUri: { fsPath: files.dir }, inputBox: { value: '' } }
    const errors: string[] = []
    const diff = 'diff --git a/a b/a\n+中文 "quotes" & echo inert\n+%PATH% !literal! ^ (parentheses)'
    const { registerCommitMessageCommand } = load('src/scm/commit-message.ts', {
      vscode: {
        extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ repositories: [repo] }) } }) },
        commands: { registerCommand: (_key: string, cb: any) => { command = cb; return {} } },
        window: { showInformationMessage() {}, showErrorMessage: (msg: string) => errors.push(msg), withProgress: (_opts: unknown, cb: any) => cb() },
        ProgressLocation: { SourceControl: 1 },
      },
      'node:child_process': { spawn: (cli: string, args: string[], opts: any) => {
        if (cli !== 'git') return spawnProcess(cli, args, { ...opts, windowsHide: true })
        const child: any = new EventEmitter()
        child.stdout = new EventEmitter()
        queueMicrotask(() => { child.stdout.emit('data', Buffer.from(diff)); child.emit('close', 0) })
        return child
      } },
    })
    registerCommitMessageCommand({ subscriptions: [] }, async () => files.shim)
    await command()
    assert.deepEqual(errors, [])
    assert.ok(repo.inputBox.value.endsWith(diff))
    const argv = JSON.parse(readFileSync(files.argv, 'utf8'))
    assert.deepEqual([argv[0], argv.length, argv[2]], ['-p', 3, '--json'])
    assert.ok(argv[1].endsWith(diff))
  } finally { await handle?.dispose(); files.cleanup() }
})

test('restart cancels and reaps a pending real sidecar before reusing its fixed port', async () => {
  const portServer = createServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const fixture = extensionFixture({ realPort: address.port })
  try {
    const oldClient = fixture.getClient()
    const cancelled = assert.rejects(oldClient, /启动已取消/)
    await fixture.firstListening
    await fixture.commands.get('tianshu.restartSidecar')!()
    await cancelled
    assert.equal(fixture.states.at(-1), 'ready')
    assert.equal(fixture.children.length, 2)
    assert.ok(fixture.children[0].exitCode !== null || fixture.children[0].signalCode !== null)
    assert.equal(fixture.children[1].exitCode, null)
    assert.equal(fixture.children[1].signalCode, null)
    assert.deepEqual(fixture.logs.filter((line) => /EADDRINUSE|重启失败/.test(line)), [])
  } finally {
    await fixture.extension.deactivate()
    for (const child of fixture.children) child.kill()
  }
})

test('manual restart during launch discards the old process when its health reply arrives', async () => {
  const fixture = extensionFixture({ delayedHealth: true })
  try {
    const oldClient = fixture.getClient()
    await tick()
    await fixture.commands.get('tianshu.restartSidecar')!()
    const replacementClient = await fixture.getClient()
    fixture.resolveHealth()
    await assert.rejects(oldClient, /启动已取消/)
    await tick()
    assert.equal(await fixture.getClient(), replacementClient)
    assert.equal(fixture.states.at(-1), 'ready')
    fixture.children[1].emit('exit', 1)
    assert.equal(fixture.states.at(-1), 'starting')
  } finally { fixture.extension.deactivate() }
})

test('SCM and sidecar share the downloaded runtime resolution', async () => {
  const runtime = resolve(root, 'fixture runtime', 'bin', 'rivet')
  const fixture = extensionFixture({ runtime })
  try {
    await fixture.getClient()
    assert.equal(await fixture.getCliPath(), runtime)
    assert.deepEqual(fixture.launchedPaths, [runtime])
    assert.equal(fixture.runtimeResolutions(), 1)
  } finally { fixture.extension.deactivate() }
})

test('failed obsolete CLI resolution cannot clear the replacement runtime path', async () => {
  const runtime = resolve(root, 'fixture runtime', 'bin', 'rivet')
  const fixture = extensionFixture({ runtime, delayedRuntimeFailure: true })
  try {
    const oldClient = fixture.getClient()
    await tick()
    await fixture.commands.get('tianshu.restartSidecar')!()
    const failed = assert.rejects(oldClient, /obsolete resolution failed/)
    fixture.rejectRuntime()
    await failed
    assert.equal(await fixture.getCliPath(), runtime)
    assert.equal(fixture.runtimeResolutions(), 2)
    assert.equal(fixture.states.at(-1), 'ready')
  } finally { fixture.extension.deactivate() }
})

test('SCM command uses the resolved downloaded runtime without rivet on PATH', async () => {
  let command!: () => Promise<void>
  const invoked: string[] = []
  const errors: string[] = []
  const repo = { rootUri: { fsPath: root }, inputBox: { value: '' } }
  const runtime = resolve(root, 'fixture runtime', 'bin', 'rivet')
  const { registerCommitMessageCommand } = load('src/scm/commit-message.ts', {
    vscode: {
      extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ repositories: [repo] }) } }) },
      workspace: { getConfiguration: () => ({ get: () => '' }) },
      commands: { registerCommand: (_key: string, cb: any) => { command = cb; return {} } },
      window: { showInformationMessage() {}, showErrorMessage: (msg: string) => errors.push(msg), withProgress: (_opts: unknown, cb: any) => cb() },
      ProgressLocation: { SourceControl: 1 },
    },
    'node:child_process': { spawn: (cli: string) => {
      invoked.push(cli)
      const child: any = new EventEmitter()
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} })
      queueMicrotask(() => {
        if (cli === 'rivet') { child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' })); return }
        child.stdout.emit('data', Buffer.from(cli === 'git' ? 'diff --git a/a b/a\n+change' : '{"success":true,"text":"fix: 修复"}\n'))
        child.emit('close', 0)
      })
      return child
    } },
  })
  registerCommitMessageCommand({ subscriptions: [] }, async () => runtime)
  await command()
  assert.equal(repo.inputBox.value, 'fix: 修复')
  assert.deepEqual(errors, [])
  assert.deepEqual(invoked, ['git', runtime])
})

// ---- P0-3：插件会话库与桌面端隔离（RIVET_DESKTOP_DIR）+ 锁冲突识别 ----

/** launcher 的 spawn/fetch 双桩：记录 spawn env，按脚本回放 /health 体。 */
function launcherProbe(health: () => unknown) {
  const spawns: Array<{ cli: string; env: Record<string, string | undefined> }> = []
  const children: any[] = []
  const { launchSidecar } = load('src/sidecar/launcher.ts', {
    'node:child_process': { spawn: (cli: string, _args: string[], options: any) => {
      spawns.push({ cli, env: options.env })
      const child: any = new EventEmitter()
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
        kill: () => { queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0) }); return true } })
      children.push(child)
      return child
    } },
  }, { fetch: async () => health() })
  return { launchSidecar, spawns, children }
}

test('sidecar spawn inherits RIVET_DESKTOP_DIR only when the caller supplies a session root', async () => {
  const ready = () => ({ ok: true, json: async () => ({ ok: true, readiness: 'ready' }) })
  const isolated = launcherProbe(ready)
  const dir = join(root, 'storage 路径', 'sidecar-data')
  const handle = await isolated.launchSidecar({ cwd: root, cliPath: 'rivet', desktopDir: dir })
  assert.equal(isolated.spawns[0]!.env.RIVET_DESKTOP_DIR, dir)
  assert.equal(isolated.spawns[0]!.env.RIVET_SERVER_TOKEN, handle.token)
  await handle.dispose()

  // 未提供时不得凭空造一个目录——沿用继承来的环境（等同桌面端默认库）。
  const inherited = launcherProbe(ready)
  const plain = await inherited.launchSidecar({ cwd: root, cliPath: 'rivet' })
  assert.equal(inherited.spawns[0]!.env.RIVET_DESKTOP_DIR, process.env.RIVET_DESKTOP_DIR)
  await plain.dispose()
})

test('sidecar reporting readiness failed with data-dir-locked fails the launch with that reason', async () => {
  const probe = launcherProbe(() => ({
    ok: true,
    json: async () => ({ ok: false, readiness: 'failed', initializationError: 'data-dir-locked',
      storeLockHolder: { pid: 4242, hostname: 'other-host' } }),
  }))
  await assert.rejects(
    probe.launchSidecar({ cwd: root, cliPath: 'rivet', desktopDir: join(root, 'storage') }),
    (err: any) => {
      assert.equal(err.reason, 'data-dir-locked')
      assert.match(err.message, /data-dir-locked/)
      assert.match(err.message, /4242/)
      assert.match(err.message, /other-host/)
      return true
    },
  )
  // 失败即回收：不能把占着会话库的进程留在后台空转。
  assert.equal(probe.children[0].exitCode, 0)
})

test('other initialization failures surface as initialization-failed with the raw cause', async () => {
  const probe = launcherProbe(() => ({
    ok: true,
    json: async () => ({ ok: false, readiness: 'failed', initializationError: 'session-registry-unavailable' }),
  }))
  await assert.rejects(
    probe.launchSidecar({ cwd: root, cliPath: 'rivet' }),
    (err: any) => {
      assert.equal(err.reason, 'initialization-failed')
      assert.match(err.message, /session-registry-unavailable/)
      return true
    },
  )
})

test('readiness initializing is not a launch failure — only failed aborts it', async () => {
  // 会话注册表还在初始化时进程已在服务：启动成功，后续请求由内核侧排队。
  const probe = launcherProbe(() => ({ ok: true, json: async () => ({ ok: false, readiness: 'initializing' }) }))
  const handle = await probe.launchSidecar({ cwd: root, cliPath: 'rivet' })
  assert.equal(handle.port > 0, true)
  await handle.dispose()
})

test('health body without readiness (old runtime / anonymous shape) still counts as healthy', async () => {
  const probe = launcherProbe(() => ({ ok: true, json: async () => ({ ok: true, version: '3.5.6' }) }))
  const handle = await probe.launchSidecar({ cwd: root, cliPath: 'rivet' })
  assert.equal(handle.token.length, 48)
  await handle.dispose()
})

test('folder window scopes the sidecar session root to workspace storage', async () => {
  const fixture = extensionFixture()
  try {
    await fixture.getClient()
    assert.equal(fixture.spawnEnvs[0]!.RIVET_DESKTOP_DIR, join('fixture-storage/ws', 'sidecar-data'))
  } finally {
    await fixture.extension.deactivate().catch(() => {})
  }
})

test('window without a storage uri falls back to a per-host-process global root', async () => {
  const fixture = extensionFixture({ noStorageUri: true })
  try {
    await fixture.getClient()
    assert.equal(fixture.spawnEnvs[0]!.RIVET_DESKTOP_DIR, join('fixture-storage', `sidecar-data-${process.pid}`))
  } finally {
    await fixture.extension.deactivate().catch(() => {})
  }
})
