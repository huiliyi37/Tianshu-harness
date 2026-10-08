import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { captureCommitVersion } from '../commit-version.js'
import { commitScopedFiles } from '../scoped-git-commit.js'

// 必须在系统 tmpdir + mkdtemp 唯一路径——曾用工作树内固定路径，并发会话的
// rmSync/init 竞态会让 `git config` 向上爬进主仓库，污染提交作者（详见
// git.test.ts 同款注释）。
let TMP: string

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: TMP, encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

describe('commitScopedFiles', () => {
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'rivet-scoped-commit-'))
    git(['init'])
    git(['config', 'user.email', 'test@test.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(TMP, '.gitignore'), '._*\n.DS_Store\n')
    writeFileSync(join(TMP, 'owned.txt'), 'base owned')
    writeFileSync(join(TMP, 'other.txt'), 'base other')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('rejects stale previews and mixed staged hunks without absorbing changes', () => {
    writeFileSync(join(TMP, 'owned.txt'), 'first edit')
    const version = captureCommitVersion(TMP, ['owned.txt'])!
    writeFileSync(join(TMP, 'owned.txt'), 'second edit')
    assert.equal(commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'stale', expectedVersion: version }).ok, false)
    assert.equal(git(['diff', '--cached', '--name-only']).trim(), '')
    git(['add', '--', 'owned.txt'])
    writeFileSync(join(TMP, 'owned.txt'), 'third edit')
    const before = git(['diff', '--cached'])
    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'mixed' })
    assert.equal(result.ok, false); assert.match(result.output, /partially staged/)
    assert.equal(git(['diff', '--cached']), before)
  })

  it('commits only scoped files and leaves external dirty files untouched', () => {
    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    writeFileSync(join(TMP, 'other.txt'), 'external change')
    writeFileSync(join(TMP, 'other-new.txt'), 'external untracked')

    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: scoped commit' })

    assert.equal(result.ok, true, result.output)
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['owned.txt'])
    const status = git(['status', '--porcelain'])
    assert.match(status, / M other\.txt/)
    assert.match(status, /\?\? other-new\.txt/)
  })

  it('commits scoped untracked files without staging unrelated untracked files', () => {
    writeFileSync(join(TMP, 'new-owned.txt'), 'owned new')
    writeFileSync(join(TMP, 'other-new.txt'), 'external untracked')

    const result = commitScopedFiles({ cwd: TMP, files: ['new-owned.txt'], message: 'fix: scoped new file' })

    assert.equal(result.ok, true, result.output)
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['new-owned.txt'])
    const status = git(['status', '--porcelain'])
    assert.match(status, /\?\? other-new\.txt/)
  })

  it('rejects an empty file list without creating a commit', () => {
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: [], message: 'fix: empty' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /No owned files/)
    assert.equal(after, before)
  })

  it('rejects paths outside cwd without creating a commit', () => {
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: ['../outside.txt'], message: 'fix: outside' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /No owned files/)
    assert.equal(after, before)
  })

  it('rejects a blank commit message without creating a commit', () => {
    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: '   ' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /Commit message is required/)
    assert.equal(after, before)
  })

  it('provides friendly error when owned files have no changes', () => {
    // Don't modify owned.txt - it's already committed and clean
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: no changes' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /No changes in owned files to commit/)
    assert.match(result.output, /owned\.txt/)
    assert.equal(after, before)
  })

  it('retries through transient index.lock contention and commits once the lock clears', { timeout: 30_000 }, () => {
    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    const lockPath = join(TMP, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    // The main thread blocks in sleepSync during backoff, so the lock must be
    // cleared by an external process — simulates the other git process exiting.
    const releaser = spawn(process.execPath, ['-e',
      "setTimeout(() => { try { require('node:fs').unlinkSync(process.argv[1]) } catch {} }, 2000)", lockPath],
    { stdio: 'ignore', detached: true })
    releaser.unref()

    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: retried through lock' })

    assert.equal(result.ok, true, `expected retry to recover, got: ${result.output}`)
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['owned.txt'])
  })

  it('returns the lock error after retry exhaustion without deleting the lock', { timeout: 30_000 }, () => {
    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    const lockPath = join(TMP, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    const before = git(['rev-parse', 'HEAD']).trim()

    const started = Date.now()
    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: lock persists' })
    const elapsed = Date.now() - started

    assert.equal(result.ok, false)
    assert.match(result.output, /index\.lock|Unable to create/i)
    // Backoff was actually applied (1s+2s+4s) rather than failing instantly.
    // Three retry slots are configured, but git may reject the lock at a
    // different stage depending on platform. Assert real backoff occurred
    // without depending on the full nominal 1s+2s+4s wall-clock budget.
    assert.ok(elapsed >= 3000, `expected backoff before exhaustion, got ${elapsed}ms`)
    // No commit landed and the lock was NOT deleted (a live process may hold it).
    assert.equal(git(['rev-parse', 'HEAD']).trim(), before)
    assert.equal(existsSync(lockPath), true)
  })

  it('commits deletions of tracked files whose worktree copy is gone (D status)', () => {
    // Anchor: git add -- <path> stages deletions — the D-status path must keep working.
    rmSync(join(TMP, 'owned.txt'))
    const before = git(['rev-parse', 'HEAD']).trim()

    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: remove owned' })

    assert.equal(result.ok, true, `expected deletion commit, got: ${result.output}`)
    assert.notEqual(git(['rev-parse', 'HEAD']).trim(), before)
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['owned.txt'])
    assert.equal(existsSync(join(TMP, 'owned.txt')), false)
  })

  it('skips stale owned paths (deleted and committed externally) and reports them', () => {
    // owned.txt is removed from both worktree and index by an external commit —
    // the owned set is stale. other.txt carries this session's change.
    git(['rm', 'owned.txt'])
    git(['commit', '-m', 'external removal'])
    writeFileSync(join(TMP, 'other.txt'), 'owned change')

    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt', 'other.txt'], message: 'fix: skip stale' })

    assert.equal(result.ok, true, `stale path must not abort the commit, got: ${result.output}`)
    assert.match(result.output, /owned\.txt/, 'stale path must be reported in the output')
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['other.txt'])
    const status = git(['status', '--porcelain'])
    assert.equal(status, '', 'worktree must be clean after the scoped commit')
  })

  it('returns an actionable message when every owned path is stale', () => {
    git(['rm', 'owned.txt'])
    git(['commit', '-m', 'external removal'])
    const before = git(['rev-parse', 'HEAD']).trim()

    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: all stale' })

    assert.equal(result.ok, false)
    assert.doesNotMatch(result.output, /did not match any files/, 'raw pathspec error must be replaced by an actionable message')
    assert.match(result.output, /stale/i)
    assert.match(result.output, /owned\.txt/)
    assert.equal(git(['rev-parse', 'HEAD']).trim(), before)
  })
})
