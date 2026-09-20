import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildVolatileBlock } from '../volatile.js'
import { createGitStatusCache } from '../volatile-git.js'
import { trustProject, untrustProject } from '../../config/project-trust.js'

describe('volatile local caches', () => {
  it('does not share .rivet.md content across cwd values', () => {
    // #218 信任门：未受信目录的项目指令不读不注入。本用例关注「缓存按 cwd 隔离」，
    // 故先把两个 cwd 标记为受信（trust store 隔离到临时 RIVET_HOME），
    // 使信任门不掩盖缓存隔离语义；断言语义不变。
    const prevHome = process.env.RIVET_HOME
    const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
    process.env.RIVET_HOME = home
    const a = mkdtempSync(join(tmpdir(), 'rivet-cwd-a-'))
    const b = mkdtempSync(join(tmpdir(), 'rivet-cwd-b-'))
    writeFileSync(join(a, '.rivet.md'), 'Project A rules', 'utf-8')
    writeFileSync(join(b, '.rivet.md'), 'Project B rules', 'utf-8')
    trustProject(a)
    trustProject(b)
    try {
      const blockA = buildVolatileBlock({ cwd: a })
      const blockB = buildVolatileBlock({ cwd: b })
      assert.ok(blockA.includes('Project A rules'))
      assert.ok(!blockA.includes('Project B rules'))
      assert.ok(blockB.includes('Project B rules'))
      assert.ok(!blockB.includes('Project A rules'))
    } finally {
      untrustProject(a)
      untrustProject(b)
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      if (prevHome === undefined) delete process.env.RIVET_HOME
      else process.env.RIVET_HOME = prevHome
    }
  })

  it('stores git status cache values per cwd', () => {
    const cache = createGitStatusCache({
      ttlMs: 60_000,
      now: () => 100,
      load: async () => undefined,
    })
    cache.prime('/repo/a', 'Current branch: a\nStatus:\n(clean)')
    cache.prime('/repo/b', 'Current branch: b\nStatus:\n M file.ts')
    assert.equal(cache.get('/repo/a'), 'Current branch: a\nStatus:\n(clean)')
    assert.equal(cache.get('/repo/b'), 'Current branch: b\nStatus:\n M file.ts')
  })

  it('does not leak stale value to different cwd', () => {
    const cache = createGitStatusCache({
      ttlMs: 60_000,
      now: () => 100,
      load: async () => undefined,
    })
    cache.prime('/repo/a', 'status-a')
    assert.equal(cache.get('/repo/a'), 'status-a')
    // /repo/b should not see /repo/a's value
    assert.equal(cache.get('/repo/b'), undefined)
  })
})
