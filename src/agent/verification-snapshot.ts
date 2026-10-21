/**
 * Verification Snapshot Worktree (VSW) — P1 core
 *
 * Materializes an isolated git worktree at `baseline.head` + only the current
 * session's owned diff, so verification runs free of concurrent-session
 * pollution. The tree is built as:
 *
 *   git worktree add --detach <.rivet/vsw/sessionId> <baseline.head>
 *   overlay owned diff:
 *     - tracked owned (modify/delete): `git diff <baseline.head> -- <owned> | git apply`
 *       (git natively handles add/modify/delete; applied onto the baseline tree)
 *     - untracked owned (new files): materializeScope (copies only when target absent,
 *       so it composes after git apply without clobbering tracked overlays)
 *
 * Non-owned files stay at baseline.head — concurrent commits/dirt never leak in,
 * so a Phase-A failure attributes cleanly to owned changes (辅's no-ambiguity rule).
 *
 * Lifecycle reuses worktree.ts primitives (createWorktreeAt / removeWorktree).
 * The overlay itself is net-new logic — materializeScope alone cannot apply
 * tracked changes/deletions (it skips existing targets), so this module does not
 * pretend to be a zero-rewrite reuse.
 *
 * @module verification-snapshot
 */

import { spawnGit } from '../tools/spawn-git.js'
import { existsSync, rmSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorktreeAtAsync, removeWorktree, removeWorktreeAsync } from './worktree.js'
import { materializeScope } from './worktree-scope.js'
import { RepoLock, worktreeRegistryLockPath } from './repo-lock.js'
import { provisionSnapshotDeps } from './snapshot-deps.js'

export interface VerificationSnapshotInit {
  /** Main repository working directory (the live, shared worktree). */
  baseCwd: string
  /** Session identifier — also the leaf dir under .rivet/vsw/. */
  sessionId: string
  /** Real baseline commit-ish (BaselineSnapshot.head). */
  baselineHead: string
  /** Files owned by the current session (repo-relative or absolute-under-baseCwd). */
  ownedFiles: string[]
  /** Cross-session lock guarding .git/worktrees mutations. Injectable for tests;
   *  defaults to a RepoLock on .rivet/worktree-registry.lock under baseCwd. */
  lock?: RepoLock
}

export interface OverlayResult {
  /** True if a tracked owned diff was applied via git apply. */
  appliedDiff: boolean
  /** Untracked owned files copied in via materializeScope (repo-relative). */
  materialized: string[]
  /** Scope entries outside the repo or path-escape (genuinely unreachable). */
  missing: string[]
  /** Valid relative paths whose files don't exist yet in base (worker creates them). */
  toBeCreated: string[]
}

export interface VerificationSnapshot {
  /** Absolute path to the snapshot worktree. */
  readonly path: string
  /** Baseline commit-ish this snapshot is pinned to. */
  readonly baselineHead: string
  /** Rebuild the tree at baseline.head + the given owned diff. */
  refresh(ownedFiles: string[]): Promise<OverlayResult>
  /** Remove the worktree (git worktree remove) and scrub the directory. */
  destroy(): void
}

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Async git spawn — collects stdout/stderr with timeout and maxBuffer.
 * Replaces the sync git() for snapshot build paths so the main event loop
 * never blocks on worktree creation, diff, or apply.
 */
async function gitAsync(
  cwd: string,
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number },
): Promise<GitResult> {
  const timeout = opts?.timeout ?? 60_000
  const maxBuffer = opts?.maxBuffer ?? 64 * 1024 * 1024
  const child = spawnGit(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

  const chunks: { stdout: Buffer[]; stderr: Buffer[]; total: number } = {
    stdout: [],
    stderr: [],
    total: 0,
  }

  return new Promise<GitResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeout)

    const onData = (buf: Buffer) => {
      chunks.total += buf.length
      if (chunks.total > maxBuffer) {
        clearTimeout(timer)
        child.kill('SIGTERM')
        reject(new Error(`gitAsync maxBuffer (${maxBuffer}) exceeded`))
      }
    }

    child.stdout?.on('data', (buf: Buffer) => {
      chunks.stdout.push(buf)
      onData(buf)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      chunks.stderr.push(buf)
      onData(buf)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        status: code ?? (child.killed ? 143 : 1),
        stdout: Buffer.concat(chunks.stdout).toString('utf-8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf-8'),
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Where a session's snapshot worktree lives. .rivet/ is gitignored. */
export function snapshotPath(baseCwd: string, sessionId: string): string {
  return join(baseCwd, '.rivet', 'vsw', sessionId)
}

/** Normalize an owned path to a repo-relative path, or null if outside the repo. */
function toRepoRelative(baseCwd: string, filePath: string): string | null {
  if (!isAbsolute(filePath)) {
    return filePath.startsWith('..') ? null : filePath
  }
  const rel = relative(baseCwd, filePath)
  // Windows 跨盘时 relative() 返回绝对路径（不以 .. 开头）——同族判据
  // （worktree-scope.ts 等 20 处 containment 检查）均带 isAbsolute(rel)
  // fail-closed；此处曾是唯一漏网（审查发现，2026-10-04）。
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

async function overlayOwnedDiff(
  baseCwd: string,
  worktreePath: string,
  baselineHead: string,
  ownedFiles: string[],
): Promise<OverlayResult> {
  const rels: string[] = []
  const abs: string[] = []
  for (const f of ownedFiles) {
    const rel = toRepoRelative(baseCwd, f)
    if (!rel) continue
    rels.push(rel)
    abs.push(isAbsolute(f) ? f : join(baseCwd, f))
  }

  let appliedDiff = false
  if (rels.length > 0) {
    // baselineHead 来自快照元数据（磁盘读取）；拒绝 `-` 开头防止被 git 解析为选项
    // （与 git.ts sanitizeBaseRef 同款防御，来源：codex-security targets.ts 调研）。
    if (baselineHead.startsWith('-')) {
      throw new Error(`VSW overlay: invalid baseline head ${JSON.stringify(baselineHead)}`)
    }
    // Diff baseline.head against the live working tree for owned paths only.
    // Captures tracked modifications and deletions; untracked-new files do not
    // appear here (git diff ignores untracked) — they go through materializeScope.
    const diff = await gitAsync(baseCwd, ['diff', '--no-color', baselineHead, '--', ...rels])
    if (diff.status !== 0) {
      throw new Error(`VSW overlay: git diff failed for baseline ${baselineHead.slice(0, 12)}: ${diff.stderr.trim()}`)
    }
    const patch = diff.stdout
    if (patch.trim().length > 0) {
      // Write patch to a temp file instead of stdin to avoid the spawnSync
      // pipe deadlock: when the patch exceeds the OS pipe buffer, the parent
      // write blocks waiting for the child to drain, while the child (git apply)
      // blocks reading stdin waiting for EOF.
      const tmpDir = mkdtempSync(join(tmpdir(), 'vsw-apply-'))
      const patchFile = join(tmpDir, 'owned.patch')
      try {
        writeFileSync(patchFile, patch, 'utf-8')
        const applied = await gitAsync(worktreePath, ['apply', '--whitespace=nowarn', patchFile])
        if (applied.status !== 0) {
          throw new Error(`VSW overlay: git apply failed in ${worktreePath}: ${applied.stderr.trim()}`)
        }
        appliedDiff = true
      } finally {
        try { unlinkSync(patchFile) } catch { /* best-effort */ }
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }
  }

  // Untracked-new owned files: copied only when the target is absent, so this
  // never clobbers the tracked overlay git apply just wrote.
  const mat = materializeScope(baseCwd, worktreePath, abs)
  return { appliedDiff, materialized: mat.materialized, missing: mat.missing, toBeCreated: mat.toBeCreated }
}

function destroyAt(baseCwd: string, worktreePath: string): void {
  try {
    removeWorktree(baseCwd, worktreePath)
  } catch {
    // best-effort — fall through to directory scrub
  }
  try {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/** Async destroyAt for the build path — same best-effort contract. */
async function destroyAtAsync(baseCwd: string, worktreePath: string): Promise<void> {
  try {
    await removeWorktreeAsync(baseCwd, worktreePath)
  } catch {
    // best-effort — fall through to directory scrub
  }
  try {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/**
 * Build a verification snapshot. Any stale worktree at the same path is removed
 * first. Throws if git worktree creation or overlay fails (no fake green).
 */
export async function createVerificationSnapshot(init: VerificationSnapshotInit): Promise<VerificationSnapshot> {
  const path = snapshotPath(init.baseCwd, init.sessionId)
  const lock = init.lock ?? new RepoLock({ lockPath: worktreeRegistryLockPath(init.baseCwd) })

  async function build(ownedFiles: string[]): Promise<OverlayResult> {
    // Only the .git/worktrees registry mutations (remove + add) need cross-session
    // serialization; the per-session overlay writes into our private worktree dir
    // and stays outside the lock to keep the held section short.
    await lock.withLockAsync(async () => {
      await destroyAtAsync(init.baseCwd, path)
      // sessionId 必须传：它落成 owner marker，是本快照日后能被 reapOrphanSnapshots
      // 回收的前提。漏传就只能靠人手清，`.rivet/vsw/` 会无界增长。
      await createWorktreeAtAsync(init.baseCwd, path, init.baselineHead, init.sessionId)
    })
    const overlay = await overlayOwnedDiff(init.baseCwd, path, init.baselineHead, ownedFiles)
    // Wire snapshot deps: symlink node_modules/.venv from base repo for tests.
    const deps = provisionSnapshotDeps(init.baseCwd, path)
    if (deps.warnings.length > 0) {
      console.warn('[vsw] dep provisioning warnings:', deps.warnings.join('; '))
    }
    return overlay
  }

  try {
    await build(init.ownedFiles)
  } catch (error) {
    // A failed overlay can leave an otherwise valid detached worktree behind.
    // The caller receives no snapshot handle in this case, so clean it here.
    await lock.withLockAsync(() => destroyAtAsync(init.baseCwd, path))
    throw error
  }

  return {
    path,
    baselineHead: init.baselineHead,
    async refresh(ownedFiles: string[]): Promise<OverlayResult> {
      // P1: full rebuild at baseline.head. Avoids the git-clean/info-exclude
      // interaction that an in-place incremental refresh would have to handle;
      // incremental refresh of only changed files is a P2+ optimization.
      return build(ownedFiles)
    },
    destroy(): void {
      lock.withLock(() => {
        destroyAt(init.baseCwd, path)
      })
    },
  }
}
