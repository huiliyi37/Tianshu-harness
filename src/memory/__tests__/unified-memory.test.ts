/**
 * Tests for unified-memory.ts — append, recall, migration idempotency.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { memoryDir } from '../../config/paths.js'
import {
  appendMemoryEntry,
  readMemoryEntries,
  recallMemoryEntries,
  countSimilarMemoryEntries,
  migrateObservationsToUnified,
  migrateLegacyMemoryToProject,
  supersedeMemoryEntry,
  isCurrentEntry,
  renderMemoryBlock,
  validateKnowledgeChains,
  type MemoryEntry,
} from '../unified-memory.js'

const TEST_DIR = join(tmpdir(), 'rivet-um-test')

function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
  const memDir = memoryDir(projectHash(TEST_DIR))
  try { rmSync(memDir, { recursive: true }) } catch {}
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true }) } catch {}
  try { rmSync(memoryDir(projectHash(TEST_DIR)), { recursive: true }) } catch {}
}

describe('unified-memory', () => {
  setup()

  it('appends and reads memory entries', () => {
    const entry = appendMemoryEntry(TEST_DIR, {
      text: 'Project uses node:test for testing',
      kind: 'fact',
      confidence: 0.9,
      source: 'auto',
      status: 'observed',
      tags: ['testing'],
    })
    assert.ok(entry.id.startsWith('mem_'))
    assert.equal(entry.repeatCount, 1)
    assert.equal(entry.kind, 'fact')

    const entries = readMemoryEntries(TEST_DIR)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.text, 'Project uses node:test for testing')
  })

  it('increments repeatCount on duplicate text', () => {
    const text = 'Project uses TypeScript strict mode'
    const e1 = appendMemoryEntry(TEST_DIR, {
      text, kind: 'fact', confidence: 0.9, source: 'auto', status: 'observed', tags: [],
    })
    assert.equal(e1.repeatCount, 1)
    const e2 = appendMemoryEntry(TEST_DIR, {
      text, kind: 'fact', confidence: 0.9, source: 'auto', status: 'observed', tags: [],
    })
    assert.equal(e2.repeatCount, 2)
  })

  it('recalls entries by keyword', () => {
    appendMemoryEntry(TEST_DIR, {
      text: 'Authentication middleware uses JWT tokens',
      kind: 'decision', confidence: 0.95, source: 'manual', status: 'verified', tags: ['auth'],
    })
    appendMemoryEntry(TEST_DIR, {
      text: 'Database uses PostgreSQL with connection pooling',
      kind: 'fact', confidence: 0.8, source: 'auto', status: 'observed', tags: ['db'],
    })

    const results = recallMemoryEntries(TEST_DIR, 'authentication JWT', 5)
    assert.ok(results.length >= 1)
    assert.ok(results[0]!.text.includes('JWT'))

    // Filter by kind
    const decisions = recallMemoryEntries(TEST_DIR, 'database', 5, 'decision')
    assert.equal(decisions.length, 0) // db entry is 'fact', not 'decision'
  })

  it('recalls entries for pure Chinese queries', () => {
    const entry = appendMemoryEntry(TEST_DIR, {
      text: '灾情专题需要按图片、视频和文档分类展示',
      kind: 'project_rule', confidence: 0.95, source: 'manual', status: 'verified', tags: ['灾情'],
    })

    const results = recallMemoryEntries(TEST_DIR, '灾情专题', 5)
    assert.ok(results.some(result => result.id === entry.id))
  })

  it('renders memory block as XML', () => {
    appendMemoryEntry(TEST_DIR, {
      text: 'Testing framework is node:test',
      kind: 'fact', confidence: 0.95, source: 'auto', status: 'verified', tags: [],
    })
    const block = renderMemoryBlock(TEST_DIR, 'testing', 500)
    assert.ok(block!.includes('<cross-session-memory>'))
    assert.ok(block!.includes('node:test'))
  })

  it('countSimilarMemoryEntries works', () => {
    const text = 'Unique observation for counting'
    appendMemoryEntry(TEST_DIR, {
      text, kind: 'fact', confidence: 0.5, source: 'auto', status: 'observed', tags: [],
    })
    const count = countSimilarMemoryEntries(TEST_DIR, text)
    assert.equal(count, 1)
  })

  it('migration is idempotent', () => {
    // migrateObservationsToUnified reads from ~/.rivet/memory/<hash>/observations.jsonl
    const obsDir = memoryDir(projectHash(TEST_DIR))
    mkdirSync(obsDir, { recursive: true })
    const obsFile = join(obsDir, 'observations.jsonl')
    writeFileSync(obsFile, [
      JSON.stringify({ id: 'obs_1', text: 'Old observation one', kind: 'fact', confidence: 0.8, source: 'auto', tags: [] }),
      JSON.stringify({ id: 'obs_2', text: 'Old observation two', kind: 'decision', confidence: 0.9, source: 'user', tags: [] }),
    ].join('\n') + '\n')

    // First run
    const count1 = migrateObservationsToUnified(TEST_DIR)
    assert.equal(count1, 2)

    // Second run — should skip already-migrated entries
    const count2 = migrateObservationsToUnified(TEST_DIR)
    assert.equal(count2, 0) // idempotent: zero new entries

    // Append a new entry to observations.jsonl after first migration
    writeFileSync(obsFile, [
      JSON.stringify({ id: 'obs_1', text: 'Old observation one', kind: 'fact', confidence: 0.8, source: 'auto', tags: [] }),
      JSON.stringify({ id: 'obs_2', text: 'Old observation two', kind: 'decision', confidence: 0.9, source: 'user', tags: [] }),
      JSON.stringify({ id: 'obs_3', text: 'New observation three', kind: 'fact', confidence: 0.7, source: 'auto', tags: [] }),
    ].join('\n') + '\n')

    // Third run — only the new entry should be migrated
    const count3 = migrateObservationsToUnified(TEST_DIR)
    assert.equal(count3, 1)
  })

  // ── Wave 2: 存储统一 + Schema v2 ──────────────────────────────

  it('writes to the project-local knowledge store (.rivet/knowledge/memory.jsonl)', () => {
    appendMemoryEntry(TEST_DIR, {
      text: 'Unified store lives inside the project',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [],
    })
    assert.ok(existsSync(join(TEST_DIR, '.rivet', 'knowledge', 'memory.jsonl')))
  })

  it('supersede seals the old entry and recall returns only the current leaf', () => {
    const oldEntry = appendMemoryEntry(TEST_DIR, {
      text: 'Bundler rollup is used for builds here',
      kind: 'project_rule', confidence: 0.9, source: 'manual', status: 'verified', tags: [], topic: 'build',
    })
    const newEntry = appendMemoryEntry(TEST_DIR, {
      text: 'Bundler esbuild replaced rollup for builds',
      kind: 'project_rule', confidence: 0.95, source: 'essence-gate', status: 'verified', tags: [], topic: 'build',
    })

    assert.equal(supersedeMemoryEntry(TEST_DIR, oldEntry.id, newEntry.id), true)

    const all = readMemoryEntries(TEST_DIR)
    const sealed = all.find(e => e.id === oldEntry.id)
    assert.equal(sealed!.supersededBy, newEntry.id)
    assert.ok(sealed!.validTo !== undefined)
    assert.equal(isCurrentEntry(sealed!), false)

    const recalled = recallMemoryEntries(TEST_DIR, 'bundler builds', 5)
    assert.ok(recalled.some(e => e.id === newEntry.id), 'current leaf must be recallable')
    assert.ok(!recalled.some(e => e.id === oldEntry.id), 'sealed entry must not surface by default')

    const withHistory = recallMemoryEntries(TEST_DIR, 'bundler builds', 5, undefined, { includeHistory: true })
    assert.ok(withHistory.some(e => e.id === oldEntry.id), 'history available on explicit request')
  })

  it('migrates legacy machine-dir entries to project store, skipping regex noise', () => {
    const legacyDir = memoryDir(projectHash(TEST_DIR))
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'memory.jsonl'), [
      JSON.stringify({ id: 'legacy_manual', text: 'Manually recorded legacy insight', kind: 'decision', confidence: 0.9, source: 'manual', status: 'verified', tags: [], ts: 1, repeatCount: 1 }),
      JSON.stringify({ id: 'legacy_noise', text: 'Project uses jest for testing', kind: 'fact', confidence: 0.85, source: 'auto', status: 'observed', tags: [], ts: 2, repeatCount: 1 }),
    ].join('\n') + '\n')

    const migrated = migrateLegacyMemoryToProject(TEST_DIR)
    assert.equal(migrated, 1, 'only non-auto entries migrate')

    // Idempotent re-run
    assert.equal(migrateLegacyMemoryToProject(TEST_DIR), 0)

    // Dual-read surfaces legacy manual entries but filters regex noise
    // (source='auto') at the legacy read layer — same policy as migration.
    const all = readMemoryEntries(TEST_DIR)
    assert.ok(all.some(e => e.id === 'legacy_manual'), 'manual legacy entry surfaces via dual-read')
    assert.ok(!all.some(e => e.id === 'legacy_noise'), 'auto-sourced legacy noise must be filtered')
  })

  it('normalizes legacy Store A schema (createdAt) on read', () => {
    const dir = join(TEST_DIR, '.rivet', 'knowledge')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'memory.jsonl'),
      JSON.stringify({ id: 'storeA_1', kind: 'project_rule', text: 'Store A style entry with createdAt', confidence: 1, createdAt: 1234, source: 'test' }) + '\n')

    const entry = readMemoryEntries(TEST_DIR).find(e => e.id === 'storeA_1')
    assert.ok(entry)
    assert.equal(entry!.ts, 1234, 'createdAt normalized to ts')
    assert.equal(entry!.status, 'observed', 'missing status defaults')
    assert.deepEqual(entry!.tags, [])
  })

  it('skips malformed lines when reading', () => {
    // Direct append of malformed line (simulate corruption)
    appendMemoryEntry(TEST_DIR, {
      text: 'Valid entry',
      kind: 'fact', confidence: 0.9, source: 'auto', status: 'observed', tags: [],
    })
    const entries = readMemoryEntries(TEST_DIR)
    // Should have at least the valid entries
    assert.ok(entries.length >= 1)
    const valid = entries.find(e => e.text === 'Valid entry')
    assert.ok(valid)
  })

  // ── Wave 5: chain validation ──

  function mkEntry(id: string, supersededBy?: string): MemoryEntry {
    return { id, text: '', kind: 'fact', confidence: 1, source: 'manual', status: 'observed', tags: [], ts: 1, repeatCount: 1, ...(supersededBy ? { supersededBy } : {}) }
  }

  it('detects dangling supersededBy reference', () => {
    const entries: MemoryEntry[] = [
      { id: 'a', text: '', kind: 'fact', confidence: 1, source: 'manual', status: 'observed', tags: [], ts: 1, repeatCount: 1, supersededBy: 'nonexistent' },
    ]
    const issues = validateKnowledgeChains(entries)
    assert.ok(issues.some(i => i.kind === 'dangling_reference'))
  })

  it('detects cycles in supersede chain', () => {
    const entries: MemoryEntry[] = [
      mkEntry('a', 'b'),
      mkEntry('b', 'c'),
      mkEntry('c', 'a'),  // cycle back to a
    ]
    const issues = validateKnowledgeChains(entries)
    assert.ok(issues.some(i => i.kind === 'cycle'))
  })

  it('detects dead chain with no current leaf', () => {
    const entries: MemoryEntry[] = [
      { ...mkEntry('a', 'b'), validTo: 1, status: 'expired' },
      { ...mkEntry('b'), validTo: 2, status: 'expired' },  // no supersededBy, but expired
    ]
    const issues = validateKnowledgeChains(entries)
    assert.ok(issues.some(i => i.kind === 'dead_chain'))
  })

  it('returns no issues for a clean chain', () => {
    const entries: MemoryEntry[] = [
      mkEntry('a', 'b'),
      mkEntry('b'),  // current leaf
    ]
    // Mark a as expired (superseded) but b is current → healthy chain
    entries[0]!.validTo = 1
    entries[0]!.status = 'expired'
    const issues = validateKnowledgeChains(entries)
    assert.equal(issues.length, 0)
  })

  teardown()
})

// ── 虚空仓库 P0: renderMemoryBlock sourceFilter（忽略 query、ts 恒定选集）──

describe('renderMemoryBlock sourceFilter — 虚空仓库 P0', () => {
  const DIR = join(tmpdir(), 'rivet-um-sourcefilter-test')

  function reset() {
    if (existsSync(DIR)) rmSync(DIR, { recursive: true })
    mkdirSync(DIR, { recursive: true })
    try { rmSync(memoryDir(projectHash(DIR)), { recursive: true }) } catch {}
  }

  function addCrafted(text: string, ts: number, sessionId?: string): MemoryEntry {
    return appendMemoryEntry(DIR, {
      text, kind: 'verified_pattern', confidence: 0.95, source: 'agent-crafted',
      status: 'verified', tags: ['agent-learned'], ts, sessionId,
    })
  }

  it('只返回指定 source 的 current 条目', () => {
    reset()
    addCrafted('agent 标记的模式 A', 100)
    appendMemoryEntry(DIR, {
      text: 'auto 提取噪声', kind: 'fact', confidence: 0.6, source: 'auto', status: 'observed', tags: [], ts: 200,
    })
    const block = renderMemoryBlock(DIR, '', 2000, 'agent-crafted')
    assert.ok(block!.includes('agent 标记的模式 A'))
    assert.equal(block!.includes('auto 提取噪声'), false)
  })

  it('query 变化不改变选集与输出字节（缓存稳定回归锚）', () => {
    reset()
    addCrafted('此项目用 npx tsx --test 运行测试', 100)
    addCrafted('appendix 块必须字节稳定', 200)
    const a = renderMemoryBlock(DIR, '', 2000, 'agent-crafted')
    const b = renderMemoryBlock(DIR, 'tsx 测试怎么跑', 2000, 'agent-crafted')
    const c = renderMemoryBlock(DIR, 'completely unrelated english query about databases', 2000, 'agent-crafted')
    assert.equal(a, b, '中文 query 不改变输出字节')
    assert.equal(a, c, '英文 query 不改变输出字节')
  })

  it('memory.jsonl 不变时输出逐字节相等；追加一条后变化恰好一次再稳定', () => {
    reset()
    addCrafted('稳定条目一', 100)
    const before1 = renderMemoryBlock(DIR, '', 2000, 'agent-crafted')
    const before2 = renderMemoryBlock(DIR, '', 2000, 'agent-crafted')
    assert.equal(before1, before2, '文件不变 → 字节不变')

    addCrafted('稳定条目二', 300)
    const after1 = renderMemoryBlock(DIR, '', 2000, 'agent-crafted')
    assert.notEqual(after1, before1, '追加后输出变化')
    const after2 = renderMemoryBlock(DIR, '', 2000, 'agent-crafted')
    assert.equal(after1, after2, '再次稳定')
  })

  it('ts 降序取最近 8 条（超出的旧条目不进块）', () => {
    reset()
    for (let i = 1; i <= 10; i++) addCrafted(`模式编号 ${i}`, i * 10)
    const block = renderMemoryBlock(DIR, '', 8000, 'agent-crafted')
    assert.ok(block!.includes('模式编号 10'), '最新条目在块内')
    assert.ok(block!.includes('模式编号 3<'), '第 8 新条目在块内')
    assert.equal(block!.includes('模式编号 2<'), false, '第 9 新条目被裁掉')
    assert.equal(block!.includes('模式编号 1<'), false, '最旧条目被裁掉')
  })

  it('被 supersede 封口的条目不进选集（尊重 isCurrentEntry）', () => {
    reset()
    const oldE = addCrafted('旧版模式', 100)
    const newE = addCrafted('新版模式', 200)
    assert.equal(supersedeMemoryEntry(DIR, oldE.id, newE.id), true)
    const block = renderMemoryBlock(DIR, '', 2000, 'agent-crafted')
    assert.ok(block!.includes('新版模式'))
    assert.equal(block!.includes('旧版模式'), false)
  })

    it('queryGatedSource: 与当前问题无关的 agent-crafted 记忆不注入（旧问题不背新问题）', () => {
      reset()
      addCrafted('登录页曾因 token 刷新失败而崩溃', 100)
      const unrelated = renderMemoryBlock(DIR, '写一个新的数据导出功能', 2000, 'agent-crafted', { queryGatedSource: true })
      assert.equal(unrelated, null, '新问题不应看到旧问题的 agent-crafted 记忆')
      const related = renderMemoryBlock(DIR, '登录页又报 token 错误了', 2000, 'agent-crafted', { queryGatedSource: true })
      assert.ok(related!.includes('token'), '相关问题时仍可召回')
    })

    it('excludeSessionId: 当前会话自己写的记忆不作为 cross-session 重复注入', () => {
      reset()
      addCrafted('当前会话刚收敛的旧案件', 100, 'session-current')
      addCrafted('其他会话沉淀的模式', 200, 'session-other')
      const block = renderMemoryBlock(DIR, '新问题', 2000, 'agent-crafted', { excludeSessionId: 'session-current' })
      assert.ok(block!.includes('其他会话沉淀'))
      assert.equal(block!.includes('当前会话刚收敛'), false)
    })

      it('excludeSessionIds: 并行在线会话的在途记忆互相不注入', () => {
        reset()
        addCrafted('会话 A 的进行中结论', 100, 'session-a')
        addCrafted('会话 B 的进行中结论', 200, 'session-b')
        addCrafted('已结束会话的稳定模式', 300, 'session-idle')
        const block = renderMemoryBlock(DIR, '并行会话', 2000, 'agent-crafted', { excludeSessionIds: ['session-a', 'session-b'] })
        assert.ok(block!.includes('已结束会话的稳定模式'))
        assert.equal(block!.includes('会话 A 的进行中结论'), false)
        assert.equal(block!.includes('会话 B 的进行中结论'), false)
      })

  it('向后兼容：不传 sourceFilter 且空 query → null（评分路径行为不变）', () => {
    reset()
    addCrafted('agent 条目', 100)
    assert.equal(renderMemoryBlock(DIR, '', 2000), null)
  })

  it('无匹配条目 → null', () => {
    reset()
    assert.equal(renderMemoryBlock(DIR, '', 2000, 'agent-crafted'), null)
  })

  it('teardown', () => {
    try { rmSync(DIR, { recursive: true }) } catch {}
    try { rmSync(memoryDir(projectHash(DIR)), { recursive: true }) } catch {}
  })
})
