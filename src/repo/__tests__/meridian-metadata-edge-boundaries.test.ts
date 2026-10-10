import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianDb } from '../meridian-db.js'
import { MeridianIndexer } from '../meridian-indexer.js'
import { resolveBetterSqlite3 } from '../native-resolver.js'
import type { MeridianSymbol, ParseResult } from '../meridian-types.js'

const MARKER = 'filesystem_metadata_cleanup_v1'
const symbol = (filePath: string, name: string): MeridianSymbol => ({ id: `${filePath}:${name}:1`, filePath, name, kind: 'function', line: 1, exported: true, contentHash: 'fixture' })
const parsed = (filePath: string, symbols: MeridianSymbol[], imports: string[] = []): ParseResult => ({ filePath, symbols, imports, contentHash: 'fixture', edges: [], calls: [] })

test('Cold metadata cleanup removes orphan named endpoints left after a normal upsert and preserves exact legal paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-orphan-endpoints-'))
  const metadataPaths = ['src/._legacy.ts', 'src/a:b/._legacy.ts', 'C:\\qa\\src\\._legacy.ts', 'src/.DS_Store/old.ts']
  const legalPaths = ['src/.hidden.ts', 'src/a:b/normal.ts', 'C:\\qa\\src\\.hidden.ts', 'src/.DS_StoreX.ts', 'src/folder._ordinary.ts']
  const real = symbol('src/real.ts', 'realFunction')
  const route = symbol('src/routes.ts', 'GET /._ordinary/:id')
  const currentRoute = symbol('src/routes.ts', 'GET /._current/:id')
  const expectedTargets = [
    'src/routes.ts:GET /._ordinary/:id:1', 'src/routes.ts:GET /._current/:id:1',
    'src/.hidden.ts:._ordinary:1', 'src/a:b/normal.ts:._ordinary:1', 'C:\\qa\\src\\.hidden.ts:._ordinary:1',
    'src/.DS_StoreX.ts:._ordinary:1', 'src/folder._ordinary.ts:._ordinary:1', 'src/not-yet-indexed.ts:*:0', 'src/data.json:*:0', 'docs/README.md:*:0',
  ]
  let db = new MeridianDb(dir)
  let indexer: MeridianIndexer | undefined
  try {
    assert.equal(db.available, true)
    db.upsertFile(parsed(real.filePath, [real]))
    db.upsertFile(parsed(route.filePath, [route]))
    db.upsertEdge(real.id, route.id, 'route_handles', 1)
    db.upsertFile(parsed(route.filePath, [currentRoute]))
    db.upsertEdge(real.id, currentRoute.id, 'route_handles', 1)
    for (const file of metadataPaths) {
      const old = symbol(file, 'oldFunction')
      db.upsertFile(parsed(file, [old]))
      db.upsertEdge(real.id, old.id, 'calls', 1)
      db.upsertFile(parsed(file, []))
      assert.deepEqual(db.getSymbolsForFile(file), [])
      assert.ok(db.getEdgesFrom(real.id).some(e => e.targetId === old.id), 'normal upsert leaves the historical incoming orphan')
      // Historical orphan source endpoints are also a migration boundary.
      db.upsertEdge(old.id, real.id, 'calls', 1)
    }
    for (const file of legalPaths) {
      const ordinary = symbol(file, '._ordinary')
      db.upsertFile(parsed(file, [ordinary]))
      db.upsertEdge(real.id, ordinary.id, 'calls', 1)
      db.upsertEdge(ordinary.id, real.id, 'calls', 1)
    }
    for (const target of ['src/not-yet-indexed.ts:*:0', 'src/data.json:*:0', 'docs/README.md:*:0']) db.upsertEdge(real.id, target, 'imports', 1)
    db.close()
    const Database = resolveBetterSqlite3(import.meta.url)
    const raw = new Database(join(dir, 'meridian.db'))
    try { raw.prepare('DELETE FROM meridian_meta WHERE key = ?').run(MARKER) } finally { raw.close() }
    indexer = new MeridianIndexer(dir, dir)
    db = indexer.getDb()
    assert.deepEqual(db.getEdgesFrom(real.id).map(e => e.targetId).sort(), [...expectedTargets].sort())
    assert.deepEqual(db.getEdgesTo(real.id).map(e => e.sourceId).sort(), expectedTargets.slice(2, 7).sort())
    assert.deepEqual(db.getAllFiles().sort(), ['src/real.ts', 'src/routes.ts', ...legalPaths].sort())
    assert.equal(db.schemaVersion(), 2)
    const map = await indexer.query('src/real.ts')
    assert.ok(!map.entries.some(e => metadataPaths.includes(e.filePath)), 'deleted named endpoints must not reappear in graph')
  } finally { indexer?.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('Real parser imports cannot add metadata placeholder edges after cleanup, while other resolved targets keep their semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-import-endpoints-'))
  const indexer = new MeridianIndexer(dir, dir)
  try {
    mkdirSync(join(dir, 'src/.rivet'), { recursive: true })
    writeFileSync(join(dir, 'src/main.ts'), "import {noise} from './._noise'; import {legal} from './.hidden'; import {runtime} from './.rivet/runtime'; export function real(){return noise()+legal()+runtime();}")
    writeFileSync(join(dir, 'src/._noise.ts'), 'export function noise(){return 1}')
    writeFileSync(join(dir, 'src/.hidden.ts'), 'export function legal(){return 2}')
    writeFileSync(join(dir, 'src/.rivet/runtime.ts'), 'export function runtime(){return 3}')
    await indexer.indexFile('src/main.ts')
    const db = indexer.getDb()
    const edges = db.getSymbolsForFile('src/main.ts').flatMap(s => db.getEdgesFrom(s.id))
    assert.deepEqual(edges.filter(e => e.kind === 'imports').map(e => e.targetId).sort(), ['src/.hidden.ts:*:0', 'src/.rivet/runtime.ts:*:0'])
    assert.deepEqual(db.getSymbolsForFile('src/._noise.ts'), [])
    assert.ok(!(await indexer.query('src/main.ts')).entries.some(e => e.filePath === 'src/._noise.ts'))
    assert.equal(db.schemaVersion(), 2)
  } finally { indexer.close(); rmSync(dir, { recursive: true, force: true }) }
})
