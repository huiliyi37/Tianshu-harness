/**
 * Essence-gate 契约测试（Wave 2 知识重构）。
 *
 * 核心契约：
 * - fail-closed：LLM 不可用/输出不可解析 → 什么都不写
 * - 结构性硬闸：admit 无 transferableTo 不入库（LLM 说了不算）
 * - salvage：失败素材无淘汰原因不入库
 * - 互斥：同 topic 矛盾规则经 supersede 封口，不并存（jest vs node:test 场景）
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runEssenceGate, parseGateVerdicts, type KnowledgeCandidate } from '../essence-gate.js'
import { runGateCompletion } from '../../agent/gate-completion.js'
import { appendMemoryEntry, readMemoryEntries, recallMemoryEntries, isCurrentEntry } from '../unified-memory.js'

function candidate(text: string, overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return { text, kind: 'fact', confidence: 0.8, origin: 'observation', ...overrides }
}

describe('essence-gate', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-gate-'))
  })

  after(() => {
    // best-effort cleanup of the last dir; earlier dirs cleaned by tmp reaper
    try { rmSync(cwd, { recursive: true, force: true }) } catch {}
  })

  it('fail-closed: LLM error writes nothing', async () => {
    const result = await runEssenceGate(
      { cwd, complete: async () => { throw new Error('llm down') } },
      [candidate('This project uses immutable spread patterns everywhere in reducers')],
    )
    assert.equal(result.failedClosed, true)
    assert.equal(result.admitted.length, 0)
    assert.equal(existsSync(join(cwd, '.rivet', 'knowledge', 'memory.jsonl')), false, 'no file may be created')
  })

  it('fail-closed: timeout 归因 failureReason=timeout 且有界返回', async () => {
    // 完整链路：runGateCompletion（race 保底，忽略 abort 的 stream）作为 complete
    // 实现——旧实现（timer 只 abort 不 reject）会让这个测试挂到外层 hook 预算。
    const neverClient = {
      stream: async () => new Promise<void>(() => {}),
    }
    const start = Date.now()
    const result = await runEssenceGate(
      {
        cwd,
        timeoutMs: 30,
        complete: (prompt, timeoutMs) => runGateCompletion(neverClient, () => {}, prompt, timeoutMs),
      },
      [candidate('This project uses immutable spread patterns everywhere in reducers')],
    )
    const elapsed = Date.now() - start

    assert.equal(result.failedClosed, true)
    assert.equal(result.failureReason, 'timeout', '超时必须显式归因为 timeout，而非笼统 llm_error')
    assert.equal(result.admitted.length, 0)
    assert.ok(elapsed < 1000, `内层超时必须先于外层预算 fail-closed，实际 ${elapsed}ms`)
    assert.ok(result.durationMs !== undefined && result.durationMs >= 30, '结果应携带耗时')
  })

  it('fail-closed: LLM error → failureReason=llm_error', async () => {
    const result = await runEssenceGate(
      { cwd, complete: async () => { throw new Error('llm down') } },
      [candidate('This project uses immutable spread patterns everywhere in reducers')],
    )
    assert.equal(result.failedClosed, true)
    assert.equal(result.failureReason, 'llm_error')
  })

  it('fail-closed: unparseable output → failureReason=invalid_output', async () => {
    const result = await runEssenceGate(
      { cwd, complete: async () => 'sorry I cannot help with that' },
      [candidate('Prefer connection pooling for database access in this repository')],
    )
    assert.equal(result.failedClosed, true)
    assert.equal(result.failureReason, 'invalid_output')
  })

  it('fail-closed: unparseable LLM output writes nothing', async () => {
    const result = await runEssenceGate(
      { cwd, complete: async () => 'sorry I cannot help with that' },
      [candidate('Prefer connection pooling for database access in this repository')],
    )
    assert.equal(result.failedClosed, true)
    assert.equal(result.admitted.length, 0)
  })

  it('structural gate: admit without transferableTo is downgraded to reject', async () => {
    const result = await runEssenceGate(
      {
        cwd,
        complete: async () => JSON.stringify([
          { index: 0, action: 'admit', refinedText: 'A principle without transfer scope that is long enough' },
        ]),
      },
      [candidate('Some observation text that is long enough to pass length checks')],
    )
    assert.equal(result.failedClosed, false)
    assert.equal(result.admitted.length, 0)
    assert.equal(result.rejected, 1)
  })

  it('admits refined principles with transferableTo and topic', async () => {
    const result = await runEssenceGate(
      {
        cwd,
        sessionId: 'sess-1',
        complete: async () => JSON.stringify([
          {
            index: 0,
            action: 'admit',
            refinedText: 'Request objects are re-entered by multiple stream() calls; client transform layers must be copy-on-write',
            transferableTo: ['api clients', 'stream middleware'],
            topic: 'api-client',
          },
        ]),
      },
      [candidate('client mutation bug happened in openai-client stream re-entry')],
    )
    assert.equal(result.admitted.length, 1)
    const entry = result.admitted[0]!
    assert.equal(entry.source, 'essence-gate')
    assert.deepEqual(entry.transferableTo, ['api clients', 'stream middleware'])
    assert.equal(entry.topic, 'api-client')
    assert.ok(entry.text.includes('copy-on-write'))

    const persisted = readMemoryEntries(cwd)
    assert.equal(persisted.length, 1)
  })

  it('salvage: failure material without reason is rejected', async () => {
    const result = await runEssenceGate(
      {
        cwd,
        complete: async () => JSON.stringify([
          {
            index: 0,
            action: 'admit',
            refinedText: 'Retry loops must check idempotency before re-execution of the failed op',
            transferableTo: ['tool execution'],
            topic: 'retry',
            // no reason → salvage incomplete
          },
        ]),
      },
      [candidate('failed 3 times retrying the same broken approach', { origin: 'failure', kind: 'failure_pattern' })],
    )
    assert.equal(result.admitted.length, 0)
    assert.equal(result.rejected, 1)
  })

  it('mutual exclusion: contradicting rule supersedes the old one (jest vs node:test)', async () => {
    const old = appendMemoryEntry(cwd, {
      text: 'Project uses jest for testing',
      kind: 'project_rule', confidence: 0.9, source: 'manual', status: 'verified', tags: [], topic: 'testing',
    })!

    const result = await runEssenceGate(
      {
        cwd,
        complete: async () => JSON.stringify([
          {
            index: 0,
            action: 'supersede',
            supersedesId: old.id,
            refinedText: 'Project uses node:test with node:assert/strict; jest is not used',
            transferableTo: ['test files', 'ci config'],
            topic: 'testing',
            reason: 'contradicts existing entry',
          },
        ]),
      },
      [candidate('we actually use node:test not jest for all testing in this repo')],
    )

    assert.equal(result.admitted.length, 1)
    assert.equal(result.superseded, 1)

    const all = readMemoryEntries(cwd)
    const sealed = all.find(e => e.id === old.id)
    assert.equal(isCurrentEntry(sealed!), false, 'old rule must be sealed')
    assert.equal(sealed!.supersededBy, result.admitted[0]!.id)

    // 矛盾规则不得并存于召回结果
    const recalled = recallMemoryEntries(cwd, 'testing framework jest node', 10)
    assert.ok(!recalled.some(e => e.id === old.id), 'sealed contradictory rule must not surface')
    assert.ok(recalled.some(e => e.id === result.admitted[0]!.id))
  })

  it('unjudged candidates count as rejected (宁缺毋滥)', async () => {
    const result = await runEssenceGate(
      { cwd, complete: async () => JSON.stringify([{ index: 0, action: 'reject' }]) },
      [
        candidate('First observation with sufficient length for gate review'),
        candidate('Second observation with sufficient length for gate review too'),
      ],
    )
    assert.equal(result.admitted.length, 0)
    assert.equal(result.rejected, 2)
  })

  it('parseGateVerdicts tolerates markdown fences and drops out-of-range indices', () => {
    const raw = '```json\n[{"index":0,"action":"reject"},{"index":5,"action":"admit"},{"index":"x","action":"admit"}]\n```'
    const verdicts = parseGateVerdicts(raw, 2)
    assert.equal(verdicts!.length, 1)
    assert.equal(verdicts![0]!.index, 0)
  })

  // ── Wave 5: result refs fields ──

  it('returns admittedRefs with id and textHash on admit', async () => {
    const result = await runEssenceGate(
      {
        cwd,
        complete: async () => JSON.stringify([
          { index: 0, action: 'admit', refinedText: 'Immutable spread patterns are the default in reducers', transferableTo: ['reducers'], topic: 'patterns' },
        ]),
      },
      [candidate('This project uses immutable spread patterns everywhere in reducers')],
    )
    assert.equal(result.failedClosed, false)
    assert.equal(result.admitted.length, 1)
    assert.equal(result.admittedRefs.length, 1)
    assert.ok(result.admittedRefs[0]!.id)
    assert.ok(result.admittedRefs[0]!.textHash)
    assert.equal(result.rejectedRefs.length, 0)
  })

  it('returns rejectedRefs with textHash and snippet on reject', async () => {
    const result = await runEssenceGate(
      {
        cwd,
        complete: async () => JSON.stringify([
          { index: 0, action: 'reject', reason: 'event-like description of file edits' },
        ]),
      },
      [candidate('Last time I edited src/main.ts and changed the entry point in a session')],
    )
    assert.equal(result.admitted.length, 0)
    assert.equal(result.rejected, 1)
    assert.equal(result.rejectedRefs.length, 1)
    assert.ok(result.rejectedRefs[0]!.textHash)
    assert.ok(result.rejectedRefs[0]!.snippet.length <= 80)
  })

  it('returns supersededRefs on successful supersede', async () => {
    // Seed an existing entry to supersede
    const old = appendMemoryEntry(cwd, {
      text: 'Old rule: use jest for testing',
      kind: 'project_rule', confidence: 0.9, source: 'manual', status: 'verified', tags: [],
    })!
    const result = await runEssenceGate(
      {
        cwd,
        complete: async () => JSON.stringify([
          { index: 0, action: 'supersede', refinedText: 'Use node:test for testing', transferableTo: ['testing'], topic: 'testing', supersedesId: old.id },
        ]),
      },
      [candidate('This project uses node:test for testing')],
    )
    assert.equal(result.superseded, 1)
    assert.equal(result.supersededRefs.length, 1)
    assert.equal(result.supersededRefs[0]!.oldId, old.id)
    assert.ok(result.supersededRefs[0]!.newId)
  })
})
