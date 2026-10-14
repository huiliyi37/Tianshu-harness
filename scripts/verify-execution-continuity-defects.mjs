import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, copyFileSync, readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

// Mutations run in a disposable mirror. The shared checkout is never restored or rewritten.
const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'execution-continuity-defects-'))
const mirror = join(temporary, 'repo')
mkdirSync(mirror)
const dirty = execFileSync('rtk', ['proxy', 'git', 'diff', '--name-only'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split('\n')
const owned = new Set([...dirty.filter(p => /^(src|desktop\/src)\//.test(p)),
  'src/api/execution-continuity.ts', 'src/api/__tests__/execution-continuity.test.ts',
  'src/agent/worker-terminal-policy.ts', 'src/agent/__tests__/worker-fixed-execution.integration.test.ts',
  'src/cache/__tests__/cache-diagnostic-class.test.ts'])
function linkTree(source, target, relative = '') {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = join(source, entry.name), dest = join(target, entry.name), rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) linkTree(path, dest, rel)
    else if (owned.has(rel)) copyFileSync(path, dest)
    else symlinkSync(path, dest)
  }
}
const api = 'src/api/__tests__/execution-continuity.test.ts'
const integration = 'src/agent/__tests__/worker-fixed-execution.integration.test.ts'
const report = 'src/agent/__tests__/worker-report-repair.test.ts'
const history = 'src/prompt/__tests__/tool-content-dedup.test.ts'
const desktop = 'desktop/src/state/__tests__/event-reducer.test.ts'
const engine = 'src/prompt/__tests__/engine.test.ts'
const boundary = 'src/agent/__tests__/compact-boundary-coordinator.test.ts'
const hands = 'src/agent/__tests__/hands-session-write-gate.test.ts'
const diagnostic = 'src/cache/__tests__/cache-diagnostic-class.test.ts'
const cases = [
  ['effort-lock', 'src/api/execution-continuity.ts', "if (!unlocked) return", "if (false) return", [api]],
  ['execution-options', 'src/api/execution-continuity.ts', "if (proof.optionsHash !== next.optionsHash) throw new ContinuationPrefixError('options', proof, next)", '', [api]],
  ['model-binding-change', 'src/api/execution-continuity.ts', "if (proof.provider !== next.provider || proof.model !== next.model || proof.endpointHash !== next.endpointHash\n              || proof.credentialScope !== next.credentialScope) throw new ContinuationPrefixError('binding', proof, next)", '', [api]],
  ['tool-catalog', 'src/api/execution-continuity.ts', "if (proof.toolsHash !== next.toolsHash) throw new ContinuationPrefixError('tools', proof, next)", '', [api]],
  ['history-prefix', 'src/api/execution-continuity.ts', "if (at !== -1) throw new ContinuationPrefixError(at, proof, next)", '', [api]],
  ['single-attempt-retry', 'src/api/retry-engine.ts', 'currentExecutionScope()?.singleAttempt ? 0 : options?.maxTotalRetries', 'options?.maxTotalRetries', [api]],
  ['resume-effort', 'src/api/execution-continuity.ts', "if (typeof savedEffort === 'string') client.setReasoningEffort?.(savedEffort)", '', [api]],
  ['unavailable-model-fallback', 'src/agent/worker-runtime.ts', 'binding = resolveModelBinding(deps.config.provider.providers, policy.target)', 'try { binding = resolveModelBinding(deps.config.provider.providers, policy.target) } catch { binding = resolveModelBinding(deps.config.provider.providers, root) }', [integration]],
  ['coordinator-rerun', 'src/agent/coordinator.ts', 'this.captureAbortCheckpoint(order, workerRun.checkpoint, workerRun.result)', "if (workerRun.result.status !== 'passed') await this.runWorker(workerConfig)\n        this.captureAbortCheckpoint(order, workerRun.checkpoint, workerRun.result)", [integration]],
  ['paid-report-repair', 'src/agent/worker-session.ts', 'const failureRaw = rejectedReports.at(-1)?.raw || latestText', "const repair = typeof config.reportRepairClient === 'function' ? config.reportRepairClient() : config.reportRepairClient\n        if (repair) await repair.stream({ model: workerModel, messages: [{ role: 'user', content: latestText }] }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} })\n        const failureRaw = rejectedReports.at(-1)?.raw || latestText", [report]],
  ['isolated-fallback', 'src/agent/worker-process/parent.ts', 'return (config) => runWorkerSessionOop(config, opts)', 'return async (config) => { try { return await runWorkerSessionOop(config, opts) } catch { return runWorkerSession(config) } }', [integration]],
  ['terminal-task-recreation', 'src/agent/worker-terminal-policy.ts', "if (this.failed.has(key) || (path && existsSync(path) && !inherited))", 'if (false)', [integration]],
  ['silent-legacy-restore', 'src/agent/session-persist.ts', "if (!isCompleteExecutionSnapshot(data.executionSnapshot)) throw new LocalWorkerPolicyError('历史请求的模型、凭据归属或执行选项证据不足；禁止静默冷启动，请显式开始新会话')", '', [integration]],
  ['missing-log-cold-restore', 'src/agent/session-persist.ts', 'hasLog || (existsSync(this.filePath) && statSync(this.filePath).size > 0 && this.loadOai().length > 0)', 'hasLog', [integration]],
  ['historical-dedup', 'src/prompt/engine.ts', 'if (!sidePath) this.recordPrefixDivergence(request.messages)', "if (!sidePath) { const seen = new Set(); for (let i = request.messages.length - 1; i >= 0; i--) { const m = request.messages[i]; if (m.role !== 'tool') continue; if (seen.has(m.content)) request.messages[i] = { ...m, content: '[duplicate content, see later tool result]' }; else seen.add(m.content) } }\n    if (!sidePath) this.recordPrefixDivergence(request.messages)", [history]],
  ['desktop-terminal-wiring', 'desktop/src/state/event-reducer.ts', "terminalFailure: typeof ev.data.terminalFailure === 'boolean' ? ev.data.terminalFailure : prev?.terminalFailure", 'terminalFailure: prev?.terminalFailure', [desktop]],
  ['late-tool-registration', 'src/prompt/engine.ts', 'if (this.toolCatalogPublished) return', '', [engine]],
  ['effort-change-reopens-tools', 'src/prompt/engine.ts', 'authorizeCacheGeneration(): void { this.executionSnapshot = undefined }', 'authorizeCacheGeneration(): void { this.executionSnapshot = undefined; this.toolCatalogPublished = false }', [engine]],
  ['quality-history-compaction', 'src/agent/compact-boundary-coordinator.ts', 'return { compacted: false, shouldAbort:', 'await this.deps.maybeCompact({ loopTurn: _turn, failures: this.deps.getCompactFailures() })\n    return { compacted: false, shouldAbort:', [boundary]],
  ['write-gate-compensation', 'src/agent/hands-session.ts', 'const repairCount = 0', 'if (report.outcome === \'failed\') await config.runAgent(buildHandsPrompt(config), {} as never, wt.path, { continueSession: true })\n      const repairCount = 0', [hands]],
  ['opaque-credential-change', 'src/api/execution-continuity.ts', "return opaque ? createHash('sha256').update(`opaque:${opaque}`).digest('hex') : undefined", 'return undefined', [api]],
  ['diagnostic-config-change', 'src/cache/cache-diagnostic-class.ts', "if (['generation_changed', 'configuration_changed'].includes((entry.wire as { comparison?: string } | undefined)?.comparison ?? '')) return 'model_or_config_change'", '', [diagnostic]],
  ['repeated-hard-limit-compaction', 'src/agent/context-budget-preparation.ts', 'if (attempt < 1)', 'if (attempt < 2)', ['src/agent/__tests__/context-budget-preparation.test.ts']],
  ['failed-resume-hint', 'src/agent/coordinator.ts', "if (result.status !== 'passed' || result.failureReason || result.terminalFailure) result.terminalFailure = true", "result.nextActions.push('Resumable: resume the failed worker')", ['src/agent/__tests__/worker-abort-checkpoint-resume.test.ts']],
  ['headless-root-account', 'src/agent/headless-coordinator.ts', 'credentialPrincipal: input.getRootCredentialPrincipal?.()', 'credentialPrincipal: undefined', [integration]],
  ['startup-default-is-not-user-selection', 'src/bootstrap.ts', 'explicitModel: opts.modelId', 'explicitModel: effectiveModelId', ['src/__tests__/startup-resume-model.test.ts']],
  ['startup-explicit-generation', 'src/bootstrap.ts', 'if (explicitStartupGeneration) {', 'if (false) {', ['src/__tests__/startup-resume-model.test.ts']],
  ['startup-restores-old-binding-on-user-change', 'src/bootstrap.ts', 'inheritFrozenFrom: explicitStartupGeneration && resumedFrozen ? { ...resumedFrozen, executionSnapshot: undefined } : resumedFrozen', 'inheritFrozenFrom: resumedFrozen', ['src/__tests__/startup-resume-model.test.ts']],
]
// Targets must be physical copies even after the changes have been committed.
for (const [, path, , , tests] of cases) {
  owned.add(path)
  for (const test of tests) owned.add(test)
}
linkTree(join(root, 'src'), join(mirror, 'src'), 'src')
linkTree(join(root, 'desktop', 'src'), join(mirror, 'desktop', 'src'), 'desktop/src')
for (const name of ['package.json', 'tsconfig.json', 'node_modules', 'scripts', 'docs', 'runtime-assets']) symlinkSync(join(root, name), join(mirror, name))
for (const name of ['package.json', 'tsconfig.json', 'node_modules']) {
  if (existsSync(join(root, 'desktop', name))) symlinkSync(join(root, 'desktop', name), join(mirror, 'desktop', name))
}
const results = []
function run(name, files) {
  const result = spawnSync('rtk', ['proxy', 'node', '--preserve-symlinks', '--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
    cwd: mirror, encoding: 'utf8', timeout: 60_000, maxBuffer: 8_000_000, windowsHide: true,
    env: { ...process.env, RIVET_HOME: join(temporary, `home-${name}`), RIVET_SESSION_DIR: join(temporary, `sessions-${name}`), RIVET_TEST: '1' },
  })
  writeFileSync(join(temporary, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result
}
const baseline = run('baseline', [api, integration, report, history, desktop, engine, boundary, hands, diagnostic, 'src/agent/__tests__/worker-abort-checkpoint-resume.test.ts', 'src/__tests__/startup-resume-model.test.ts'])
if (baseline.status !== 0) throw new Error(`Mirror baseline failed: ${temporary}/baseline.log`)
console.log('mirror baseline: green')
for (const [name, path, before, after, tests] of cases) {
  const file = join(mirror, path), source = readFileSync(file, 'utf8')
  if (lstatSync(file).isSymbolicLink()) throw new Error(`Unsafe mutation target: ${path}`)
  if (!source.includes(before)) throw new Error(`Mutation anchor missing: ${name}`)
  try {
    writeFileSync(file, source.replace(before, after))
    const result = run(name, tests)
    const assertionFailure = /ERR_ASSERTION|AssertionError|Missing expected rejection|Missing expected exception/.test(result.stdout ?? '')
    const killed = result.status !== 0 && !result.error && assertionFailure
    results.push({ name, killed, exitCode: result.status, timeout: !!result.error })
    console.log(`${name}: ${killed ? 'red as expected' : 'INVALID / SURVIVED'}`)
    if (!killed) throw new Error(`Mutation did not produce an assertion failure: ${temporary}/${name}.log`)
  } finally { writeFileSync(file, source) }
}
writeFileSync(join(temporary, 'results.json'), JSON.stringify({ baseline: 'green', results }, null, 2))
console.log(`Evidence: ${temporary}/results.json`)
