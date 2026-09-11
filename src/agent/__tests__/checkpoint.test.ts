import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { rivetHome } from '../../config/paths.js'
import {
  createCheckpoint,
  getRollbackPreview,
  rollbackToCheckpoint,
  listCheckpoints,
  recordAgentTouchedFile,
  recordBashSideEffects,
  makeOwnershipGuard,
  pruneOrphanCheckpoints,
  type ClaimLookup,
} from '../checkpoint.js'

function makeTempGitRepo(): string {
  const repo = join(tmpdir(), `rivet-ck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(repo, { recursive: true })
  execSync('git init', { cwd: repo })
  execSync('git config user.email "test@test.com"', { cwd: repo })
  execSync('git config user.name "Test"', { cwd: repo })
  writeFileSync(join(repo, 'initial.txt'), 'hello')
  execSync('git add .', { cwd: repo })
  execSync('git commit -m "initial"', { cwd: repo })
  return repo
}

function cleanupRepo(repo: string): void {
  if (existsSync(repo)) rmSync(repo, { recursive: true, force: true })
}

describe('checkpoint module', () => {
  describe('pruneOrphanCheckpoints', () => {
    it('不可读（瞬态错误/损坏）的 checkpoint 保留不删——2026-09-11 F3 修复', () => {
      const rivetDir = rivetHome()
      mkdirSync(rivetDir, { recursive: true })
      const tag = `prunekeep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const garbage = join(rivetDir, `checkpoint-${tag}.json`)
      // 模拟瞬态读取失败/半写：内容不是合法 JSON（修复前：解析失败→当孤儿→删除）
      writeFileSync(garbage, '{ truncated not json')
      try {
        pruneOrphanCheckpoints()
        assert.equal(existsSync(garbage), true,
          '读不了的 checkpoint 必须保留——Windows EBUSY/权限抖动不应不可逆删除回滚点')
      } finally {
        if (existsSync(garbage)) rmSync(garbage, { force: true })
      }
    })

    it('读取抛错（EACCES）的 checkpoint 同样保留（unix）', () => {
      if (process.platform === 'win32') return
      const rivetDir = rivetHome()
      mkdirSync(rivetDir, { recursive: true })
      const tag = `pruneperm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const locked = join(rivetDir, `checkpoint-${tag}.json`)
      const deadCwd = join(tmpdir(), `rivet-ck-gone-${Date.now()}`)
      writeFileSync(locked, JSON.stringify({ version: 2, hash: 'x', timestamp: Date.now(), label: 'auto', cwd: deadCwd, preExistingDirtyFiles: [], preExistingUntrackedFiles: [], agentTouchedFiles: [] }))
      chmodSync(locked, 0o000)
      try {
        pruneOrphanCheckpoints()
        assert.equal(existsSync(locked), true, '读取抛错必须保留（修复前按孤儿删除）')
      } finally {
        chmodSync(locked, 0o644)
        if (existsSync(locked)) rmSync(locked, { force: true })
      }
    })

    it('removes checkpoint files whose cwd no longer exists', () => {
      const rivetDir = rivetHome()
      mkdirSync(rivetDir, { recursive: true })
      const deadCwd = join(tmpdir(), `rivet-ck-gone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      // deadCwd is never created → orphan.
      const tag = `prunetest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const orphan = join(rivetDir, `checkpoint-${tag}.json`)
      writeFileSync(orphan, JSON.stringify({ version: 2, hash: 'x', timestamp: Date.now(), label: 'auto', cwd: deadCwd, preExistingDirtyFiles: [], preExistingUntrackedFiles: [], agentTouchedFiles: [] }))
      assert.ok(existsSync(orphan))

      const removed = pruneOrphanCheckpoints()
      assert.ok(removed >= 1, 'should remove at least the orphan we planted')
      assert.equal(existsSync(orphan), false, 'orphan checkpoint must be deleted')
    })

    it('keeps checkpoints whose cwd still exists', () => {
      const repo = makeTempGitRepo()
      try {
        const rivetDir = rivetHome()
        const tag = `prunekeep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const live = join(rivetDir, `checkpoint-${tag}.json`)
        writeFileSync(live, JSON.stringify({ version: 2, hash: 'x', timestamp: Date.now(), label: 'auto', cwd: repo, preExistingDirtyFiles: [], preExistingUntrackedFiles: [], agentTouchedFiles: [] }))
        pruneOrphanCheckpoints()
        assert.ok(existsSync(live), 'checkpoint with a live cwd must survive')
        rmSync(live, { force: true })
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('recordBashSideEffects (B2: full rollback of shell side effects)', () => {
    it('captures bash create/modify/delete and rolls them back, leaving pre-existing files alone', async () => {
      const repo = makeTempGitRepo()
      const sid = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      try {
        await createCheckpoint(repo, 'auto', sid)
        // Simulate bash side effects: create a new file, modify the tracked one.
        writeFileSync(join(repo, 'created-by-bash.txt'), 'new')
        writeFileSync(join(repo, 'initial.txt'), 'MUTATED')

        const recorded = await recordBashSideEffects(repo, sid)
        assert.ok(recorded.includes('created-by-bash.txt'), 'new file captured')
        assert.ok(recorded.includes('initial.txt'), 'modified tracked file captured')

        const preview = await getRollbackPreview(repo, sid)
        assert.ok(preview, 'preview should exist')
        const result = await rollbackToCheckpoint(repo, preview!.confirmationToken, sid)
        assert.equal(result.success, true)

        // Created file deleted, tracked file restored to committed content.
        assert.equal(existsSync(join(repo, 'created-by-bash.txt')), false, 'bash-created file removed')
        assert.equal(readFileSync(join(repo, 'initial.txt'), 'utf-8'), 'hello', 'tracked file restored')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('PARALLEL SAFETY: never rolls back a path owned by another live session', async () => {
      const repo = makeTempGitRepo()
      const sidA = `A-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const sidB = `B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      try {
        await createCheckpoint(repo, 'auto', sidA)

        // Session A's bash touches two files: its own + one that B owns.
        writeFileSync(join(repo, 'a-owned.txt'), 'A change')
        writeFileSync(join(repo, 'b-owned.txt'), 'A clobbered B!')

        // Registry stub: B holds an exclusive claim on b-owned.txt.
        const registry: ClaimLookup = {
          reapStaleClaims: () => [],
          checkClaim: (filePath: string) =>
            filePath.endsWith('b-owned.txt')
              ? { sessionId: sidB, claimType: 'exclusive' }
              : null,
        }
        const guard = makeOwnershipGuard(registry, sidA, repo)

        // Capture must NOT attribute b-owned.txt to session A.
        const recorded = await recordBashSideEffects(repo, sidA, guard)
        assert.ok(recorded.includes('a-owned.txt'))
        assert.ok(!recorded.includes('b-owned.txt'), 'must not claim B-owned file')

        // Even if a-owned set somehow contained it, rollback guard must skip it.
        recordAgentTouchedFile(repo, 'b-owned.txt', sidA)
        const preview = await getRollbackPreview(repo, sidA, guard)
        assert.ok(preview)
        const result = await rollbackToCheckpoint(repo, preview!.confirmationToken, sidA, guard)
        assert.equal(result.success, true)
        assert.ok((result.skipped ?? []).includes('b-owned.txt'), 'B-owned path reported as skipped')

        // B's change is intact; A's own change reverted.
        assert.equal(readFileSync(join(repo, 'b-owned.txt'), 'utf-8'), 'A clobbered B!', 'B-owned file untouched by A rollback')
        assert.equal(existsSync(join(repo, 'a-owned.txt')), false, 'A own file reverted')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('records irreversible bash effects (curl POST) and surfaces them as unrevertable', async () => {
      const repo = makeTempGitRepo()
      const sid = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      try {
        await createCheckpoint(repo, 'auto', sid)
        // A command that mutates remote state but touches NO files on disk.
        const recorded = await recordBashSideEffects(repo, sid, undefined, 'curl -X POST https://api.example.com/charge')
        assert.deepEqual(recorded, [], 'no files changed on disk')

        // Preview must still appear and carry the unrevertable caveat.
        const preview = await getRollbackPreview(repo, sid)
        assert.ok(preview, 'preview surfaces even with zero revertable files')
        assert.match(preview!.text, /CANNOT be reverted/i)
        assert.match(preview!.text, /network mutation/i)

        const result = await rollbackToCheckpoint(repo, preview!.confirmationToken, sid)
        assert.ok(result.unrevertable && result.unrevertable.length > 0, 'rollback result carries unrevertable caveats')
        assert.match(result.unrevertable![0]!, /network mutation/i)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('combines file restore with unrevertable caveat when a command does both', async () => {
      const repo = makeTempGitRepo()
      const sid = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      try {
        await createCheckpoint(repo, 'auto', sid)
        writeFileSync(join(repo, 'log.txt'), 'wrote a log then published')
        // Command both wrote a file and published a package.
        const recorded = await recordBashSideEffects(repo, sid, undefined, 'npm publish > log.txt')
        assert.ok(recorded.includes('log.txt'), 'file change captured')

        const preview = await getRollbackPreview(repo, sid)
        assert.ok(preview)
        assert.match(preview!.text, /- log\.txt/)
        assert.match(preview!.text, /publish/i)

        const result = await rollbackToCheckpoint(repo, preview!.confirmationToken, sid)
        assert.equal(result.success, true, 'file portion reverted')
        assert.ok((result.unrevertable ?? []).some(e => /publish/i.test(e)), 'publish caveat surfaced')
        assert.equal(existsSync(join(repo, 'log.txt')), false, 'bash-created file removed')
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('createCheckpoint', () => {
    it('returns a valid Checkpoint with hash and timestamp in a git repo', async () => {
      const repo = makeTempGitRepo()
      try {
        const before = Date.now()
        const cp = await createCheckpoint(repo, 'auto')
        const after = Date.now()

        assert.ok(cp)
        assert.match(cp.hash, /^[0-9a-f]{40}$/)
        assert.equal(cp.message, 'auto')
        assert.ok(cp.timestamp >= before && cp.timestamp <= after)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns null in a non-git directory', async () => {
      const nonGitDir = join(tmpdir(), `rivet-nogit-${Date.now()}`)
      mkdirSync(nonGitDir, { recursive: true })
      try {
        const cp = await createCheckpoint(nonGitDir, 'auto')
        assert.equal(cp, null)
      } finally {
        cleanupRepo(nonGitDir)
      }
    })

    it('defaults label to "checkpoint"', async () => {
      const repo = makeTempGitRepo()
      try {
        const cp = await createCheckpoint(repo)
        assert.ok(cp)
        assert.equal(cp.message, 'checkpoint')
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('getRollbackPreview', () => {
    it('returns null when no checkpoint exists', async () => {
      const repo = makeTempGitRepo()
      try {
        const preview = await getRollbackPreview(repo)
        assert.equal(preview, null)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns null when no agent-owned changes', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        const preview = await getRollbackPreview(repo)
        assert.equal(preview, null)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns preview with confirmation token for agent files', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        recordAgentTouchedFile(repo, 'agent-created.txt')
        writeFileSync(join(repo, 'agent-created.txt'), 'agent work')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview)
        assert.ok(preview.confirmationToken)
        assert.ok(preview.text.includes('agent-created.txt'))
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('rollbackToCheckpoint', () => {
    it('returns { success: false } when no checkpoint exists', async () => {
      const repo = makeTempGitRepo()
      try {
        const result = await rollbackToCheckpoint(repo)
        assert.equal(result.success, false)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('requires confirmation token for rollback', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        recordAgentTouchedFile(repo, 'agent-created.txt')
        writeFileSync(join(repo, 'agent-created.txt'), 'agent work')
        const result = await rollbackToCheckpoint(repo)
        assert.equal(result.success, false)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('does not remove pre-existing unstaged changes during rollback', async () => {
      const repo = makeTempGitRepo()
      try {
        writeFileSync(join(repo, 'user-work.txt'), 'user work before agent')
        const cp = await createCheckpoint(repo, 'auto')
        assert.ok(cp)

        recordAgentTouchedFile(repo, 'agent-created.txt')
        writeFileSync(join(repo, 'agent-created.txt'), 'agent work')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview)
        const result = await rollbackToCheckpoint(repo, preview.confirmationToken)

        assert.equal(result.success, true)
        assert.ok(existsSync(join(repo, 'user-work.txt')))
        assert.ok(!existsSync(join(repo, 'agent-created.txt')))
      } finally {
        cleanupRepo(repo)
      }
    })

    it('restores tracked files to checkpoint state', async () => {
      const repo = makeTempGitRepo()
      try {
        writeFileSync(join(repo, 'tracked.txt'), 'original')
        execSync('git add tracked.txt', { cwd: repo })
        execSync('git commit -m "add tracked"', { cwd: repo })

        const cp = await createCheckpoint(repo, 'auto')
        assert.ok(cp)

        recordAgentTouchedFile(repo, 'tracked.txt')
        writeFileSync(join(repo, 'tracked.txt'), 'modified by agent')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview)
        const result = await rollbackToCheckpoint(repo, preview.confirmationToken)

        assert.equal(result.success, true)
        assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf-8'), 'original')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('rejects wrong confirmation token', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        recordAgentTouchedFile(repo, 'agent-file.txt')
        writeFileSync(join(repo, 'agent-file.txt'), 'data')

        const result = await rollbackToCheckpoint(repo, 'wrong-token')
        assert.equal(result.success, false)
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('listCheckpoints', () => {
    it('returns empty array when no checkpoint exists', () => {
      const repo = makeTempGitRepo()
      try {
        assert.deepEqual(listCheckpoints(repo), [])
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns single checkpoint after createCheckpoint', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'manual')
        const list = listCheckpoints(repo)
        assert.equal(list.length, 1)
        assert.equal(list[0]!.message, 'manual')
        assert.match(list[0]!.hash, /^[0-9a-f]{7}$/)
        assert.ok(list[0]!.timestamp > 0)
      } finally {
        cleanupRepo(repo)
      }
    })
  })
})
