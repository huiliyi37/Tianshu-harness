import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseWorktreeList, buildWorktreeArgs, getCurrentGitRef, createWorktree, cleanupStaleHandsBranches, removeWorktree, hasUnlandedWork, commitAll } from '../agent/worktree.js'

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initGitRepo(dir: string, branch = 'main'): void {
  git(dir, ['init', '-b', branch])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# test\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
}

describe('parseWorktreeList', () => {
  it('parses git worktree list output', () => {
    const output = `/Users/dev/project  abc1234 [main]\n/Users/dev/wt1  def5678 [feat-x]`
    const result = parseWorktreeList(output)
    assert.equal(result.length, 2)
    assert.deepEqual(result[0], { path: '/Users/dev/project', commit: 'abc1234', branch: 'main' })
    assert.deepEqual(result[1], { path: '/Users/dev/wt1', commit: 'def5678', branch: 'feat-x' })
  })

  it('parses porcelain output with paths containing spaces', () => {
    const output = `worktree /Users/dev/project with space\nHEAD abc1234\nbranch refs/heads/main\n\nworktree /Users/dev/wt1\nHEAD def5678\nbranch refs/heads/feat-x\n`
    const result = parseWorktreeList(output)
    assert.deepEqual(result, [
      { path: '/Users/dev/project with space', commit: 'abc1234', branch: 'main' },
      { path: '/Users/dev/wt1', commit: 'def5678', branch: 'feat-x' },
    ])
  })

  it('returns empty array for empty output', () => {
    assert.equal(parseWorktreeList('').length, 0)
  })

  it('handles detached HEAD', () => {
    const output = `/tmp/wt  1234567 [(HEAD detached at abc1234)]`
    const result = parseWorktreeList(output)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.branch, '(HEAD detached at abc1234)')
  })
})

describe('buildWorktreeArgs', () => {
  it('with branch', () => {
    assert.deepEqual(buildWorktreeArgs('/tmp/wt', 'session-abc'), ['worktree', 'add', '-b', 'session-abc', '/tmp/wt'])
  })

  it('detached', () => {
    assert.deepEqual(buildWorktreeArgs('/tmp/wt'), ['worktree', 'add', '--detach', '/tmp/wt'])
  })
})

describe('getCurrentGitRef', () => {
  let repo: string

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rivet-current-ref-'))
    initGitRepo(repo, 'feature-base')
  })

  after(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the current branch instead of assuming main', () => {
    assert.equal(getCurrentGitRef(repo), 'feature-base')
  })
})

describe('createWorktree failure cleanup (S1a)', () => {
  const _savedTmpdir = process.env.TMPDIR
  const _originalTmp = tmpdir()
  let _testTmp: string

  // Redirect TMPDIR to workspace — agent Seatbelt sandbox blocks writes to /var/folders T/.
  before(() => {
    _testTmp = mkdtempSync(join(process.cwd(), '.tmp-wt-s1a-'))
    process.env.TMPDIR = _testTmp
  })
  after(() => {
    if (_savedTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = _savedTmpdir
    rmSync(_testTmp, { recursive: true, force: true })
  })

  it('cleans up mkdtemp directory when git worktree add fails', () => {
    // Non-git directory → git worktree add will fail.
    // Put it outside the project so git cannot find a parent .git directory.
    const nonGit = mkdtempSync(join(_originalTmp, 'rivet-test-nongit-'))
    const sessionId = 'cleanup-t1' // slice(0,8) = 'cleanup-'
    const wtPrefix = 'rivet-wt-cleanup-'

    try {
      // Before: no rivet-wt-cleanup- dirs in tmpdir
      const before = readdirSync(tmpdir()).filter(n => n.startsWith(wtPrefix))
      assert.equal(before.length, 0)

      // Should throw because cwd is not a git repo
      assert.throws(
        () => createWorktree(nonGit, sessionId),
        /failed to create git worktree/,
      )

      // After: still no dirs — mkdtemp dir was cleaned up
      const after = readdirSync(tmpdir()).filter(n => n.startsWith(wtPrefix))
      assert.equal(after.length, 0, 'mkdtemp dir must be cleaned up after git worktree add failure')
    } finally {
      try { rmSync(nonGit, { recursive: true, force: true }) } catch {}
    }
  })
})

describe('createWorktree branch uniqueness (S1b)', () => {
  let repo: string
  let wt: { path: string; branch: string } | null = null

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rivet-branch-uniq-'))
    initGitRepo(repo, 'main')
  })

  after(() => {
    if (wt) {
      try { git(repo, ['worktree', 'remove', '--force', wt.path]) } catch {}
      try { git(repo, ['branch', '-D', wt.branch]) } catch {}
    }
    rmSync(repo, { recursive: true, force: true })
  })

  it('picks a unique branch when the base branch name already exists', () => {
    const sessionId = 'collide-1'
    const baseBranch = `rivet-hands-${sessionId}`
    git(repo, ['checkout', '-b', baseBranch])
    git(repo, ['checkout', 'main'])

    wt = createWorktree(repo, sessionId, baseBranch)
    assert.notEqual(wt.branch, baseBranch, 'must not reuse existing branch')
    assert.ok(wt.branch.startsWith(baseBranch), 'unique branch keeps base prefix')

    const list = git(repo, ['worktree', 'list', '--porcelain'])
    // git porcelain 输出统一正斜杠（Windows 亦然）；wt.path 是平台原生形态，
    // 比较前两侧归一，避免 Windows 上 includes 恒 false 的假红。
    assert.ok(
      list.replaceAll('\\', '/').includes(wt.path.replaceAll('\\', '/')),
      'worktree is registered',
    )
  })

  it('includes git stderr in the thrown error', () => {
    const badRepo = mkdtempSync(join(tmpdir(), 'rivet-bad-repo-'))
    try {
      assert.throws(
        () => createWorktree(badRepo, 'stderr-test'),
        /不是 git 仓库|not a git repository|failed to create git worktree/,
      )
    } finally {
      rmSync(badRepo, { recursive: true, force: true })
    }
  })
})

describe('cleanupStaleHandsBranches', () => {
  let repo: string

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rivet-stale-branch-'))
    initGitRepo(repo, 'main')
  })

  after(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes rivet-hands branches that are not attached to a worktree', () => {
    git(repo, ['checkout', '-b', 'rivet-hands-stale-1'])
    git(repo, ['checkout', 'main'])
    git(repo, ['checkout', '-b', 'rivet-hands-stale-2'])
    git(repo, ['checkout', 'main'])

    const removed = cleanupStaleHandsBranches(repo)
    removed.sort()
    assert.deepEqual(removed, ['rivet-hands-stale-1', 'rivet-hands-stale-2'])

    const remaining = git(repo, ['branch', '--list', 'rivet-hands-*']).trim()
    assert.equal(remaining, '')
  })

  it('keeps stale branches that carry unmerged commits (unlanded work)', () => {
    git(repo, ['checkout', '-b', 'rivet-hands-unmerged-1'])
    writeFileSync(join(repo, 'unlanded.txt'), 'work\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'unlanded work'])
    git(repo, ['checkout', 'main'])
    try {
      const removed = cleanupStaleHandsBranches(repo)
      assert.ok(!removed.includes('rivet-hands-unmerged-1'), 'branch with unmerged commits must survive cleanup')
      const remaining = git(repo, ['branch', '--list', 'rivet-hands-unmerged-1']).trim()
      assert.ok(remaining.includes('rivet-hands-unmerged-1'))
    } finally {
      git(repo, ['branch', '-D', 'rivet-hands-unmerged-1'])
    }
  })

  it('keeps branches that still belong to an active worktree', () => {
    const wt = createWorktree(repo, 'active-1', 'rivet-hands-active-1')
    try {
      // Create a stale branch alongside the active one
      git(repo, ['checkout', '-b', 'rivet-hands-stale-3'])
      git(repo, ['checkout', 'main'])

      const removed = cleanupStaleHandsBranches(repo)
      assert.deepEqual(removed, ['rivet-hands-stale-3'])

      const remaining = git(repo, ['branch', '--list', 'rivet-hands-*']).trim()
      assert.ok(remaining.includes('rivet-hands-active-1'), 'active branch preserved')
    } finally {
      git(repo, ['worktree', 'remove', '--force', wt.path])
      git(repo, ['branch', '-D', wt.branch])
    }
  })
})

describe('hasUnlandedWork / removeWorktree keepBranch / commitAll', () => {
  let repo: string

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rivet-unlanded-'))
    initGitRepo(repo, 'main')
  })

  after(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports clean worktree with no unmerged commits', () => {
    const wt = createWorktree(repo, 'clean-1')
    try {
      const work = hasUnlandedWork(repo, wt.path, wt.branch)
      assert.deepEqual(work, { dirty: false, unmergedCommits: 0 })
    } finally {
      removeWorktree(repo, wt.path, wt.branch)
    }
  })

  it('detects dirty tree and unmerged commits', () => {
    const wt = createWorktree(repo, 'dirty-1')
    try {
      writeFileSync(join(wt.path, 'committed.txt'), 'a\n')
      git(wt.path, ['add', '-A'])
      git(wt.path, ['commit', '-m', 'work'])
      writeFileSync(join(wt.path, 'uncommitted.txt'), 'b\n')

      const work = hasUnlandedWork(repo, wt.path, wt.branch)
      assert.equal(work.dirty, true)
      assert.equal(work.unmergedCommits, 1)
    } finally {
      removeWorktree(repo, wt.path, wt.branch)
    }
  })

  it('commitAll checkpoints a dirty tree; keepBranch preserves the branch', () => {
    const wt = createWorktree(repo, 'keep-1')
    writeFileSync(join(wt.path, 'wip.txt'), 'wip\n')

    const result = commitAll(wt.path, 'rivet: archive checkpoint', { noVerify: true })
    assert.equal(result.ok, true)
    assert.ok(result.sha, 'checkpoint commit created')

    removeWorktree(repo, wt.path, wt.branch, { keepBranch: true })

    const branches = git(repo, ['branch', '--list', wt.branch]).trim()
    assert.ok(branches.includes(wt.branch), 'branch survives removal with keepBranch')
    // The checkpoint commit is reachable from the kept branch.
    const show = git(repo, ['show', '--stat', '--format=%s', wt.branch]).trim()
    assert.ok(show.includes('rivet: archive checkpoint'))
    assert.ok(show.includes('wip.txt'))

    git(repo, ['branch', '-D', wt.branch])
  })

  it('commitAll returns nothingToCommit on a clean tree', () => {
    const result = commitAll(repo, 'noop')
    assert.deepEqual(result, { ok: true, nothingToCommit: true })
  })
})
