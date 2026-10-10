/**
 * Worker session persistence tests — save/load round-trip for resume support.
 * Covers the runtime-validated v2 format (atomic writes, optional checkpoint,
 * size-overflow history omission) plus v1 legacy reads and checkpoint consume-once.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveWorkerSession,
  loadWorkerSession,
  consumeCheckpointOnce,
  workerSessionPath,
  SESSION_HISTORY_SIZE_LIMIT,
} from '../worker-session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { WorkerCheckpoint } from '../worker-session.js'
import { proveWirePrefix } from '../../api/continuation-prefix.js'
import type { FrozenSnapshotData } from '../../prompt/frozen-snapshot.js'
import { leaseWorkerResume } from '../worker-resume-lease.js'
import { isFilesystemMetadata } from '../../utils/file-metadata.js'

describe('worker-session-persist', () => {
  function makeMessages(): OaiMessage[] {
    return [
      { role: 'system', content: 'You are a worker.' },
      { role: 'user', content: 'Find the auth flow.' },
      { role: 'assistant', content: 'I found it.', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"auth"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'auth.ts:1:export function authenticate' },
      { role: 'assistant', content: '{"workOrderId":"wo_test","status":"passed","summary":"found auth flow"}' },
    ]
  }

  function makeCheckpoint(): WorkerCheckpoint {
    return { turnIndex: 3, partialResult: 'auth flow located', completedTools: ['grep:auth'] }
  }

  it('save → load round-trips messages', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const id = 'wo_roundtrip'
    const msgs = makeMessages()
    saveWorkerSession(id, 'code_scout', 'Find the auth flow.', msgs, home)

    const loaded = loadWorkerSession(id, home)
    assert.ok(loaded, 'should load the saved record')
    assert.equal(loaded!.workOrderId, id)
    assert.equal(loaded!.profile, 'code_scout')
    assert.equal(loaded!.objective, 'Find the auth flow.')
    assert.equal(loaded!.messages.length, 5)
    assert.equal(loaded!.messages[0]!.role, 'system')
    assert.equal(loaded!.messages[1]!.role, 'user')
    assert.equal(loaded!.messages[2]!.role, 'assistant')
    assert.ok(loaded!.savedAt > 0)
  })

  it('returns null when the file does not exist (cold miss, no throw)', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const loaded = loadWorkerSession('nonexistent', home)
    assert.equal(loaded, null)
  })

  it('returns null for corrupt JSON (no throw)', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wo_bad.session.jsonl'), 'not json at all', 'utf-8')
    const loaded = loadWorkerSession('wo_bad', home)
    assert.equal(loaded, null)
  })

  it('returns null for an empty file', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wo_empty.session.jsonl'), '   \n  ', 'utf-8')
    const loaded = loadWorkerSession('wo_empty', home)
    assert.equal(loaded, null)
  })

  it('can save and load an empty messages array', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    saveWorkerSession('wo_empty_msgs', 'code_scout', 'test', [], home)
    const loaded = loadWorkerSession('wo_empty_msgs', home)
    assert.ok(loaded)
    assert.deepEqual(loaded!.messages, [])
  })

  it('creates the subagents directory if it does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    // Verify the directory doesn't exist yet
    assert.equal(existsSync(join(home, '.rivet', 'subagents')), false)
    saveWorkerSession('wo_mkdir', 'code_scout', 'test', makeMessages(), home)
    assert.ok(existsSync(workerSessionPath('wo_mkdir', home)))
  })

  it('workerSessionPath returns the expected location', () => {
    const path = workerSessionPath('wo_abc', '/fake/home')
    // 期望值用 join 构造（平台无关）——Windows 上 join 产出反斜杠，
    // 硬编码正斜杠的断言在那里恒败。
    assert.equal(path, join('/fake/home', '.rivet', 'subagents', 'wo_abc.session.jsonl'))
    // orderId 含冒号时文件名必须经 orderFileKey 编码（Windows ADS 回归）
    assert.ok(
      !workerSessionPath('batch:0', '/fake/home').includes(':'),
      'session 文件名不得含冒号（Windows 非法，会落成 NTFS ADS）',
    )
  })

  it('round-trips complex multimodal and tool messages', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const messages: OaiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
      { role: 'assistant', content: null, reasoning_content: 'thinking deeply', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'file contents here' },
    ]
    saveWorkerSession('wo_complex', 'patcher', 'complex task', messages, home)
    const loaded = loadWorkerSession('wo_complex', home)
    assert.ok(loaded)
    assert.equal(loaded!.messages.length, 3)
    // Verify multimodal user message survives
    const userMsg = loaded!.messages[0]!
    assert.equal(userMsg.role, 'user')
    assert.ok(Array.isArray(userMsg.content))
    // Verify assistant reasoning + tool_calls survive
    const asstMsg = loaded!.messages[1]!
    assert.equal(asstMsg.role, 'assistant')
    assert.equal(asstMsg.reasoning_content, 'thinking deeply')
    assert.ok(asstMsg.tool_calls && asstMsg.tool_calls.length === 1)
  })

  // ── v2 format ────────────────────────────────────────────────────────────

  it('resume retains frozen anchors and the last actual wire proof', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const messages = makeMessages()
    const prefixProof = proveWirePrefix({ model: 'deepseek-v4-flash', messages, tools: [] }, 'deepseek-spark', 'last-main')
    const frozenSnapshot: FrozenSnapshotData = {
      v: 1, frozenUserMerged: [['user-anchor', ['stable appendix']]],
      frozenPendingMerged: [], firstUserKey: 'user-anchor', collapseWatermark: 0, collapseTokenStep: 1024,
    }
    saveWorkerSession('wo_proof', 'code_scout', 'resume', messages, home, undefined, { prefixProof, frozenSnapshot })
    const loaded = loadWorkerSession('wo_proof', home)
    assert.deepEqual(loaded?.prefixProof, prefixProof)
    assert.deepEqual(loaded?.frozenSnapshot, frozenSnapshot)
    assert.deepEqual(loaded?.messages, messages)
    const oversized = [{ role: 'user' as const, content: 'x'.repeat(SESSION_HISTORY_SIZE_LIMIT + 100) }]
    saveWorkerSession('wo_proof', 'code_scout', 'resume', oversized, home, undefined, { prefixProof, frozenSnapshot })
    const trimmed = loadWorkerSession('wo_proof', home)
    assert.deepEqual(trimmed?.messages, oversized)
    assert.deepEqual(trimmed?.prefixProof, prefixProof)
    assert.deepEqual(trimmed?.frozenSnapshot, frozenSnapshot)
    assert.ok(trimmed?.historyRef)
  })

  it('v2 checkpoint round-trips: checkpoint is preserved across save/load', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const id = 'wo_cp_roundtrip'
    saveWorkerSession(id, 'patcher', 'resume me', makeMessages(), home, makeCheckpoint())

    const loaded = loadWorkerSession(id, home)
    assert.ok(loaded, 'should load the v2 record')
    assert.equal(loaded!.format, 2)
    assert.ok(loaded!.checkpoint, 'checkpoint should survive the round-trip')
    assert.equal(loaded!.checkpoint!.turnIndex, 3)
    assert.equal(loaded!.checkpoint!.partialResult, 'auth flow located')
    assert.deepEqual(loaded!.checkpoint!.completedTools, ['grep:auth'])
    assert.equal(loaded!.historyOmitted, undefined)
    assert.equal(loaded!.messages.length, 5)
  })

  it('v1 compatibility: a legacy record without a format field still loads', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    const legacy: Record<string, unknown> = {
      workOrderId: 'wo_legacy',
      profile: 'code_scout',
      objective: 'old objective',
      messages: makeMessages(),
      savedAt: 1700000000000,
    }
    writeFileSync(join(dir, 'wo_legacy.session.jsonl'), JSON.stringify(legacy) + '\n', 'utf-8')

    const loaded = loadWorkerSession('wo_legacy', home)
    assert.ok(loaded, 'legacy v1 record should load')
    assert.equal(loaded!.format, 1)
    assert.equal(loaded!.workOrderId, 'wo_legacy')
    assert.equal(loaded!.messages.length, 5)
  })

  it('oversized history preserves the complete transcript outside the manifest', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const id = 'wo_oversized'
    // Build messages whose serialized size exceeds the session history limit.
    const big = 'x'.repeat(SESSION_HISTORY_SIZE_LIMIT + 100)
    const messages: OaiMessage[] = [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
    ]
    saveWorkerSession(id, 'patcher', 'huge task', messages, home, makeCheckpoint())

    const loaded = loadWorkerSession(id, home)
    assert.ok(loaded, 'oversized record should still load')
    assert.equal(loaded!.format, 2)
    // Never slice a tail — messages must be dropped wholesale, not truncated.
    assert.deepEqual(loaded!.messages, messages)
    assert.equal(loaded!.historyOmitted, undefined)
    assert.ok(loaded!.historyRef)
    // The checkpoint survives the size overflow.
    assert.ok(loaded!.checkpoint, 'checkpoint kept across size overflow')
    assert.equal(loaded!.checkpoint!.turnIndex, 3)
  })

  it('resume leases do not consume checkpoints on rejection or cancellation; one owner per generation', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-resume-lease-'))
    saveWorkerSession('source', 'patcher', 'resume', makeMessages(), home, makeCheckpoint())
    const record = loadWorkerSession('source', home)!
    const first = leaseWorkerResume('source', record, home)
    assert.throws(() => leaseWorkerResume('source', record, home), /already leased/)
    first.release()
    assert.deepEqual(loadWorkerSession('source', home)?.checkpoint, record.checkpoint)
    const next = leaseWorkerResume('source', record, home)
    next.ack(); next.release()
    assert.equal(loadWorkerSession('source', home)?.checkpoint, undefined)
    saveWorkerSession('source', 'patcher', 'resume', makeMessages(), home, makeCheckpoint())
    const original = loadWorkerSession('source', home)!, replacement = leaseWorkerResume('source', original, home)
    const path = workerSessionPath('source', home)
    writeFileSync(path, JSON.stringify({ ...original, checkpoint: { ...original.checkpoint, turnIndex: 99 } }))
    replacement.ack(); replacement.release()
    assert.equal(loadWorkerSession('source', home)?.checkpoint?.turnIndex, 99, 'same timestamp never permits consuming a changed generation')
  })

  it('bad large-history archives cannot silently become empty resumable sessions', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-history-digest-'))
    saveWorkerSession('large', 'code_scout', 'resume', [{ role: 'user', content: 'x'.repeat(SESSION_HISTORY_SIZE_LIMIT + 10) }], home)
    const record = loadWorkerSession('large', home)!
    writeFileSync(join(home, '.rivet/subagents', record.historyRef!.file), 'damaged')
    assert.equal(loadWorkerSession('large', home), null)
  })

  it('corrupt-record fail-open: structurally-invalid v2 record loads as null', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const dir = join(home, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    // Unknown future format → fail open (can't trust what we don't understand).
    writeFileSync(join(dir, 'wo_future.session.jsonl'), JSON.stringify({ format: 3, workOrderId: 'wo_future' }) + '\n', 'utf-8')
    // Valid JSON, valid format, but messages is not an array → fail open.
    writeFileSync(join(dir, 'wo_badshape.session.jsonl'), JSON.stringify({ format: 2, workOrderId: 'wo_badshape', profile: 'p', objective: 'o', messages: 'nope', savedAt: 1 }) + '\n', 'utf-8')

    assert.equal(loadWorkerSession('wo_future', home), null)
    assert.equal(loadWorkerSession('wo_badshape', home), null)
  })

  it('checkpoint consume-once: consumed by the first call, absent on subsequent loads', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const id = 'wo_consume'
    saveWorkerSession(id, 'patcher', 'resume me', makeMessages(), home, makeCheckpoint())

    // First consume returns the checkpoint and clears it atomically from disk.
    const first = consumeCheckpointOnce(id, home)
    assert.ok(first, 'first consume should return the checkpoint')
    assert.equal(first!.turnIndex, 3)

    // A second consume finds nothing left.
    assert.equal(consumeCheckpointOnce(id, home), null)

    // The persisted record is intact except the checkpoint is gone; messages survive.
    const loaded = loadWorkerSession(id, home)
    assert.ok(loaded, 'record should still exist after consume')
    assert.equal(loaded!.checkpoint, undefined)
    assert.equal(loaded!.messages.length, 5)
  })

  it('atomic write: no temp files remain after save', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    const id = 'wo_atomic'
    const messages = makeMessages()
    const outcome = saveWorkerSession(id, 'patcher', 'atomic test', messages, home)
    assert.equal(outcome.ok, true, 'atomic save should succeed')
    assert.deepEqual(loadWorkerSession(id, home)?.messages, messages, 'saved messages should round-trip')
    const dir = join(home, '.rivet', 'subagents')
    const leftovers = readdirSync(dir).filter((f) => !isFilesystemMetadata(f) && f !== `${id}.session.jsonl`)
    assert.deepEqual(leftovers, [], 'temp/rename artifacts should be cleaned up')
  })
})
