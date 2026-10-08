import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareCompletionCapture } from '../../tools/test-completion.js'
import { classifyVerificationCommand, shellWord } from '../../tools/verification-command.js'
import { inferBashVerificationScope } from '../bash-verification.js'
import { assessImpactedTestCoverage, createVerificationAttribution, getEffectiveVerifications } from '../verification-attribution.js'
import { createPersistentTaskState } from '../task-state-persist.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createDeliverTaskTool } from '../deliver-task.js'
import { runVerification } from './helpers/verification-pipeline-fixture.js'
import type { VerificationMetadata } from '../../tools/types.js'

const repo = resolve(import.meta.dirname, '../../..')
const loader = 'tsx'
function receiptDirectory(command: string): string {
  const path = command.match(/--test-reporter=([^'"]+\.mjs)/)?.[1]
  assert.ok(path, 'completion capture must register its reporter')
  return join(path.startsWith('file:') ? fileURLToPath(path) : path, '..')
}
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'completion-proof-'))
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd })
  writeFileSync(join(cwd, '.gitignore'), '._*\n.DS_Store\nnode_modules/\n')
  const write = (file: string, source: string) => { mkdirSync(join(cwd, file, '..'), { recursive: true }); writeFileSync(join(cwd, file), source) }
  write('feature.js', 'export const feature = 1;')
  write('src/alpha.test.ts', "import {test} from 'node:test'; test('alpha',()=>{}); test('delayed',async()=>{await new Promise(r=>setTimeout(r,20))});")
  write('src/beta.test.ts', "import {test} from 'node:test'; test('beta',()=>{});")
  symlinkSync(join(repo, 'node_modules'), join(cwd, 'node_modules'), 'junction')
  return { cwd, write, dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}
function execute(cwd: string, command: string) {
  const capture = prepareCompletionCapture(command, cwd, process.platform === 'win32' ? 'cmd' : 'bash')
  assert.ok(capture, command)
  try {
    const result = spawnSync(capture.command, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, ...capture.env }, timeout: 15_000 })
    const coverage = capture.read(result.status ?? -1)!
    return { coverage, result, meta: { command, status: result.status === 0 ? 'passed' : 'failed', scope: 'full', kind: 'test', exitCode: result.status ?? -1, coverage } as VerificationMetadata }
  } finally { capture.dispose() }
}

it('argv normalization handles wrappers/loaders/Windows paths without loader targets', () => {
  for (const prefix of ['', 'rtk ', 'rtk proxy ']) for (const loader of ['--import tsx', '--import=tsx', '--require loader.js', '--require=loader.js']) {
    const value = inferBashVerificationScope(`${prefix}node ${loader} --test "src/space name.test.ts"`)
    assert.deepEqual(value, { kind: 'test', scope: 'targeted', targetFiles: ['src/space name.test.ts'] })
  }
  assert.equal(inferBashVerificationScope('"C:\\Program Files\\node.exe" --import tsx --test "src/a.test.ts"').kind, 'test')
  for (const command of ['rtk rtk node --test a.test.ts', 'custom node --test a.test.ts', 'node --test | tail', 'node --test $(echo x)', 'node --test --unknown']) assert.equal(inferBashVerificationScope(command).scope, 'unknown', command)
  assert.equal(inferBashVerificationScope('node --test > out').scope, 'full')
  assert.equal(inferBashVerificationScope('cd repo && rtk node --test').scope, 'full')
  for (const option of ['--test-name-pattern=x', '--test-skip-pattern x']) assert.equal(classifyVerificationCommand(`rtk node --test ${option} a.test.ts`).filtered, true)
})

it('actual completion covers glob targets, not discovery or same-name files in another suite', () => {
  const f = fixture()
  try {
    const { meta, coverage } = execute(f.cwd, `node --import ${loader} --test "src/*.test.ts"`)
    assert.equal(coverage.complete, true)
    assert.deepEqual(coverage.files.map(file => file.path).sort(), ['src/alpha.test.ts', 'src/beta.test.ts'])
    assert.deepEqual(assessImpactedTestCoverage(['src/alpha.test.ts', 'desktop/src/alpha.test.ts'], [meta], () => true, f.cwd).uncovered, ['desktop/src/alpha.test.ts'])
    assert.deepEqual(assessImpactedTestCoverage(['src/alpha.test.ts'], [meta], () => true, '/different').uncovered, ['src/alpha.test.ts'])
    assert.deepEqual(assessImpactedTestCoverage(['src/alpha.test.ts'], [{ ...meta, coverage: { ...coverage, complete: false } }], () => true).uncovered, ['src/alpha.test.ts'])
    assert.deepEqual(assessImpactedTestCoverage(['src/alpha.test.ts'], [{ ...meta, coverage: undefined, targetFiles: ['src/alpha.test.ts'] }], () => true).uncovered, ['src/alpha.test.ts'])
    f.write('desktop/src/alpha.test.ts', "import {test} from 'node:test';test('desktop alpha',()=>{});")
    const desktop = execute(join(f.cwd, 'desktop'), `node --import ${loader} --test src/alpha.test.ts`)
    assert.deepEqual(assessImpactedTestCoverage(['src/alpha.test.ts'], [desktop.meta], () => true, join(f.cwd, 'desktop')).uncovered, [])
    assert.deepEqual(assessImpactedTestCoverage(['src/alpha.test.ts'], [desktop.meta], () => true, f.cwd).uncovered, ['src/alpha.test.ts'])
  } finally { f.dispose() }
})

it('filesystem metadata beside completion receipts does not count as another runner', () => {
  const f = fixture()
  const capture = prepareCompletionCapture('node --test src/alpha.test.ts', f.cwd, process.platform === 'win32' ? 'cmd' : 'bash')!
  try {
    const result = spawnSync(capture.command, { cwd: f.cwd, shell: true, encoding: 'utf8', env: { ...process.env, ...capture.env }, timeout: 15_000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    writeFileSync(join(receiptDirectory(capture.command), '._another.start'), 'filesystem metadata')
    const coverage = capture.read(result.status!)!
    assert.equal(coverage.workspaceChanged, false)
    assert.equal(coverage.executionComplete, true)
    assert.equal(coverage.complete, true)
    assert.deepEqual(coverage.files.map(file => file.path), ['src/alpha.test.ts'])
  } finally { capture.dispose(); f.dispose() }
})

it('a transparent rtk proxy may drop all presentation output without losing proof', { skip: process.platform === 'win32' }, () => {
  const f = fixture()
  try {
    f.write('bin/rtk', "#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='proxy')a.shift();const r=spawnSync(a[0],a.slice(1),{env:process.env,cwd:process.cwd()});console.log('compressed output');process.exit(r.status??1);")
    execFileSync('chmod', ['+x', join(f.cwd, 'bin/rtk')])
    const { meta, result } = execute(f.cwd, `${shellWord(join(f.cwd, 'bin/rtk'))} proxy node --import ${loader} --test src/alpha.test.ts`)
    assert.match(result.stdout, /compressed/)
    assert.equal(meta.coverage?.complete, true)
    assert.deepEqual(assessImpactedTestCoverage(['src/alpha.test.ts'], [meta], () => true).uncovered, [])
  } finally { f.dispose() }
})

it('zero, skipped, todo and failed files cannot discharge obligations', () => {
  const f = fixture()
  try {
    for (const [name, body] of [['empty', ''], ['skip', "test.skip('skip',()=>{});"], ['todo', "test.todo('todo');"], ['fail', "test('fail',()=>{throw Error('red')});"], ['cancel', "test('cancel',async()=>await new Promise(()=>{}));"]]) {
      f.write(`src/${name}.test.ts`, "import {test} from 'node:test';" + body)
      const { meta, result } = execute(f.cwd, `node --import ${loader} --test ${name === 'cancel' ? '--test-timeout=200 ' : ''}src/${name}.test.ts`)
      assert.equal(result.error, undefined, `${name}: runner must settle before fixture cleanup`)
      if (name === 'cancel') {
        assert.equal(meta.coverage?.executionComplete, true, name)
        assert.equal(meta.coverage?.totals?.cancelled, 1)
      }
      assert.deepEqual(assessImpactedTestCoverage([`src/${name}.test.ts`], [meta], () => true).uncovered, [`src/${name}.test.ts`], name)
    }
    assert.equal(prepareCompletionCapture(`node --test --test-name-pattern=x src/alpha.test.ts`, f.cwd), undefined)
  } finally { f.dispose() }
})

it('missing/foreign completion receipts, changed snapshots and timeouts fail closed', () => {
  const f = fixture()
  try {
    const capture = prepareCompletionCapture(`node --import ${loader} --test src/alpha.test.ts`, f.cwd, process.platform === 'win32' ? 'cmd' : 'bash')!
    assert.equal(capture.read(0)?.complete, false, 'discovery without execution')
    const result = spawnSync(capture.command, { cwd: f.cwd, shell: true, env: { ...process.env, ...capture.env }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(capture.read(0)?.complete, true)
    f.write('feature.js', 'export const feature = 2;')
    assert.equal(capture.read(0)?.complete, false, 'external source edit')
    assert.equal(capture.read(-1)?.complete, false, 'timeout')
    f.write('feature.js', 'export const feature = 1;')
    assert.equal(capture.read(0)?.complete, true, 'fresh again before foreign-receipt check')
    const dir = receiptDirectory(capture.command)
    const receiptName = readdirSync(dir).find(n => !n.startsWith('._') && n.endsWith('.json') && n !== 'seal.json')!
    const path = join(dir, receiptName)
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    receipt.runId = 'previous-run'
    writeFileSync(path, JSON.stringify(receipt))
    assert.equal(capture.read(0)?.complete, false)
    capture.dispose()
  } finally { f.dispose() }
})

it('bash and run_tests carry proof through tool pipeline, ledger and EvidenceTracker', async () => {
  for (const tool of ['bash', 'run_tests'] as const) {
    const run = await runVerification(tool === 'bash' ? 'node --test good.test.mjs' : 'good.test.mjs', false, false, { tool })
    assert.equal(run.actual.verification?.coverage?.complete, true, tool)
    assert.equal(run.verification.coverage?.complete, true, tool)
    const effective = getEffectiveVerifications(run.ledger.getVerifications()).effective
    assert.equal(effective[0]?.coverage?.complete, true, tool)
    assert.deepEqual(assessImpactedTestCoverage(['good.test.mjs'], effective, () => true).uncovered, [], tool)
  }
})

it('bash and run_tests preserve completion proof under a Unicode temporary directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'completion-中文-'))
  const key = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
  const previous = process.env[key]
  process.env[key] = directory
  try {
    for (const tool of ['bash', 'run_tests'] as const) {
      const run = await runVerification(tool === 'bash' ? 'node --test good.test.mjs' : 'good.test.mjs', false, false, { tool })
      assert.equal(run.actual.verification?.exitCode, 0, run.actual.content)
      assert.equal(run.actual.verification?.coverage?.executionComplete, true, tool)
      assert.equal(run.actual.verification?.coverage?.complete, true, tool)
      assert.deepEqual(run.actual.verification?.coverage?.files.map(file => file.path), ['good.test.mjs'], tool)
    }
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

it('supported package/root batch runners seal actual results; names do not grant coverage', () => {
  const f = fixture()
  try {
    f.write('package.json', JSON.stringify({ scripts: { test: 'node --test', 'test:desktop': 'node -e "process.exit(0)"' } }))
    const direct = execute(f.cwd, `npm test -- --import ${loader} src/alpha.test.ts`)
    assert.equal(direct.meta.coverage?.complete, true, direct.result.stderr)
    assert.equal(prepareCompletionCapture('npm run test:desktop', f.cwd), undefined)
    const root = execute(f.cwd, `node --import ${loader} ${shellWord(join(repo, 'scripts/run-node-tests.ts'))} src/alpha.test.ts`)
    assert.equal(root.coverage.complete, true, root.result.stderr + root.result.stdout)
    assert.deepEqual(root.coverage.files.map(file => file.path), ['src/alpha.test.ts'])
  } finally { f.dispose() }
})

it('receipt persists and deduplicates without runId, and commits exactly once only after all required files pass', async () => {
  const f = fixture(), previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = join(f.cwd, '.sessions')
  try {
    const baseline = { branch: 'main', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim(), preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
    const state = createPersistentTaskState(f.cwd, 'completion-fixture', baseline)
    state.taskLedger.record({ type: 'file_write', path: 'feature.js' })
    const { meta } = execute(f.cwd, `node --import ${loader} --test src/alpha.test.ts src/beta.test.ts`)
    for (const runId of ['first', 'second']) state.taskLedger.record({ type: 'verification', command: 'node --test', status: 'passed', meta: { ...meta, coverage: { ...meta.coverage!, runId } } })
    const restored = createPersistentTaskState(f.cwd, 'completion-fixture', baseline)
    assert.equal(restored.recovery, 'restored')
    assert.equal(getEffectiveVerifications(restored.taskLedger.getVerifications()).effective.length, 1)
    const gate = createDeliveryGateV2({ taskLedger: restored.taskLedger, ownership: restored.ownership, attribution: createVerificationAttribution({ ownership: restored.ownership }) })
    let calls = 0, required = ['src/alpha.test.ts', 'src/beta.test.ts']
    const tool = createDeliverTaskTool(() => ({ ...restored, gate, getCurrentDirtyFiles: () => ['feature.js'], getImpactedTests: () => required, detectWroteButNeverRead: () => [], commitOwnedFiles: () => { calls++; return { ok: true, output: 'mock commit' } } }))
    const params = { cwd: f.cwd, toolUseId: 'completion-commit', input: { commit: true, message: 'fix: fixture', force: true } }
    assert.notEqual((await tool.execute(params)).isError, true)
    assert.equal(calls, 1)
    required = [...required, 'src/missing.test.ts']; f.write('src/missing.test.ts', '')
    assert.equal((await tool.execute(params)).isError, true)
    assert.equal(calls, 1)
    required = ['src/alpha.test.ts']
    const failed = { ...meta.coverage!, runId: 'failed', complete: false, files: [{ path: 'src/alpha.test.ts', outcome: 'failed' as const, tests: 1, skipped: 0, cancelled: 0 }] }
    restored.taskLedger.record({ type: 'verification', command: 'node --test src/alpha.test.ts', status: 'failed', meta: { kind: 'test', scope: 'full', exitCode: 1, coverage: failed } })
    assert.equal((await tool.execute(params)).isError, true)
    assert.equal(calls, 1)
  } finally { if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous; f.dispose() }
})
