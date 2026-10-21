import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { builtinModules } from 'node:module'
import { build } from 'esbuild'
import { LongWorld } from './recovery-long-world.js'
import { CASES, snapshotFiles } from './scoped-hook-task.js'
import { checkEvidence, nodeTestCounts, verdict, type Stage } from './experiment-protocol.js'
import { allocatePorts, assertPortsAvailable } from './experiment-capabilities.js'
import { deliveryOutcome } from './scoped-hook-outcomes.js'

const modules = realpathSync(resolve('node_modules'))
const compiler = realpathSync(join(modules, 'typescript/bin/tsc'))
// Bypass Apple's /usr/bin/git launcher so its xcrun cache cannot escape the test home.
const gitBinary = process.platform === 'darwin' ? realpathSync(execFileSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim()) : '/usr/bin/git'

function killOwnedTree(child: ChildProcess): void {
  if (!child.pid) return
  const owned = new Set([child.pid])
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number))
    for (let pass = 0; pass < rows.length; pass++) { const before = owned.size; for (const [pid, ppid] of rows) if (owned.has(ppid!)) owned.add(pid!); if (owned.size === before) break }
  } catch { /* root process group is still owned */ }
  for (const pid of [...owned].reverse()) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } } }
}

function http(port: number, path: string, body?: unknown, budget = 12_000): Promise<{ ok: boolean; value?: any; ms: number; error?: string }> {
  const started = Date.now()
  return new Promise(resolveResult => {
    const r = request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', agent: false, headers: { 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += String(chunk) }); res.on('end', () => {
        try { resolveResult({ ok: res.statusCode === 200, value: JSON.parse(text), ms: Date.now() - started }) }
        catch { resolveResult({ ok: false, error: 'invalid-response', ms: Date.now() - started }) }
      })
    })
    const timer = setTimeout(() => r.destroy(new Error('probe-timeout')), budget)
    r.once('error', error => resolveResult({ ok: false, error: error.message, ms: Date.now() - started }))
    r.once('close', () => clearTimeout(timer)); if (body !== undefined) r.write(JSON.stringify(body)); r.end()
  })
}

export class HookWorld extends LongWorld {
  private runIndex = 0
  constructor(fixed = false) { super(snapshotFiles(fixed), ['.build'], true) }
  override definitions() {
    return super.definitions().map(d => d.name !== 'run_checks' ? d : { ...d,
      description: 'Run strict TypeScript checking, existing smoke and the real slow Git hook/HTTP reproduction in isolated repositories. No args runs original checks. test_file runs an added test/*.test.mjs after building. No installs or arbitrary shell.' })
  }
  private profile(port?: number): string {
    if (process.platform !== 'darwin') throw new Error('Historical task requires verified macOS Seatbelt; no bare fallback')
    const q = (s: string) => JSON.stringify(realpathSync(s))
    const ancestors = new Set<string>()
    for (const root of [this.root, modules]) {
      for (let p = dirname(root); ; p = dirname(p)) { ancestors.add(p); if (dirname(p) === p) break }
    }
    const traversal = [...ancestors].map(p => `(literal ${JSON.stringify(p)})`).join(' ')
    const network = (port ? [port] : this.capabilities.loopbackPorts).map(p => `(allow network-inbound (local ip "localhost:${p}"))(allow network-outbound (remote ip "localhost:${p}"))`).join('')
    return `(version 1)(allow default)(deny network*)${network}
(deny file-read*)(allow file-read-metadata)(allow file-read* (subpath ${q(this.root)}) (subpath ${q(modules)}) (subpath ${q(dirname(realpathSync(process.execPath)))}) (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library") (subpath "/Applications/Xcode.app") (subpath "/dev") (subpath "/private/etc") (subpath "/private/var/db"))
(deny file-write*)(allow file-write* (subpath ${q(this.root)}) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))`
      + `(allow file-read* ${traversal})` // exact ancestor directories, not their file descendants.
  }
  private launch(args: string[], options: { port?: number; repo?: string; childProcess?: boolean; signal?: AbortSignal } = {}): ChildProcess {
    const permissions = ['--permission', '--allow-fs-read=' + this.root, '--allow-fs-read=' + modules, '--allow-fs-read=' + gitBinary, '--allow-fs-write=' + this.root, ...(options.childProcess ? ['--allow-child-process'] : [])]
    const child = spawn('/usr/bin/sandbox-exec', ['-p', this.profile(options.port), realpathSync(process.execPath), ...permissions, ...args], {
      cwd: this.root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
        PATH: '/usr/bin:/bin', HOME: join(this.root, '.home'), TMPDIR: join(this.root, '.tmp'),
        RIVET_HOME: join(this.root, '.home/rivet'), RIVET_SESSION_DIR: join(this.root, '.home/sessions'), RIVET_GIT_PATH: gitBinary,
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C',
        ...Object.fromEntries(this.capabilities.loopbackPorts.map((p, i) => ['EXPERIMENT_PORT_' + (i + 1), String(p)])),
        ...(options.repo ? { BENCH_REPO: options.repo } : {}), ...(options.port ? { BENCH_PORT: String(options.port) } : {}),
      }, windowsHide: true,
    })
    const stop = () => killOwnedTree(child)
    options.signal?.addEventListener('abort', stop, { once: true }); child.once('close', () => options.signal?.removeEventListener('abort', stop))
    if (options.signal?.aborted) stop()
    return child
  }
  private async command(args: string[], signal?: AbortSignal, childProcess = false) {
    await this.ensurePorts()
    await assertPortsAvailable(this.capabilities.loopbackPorts)
    signal?.throwIfAborted()
    const child = this.launch(args, { signal, childProcess })
    let output = '', timedOut = false
    const result = await new Promise<{ exit: number | null; output: string; timedOut: boolean }>(resolveResult => {
      const timer = setTimeout(() => { timedOut = true; killOwnedTree(child) }, 25_000)
      const chunk = (s: Buffer) => { output += String(s); if (output.length > 200_000) { timedOut = true; killOwnedTree(child) } }
      child.stdout?.on('data', chunk); child.stderr?.on('data', chunk); child.on('error', e => { output += e.message })
      child.on('close', (exit, signal) => { clearTimeout(timer); resolveResult({ exit, output: (output + (signal ? `\nprocess-signal=${signal}` : '')).slice(-200_000), timedOut }) })
    })
    return result
  }
  private async compile(signal?: AbortSignal) {
    const types = await this.command([compiler, '-p', 'tsconfig.json', '--typeRoots', join(modules, '@types')], signal)
    if (types.exit !== 0) return { ok: false, types }
    const started = Date.now()
    try {
      await build({ entryPoints: { serve: join(this.root, 'scripts/serve.ts'), delivery: join(this.root, 'src/delivery.ts') },
        outdir: join(this.root, '.build'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
        plugins: [{ name: 'workspace-only', setup: builder => {
          builder.onResolve({ filter: /^[^./]/ }, arg => {
            if (arg.path.startsWith('node:') || builtinModules.includes(arg.path)) return { path: arg.path, external: true }
            return { errors: [{ text: 'Only built-in or project-relative imports are available; no automatic dependency installation.' }] }
          })
          builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, arg => {
            const p = realpathSync(arg.path), rel = relative(this.root, p)
            if (rel.startsWith('..') || resolve(p) !== p) return { errors: [{ text: 'Import is outside the isolated task.' }] }
            return { contents: readFileSync(p, 'utf8'), loader: p.endsWith('.ts') ? 'ts' : 'js' }
          })
        } }],
      })
      return { ok: true, types, buildMs: Date.now() - started }
    } catch (error) { return { ok: false, types, buildError: error instanceof Error ? error.message : 'build failed' } }
  }
  protected override probeProcess(args: string[]) { return this.command(args, undefined, true) }
  override async preflight() {
    const compiled = await this.compile(), probe = await super.preflight()
    const generatedReadable = existsSync(join(this.root, '.build/delivery.mjs')) && readFileSync(join(this.root, '.build/delivery.mjs'), 'utf8').length > 0
    return { ...probe, compiled, generatedReadable, git: gitBinary, passed: probe.passed && compiled.ok && generatedReadable }
  }
  private git(repo: string, ...args: string[]): string {
    return execFileSync(gitBinary, args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: join(this.root, '.home'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' } }).trimEnd()
  }
  private repo() {
    const path = join(this.root, '.runs', String(++this.runIndex)); mkdirSync(path, { recursive: true })
    this.git(path, 'init', '-q'); this.git(path, 'config', 'user.name', 'fixture'); this.git(path, 'config', 'user.email', 'fixture@example.invalid'); this.git(path, 'config', 'commit.gpgSign', 'false')
    for (const p of ['owned.txt', 'other.txt']) writeFileSync(join(path, p), 'before\n')
    this.git(path, 'add', '--', 'owned.txt', 'other.txt'); this.git(path, 'commit', '-q', '-m', 'base')
    writeFileSync(join(path, 'owned.txt'), 'after\n')
    writeFileSync(join(path, 'other.txt'), 'staged-other\n'); this.git(path, 'add', '--', 'other.txt'); writeFileSync(join(path, 'other.txt'), 'unstaged-other\n')
    return path
  }
  private hook(repo: string, kind: 'pre-commit' | 'post-commit', mode: 'slow' | 'failed') {
    const file = join(repo, '.git/hooks', kind)
    writeFileSync(file, `#!/bin/sh\nprintf 'start\\n' >> .git/hook.log\n${mode === 'slow' ? '/bin/sleep 4' : 'exit 1'}\nprintf 'finish\\n' >> .git/hook.log\n`)
    chmodSync(file, 0o700)
  }
  private async service(repo: string, signal?: AbortSignal) {
    const port = (await allocatePorts(1))[0]!, child = this.launch(['.build/serve.mjs'], { port, repo, childProcess: true, signal })
    let stdout = '', stderr = ''
    child.stdout?.on('data', s => { stdout += String(s) }); child.stderr?.on('data', s => { stderr += String(s) })
    let ready = false
    for (let i = 0; i < 150; i++) {
      signal?.throwIfAborted()
      if (stdout.includes('"ready":true')) { ready = true; break }
      if (child.exitCode !== null) break
      await delay(20)
    }
    if (!ready) { killOwnedTree(child); throw new Error('Isolated service failed to start: ' + stderr.slice(-1000)) }
    return { port, child, stop: async () => { killOwnedTree(child); await new Promise<void>(resolveStop => { if (child.exitCode !== null || child.signalCode) return resolveStop(); child.once('close', () => resolveStop()) }) } }
  }
  private async marker(repo: string, signal?: AbortSignal) {
    for (let i = 0; i < 120; i++) { signal?.throwIfAborted(); if (existsSync(join(repo, '.git/hook.log'))) return true; await delay(20) }
    return false
  }
  private async slowProbe(signal?: AbortSignal) {
    const repo = this.repo(); this.hook(repo, 'pre-commit', 'slow')
    const indexBefore = this.git(repo, 'show', ':other.txt'), headBefore = this.git(repo, 'rev-parse', 'HEAD')
    const server = await this.service(repo, signal)
    try {
      const started = Date.now(), pending = http(server.port, '/deliver', { files: ['owned.txt'], message: 'delivery probe' })
      const markerSeen = await this.marker(repo, signal)
      const probes = await Promise.all(Array.from({ length: 6 }, async (_, i) => { await delay(i * 80); return { health: await http(server.port, '/readyz', undefined, 500), approval: await http(server.port, '/approvals', undefined, 500) } }))
      const response = await pending, elapsedMs = Date.now() - started, log = existsSync(join(repo, '.git/hook.log')) ? readFileSync(join(repo, '.git/hook.log'), 'utf8') : ''
      return { markerSeen, response, elapsedMs, probes,
        responsive: probes.every(p => p.health.ok && p.approval.ok), hookExecuted: markerSeen && log === 'start\nfinish\n' && elapsedMs >= 3800,
        owned: response.value?.status === 'committed' && this.git(repo, 'rev-parse', 'HEAD') !== headBefore && this.git(repo, 'show', 'HEAD:owned.txt') === 'after' && this.git(repo, 'show', 'HEAD:other.txt') === 'before'
          && this.git(repo, 'show', ':other.txt') === indexBefore && readFileSync(join(repo, 'other.txt'), 'utf8') === 'unstaged-other\n',
      }
    } finally { await server.stop() }
  }
  override async checks(testFile?: string, signal?: AbortSignal): Promise<any> {
    const before = this.sourceHash(), compiled = await this.compile(signal)
    const runs: Stage[] = [{ id: 'typecheck', required: true, executed: true, origin: 'candidate', command: ['typecheck'],
      exit: compiled.types.exit === 0 ? (compiled.ok ? 0 : 1) : compiled.types.exit, output: JSON.stringify(compiled), timedOut: compiled.types.timedOut },
      { id: 'tests', required: true, executed: false, exit: null, output: 'Not run: prerequisite compilation did not complete.', timedOut: false, origin: 'harness' },
      ...(!testFile ? [{ id: 'reproduction', required: true, executed: false, exit: null, output: 'Not run: prerequisite compilation did not complete.', timedOut: false, origin: 'harness' as const }] : [])]
    if (compiled.ok) {
      const test = await this.command(['--test', '--test-isolation=none', testFile ?? 'test/smoke.test.mjs'], signal, true)
      runs[1] = { id: 'tests', required: true, executed: true, origin: 'candidate', ...test, tests: nodeTestCounts(test.output) }
      if (!testFile) {
        const probe = await this.slowProbe(signal)
        runs[2] = { id: 'reproduction', required: true, executed: true, origin: 'candidate', exit: probe.responsive && probe.hookExecuted && probe.owned ? 0 : 1, output: JSON.stringify(probe), timedOut: false }
      }
    }
    return checkEvidence(before, this.sourceHash(), this.protectedUnchanged(), runs)
  }
  private async boundaryProbe(kind: string) {
    const repo = this.repo(), before = this.git(repo, 'rev-parse', 'HEAD'), message = 'boundary identity probe'
    const otherIndex = this.git(repo, 'show', ':other.txt')
    if (kind === 'term-ignoring-hook') {
      const hook = join(repo, '.git/hooks/pre-commit')
      writeFileSync(hook, `#!/bin/sh\ntrap '' TERM\nexec >/dev/null 2>&1\necho $$ > .git/hook.pid\necho start > .git/hook.log\n/bin/sleep 4\necho late > .git/late\n`); chmodSync(hook, 0o700)
    } else this.hook(repo, 'pre-commit', 'slow')
    const server = await this.service(repo)
    let group: number | undefined
    try {
      const pending = http(server.port, '/deliver', { files: ['owned.txt'], message })
      const marker = await this.marker(repo)
      if (!marker) return { passed: false, evidence: { marker, response: await pending } }
      let foreign: string | undefined
      if (kind !== 'term-ignoring-hook') {
        let tree = 'HEAD^{tree}'
        if (kind === 'foreign-same-path') {
          writeFileSync(join(repo, '.git/foreign-owned'), 'foreign content\n')
          const blob = this.git(repo, 'hash-object', '-w', '--', '.git/foreign-owned')
          const entries = this.git(repo, 'ls-tree', 'HEAD').split('\n').map(line => line.endsWith('\towned.txt') ? line.replace(/blob [0-9a-f]+/, 'blob ' + blob) : line).join('\n') + '\n'
          tree = execFileSync(gitBinary, ['mktree'], { cwd: repo, input: entries, encoding: 'utf8', windowsHide: true, env: { PATH: '/usr/bin:/bin', HOME: join(this.root, '.home'), GIT_CONFIG_NOSYSTEM: '1' } }).trim()
        }
        foreign = this.git(repo, 'commit-tree', tree, '-p', before, '-m', message)
        this.git(repo, 'update-ref', 'HEAD', foreign, before)
      } else {
        const pid = Number(readFileSync(join(repo, '.git/hook.pid'), 'utf8').trim())
        const pgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true }).trim())
        const parent = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true }).trim())
        const ancestor = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(parent)], { encoding: 'utf8', windowsHide: true }).trim())
        if (pgid !== parent || ancestor !== server.child.pid || pgid <= 1) throw new Error('Cannot establish fixture group ownership')
        group = pgid
      }
      const started = Date.now(), cancel = await http(server.port, '/cancel', undefined, 500), response = await pending, ms = Date.now() - started
      const head = this.git(repo, 'rev-parse', 'HEAD'), selected = this.git(repo, 'show', 'HEAD:owned.txt'), status = response.value?.status
      const preserved = this.git(repo, 'show', ':other.txt') === otherIndex && readFileSync(join(repo, 'other.txt'), 'utf8') === 'unstaged-other\n'
      if (kind === 'term-ignoring-hook') {
        const lateAtReturn = existsSync(join(repo, '.git/late')); await delay(4300)
        const lateAfterReturn = existsSync(join(repo, '.git/late'))
        return { passed: deliveryOutcome(status) === 'unknown' ? null : response.ok && cancel.ok && deliveryOutcome(status) === 'stopped' && head === before && !lateAtReturn && !lateAfterReturn && ms < 3000 && preserved,
          evidence: { response, cancel, ms, lateAtReturn, lateAfterReturn, preserved } }
      }
      const recognized = deliveryOutcome(status) !== 'unknown'
      return { passed: recognized ? response.ok && cancel.ok && status !== 'committed' && head === foreign && preserved && response.value?.landed !== true : null,
        evidence: { response, cancel, selected, headIsForeign: head === foreign, preserved } }
    } finally { if (group) { try { process.kill(-group, 'SIGKILL') } catch { /* owned fixture group ended */ } }; await server.stop() }
  }
  override async grade(): Promise<any> {
    const compiled = await this.compile()
    const results: any[] = [verdict('types', compiled.ok, compiled)]
    const add = (id: string, passed: boolean | null, evidence: any, origin: 'candidate' | 'harness' | 'unknown' = 'candidate') => results.push(verdict(id, passed, evidence, origin))
    if (compiled.ok) {
      const slow = await this.slowProbe(); add('responsiveness', slow.responsive, slow.probes); add('hook-executed', slow.hookExecuted, { elapsedMs: slow.elapsedMs, markerSeen: slow.markerSeen }); add('owned-isolation', slow.owned, slow.response)
      for (const kind of ['partial-staging', 'snapshot-changed', 'failed-hook', 'foreign-lock', 'cancel', 'timeout', 'uncertain-commit', 'unchanged']) {
        const repo = this.repo(), head = this.git(repo, 'rev-parse', 'HEAD')
        if (kind === 'partial-staging') { this.git(repo, 'add', '--', 'owned.txt'); writeFileSync(join(repo, 'owned.txt'), 'partial-extra\n') }
        if (kind === 'failed-hook') this.hook(repo, 'pre-commit', 'failed')
        if (kind === 'cancel' || kind === 'timeout') this.hook(repo, 'pre-commit', 'slow')
        if (kind === 'uncertain-commit') this.hook(repo, 'post-commit', 'slow')
        if (kind === 'unchanged') writeFileSync(join(repo, 'owned.txt'), 'before\n')
        const server = await this.service(repo)
        try {
          let expectedVersion
          if (kind === 'snapshot-changed') { expectedVersion = (await http(server.port, '/preview', { files: ['owned.txt'] })).value?.version; writeFileSync(join(repo, 'owned.txt'), 'changed after preview\n') }
          const index = this.git(repo, 'ls-files', '--stage'), lock = join(repo, '.git/index.lock')
          if (kind === 'foreign-lock') writeFileSync(lock, 'owned by grader\n')
          const started = Date.now(), promise = http(server.port, '/deliver', { files: ['owned.txt'], message: 'grade ' + kind, ...(expectedVersion ? { expectedVersion } : {}), ...(kind === 'timeout' ? { timeoutMs: 200 } : {}) })
          let cancelReply: any, lockPresent: boolean | undefined, health: any
          if (kind === 'foreign-lock') {
            await delay(200); lockPresent = existsSync(lock) && readFileSync(lock, 'utf8') === 'owned by grader\n'; health = await http(server.port, '/readyz', undefined, 500)
            if (existsSync(lock)) rmSync(lock) // only our own fixture lock is removed by its creator.
          }
          if (kind === 'cancel' || kind === 'uncertain-commit') { await this.marker(repo); cancelReply = await http(server.port, '/cancel', undefined, 500) }
          const response = await promise, ms = Date.now() - started, after = this.git(repo, 'rev-parse', 'HEAD'), status = response.value?.status
          let passed = false
          if (kind === 'partial-staging' || kind === 'snapshot-changed' || kind === 'failed-hook' || kind === 'unchanged') passed = response.ok && deliveryOutcome(status) === 'stopped' && head === after && (kind !== 'partial-staging' || this.git(repo, 'ls-files', '--stage') === index)
          if (kind === 'foreign-lock') passed = lockPresent === true && health?.ok && status === 'committed' && head !== after
          if (kind === 'cancel') passed = cancelReply?.ok && deliveryOutcome(status) === 'stopped' && head === after && ms < 3000 && !readFileSync(join(repo, '.git/hook.log'), 'utf8').includes('finish')
          if (kind === 'timeout') passed = deliveryOutcome(status) === 'stopped' && head === after && ms < 3000
          if (kind === 'uncertain-commit') passed = response.ok && cancelReply?.ok && head !== after && deliveryOutcome(status) !== 'unknown' && this.git(repo, 'rev-list', '--count', 'HEAD') === '2' && this.git(repo, 'show', 'HEAD:owned.txt') === 'after' && this.git(repo, 'show', 'HEAD:other.txt') === 'before' && this.git(repo, 'show', ':other.txt') === 'staged-other' && readFileSync(join(repo, 'other.txt'), 'utf8') === 'unstaged-other\n' && response.value?.landed !== false
          add(kind, response.ok && deliveryOutcome(status) !== 'unknown' ? !!passed : null, { response, ms, headChanged: head !== after, cancelReply, lockPresent, health }, response.ok ? 'candidate' : 'unknown')
        } catch (error) { add(kind, null, { error: error instanceof Error ? error.message : 'unknown' }, 'unknown') }
        finally { await server.stop() }
      }
      for (const id of CASES.slice(12)) { try { const result = await this.boundaryProbe(id); add(id, result.passed, result.evidence) } catch (error) { add(id, null, { error: error instanceof Error ? error.message : 'unknown' }, 'unknown') } }
    } else for (const id of CASES.slice(1)) add(id, null, { skipped: 'type/build failure' }, 'unknown')
    const hashes = this.hashes(), protectedUnchanged = Object.entries(this.initialHashes).filter(([p]) => !p.startsWith('src/')).every(([p, hash]) => hashes[p] === hash)
    const passed = results.length === CASES.length && results.every(r => r.passed) && protectedUnchanged
    return { exit: passed ? 0 : 1, parsed: { results }, protectedUnchanged, hashes, passed }
  }
}
