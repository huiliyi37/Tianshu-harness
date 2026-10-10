import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianDb } from '../meridian-db.js'
import { MeridianIndexer } from '../meridian-indexer.js'
import { initParser, parseFile } from '../meridian-parser.js'
import { resolveBetterSqlite3 } from '../native-resolver.js'
import { scheduleMeridianBackfill } from '../meridian-backfill.js'
import { createRepoGraphTool } from '../../tools/repo-graph.js'

const MARKER = 'filesystem_metadata_cleanup_v1'
const real = 'src/real[1]_.ts'
const metadata = 'src/._legacy[1]_.ts'
const ordinary = 'src/_legacy[1]_.ts'

async function seedLegacy(dir: string): Promise<{ realId: string; metadataId: string }> {
  const db = new MeridianDb(dir)
  assert.equal(db.available, true, 'test must exercise real sqlite')
  await initParser()
  const parsedReal = await parseFile(real, 'export function realFunction() { return 1 }')
  const parsedMetadata = await parseFile(metadata, 'export function legacyMetadataFunction() { return 2 }')
  const parsedOrdinary = await parseFile(ordinary, 'export function legitimateUnderscoreFunction() { return 3 }')
  for (const parsed of [parsedReal, parsedMetadata, parsedOrdinary]) db.upsertFile(parsed)
  const realId = parsedReal.symbols[0]!.id
  const metadataId = parsedMetadata.symbols[0]!.id
  const ordinaryId = parsedOrdinary.symbols[0]!.id
  db.upsertEdge(realId, ordinaryId, 'calls', 0.8)
  db.upsertEdge(ordinaryId, realId, 'calls', 0.7)
  db.upsertEdge(realId, metadataId, 'calls', 1)
  db.upsertEdge(metadataId, realId, 'calls', 1)
  db.upsertEdge(realId, 'src/not-yet-indexed.ts:*:0', 'imports', 1)
  db.recordCoEdit(real, metadata, 1)
  db.recordCoEdit(real, ordinary, 1)
  db.recordAccess(metadata)
  db.close()
  const Database = resolveBetterSqlite3(import.meta.url)
  const raw = new Database(join(dir, 'meridian.db'))
  try { raw.prepare('DELETE FROM meridian_meta WHERE key = ?').run(MARKER) } finally { raw.close() }
  return { realId, metadataId }
}

test('Cold Meridian open removes old metadata from graph, count and symbol search while preserving normal pending imports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-legacy-metadata-'))
  let indexer: MeridianIndexer | undefined
  try {
    const ids = await seedLegacy(dir)
    indexer = new MeridianIndexer(dir, dir)
    // The new scheduling filter must not masquerade as a cleanup of old DB rows.
    await scheduleMeridianBackfill(indexer, dir).done
    const db = indexer.getDb()
    const map = await indexer.query(real)
    const graph = await createRepoGraphTool(() => indexer!).execute({ input: { from_file: real }, cwd: dir } as any)
    console.log(JSON.stringify({ files: db.getAllFiles(), symbols: db.getSymbolsByNames(['legacyMetadataFunction']), map, graph: graph.content }))
    assert.deepEqual(db.getStats(), { files: 2, symbols: 2, edges: 3 })
    assert.deepEqual(db.getAllFiles().sort(), [real, ordinary].sort())
    assert.deepEqual(db.getSymbolsByNames(['legacyMetadataFunction']), [])
    assert.equal(map.graphSize, 2)
    assert.ok(map.entries.every(entry => entry.filePath !== metadata))
    assert.ok(!graph.content.includes(metadata))
    assert.deepEqual(db.getEdgesFrom(ids.metadataId), [])
    assert.deepEqual(db.getEdgesTo(ids.metadataId), [])
    assert.equal(db.getEdgesFrom(ids.realId).filter(edge => edge.kind === 'calls').length, 1)
    assert.equal(db.getEdgesTo(ids.realId).filter(edge => edge.kind === 'calls').length, 1)
    assert.ok(db.getEdgesFrom(ids.realId).some(edge => edge.targetId === 'src/not-yet-indexed.ts:*:0'))
    assert.deepEqual(db.getCoEditNeighbors(real).map(entry => entry.file), [ordinary])
    assert.equal(db.schemaVersion(), 2, 'narrow cleanup must preserve existing schema/migration guards')
    indexer.close()
    indexer = new MeridianIndexer(dir, dir)
    assert.deepEqual(indexer.getDb().getAllFiles().sort(), [real, ordinary].sort())
    assert.ok(indexer.getDb().getEdgesFrom(ids.realId).some(edge => edge.targetId === 'src/not-yet-indexed.ts:*:0'))
  } finally { indexer?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('Cleanup uses exact metadata path components and preserves legitimate hidden, underscore and wildcard names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-metadata-components-'))
  let db = new MeridianDb(dir)
  const metadataPaths = ['._root.ts', 'src/._name[1]_.ts', 'src/.DS_Store', 'src/._directory/file.ts', 'src\\._windows.ts', 'src\\.DS_Store']
  const legalPaths = ['src/.hidden.ts', 'src/_name[1]_.ts', 'src/.DS_StoreX.ts', 'src/folder._ordinary.ts']
  try {
    assert.equal(db.available, true)
    for (const filePath of [...metadataPaths, ...legalPaths]) db.upsertFile({ filePath, contentHash: 'test', symbols: [], edges: [], imports: [], calls: [] })
    db.close()
    const Database = resolveBetterSqlite3(import.meta.url)
    const raw = new Database(join(dir, 'meridian.db'))
    try { raw.prepare('DELETE FROM meridian_meta WHERE key = ?').run(MARKER) } finally { raw.close() }
    db = new MeridianDb(dir)
    assert.deepEqual(db.getAllFiles().sort(), legalPaths.sort())
    assert.equal(db.schemaVersion(), 2)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('A failed cleanup rolls back relationships and leaves no marker; a later open retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-metadata-rollback-'))
  let db: MeridianDb | undefined
  const Database = resolveBetterSqlite3(import.meta.url)
  try {
    await seedLegacy(dir)
    let raw = new Database(join(dir, 'meridian.db'))
    raw.exec("CREATE TRIGGER deny_cleanup BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'fixture denied cleanup'); END")
    raw.close()
    db = new MeridianDb(dir)
    assert.equal(db.available, false, 'failed cleanup must not expose the polluted index')
    db.close()
    raw = new Database(join(dir, 'meridian.db'))
    try {
      assert.equal(raw.prepare('SELECT value FROM meridian_meta WHERE key = ?').get(MARKER), undefined)
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM files').get().count, 3)
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM symbols').get().count, 3)
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM edges').get().count, 5)
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM co_edits').get().count, 2)
      raw.exec('DROP TRIGGER deny_cleanup')
    } finally { raw.close() }
    db = new MeridianDb(dir)
    assert.equal(db.available, true)
    assert.deepEqual(db.getStats(), { files: 2, symbols: 2, edges: 3 })
    db.close()
    raw = new Database(join(dir, 'meridian.db'))
    try { assert.equal(raw.prepare('SELECT value FROM meridian_meta WHERE key = ?').get(MARKER).value, '1') } finally { raw.close() }
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('A concurrent SQLite writer prevents partial cleanup; a later opener retries after the writer releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-metadata-lock-'))
  const Database = resolveBetterSqlite3(import.meta.url)
  let db: MeridianDb | undefined
  let otherWriter: any
  try {
    await seedLegacy(dir)
    otherWriter = new Database(join(dir, 'meridian.db'))
    otherWriter.exec('BEGIN IMMEDIATE')
    db = new MeridianDb(dir)
    assert.equal(db.available, false, 'cleanup must obtain the SQLite writer lock before changing cache rows')
    assert.equal(otherWriter.prepare('SELECT value FROM meridian_meta WHERE key = ?').get(MARKER), undefined)
    assert.equal(otherWriter.prepare('SELECT COUNT(*) AS count FROM edges').get().count, 5)
    otherWriter.exec('ROLLBACK')
    otherWriter.close()
    otherWriter = undefined
    db.close()
    db = new MeridianDb(dir)
    assert.equal(db.available, true)
    assert.deepEqual(db.getStats(), { files: 2, symbols: 2, edges: 3 })
  } finally {
    if (otherWriter) { try { otherWriter.exec('ROLLBACK') } catch {} otherWriter.close() }
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Tool edit bookkeeping cannot reintroduce metadata co-edit edges after cleanup; normal documents still participate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-metadata-bookkeeping-'))
  const indexer = new MeridianIndexer(dir, dir)
  try {
    const db = indexer.getDb()
    assert.equal(db.available, true)
    indexer.recordEdit('src/real.ts', 1)
    for (const file of ['src/._noise.ts', 'src/.DS_Store', '._directory/file.ts']) {
      await indexer.invalidateFile(file)
      indexer.recordEdit(file, 1)
    }
    indexer.flushTurn()
    assert.deepEqual(db.getCoEditNeighbors('src/real.ts'), [])
    assert.ok((await indexer.query('src/real.ts')).entries.every(entry => !entry.filePath.includes('._') && !entry.filePath.includes('.DS_Store')))
    indexer.recordEdit('src/real.ts', 2)
    indexer.recordEdit('README.md', 2)
    indexer.flushTurn()
    assert.deepEqual(db.getCoEditNeighbors('src/real.ts').map(entry => entry.file), ['README.md'])
  } finally { indexer.close(); rmSync(dir, { recursive: true, force: true }) }
})
