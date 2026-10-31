import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendProjectMemory, compactProjectMemory, readCommitFacts } from '../project-memory-writer.js'

function claim(id: string, confidence: number, createdAt: number, text = `Claim ${id}`) {
  return {
    id,
    kind: 'decision',
    text,
    confidence,
    createdAt,
    evidence: [{ summary: `source ${id}` }],
  }
}

function memoryPath(cwd: string): string {
  return join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
}

function readEntries(cwd: string): Array<Record<string, unknown>> {
  return readFileSync(memoryPath(cwd), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

describe('project-memory-writer', () => {
  it('appends project memory entries to .rivet/knowledge/memory.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, claim('decision-1', 0.95, 1, 'Use guided retrieval.'))

      assert.ok(existsSync(memoryPath(dir)))
      const entries = readEntries(dir)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.id, 'decision-1')
      assert.equal(entries[0]!.text, 'Use guided retrieval.')
      assert.equal(entries[0]!.source, 'source decision-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes commit facts to the sidecar, keeping the 200-entry main quota clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    const prevTrust = process.env.RIVET_TRUST_PROJECT
    process.env.RIVET_TRUST_PROJECT = '1' // readCommitFacts 带信任门，fixture 显式授信
    try {
      appendProjectMemory(dir, {
        id: 'commit-1',
        kind: 'decision',
        text: 'Commit abc1234: "fix typo" (src/a.ts)',
        confidence: 0.95,
        createdAt: 1,
        tags: ['tool', 'commit_fact'],
      })

      // Wave 1（知识重构）：commit_fact confidence=0.95 曾在主存储 compact 时
      // 挤掉 0.7 的 dream 蒸馏产物——分流侧车后不再竞争主配额。
      assert.equal(existsSync(memoryPath(dir)), false, 'commit facts must not enter memory.jsonl')
      const sidecar = readCommitFacts(dir)
      assert.equal(sidecar.length, 1)
      assert.equal(sidecar[0]!.id, 'commit-1')
      assert.deepEqual(sidecar[0]!.tags, ['tool', 'commit_fact'])
    } finally {
      if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
      else process.env.RIVET_TRUST_PROJECT = prevTrust
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('commit-fact sidecar enforces FIFO cap independent of main store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    const prevTrust = process.env.RIVET_TRUST_PROJECT
    process.env.RIVET_TRUST_PROJECT = '1' // readCommitFacts 带信任门，fixture 显式授信
    try {
      for (let i = 0; i < 305; i++) {
        appendProjectMemory(dir, {
          id: `commit-${i}`,
          kind: 'decision',
          text: `Commit fact number ${i}`,
          confidence: 0.95,
          createdAt: i,
          tags: ['commit_fact'],
        })
      }
      const sidecar = readCommitFacts(dir)
      assert.equal(sidecar.length, 300)
      assert.equal(sidecar[0]!.id, 'commit-5', 'oldest entries evicted FIFO')
      assert.equal(sidecar[299]!.id, 'commit-304')
    } finally {
      if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
      else process.env.RIVET_TRUST_PROJECT = prevTrust
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses unknown source when claim has no evidence summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, { id: 'decision-1', kind: 'decision', text: 'No source.', confidence: 0.9, createdAt: 1 })

      const entries = readEntries(dir)
      assert.equal(entries[0]!.source, 'unknown')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns zero when compacting an absent memory file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      assert.equal(compactProjectMemory(dir), 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates entries by id and keeps the latest duplicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, claim('same-id', 0.6, 1, 'Old text.'))
      appendProjectMemory(dir, claim('same-id', 0.95, 2, 'New text.'))

      const removed = compactProjectMemory(dir)
      const entries = readEntries(dir)

      assert.equal(removed, 1)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.text, 'New text.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('trims to the top 200 entries by confidence then recency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      for (let i = 0; i < 205; i++) {
        appendProjectMemory(dir, claim(`claim-${i}`, i === 0 ? 0.1 : 0.9, i))
      }

      const removed = compactProjectMemory(dir)
      const entries = readEntries(dir)

      assert.equal(removed, 5)
      assert.equal(entries.length, 200)
      assert.ok(!entries.some(e => e.id === 'claim-0'))
      assert.equal(entries[0]!.id, 'claim-204')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compacts oversized files even when entry count is below limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    const path = memoryPath(dir)
    try {
      mkdirSync(join(dir, '.rivet', 'knowledge'), { recursive: true })
      const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({
        id: `claim-${i}`,
        kind: 'decision',
        text: 'x'.repeat(1000),
        confidence: 0.9,
        createdAt: i,
        source: 'test',
      }))
      writeFileSync(path, lines.join('\n') + '\n', 'utf-8')

      const before = readFileSync(path, 'utf-8').length
      const removed = compactProjectMemory(dir)
      const after = readFileSync(path, 'utf-8').length

      assert.ok(before > 16_384)
      assert.equal(removed, 0)
      assert.ok(after <= before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 软链写入逃逸回归（2026-10-31 审计 Finding 3）：原子写走「tmp 文件 + rename」，
// 目标目录为软链时 rename 会把内容落到项目外——项目记忆写入变成任意路径写入。
describe('project-memory-writer symlink containment', () => {
  function outsideDir(): { outside: string; cleanup: () => void } {
    const outside = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-outside-'))
    return { outside, cleanup: () => rmSync(outside, { recursive: true, force: true }) }
  }

  it('refuses to write when .rivet/knowledge is a symlink to an outside directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    const outside = outsideDir()
    try {
      mkdirSync(join(dir, '.rivet'), { recursive: true })
      symlinkSync(outside.outside, join(dir, '.rivet', 'knowledge'))

      appendProjectMemory(dir, claim('leak-1', 0.95, 1, 'MUST_NOT_ESCAPE'))

      assert.equal(existsSync(join(outside.outside, 'memory.jsonl')), false, 'no file may be created outside the project')
      assert.deepEqual(readdirOf(outside.outside), [], 'no temp or lock files may leak outside the project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      outside.cleanup()
    }
  })

  it('refuses to write through a memory.jsonl that is a symlink to an outside file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    const outside = outsideDir()
    try {
      const target = join(outside.outside, 'victim.jsonl')
      writeFileSync(target, 'ORIGINAL_OUTSIDE_CONTENT\n', 'utf-8')
      mkdirSync(join(dir, '.rivet', 'knowledge'), { recursive: true })
      symlinkSync(target, memoryPath(dir))

      appendProjectMemory(dir, claim('leak-2', 0.95, 1, 'MUST_NOT_ESCAPE'))

      assert.equal(readFileSync(target, 'utf-8'), 'ORIGINAL_OUTSIDE_CONTENT\n', 'outside file content must be untouched')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      outside.cleanup()
    }
  })

  it('still writes normally when the target directory is a real in-project directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, claim('ok-1', 0.95, 1, 'NORMAL_WRITE_KEPT'))

      const entries = readEntries(dir)
      assert.equal(entries.length, 1, 'containment check must not break the normal write path')
      assert.equal(entries[0]!.text, 'NORMAL_WRITE_KEPT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function readdirOf(path: string): string[] {
  return readdirSync(path)
}
