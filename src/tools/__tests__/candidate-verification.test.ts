import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createVerificationSnapshot } from '../../agent/verification-snapshot.js'
import { openCandidateDeliveryTree } from '../../agent/candidate-delivery-tree.js'
import { candidateSnapshotRef } from '../../agent/candidate-snapshot-ref.js'
import { runTestPhases } from '../run-test-phases.js'
import { runPlannedTests } from '../run-planned-tests.js'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import type { VerificationMetadata } from '../types.js'

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('deliveryFiles verifies current HEAD plus selected edits, excluding peer dirt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-candidate-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 1\n')
    writeFileSync(join(cwd, 'feature.test.mjs'), "import { test } from 'node:test'; import { value } from './feature.mjs'; test('candidate', () => { if (value !== 2) throw Error('wrong value') })\n")
    git(cwd, 'add', '--', 'feature.mjs', 'feature.test.mjs')
    git(cwd, 'commit', '-qm', 'baseline')
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 2\n')
    writeFileSync(join(cwd, 'feature.test.mjs'), "import { test } from 'node:test'; test('peer edit', () => { throw Error('peer dirt') })\n")
    const ref = candidateSnapshotRef(cwd, ['feature.mjs'])
    assert.ok(ref)
    const snapshot = await createVerificationSnapshot({ baseCwd: cwd, sessionId: 'candidate-test', baselineHead: git(cwd, 'rev-parse', 'HEAD'), ownedFiles: ['feature.mjs'] })
    try {
      assert.match(readFileSync(join(snapshot.path, 'feature.mjs'), 'utf8'), /value = 2/)
      assert.match(readFileSync(join(snapshot.path, 'feature.test.mjs'), 'utf8'), /candidate/)
      const result = await runTestPhases({ cwd, toolUseId: 'candidate-test', input: { deliveryFiles: ['feature.mjs'] },
        verificationSnapshot: { path: snapshot.path, snapshotRef: ref, repositoryRoot: cwd, candidateOnly: true } },
      { type: 'run', command: process.execPath, args: ['--test', 'feature.test.mjs'], display: 'node --test feature.test.mjs', runner: 'node', scope: 'targeted', targetFiles: ['feature.test.mjs'] }, undefined, () => 30_000)
      assert.equal(result.isError, false, result.content)
      assert.deepEqual(result.verification?.candidateFiles, ['feature.mjs'])
      assert.equal(result.verification?.snapshotRef, ref)
      assert.equal(result.extraVerifications?.length ?? 0, 0, 'peer-dirty live tree must not be treated as candidate integration')
      assert.match(result.content, /提交候选/)
    } finally { snapshot.destroy() }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('candidate batch planning reads the isolated package script, not a peer edit in the live tree', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-candidate-plan-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 1\n')
    writeFileSync(join(cwd, 'feature.test.mjs'), "import { test } from 'node:test'; import { value } from './feature.mjs'; test('candidate', () => { if (value !== 2) throw Error('wrong value') })\n")
    git(cwd, 'add', '--', 'package.json', 'feature.mjs', 'feature.test.mjs')
    git(cwd, 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 2\n')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node missing-peer-runner.mjs' } }))
    const tree = await openCandidateDeliveryTree(cwd, ['feature.mjs'])
    try {
      const output: string[] = []
      const result = await runPlannedTests({ cwd, toolUseId: 'candidate-plan', input: { files: ['feature.test.mjs'], deliveryFiles: ['feature.mjs'] },
        verificationSnapshot: { path: tree.path, snapshotRef: tree.ref, repositoryRoot: cwd, candidateOnly: true }, onOutput: text => output.push(text) }, () => 30_000)
      assert.equal(result.isError, false, result.content)
      assert.equal(result.verification?.snapshotRef, tree.ref)
      assert.match(output.join(''), /提交候选/)
      assert.doesNotMatch(output.join(''), /missing-peer-runner|\.rivet\/vsw/)
      const full = await RUN_TESTS_TOOL.execute({ cwd, toolUseId: 'candidate-full-plan', input: { deliveryFiles: ['feature.mjs'] },
        verificationSnapshot: { path: tree.path, snapshotRef: tree.ref, repositoryRoot: cwd, candidateOnly: true } })
      assert.equal(full.isError, false, full.content)
      assert.equal(full.verification?.snapshotRef, tree.ref)
    } finally { tree.destroy() }
    const selectedPackage = await openCandidateDeliveryTree(cwd, ['feature.mjs', 'package.json'])
    try {
      const blocked = await runPlannedTests({ cwd, toolUseId: 'candidate-selected-package', input: { files: ['feature.test.mjs'], deliveryFiles: ['feature.mjs', 'package.json'] },
        verificationSnapshot: { path: selectedPackage.path, snapshotRef: selectedPackage.ref, repositoryRoot: cwd, candidateOnly: true } }, () => 30_000)
      assert.equal(blocked.isError, true, 'the selected package.json must change the test entry')
      assert.match(blocked.content, /missing-peer-runner|unknown_runner|无法|不能|脚本/)
    } finally { selectedPackage.destroy() }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('a test that writes the candidate snapshot cannot produce delivery evidence', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-candidate-mutator-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 1\n')
    writeFileSync(join(cwd, 'feature.test.mjs'), "import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('mutates', () => { writeFileSync('feature.mjs', 'export const value = 3\\n') })\n")
    git(cwd, 'add', '--', 'feature.mjs', 'feature.test.mjs')
    git(cwd, 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 2\n')
    const tree = await openCandidateDeliveryTree(cwd, ['feature.mjs'])
    try {
      const result = await runTestPhases({ cwd, toolUseId: 'candidate-mutator', input: { deliveryFiles: ['feature.mjs'] },
        verificationSnapshot: { path: tree.path, snapshotRef: tree.ref, repositoryRoot: cwd, candidateOnly: true } },
      { type: 'run', command: process.execPath, args: ['--test', 'feature.test.mjs'], display: 'node --test feature.test.mjs', runner: 'node', scope: 'targeted', targetFiles: ['feature.test.mjs'] }, undefined, () => 30_000)
      assert.equal(result.isError, true)
      assert.equal(result.verification?.stale, true)
      assert.equal(result.verification?.status, 'blocked')
    } finally { tree.destroy() }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('candidate test failures do not reveal a temporary worktree path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-candidate-output-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 1\n')
    writeFileSync(join(cwd, 'feature.test.mjs'), "import { test } from 'node:test'; test('path', () => { throw Error(process.cwd()) })\n")
    git(cwd, 'add', '--', 'package.json', 'feature.mjs', 'feature.test.mjs')
    git(cwd, 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 2\n')
    const tree = await openCandidateDeliveryTree(cwd, ['feature.mjs'])
    try {
      const streamed: string[] = []
      const result = await runPlannedTests({ cwd, toolUseId: 'candidate-output', input: { deliveryFiles: ['feature.mjs'] },
        verificationSnapshot: { path: tree.path, snapshotRef: tree.ref, repositoryRoot: cwd, candidateOnly: true }, onOutput: chunk => streamed.push(chunk) }, () => 30_000)
      assert.equal(result.isError, true)
      assert.doesNotMatch(result.content + streamed.join(''), /\.rivet\/vsw\/candidate-/)
      assert.match(result.content, /feature\.test\.mjs/)
      assert.match(result.content, /下一步：run_tests\(deliveryFiles=\["feature.mjs"\]\)/)
    } finally { tree.destroy() }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('completed batches record receipts before a later batch is deferred', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-batch-resume-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 1\n')
    const files = Array.from({ length: 21 }, (_, index) => `case-${index}.test.mjs`)
    for (const file of files) writeFileSync(join(cwd, file), "import { test } from 'node:test'; test('ok', () => {})\n")
    git(cwd, 'add', '--', 'package.json', 'feature.mjs', ...files)
    git(cwd, 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'feature.mjs'), 'export const value = 2\n')
    const tree = await openCandidateDeliveryTree(cwd, ['feature.mjs'])
    try {
      const receipts: VerificationMetadata[] = []
      const output: string[] = []
      const result = await runPlannedTests({ cwd, toolUseId: 'batch-resume', input: { files, deliveryFiles: ['feature.mjs'] },
        verificationSnapshot: { path: tree.path, snapshotRef: tree.ref, repositoryRoot: cwd, candidateOnly: true },
        onVerificationCompleted: receipt => receipts.push(receipt), onOutput: chunk => output.push(chunk) },
      () => receipts.length ? 0 : 30_000)
      assert.equal(receipts.length, 1, `${result.content}\n${output.join('')}`)
      assert.equal(result.isError, true)
      assert.equal(receipts[0]?.status, 'passed')
      assert.equal(receipts[0]?.targetFiles?.length, 20)
      assert.match(output.join(''), /验证批次 1\/2/)
      assert.match(result.content, /下一步：run_tests\(files=\["case-20.test.mjs"\], deliveryFiles=\["feature.mjs"\]\)/)
      assert.equal(result.verification?.executionId, receipts[0]?.executionId)
      const controller = new AbortController()
      const cancelledReceipts: VerificationMetadata[] = []
      const cancelled = await runPlannedTests({ cwd, toolUseId: 'batch-cancelled', input: { files, deliveryFiles: ['feature.mjs'] }, abortSignal: controller.signal,
        verificationSnapshot: { path: tree.path, snapshotRef: tree.ref, repositoryRoot: cwd, candidateOnly: true },
        onVerificationCompleted: receipt => { cancelledReceipts.push(receipt); controller.abort() } }, () => 30_000)
      assert.equal(cancelledReceipts.length, 1)
      assert.equal(cancelled.isError, true)
      assert.match(cancelled.content, /已取消/)
      assert.equal(cancelledReceipts[0]?.status, 'passed')
      assert.match(cancelled.content, /下一步：run_tests\(files=\["case-20.test.mjs"\], deliveryFiles=\["feature.mjs"\]\)/)
    } finally { tree.destroy() }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('candidate typecheck receipt requires config coverage and a successful local tsc run', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-typecheck-candidate-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    mkdirSync(join(cwd, 'src'))
    symlinkSync(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir')
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src'] }))
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const value: number = 1\n')
    git(cwd, 'add', '--', 'tsconfig.json', 'src/a.ts')
    git(cwd, 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const value: number = 2\n')
    const tree = await openCandidateDeliveryTree(cwd, ['src/a.ts'])
    try {
      const result = await RUN_TESTS_TOOL.execute({ cwd, toolUseId: 'candidate-typecheck', input: { deliveryFiles: ['src/a.ts'], check: 'typecheck' },
        verificationSnapshot: { path: tree.path, repositoryRoot: cwd, snapshotRef: tree.ref, candidateOnly: true } })
      assert.equal(result.isError, false, result.content)
      assert.equal(result.verification?.kind, 'typecheck')
      assert.equal(result.verification?.candidateTypecheckComplete, true)
      assert.equal(result.verification?.snapshotRef, tree.ref)

      const uncovered = await RUN_TESTS_TOOL.execute({ cwd, toolUseId: 'candidate-typecheck-blocked', input: { deliveryFiles: ['outside.ts'], check: 'typecheck' },
        verificationSnapshot: { path: tree.path, repositoryRoot: cwd, snapshotRef: tree.ref, candidateOnly: true } })
      assert.equal(uncovered.verification?.status, 'blocked')
    } finally { tree.destroy() }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
