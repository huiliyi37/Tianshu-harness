import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextClaimStore } from '../../context/claim-store.js'
import type { EmbeddingProvider } from '../../search/embedding-provider.js'
import { createMemoryTool } from '../../tools/memory.js'
import { appendMemoryEntry } from '../unified-memory.js'
import { resetKnowledgeIndexCache } from '../knowledge-index.js'

// issue #416：未授信项目下 recall 因「跳过索引」返回空 —— 该空结果此前与
// 「库中确实无匹配记忆」不可区分，调用方无从得知需要 /trust。本文件锁定：
//   ① 未授信 + 库中其实有匹配 → 提示为「未授信未检索」而非裸「未找到」；
//   ② 授信 + 有匹配 → 正常命中（回归，行为不变）；
//   ③ 授信 + 无匹配 → 仍为裸「未找到」（不误报未授信）。
// node:test 文件级进程隔离；文件内逐用例切换 RIVET_TRUST_PROJECT。

const disabledEmbedder: EmbeddingProvider = {
  id: 'disabled', isAvailable: () => false, embed: async () => [],
}

const roots: string[] = []

afterEach(() => {
  resetKnowledgeIndexCache()
  delete process.env.RIVET_TRUST_PROJECT
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function recall(cwd: string, query: string) {
  const tool = createMemoryTool({} as ContextClaimStore, {
    sessionId: 'test-session', getTurn: () => 1, cwd, embeddingProvider: disabledEmbedder,
  })
  return tool.execute({ input: { action: 'recall', query }, toolUseId: 'tool-1', cwd })
}

describe('memory recall — 未授信项目提示（issue #416）', () => {
  it('未授信时给出可操作的未检索提示，而非裸「未找到」', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-recall-untrusted-'))
    roots.push(cwd)

    // 授信状态下写入一条真实记忆，确保库中确有内容。
    process.env.RIVET_TRUST_PROJECT = '1'
    appendMemoryEntry(cwd, {
      text: 'OrcaKit 使用前缀缓存降低长会话成本。',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [],
    })
    resetKnowledgeIndexCache()

    // 切到未授信：索引被门跳过，同一查询命中为空。
    process.env.RIVET_TRUST_PROJECT = '0'
    const result = await recall(cwd, 'OrcaKit')

    assert.equal(result.isError, undefined)
    assert.match(result.content, /未授信/, '未授信空结果须点明未授信')
    assert.match(result.content, /\/trust/, '须给出 /trust 可操作指引')
    assert.doesNotMatch(result.content, /未找到与/, '不得再返回与「确实无匹配」不可区分的裸提示')
    assert.doesNotMatch(result.content, /知识条目/, '未授信不得有命中')
  })

  it('授信时同一查询正常命中（回归：真实命中行为不变）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-recall-trusted-'))
    roots.push(cwd)

    process.env.RIVET_TRUST_PROJECT = '1'
    appendMemoryEntry(cwd, {
      text: 'OrcaKit 使用前缀缓存降低长会话成本。',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [],
    })
    resetKnowledgeIndexCache()

    const result = await recall(cwd, 'OrcaKit')

    assert.equal(result.isError, undefined)
    assert.match(result.content, /知识条目（1）/, '授信后应正常命中')
    assert.match(result.content, /OrcaKit/)
    assert.doesNotMatch(result.content, /未授信/, '有命中时不得出现未授信提示')
  })

  it('授信但确实无匹配时仍为裸「未找到」（不误报未授信）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-recall-trusted-miss-'))
    roots.push(cwd)

    process.env.RIVET_TRUST_PROJECT = '1'
    appendMemoryEntry(cwd, {
      text: 'OrcaKit 使用前缀缓存降低长会话成本。',
      kind: 'project_rule', confidence: 1, source: 'manual', status: 'verified', tags: [],
    })
    resetKnowledgeIndexCache()

    const result = await recall(cwd, 'zzz-no-such-topic-zzz')

    assert.equal(result.isError, undefined)
    assert.match(result.content, /未找到与「zzz-no-such-topic-zzz」相关的记忆。/)
    assert.doesNotMatch(result.content, /未授信/, '授信项目无匹配不得误报未授信')
  })
})
