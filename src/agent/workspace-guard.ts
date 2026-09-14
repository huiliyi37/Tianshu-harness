/**
 * WorkspaceGuard — Stash / Runtime Artifact Guard
 *
 * 防止以下事故：
 * - .rivet/artifacts 被提交到 git
 * - .rivet/sessions 被误删
 * - stash 内容覆盖当前工作区（内容不同时阻断）
 * - 评分/验证文件被 merge 覆盖
 * - agent 直接 apply stash 导致回退
 * - tracked local changes 被 merge 静默覆盖
 *
 * 关键规则：
 * 1. .rivet/artifacts/ 不应 tracked
 * 2. .rivet/sessions/ 不应 tracked，除非明确提升
 * 3. stash apply 前应逐文件比较 hash
 * 4. merge 前检查 untracked overwrite + tracked local modifications
 * 5. runtime artifacts 被 ignore 不是可删除许可
 *
 * StarSpine relation:
 * - Task Contract scope/ownership knownRisks（架构 spec 3.2）
 * - Pure Delivery delivery gate（纯净交付路线图）
 * - Memory retention policy（T2 记忆文件保全策略）
 *
 * This module is pure diagnostic. It does not mutate workspace.
 * WorkspaceGuard 不执行 stash apply，不执行 merge，不删除 artifacts。
 * 只报告。
 *
 * HEARTH 兼容：safeToMerge 可作为 delivery gate 的一部分。
 * Songline 兼容：reasons 字符串列表可被 obligation engine 读取。
 *
 * @module workspace-guard
 * @task C
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// ── Types ───────────────────────────────────────────────────────────

export interface WorkspaceGuardReport {
  trackedRuntimeArtifacts: string[]
  ignoredButPresentRuntimeArtifacts: string[]
  stashConflicts: Array<{
    stashRef: string
    path: string
    /** same=content identical; different=content differs (ordering not trusted);
     *  missing_current=file not in working tree; missing_stash=file not in stash;
     *  unknown=could not determine */
    status: 'same' | 'different' | 'missing_current' | 'missing_stash' | 'unknown'
  }>
  wouldOverwriteUntracked: string[]
  safeToMerge: boolean
  reasons: string[]
}

export interface RuntimeArtifactCheck {
  tracked: string[]
  ignoredButPresent: string[]
  blocked: boolean
  reasons: string[]
}

export interface StashSafetyCheck {
  conflicts: WorkspaceGuardReport['stashConflicts']
  blocked: boolean
  reasons: string[]
}

export interface MergeSafetyCheck {
  wouldOverwriteUntracked: string[]
  /** Tracked files with local modifications that the target branch would overwrite */
  wouldOverwriteModified: string[]
  blocked: boolean
  reasons: string[]
}

export interface WorkspaceGuard {
  /** Check if runtime artifacts (.rivet/artifacts, .rivet/sessions) are tracked or ignorantly present. */
  checkRuntimeArtifacts(): Promise<RuntimeArtifactCheck>

  /** Check if applying a stash would overwrite different working-tree content. */
  checkStashSafety(stashRef: string): Promise<StashSafetyCheck>

  /** Check if merging a branch would overwrite untracked or locally-modified tracked files. */
  checkMergeSafety(targetBranch: string): Promise<MergeSafetyCheck>

  /** Full diagnostic report. */
  fullReport(stashRef?: string, targetBranch?: string): Promise<WorkspaceGuardReport>
}

// ── Constants ───────────────────────────────────────────────────────

const RUNTIME_DIRS = ['.rivet/artifacts', '.rivet/sessions']

/** Files within .rivet/ that are explicitly promoted to tracked — everything else must be untracked. */
const PROMOTED_RIVET_FILES = new Set(['.rivet/playbook.jsonl'])

// ── Git helpers ─────────────────────────────────────────────────────

/**
 * Run git and return stdout split into lines.
 * Throws on git failure — callers decide whether to degrade or report.
 * Empty output (git succeeds but no results) returns [].
 */
async function gitLines(args: string[], cwd: string): Promise<string[]> {
  const { stdout } = await execFileP('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf-8', timeout: 10_000, windowsHide: true })
  return stdout.trim().split('\n').filter(Boolean)
}

/**
 * Run git and return raw stdout string.
 * Throws on git failure — callers decide whether to degrade or report.
 */
async function gitString(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf-8', timeout: 10_000, windowsHide: true })
  return stdout
}

/** Returns true if the path exists and is a regular file in the working tree. */
function fileExists(absPath: string): boolean {
  try {
    return statSync(absPath).isFile()
  } catch {
    return false
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ── Implementation ──────────────────────────────────────────────────

export function createWorkspaceGuard(cwd: string): WorkspaceGuard {
  const absCwd = resolve(cwd)

  // ── checkRuntimeArtifacts ──────────────────────────────────────

  async function checkRuntimeArtifacts(): Promise<RuntimeArtifactCheck> {
    const reasons: string[] = []
    const tracked: string[] = []
    const ignoredButPresent: string[] = []

    // Get all tracked files from git
    let trackedLines: string[]
    try {
      trackedLines = await gitLines(['ls-files', '--cached'], absCwd)
    } catch {
      return { tracked: [], ignoredButPresent: [], blocked: true, reasons: ['BLOCKED: git ls-files failed — cannot verify runtime artifacts.'] }
    }

    // Check each runtime directory
    for (const dir of RUNTIME_DIRS) {
      // Check: is anything under this dir tracked?
      for (const line of trackedLines) {
        if (line.startsWith(dir + '/') || line === dir) {
          // Allow explicitly promoted files
          if (!PROMOTED_RIVET_FILES.has(line)) {
            tracked.push(line)
          }
        }
      }

      // Check: is the dir present on disk but gitignored?
      const dirAbs = resolve(absCwd, dir)
      if (existsSync(dirAbs)) {
        try {
          const ignoredFiles = await gitLines(
            ['ls-files', '--others', '--ignored', '--exclude-standard', dir],
            absCwd,
          )
          if (ignoredFiles.length > 0) {
            ignoredButPresent.push(...ignoredFiles)
          }
        } catch {
          // git failure here is non-critical — skip ignored-file detection
        }
      }
    }

    if (tracked.length > 0) {
      reasons.push(
        `BLOCKED: ${tracked.length} runtime artifact(s) tracked in git: ${tracked.join(', ')}. ` +
        `These belong in .gitignore (${RUNTIME_DIRS.join(', ')}). Run: git rm --cached ${tracked.join(' ')}`,
      )
    }

    if (ignoredButPresent.length > 0) {
      reasons.push(
        `WARNING: ignored runtime artifacts present. ` +
        `Do not commit automatically; do not delete before promotion review. ` +
        `(${ignoredButPresent.length} file(s): ${ignoredButPresent.slice(0, 5).join(', ')}` +
        `${ignoredButPresent.length > 5 ? '...' : ''})`,
      )
    }

    return {
      tracked,
      ignoredButPresent,
      blocked: tracked.length > 0,
      reasons,
    }
  }

  // ── checkStashSafety ───────────────────────────────────────────

  async function checkStashSafety(stashRef: string): Promise<StashSafetyCheck> {
    const reasons: string[] = []
    const conflicts: WorkspaceGuardReport['stashConflicts'] = []

    // Get list of files in stash — may fail if stashRef doesn't exist
    let stashFiles: string[]
    try {
      stashFiles = await gitLines(
        ['stash', 'show', '--name-only', stashRef],
        absCwd,
      )
    } catch {
      return {
        conflicts: [],
        blocked: true,
        reasons: [`BLOCKED: stash ref ${stashRef} does not exist or git error.`],
      }
    }

    if (stashFiles.length === 0) {
      return { conflicts: [], blocked: false, reasons: ['Stash has no files to compare.'] }
    }

    for (const file of stashFiles) {
      const absPath = resolve(absCwd, file)

      // Get stash version content
      let stashContent: string
      try {
        stashContent = await gitString(['show', `${stashRef}:${file}`], absCwd)
      } catch {
        // File not in stash tree
        conflicts.push({ stashRef, path: file, status: 'missing_stash' })
        continue
      }
      // Empty content is valid (empty file), but check if file actually exists in stash tree
      if (stashContent === '') {
        try {
          const lsResult = await gitString(['ls-tree', stashRef, '--', file], absCwd)
          if (!lsResult.trim()) {
            conflicts.push({ stashRef, path: file, status: 'missing_stash' })
            continue
          }
        } catch {
          conflicts.push({ stashRef, path: file, status: 'missing_stash' })
          continue
        }
      }

      if (!fileExists(absPath)) {
        conflicts.push({ stashRef, path: file, status: 'missing_current' })
        continue
      }

      // Get current working-tree hash
      const currentContent = readFileSync(absPath, 'utf-8')
      const currentHash = sha256(currentContent)
      const stashHash = sha256(stashContent)

      if (currentHash === stashHash) {
        conflicts.push({ stashRef, path: file, status: 'same' })
      } else {
        conflicts.push({ stashRef, path: file, status: 'different' })
      }
    }

    const differentFiles = conflicts.filter(c => c.status === 'different')
    const missingCurrent = conflicts.filter(c => c.status === 'missing_current')

    if (differentFiles.length > 0) {
      reasons.push(
        `BLOCKED: ${differentFiles.length} file(s) in working tree have different content from stash ${stashRef}: ` +
        `${differentFiles.map(f => f.path).join(', ')}. ` +
        `Applying stash would overwrite current content. Compare manually before proceeding.`,
      )
    }

    if (missingCurrent.length > 0) {
      reasons.push(
        `WARNING: ${missingCurrent.length} file(s) exist in stash but missing from working tree: ` +
        `${missingCurrent.map(f => f.path).join(', ')}.`,
      )
    }

    return {
      conflicts,
      blocked: differentFiles.length > 0,
      reasons,
    }
  }

  // ── checkMergeSafety ───────────────────────────────────────────

  async function checkMergeSafety(targetBranch: string): Promise<MergeSafetyCheck> {
    const reasons: string[] = []
    const wouldOverwriteUntracked: string[] = []
    const wouldOverwriteModified: string[] = []

    // 1. Get files changed in target branch relative to HEAD
    let targetChangedFiles: string[]
    try {
      targetChangedFiles = await gitLines(
        ['diff', '--name-only', `HEAD..${targetBranch}`],
        absCwd,
      )
    } catch {
      return {
        wouldOverwriteUntracked: [],
        wouldOverwriteModified: [],
        blocked: true,
        reasons: [`BLOCKED: cannot diff HEAD..${targetBranch} — branch may not exist.`],
      }
    }
    const targetChangedSet = new Set(targetChangedFiles)

    // 2. Check untracked files that would be overwritten
    let untracked: string[]
    try {
      untracked = await gitLines(
        ['ls-files', '--others', '--exclude-standard'],
        absCwd,
      )
    } catch {
      return {
        wouldOverwriteUntracked: [],
        wouldOverwriteModified: [],
        blocked: true,
        reasons: [`BLOCKED: cannot list untracked files — git error.`],
      }
    }
    for (const file of untracked) {
      if (targetChangedSet.has(file)) {
        wouldOverwriteUntracked.push(file)
      }
    }

    // 3. Check tracked files with local modifications that would be overwritten
    // Use git diff instead of status --porcelain to avoid fragile XY parsing
    let unstagedModified: string[]
    let stagedModified: string[]
    try {
      unstagedModified = await gitLines(['diff', '--name-only'], absCwd)
      stagedModified = await gitLines(['diff', '--cached', '--name-only'], absCwd)
    } catch {
      return {
        wouldOverwriteUntracked,
        wouldOverwriteModified: [],
        blocked: true,
        reasons: [`BLOCKED: cannot determine local modifications — git error.`],
      }
    }
    const locallyModifiedSet = new Set([...unstagedModified, ...stagedModified])

    for (const file of locallyModifiedSet) {
      if (targetChangedSet.has(file)) {
        wouldOverwriteModified.push(file)
      }
    }

    // Also check: would any runtime artifacts be affected?
    const runtimeCheck = await checkRuntimeArtifacts()
    if (runtimeCheck.blocked) {
      reasons.push(...runtimeCheck.reasons)
    }

    if (wouldOverwriteUntracked.length > 0) {
      reasons.push(
        `BLOCKED: merge from ${targetBranch} would overwrite ${wouldOverwriteUntracked.length} untracked file(s): ` +
        `${wouldOverwriteUntracked.join(', ')}. ` +
        `Commit or stash these files first.`,
      )
    }

    if (wouldOverwriteModified.length > 0) {
      reasons.push(
        `BLOCKED: merge from ${targetBranch} would overwrite ${wouldOverwriteModified.length} locally-modified tracked file(s): ` +
        `${wouldOverwriteModified.join(', ')}. ` +
        `Commit or stash these changes first.`,
      )
    }

    return {
      wouldOverwriteUntracked,
      wouldOverwriteModified,
      blocked:
        wouldOverwriteUntracked.length > 0 ||
        wouldOverwriteModified.length > 0 ||
        runtimeCheck.blocked,
      reasons,
    }
  }

  // ── fullReport ─────────────────────────────────────────────────

  async function fullReport(
    stashRef?: string,
    targetBranch?: string,
  ): Promise<WorkspaceGuardReport> {
    const runtimeCheck = await checkRuntimeArtifacts()
    const reasons = [...runtimeCheck.reasons]

    let stashConflicts: WorkspaceGuardReport['stashConflicts'] = []
    let wouldOverwriteUntracked: string[] = []
    let stashBlocked = false
    let mergeBlocked = false

    if (stashRef) {
      const stashCheck = await checkStashSafety(stashRef)
      stashConflicts = stashCheck.conflicts
      stashBlocked = stashCheck.blocked
      reasons.push(...stashCheck.reasons)
    }

    if (targetBranch) {
      const mergeCheck = await checkMergeSafety(targetBranch)
      wouldOverwriteUntracked = mergeCheck.wouldOverwriteUntracked
      mergeBlocked = mergeCheck.blocked
      reasons.push(...mergeCheck.reasons)
    }

    const safeToMerge =
      !runtimeCheck.blocked &&
      !stashBlocked &&
      !mergeBlocked

    return {
      trackedRuntimeArtifacts: runtimeCheck.tracked,
      ignoredButPresentRuntimeArtifacts: runtimeCheck.ignoredButPresent,
      stashConflicts,
      wouldOverwriteUntracked,
      safeToMerge,
      reasons,
    }
  }

  return {
    checkRuntimeArtifacts,
    checkStashSafety,
    checkMergeSafety,
    fullReport,
  }
}
