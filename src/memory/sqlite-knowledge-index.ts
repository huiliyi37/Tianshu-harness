import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { tokenize } from '../search/text-index.js'
import type { MemoryKind } from './unified-memory.js'

export type KnowledgeDocumentSource = 'entry' | 'markdown' | 'playbook'

export interface SQLiteKnowledgeDocument {
  id: string
  text: string
  indexText: string
  source: KnowledgeDocumentSource
  kind?: MemoryKind
  topic?: string
  current: boolean
  ts: number
}

export interface SQLiteKnowledgeSearchOptions {
  kind?: MemoryKind | MemoryKind[]
  topic?: string
  includeHistory?: boolean
  source?: 'playbook'
}

export interface SQLiteKnowledgeRank {
  id: string
  score: number
}

type Statement = {
  get: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
  run: (...params: unknown[]) => unknown
}

type Database = {
  exec: (sql: string) => void
  prepare: (sql: string) => Statement
  close: () => void
}

const SCHEMA_VERSION = 1
const DB_FILENAME = 'memory-index.sqlite'

function ftsQuery(query: string): string {
  return [...new Set(tokenize(query))]
    .slice(0, 32)
    .map(term => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ')
}

function indexedContent(document: SQLiteKnowledgeDocument): string {
  const terms = tokenize(document.indexText).join(' ')
  return terms ? `${document.indexText}\n${terms}` : document.indexText
}

function passesFilters(document: SQLiteKnowledgeDocument, options: SQLiteKnowledgeSearchOptions): boolean {
  if (options.source === 'playbook' && document.source !== 'playbook') return false
  if (!options.includeHistory && !document.current) return false
  if (options.kind) {
    const kinds = Array.isArray(options.kind) ? options.kind : [options.kind]
    if (!document.kind || !kinds.includes(document.kind)) return false
  }
  if (options.topic && !(document.topic ?? '').toLowerCase().includes(options.topic.toLowerCase())) return false
  return true
}

/**
 * Persistent, rebuildable FTS5 projection of the project knowledge corpus.
 * JSONL/Markdown remain authoritative; any SQLite failure degrades to the
 * existing in-memory BM25 path and never blocks memory recall.
 */
export class SQLiteKnowledgeIndex {
  private disabled = false

  constructor(private readonly cwd: string) {}

  private async database(): Promise<Database | null> {
    if (this.disabled) return null
    return this.openDatabase()
  }

  private async openDatabase(): Promise<Database | null> {
    let db: Database | undefined
    try {
      const dir = join(this.cwd, '.rivet', 'knowledge')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, DB_FILENAME)
      if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600))
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(path) as unknown as Database
      const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
      const version = row?.user_version ?? 0
      if (version !== 0 && version !== SCHEMA_VERSION) {
        db.close()
        this.disabled = true
        return null
      }
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 3000')
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_docs (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          source TEXT NOT NULL,
          kind TEXT,
          topic TEXT,
          current INTEGER NOT NULL,
          ts INTEGER NOT NULL
        ) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          id UNINDEXED,
          content,
          tokenize = 'unicode61'
        );
        CREATE TABLE IF NOT EXISTS knowledge_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
      return db
    } catch {
      try { db?.close() } catch { /* partially opened */ }
      this.disabled = true
      return null
    }
  }

  private sync(db: Database, documents: readonly SQLiteKnowledgeDocument[], fingerprint: string): void {
    const stored = db.prepare("SELECT value FROM knowledge_meta WHERE key = 'source_fingerprint'").get() as { value?: string } | undefined
    if (stored?.value === fingerprint) return

    const insertDoc = db.prepare('INSERT INTO knowledge_docs(id, text, source, kind, topic, current, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertFts = db.prepare('INSERT INTO knowledge_fts(id, content) VALUES (?, ?)')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM knowledge_docs; DELETE FROM knowledge_fts;')
      for (const document of documents) {
        insertDoc.run(
          document.id,
          document.text,
          document.source,
          document.kind ?? null,
          document.topic ?? null,
          document.current ? 1 : 0,
          document.ts,
        )
        insertFts.run(document.id, indexedContent(document))
      }
      db.prepare("INSERT INTO knowledge_meta(key, value) VALUES ('source_fingerprint', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(fingerprint)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }

  async search(
    documents: readonly SQLiteKnowledgeDocument[],
    fingerprint: string,
    query: string,
    limit: number,
    options: SQLiteKnowledgeSearchOptions,
  ): Promise<SQLiteKnowledgeRank[] | null> {
    const match = ftsQuery(query)
    if (!match) return []
    const db = await this.database()
    if (!db) return null
    try {
      this.sync(db, documents, fingerprint)
      const byId = new Map(documents.map(document => [document.id, document]))
      const scanLimit = Math.max(limit * 12, documents.length, 48)
      const rows = db.prepare(`
        SELECT id, bm25(knowledge_fts) AS rank
        FROM knowledge_fts
        WHERE knowledge_fts MATCH ?
        ORDER BY rank ASC, id ASC
        LIMIT ?
      `).all(match, scanLimit) as Array<{ id: string; rank: number }>
      return rows
        .flatMap(row => {
          const document = byId.get(row.id)
          if (!document || !passesFilters(document, options)) return []
          const relevance = Math.abs(row.rank)
          return [{ id: row.id, score: relevance / (1 + relevance) }]
        })
        .slice(0, limit)
    } catch {
      return null
    } finally {
      try { db.close() } catch { /* already closed */ }
    }
  }

  close(): void { /* connections are operation-scoped */ }
}
