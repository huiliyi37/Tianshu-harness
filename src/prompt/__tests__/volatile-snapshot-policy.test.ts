import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVolatileSnapshot } from '../volatile-snapshot.js'
import { buildStableVolatileBlock, buildDynamicAppendixParts, type VolatileContext } from '../volatile.js'
import { standardPromptBlocks, invalidatePromptBlocks, type PromptBlockPolicy } from '../block-policy.js'
import { clearCapsuleCache } from '../../agent/seed-capsule-store.js'

// 信任门（2026-10-09）：胶囊素材写在临时 cwd 的 docs/ 下，需项目已授信才加载
// （与 seed-capsule-store 测试同惯例）。
process.env.RIVET_TRUST_PROJECT = '1'

function leanPolicy(): PromptBlockPolicy {
  const base = standardPromptBlocks()
  return {
    ...base,
    profile: 'lean',
    blocks: { ...base.blocks, historicalLessons: false },
    caps: { ...base.caps, projectMemory: 200, knowledgeManifest: 200, codebaseIndex: 200 },
    capsuleIndexLimit: 2,
  }
}

describe('createVolatileSnapshot consumes the block policy', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-policy-'))
    clearCapsuleCache()
    invalidatePromptBlocks()
    const docs = join(dir, 'docs')
    mkdirSync(docs)
    for (const [i, star] of ['甲', '乙', '丙', '丁'].entries()) {
      writeFileSync(join(docs, `seed-capsule-${i}.md`), [
        // gist 取真实量级（仓库内 40-80 字符），否则截断省不下字节、不触发瘦身
        `<seed-capsule star="${star}" sealed="2026-01-0${i + 1}" gist="${star}${'之道'.repeat(30)}">`,
        '  正文',
        '</seed-capsule>',
      ].join('\n'))
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    clearCapsuleCache()
    invalidatePromptBlocks()
  })

  it('defaults to standard when no policy is supplied', () => {
    // 无 policy 的调用方（worker / 测试 / 早期 sidecar）必须拿到历史行为。
    const implicit = createVolatileSnapshot({ cwd: dir })
    const explicit = createVolatileSnapshot({ cwd: dir, blockPolicy: standardPromptBlocks() })
    assert.equal(buildStableVolatileBlock(implicit), buildStableVolatileBlock(explicit))
  })

  it('caps ride along on the snapshot so the renderer can honor them', () => {
    const snap = createVolatileSnapshot({ cwd: dir, blockPolicy: leanPolicy() })
    assert.equal(snap.blockCaps?.projectMemory, 200)
    assert.equal(snap.blockToggles?.historicalLessons, false)
  })

  it('truncates the capsule index under lean', () => {
    const std = createVolatileSnapshot({ cwd: dir })
    const lean = createVolatileSnapshot({ cwd: dir, blockPolicy: leanPolicy() })
    assert.ok(std.seedCapsuleBlock!.length > lean.seedCapsuleBlock!.length)
    assert.ok(lean.seedCapsuleBlock!.includes('其余 2 位'))
    assert.ok(lean.seedCapsuleBlock!.includes('丁'), 'omitted stars stay discoverable')
  })

  it('skips a block entirely when its toggle is off', () => {
    const base = standardPromptBlocks()
    const snap = createVolatileSnapshot({
      cwd: dir,
      blockPolicy: { ...base, blocks: { ...base.blocks, seedCapsule: false } },
    })
    assert.equal(snap.seedCapsuleBlock, undefined)
  })

  it('never drops content the caller passed explicitly', () => {
    // 档位管「自动加载什么」，无权丢弃调用方明确要求注入的内容。
    const base = standardPromptBlocks()
    const snap = createVolatileSnapshot({
      cwd: dir,
      projectMemoryBlock: '<project-memory>caller supplied</project-memory>',
      blockPolicy: { ...base, blocks: { ...base.blocks, projectMemory: false } },
    })
    assert.match(snap.projectMemoryBlock!, /caller supplied/)
  })

  it('applies the lean cap to the rendered frozen block', () => {
    const long = `<project-memory>${'长'.repeat(2_000)}</project-memory>`
    const base = standardPromptBlocks()
    const std = buildStableVolatileBlock({ cwd: dir, projectMemoryBlock: long } as VolatileContext)
    const lean = buildStableVolatileBlock({
      cwd: dir,
      projectMemoryBlock: long,
      blockCaps: { ...base.caps, projectMemory: 200 },
    } as VolatileContext)
    assert.ok(lean.length < std.length, 'lean cap must actually shorten the rendered block')
  })
})

describe('historical-lessons gating', () => {
  const lessons = [{ id: 'l1', lesson: '教训', context: '上下文' }] as VolatileContext['playbookLessons']

  function render(toggles?: VolatileContext['blockToggles']): string {
    const ctx = { cwd: '/tmp', playbookLessons: lessons, blockToggles: toggles } as VolatileContext
    return buildDynamicAppendixParts(ctx).map(p => p.content).join('\n')
  }

  it('renders by default', () => {
    assert.match(render(), /<historical-lessons>/)
  })

  it('renders when the toggle is explicitly on', () => {
    assert.match(render({ historicalLessons: true }), /<historical-lessons>/)
  })

  it('is dropped when the toggle is off', () => {
    assert.doesNotMatch(render({ historicalLessons: false }), /<historical-lessons>/)
  })

  it('is unaffected by unrelated toggles', () => {
    assert.match(render({ seedCapsule: false }), /<historical-lessons>/)
  })
})
