import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianIndexer } from '../meridian-indexer.js'

function isIndexable(indexer: MeridianIndexer, filePath: string): boolean {
  return (indexer as unknown as { isIndexable(filePath: string): boolean }).isIndexable(filePath)
}

function callToRepoRelative(indexer: MeridianIndexer, filePath: string): string | null {
  return (indexer as unknown as { toRepoRelative(filePath: string): string | null }).toRepoRelative(filePath)
}

describe('MeridianIndexer attention indexing scope', () => {
  it('indexes content source files but rejects runtime, build, and foreign attention noise', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-attention-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      assert.equal(isIndexable(indexer, 'src/app.ts'), true)
      assert.equal(isIndexable(indexer, 'docs/teamtask/plan.md'), false, 'non-code content remains outside parser scope')
      assert.equal(isIndexable(indexer, 'node_modules/pkg/index.ts'), false)
      assert.equal(isIndexable(indexer, '.codex/hooks.ts'), false)
      assert.equal(isIndexable(indexer, '.test-tmp/generated.ts'), false)
      assert.equal(isIndexable(indexer, 'src/app.ts.map'), false)
      assert.equal(isIndexable(indexer, '.vscode/settings.ts'), true, '.vscode stays content-side unless explicitly proven noisy')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('rejects absolute paths inside silent layers — counterexample for real read_file chain', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-abs-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-abs-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      // Simulate real read_file target: absolute path to .codex foreign file
      assert.equal(
        isIndexable(indexer, join(cwd, '.codex', 'hooks.ts')),
        false,
        'absolute path inside foreign silent layer must stay silent',
      )
      // Same for .agents
      assert.equal(
        isIndexable(indexer, resolve(cwd, '.agents/plugin.ts')),
        false,
        'absolute .agents path must stay silent',
      )
      // node_modules absolute
      assert.equal(
        isIndexable(indexer, resolve(cwd, 'node_modules/pkg/index.ts')),
        false,
        'absolute node_modules must stay silent',
      )
      // Legitimate absolute path to real source stays indexable
      assert.equal(
        isIndexable(indexer, resolve(cwd, 'src/app.ts')),
        true,
        'absolute path to real content stays indexable',
      )
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('toRepoRelative normalizes absolute to repo-relative, blocks traversal and outside paths', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-rel-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-rel-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      assert.equal(callToRepoRelative(indexer, resolve(cwd, 'src/app.ts')), 'src/app.ts')
      assert.equal(callToRepoRelative(indexer, resolve(cwd, '.codex/hooks.ts')), '.codex/hooks.ts')
      // relative passes through unchanged
      assert.equal(callToRepoRelative(indexer, 'src/app.ts'), 'src/app.ts')
      // relative traversal outside cwd returns null — fail-closed
      assert.equal(callToRepoRelative(indexer, '../outside.ts'), null)
      // absolute outside cwd returns null — fail-closed
      const outside = resolve('/tmp/outside/file.ts')
      assert.equal(callToRepoRelative(indexer, outside), null)
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('rejects absolute paths outside the project — fail-closed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      assert.equal(
        isIndexable(indexer, '/tmp/outside/file.ts'),
        false,
        'absolute path outside project must not be indexable',
      )
      assert.equal(
        isIndexable(indexer, '/Users/stranger/project/src/app.ts'),
        false,
        'absolute path to another project must not be indexable',
      )
      // relative traversal also blocked
      assert.equal(
        isIndexable(indexer, '../outside.ts'),
        false,
        'relative traversal outside project must not be indexable',
      )
      assert.equal(
        isIndexable(indexer, '../../etc/passwd.ts'),
        false,
        'deep traversal must not be indexable',
      )
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('indexFile rejects outside-project paths even when file exists on disk', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-idx-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-outside-idx-state-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'meridian-outside-'))
    const outsideFile = join(outsideDir, 'secret.ts')
    writeFileSync(outsideFile, 'export const secret = 42\n')
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      // absolute outside-project path
      await indexer.indexFile(outsideFile)
      let stats = indexer.getStats()
      assert.equal(stats.files, 0, 'absolute outside-project file must not enter the DB')

      // relative traversal: create a real file one dir up
      const parentDir = join(cwd, '..', 'meridian-parent-sibling.ts')
      writeFileSync(parentDir, 'export const sibling = 1\n')
      await indexer.indexFile('../meridian-parent-sibling.ts')
      stats = indexer.getStats()
      assert.equal(stats.files, 0, 'relative traversal outside project must not enter the DB')
      rmSync(parentDir, { force: true })
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('probeFile cheap path preserves recordAccess and change detection without parsing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-probe-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-probe-state-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    const file = join(cwd, 'src', 'a.ts')
    writeFileSync(file, 'export const a = 1\n')
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      // New file: needs parse, but probe must not write files/symbols.
      assert.equal(indexer.probeFile('src/a.ts'), 'parse')
      assert.equal(indexer.getStats().files, 0)

      // After real index, unchanged probe records access and returns unchanged.
      await indexer.indexFile('src/a.ts')
      const before = indexer.getDb().getAccessCount('src/a.ts')
      assert.equal(indexer.probeFile('src/a.ts'), 'unchanged')
      assert.equal(indexer.getDb().getAccessCount('src/a.ts'), before + 1)

      // External change (git checkout / concurrent edit) is detected as parse.
      writeFileSync(file, 'export const a = 2\n')
      assert.equal(indexer.probeFile('src/a.ts'), 'parse')

      // Outside / silent paths stay skip without touching disk records.
      assert.equal(indexer.probeFile('/tmp/outside.ts'), 'skip')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('invalidateFile serializes concurrent same-file runs and reruns once for late writes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-invalidate-guard-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-invalidate-guard-state-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      const cast = indexer as unknown as { invalidateFileCore(rel: string): Promise<void> }
      const original = cast.invalidateFileCore.bind(indexer)
      let coreCalls = 0
      let releaseFirst: () => void = () => {}
      const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
      cast.invalidateFileCore = async (rel: string) => {
        coreCalls++
        if (coreCalls === 1) await firstGate
        else await original(rel)
      }

      const first = indexer.invalidateFile('src/a.ts')
      // 等第一个 core 真正进入（wrapper 已把 invalidating 置位）。
      while (coreCalls === 0) await new Promise<void>(resolve => setImmediate(resolve))

      const second = indexer.invalidateFile('src/a.ts')
      await second
      assert.equal(coreCalls, 1, 'concurrent same-file invalidate must not double-parse immediately')

      releaseFirst()
      await first
      // wrapper 发现 pending 标记，重跑一轮——并发写期间的最新内容不会丢。
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(coreCalls, 2, 'pending invalidation must rerun once after the first completes')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('stores resolved import edges so reverse-dependency lookup works end-to-end', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-revdep-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-revdep-state-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 1\n')
    writeFileSync(
      join(cwd, 'src', 'a.ts'),
      "import { b } from './b.js'\nimport { z } from 'zod'\nexport const a = b\nexport const zz = z\n",
    )
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile('src/a.ts')
      const db = indexer.getDb()

      // a.ts imports b.ts → b.ts's reverse dependents include a.ts
      const dependents = db.getReverseDependents('src/b.ts').map(d => d.file)
      assert.ok(dependents.includes('src/a.ts'), `expected src/a.ts in reverse dependents, got ${JSON.stringify(dependents)}`)
      assert.ok(indexer.impact(['src/b.ts']).direct.includes('src/a.ts'))

      // External package import (zod) resolves to nothing → no edge created
      assert.equal(db.getReverseDependents('zod').length, 0)

      // invalidateFile re-parses and must keep import edges resolved (not raw)
      await indexer.invalidateFile('src/a.ts')
      const afterInvalidate = db.getReverseDependents('src/b.ts').map(d => d.file)
      assert.ok(afterInvalidate.includes('src/a.ts'), `expected resolved edge after invalidate, got ${JSON.stringify(afterInvalidate)}`)
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('indexFile rejects absolute silent paths without creating DB entries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-idx-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-idx-state-'))
    // Create the file on disk so existsSync would pass if isIndexable didn't block it
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(join(cwd, '.codex', 'hooks.ts'), 'export const x = 1\n')
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile(resolve(cwd, '.codex', 'hooks.ts'))
      const stats = indexer.getStats()
      assert.equal(stats.files, 0, 'absolute silent path must not enter the DB')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('builds cross-file calls edge with inferred confidence on unique name match', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-calls-inferred-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-calls-inferred-state-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'b.ts'), 'export function helper() {}\n')
    writeFileSync(join(cwd, 'src', 'a.ts'), "import { helper } from './b.js'\nexport function a() { helper() }\n")
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile('src/a.ts')
      const db = indexer.getDb()
      const aSym = db.getSymbolsForFile('src/a.ts').find(s => s.name === 'a')
      assert.ok(aSym)
      const calls = db.getEdgesFrom(aSym.id).filter(e => e.kind === 'calls')
      assert.equal(calls.length, 1, `expected one calls edge, got ${JSON.stringify(calls)}`)
      const inferred = calls[0]
      assert.ok(inferred)
      assert.equal(inferred.targetId, 'src/b.ts:helper:1')
      assert.equal(inferred.confidence, 'inferred')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('builds ambiguous calls edges when callee name matches multiple symbols', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-calls-ambiguous-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-calls-ambiguous-state-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'b.ts'), 'export function helper() {}\n')
    writeFileSync(join(cwd, 'src', 'c.ts'), 'export function helper() {}\n')
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export function a() { helper() }\n')
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile('src/b.ts')
      await indexer.indexFile('src/c.ts')
      await indexer.indexFile('src/a.ts')
      const db = indexer.getDb()
      const aSym = db.getSymbolsForFile('src/a.ts').find(s => s.name === 'a')
      assert.ok(aSym)
      const calls = db.getEdgesFrom(aSym.id).filter(e => e.kind === 'calls')
      assert.equal(calls.length, 2, `expected two ambiguous calls edges, got ${JSON.stringify(calls)}`)
      assert.ok(calls.every(e => e.confidence === 'ambiguous'), 'ambiguous name match must stay ambiguous')
      assert.deepEqual(calls.map(e => e.targetId).sort(), ['src/b.ts:helper:1', 'src/c.ts:helper:1'])
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('persists extracted and inferred calls edges together through the indexFile production path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-calls-mixed-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-calls-mixed-state-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'b.ts'), 'export function remote() {}\n')
    writeFileSync(
      join(cwd, 'src', 'a.ts'),
      "import { remote } from './b.js'\nexport function local() {}\nexport function entry() { local(); remote() }\n",
    )
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile('src/a.ts')
      const db = indexer.getDb()
      const entry = db.getSymbolsForFile('src/a.ts').find(s => s.name === 'entry')
      assert.ok(entry)
      const calls = db.getEdgesFrom(entry.id).filter(e => e.kind === 'calls')
      assert.equal(calls.length, 2, `expected extracted + inferred calls edges, got ${JSON.stringify(calls)}`)
      const extracted = calls.find(e => e.confidence === 'extracted')
      assert.ok(extracted, 'same-file call must land at extracted confidence')
      assert.equal(extracted.targetId, 'src/a.ts:local:2')
      const inferred = calls.find(e => e.confidence === 'inferred')
      assert.ok(inferred, 'cross-file unique-name call must land at inferred confidence')
      assert.equal(inferred.targetId, 'src/b.ts:remote:1')

      // Re-indexing replaces, never accumulates — upsertFile clears the file's
      // out-edges before inserting the fresh parse result.
      await indexer.indexFile('src/a.ts')
      const after = db.getEdgesFrom(entry.id).filter(e => e.kind === 'calls')
      assert.equal(after.length, 2, `re-index must not accumulate calls edges, got ${JSON.stringify(after)}`)
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('MeridianIndexer when the index is unavailable', () => {
  it('gives up before touching the disk', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root ignores file permissions, so an unreadable file proves nothing')
      return
    }
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-degraded-'))
    // stateDir as a regular file → sqlite cannot open → index unavailable.
    const stateDir = join(tmpdir(), `meridian-indexer-degraded-state-${process.pid}-${Date.now()}`)
    writeFileSync(stateDir, 'a file where a directory is expected')
    mkdirSync(join(cwd, 'src'))
    const target = join(cwd, 'src', 'a.ts')
    writeFileSync(target, 'export const a = 1\n')
    // Make the read itself observable: reaching readFileSync throws EACCES.
    // That read, its hash, and the tree-sitter parse behind it all feed an
    // index that cannot store them — and the 1-hop import expansion repeats
    // the whole thing for every dependency, on every read_file.
    chmodSync(target, 0o000)
    const realWarn = console.warn
    console.warn = () => {}
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      await indexer.indexFile('src/a.ts')
    } finally {
      console.warn = realWarn
      chmodSync(target, 0o644)
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { force: true })
    }
  })

  it('rejects symlink escape — file inside repo pointing outside project boundary', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-indexer-symlink-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-symlink-state-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'meridian-indexer-symlink-outside-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      // Real target outside the repo root
      const target = join(outsideDir, 'leak.ts')
      writeFileSync(target, 'export const leak = 1\n')
      // Symlink inside repo → outside target
      const linkPath = join(cwd, 'src', 'leak-link.ts')
      mkdirSync(join(cwd, 'src'), { recursive: true })
      symlinkSync(target, linkPath)

      assert.equal(callToRepoRelative(indexer, linkPath), null, 'symlink escape must fail closed')
      assert.equal(callToRepoRelative(indexer, join(cwd, 'src', 'app.ts')), 'src/app.ts', 'in-repo file unaffected')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects shared-prefix escape when the file does not exist (MEDIUM-3)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-shared-prefix-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-shared-prefix-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      // Dir name shares the cwd prefix but sits outside it; file does not exist
      const escape = `${cwd}-other/ghost.ts`
      assert.equal(callToRepoRelative(indexer, escape), null, 'shared-prefix escape must be rejected')
      assert.equal(callToRepoRelative(indexer, 'src/ok.ts'), 'src/ok.ts', 'in-repo path unaffected')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  function writeTestFixture(cwd: string): void {
    // SUT + its test file; the test file ALSO contains an Express route so the
    // framework-extraction second upsertFile path is exercised.
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'app.ts'), 'export function health() { return 1 }\n')
    writeFileSync(join(cwd, 'src', 'app.test.ts'), `
import { health } from './app.js'
const app = { get: () => {} }
app.get('/health', health)
`)
  }

  it('keeps tested_by edges when a test file also contains routes (MEDIUM-2)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-tb-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-tb-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      writeTestFixture(cwd)
      await indexer.indexFile('src/app.test.ts')
      const edges = indexer['db'].getEdgesFrom('src/app.test.ts:*:0')
      assert.ok(edges.some(e => e.kind === 'tested_by'), `tested_by edge must survive, got ${JSON.stringify(edges.map(e => e.kind))}`)
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('rebuilds tested_by edges on invalidateFile hot-update (LOW-1)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'meridian-tb-hot-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-tb-hot-state-'))
    const indexer = new MeridianIndexer(cwd, stateDir)
    try {
      writeTestFixture(cwd)
      await indexer.indexFile('src/app.test.ts')
      assert.ok(indexer['db'].getEdgesFrom('src/app.test.ts:*:0').some(e => e.kind === 'tested_by'), 'baseline tested_by exists')
      writeFileSync(join(cwd, 'src', 'app.test.ts'), `
import { health } from './app.js'
const app = { get: () => {} }
app.get('/health', health)
// edited by agent
`)
      await indexer.invalidateFile('src/app.test.ts')
      assert.ok(indexer['db'].getEdgesFrom('src/app.test.ts:*:0').some(e => e.kind === 'tested_by'), 'tested_by must be rebuilt on hot-update')
    } finally {
      indexer.close()
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
