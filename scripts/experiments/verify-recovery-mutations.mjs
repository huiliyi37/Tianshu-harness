/** Restore one defect in a child module loader; never rewrite the shared checkout. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const tests = 'scripts/__tests__/'
const definitions = {
  retrievalCalibration: ['retrieval-policy.ts', 'retrieval-convergence.test.ts', 'three arms change only', s => s.replace("arm === 'B' ? ''", "arm === 'B' ? CURRENT_CALIBRATION")],
  retrievalCapacity: ['retrieval-policy.ts', 'retrieval-convergence.test.ts', 'registered order', s => s.replace("r.status === 'final' && ", '')],
  retrievalReadonly: ['retrieval-tasks.ts', 'retrieval-convergence.test.ts', 'real grep handles', s => s.replace('this.capabilities.writableRoots = []', "this.capabilities.writableRoots = ['src', 'test']")],
  retrievalPrivate: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'real grep handles', s => s.replace('const files = this.inputs(selected.path)', "const files = this.inputs(selected.path); files['src/leaked.txt'] = Buffer.from(readFileSync(join(this.world.privateRoot, 'canary.txt'), 'utf8'))")],
  retrievalTruncation: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'real grep handles', s => s.replace('hasSearchTruncationMarker(known.content)', "known.content.includes('截断')")],
  retrievalProjectionScope: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'narrow search excludes unrelated', s => s.replaceAll('this.inputs(selected.path)', 'this.inputs()').replaceAll("this.inputs(input.path ?? '')", 'this.inputs()')],
  retrievalProjectionBound: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'projection reader rejects oversized', s => s.replace('if (stat.size > remaining) throw limit()', "if (stat.size > remaining) { readFileSync(path); throw limit() }" )],
  retrievalBinding: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'single-file evidence', s => s.replace('versions: before, payload:', 'versions: { wholeSource: this.world.sourceHash() }, payload:')],
  retrievalEditorWiring: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'grep observations reach', s => s.replace('this.reads.registerGrepFileAccess(actual.absolute, last.mtimeMs,', 'this.reads.registerGrepFileAccess(join(projection, p), last.mtimeMs,')],
  retrievalPaths: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'end-to-end directory', s => s.replace("replaceAll(projection + '/', '')", "replaceAll(projection, '<workspace>')")],
  retrievalPreflight: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'preflight observations never', s => s.replace("this.grepSession = 'qualification-' + (++this.qualifications)", "this.grepSession = 'long-pilot'")],
  retrievalSectionScope: ['retrieval-search.ts', 'retrieval-convergence.test.ts', 'end-to-end directory', s => s.replace("resolveCapability(this.world.root, input.file_path, 'read', this.world.capabilities)", '{path: input.file_path}')],
  tail: ['experiment-protocol.ts', 'experiment-protocol.test.ts', 'full request reservation', s => s.replace('this.trialLimit - this.spent < this.requestLimit', 'this.trialLimit - this.spent < 1')],
  usage: ['experiment-protocol.ts', 'experiment-protocol.test.ts', 'unknown or estimated', s => s.replace('this.uncertain = true; return', 'this.reserved = 0; return')],
  stages: ['experiment-protocol.ts', 'experiment-protocol.test.ts', 'unexecuted, skipped', s => s.replace('r.tests.passed + r.tests.failed > 0 && r.tests.skipped === 0', 'true')],
  generated: ['experiment-capabilities.ts', 'experiment-protocol.test.ts', 'one path policy', s => s.replace('  if (!c.readable.some', "  if (path.startsWith('.')) throw new CapabilityError('outside_workspace', 'legacy hidden path rejection')\n  if (!c.readable.some")],
  alias: ['experiment-capabilities.ts', 'experiment-protocol.test.ts', 'one path policy', s => s.replace('!c.writableRoots.some(p => under(actualPath, p)) || ', '')],
  hardTimeout: ['experiment-stream.ts', 'experiment-protocol.test.ts', 'survives >120s', s => s.replace('const started = Date.now()', 'const started = Date.now(); const legacyAbort=new AbortController(); const legacyTimer=setTimeout(()=>legacyAbort.abort(),120000)').replace('}, signal)', '}, AbortSignal.any([signal,legacyAbort.signal]))').replace('  const measured =', '  clearTimeout(legacyTimer); const measured =')],
  truncatedTools: ['experiment-stream.ts', 'experiment-protocol.test.ts', 'length stop quarantines', s => s.replace("? 'single-response-limit'", "? 'tools'")],
  immutableDispatch: ['experiment-stream.ts', 'experiment-protocol.test.ts', 'immutable multi-turn', s => s.replace('messages: structuredClone(messages)', 'messages')],
  protocolError: ['experiment-stream.ts', 'experiment-protocol.test.ts', 'unknown streamed tool names', s => s.replace("? 'provider-protocol-error'", "? 'transport-error'")],
  acknowledgement: ['recovery-long-policy.ts', 'recovery-long-experiment.test.ts', 'feedback is bound', s => s.replace("r.id === 'reproduction' && r.executed", 'r.executed')],
  privateRead: ['scoped-hook-world.ts', 'scoped-hook-experiment.test.ts', 'advertised generated', s => s.replace('(subpath ${q(this.root)}) (subpath ${q(modules)})', '(subpath ${q(this.root)}) (subpath ${q(this.privateRoot)}) (subpath ${q(modules)})').replace("'--allow-fs-read=' + modules,", "'--allow-fs-read=' + modules, '--allow-fs-read=' + this.privateRoot,")],
  status: ['scoped-hook-outcomes.ts', 'scoped-hook-experiment.test.ts', 'real cancelled/timeout', s => s.replace("'cancelled', 'uncertain', 'timeout', 'timed_out'", "'blocked'")],
  portConflict: ['scoped-hook-world.ts', 'scoped-hook-experiment.test.ts', 'advertised generated', s => s.replace('    await assertPortsAvailable(this.capabilities.loopbackPorts)', '')],
  descendants: ['scoped-hook-reference.ts', 'scoped-hook-experiment.test.ts', 'historical service really blocks', s => s.replace('export function correctedReference(files: Record<string, string>) {', 'export function correctedReference(files: Record<string, string>) { return files;')],
}
const mutation = process.env.EXPERIMENT_MUTATION
if (mutation) {
  const [file, , , change] = definitions[mutation]
  const { transformSync } = createRequire(resolve('package.json'))('esbuild')
  registerHooks({ load(url, ctx, next) {
    if (!url.startsWith('file:') || fileURLToPath(url) !== resolve('scripts/experiments', file)) return next(url, ctx)
    const source = readFileSync(new URL(url), 'utf8'), changed = change(source)
    assert.notEqual(changed, source, 'mutation anchor missing')
    process.stderr.write('MUTATION APPLIED: ' + mutation + '\n')
    return { shortCircuit: true, format: 'module', source: transformSync(changed, { loader: 'ts', format: 'esm', target: 'esnext' }).code }
  } })
}

function tapCases(result) {
  const output = result.stdout + result.stderr
  const rows = [...result.stdout.matchAll(/^(ok|not ok) \d+ - ([^\r\n]+)$/gm)]
  const total = Number(result.stdout.match(/^# tests (\d+)$/m)?.[1] ?? 0)
  assert.ok(!result.error && result.signal == null && total > 0 && rows.length === total
    && !/^# (?:cancelled|skipped|todo) [1-9]/m.test(result.stdout), 'expected completed, selected tests without skips, TODOs or cancellation')
  return { output, passed: rows.filter(r => r[1] === 'ok').map(r => r[2]), failed: rows.filter(r => r[1] === 'not ok').map(r => r[2]) }
}

/** A RED is evidence only after a fresh GREEN of the same selected tests. */
export function verifyMutation(name, destination, run) {
  assert.ok(Object.hasOwn(definitions, name), 'unknown mutation: ' + name)
  const [, file, pattern] = definitions[name]
  const execute = phase => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-mutation-'))
    try {
      writeFileSync(join(home, 'config.json'), '{}')
      const env = { ...process.env, RIVET_HOME: home, RIVET_SESSION_DIR: join(home, 'sessions') }
      delete env.EXPERIMENT_MUTATION
      delete env.NODE_TEST_CONTEXT
      if (phase === 'mutant') env.EXPERIMENT_MUTATION = name
      const r = run ? run(phase, env) : spawnSync(process.execPath, ['--import', 'tsx', ...(phase === 'mutant' ? ['--import', import.meta.filename] : []), '--test', '--test-reporter=tap', '--test-name-pattern=' + pattern, tests + file], {
        encoding: 'utf8', timeout: 100_000, maxBuffer: 4_000_000, windowsHide: true,
        env,
      })
      writeFileSync(join(destination, name + (phase === 'baseline' ? '.baseline.log' : '.log')), r.stdout + r.stderr)
      const cases = tapCases(r)
      assert.ok([...cases.passed, ...cases.failed].every(test => new RegExp(pattern).test(test)), 'expected the selected test names, not a file-level placeholder')
      return { result: r, ...cases }
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
  const baseline = execute('baseline')
  assert.ok(baseline.result.status === 0 && baseline.failed.length === 0, name + ': baseline must be GREEN before testing a mutation')
  const mutant = execute('mutant')
  assert.ok(mutant.result.status === 1 && mutant.failed.length > 0
    && mutant.failed.every(test => baseline.passed.includes(test))
    && JSON.stringify([...mutant.passed, ...mutant.failed].sort()) === JSON.stringify([...baseline.passed].sort())
    && /AssertionError|ERR_ASSERTION/.test(mutant.output) && !mutant.output.includes('mutation anchor missing')
    && mutant.output.includes('MUTATION APPLIED: ' + name), name + ': expected target assertion RED after baseline GREEN; inspect ' + join(destination, name + '.log'))
}

if (!mutation && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const destination = resolve(process.argv[2] ?? '.rivet/research/2026-10-20-v4-validation/mutations')
  mkdirSync(destination, { recursive: true })
  const names = process.argv[3] ? [process.argv[3]] : Object.keys(definitions)
  for (const name of names) {
    verifyMutation(name, destination)
    console.log('BASELINE GREEN -> ASSERTION RED: ' + name)
  }
}
