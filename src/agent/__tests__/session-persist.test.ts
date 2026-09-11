import { describe, it, beforeEach, afterEach, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_SESSION_MESSAGE_JSON_CHARS, SessionPersist, evictOldSessionsInternal, getSessionDir, projectSlug, serializeSessionMessage, formatExitSummary, shouldAutoWriteHandoff } from '../session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { appendChecksum } from '../checksum.js'
import { decodeTranscriptText, encodeBatch } from '../session-transcript-codec.js'

describe('SessionPersist', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('creates a claim store for the session', () => {
    const persist = new SessionPersist('test-session-001', tempDir)
    const store = persist.createClaimStore()
    assert.ok(store)
    assert.equal(typeof store.propose, 'function')
    assert.equal(typeof store.listActiveClaims, 'function')
  })

  it('buildMemoryBlock returns string for fresh session', () => {
    const persist = new SessionPersist('test-session-002', tempDir)
    const block = persist.buildMemoryBlock()
    assert.equal(typeof block, 'string')
  })

  it('getSessionMemoryState returns undefined for fresh session', () => {
    const persist = new SessionPersist('test-session-003', tempDir)
    const state = persist.getSessionMemoryState()
    assert.equal(state, undefined)
  })

  it('injectDurableClaims does not throw on fresh store', () => {
    const persist = new SessionPersist('test-session-004', tempDir)
    const store = persist.createClaimStore()
    assert.doesNotThrow(() => persist.injectDurableClaims(store))
  })

  it('getBackupDir returns a path containing the session id', () => {
    const persist = new SessionPersist('test-session-005', tempDir)
    const dir = persist.getBackupDir()
    assert.equal(typeof dir, 'string')
    assert.ok(dir.includes('test-session-005'))
  })

  it('caps oversized session message JSON lines', () => {
    const serialized = serializeSessionMessage({ role: 'user', content: 'x'.repeat(MAX_SESSION_MESSAGE_JSON_CHARS * 2) } as any)

    assert.ok(serialized.length <= MAX_SESSION_MESSAGE_JSON_CHARS + 512)
    assert.match(serialized, /session-message-truncated/)
  })
})

describe('SessionPersist — metadata (P1)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-meta-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('initMetadata creates metadata file with defaults', () => {
    const persist = new SessionPersist('meta-init-001', tempDir)
    persist.initMetadata({ model: 'deepseek-v4' })

    const meta = persist.loadMetadata()
    assert.ok(meta)
    assert.equal(meta!.model, 'deepseek-v4')
    assert.equal(meta!.status, 'active')
    assert.equal(meta!.turnCount, 0)
    assert.equal(meta!.toolCallCount, 0)
    assert.ok(meta!.createdAt > 0)
    assert.ok(meta!.tokenUsage)
    assert.equal(meta!.tokenUsage!.prompt, 0)
    assert.equal(meta!.tokenUsage!.completion, 0)
    assert.equal(meta!.tokenUsage!.total, 0)
  })

  it('initMetadata is idempotent — does not overwrite existing', () => {
    const persist = new SessionPersist('meta-idempotent', tempDir)
    persist.initMetadata({ model: 'model-v1' })
    persist.updateMetadata({ turnCount: 5 })
    // Second init should be a no-op
    persist.initMetadata({ model: 'model-v2' })

    const meta = persist.loadMetadata()
    assert.equal(meta!.model, 'model-v1')
    assert.equal(meta!.turnCount, 5)
  })

  it('updateMetadata merges partial fields', () => {
    const persist = new SessionPersist('meta-patch', tempDir)
    persist.initMetadata({ model: 'deepseek-v4' })
    persist.updateMetadata({ turnCount: 3, toolCallCount: 10 })
    persist.updateMetadata({ turnCount: 4, title: 'Fix the bug' })

    const meta = persist.loadMetadata()
    assert.equal(meta!.model, 'deepseek-v4')
    assert.equal(meta!.turnCount, 4)
    assert.equal(meta!.toolCallCount, 10)
    assert.equal(meta!.title, 'Fix the bug')
  })

  it('updateMetadata persists lastStopReason (谁停的它 — 事后取证)', () => {
    const persist = new SessionPersist('meta-stop-reason', tempDir)
    persist.initMetadata({ model: 'deepseek-v4' })
    persist.updateMetadata({
      lastStopReason: { source: 'user-interrupt', turn: 46, voluntary: false, detail: 'esc', t: 1751830000000 },
    })
    // 每次 run 结束覆盖上一条
    persist.updateMetadata({
      lastStopReason: { source: 'natural-finish', turn: 12, voluntary: true, t: 1751830001000 },
    })

    const meta = persist.loadMetadata()
    assert.equal(meta!.lastStopReason!.source, 'natural-finish')
    assert.equal(meta!.lastStopReason!.turn, 12)
    assert.equal(meta!.lastStopReason!.voluntary, true)
    assert.equal(meta!.lastStopReason!.detail, undefined)
    assert.equal(meta!.model, 'deepseek-v4', 'sibling fields survive the patch')
  })

  it('updateMetadata merges tokenUsage without losing existing fields', () => {
    const persist = new SessionPersist('meta-tokens', tempDir)
    persist.initMetadata()
    persist.updateMetadata({ tokenUsage: { prompt: 100, completion: 50, total: 150 } })
    persist.updateMetadata({ tokenUsage: { prompt: 200, completion: 60, total: 260 } })

    const meta = persist.loadMetadata()
    assert.equal(meta!.tokenUsage!.prompt, 200)
    assert.equal(meta!.tokenUsage!.completion, 60)
    assert.equal(meta!.tokenUsage!.total, 260)
  })

  it('updateMetadata preserves createdAt', () => {
    const persist = new SessionPersist('meta-created', tempDir)
    persist.initMetadata()
    const originalCreatedAt = persist.loadMetadata()!.createdAt

    // Wait a tiny bit and update
    persist.updateMetadata({ turnCount: 1 })
    const meta = persist.loadMetadata()
    assert.equal(meta!.createdAt, originalCreatedAt)
    assert.ok(meta!.updatedAt >= originalCreatedAt)
  })

  it('updateMetadata advances updatedAt past createdAt (regression: spread order froze it)', () => {
    // Stub Date.now so the test is deterministic and the advance is observable
    // without sleeping. Regression guard: a prior bug spread ...existing AFTER
    // updatedAt, re-overwriting it with the stale value so it never advanced.
    let clock = 1_000
    const now = mock.method(Date, 'now', () => clock)
    try {
      const persist = new SessionPersist('meta-updatedat', tempDir)
      persist.initMetadata()
      const created = persist.loadMetadata()!
      assert.equal(created.createdAt, 1_000)
      assert.equal(created.updatedAt, 1_000)

      clock = 5_000
      persist.updateMetadata({ turnCount: 1 })
      const after = persist.loadMetadata()!
      assert.equal(after.createdAt, 1_000, 'createdAt must be preserved')
      assert.equal(after.updatedAt, 5_000, 'updatedAt must advance to current time')
      assert.ok(after.updatedAt > after.createdAt, 'updatedAt must move past createdAt on update')
    } finally {
      now.mock.restore()
    }
  })

  it('loadMetadata returns undefined when no metadata file exists', () => {
    const persist = new SessionPersist('meta-noexist', tempDir)
    assert.equal(persist.loadMetadata(), undefined)
  })

  it('listSessionsWithMetadata returns sorted results', async () => {
    // Create sessions with .jsonl files (required by listSessions) + metadata
    const p1 = new SessionPersist('meta-list-1', tempDir)
    await p1.appendOaiWithChecksum({ role: 'user', content: 'hello' })
    p1.initMetadata()
    p1.updateMetadata({ title: 'older session' })

    const p2 = new SessionPersist('meta-list-2', tempDir)
    await p2.appendOaiWithChecksum({ role: 'user', content: 'hello2' })
    p2.initMetadata()
    p2.updateMetadata({ title: 'newer session', turnCount: 1 })

    const sessions = SessionPersist.listSessionsWithMetadata(tempDir)
    const ourSessions = sessions.filter(s => s.id.startsWith('meta-list-'))
    assert.equal(ourSessions.length, 2)
    // Most recent first
    assert.ok(ourSessions[0]!.updatedAt >= ourSessions[1]!.updatedAt)
  })
})

describe('SessionPersist — resolveSessionId / formatSessionList / listMainSessions', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-resolve-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
    SessionPersist.invalidateListCache()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
    SessionPersist.invalidateListCache()
  })

  async function seed(id: string, title: string): Promise<void> {
    const p = new SessionPersist(id, tempDir)
    await p.appendOaiWithChecksum({ role: 'user', content: title })
    p.initMetadata({ model: 'deepseek-v4' })
    p.updateMetadata({ title })
    // updateMetadata 合入批节奏（内存缓存），列表走磁盘读——flush 落盘。
    await p.flushSessionBuffer()
    SessionPersist.invalidateListCache()
  }

  it('exact id match wins', async () => {
    await seed('aaaa1111-0000', 'one')
    await seed('aaaa2222-0000', 'two')
    assert.deepEqual(SessionPersist.resolveSessionId(tempDir, 'aaaa1111-0000'), { id: 'aaaa1111-0000' })
  })

  it('unique prefix resolves to the full id', async () => {
    await seed('abcd1234-0000', 'one')
    await seed('wxyz9999-0000', 'two')
    assert.deepEqual(SessionPersist.resolveSessionId(tempDir, 'abcd'), { id: 'abcd1234-0000' })
  })

  it('ambiguous prefix returns candidate list', async () => {
    await seed('dup11111-0000', 'one')
    await seed('dup22222-0000', 'two')
    const r = SessionPersist.resolveSessionId(tempDir, 'dup')
    assert.ok(r && 'ambiguous' in r)
    assert.equal((r as { ambiguous: string[] }).ambiguous.length, 2)
  })

  it('no match returns null (incl. empty ref)', async () => {
    await seed('aaaa1111-0000', 'one')
    assert.equal(SessionPersist.resolveSessionId(tempDir, 'zzzz'), null)
    assert.equal(SessionPersist.resolveSessionId(tempDir, ''), null)
    assert.equal(SessionPersist.resolveSessionId(tempDir, '   '), null)
  })

  it('excludes worker sub-sessions from listing and resolution', async () => {
    await seed('main1111-0000', 'main')
    await seed('worker-abcdef01', 'worker child')
    const ids = SessionPersist.listMainSessions(tempDir).map(s => s.id)
    assert.ok(ids.includes('main1111-0000'))
    assert.ok(!ids.some(id => id.startsWith('worker-')))
    assert.equal(SessionPersist.resolveSessionId(tempDir, 'worker-'), null)
  })

  it('formatSessionList renders rows and marks the current session', async () => {
    await seed('cur00000-0000', 'current one')
    const out = SessionPersist.formatSessionList(tempDir, 'cur00000-0000')
    assert.match(out, /cur00000/)
    assert.match(out, /当前/)
    assert.match(out, /current one/)
  })

  it('formatSessionList handles an empty session dir', () => {
    const out = SessionPersist.formatSessionList(tempDir)
    assert.match(out, /没有历史会话/)
  })
})

describe('SessionPersist — persisted messages', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-msg-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('persists truncated oversized messages as loadable JSON', async () => {
    const persist = new SessionPersist('test-session-large-message', tempDir)
    await persist.appendWithChecksum({ role: 'user', content: 'x'.repeat(MAX_SESSION_MESSAGE_JSON_CHARS * 2) } as any)

    const messages = persist.load()
    assert.equal(messages.length, 1)
    assert.match(String(messages[0]!.content), /session-message-truncated/)
  })

  it('appends and loads OpenAI-native messages with checksum', async () => {
    const persist = new SessionPersist('test-session-oai', tempDir)
    const messages: OaiMessage[] = [
      { role: 'user', content: 'Read a file' },
      {
        role: 'assistant',
        content: 'Reading.',
        reasoning_content: 'Need file context.',
        tool_calls: [
          {
            id: 'call_read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read', content: 'contents' },
    ]

    for (const message of messages) {
      await persist.appendOaiWithChecksum(message)
    }

    assert.deepEqual(persist.loadOai(), messages)
  })

  it('normalizes legacy empty tool_calls rows while loading a session', () => {
    const persist = new SessionPersist('test-session-empty-tool-calls', tempDir)
    const malformed = JSON.stringify({ role: 'assistant', content: 'recovered', tool_calls: [] })
    writeFileSync(persist.getFilePath(), appendChecksum(malformed) + '\n')

    assert.deepEqual(persist.loadOai(), [{ role: 'assistant', content: 'recovered' }])
  })

  it('migrates legacy session messages to OAI on loadOai', async () => {
    const persist = new SessionPersist('test-session-oai-legacy', tempDir)
    await persist.appendWithChecksum({ role: 'user', content: 'Start' } as any)
    await persist.appendWithChecksum({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Need context.' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'README.md' } },
      ],
    } as any)
    await persist.appendWithChecksum({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contents' }],
    } as any)

    assert.deepEqual(persist.loadOai(), [
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: 'Reading.',
        reasoning_content: 'Need context.',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: 'contents' },
    ])
  })

  it('strips a write-tool orphan tool_call with a NON-destructive verify reminder (not "files do not exist")', async () => {
    const persist = new SessionPersist('test-orphan-write', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'edit the component' })
    // Assistant committed a write_file call but the result line never landed
    // (interrupted after the file was written, before the result was flushed).
    await persist.appendOaiWithChecksum({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_write', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"App.tsx"}' } },
      ],
    })

    const loaded = persist.loadOai()
    const reminder = loaded.find(m => m.role === 'system')
    assert.ok(reminder, 'expected an injected system reminder')
    const text = String(reminder!.content)
    // Must NOT falsely assert the file is gone — that drives a blind rewrite.
    assert.doesNotMatch(text, /DO NOT EXIST/i)
    // Must steer the model to verify current state first.
    assert.match(text, /verify/i)
    assert.match(text, /read_file|grep/i)
    // The orphan tool_call itself is stripped (empty-content assistant dropped).
    assert.ok(!loaded.some(m => m.role === 'assistant' && m.tool_calls?.length))
  })

  it('keeps the generic re-run reminder for a read-only orphan tool_call', async () => {
    const persist = new SessionPersist('test-orphan-read', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'look something up' })
    await persist.appendOaiWithChecksum({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_grep', type: 'function', function: { name: 'grep', arguments: '{"pattern":"foo"}' } },
      ],
    })

    const reminder = persist.loadOai().find(m => m.role === 'system')
    assert.ok(reminder)
    const text = String(reminder!.content)
    assert.doesNotMatch(text, /read_file or grep/i)
    assert.match(text, /re-run/i)
  })
})


describe('SessionEviction', () => {
  let evictDir: string

  before(() => {
    evictDir = join(tmpdir(), `rivet-evict-test-${Date.now()}`)
    mkdirSync(evictDir, { recursive: true })
  })

  after(() => {
    rmSync(evictDir, { recursive: true, force: true })
  })

  it('does not evict when below limit', () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(evictDir, `session-${i}.jsonl`), '{}\n')
    }
    const evicted = evictOldSessionsInternal(evictDir, 'session-keep', 50)
    assert.equal(evicted.length, 0)
  })

  it('evicts oldest sessions beyond limit keeping current', () => {
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(evictDir, `ev-${i}.jsonl`), '{}\n')
    }
    writeFileSync(join(evictDir, 'ev-keep.jsonl'), '{}\n')
    const evicted = evictOldSessionsInternal(evictDir, 'ev-keep', 10)
    // 13 total - 10 limit = 3 should be evicted
    assert.ok(evicted.length >= 3)
    assert.ok(!evicted.includes('ev-keep'))
    // Keep file should still exist
    assert.ok(existsSync(join(evictDir, 'ev-keep.jsonl')))
  })

  it('handles empty directory', () => {
    const emptyDir = join(evictDir, 'empty')
    mkdirSync(emptyDir, { recursive: true })
    const evicted = evictOldSessionsInternal(emptyDir, 'none', 10)
    assert.equal(evicted.length, 0)
  })

  it('removes same-name session directory when evicting (getBackupDir leak)', () => {
    // Simulate what getBackupDir() creates: <session-id>/backups/
    // Without rmSync on the directory, these accumulate forever.
    // （id 不能用 worker- 前缀——worker 会话已不进 evict 额度池。）
    const sessDir = join(evictDir, 'sess-leak')
    mkdirSync(join(sessDir, 'backups'), { recursive: true })
    writeFileSync(join(sessDir, 'backups', 'dummy.txt'), 'test')
    // Need the .jsonl for evict to notice the session
    writeFileSync(join(evictDir, 'sess-leak.jsonl'), '{}\n')

    // Fill up to trigger eviction (limit=1, keep=another)
    writeFileSync(join(evictDir, 'sess-keep.jsonl'), '{}\n')

    const evicted = evictOldSessionsInternal(evictDir, 'sess-keep', 1)
    assert.ok(evicted.includes('sess-leak'))
    // Directory must be gone — this is the bug we're fixing
    assert.ok(!existsSync(sessDir), 'session directory should be removed on evict')
    // Keep session's files/dirs should survive
    assert.ok(existsSync(join(evictDir, 'sess-keep.jsonl')))
  })

  it('worker jsonl 与附属文件（.claims 等）不占额度、不被驱逐——主会话被 worker 洪水挤出额度是桌面失忆事故的根因', () => {
    const dir = join(evictDir, 'quota-isolation')
    mkdirSync(dir, { recursive: true })
    // 3 个主会话（最老的 main-0 应在 limit=2 时被驱逐）
    for (let i = 0; i < 3; i++) {
      const p = join(dir, `main-${i}.jsonl`)
      writeFileSync(p, '{}\n')
      const t = new Date(Date.now() - (100 - i) * 1000)
      utimesSync(p, t, t)
    }
    // worker 洪水 + claims 附属文件：全部比主会话更老（曾经会先于主会话被计入并驱逐）
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `worker-wo_${i}-abc.jsonl`)
      writeFileSync(p, '{}\n')
      const t = new Date(Date.now() - (200 - i) * 1000)
      utimesSync(p, t, t)
    }
    writeFileSync(join(dir, 'main-1.claims.jsonl'), '{}\n')

    const evicted = evictOldSessionsInternal(dir, 'main-2', 2)

    // 只有主会话计数：3 主会话 - limit 2 = 驱逐 1（最老的 main-0）
    assert.deepEqual(evicted, ['main-0'], 'worker/claims 不占额度，驱逐只按主会话计算')
    // worker 文件全部幸存（生命周期归 cleanupStaleWorkerSessionDirs）
    for (let i = 0; i < 5; i++) {
      assert.ok(existsSync(join(dir, `worker-wo_${i}-abc.jsonl`)), `worker-${i} 不该被 evict 碰`)
    }
    // 在用主会话的 claims 附属文件不被当作"最老会话"驱逐
    assert.ok(existsSync(join(dir, 'main-1.claims.jsonl')), 'claims 附属文件不是会话，不被驱逐')
    assert.ok(existsSync(join(dir, 'main-1.jsonl')))
    assert.ok(existsSync(join(dir, 'main-2.jsonl')))
  })
})

describe('checksum integration', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-checksum-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('appends and loads messages with checksum', async () => {
    const persist = new SessionPersist('test-checksum', tempDir)
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    await persist.appendWithChecksum(message)
    const loaded = persist.loadWithChecksum()
    
    assert.equal(loaded.length, 1)
    assert.deepEqual(loaded[0], message)
  })

  it('loads legacy format without checksum', async () => {
    const persist = new SessionPersist('test-legacy', tempDir)
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    // 手动写入旧格式
    const { appendFileSync } = await import('node:fs')
    appendFileSync(persist.getFilePath(), JSON.stringify(message) + '\n')
    
    const loaded = persist.loadWithChecksum()
    
    assert.equal(loaded.length, 1)
    assert.deepEqual(loaded[0], message)
  })

  it('skips invalid checksum lines', async () => {
    const persist = new SessionPersist('test-invalid-checksum', tempDir)
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    // 写入有效消息
    await persist.appendWithChecksum(message)
    
    // 写入无效校验和（帧内坏行——转录已是 zstd 帧流，坏行以帧为单位注入）
    const { appendFileSync } = await import('node:fs')
    appendFileSync(persist.getFilePath(), encodeBatch('{"invalid": true}|0000000000000000\n'))
    
    const loaded = persist.loadWithChecksum()

    assert.equal(loaded.length, 1)
    assert.deepEqual(loaded[0], message)
  })

  it('appendModelSwitch writes a checksummed event that is skipped on replay', async () => {
    const persist = new SessionPersist('test-model-switch', tempDir)
    // 真实消息 + 中间夹一条切换事件
    await persist.appendOaiWithChecksum({ role: 'user', content: 'before switch' })
    persist.appendModelSwitch({ from: 'claude-opus-4-8', to: 'deepseek-v4-pro', provider: 'deepseek' })
    await persist.appendOaiWithChecksum({ role: 'assistant', content: 'after switch' })

    // model_switch 行不进消息历史（与 compact_start/end 同等待遇），不破坏 replay
    const loaded = persist.loadOai()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.content, 'before switch')
    assert.equal(loaded[1]!.content, 'after switch')

    // 但事件确实落盘且通过 checksum（裸读文件能看到 model_switch 行）
    // write-behind 批队列：裸读前必须显式 flush 让批落盘。
    await persist.flushSessionBuffer()
    const { readFileSync } = await import('node:fs')
    const raw = decodeTranscriptText(readFileSync(persist.getFilePath()))
    assert.match(raw, /"type":"model_switch"/)
    assert.match(raw, /"to":"deepseek-v4-pro"/)
    assert.match(raw, /"from":"claude-opus-4-8"/)
  })

  it('compactOai preserves model_switch audit lines across a full rewrite', async () => {
    const persist = new SessionPersist('test-switch-survives-compact', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'before switch' })
    persist.appendModelSwitch({ from: 'deepseek-v4-pro', to: 'glm-5.2', provider: 'glm' })
    await persist.appendOaiWithChecksum({ role: 'assistant', content: 'after switch' })

    // 压缩重写从内存消息再生文件——audit 行不进内存，重写前必须从旧文件捞回。
    persist.compactOai(persist.loadOai())

    const { readFileSync } = await import('node:fs')
    const raw = decodeTranscriptText(readFileSync(persist.getFilePath()))
    assert.match(raw, /"type":"model_switch"/, 'model_switch audit line must survive compactOai')
    assert.match(raw, /"to":"glm-5\.2"/)
    // replay 语义不变：audit 行仍被跳过
    const loaded = persist.loadOai()
    assert.equal(loaded.length, 2)

    // 再次重写也不丢、不重复膨胀（每次重写恰好保留一份）
    persist.compactOai(persist.loadOai())
    const raw2 = decodeTranscriptText(readFileSync(persist.getFilePath()))
    assert.equal(raw2.split('\n').filter(l => l.includes('"type":"model_switch"')).length, 1)
  })

  it('compactOaiAsync preserves model_switch audit lines across a full rewrite', async () => {
    const persist = new SessionPersist('test-switch-survives-async-compact', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'hi' })
    persist.appendModelSwitch({ to: 'glm-5.2', provider: 'glm' })

    await persist.compactOaiAsync(persist.loadOai())

    const { readFileSync } = await import('node:fs')
    const raw = decodeTranscriptText(readFileSync(persist.getFilePath()))
    assert.match(raw, /"type":"model_switch"/, 'model_switch audit line must survive compactOaiAsync')
    assert.equal(persist.loadOai().length, 1)
  })
})

describe('projectSlug (cross-platform session dir name)', () => {
  it('POSIX path: basename + hash, backward-compatible with old split("/") behavior', () => {
    // 这是回归基线：macOS/Linux 既有会话目录名不能变，否则历史会话丢失。
    const slug = projectSlug('/Users/banxia/app/deepseek-tui/opencode-tui')
    assert.match(slug, /^opencode-tui-[0-9a-f]{6}$/, `posix slug: ${slug}`)
  })

  it('Windows backslash path: splits on \\ and takes the real basename', () => {
    // 旧实现 split('/') 切不开反斜杠路径 → 整条路径作为 basename → 含 ':' '\' 非法。
    const slug = projectSlug('D:\\tianshu\\Tianshu-Tui')
    assert.match(slug, /^Tianshu-Tui-[0-9a-f]{6}$/, `windows backslash slug: ${slug}`)
    // slug 绝不能含盘符冒号或反斜杠（NTFS 非法目录字符）
    assert.ok(!/[\\:]/.test(slug), `slug must not contain drive-colon or backslash: ${slug}`)
  })

  it('Windows drive-letter path: colon sanitized out of basename', () => {
    // 报错现场：cwd 形如 D:\tianshu\proj，basename 含 D: → 清洗后不含冒号
    const slug = projectSlug('C:\\Users\\Admin\\projects\\my-app')
    assert.match(slug, /^my-app-[0-9a-f]{6}$/, `drive-letter slug: ${slug}`)
  })

  it('reproduces the reported fatal: full Windows path no longer leaks into slug', () => {
    // 烟雾测试报错：mkdir "...sessions\D:\tianshu\Tianshu-Tui-8ffe00"
    // 修复后 slug 必须只是 basename-hash，绝不包含 \ 或 :
    const slug = projectSlug('D:\\tianshu\\Tianshu-Tui-8ffe00')
    assert.ok(!slug.includes('D:'), `no drive leak: ${slug}`)
    assert.ok(!slug.includes('\\'), `no backslash leak: ${slug}`)
    assert.match(slug, /^[^\\/:*?"<>|]+-[0-9a-f]{6}$/, `slug fs-safe: ${slug}`)
  })

  it('mixed separators (/ and \\) both split correctly', () => {
    // 某些 Windows 工具产出正反斜杠混合路径
    const slug = projectSlug('D:/tianshu\\mixed-project')
    assert.match(slug, /^mixed-project-[0-9a-f]{6}$/, `mixed-sep slug: ${slug}`)
  })

  it('different cwds produce different slugs (hash disambiguates)', () => {
    const a = projectSlug('/home/u/proj')
    const b = projectSlug('/home/u/other/proj')
    // 同 basename 'proj' 但 cwd 不同 → hash 不同 → 不撞目录
    assert.notEqual(a, b, 'same basename different cwd must differ by hash')
  })

  it('trailing slash does not change the slug', () => {
    // 有无尾斜杠应等价（filter(Boolean) 已去掉空段，hash 仍基于原 cwd）
    const withSlash = projectSlug('/home/u/proj/')
    const noSlash = projectSlug('/home/u/proj')
    // basename 一致（都是 proj）；hash 因 cwd 字面量不同而不同——这是既有行为，保留。
    assert.ok(withSlash.startsWith('proj-') && noSlash.startsWith('proj-'), 'basename stable')
  })
})

describe('formatExitSummary（退出回连指引）', () => {
  const SID = '3f415454-aaaa-bbbb-cccc-1234567890ab'

  it('含 id 前缀、轮数、标题与恢复命令', () => {
    const out = formatExitSummary({ title: '修复 fetch failed 报错', turnCount: 12 }, SID)
    assert.ok(out, '有内容的会话应产出摘要')
    assert.ok(out!.includes('3f415454'), `含 id8: ${out}`)
    assert.ok(out!.includes('12轮'), `含轮数: ${out}`)
    assert.ok(out!.includes('修复 fetch failed 报错'), `含标题: ${out}`)
    assert.ok(out!.includes('rivet --continue'), `含 --continue 指引: ${out}`)
    assert.ok(out!.includes('rivet --resume 3f415454'), `含 --resume 指引: ${out}`)
  })

  it('无标题时省略标题段', () => {
    const out = formatExitSummary({ turnCount: 3 }, SID)
    assert.ok(out)
    assert.ok(out!.includes('3轮'))
    assert.ok(!out!.includes('“'), `无标题引号: ${out}`)
  })

  it('首行是品牌告别语（✦ 启明星）', () => {
    const out = formatExitSummary({ turnCount: 3 }, SID)
    assert.ok(out)
    assert.ok(out!.startsWith('✦ 后会有期'), `告别行应在首行: ${out}`)
  })

  it('空会话（turnCount 0 / 缺省 / null meta）不打印', () => {
    assert.equal(formatExitSummary({ turnCount: 0 }, SID), null)
    assert.equal(formatExitSummary({}, SID), null)
    assert.equal(formatExitSummary(null, SID), null)
  })

  it('超长标题截断到 60 字符', () => {
    const long = 'x'.repeat(200)
    const out = formatExitSummary({ title: long, turnCount: 1 }, SID)
    assert.ok(out)
    assert.ok(!out!.includes('x'.repeat(61)), '标题应截断')
  })
})


describe('SessionPersist — 冻结前缀快照（resume 缓存继承）', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  const sampleSnapshot = () => ({
    v: 1 as const,
    frozenUserMerged: [['m1', ['snapshot-a', 'snapshot-b']] as [string, string[]]],
    frozenPendingMerged: [['m2', 'pending-c'] as [string, string]],
    firstUserKey: 'm1',
    collapseWatermark: 42,
    collapseTokenStep: 7,
  })

  it('writeFrozenSnapshot → readFrozenSnapshot 往返一致', () => {
    const persist = new SessionPersist('frozen-session-001', tempDir)
    persist.writeFrozenSnapshot(sampleSnapshot())
    assert.deepEqual(persist.readFrozenSnapshot(), sampleSnapshot())
  })

  it('无文件 / 坏 JSON / 坏形状一律降级 undefined', () => {
    const persist = new SessionPersist('frozen-session-002', tempDir)
    assert.equal(persist.readFrozenSnapshot(), undefined, '无文件')

    const frozenPath = join(getSessionDir(tempDir), 'frozen-session-002.frozen.json')
    writeFileSync(frozenPath, '{not json')
    assert.equal(persist.readFrozenSnapshot(), undefined, '坏 JSON')

    writeFileSync(frozenPath, JSON.stringify({ v: 2, frozenUserMerged: [], frozenPendingMerged: [], firstUserKey: null, collapseWatermark: 0, collapseTokenStep: -1 }))
    assert.equal(persist.readFrozenSnapshot(), undefined, '版本不符')
  })

  it('evictOldSessionsInternal 连带删除 .frozen.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-evict-'))
    try {
      // 造 limit+1 个会话，最老的带 frozen 文件
      for (let i = 0; i < 4; i++) {
        const id = `evict-${String(i).padStart(3, '0')}`
        const p = join(dir, `${id}.jsonl`)
        writeFileSync(p, '{}')
        // mtime 递增保证淘汰序确定
        const t = new Date(Date.now() - (100 - i) * 1000)
        utimesSync(p, t, t)
      }
      writeFileSync(join(dir, 'evict-000.frozen.json'), '{}')
      const evicted = evictOldSessionsInternal(dir, 'evict-003', 3)
      assert.deepEqual(evicted, ['evict-000'])
      assert.ok(!existsSync(join(dir, 'evict-000.frozen.json')), 'frozen 文件应随会话一并淘汰')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe('formatExitSummary — 缓存成本备注', () => {
  it('含回连缓存成本提醒（TTL 内继承锚点 / 过期全量重建）', () => {
    const out = formatExitSummary({ title: 't', turnCount: 5 }, '3f415454-aaaa-bbbb-cccc-1234567890ab')
    assert.ok(out)
    assert.match(out!, /缓存成本/)
    assert.match(out!, /继承冻结锚点/)
    assert.match(out!, /全量重建一次前缀/)
  })
})

describe('shouldAutoWriteHandoff — shutdown 自动交接防覆盖', () => {
  const SESSION_START = 1_000_000

  it('无既有文件 → 写（兜底）', () => {
    assert.equal(shouldAutoWriteHandoff(null, SESSION_START), true)
  })

  it('旧文件（mtime ≤ 会话开始）→ 重写（上一会话/本次未手动交接）', () => {
    assert.equal(shouldAutoWriteHandoff(SESSION_START - 1, SESSION_START), true)
    assert.equal(shouldAutoWriteHandoff(SESSION_START, SESSION_START), true)
  })

  it('会话内更新的文件（mtime > 会话开始）→ 跳过（/handoff 或人工编辑不被摘要覆盖）', () => {
    assert.equal(shouldAutoWriteHandoff(SESSION_START + 1, SESSION_START), false)
  })
})

describe('SessionPersist — getHandoffPath', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('返回会话目录下 <id>.handoff.md，writeHandoff 写入同一路径', () => {
    const persist = new SessionPersist('handoff-path-001', tempDir)
    const p = persist.getHandoffPath()
    assert.ok(p.endsWith('handoff-path-001.handoff.md'))
    persist.writeHandoff('# 交接')
    assert.ok(existsSync(p), 'writeHandoff 与 getHandoffPath 同路径')
  })
})

describe('SessionPersist — loadPreviousDurableClaims（跨会话继承）', () => {
  let tempDir: string

  // UUID 形态 id（SESSION_ID_RE 只认 [a-zA-Z0-9_-]）。字典序刻意设计：
  // NEWER < CURRENT < OLDER，即「时间上最近的会话」字典序反而最小——
  // 老实现 sort().pop() 取字典序最大，必然错过它。
  const OLDER = 'ffff0001-0000-4000-8000-000000000001'
  const NEWER = 'bbbb0002-0000-4000-8000-000000000002'
  const CURRENT = 'cccc0003-0000-4000-8000-000000000003'
  const ORPHAN = 'eeee0004-0000-4000-8000-000000000004'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-durable-claims-'))
    process.env.RIVET_SESSION_DIR = tempDir
    SessionPersist.invalidateListCache()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
    SessionPersist.invalidateListCache()
  })

  /**
   * 按真实磁盘形态种一个会话：转录 .jsonl（write-behind 批）+ meta.json
   * （updatedAt 由时钟参数决定，保证排序断言确定性）+ durable claims 落盘
   * （write-behind 写链）。claims 文件本身 `<id>.claims.jsonl` 就是
   * listSessions 剥出一层后缀后 `<id>.claims` 伪会话条目的来源。
   */
  async function seedSession(id: string, label: string, clockMs: number, withClaims = true): Promise<void> {
    const now = mock.method(Date, 'now', () => clockMs)
    try {
      const persist = new SessionPersist(id, tempDir)
      await persist.appendOaiWithChecksum({ role: 'user', content: `session ${label}` })
      persist.initMetadata({ model: 'deepseek-v4' })
      persist.updateMetadata({ title: `session ${label}` })
      await persist.flushSessionBuffer()
      if (!withClaims) return

      const store = persist.createClaimStore()
      const claim = store.propose({
        kind: 'user_constraint',
        scope: 'session',
        text: `durable-claim-of-${label}`,
        confidence: 0.9,
        fitness: 5,
        source: { actor: 'user', sessionId: id, turn: 1, eventId: `turn-1:${id}` },
        evidence: [{ id: 'e1', kind: 'user_message', summary: label, createdAt: clockMs }],
        createdAt: clockMs,
        tags: [],
      })
      store.updateClaimStatus(claim.id, 'durable', 'seed: cross-session inheritance fixture')
      await store.flushWrites()
    } finally {
      now.mock.restore()
    }
  }

  it('伪会话条目（<id>.claims.jsonl 附属文件被 listSessions 剥成 <id>.claims）不被当成「上一个会话」——继承最近真会话的 durable claims 而非恒 []', async () => {
    await seedSession(OLDER, 'older', 1_000)
    await seedSession(NEWER, 'newer', 2_000)
    await seedSession(CURRENT, 'current', 3_000)
    // 另造一个孤儿伪条目：转录已清、claims 附属文件残留（崩溃/清理后的真实磁盘形态）
    writeFileSync(join(getSessionDir(tempDir), `${ORPHAN}.claims.jsonl`), '')
    SessionPersist.invalidateListCache()

    const persist = new SessionPersist(CURRENT, tempDir)
    const claims = persist.loadPreviousDurableClaims()

    assert.equal(claims.length, 1, '必须继承到恰好一条 durable claim（带点伪 id 未过滤时恒返回 []）')
    assert.equal(claims[0]!.text, 'durable-claim-of-newer', '必须是时间上最近的真会话（newer）的 claim')
  })

  it('字典序最大 ≠ 最近：上一个真会话 id 更大时也必须按 updatedAt 选最近的，而非字典序最大的旧会话', async () => {
    // OLDER 字典序最大但时间更老、无 claims 文件；NEWER 最近、带 durable claims
    await seedSession(OLDER, 'older', 1_000, false)
    await seedSession(NEWER, 'newer', 2_000)
    await seedSession(CURRENT, 'current', 3_000)
    SessionPersist.invalidateListCache()

    const persist = new SessionPersist(CURRENT, tempDir)
    const claims = persist.loadPreviousDurableClaims()

    assert.equal(claims.length, 1, '必须按 updatedAt 选中最近的 NEWER，而不是字典序最大的 OLDER')
    assert.equal(claims[0]!.text, 'durable-claim-of-newer')
  })

  it('没有上一个真会话时返回 []（孤儿伪条目不算会话）', async () => {
    await seedSession(CURRENT, 'current', 1_000)
    writeFileSync(join(getSessionDir(tempDir), `${ORPHAN}.claims.jsonl`), '')
    SessionPersist.invalidateListCache()

    const persist = new SessionPersist(CURRENT, tempDir)
    assert.deepEqual(persist.loadPreviousDurableClaims(), [])
  })
})
