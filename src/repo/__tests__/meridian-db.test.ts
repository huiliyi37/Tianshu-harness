import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { resolveBetterSqlite3 } from '../native-resolver.js'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('meridian db', () => {
  let db: MeridianDb
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-'))
    db = new MeridianDb(dir)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upserts and retrieves symbols', () => {
    db.upsertFile({
      filePath: 'src/foo.ts',
      contentHash: 'abc123',
      symbols: [{ id: 'src/foo.ts:hello:1', name: 'hello', kind: 'function', filePath: 'src/foo.ts', line: 1, exported: true, contentHash: 'abc123' }],
      edges: [],
      imports: ['./bar.js'],
      calls: [],
    })
    const symbols = db.getSymbolsForFile('src/foo.ts')
    assert.equal(symbols.length, 1)
    assert.equal(symbols[0]!.name, 'hello')
  })

  it('getSymbolsByNames returns one batch for a name set and matches getAllSymbols for the same set', () => {
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [
        { id: 'src/a.ts:hello:1', name: 'hello', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' },
        { id: 'src/a.ts:other:2', name: 'other', kind: 'function', filePath: 'src/a.ts', line: 2, exported: false, contentHash: 'h1' },
      ],
      edges: [], imports: [], calls: [],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [{ id: 'src/b.ts:hello:1', name: 'hello', kind: 'function', filePath: 'src/b.ts', line: 1, exported: false, contentHash: 'h2' }],
      edges: [], imports: [], calls: [],
    })
    const got = db.getSymbolsByNames(['hello', 'missing', 'hello'])
    assert.deepEqual(got.map(s => s.id).sort(), ['src/a.ts:hello:1', 'src/b.ts:hello:1'])
    const expected = db.getAllSymbols().filter(s => s.name === 'hello').map(s => s.id).sort()
    assert.deepEqual(got.map(s => s.id).sort(), expected, 'name-set batch must equal getAllSymbols for the same names')
    assert.deepEqual(db.getSymbolsByNames([]), [])
    assert.deepEqual(db.getSymbolsByNames(['missing']), [])
  })

  it('skips re-parse when hash matches', () => {
    assert.equal(db.needsParse('src/foo.ts', 'hash1'), true)
    db.upsertFile({ filePath: 'src/foo.ts', contentHash: 'hash1', symbols: [], edges: [], imports: [], calls: [] })
    assert.equal(db.needsParse('src/foo.ts', 'hash1'), false)
    assert.equal(db.needsParse('src/foo.ts', 'hash2'), true)
  })

  it('hasFiles probes cold-start emptiness without full scans (P1-2)', () => {
    // 冷库（新 clone 首启）files 表为空——hasFiles 用 LIMIT 1 轻量探测，
    // 供 tool-pipeline 区分「空库需落回 importGraph」与「索引有数据」。
    assert.equal(db.hasFiles(), false)
    db.upsertFile({
      filePath: 'src/foo.ts',
      contentHash: 'h1',
      symbols: [],
      edges: [],
      imports: [],
      calls: [],
    })
    assert.equal(db.hasFiles(), true)
  })

  it('stores and retrieves edges', () => {
    db.upsertFile({
      filePath: 'src/a.ts',
      contentHash: 'h1',
      symbols: [
        { id: 'src/a.ts:A:1', name: 'A', kind: 'class', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' },
      ],
      edges: [{ sourceId: 'src/a.ts:A:1', targetId: 'src/b.ts:B:1', kind: 'imports', weight: 1.0 }],
      imports: ['./b.js'],
      calls: [],
    })
    const edges = db.getEdgesFrom('src/a.ts:A:1')
    assert.equal(edges.length, 2) // explicit edge + import edge from first symbol
    assert.ok(edges.some(e => e.targetId === 'src/b.ts:B:1'))
  })

  it('records access and returns access count', () => {
    db.recordAccess('src/foo.ts')
    db.recordAccess('src/foo.ts')
    const count = db.getAccessCount('src/foo.ts')
    assert.equal(count, 2)
  })

  it('returns neighbors within N hops', () => {
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [{ id: 'a:X:1', name: 'X', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [{ sourceId: 'a:X:1', targetId: 'b:Y:1', kind: 'calls', weight: 1.0 }],
      imports: [],
      calls: [],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [{ id: 'b:Y:1', name: 'Y', kind: 'function', filePath: 'src/b.ts', line: 1, exported: true, contentHash: 'h2' }],
      edges: [{ sourceId: 'b:Y:1', targetId: 'c:Z:1', kind: 'calls', weight: 1.0 }],
      imports: [],
      calls: [],
    })
    const neighbors = db.getNeighborIds('a:X:1', 2)
    assert.ok(neighbors.has('b:Y:1'))
    assert.ok(neighbors.has('c:Z:1'))
  })

  it('returns stats', () => {
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [{ id: 'a:X:1', name: 'X', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [{ sourceId: 'a:X:1', targetId: 'b:Y:1', kind: 'calls', weight: 1.0 }],
      imports: [],
      calls: [],
    })
    const stats = db.getStats()
    assert.equal(stats.files, 1)
    assert.equal(stats.symbols, 1)
    assert.equal(stats.edges, 1)
  })

  it('saves and loads physarum edges', () => {
    db.savePhysarumEdges([
      { fileA: 'a.ts', fileB: 'b.ts', weight: 2.5, flow: 3, consolidated: true, activationCount: 7, lastActivatedTurn: 12, direction: 0.4 },
      { fileA: 'c.ts', fileB: 'd.ts', weight: 1.0, flow: 0, consolidated: false, activationCount: 1, lastActivatedTurn: 1, direction: 0 },
    ])
    const loaded = db.loadPhysarumEdges()
    assert.equal(loaded.length, 2)
    const first = loaded.find(e => e.fileA === 'a.ts')!
    assert.equal(first.weight, 2.5)
    assert.equal(first.consolidated, true)
    assert.equal(first.activationCount, 7)
    assert.equal(first.direction, 0.4)
  })

  it('records and retrieves physarum prediction observations newest first', () => {
    db.recordPhysarumPredictionObservation({
      sourceFile: 'src/a.ts',
      predictedAtTurn: 1,
      predictions: [{ file: 'src/b.ts', score: 2.5 }],
      observedFile: 'src/b.ts',
      observedAtTurn: 2,
      hitRank: 1,
      leadTurns: 1,
    })
    db.recordPhysarumPredictionObservation({
      sourceFile: 'src/b.ts',
      predictedAtTurn: 2,
      predictions: [{ file: 'src/a.ts', score: 1.2 }],
      observedFile: 'src/c.ts',
      observedAtTurn: 3,
      hitRank: null,
      leadTurns: 1,
    })

    const loaded = db.getPhysarumPredictionObservations(10)
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.sourceFile, 'src/b.ts')
    assert.equal(loaded[0]!.hitRank, null)
    assert.deepEqual(loaded[1]!.predictions, [{ file: 'src/b.ts', score: 2.5 }])
  })

  it('does not create meridian.db on construction (lazy open)', () => {
    const lazyDir = mkdtempSync(join(tmpdir(), 'meridian-lazy-'))
    try {
      const lazyDb = new MeridianDb(lazyDir)
      assert.equal(existsSync(join(lazyDir, 'meridian.db')), false, 'db file should NOT exist after construction')
      // First actual query triggers lazy open
      assert.deepEqual(lazyDb.getSymbolsForFile('src/none.ts'), [])
      assert.equal(existsSync(join(lazyDir, 'meridian.db')), true, 'db file SHOULD exist after first query')
      lazyDb.close()
    } finally {
      rmSync(lazyDir, { recursive: true, force: true })
    }
  })

  it('savePhysarumEdges replaces previous state', () => {
    db.savePhysarumEdges([
      { fileA: 'x.ts', fileB: 'y.ts', weight: 1.0, flow: 1, consolidated: false, activationCount: 1, lastActivatedTurn: 1, direction: 0 },
    ])
    db.savePhysarumEdges([
      { fileA: 'p.ts', fileB: 'q.ts', weight: 3.0, flow: 5, consolidated: true, activationCount: 10, lastActivatedTurn: 20, direction: -0.2 },
    ])
    const loaded = db.loadPhysarumEdges()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.fileA, 'p.ts')
  })

  it('saves and loads P3 tool pattern miner state', () => {
    const snapshot = {
      version: 1 as const,
      bigrams: [{
        fromTool: 'grep',
        entries: [{ tool: 'read_file', targetPath: 'src/foo.ts' }],
      }],
      trigrams: [{
        context: 'glob|grep',
        entries: [{ tool: 'read_file', targetPath: 'src/foo.ts' }],
      }],
      prev: 'grep',
    }

    db.saveToolPatternMinerSnapshot(snapshot)

    assert.deepEqual(db.loadToolPatternMinerSnapshot(), snapshot)
  })

  // ─── D6 task 1: LIKE → GLOB precision fixes ─────────────────────────
  it('getTestsFor does not match files whose name differs only by underscore wildcard (tool_x.ts vs toolAx.ts)', () => {
    db.upsertEdge('src/agent/toolA.test.ts:test1:1', 'src/agent/toolAx.ts:foo:1', 'tested_by', 1.0)
    db.upsertEdge('src/agent/toolX.test.ts:test2:1', 'src/agent/tool_x.ts:foo:1', 'tested_by', 1.0)
    assert.deepEqual(db.getTestsFor('src/agent/tool_x.ts'), ['src/agent/toolX.test.ts'])
  })

  it('getReverseDependents does not return callers of a similarly-named file (tool_x.ts vs toolAx.ts)', () => {
    db.upsertEdge('src/agent/caller.ts:call:1', 'src/agent/toolAx.ts:foo:1', 'imports', 1.0)
    db.upsertEdge('src/agent/realCaller.ts:call:1', 'src/agent/tool_x.ts:foo:1', 'imports', 1.0)
    const deps = db.getReverseDependents('src/agent/tool_x.ts')
    assert.deepEqual(deps.map(d => d.file), ['src/agent/realCaller.ts'])
  })

  it('matches file paths case-sensitively (Foo.ts vs foo.ts)', () => {
    db.upsertEdge('src/tests/upper.test.ts:t1:1', 'src/foo.ts:bar:1', 'tested_by', 1.0)
    db.upsertEdge('src/tests/lower.test.ts:t2:1', 'src/Foo.ts:bar:1', 'tested_by', 1.0)
    assert.deepEqual(db.getTestsFor('src/Foo.ts'), ['src/tests/lower.test.ts'])
  })

  // ─── 2026-09-12: GLOB 前缀必须 JS 侧整体绑定——SQL 拼接（? || ':*'）会让
  // SQLite 放弃 idx_edges_target 退化为全表扫描（实测 225K 边 ~1s/查询，
  // analyzeImpact 三跳 BFS 累计成 [slow-sync-stage] 4s 警告）。此处钉查询计划。
  it('edge prefix queries use the edges index, never a full scan (EXPLAIN)', () => {
    db.upsertEdge('src/a.ts:call:1', 'src/b.ts:foo:1', 'imports', 1.0)
    db.upsertEdge('src/t.test.ts:t:1', 'src/b.ts:foo:1', 'tested_by', 1.0)
    const raw = (db as any).db
    // 拦截 prepare 捕获方法的真 SQL 与实参——测试与方法实现零文本漂移。
    const captured: Array<{ sql: string; args: unknown[] }> = []
    const origPrepare = raw.prepare.bind(raw)
    raw.prepare = (sql: string) => {
      captured.push({ sql, args: [] as unknown[] })
      const stmt = origPrepare(sql)
      const origAll = stmt.all.bind(stmt)
      stmt.all = (...args: unknown[]) => { captured[captured.length - 1]!.args = args; return origAll(...args) }
      return stmt
    }
    try {
      db.getReverseDependents('src/b.ts')
      db.getForwardDependencies('src/b.ts')
      db.getTestsFor('src/b.ts')
    } finally {
      raw.prepare = origPrepare
    }
    assert.equal(captured.length, 3)
    const expectedIndex: Array<RegExp> = [/idx_edges_target/, /idx_edges_source/, /idx_edges_target/]
    for (const [i, { sql, args }] of captured.entries()) {
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
        .map((r) => r.detail).join(' | ')
      assert.match(plan, new RegExp(`SEARCH e USING INDEX ${expectedIndex[i]!.source}`),
        `查询 ${i} 应走索引而非全表扫描: ${plan}`)
    }
  })

  // ─── D6 task 2: schema version + legacy migration ──────────────────
  it('reports schema version 2 after open', () => {
    assert.equal(db.schemaVersion(), 2)
  })

  /** Roll user_version back to 0 so the next open sees a pre-v1 database. */
  const markLegacy = () => {
    const Database = resolveBetterSqlite3(import.meta.url)
    const conn = new Database(join(dir, 'meridian.db'))
    try { conn.pragma('user_version = 0') } finally { conn.close() }
  }

  it('migrates legacy absolute-path rows and dangling imports edges on reopen', () => {
    // Historical dirty rows: absolute-path file + its symbol + a dangling imports edge
    db.upsertFile({
      filePath: '/abs/dir/legacy.ts',
      contentHash: 'h1',
      symbols: [{ id: '/abs/dir/legacy.ts:X:1', name: 'X', kind: 'function', filePath: '/abs/dir/legacy.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [],
      imports: [],
      calls: [],
    })
    db.upsertEdge('/abs/dir/legacy.ts:X:1', 'src/nonexistent.ts:*:0', 'imports', 1.0)
    // Clean rows that must survive migration
    db.upsertFile({
      filePath: 'src/ok.ts',
      contentHash: 'h2',
      symbols: [{ id: 'src/ok.ts:Y:1', name: 'Y', kind: 'function', filePath: 'src/ok.ts', line: 1, exported: true, contentHash: 'h2' }],
      edges: [],
      imports: [],
      calls: [],
    })
    db.upsertEdge('src/ok.ts:Y:1', 'src/ok.ts:*:0', 'imports', 1.0)

    // Reopen a pre-v1 database to trigger the one-shot migration
    db.close()
    markLegacy()
    db = new MeridianDb(dir)

    const files = db.getAllFiles()
    assert.ok(!files.some(f => f.startsWith('/')), `absolute-path rows remain: ${JSON.stringify(files)}`)
    assert.ok(files.includes('src/ok.ts'), 'clean relative row must survive migration')
    assert.equal(db.schemaVersion(), 2)
    // Dangling imports edge purged; valid imports edge kept
    assert.equal(db.getEdgesTo('src/nonexistent.ts:*:0').length, 0, 'dangling imports edge must be purged')
    assert.equal(db.getEdgesTo('src/ok.ts:*:0').length, 1, 'valid imports edge must survive')
  })

  it('migration is idempotent across reopenings', () => {
    db.upsertFile({
      filePath: '/abs/x.ts',
      contentHash: 'h1',
      symbols: [{ id: '/abs/x.ts:Z:1', name: 'Z', kind: 'function', filePath: '/abs/x.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [],
      imports: [],
      calls: [],
    })
    db.close()
    markLegacy()
    db = new MeridianDb(dir)
    assert.ok(!db.getAllFiles().some(f => f.startsWith('/')), 'first migration must purge absolute paths')
    db.close()
    db = new MeridianDb(dir)
    assert.ok(!db.getAllFiles().some(f => f.startsWith('/')), 'second migration must be a no-op')
    assert.equal(db.schemaVersion(), 2)
  })

  it('leaves edges to not-yet-indexed files alone once the db is at v1', () => {
    // src/b.ts exists on disk but has not been indexed yet, so the edge into it
    // looks "dangling" to the v1 purge. Re-running the purge on every open would
    // delete it, and the unchanged content hash means it would never come back.
    db.upsertFile({
      filePath: 'src/a.ts',
      contentHash: 'ha',
      symbols: [{ id: 'src/a.ts:A:1', name: 'A', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'ha' }],
      edges: [],
      imports: ['src/b.ts'],
      calls: [],
    })
    assert.deepEqual(db.getReverseDependents('src/b.ts').map(d => d.file), ['src/a.ts'])

    db.close()
    db = new MeridianDb(dir)
    assert.deepEqual(db.getReverseDependents('src/b.ts').map(d => d.file), ['src/a.ts'],
      'reopen must not purge the reverse-dependency edge of an unindexed target')
    assert.equal(db.needsParse('src/a.ts', 'ha'), false, 'source stays unchanged, so a purged edge could never be rebuilt')
  })

  // ─── P2-2 出边 API（getForwardDependencies）─────────────────────────

  function upsertImporter(filePath: string, imports: string[]): void {
    db.upsertFile({
      filePath,
      contentHash: `h-${filePath}`,
      symbols: [{ id: `${filePath}:A:1`, name: 'A', kind: 'function', filePath, line: 1, exported: true, contentHash: `h-${filePath}` }],
      edges: [],
      imports,
      calls: [],
    })
  }

  it('getForwardDependencies returns the imports edges of a file (P2-2)', () => {
    upsertImporter('src/a.ts', ['src/b.ts', 'src/c.ts'])
    upsertImporter('src/b.ts', [])
    const files = db.getForwardDependencies('src/a.ts').map(d => d.file).sort()
    assert.deepEqual(files, ['src/b.ts', 'src/c.ts'])
    const kinds = db.getForwardDependencies('src/a.ts').map(d => d.kind)
    assert.deepEqual(kinds, ['imports', 'imports'])
  })

  it('getForwardDependencies excludes self-imports (P2-2)', () => {
    upsertImporter('src/a.ts', ['src/a.ts'])
    assert.deepEqual(db.getForwardDependencies('src/a.ts'), [])
  })

  it('getForwardDependencies returns [] on empty graph (P2-2)', () => {
    assert.deepEqual(db.getForwardDependencies('src/ghost.ts'), [])
    upsertImporter('src/a.ts', [])
    assert.deepEqual(db.getForwardDependencies('src/a.ts'), [])
  })

  it('getForwardDependencies keeps dangling edges (unindexed target) and glob-escapes path metacharacters (P2-2)', () => {
    upsertImporter('src/a.ts', ['src/ghost.ts'])
    assert.deepEqual(db.getForwardDependencies('src/a.ts').map(d => d.file), ['src/ghost.ts'],
      'edge into a not-yet-indexed file must still be reported (v1 does not purge)')
    // 路径含 GLOB 元字符：必须字面匹配（globEscape），否则 [x] 被当字符类
    upsertImporter('src/[x].ts', ['src/y.ts'])
    assert.deepEqual(db.getForwardDependencies('src/[x].ts').map(d => d.file), ['src/y.ts'])
  })
})

describe('meridian db with sqlite unavailable', () => {
  // Point stateDir at a regular file: existsSync passes (so no mkdir), then
  // opening <file>/meridian.db fails. Same degraded state a missing native
  // binding produces, without having to break the install to reach it.
  let notADir: string
  let db: MeridianDb
  let realWarn: typeof console.warn

  beforeEach(() => {
    notADir = join(tmpdir(), `meridian-degraded-${process.pid}-${Date.now()}`)
    writeFileSync(notADir, 'a file where a directory is expected')
    db = new MeridianDb(notADir)
    realWarn = console.warn
    console.warn = () => {} // degrading warns by design; not the subject here
  })

  afterEach(() => {
    console.warn = realWarn
    rmSync(notADir, { force: true })
  })

  it('reports itself unavailable', () => {
    assert.equal(db.available, false)
  })

  it('answers needsParse with false so callers stop parsing into a sink', () => {
    // Unguarded, the no-op DB's get() returns undefined, which the raw query
    // reads as "hash changed" — so every caller re-reads and re-parses the same
    // file forever, and in the indexer that fans out across its whole import
    // list on each pass.
    assert.equal(db.needsParse('src/a.ts', 'hash-1'), false)
    db.upsertFile({ filePath: 'src/a.ts', contentHash: 'hash-1', symbols: [], edges: [], imports: [], calls: [] })
    assert.equal(db.needsParse('src/a.ts', 'hash-1'), false, 'a write that went nowhere must not flip it either')
  })

  it('accepts writes without throwing', () => {
    assert.doesNotThrow(() => db.recordAccess('src/a.ts'))
  })
})
