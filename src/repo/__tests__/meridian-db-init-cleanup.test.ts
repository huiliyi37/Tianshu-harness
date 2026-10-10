import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianDb } from '../meridian-db.js'
import { resolveBetterSqlite3 } from '../native-resolver.js'

function captureNativeConnections(run: (connections: any[], failures: any[]) => void, injectedError?: Error): void {
  const req = createRequire(import.meta.url)
  const id = req.resolve('better-sqlite3')
  const RealDatabase = req(id)
  const connections: any[] = []
  const failures: any[] = []
  function TrackedDatabase(filename: string, options: any) {
    const connection = new RealDatabase(filename, options)
    connections.push(connection)
    for (const phase of ['pragma', 'exec']) {
      const original = connection[phase]
      connection[phase] = function (this: any, ...args: any[]) {
        try {
          if (injectedError && phase === 'pragma') throw injectedError
          return original.apply(this, args)
        } catch (error) {
          failures.push({ phase, input: String(args[0]).slice(0, 80), code: (error as any).code })
          throw error
        }
      }
    }
    return connection
  }
  TrackedDatabase.prototype = RealDatabase.prototype
  req.cache[id]!.exports = TrackedDatabase
  try { run(connections, failures) } finally {
    req.cache[id]!.exports = RealDatabase
    // Close a leaked connection even when the negative assertion fails.
    for (const connection of connections) if (connection.open) connection.close()
  }
}

function assertClosed(connections: any[]): void {
  assert.equal(connections.length, 1, 'must inspect the real native connection used by Meridian')
  assert.equal(connections[0].open, false, 'failed initialization must close the native connection before fallback')
  assert.throws(() => connections[0].prepare('SELECT 1').get(), /not open/)
}

test('SQLite WAL setup failure closes the native connection before the unavailable fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-init-wal-'))
  const Database = resolveBetterSqlite3(import.meta.url)
  const writer = new Database(join(dir, 'meridian.db'))
  let db: MeridianDb | undefined
  try {
    assert.equal(writer.pragma('journal_mode', { simple: true }), 'delete')
    writer.exec('CREATE TABLE fixture (id INTEGER)')
    writer.exec('BEGIN IMMEDIATE')
    captureNativeConnections((connections, failures) => {
      db = new MeridianDb(dir)
      assert.equal(db.available, false)
      assert.deepEqual(failures, [{ phase: 'pragma', input: 'journal_mode = WAL', code: 'SQLITE_BUSY' }])
      console.log(JSON.stringify({ fixture: 'wal', failures, nativeOpenBeforeClose: connections.map(connection => connection.open) }))
      assertClosed(connections)
      db.close()
      assertClosed(connections)
    })
    writer.exec('ROLLBACK')
    const recovered = new MeridianDb(dir)
    try { assert.equal(recovered.available, true) } finally { recovered.close() }
  } finally {
    db?.close()
    if (writer.inTransaction) writer.exec('ROLLBACK')
    writer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SQLite schema setup failure closes the native connection without changing migration behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-init-schema-'))
  const Database = resolveBetterSqlite3(import.meta.url)
  let writer: any
  let db: MeridianDb | undefined
  try {
    const seed = new MeridianDb(dir)
    try { assert.equal(seed.available, true) } finally { seed.close() }
    writer = new Database(join(dir, 'meridian.db'))
    writer.exec('DROP INDEX idx_symbols_file')
    writer.exec('BEGIN IMMEDIATE')
    captureNativeConnections((connections, failures) => {
      db = new MeridianDb(dir)
      assert.equal(db.available, false)
      assert.equal(failures.length, 1)
      assert.equal(failures[0].phase, 'exec')
      assert.equal(failures[0].code, 'SQLITE_BUSY')
      assert.ok(failures[0].input.includes('CREATE TABLE IF NOT EXISTS files'))
      console.log(JSON.stringify({ fixture: 'schema', failures, nativeOpenBeforeClose: connections.map(connection => connection.open) }))
      assertClosed(connections)
      db.close()
      assertClosed(connections)
    })
    writer.exec('ROLLBACK')
    const recovered = new MeridianDb(dir)
    try { assert.equal(recovered.available, true); assert.equal(recovered.schemaVersion(), 2) } finally { recovered.close() }
  } finally {
    db?.close()
    if (writer) { if (writer.inTransaction) writer.exec('ROLLBACK'); writer.close() }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Broken native bundle errors still fail loud after closing any initialized connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-init-bundle-'))
  const failure = Object.assign(new Error('fixture broken native bundle'), { code: 'ESQLITE_BUNDLE_BROKEN' })
  try {
    captureNativeConnections((connections) => {
      const db = new MeridianDb(dir)
      assert.throws(() => db.available, error => error === failure)
      assertClosed(connections)
      db.close()
    }, failure)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
