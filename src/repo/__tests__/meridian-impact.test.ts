import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { analyzeImpact, inferTestedByTargets } from '../meridian-impact.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { candidateTypecheckCoverage, isPureTypeOnlyImportEdge } from '../type-only-import.js'

it('peer-dirty importer cannot demote a candidate runtime edge', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'type-only-peer-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    writeFileSync(join(cwd, 'feature.ts'), 'export interface Feature { value: number }; export const value = 1')
    writeFileSync(join(cwd, 'consumer.test.ts'), "import { value } from './feature.js'; void value")
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true }, include: ['*.ts'] }))
    git('add', '--', 'feature.ts', 'consumer.test.ts', 'tsconfig.json'); git('commit', '-qm', 'baseline')
    writeFileSync(join(cwd, 'consumer.test.ts'), "import type { Feature } from './feature.js'; type Check = Feature")
    const proof = { candidateRef: 'tree', verifiedRef: 'tree', passed: true, complete: true, candidateFiles: ['feature.ts'] }
    const checkedFiles = candidateTypecheckCoverage(cwd, proof)
    assert.ok(checkedFiles)
    assert.equal(isPureTypeOnlyImportEdge(cwd, 'consumer.test.ts', 'feature.ts', proof, checkedFiles), false)
    assert.equal(isPureTypeOnlyImportEdge(cwd, 'consumer.test.ts', 'feature.ts', { ...proof, candidateFiles: ['feature.ts', 'consumer.test.ts'] }, checkedFiles), true)
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true }, include: ['feature.ts'] }))
    git('add', '--', 'tsconfig.json'); git('commit', '-qm', 'narrow config')
    const narrowCoverage = candidateTypecheckCoverage(cwd, proof)
    assert.ok(narrowCoverage)
    assert.equal(isPureTypeOnlyImportEdge(cwd, 'consumer.test.ts', 'feature.ts', { ...proof, candidateFiles: ['feature.ts', 'consumer.test.ts'] }, narrowCoverage), false)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

describe('meridian impact', () => {
  let db: MeridianDb
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'meridian-impact-'))
    db = new MeridianDb(tmpDir)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setupGraph() {
    // Graph: app.ts imports auth.ts imports db.ts
    //        ui.ts imports auth.ts
    //        auth.test.ts tested_by auth.ts
    db.upsertEdge('app.ts:main:1', 'auth.ts:login:1', 'imports', 1.0)
    db.upsertEdge('auth.ts:login:1', 'db.ts:query:1', 'imports', 1.0)
    db.upsertEdge('ui.ts:render:1', 'auth.ts:login:1', 'imports', 1.0)
    db.upsertEdge('auth.test.ts:*:0', 'auth.ts:*:0', 'tested_by', 0.7)
  }

  function commitTypecheckFixture() {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8' })
    writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true }, include: ['*.ts'] }))
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    git('add', '--', 'tsconfig.json'); git('commit', '-qm', 'config')
  }

  it('finds direct dependents via reverse BFS', () => {
    setupGraph()
    const result = analyzeImpact(db, ['auth.ts'])
    assert.ok(result.direct.includes('app.ts'))
    assert.ok(result.direct.includes('ui.ts'))
    // auth.test.ts also shows up as direct dependent via tested_by edge
    assert.ok(result.direct.length >= 2)
  })

  it('finds transitive dependents at hop 2+', () => {
    setupGraph()
    // Change db.ts → auth.ts is direct, app.ts/ui.ts are transitive
    const result = analyzeImpact(db, ['db.ts'])
    assert.ok(result.direct.includes('auth.ts'))
    assert.ok(result.transitive.includes('app.ts') || result.transitive.includes('ui.ts'))
  })

  it('finds tests for changed files', () => {
    setupGraph()
    const result = analyzeImpact(db, ['auth.ts'])
    assert.ok(result.tests.includes('auth.test.ts'))
  })

  it('returns empty for leaf files with no dependents', () => {
    setupGraph()
    const result = analyzeImpact(db, ['app.ts'])
    assert.equal(result.totalImpact, 0)
  })

  it('respects maxHops limit', () => {
    setupGraph()
    const result = analyzeImpact(db, ['db.ts'], { maxHops: 1 })
    // Only 1 hop: auth.ts is direct, app.ts/ui.ts not reached
    assert.ok(result.direct.includes('auth.ts'))
    assert.equal(result.transitive.length, 0)
  })

  it('finds tests via co-edit neighbors', () => {
    setupGraph()
    // auth.ts was co-edited with auth.test.ts
    db.recordCoEdit('auth.ts', 'auth.test.ts', 1)
    const result = analyzeImpact(db, ['auth.ts'])
    assert.ok(result.tests.includes('auth.test.ts'))
  })

  it('handles multiple changed files', () => {
    setupGraph()
    const result = analyzeImpact(db, ['auth.ts', 'db.ts'])
    // auth.ts dependents + db.ts dependents (auth.ts already in changed set)
    assert.ok(result.direct.includes('app.ts'))
    assert.ok(result.direct.includes('ui.ts'))
  })

  it('support files stay in the graph but only their real test dependents are required', () => {
    const helper = 'src/__tests__/helpers/fixture.ts'
    const test = 'src/__tests__/consumer.test.ts'
    db.upsertEdge(`${helper}:fixture:1`, 'src/feature.ts:feature:1', 'imports', 1, 'extracted')
    db.upsertEdge(`${test}:check:1`, `${helper}:fixture:1`, 'imports', 1, 'extracted')
    db.upsertEdge(`${helper}:*:0`, 'src/feature.ts:*:0', 'tested_by', 1, 'inferred')
    db.recordCoEdit('src/feature.ts', helper, 1)
    const impact = analyzeImpact(db, ['src/feature.ts'])
    assert.deepEqual(impact.requiredTests, [test])
    assert.ok(impact.direct.includes(helper))
    assert.ok(!impact.tests.includes(helper))
    assert.equal(impact.reasons?.[test]?.length, 2)
    assert.deepEqual(analyzeImpact(db, [helper]).requiredTests, [test])
    assert.deepEqual(inferTestedByTargets(helper, ['src/fixture.ts']), [])
  })

  it('Python and Go test entry names remain obligations without test-directory hints', () => {
    const tests = ['test_feature.py', 'feature_test.py', 'feature_test.go', 'feature.spec.ts', 'feature.test.mjs']
    for (const file of [...tests, 'test/helper.py', '__tests__/fixture.go']) {
      db.upsertEdge(`${file}:check:1`, 'feature.ts:feature:1', 'imports', 1, 'extracted')
    }
    assert.deepEqual(analyzeImpact(db, ['feature.ts']).requiredTests, tests.sort())
  })

  it('demotes explicit type-only imports only with complete proof for the same candidate tree', () => {
    writeFileSync(join(tmpDir, 'feature.ts'), 'export interface Feature { value: number }')
    writeFileSync(join(tmpDir, 'type.test.ts'), "import type { Feature } from './feature.js'; type Check = Feature")
    writeFileSync(join(tmpDir, 'inline.test.ts'), "import { type Feature } from './feature.js'; type Check = Feature")
    writeFileSync(join(tmpDir, 'value.test.ts'), "import { Feature } from './feature.js'; void Feature")
    writeFileSync(join(tmpDir, 'side-effect.test.ts'), "import type { Feature } from './feature.js'; import './feature.js'; type Check = Feature")
    for (const name of ['type', 'inline', 'value', 'side-effect']) {
      db.upsertEdge(`${name}.test.ts:check:1`, 'feature.ts:Feature:1', 'imports', 1, 'extracted')
    }
    commitTypecheckFixture()
    const proof = { candidateRef: 'tree-a', verifiedRef: 'tree-a', passed: true, complete: true, candidateFiles: ['feature.ts', 'type.test.ts', 'inline.test.ts', 'value.test.ts', 'side-effect.test.ts'] }
    const defaultImpact = analyzeImpact(db, ['feature.ts'], { cwd: tmpDir })
    assert.deepEqual(defaultImpact.requiredTests, ['inline.test.ts', 'side-effect.test.ts', 'type.test.ts', 'value.test.ts'])
    const stale = analyzeImpact(db, ['feature.ts'], { cwd: tmpDir, typecheckProof: { ...proof, verifiedRef: 'tree-b' } })
    assert.deepEqual(stale.requiredTests, defaultImpact.requiredTests)
    const partial = analyzeImpact(db, ['feature.ts'], { cwd: tmpDir, typecheckProof: { ...proof, complete: false } })
    assert.deepEqual(partial.requiredTests, defaultImpact.requiredTests)
    const precise = analyzeImpact(db, ['feature.ts'], { cwd: tmpDir, typecheckProof: proof })
    assert.deepEqual(precise.requiredTests, ['side-effect.test.ts', 'value.test.ts'])
    assert.deepEqual(precise.advisoryTests, ['inline.test.ts', 'type.test.ts'])
    assert.equal(precise.reasons?.['type.test.ts']?.[0]?.typeOnly, true)
    assert.equal(precise.policyVersion, 2)
  })

  it('promotes a test reached by a runtime path after a type-only path', () => {
    writeFileSync(join(tmpDir, 'feature.ts'), 'export interface Feature { value: number }; export const value = 1')
    writeFileSync(join(tmpDir, 'types.ts'), "import type { Feature } from './feature.js'; export type Alias = Feature")
    writeFileSync(join(tmpDir, 'runtime.ts'), "import { value } from './feature.js'; export const result = value")
    writeFileSync(join(tmpDir, 'consumer.test.ts'), "import './types.js'; import './runtime.js'")
    db.upsertEdge('types.ts:Alias:1', 'feature.ts:Feature:1', 'imports', 1, 'extracted')
    db.upsertEdge('runtime.ts:result:1', 'feature.ts:value:1', 'imports', 1, 'extracted')
    db.upsertEdge('consumer.test.ts:check:1', 'types.ts:Alias:1', 'imports', 1, 'extracted')
    db.upsertEdge('consumer.test.ts:check:1', 'runtime.ts:result:1', 'imports', 1, 'extracted')
    commitTypecheckFixture()
    const impact = analyzeImpact(db, ['feature.ts'], { cwd: tmpDir, typecheckProof: { candidateRef: 'tree-a', verifiedRef: 'tree-a', passed: true, complete: true, candidateFiles: ['feature.ts', 'types.ts', 'runtime.ts', 'consumer.test.ts'] } })
    assert.deepEqual(impact.requiredTests, ['consumer.test.ts'])
    assert.deepEqual(impact.advisoryTests, [])
    assert.equal(impact.reasons?.['consumer.test.ts']?.[0]?.to, 'runtime.ts')
  })
})

describe('inferTestedByTargets', () => {
  const allFiles = [
    'src/auth/login.ts',
    'src/auth/__tests__/login.test.ts',
    'src/utils.ts',
    'src/utils.spec.ts',
    'test/utils.test.ts',
  ]

  it('matches test file to source by name', () => {
    const targets = inferTestedByTargets('src/auth/__tests__/login.test.ts', allFiles)
    assert.ok(targets.includes('src/auth/login.ts'))
  })

  it('does not match non-test files', () => {
    const targets = inferTestedByTargets('src/auth/login.ts', allFiles)
    assert.equal(targets.length, 0)
  })

  it('matches spec files', () => {
    const targets = inferTestedByTargets('src/utils.spec.ts', allFiles)
    assert.ok(targets.includes('src/utils.ts'))
  })

  it('does not match test to test', () => {
    const targets = inferTestedByTargets('test/utils.test.ts', allFiles)
    // Should match src/utils.ts but not src/utils.spec.ts
    assert.ok(targets.includes('src/utils.ts'))
    assert.ok(!targets.includes('src/utils.spec.ts'))
  })
})
