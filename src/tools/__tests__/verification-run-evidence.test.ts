import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { prepareCompletionCapture } from '../test-completion.js'
import { shellWord } from '../verification-command.js'
import { completionFacts } from '../verification-facts.js'
import { SessionJobs } from '../job-store.js'
import { BASH_TOOL } from '../bash.js'
import type { VerificationMetadata } from '../types.js'
import { createPersistentTaskState } from '../../agent/task-state-persist.js'
import { createVerificationRecorder } from '../../agent/verification-recorder.js'
import { EvidenceTracker } from '../../agent/evidence.js'
import { getEffectiveVerifications } from '../../agent/verification-attribution.js'
import { buildBashVerification } from '../../agent/bash-verification.js'

const repo = resolve(import.meta.dirname, '../../..')
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'verification-run-'))
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd })
  symlinkSync(join(repo, 'node_modules'), join(cwd, 'node_modules'), 'junction')
  return { cwd, dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}

it('multi-batch totals survive compressed output, output clipping and repeated failure excerpts', () => {
  const f = fixture()
  try {
    const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href
    const script = ['node', '--import', loader, join(repo, 'scripts/run-node-tests.ts')]
      .map(word => process.platform === 'win32' ? word : shellWord(word)).join(' ')
    writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: script } }))
    for (let i = 0; i < 55; i++) {
      const directory = join(f.cwd, 'src', ...Array.from({ length: 4 }, (_, j) => `${j}-${'a'.repeat(150)}`), String(i))
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'example.test.ts'), `import {test} from 'node:test'; console.log('x'.repeat(3000));test('fixture',()=>{${i === 0 ? "throw Error('red')" : ''}});`)
    }
    const capture = prepareCompletionCapture('npm test', f.cwd)!
    assert.ok(capture)
    try {
      const result = spawnSync(capture.command, { cwd: f.cwd, shell: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000, env: { ...process.env, ...capture.env } })
      assert.equal(result.status, 1, result.stderr)
      assert.ok(result.stdout.length > 100_000)
      const facts = completionFacts(capture.read(result.status!))
      assert.equal(facts.countsReliable, true)
      assert.equal(facts.passed, 54)
      assert.equal(facts.failed, 1)
      assert.equal(facts.coverage?.files.length, 55)
      assert.equal(facts.coverage?.complete, false)
      assert.equal(facts.coverage?.executionComplete, true)
    } finally { capture.dispose() }
  } finally { f.dispose() }
})

it('the original RTK shell wrapper retains structured proof even when stdout is discarded', { skip: process.platform === 'win32' }, () => {
  const f = fixture()
  try {
    mkdirSync(join(f.cwd, 'bin'))
    const rtk = join(f.cwd, 'bin/rtk')
    writeFileSync(rtk, "#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='proxy')a.shift();const r=spawnSync(a[0],a.slice(1),{env:process.env,cwd:process.cwd()});console.log('compressed');process.exit(r.status??1);")
    execFileSync('chmod', ['+x', rtk])
    writeFileSync(join(f.cwd, 'example.test.mjs'), "import {test} from 'node:test';test('yes',()=>{});")
    writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    const capture = prepareCompletionCapture(`${rtk} proxy bash -c 'cd ${f.cwd} && npm test'`, repo)!
    assert.ok(capture)
    try {
      const result = spawnSync(capture.command, { cwd: repo, shell: true, encoding: 'utf8', env: { ...process.env, ...capture.env }, timeout: 15_000 })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), 'compressed')
      const facts = completionFacts(capture.read(0))
      assert.equal(facts.passed, 1, JSON.stringify(facts))
      assert.equal(facts.coverage?.complete, true)
      writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test example.test.mjs' } }))
      assert.equal(prepareCompletionCapture('npm test', f.cwd), undefined, 'fixed targets must not silently suppress reporter options')
    } finally { capture.dispose() }
  } finally { f.dispose() }
})

it('pattern/await timeout do not record completion; kill preserves interruption and records once', async () => {
  const f = fixture(), logs = mkdtempSync(join(tmpdir(), 'verification-job-logs-'))
  const jobs = new SessionJobs(logs)
  try {
    writeFileSync(join(f.cwd, 'example.test.mjs'), "import {test} from 'node:test';test('pending',async()=>{console.log('Ready');await new Promise(r=>setTimeout(r,10000));});")
    const records: VerificationMetadata[] = []
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'lifecycle', input: { command: 'node --test example.test.mjs', run_in_background: true }, jobs, onVerificationCompleted: v => records.push(v) })
    const id = result.backgroundJobId!
    const ready = await jobs.await(id, { pattern: 'Ready', timeoutMs: 5000 })
    assert.equal(ready?.matched, true)
    assert.equal(records.length, 0)
    assert.equal((await jobs.await(id, { timeoutMs: 5 }))?.timedOut, true)
    assert.equal(records.length, 0)
    const exited = new Promise<void>(resolve => jobs.on('event', event => { if (event.kind === 'exit') resolve() }))
    assert.equal(jobs.kill(id), true)
    await exited
    assert.equal(records.length, 1)
    assert.notEqual(records[0]!.status, 'passed')
    assert.equal(records[0]!.coverage?.complete, false)
    assert.equal(records[0]!.countsReliable, false)
    await jobs.await(id, { timeoutMs: 1 }); jobs.logs(id)
    assert.equal(records.length, 1)
  } finally { jobs.killAll(); f.dispose(); rmSync(logs, { recursive: true, force: true }) }
})

it('background results bind to execution time and preserve edits made while running after recovery', async () => {
  const f = fixture(), logs = mkdtempSync(join(tmpdir(), 'verification-version-'))
  const previous = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = logs
  const jobs = new SessionJobs(logs)
  try {
    writeFileSync(join(f.cwd, 'feature.js'), 'export const value = 1;')
    writeFileSync(join(f.cwd, 'version.test.mjs'), "import {test} from 'node:test';test('version',async()=>{console.log('Ready');await new Promise(r=>setTimeout(r,400));});")
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim()
    const baseline = { branch: 'main', head, preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
    const state = createPersistentTaskState(f.cwd, 'version', baseline)
    assert.equal(state.recovery, 'baseline_missing')
    state.taskLedger.record({ type: 'file_write', path: 'feature.js' })
    const evidence = new EvidenceTracker()
    evidence.trackFileModified('feature.js')
    const record = createVerificationRecorder({ taskLedger: state.taskLedger, evidence })
    const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'version', input: { command: 'node --test version.test.mjs', run_in_background: true }, jobs, onVerificationCompleted: record })
    const id = result.backgroundJobId!
    assert.equal((await jobs.await(id, { pattern: 'Ready', timeoutMs: 5000 }))?.matched, true)
    writeFileSync(join(f.cwd, 'feature.js'), 'export const value = 2;')
    evidence.trackFileModified('feature.js')
    await jobs.await(id, { timeoutMs: 5000 })
    const v = evidence.getState().verifications.at(-1)!
    assert.equal(v.status, 'passed', 'actual execution remains passed')
    assert.equal(v.passed, 1)
    assert.equal(v.stale, true, 'cannot prove the new code')
    assert.equal(v.coverage?.executionComplete, true)
    assert.equal(v.coverage?.complete, false)
    assert.equal(evidence.getGateState().editsSinceLastTest, 2, 'stale completion cannot clear verification debt')
    const restored = createPersistentTaskState(f.cwd, 'version', baseline)
    assert.equal(getEffectiveVerifications(restored.taskLedger.getVerifications()).effective.length, 0)
  } finally { jobs.killAll(); if (previous === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previous; f.dispose(); rmSync(logs, { recursive: true, force: true }) }
})

it('spawn error and close settle once, and lifetime termination preserves timeout', async () => {
  const f = fixture(), logs = mkdtempSync(join(tmpdir(), 'verification-error-'))
  const jobs = new SessionJobs(logs)
  try {
    let completed = 0
    const failed = new Promise<void>(resolve => jobs.on('event', event => { if (event.kind === 'exit') resolve() }))
    jobs.spawn({ command: 'node --version', rawCommand: 'node --version', cwd: join(f.cwd, 'missing'), env: process.env, onCompleted: result => { completed++; assert.ok(result.error) } })
    await failed
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(completed, 1)
    writeFileSync(join(f.cwd, 'timeout.test.mjs'), "import {test} from 'node:test';test('timeout',async()=>await new Promise(r=>setTimeout(r,10000)));")
    const records: VerificationMetadata[] = []
    const registry = { spawn: (opts: Parameters<SessionJobs['spawn']>[0]) => jobs.spawn({ ...opts, maxLifetimeMs: 100 }), await: jobs.await.bind(jobs), logs: jobs.logs.bind(jobs), list: jobs.list.bind(jobs), kill: jobs.kill.bind(jobs) }
    const exit = new Promise<void>(resolve => jobs.on('event', event => { if (event.kind === 'exit' && event.job.command.includes('timeout.test')) resolve() }))
    await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'timeout', input: { command: 'node --test timeout.test.mjs', run_in_background: true }, jobs: registry, onVerificationCompleted: v => records.push(v) })
    await exit
    assert.equal(records.length, 1)
    assert.equal(records[0]?.failureKind, 'timeout')
    assert.equal(records[0]?.countsReliable, false)
  } finally { jobs.killAll(); f.dispose(); rmSync(logs, { recursive: true, force: true }) }
})

it('background exit facts override replayed failure text; non-test checks never manufacture counts', async () => {
  const f = fixture(), logs = mkdtempSync(join(tmpdir(), 'verification-exit-'))
  const jobs = new SessionJobs(logs)
  try {
    writeFileSync(join(f.cwd, 'text.test.mjs'), "import {test} from 'node:test';test('real pass',()=>console.log('# fail 9'));")
    writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ scripts: { lint: `node -e "console.log('# fail 9')"` } }))
    const foreground = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'foreground-exit', input: { command: 'node --test text.test.mjs' } })
    assert.equal(buildBashVerification('node --test text.test.mjs', foreground, { content: foreground.content as string, isError: !!foreground.isError }).status, 'passed')
    for (const command of ['node --test text.test.mjs', 'npm run lint']) {
      const records: VerificationMetadata[] = []
      const result = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'exit-facts', input: { command, run_in_background: true }, jobs, onVerificationCompleted: v => records.push(v) })
      await jobs.await(result.backgroundJobId!, { timeoutMs: 5000 })
      assert.equal(records.length, 1)
      assert.equal(records[0]?.status, 'passed')
      if (command.includes('--test')) { assert.equal(records[0]?.failed, 0); assert.equal(records[0]?.passed, 1) }
      else { assert.equal(records[0]?.kind, 'lint'); assert.equal(records[0]?.passed, undefined); assert.equal(records[0]?.failed, undefined); assert.equal(records[0]?.coverage, undefined) }
    }
    const unknown: VerificationMetadata[] = []
    const complex = await BASH_TOOL.execute({ cwd: f.cwd, toolUseId: 'complex', input: { command: 'node --test text.test.mjs | cat', run_in_background: true }, jobs, onVerificationCompleted: v => unknown.push(v) })
    await jobs.await(complex.backgroundJobId!, { timeoutMs: 5000 })
    assert.match(complex.content as string, /无法自动获取完整证明/)
    assert.notEqual(unknown[0]?.status, 'passed')
    assert.equal(unknown[0]?.coverage, undefined)
  } finally { jobs.killAll(); f.dispose(); rmSync(logs, { recursive: true, force: true }) }
})
