/**
 * KnowledgeIndex 检索契约测试（Wave 3 知识重构）。
 *
 * 覆盖：BM25 相关性、结构过滤（kind/topic/validity）、时间邻近加权、
 * md 分块命中、mtime 惰性重建。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KnowledgeIndex, recencyBoost } from '../knowledge-index.js'
import { appendMemoryEntry, supersedeMemoryEntry } from '../unified-memory.js'

describe('knowledge-index', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-kidx-'))
  })

  it('returns relevant entries for keyword queries (固定检索用例)', async () => {
    appendMemoryEntry(cwd, {
      text: 'Sync to the public repo only via scripts/sync-to-public.sh, never push tianshu directly',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [], topic: 'git-workflow',
    })
    appendMemoryEntry(cwd, {
      text: 'Desktop sidecar drives the agent kernel over HTTP/SSE from src/server',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [], topic: 'desktop',
    })

    const idx = new KnowledgeIndex(cwd)
    const hits = await idx.search('public repo sync push')
    assert.ok(hits.length >= 1)
    assert.ok(hits[0]!.text.includes('sync-to-public'), 'most relevant rule must rank first')
  })

  it('filters by kind and topic before scoring', async () => {
    appendMemoryEntry(cwd, {
      text: 'Testing convention: node:test runner with assert strict everywhere',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [], topic: 'testing',
    })
    appendMemoryEntry(cwd, {
      text: 'Testing insight: flaky tests correlate with shared tmp paths',
      kind: 'finding', confidence: 0.8, source: 'essence-gate', status: 'verified', tags: [], topic: 'testing',
    })

    const idx = new KnowledgeIndex(cwd)
    const ruleOnly = await idx.search('testing', { kind: 'project_rule' })
    assert.ok(ruleOnly.every(h => h.entry?.kind === 'project_rule'))

    const topicHits = await idx.search('testing', { topic: 'testing' })
    assert.ok(topicHits.length >= 2)
  })

  it('excludes superseded entries by default, includes with includeHistory', async () => {
    const oldEntry = appendMemoryEntry(cwd, {
      text: 'Bundler webpack is used for all builds in this project',
      kind: 'project_rule', confidence: 0.9, source: 'manual', status: 'verified', tags: [], topic: 'build',
    })
    const newEntry = appendMemoryEntry(cwd, {
      text: 'Bundler esbuild is used for all builds in this project',
      kind: 'project_rule', confidence: 0.95, source: 'essence-gate', status: 'verified', tags: [], topic: 'build',
    })
    supersedeMemoryEntry(cwd, oldEntry.id, newEntry.id)

    const idx = new KnowledgeIndex(cwd)
    const current = await idx.search('bundler builds')
    assert.ok(!current.some(h => h.entry?.id === oldEntry.id), 'superseded entry hidden by default')
    assert.ok(current.some(h => h.entry?.id === newEntry.id))

    const history = await idx.search('bundler builds', { includeHistory: true })
    assert.ok(history.some(h => h.entry?.id === oldEntry.id))
  })

  it('recency boost ranks newer entries above older equally-matching ones', async () => {
    const now = Date.now()
    appendMemoryEntry(cwd, {
      id: 'old-entry',
      text: 'Cache invalidation strategy relies on frozen prefix snapshots',
      kind: 'finding', confidence: 0.9, source: 'manual', status: 'verified', tags: [],
      ts: now - 180 * 86_400_000, // 180 days old
    })
    appendMemoryEntry(cwd, {
      id: 'new-entry',
      text: 'Cache invalidation strategy relies on frozen prefix snapshots',
      kind: 'finding', confidence: 0.9, source: 'manual', status: 'verified', tags: [],
      ts: now - 86_400_000, // 1 day old
    })

    const idx = new KnowledgeIndex(cwd)
    const hits = await idx.search('cache invalidation frozen prefix')
    assert.ok(hits.length >= 2)
    assert.equal(hits[0]!.entry?.id, 'new-entry', 'newer entry must outrank older twin')

    // 配方本身
    assert.ok(recencyBoost(now - 86_400_000, now) > recencyBoost(now - 180 * 86_400_000, now))
  })

  it('surfaces knowledge/*.md chunks', async () => {
    const dir = join(cwd, '.rivet', 'knowledge')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.md'), '# Retrieval map\n\nBefore changing prompt engine, recall prefix-cache invariants first.\n')

    const idx = new KnowledgeIndex(cwd)
    const hits = await idx.search('prompt engine prefix cache invariants')
    assert.ok(hits.some(h => h.file === 'manifest.md'))
  })

  it('indexes playbook lessons and honors source:playbook filter (Wave 4 recall-only channel)', async () => {
    const rivetDir = join(cwd, '.rivet')
    mkdirSync(rivetDir, { recursive: true })
    writeFileSync(join(rivetDir, 'playbook.jsonl'), JSON.stringify({
      id: 'pb1', createdAt: Date.now(), keywords: ['pagination', 'endpoint'],
      lesson: 'verify pagination bounds before shipping', context: 'users endpoint task',
      useCount: 0, lastUsedAt: null, importance: 0.7,
    }) + '\n')
    appendMemoryEntry(cwd, {
      text: 'Pagination endpoints must clamp limit to 100',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [], topic: 'api',
    })

    const idx = new KnowledgeIndex(cwd)
    const mixed = await idx.search('pagination endpoint')
    assert.ok(mixed.some(h => h.playbook), 'playbook lesson discoverable in default search')
    assert.ok(mixed.some(h => h.entry), 'structured entries still present')

    const pbOnly = await idx.search('pagination endpoint', { source: 'playbook' })
    assert.ok(pbOnly.length >= 1)
    assert.ok(pbOnly.every(h => h.playbook === true), 'source:playbook returns only lessons')
    assert.ok(pbOnly[0]!.text.includes('verify pagination bounds'))
  })

  it('rebuilds lazily when the store changes', async () => {
    const idx = new KnowledgeIndex(cwd)
    assert.equal((await idx.search('lazily rebuilt entry')).length, 0)

    appendMemoryEntry(cwd, {
      text: 'Lazily rebuilt entry should be found after append without new index instance',
      kind: 'finding', confidence: 0.9, source: 'manual', status: 'verified', tags: [],
    })
    const hits = await idx.search('lazily rebuilt entry')
    assert.ok(hits.length >= 1)
  })

  it('excludes entries written by live parallel sessions (parallel workspace isolation)', async () => {
    appendMemoryEntry(cwd, {
      text: 'In-flight conclusion from session A about pagination bounds',
      kind: 'finding', confidence: 0.9, source: 'auto-capture', status: 'observed', tags: [],
      sessionId: 'session-a', topic: 'pagination',
    })
    appendMemoryEntry(cwd, {
      text: 'Stable cross-session rule about pagination bounds',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [],
      sessionId: 'session-idle', topic: 'pagination',
    })

    const idx = new KnowledgeIndex(cwd)
    const hits = await idx.search('pagination bounds', { excludeSessionIds: ['session-a'] })
    assert.ok(hits.length >= 1)
    assert.ok(hits.every(h => h.entry?.sessionId !== 'session-a'), '在线会话条目不得进入召回')
  })
})
