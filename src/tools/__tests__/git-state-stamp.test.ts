/**
 * Git 状态戳（2026-10-21 sidecar 卡死修复）：
 * - 同一状态重复取戳不变（缓存才命中）；
 * - 提交 / git add / 切分支 / 链接工作树内的改动都会改变戳（缓存不会给出旧结果）；
 * - 非仓库返回 null（调用方退回真实 git 调用）；
 * - 交付指纹与变更率在状态不变时不再起 git 子进程，状态一变立即重算。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitStateStamp, resetGitStateStampCache } from '../git-state-stamp.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-stamp-'))
  git(cwd, 'init', '-q', '-b', 'main')
  writeFileSync(join(cwd, 'a.txt'), 'a')
  git(cwd, 'add', 'a.txt'); git(cwd, 'commit', '-qm', 'init')
  return cwd
}

describe('gitStateStamp', () => {
  beforeEach(() => resetGitStateStampCache())

  it('状态不变时戳稳定', () => {
    const cwd = repo()
    assert.ok(gitStateStamp(cwd))
    assert.equal(gitStateStamp(cwd), gitStateStamp(cwd))
  })

  it('git add / commit / 切分支都会改变戳', async () => {
    const cwd = repo()
    const s0 = gitStateStamp(cwd)
    await sleep(20)
    writeFileSync(join(cwd, 'b.txt'), 'b'); git(cwd, 'add', 'b.txt')
    const s1 = gitStateStamp(cwd)
    assert.notEqual(s1, s0, 'index 变化')
    await sleep(20)
    git(cwd, 'commit', '-qm', 'b')
    const s2 = gitStateStamp(cwd)
    assert.notEqual(s2, s1, 'HEAD 指向的 ref 变化')
    git(cwd, 'checkout', '-qb', 'feat')
    assert.notEqual(gitStateStamp(cwd), s2, '切分支改写 HEAD')
  })

  it('子目录与链接工作树都能定位 gitdir', async () => {
    const cwd = repo()
    const wt = join(mkdtempSync(join(tmpdir(), 'rivet-stamp-wt-')), 'wt')
    git(cwd, 'worktree', 'add', '-q', wt, '-b', 'side')
    const s0 = gitStateStamp(wt)
    assert.ok(s0)
    await sleep(20)
    writeFileSync(join(wt, 'c.txt'), 'c'); git(wt, 'add', 'c.txt')
    assert.notEqual(gitStateStamp(wt), s0, '链接工作树自己的 index')
  })

  it('非仓库返回 null', () => {
    assert.equal(gitStateStamp(mkdtempSync(join(tmpdir(), 'rivet-stamp-none-'))), null)
  })
})

// 计数式探针：包住真实 spawn / spawnSync，数被调用多少次（行为照常执行）。
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { getGitChangeRate } from '../../agent/git-freshness.js'
import { createPersistentTaskState } from '../../agent/task-state-persist.js'

function countSpawns(t: import('node:test').TestContext) {
  const counts = { spawn: 0, spawnSync: 0 }
  const realSpawn = childProcess.spawn, realSync = childProcess.spawnSync
  t.mock.method(childProcess, 'spawn', (...a: Parameters<typeof realSpawn>) => { counts.spawn++; return realSpawn(...a) })
  t.mock.method(childProcess, 'spawnSync', (...a: Parameters<typeof realSync>) => { counts.spawnSync++; return realSync(...a) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return counts
}

describe('状态不变时不再起 git 子进程', () => {
  it('变更率：第二次命中缓存；提交后重算', async t => {
    const cwd = repo()
    writeFileSync(join(cwd, 'a.txt'), 'a2'); git(cwd, 'commit', '-qam', 'two')
    const counts = countSpawns(t)
    // 探针在负载下可能 400ms 超时被杀，被污染的结果按设计不进缓存（下次照常重算），
    // 所以先取到一次干净结果再断言零 spawn；有界重试，缓存真失效时仍判红。
    let r1 = await getGitChangeRate(cwd)
    assert.ok(counts.spawn > 0)
    let after1 = counts.spawn
    for (let i = 0; i < 4; i++) {
      const r = await getGitChangeRate(cwd)
      if (counts.spawn === after1) break
      r1 = r; after1 = counts.spawn
    }
    assert.equal(await getGitChangeRate(cwd), r1)
    assert.equal(counts.spawn, after1, '状态未变：零 spawn')
    await sleep(20)
    writeFileSync(join(cwd, 'z.txt'), 'z'); git(cwd, 'add', 'z.txt'); git(cwd, 'commit', '-qm', 'three')
    await getGitChangeRate(cwd)
    assert.ok(counts.spawn > after1, '提交后重算')
  })

  it('交付指纹：重复取指纹不重复 spawn git；git add 后重算且旧验证失效', async t => {
    process.env.RIVET_HOME ??= mkdtempSync(join(tmpdir(), 'rivet-stamp-home-'))
    const cwd = repo()
    const baseline = { branch: 'main', head: git(cwd, 'rev-parse', 'HEAD'), preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
    const state = createPersistentTaskState(cwd, `stamp-${Date.now()}`, baseline)
    const counts = countSpawns(t)
    const f1 = state.taskLedger.captureVerificationFingerprint!(false)
    const n1 = counts.spawnSync
    assert.equal(state.taskLedger.captureVerificationFingerprint!(false), f1)
    assert.equal(counts.spawnSync, n1, '状态未变：零 spawnSync')
    await sleep(20)
    writeFileSync(join(cwd, 'n.txt'), 'n'); git(cwd, 'add', 'n.txt')
    assert.notEqual(state.taskLedger.captureVerificationFingerprint!(false), f1, 'index 变化 → 指纹变化')
  })
})
