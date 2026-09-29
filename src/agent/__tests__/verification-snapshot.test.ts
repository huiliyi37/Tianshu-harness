import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { createVerificationSnapshot, snapshotPath } from '../verification-snapshot.js'

const tempDirs: string[] = []

function g(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim()
}

/** Git repo with a tracked src/a.ts on an initial commit. Returns {dir, head}. */
function makeRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vsw-test-'))
  tempDirs.push(dir)
  g(dir, 'git init -b main')
  g(dir, 'git config user.email "test@test"')
  g(dir, 'git config user.name "test"')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "baseline"\n')
  writeFileSync(join(dir, 'README.md'), '# baseline\n')
  g(dir, 'git add -A')
  g(dir, 'git commit -m init')
  return { dir, head: g(dir, 'git rev-parse HEAD') }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      // Clean any worktree registration before removing the dir tree.
      try { execSync('git worktree prune', { cwd: dir, stdio: 'ignore' }) } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
})

describe('verification-snapshot — VSW core', async () => {
  it('creates a detached worktree under .rivet/vsw/<sessionId> at baseline.head', async () => {
    const { dir, head } = makeRepo()
    const snap = await createVerificationSnapshot({ baseCwd: dir, sessionId: 'sess1', baselineHead: head, ownedFiles: [] })

    assert.equal(snap.path, snapshotPath(dir, 'sess1'))
    assert.ok(existsSync(snap.path), 'worktree dir should exist')
    // Detached at baseline.head.
    assert.equal(g(snap.path, 'git rev-parse HEAD'), head)
    const list = g(dir, 'git worktree list --porcelain')
    // git 在 Windows 输出正斜杠路径，snap.path 用平台分隔符——归一化后比较。
    assert.ok(
      list.replace(/\\/g, '/').includes(snap.path.replace(/\\/g, '/')),
      'worktree should be registered',
    )

    snap.destroy()
  })

  it('overlays tracked owned modifications (does NOT skip them like materializeScope would)', async () => {
    const { dir, head } = makeRepo()
    // Session edits a tracked file in the live working tree (uncommitted).
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "owned-change"\n')

    const snap = await createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess2', baselineHead: head, ownedFiles: ['src/a.ts'],
    })

    // 反证: a naive materializeScope overlay would `continue` on the existing
    // baseline file and leave "baseline" content → this asserts the diff applied.
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "owned-change"\n')
    snap.destroy()
  })

  it('materializes untracked-new owned files', async () => {
    const { dir, head } = makeRepo()
    writeFileSync(join(dir, 'src', 'new.ts'), 'export const n = 1\n')

    const snap = await createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess3', baselineHead: head, ownedFiles: ['src/new.ts'],
    })

    assert.ok(existsSync(join(snap.path, 'src', 'new.ts')), 'untracked owned file should be copied in')
    assert.equal(readFileSync(join(snap.path, 'src', 'new.ts'), 'utf-8'), 'export const n = 1\n')
    snap.destroy()
  })

  it('isolates the snapshot from concurrent non-owned commits (no pollution)', async () => {
    const { dir, head } = makeRepo()
    // Owned change.
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "owned-change"\n')
    // Concurrent session advances HEAD with an UNowned change.
    writeFileSync(join(dir, 'README.md'), '# concurrent-pollution\n')
    g(dir, 'git add README.md')
    g(dir, 'git commit -m "concurrent session commit"')

    const snap = await createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess4', baselineHead: head, ownedFiles: ['src/a.ts'],
    })

    // Owned change present.
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "owned-change"\n')
    // Concurrent commit NOT present — snapshot stays at baseline README.
    assert.equal(readFileSync(join(snap.path, 'README.md'), 'utf-8'), '# baseline\n')
    snap.destroy()
  })

  it('overlays tracked owned deletions', async () => {
    const { dir, head } = makeRepo()
    unlinkSync(join(dir, 'src', 'a.ts'))

    const snap = await createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess5', baselineHead: head, ownedFiles: ['src/a.ts'],
    })

    assert.equal(existsSync(join(snap.path, 'src', 'a.ts')), false, 'deleted owned file should be absent in snapshot')
    snap.destroy()
  })

  it('refresh rebuilds the tree at the latest owned content', async () => {
    const { dir, head } = makeRepo()
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "v1"\n')
    const snap = await createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess6', baselineHead: head, ownedFiles: ['src/a.ts'],
    })
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "v1"\n')

    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "v2"\n')
    await snap.refresh(['src/a.ts'])
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "v2"\n')
    snap.destroy()
  })

  it('destroy removes the worktree and unregisters it', async () => {
    const { dir, head } = makeRepo()
    const snap = await createVerificationSnapshot({ baseCwd: dir, sessionId: 'sess7', baselineHead: head, ownedFiles: [] })
    assert.ok(existsSync(snap.path))

    snap.destroy()
    assert.equal(existsSync(snap.path), false, 'worktree dir should be gone')
    const list = g(dir, 'git worktree list --porcelain')
    assert.equal(list.includes(snap.path), false, 'worktree should be unregistered')
  })

  it('a stale snapshot at the same path is replaced on create', async () => {
    const { dir, head } = makeRepo()
    const first = await createVerificationSnapshot({ baseCwd: dir, sessionId: 'dup', baselineHead: head, ownedFiles: [] })
    assert.ok(existsSync(first.path))
    // Create again with the same sessionId — should not throw on the existing path.
    const second = await createVerificationSnapshot({ baseCwd: dir, sessionId: 'dup', baselineHead: head, ownedFiles: [] })
    assert.equal(second.path, first.path)
    assert.equal(g(second.path, 'git rev-parse HEAD'), head)
    second.destroy()
  })

  // Source-level guard: prevent stdin deadlock regression.
  // The original bug was caused by passing patch content via spawnSync `input`
  // which deadlocks when the patch exceeds the OS pipe buffer. Any future edit
  // that reintroduces `spawnGitSync` or an `input` spawn option in this module
  // must fail this test.
  it('contains no spawnGitSync or input: spawn option regression vectors', () => {
    const srcPath = join(process.cwd(), 'src', 'agent', 'verification-snapshot.ts')
    const src = readFileSync(srcPath, 'utf-8')
    assert.ok(
      !src.includes('spawnGitSync'),
      'verification-snapshot.ts must not import spawnGitSync — use gitAsync for async spawn',
    )
    // Match `input` as a spawn option key: indented line like `    input,` or `    input:`.
    // Does not match function params (input?: string) or comments.
    const hasInputOption = /^[ \t]+input[,:]/m.test(src)
    assert.equal(hasInputOption, false,
      'verification-snapshot.ts must not pass `input` as a spawn option — use temp files instead',
    )
  })
})
