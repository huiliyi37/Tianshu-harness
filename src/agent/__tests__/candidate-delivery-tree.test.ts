import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openCandidateDeliveryTree } from '../candidate-delivery-tree.js'
import { resolveCandidateDeliveryImpact } from '../delivery-impact.js'
import { MeridianIndexer } from '../../repo/meridian-indexer.js'

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('candidate impact reads HEAD imports while the live importer is peer-dirty', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'candidate-impact-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src/a.ts'), 'export const value = 1\n')
    writeFileSync(join(cwd, 'src/consumer.test.ts'), "import { value } from './a.js'; void value\n")
    git(cwd, 'add', '--', 'src/a.ts', 'src/consumer.test.ts')
    git(cwd, 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'src/a.ts'), 'export const value = 2\n')
    writeFileSync(join(cwd, 'src/consumer.test.ts'), 'export const peerEdit = true\n')

    const indexDir = mkdtempSync(join(tmpdir(), 'candidate-live-index-'))
    const indexer = new MeridianIndexer(cwd, indexDir)
    try {
      assert.equal(indexer.getDb().available, true)
      await indexer.indexFile('src/consumer.test.ts')
      const liveBefore = indexer.getDb().getReverseDependents('src/a.ts')
      const tree = await openCandidateDeliveryTree(cwd, ['src/a.ts'])
      try {
        const impact = await resolveCandidateDeliveryImpact(tree.path, ['src/a.ts'], indexer)
        assert.equal(impact.resolved, true, impact.reason)
        assert.ok(impact.requiredTests.includes('src/consumer.test.ts'))
        assert.deepEqual(indexer.getDb().getReverseDependents('src/a.ts'), liveBefore, 'candidate reconciliation must not rewrite the shared index')
        assert.equal(tree.isCurrent(), true)
        writeFileSync(join(cwd, 'src/a.ts'), 'export const value = 3\n')
        assert.equal(tree.isCurrent(), false)
        writeFileSync(join(cwd, 'src/a.ts'), 'export const value = 2\n')
        assert.equal(tree.isCurrent(), true)
        git(cwd, 'commit', '--allow-empty', '-qm', 'new HEAD')
        assert.equal(tree.isCurrent(), false)
      } finally { tree.destroy() }
      assert.equal(git(cwd, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1)
    } finally { indexer.getDb().close(); rmSync(indexDir, { recursive: true, force: true }) }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('candidate impact stays unresolved when the index copy fails and static fallback cannot prove coverage', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'candidate-impact-unresolved-'))
  try {
    const indexer = { getDb: () => ({ available: true, backupTo: async () => false }) } as unknown as MeridianIndexer
    const impact = await resolveCandidateDeliveryImpact(cwd, ['src/a.py'], indexer)
    assert.equal(impact.resolved, false)
    assert.match(impact.reason ?? '', /impact_unresolved/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('a selected import edge expands the candidate impact through its consumer', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'candidate-import-edge-'))
  const indexDir = mkdtempSync(join(tmpdir(), 'candidate-edge-index-'))
  try {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'user.email', 'test@example.com')
    git(cwd, 'config', 'user.name', 'Test')
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src/a.ts'), 'export const value = 1\n')
    writeFileSync(join(cwd, 'src/b.ts'), 'export const dependency = 1\n')
    writeFileSync(join(cwd, 'src/consumer.test.ts'), "import { value } from './a.js'; void value\n")
    git(cwd, 'add', '--', 'src/a.ts', 'src/b.ts', 'src/consumer.test.ts')
    git(cwd, 'commit', '-qm', 'base')
    const indexer = new MeridianIndexer(cwd, indexDir)
    try {
      assert.equal(indexer.getDb().available, true)
      await indexer.indexFile('src/a.ts')
      await indexer.indexFile('src/b.ts')
      await indexer.indexFile('src/consumer.test.ts')
      writeFileSync(join(cwd, 'src/a.ts'), "import { dependency } from './b.js'; export const value = dependency\n")
      writeFileSync(join(cwd, 'src/b.ts'), 'export const dependency = 2\n')
      const tree = await openCandidateDeliveryTree(cwd, ['src/a.ts', 'src/b.ts'])
      try {
        const impact = await resolveCandidateDeliveryImpact(tree.path, ['src/b.ts'], indexer)
        assert.equal(impact.resolved, true, impact.reason)
        assert.ok(impact.requiredTests.includes('src/consumer.test.ts'), JSON.stringify(impact))
      } finally { tree.destroy() }
    } finally { indexer.getDb().close() }
  } finally { rmSync(indexDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
})
