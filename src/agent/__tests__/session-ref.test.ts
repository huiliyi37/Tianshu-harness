import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SessionPersist } from '../session-persist.js'
import { resolveSessionRef, formatSessionRefMessage } from '../session-ref.js'

describe('resolveSessionRef — 会话引用多模态解析', () => {
  let tempDir: string
  const originalSessionDir = process.env.RIVET_SESSION_DIR

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-session-ref-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
    SessionPersist.invalidateListCache()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    if (originalSessionDir !== undefined) {
      process.env.RIVET_SESSION_DIR = originalSessionDir
    } else {
      delete process.env.RIVET_SESSION_DIR
    }
    SessionPersist.invalidateListCache()
  })

  async function seed(id: string, title: string, updatedAt?: number): Promise<void> {
    const p = new SessionPersist(id, tempDir)
    await p.appendOaiWithChecksum({ role: 'user', content: title })
    p.initMetadata({ model: 'deepseek-v4' })
    p.updateMetadata({ title, ...(updatedAt ? { updatedAt } : {}) })
    await p.flushSessionBuffer()
    SessionPersist.invalidateListCache()
  }

  it('空输入与空引号返回 empty，不匹配无标题会话', async () => {
    // 即使存在空标题会话，空引号也不应误匹配
    await seed('empty-title-0001', '')
    assert.deepEqual(resolveSessionRef(tempDir, ''), { kind: 'empty' })
    assert.deepEqual(resolveSessionRef(tempDir, '   '), { kind: 'empty' })
    assert.deepEqual(resolveSessionRef(tempDir, '""'), { kind: 'empty' })
    assert.deepEqual(resolveSessionRef(tempDir, "''"), { kind: 'empty' })
    assert.deepEqual(resolveSessionRef(tempDir, '"   "'), { kind: 'empty' })
  })

  it('显式 --id 或 -i 绕过数字序号冲突，定向解析 ID 前缀', async () => {
    await seed('12345678-0001', 'Session A')
    await seed('87654321-0002', 'Session B')

    // --id 1234
    const r1 = resolveSessionRef(tempDir, '--id 1234')
    assert.deepEqual(r1, { kind: 'id', id: '12345678-0001' })

    // -i=1234
    const r2 = resolveSessionRef(tempDir, '-i=1234')
    assert.deepEqual(r2, { kind: 'id', id: '12345678-0001' })

    // 缺少 ID 值
    assert.deepEqual(resolveSessionRef(tempDir, '--id'), { kind: 'not_found', ref: '' })

    // 未找到
    assert.deepEqual(resolveSessionRef(tempDir, '--id 9999'), { kind: 'not_found', ref: '9999' })
  })

  it('纯数字在无 --id 时保持 1-based 序号语义', async () => {
    await seed('aaaa-0001', 'First', 1000)
    await seed('bbbb-0002', 'Second', 2000)

    // 序号 1 对应最新 (bbbb-0002)
    assert.deepEqual(resolveSessionRef(tempDir, '1'), { kind: 'index', id: 'bbbb-0002' })
    // 序号 2 对应较早 (aaaa-0001)
    assert.deepEqual(resolveSessionRef(tempDir, '2'), { kind: 'index', id: 'aaaa-0001' })

    // 越界
    assert.deepEqual(resolveSessionRef(tempDir, '0'), { kind: 'out_of_range', total: 2, index: 0 })
    assert.deepEqual(resolveSessionRef(tempDir, '3'), { kind: 'out_of_range', total: 2, index: 3 })
  })

  it('精确 ID 优先于同名标题匹配', async () => {
    // 某会话 ID 恰好与另一会话标题重名
    await seed('session-exact-id', 'Different Title')
    await seed('other-id-0002', 'session-exact-id')

    // 精确 ID 匹配胜出
    const r = resolveSessionRef(tempDir, 'session-exact-id')
    assert.deepEqual(r, { kind: 'id', id: 'session-exact-id' })
  })

  it('多词标题与引号支持', async () => {
    await seed('aaaa-1111', 'Fix parser bug for TUI')
    await seed('bbbb-2222', 'Feature User Auth')

    // 完整多词匹配
    const r1 = resolveSessionRef(tempDir, 'Fix parser bug for TUI')
    assert.deepEqual(r1, { kind: 'title', id: 'aaaa-1111' })

    // 不区分大小写
    const r2 = resolveSessionRef(tempDir, 'fix parser bug for tui')
    assert.deepEqual(r2, { kind: 'title', id: 'aaaa-1111' })

    // 带引号
    const r3 = resolveSessionRef(tempDir, '"Feature User Auth"')
    assert.deepEqual(r3, { kind: 'title', id: 'bbbb-2222' })
  })

  it('同名标题非唯一匹配时拒绝并返回候选', async () => {
    await seed('dup-0001', 'Duplicate Name', 1000)
    await seed('dup-0002', 'Duplicate Name', 2000)

    const r = resolveSessionRef(tempDir, 'Duplicate Name')
    assert.equal(r.kind, 'ambiguous_title')
    if (r.kind === 'ambiguous_title') {
      assert.equal(r.title, 'Duplicate Name')
      assert.equal(r.candidates.length, 2)
      assert.ok(r.candidates.some(c => c.id === 'dup-0001'))
      assert.ok(r.candidates.some(c => c.id === 'dup-0002'))
    }
  })

  it('ID 前缀回退与歧义', async () => {
    await seed('prefix111-0001', 'Task A')
    await seed('prefix222-0002', 'Task B')

    // 唯一前缀
    assert.deepEqual(resolveSessionRef(tempDir, 'prefix111'), { kind: 'id', id: 'prefix111-0001' })

    // 歧义前缀
    const amb = resolveSessionRef(tempDir, 'prefix')
    assert.equal(amb.kind, 'ambiguous_id')
    if (amb.kind === 'ambiguous_id') {
      assert.equal(amb.candidates.length, 2)
    }

    // 未知输入
    assert.deepEqual(resolveSessionRef(tempDir, 'unknown'), { kind: 'not_found', ref: 'unknown' })
  })

  it('formatSessionRefMessage 格式化各分支文案', () => {
    assert.ok(formatSessionRefMessage({ kind: 'empty' })?.includes('用法: /resume'))
    assert.ok(formatSessionRefMessage({ kind: 'out_of_range', total: 3, index: 5 })?.includes('序号超出范围'))
    assert.ok(formatSessionRefMessage({ kind: 'ambiguous_id', prefix: 'pre', candidates: ['id1', 'id2'] })?.includes('匹配多个会话'))
    assert.ok(formatSessionRefMessage({ kind: 'ambiguous_title', title: 't', candidates: [{ id: 'id1', title: 't' }] })?.includes('匹配多个会话'))
    assert.ok(formatSessionRefMessage({ kind: 'not_found', ref: 'xyz' })?.includes('未找到匹配会话'))
    assert.ok(formatSessionRefMessage({ kind: 'not_found', ref: '' })?.includes('用法: /resume --id'))
    assert.equal(formatSessionRefMessage({ kind: 'id', id: 'some-id' }), null)
  })
})
