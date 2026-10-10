import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isMeridianIndexablePath } from '../../repo/meridian-indexer.js'
import { scheduleMeridianBackfill } from '../../repo/meridian-backfill.js'
import { SemanticIndex } from '../semantic-index.js'

test('Meridian rejects metadata path components before they consume backfill capacity', async () => {
  for (const path of ['._a.ts', 'src/._b.py', '._directory/app.ts', '.DS_Store/app.ts']) assert.equal(isMeridianIndexablePath(path), false, path)
  assert.equal(isMeridianIndexablePath('src/.hidden.ts'), true)
  const dir = mkdtempSync(join(tmpdir(), 'meridian-metadata-'))
  const oldMax = process.env.RIVET_MERIDIAN_BACKFILL_MAX
  try {
    writeFileSync(join(dir, 'real.ts'), 'export const real = 1')
    writeFileSync(join(dir, '._real.ts'), 'export const metadata = 1')
    process.env.RIVET_MERIDIAN_BACKFILL_MAX = '1'
    const calls: string[] = []
    await scheduleMeridianBackfill({ indexFile: async (file: string) => { calls.push(file) } } as any, dir).done
    assert.deepEqual(calls, ['real.ts'])
  } finally {
    if (oldMax === undefined) delete process.env.RIVET_MERIDIAN_BACKFILL_MAX
    else process.env.RIVET_MERIDIAN_BACKFILL_MAX = oldMax
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Semantic index excludes metadata at rebuild, stale scan, incremental scan and cold restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-metadata-'))
  try {
    writeFileSync(join(dir, 'real.ts'), 'export function authenticateUser(token: string) { return true }')
    writeFileSync(join(dir, '._real.ts'), 'export const metadata = 1')
    const idx = new SemanticIndex(dir, undefined, { staleTtlMs: 0 })
    assert.deepEqual(idx.rebuild(1), { indexed: 1, skipped: 0 })
    const persistedPath = join(dir, '.rivet', 'semantic-index.json')
    let snapshot = JSON.parse(readFileSync(persistedPath, 'utf8'))
    assert.deepEqual(Object.keys(snapshot.fileHashes), ['real.ts'])
    assert.ok(idx.search('authenticate user token').some(hit => hit.file === 'real.ts'))
    writeFileSync(join(dir, '._other.ts'), 'export const extraMetadata = 2')
    writeFileSync(join(dir, '._real.ts'), 'export const metadata = 3')
    assert.equal(idx.isStale(), false)
    assert.deepEqual(idx.incrementalUpdate(), { reindexed: 0, removed: 0, fallbackRebuild: false })
    const restored = new SemanticIndex(dir, undefined, { staleTtlMs: 0 })
    assert.equal(restored.isStale(), false)
    assert.ok(restored.search('authenticate user token').some(hit => hit.file === 'real.ts'))
    // A snapshot produced by an older version must not revive indexed sidecars.
    snapshot = JSON.parse(readFileSync(persistedPath, 'utf8'))
    snapshot.fileHashes['._real.ts'] = 'bad-old-hash'
    snapshot.chunks.push({ file: '._real.ts', startLine: 1, endLine: 1, text: 'onlyMetadataNeedle' })
    writeFileSync(persistedPath, JSON.stringify(snapshot))
    const legacyRestored = new SemanticIndex(dir, undefined, { staleTtlMs: 0 })
    assert.equal(legacyRestored.isStale(), false)
    assert.equal(legacyRestored.search('onlyMetadataNeedle').length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Cold hybrid restore prunes legacy metadata vectors before vector top-k selection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-vector-metadata-'))
  try {
    writeFileSync(join(dir, 'real.ts'), 'export function authenticateUser(token: string) { return true }')
    const original = new SemanticIndex(dir)
    original.rebuild(10)
    const indexPath = join(dir, '.rivet', 'semantic-index.json')
    const snapshot = JSON.parse(readFileSync(indexPath, 'utf8'))
    const realChunk = snapshot.chunks.find((c: { file: string }) => c.file === 'real.ts')
    assert.ok(realChunk)
    const realId = `${realChunk.file}:${realChunk.startLine}-${realChunk.endLine}`
    const legacyEntries = Array.from({ length: 24 }, (_, i) => {
      const file = `._legacy${i}.ts`
      snapshot.fileHashes[file] = `legacy${i}`
      snapshot.chunks.push({ file, startLine: 1, endLine: 1, text: 'unrelatedMetadataText' })
      return { id: `${file}:1-1`, vector: [1, 0] }
    })
    writeFileSync(indexPath, JSON.stringify(snapshot))
    const provider = { id: 'local-constant-fixture', isAvailable: () => true, embed: async (texts: string[]) => texts.map(() => [1, 0]) }
    writeFileSync(join(dir, '.rivet', 'vector-index.json'), JSON.stringify({
      version: 1, providerId: provider.id, dim: 2,
      entries: [...legacyEntries, { id: realId, vector: [0.9, 0.1] }],
    }))
    const restored = new SemanticIndex(dir, provider)
    assert.deepEqual(restored.search('qzxwv123only'), [], 'query deliberately has no BM25 match')
    const result = await restored.searchHybrid('qzxwv123only', 5)
    assert.equal(result.backend, 'hybrid')
    assert.deepEqual(result.hits.map(hit => hit.file), ['real.ts'])
    // Provider/model mismatch must still refuse the old snapshot.
    const otherProvider = { ...provider, id: 'other-local-fixture', embed: async (_texts: string[]): Promise<number[][]> => { throw new Error('no embeddings available') } }
    assert.deepEqual((await new SemanticIndex(dir, otherProvider).searchHybrid('qzxwv123only', 5)).hits, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
