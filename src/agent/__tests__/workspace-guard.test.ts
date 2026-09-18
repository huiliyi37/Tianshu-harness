import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createWorkspaceGuard,
  type WorkspaceGuard,
  type WorkspaceGuardReport,
} from '../workspace-guard.js'

const execFileP = promisify(execFile)

// 必须在系统 tmpdir + mkdtemp 唯一路径——曾用工作树内固定路径，并发会话的
// rmSync/init 竞态会让 `git config` 向上爬进主仓库，污染提交作者（详见
// git.test.ts 同款注释）。
let TMP: string

// ── Async git helpers ───────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  return stdout
}

/** git stash with assertion — fails fast if no stash entry was created */
async function gitStash(cwd: string): Promise<void> {
  const before = await git(cwd, ['stash', 'list'])
  const beforeCount = before.trim() ? before.trim().split('\n').length : 0
  await git(cwd, ['stash'])
  const after = await git(cwd, ['stash', 'list'])
  const afterCount = after.trim() ? after.trim().split('\n').length : 0
  assert.ok(afterCount > beforeCount,
    `git stash did not create an entry (working tree was clean?). before=${beforeCount} after=${afterCount}`)
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const out = await git(cwd, args)
  return out.trim().split('\n').filter(Boolean)
}

// ── Test helpers ────────────────────────────────────────────────────

async function setupGitRepo(cwd: string): Promise<void> {
  await git(cwd, ['init', '-b', 'main'])
  await git(cwd, ['config', 'user.email', 'test@test.com'])
  await git(cwd, ['config', 'user.name', 'Test'])
}

function makeGitignore(cwd: string, patterns: string[]): void {
  writeFileSync(join(cwd, '.gitignore'), patterns.join('\n') + '\n')
}

async function gitAdd(cwd: string, files: string[], force = false): Promise<void> {
  const args = force ? ['add', '-f', ...files] : ['add', ...files]
  await git(cwd, args)
}

async function gitCommit(cwd: string, msg: string): Promise<void> {
  await git(cwd, ['commit', '-m', msg])
}

function makeDir(cwd: string, dir: string): void {
  mkdirSync(join(cwd, dir), { recursive: true })
}

function makeFile(cwd: string, path: string, content: string): void {
  const fullPath = join(cwd, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

describe('workspace-guard — stash / runtime artifact guard', () => {
  let guard: WorkspaceGuard

  beforeEach(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'rivet-workspace-guard-'))
    await setupGitRepo(TMP)
    makeGitignore(TMP, ['.rivet/artifacts/', '.rivet/sessions/'])
    guard = createWorkspaceGuard(TMP)
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // ── Spec scenario 1: tracked runtime artifacts → blocked ──────

  it('tracked runtime artifacts → blocked', async () => {
    makeDir(TMP, '.rivet/artifacts')
    makeFile(TMP, '.rivet/artifacts/verification.json', '{"score": 0.95}')
    makeFile(TMP, '.rivet/artifacts/log.txt', 'session log')
    await gitAdd(TMP, ['.rivet/artifacts/verification.json', '.rivet/artifacts/log.txt'], true)

    const result = await guard.checkRuntimeArtifacts()

    assert.equal(result.blocked, true, 'tracked runtime artifacts should block')
    assert.ok(result.tracked.length >= 2, `Expected >=2 tracked, got ${result.tracked.length}`)
    assert.ok(
      result.tracked.some(f => f.includes('verification.json')),
      'verification.json should be listed as tracked',
    )
    assert.ok(
      result.tracked.some(f => f.includes('log.txt')),
      'log.txt should be listed as tracked',
    )

    const blockedReasons = result.reasons.filter(r => r.startsWith('BLOCKED:'))
    assert.ok(blockedReasons.length > 0, `Expected BLOCKED reason, got: ${result.reasons.join(' | ')}`)
    assert.ok(
      blockedReasons[0]!.includes('runtime artifact'),
      `Reason should mention runtime artifacts: ${blockedReasons[0]}`,
    )
  })

  // ── Spec scenario 2: ignored runtime artifacts → warning, not blocked ──

  it('ignored runtime artifacts → warning, not blocked', async () => {
    makeDir(TMP, '.rivet/artifacts')
    makeFile(TMP, '.rivet/artifacts/verification.json', '{"score": 0.95}')
    makeDir(TMP, '.rivet/sessions')
    makeFile(TMP, '.rivet/sessions/session-1.jsonl', '{"turn": 1}')

    // Ensure gitignore covers them
    const ignored = await gitLines(TMP, ['ls-files', '--others', '--ignored', '--exclude-standard'])
    assert.ok(ignored.length > 0, 'files should be gitignored')

    const result = await guard.checkRuntimeArtifacts()

    assert.equal(result.blocked, false, 'ignored runtime artifacts should NOT block')
    assert.equal(result.tracked.length, 0, 'no tracked runtime artifacts expected')
    assert.ok(
      result.ignoredButPresent.length > 0,
      `Expected ignored-but-present files, got: ${result.ignoredButPresent}`,
    )

    // Warning must mention do not delete + promotion (memory retention policy alignment)
    const warningReasons = result.reasons.filter(r => r.startsWith('WARNING:'))
    assert.ok(warningReasons.length > 0, `Expected WARNING reason, got: ${result.reasons.join(' | ')}`)
    const warningText = warningReasons[0]!
    assert.ok(
      warningText.includes('do not delete'),
      `Warning should include 'do not delete': ${warningText}`,
    )
    assert.ok(
      warningText.includes('promotion'),
      `Warning should include 'promotion': ${warningText}`,
    )
  })

  // ── Spec scenario 3: stash different content → blocked from auto-apply ──

  it('stash different content vs current file → blocked from auto-apply', async () => {
    makeFile(TMP, 'src/app.ts', 'const x = 1')
    await gitAdd(TMP, ['src/app.ts'])
    await gitCommit(TMP, 'initial commit')

    // Modify the file
    makeFile(TMP, 'src/app.ts', 'const x = 2')
    // Stash it
    await gitStash(TMP)

    // Now modify the file again — current version differs from stash
    makeFile(TMP, 'src/app.ts', 'const x = 3')

    const result = await guard.checkStashSafety('stash@{0}')

    assert.equal(result.blocked, true, 'stash with different content should block auto-apply')
    assert.ok(result.conflicts.length > 0, 'should have at least one conflict')

    const differentConflicts = result.conflicts.filter(c => c.status === 'different')
    assert.ok(differentConflicts.length > 0, 'should detect different working-tree file')
    assert.ok(
      differentConflicts.some(c => c.path === 'src/app.ts'),
      'src/app.ts should be listed as different',
    )

    const blockedReasons = result.reasons.filter(r => r.startsWith('BLOCKED:'))
    assert.ok(blockedReasons.length > 0, `Expected BLOCKED reason, got: ${result.reasons.join(' | ')}`)
    assert.ok(
      blockedReasons[0]!.includes('different content'),
      `Reason should mention different content: ${blockedReasons[0]}`,
    )
  })

  // ── Spec scenario 4: untracked file would be overwritten → blocked ──

  it('untracked file would be overwritten by merge → blocked', async () => {
    makeFile(TMP, 'docs/readme.md', 'initial readme')
    await gitAdd(TMP, ['docs/readme.md'])
    await gitCommit(TMP, 'initial commit')

    // Create a branch with another file
    await git(TMP, ['checkout', '-b', 'feature/docs'])
    makeFile(TMP, 'docs/notes.md', '# Notes from feature branch')
    await gitAdd(TMP, ['docs/notes.md'])
    await gitCommit(TMP, 'add notes on feature branch')

    // Switch back to main
    await git(TMP, ['checkout', 'main'])

    // Create an untracked file with the same name
    makeFile(TMP, 'docs/notes.md', '# Local untracked notes — must not be overwritten')

    const result = await guard.checkMergeSafety('feature/docs')

    assert.equal(result.blocked, true, 'merge that overwrites untracked files should block')
    assert.ok(
      result.wouldOverwriteUntracked.includes('docs/notes.md'),
      `docs/notes.md should be flagged, got: ${result.wouldOverwriteUntracked}`,
    )

    const blockedReasons = result.reasons.filter(r => r.startsWith('BLOCKED:'))
    assert.ok(blockedReasons.length > 0, `Expected BLOCKED reason, got: ${result.reasons.join(' | ')}`)
    assert.ok(
      blockedReasons.some(r => r.includes('untracked')),
      `Reason should mention untracked: ${blockedReasons.join(' | ')}`,
    )
  })

  // ── Step 2 new: modified tracked file would be overwritten → blocked ──

  it('modified tracked file would be overwritten by merge → blocked', async () => {
    // Main: committed file
    makeFile(TMP, 'src/lib.ts', 'export const version = 1')
    await gitAdd(TMP, ['src/lib.ts'])
    await gitCommit(TMP, 'initial commit')

    // Branch: modify the same file
    await git(TMP, ['checkout', '-b', 'feature/v2'])
    makeFile(TMP, 'src/lib.ts', 'export const version = 2')
    await gitAdd(TMP, ['src/lib.ts'])
    await gitCommit(TMP, 'bump version on feature branch')

    // Switch back to main
    await git(TMP, ['checkout', 'main'])

    // Modify the file locally (unstaged) — merge would overwrite this
    makeFile(TMP, 'src/lib.ts', 'export const version = 1; // local WIP changes')

    const result = await guard.checkMergeSafety('feature/v2')

    assert.equal(result.blocked, true, 'merge overwriting locally-modified file should block')
    assert.ok(
      result.wouldOverwriteModified.includes('src/lib.ts'),
      `src/lib.ts should be flagged as wouldOverwriteModified, got: ${result.wouldOverwriteModified}`,
    )

    const blockedReasons = result.reasons.filter(r => r.startsWith('BLOCKED:'))
    assert.ok(
      blockedReasons.some(r => r.includes('locally-modified')),
      `Reason should mention locally-modified: ${blockedReasons.join(' | ')}`,
    )
  })

  // ── Step 2 new: modified file NOT touched by target → not blocked ──

  it('modified tracked file not touched by target → not blocked by merge', async () => {
    makeFile(TMP, 'src/lib.ts', 'export const version = 1')
    makeFile(TMP, 'src/other.ts', 'export const x = 1')
    await gitAdd(TMP, ['src/lib.ts', 'src/other.ts'])
    await gitCommit(TMP, 'initial commit')

    // Branch: only changes src/lib.ts
    await git(TMP, ['checkout', '-b', 'feature/v2'])
    makeFile(TMP, 'src/lib.ts', 'export const version = 2')
    await gitAdd(TMP, ['src/lib.ts'])
    await gitCommit(TMP, 'bump on feature branch')

    // Switch back
    await git(TMP, ['checkout', 'main'])

    // Modify src/other.ts locally — this file is NOT touched by target branch
    makeFile(TMP, 'src/other.ts', 'export const x = 999')

    const result = await guard.checkMergeSafety('feature/v2')

    // src/other.ts should NOT be in wouldOverwriteModified
    assert.ok(
      !result.wouldOverwriteModified.includes('src/other.ts'),
      `src/other.ts should NOT be flagged, got: ${result.wouldOverwriteModified}`,
    )

    // src/lib.ts IS touched by target but we didn't modify it locally → not flagged
    assert.ok(
      !result.wouldOverwriteModified.includes('src/lib.ts'),
      `src/lib.ts should NOT be flagged (not modified locally), got: ${result.wouldOverwriteModified}`,
    )

    // No local modifications overlap with target → not blocked
    assert.equal(result.blocked, false, 'merge with no local overlap should not block')
  })

  // ── Step 2 new: staged tracked file touched by target → blocked ──

  it('staged tracked file touched by target → blocked', async () => {
    makeFile(TMP, 'src/lib.ts', 'export const version = 1')
    await gitAdd(TMP, ['src/lib.ts'])
    await gitCommit(TMP, 'initial commit')

    // Branch: modify the same file
    await git(TMP, ['checkout', '-b', 'feature/v2'])
    makeFile(TMP, 'src/lib.ts', 'export const version = 2')
    await gitAdd(TMP, ['src/lib.ts'])
    await gitCommit(TMP, 'bump version on feature branch')

    // Switch back to main
    await git(TMP, ['checkout', 'main'])

    // Modify and stage the file (staged change)
    makeFile(TMP, 'src/lib.ts', 'export const version = 1; // staged improvement')
    await gitAdd(TMP, ['src/lib.ts'])

    const result = await guard.checkMergeSafety('feature/v2')

    assert.equal(result.blocked, true, 'merge overwriting staged file should block')
    assert.ok(
      result.wouldOverwriteModified.includes('src/lib.ts'),
      `src/lib.ts should be flagged, got: ${result.wouldOverwriteModified}`,
    )
  })

  // ── Edge case: promoted .rivet/playbook.jsonl does not trigger false positive ──

  it('promoted .rivet/playbook.jsonl does not block when tracked', async () => {
    makeDir(TMP, '.rivet')
    makeFile(TMP, '.rivet/playbook.jsonl', '{}')
    await gitAdd(TMP, ['.rivet/playbook.jsonl'])

    const result = await guard.checkRuntimeArtifacts()

    const hasPlaybook = result.tracked.some(f => f.includes('playbook.jsonl'))
    assert.equal(hasPlaybook, false, 'promoted .rivet/playbook.jsonl should not be flagged')
    assert.equal(result.blocked, false, 'promoted file alone should not block')
  })

  // ── Edge case: same stash content → not blocked ──

  it('same stash content vs current file → not blocked', async () => {
    makeFile(TMP, 'src/lib.ts', 'export const version = 1')
    await gitAdd(TMP, ['src/lib.ts'])
    await gitCommit(TMP, 'initial')

    // Modify and stash
    makeFile(TMP, 'src/lib.ts', 'export const version = 2')
    await gitStash(TMP)

    // Apply the stash back
    await git(TMP, ['stash', 'apply'])

    const result = await guard.checkStashSafety('stash@{0}')

    const sameConflicts = result.conflicts.filter(c => c.status === 'same')
    assert.ok(sameConflicts.length > 0, 'should detect same content')
    assert.equal(result.blocked, false, 'same content should not block')
  })

  // ── Edge case: stash file missing from working tree (missing_current) ──

  it('stash file missing from working tree → warning not blocked', async () => {
    makeFile(TMP, 'src/temp.ts', 'temporary file')
    await gitAdd(TMP, ['src/temp.ts'])
    await gitCommit(TMP, 'initial')

    // Need uncommitted changes for stash to create an entry
    makeFile(TMP, 'src/temp.ts', 'modified temporary file')
    await gitStash(TMP)

    // Now delete the file from working tree — stash still has it
    rmSync(join(TMP, 'src/temp.ts'))

    const result = await guard.checkStashSafety('stash@{0}')

    // File exists in stash but missing from working tree
    const missing = result.conflicts.filter(c => c.status === 'missing_current')
    assert.ok(missing.length > 0,
      `Expected missing_current, got: ${JSON.stringify(result.conflicts)}`)

    // missing_current is not a blocking condition (file can be restored)
    assert.equal(result.blocked, false, 'missing_current alone should not block')
  })

  // ── fullReport integration test ──

  it('fullReport returns safeToMerge=true for clean workspace', async () => {
    makeFile(TMP, 'src/clean.ts', 'clean file')
    await gitAdd(TMP, ['src/clean.ts'])
    await gitCommit(TMP, 'clean commit')

    const report: WorkspaceGuardReport = await guard.fullReport()

    assert.equal(report.trackedRuntimeArtifacts.length, 0)
    assert.equal(report.ignoredButPresentRuntimeArtifacts.length, 0)
    assert.equal(report.stashConflicts.length, 0)
    assert.equal(report.wouldOverwriteUntracked.length, 0)
    assert.equal(report.safeToMerge, true, 'clean workspace should be safe to merge')
    assert.ok(report.reasons.length >= 0)
  })

  // ── fullReport with runtime artifacts present ──

  it('fullReport sets safeToMerge=false when runtime artifacts are tracked', async () => {
    makeDir(TMP, '.rivet/artifacts')
    makeFile(TMP, '.rivet/artifacts/data.json', '{}')
    await gitAdd(TMP, ['.rivet/artifacts/data.json'], true)

    const report: WorkspaceGuardReport = await guard.fullReport()

    assert.equal(report.safeToMerge, false, 'tracked runtime artifacts should make safeToMerge=false')
    assert.ok(report.trackedRuntimeArtifacts.length > 0)
    assert.ok(
      report.reasons.some(r => r.startsWith('BLOCKED:')),
      `Expected BLOCKED reason in fullReport, got: ${report.reasons.join(' | ')}`,
    )
  })

  // ── WorkspaceGuard is not a class ──

  it('WorkspaceGuard uses factory pattern, not class', () => {
    const g = createWorkspaceGuard('/tmp/test')
    assert.equal(typeof g, 'object')
    assert.equal(typeof g.checkRuntimeArtifacts, 'function')
    assert.equal(typeof g.checkStashSafety, 'function')
    assert.equal(typeof g.checkMergeSafety, 'function')
    assert.equal(typeof g.fullReport, 'function')
    assert.ok(!(g instanceof (class {})), 'should not be a class instance')
  })
})
