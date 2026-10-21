import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import { createDeliverTaskTool } from '../deliver-task.js'
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianDb } from '../../repo/meridian-db.js'
import { MeridianIndexer } from '../../repo/meridian-indexer.js'
import { analyzeImpact } from '../../repo/meridian-impact.js'
import { resolveDeliveryImpact } from '../delivery-impact.js'

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'required-impact-'))
  const write = (path: string, source: string) => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), source) }
  return { cwd, write, dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}

it('both impact paths exclude helpers and preserve tests reached through them', async () => {
  const f = fixture()
  execFileSync('git', ['init', '-q'], { cwd: f.cwd })
  const indexer = new MeridianIndexer(f.cwd)
  try {
    f.write('src/feature.ts', 'export const feature = 1;')
    f.write('src/fixture.ts', 'export const fixture = 1;')
    f.write('src/__tests__/helpers/fixture.ts', "import '../../feature.js'; export const fixture = 1;")
    f.write('src/__tests__/consumer.test.ts', "import './helpers/fixture.js';")
    for (const source of ['src/feature.ts', 'src/__tests__/helpers/fixture.ts']) {
      for (const active of [undefined, indexer]) {
        const impact = await resolveDeliveryImpact(f.cwd, [source], active)
        assert.equal(impact.resolved, true, impact.reason)
        assert.deepEqual(impact.requiredTests, ['src/__tests__/consumer.test.ts'])
        assert.ok(!impact.advisoryTests.includes('src/__tests__/helpers/fixture.ts'))
      }
    }
    f.write('src/__tests__/helpers/fixture.ts', 'export const fixture = 1;')
    for (const update of [false, true]) {
      await indexer.indexFile('src/__tests__/helpers/fixture.ts')
      if (update) await indexer.invalidateFile('src/__tests__/helpers/fixture.ts')
      assert.deepEqual(indexer.getDb().getTestsFor('src/fixture.ts'), [])
    }
  } finally { indexer.close(); f.dispose() }
})

it('ambiguous calls stay advisory; extracted edges beyond an advisory path never become required', () => {
  const f = fixture(), db = new MeridianDb(join(f.cwd, '.rivet'))
  try {
    db.upsertEdge('desktop/HomeWelcome.tsx:render:1', 'src/session.ts:session:1', 'calls', 1, 'ambiguous')
    db.upsertEdge('desktop/check-boundary.test.ts:check:1', 'desktop/HomeWelcome.tsx:render:1', 'calls', 1, 'ambiguous')
    db.upsertEdge('desktop/further.test.ts:check:1', 'desktop/HomeWelcome.tsx:render:1', 'imports', 1, 'extracted')
    db.upsertEdge('src/real.test.ts:check:1', 'src/session.ts:session:1', 'imports', 1, 'extracted')
    db.upsertEdge('src/named.test.ts:*:0', 'src/session.ts:*:0', 'tested_by', 1, 'extracted')
    db.recordCoEdit('src/session.ts', 'src/co-edit.test.ts', 1)
    const impact = analyzeImpact(db, ['src/session.ts'])
    assert.deepEqual(impact.requiredTests, ['src/real.test.ts'])
    for (const path of ['desktop/check-boundary.test.ts', 'desktop/further.test.ts', 'src/named.test.ts', 'src/co-edit.test.ts']) assert.ok(impact.advisoryTests?.includes(path), path)
    assert.equal(impact.reasons?.['desktop/check-boundary.test.ts']?.[0]?.confidence, 'ambiguous')
    db.upsertEdge('desktop/further.test.ts:check:1', 'src/session.ts:session:1', 'calls', 1, 'extracted')
    const mixed = analyzeImpact(db, ['src/session.ts'])
    assert.ok(mixed.requiredTests?.includes('desktop/further.test.ts'))
    assert.ok(!mixed.advisoryTests?.includes('desktop/further.test.ts'))
    assert.equal(mixed.reasons?.['desktop/further.test.ts']?.[0]?.confidence, 'extracted')
    assert.equal(mixed.policyVersion, 1)
  } finally { db.close(); f.dispose() }
})

it('fresh reconciliation finds new importers, removes deleted files and repairs symbol-free imports', async () => {
  const f = fixture()
  execFileSync('git', ['init', '-q'], { cwd: f.cwd })
  const indexer = new MeridianIndexer(f.cwd)
  try {
    f.write('src/feature.ts', 'export const feature = 1;')
    f.write('src/feature.test.ts', "import './feature.js';")
    const first = await resolveDeliveryImpact(f.cwd, ['src/feature.ts'], indexer)
    assert.equal(first.resolved, true, first.reason)
    assert.deepEqual(first.requiredTests, ['src/feature.test.ts'])
    f.write('src/new.test.ts', "import './feature.js'; export const check = 1;")
    const second = await resolveDeliveryImpact(f.cwd, ['src/feature.ts'], indexer)
    assert.deepEqual(second.requiredTests, ['src/feature.test.ts', 'src/new.test.ts'])
    rmSync(join(f.cwd, 'src/new.test.ts'))
    f.write('src/feature.test.ts', 'export const independent = 1;')
    const third = await resolveDeliveryImpact(f.cwd, ['src/feature.ts'], indexer)
    assert.deepEqual(third.requiredTests, [])
    assert.deepEqual((await resolveDeliveryImpact(f.cwd, ['src/feature.test.ts'], indexer)).requiredTests, ['src/feature.test.ts'])
  } finally { indexer.close(); f.dispose() }
})

it('complete static fallback preserves real imports; unavailable/truncated analysis remains unresolved', async () => {
  const f = fixture()
  try {
    f.write('feature.ts', 'export const feature = 1;')
    f.write('consumer.test.ts', "import './feature.js';")
    const impact = await resolveDeliveryImpact(f.cwd, ['feature.ts'])
    assert.equal(impact.resolved, true)
    assert.deepEqual(impact.requiredTests, ['consumer.test.ts'])
    assert.equal(impact.reasons?.['consumer.test.ts']?.[0]?.kind, 'imports')
    for (let i = 0; i < 1001; i++) f.write(`many/${i}.ts`, 'export {};')
    const unresolved = await resolveDeliveryImpact(f.cwd, ['feature.ts'])
    assert.equal(unresolved.resolved, false)
    assert.match(unresolved.reason ?? '', /impact_unresolved/)
    assert.equal((await resolveDeliveryImpact(join(f.cwd, 'missing'), ['feature.ts'])).resolved, false)
  } finally { f.dispose() }
})

it('index and fallback agree on conditional type-only impact for the verified candidate', async () => {
  const f = fixture()
  execFileSync('git', ['init', '-q'], { cwd: f.cwd })
  const indexer = new MeridianIndexer(f.cwd)
  try {
    f.write('feature.ts', 'export interface Feature { value: number }; export const value = 1')
    f.write('type.test.ts', "import type { Feature } from './feature.js'; type Check = Feature; export const check = 1")
    f.write('runtime.test.ts', "import { value } from './feature.js'; export const check = value")
    f.write('tsconfig.json', JSON.stringify({ compilerOptions: { noEmit: true }, include: ['*.ts'] }))
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: f.cwd })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: f.cwd })
    execFileSync('git', ['add', '--', 'tsconfig.json'], { cwd: f.cwd })
    execFileSync('git', ['commit', '-qm', 'config'], { cwd: f.cwd })
    const proof = { candidateRef: 'candidate-a', verifiedRef: 'candidate-a', passed: true, complete: true, candidateFiles: ['feature.ts', 'type.test.ts'] }
    for (const active of [indexer, undefined]) {
      const withoutProof = await resolveDeliveryImpact(f.cwd, ['feature.ts'], active)
      assert.deepEqual(withoutProof.requiredTests, ['runtime.test.ts', 'type.test.ts'])
      const withProof = await resolveDeliveryImpact(f.cwd, ['feature.ts'], active, proof)
      assert.equal(withProof.resolved, true, withProof.reason)
      assert.deepEqual(withProof.requiredTests, ['runtime.test.ts'])
      assert.deepEqual(withProof.advisoryTests, ['type.test.ts'])
      assert.equal(withProof.policyVersion, 2)
      const stale = await resolveDeliveryImpact(f.cwd, ['feature.ts'], active, { ...proof, verifiedRef: 'older-tree' })
      assert.deepEqual(stale.requiredTests, ['runtime.test.ts', 'type.test.ts'])
    }
  } finally { indexer.close(); f.dispose() }
})

it('delivery awaits fresh impact for dirty owned/coOwned, excludes history, and refuses unresolved analysis', async () => {
  const f = fixture()
  try {
    f.write('feature.js', 'export const feature = 1;')
    f.write('co.js', 'export const co = 1;')
    f.write('consumer.test.ts', '// fixture')
    f.write('old-uncovered.test.ts', '// advisory fixture must exist to detect accidental legacy gating')
    const ledger = createTaskLedger({ taskId: 'impact-consumer' })
    const ownership = createOwnershipLedger({ taskLedger: ledger, baseline: createWorktreeBaseline({ branch: 'main', head: 'fixture', capturedAt: Date.now(), preExistingDirty: ['co.js'], preExistingUntracked: [] }) })
    for (const path of ['feature.js', 'co.js', 'historical.js']) ledger.record({ type: 'file_write', path })
    ownership.autoOwnFromLedger()
    assert.ok(ownership.isCoOwned('co.js'))
    ledger.record({ type: 'verification', command: 'node --test consumer.test.ts', status: 'passed', meta: { kind: 'test', scope: 'targeted', exitCode: 0, coverage: { version: 1, runId: 'fixture', runner: 'node-test', cwd: f.cwd, repositoryRoot: f.cwd, complete: true, filtered: false, files: [{ path: 'consumer.test.ts', outcome: 'passed', tests: 1, skipped: 0, cancelled: 0 }] } } })
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })
    let calls = 0, resolved = true, seen = 0
    const tool = createDeliverTaskTool(() => ({ taskLedger: ledger, ownership, gate, getCurrentDirtyFiles: () => ['feature.js', 'co.js'], getImpactedTests: () => ['old-uncovered.test.ts'], resolveDeliveryImpact: async (_cwd, files) => { await new Promise(r => setTimeout(r, 10)); seen++; assert.deepEqual([...files].sort(), ['co.js', 'feature.js']); return { resolved, requiredTests: ['consumer.test.ts'], advisoryTests: ['old-uncovered.test.ts'], reason: 'impact_unresolved', policyVersion: 1 } }, detectWroteButNeverRead: () => [], commitOwnedFiles: () => { calls++; return { ok: true, output: 'mock commit' } } }))
    const params = { cwd: f.cwd, toolUseId: 'impact-consumer', input: { commit: true, message: 'fix: fixture', force: true } }
    assert.notEqual((await tool.execute(params)).isError, true)
    assert.equal(seen, 1)
    assert.equal(calls, 1)
    resolved = false
    const rejected = await tool.execute(params)
    assert.equal(rejected.isError, true)
    assert.equal(rejected.errorKind, 'delivery_gate')
    assert.match(rejected.content, /impact_unresolved/)
    assert.equal(calls, 1)
  } finally { f.dispose() }
})
