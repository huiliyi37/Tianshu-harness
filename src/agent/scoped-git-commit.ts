import type { CommitVersion, VersionDiffKind } from './commit-version.js'
import { diffCommitVersion } from './commit-version.js'
import { captureCommitVersionAsync, captureCommitVersionDetailed, type CommitVersionCapture } from './commit-version-async.js'
import { gitCommand } from '../tools/git-command.js'
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface ScopedCommitInput {
  cwd: string
  files: string[]
  message: string
  expectedVersion?: CommitVersion
  signal?: AbortSignal
  timeoutMs?: number
}

/** 失败归因码：让调用方不用匹配文案就能分支出下一步（issue #537 C 项）。 */
export type ScopedCommitReason =
  | 'empty-message'
  | 'empty-files'
  | 'all-stale'
  | 'version-unavailable'
  | 'head-changed'
  | 'index-changed'
  | 'files-changed'
  | 'index-unreadable'
  | 'partially-staged'
  | 'retry-head-changed'
  | 'retry-files-changed'
  | 'staging-head-changed'
  | 'staging-files-changed'
  | 'commit-interrupted'
  | 'nothing-to-commit'
  | 'git-add-failed'
  | 'git-commit-failed'

export interface ScopedCommitResult {
  ok: boolean
  output: string
  /** SHA printed by this git commit invocation, never inferred from a later HEAD. */
  commitSha?: string
  /** 可选：稳定的失败归因码。缺省表示未分类（调用方应回落到通用处理）。 */
  reason?: ScopedCommitReason
  /** 可选：人读补充，例如「哪个文件命中了敏感规则」。 */
  detail?: string
}

// ── Transient git lock retry ─────────────────────────────────────────
// index.lock contention is transient in multi-session workspaces (another
// git process exiting, a concurrent session mid-add). Bubbling it up to the
// LLM costs a full outer deliver_task retry (all pre-commit gates re-run,
// and the retried commit spawns a duplicate post-commit review worker).
// Retry in place with bounded backoff instead. The lock is NEVER deleted —
// it is likely held by a live process; on exhaustion the original error is
// returned unchanged.
const LOCK_RETRY_DELAYS_MS = [1000, 2000, 4000]

function isLockContention(output: string): boolean {
  const lower = output.toLowerCase()
  return lower.includes('index.lock') && (lower.includes('file exists') || lower.includes('another git process'))
}

/** Classify owned paths before `git add`: a path missing from BOTH the worktree
 *  and the git index is stale — its deletion was already committed by another
 *  session. Staging it fails with a raw "pathspec did not match" error that
 *  costs a full outer deliver_task retry. Skip and report instead. A missing
 *  worktree copy still present in the index is a staged deletion (D status):
 *  `git add -- <path>` stages the removal, so it must be kept. */
async function classifyStalePaths(cwd: string, files: string[], signal?: AbortSignal): Promise<{ addable: string[]; stale: string[] }> {
  const addable: string[] = []
  const missing: string[] = []
  for (const f of files) {
    if (existsSync(join(cwd, f))) addable.push(f)
    else missing.push(f)
  }
  if (missing.length === 0) return { addable, stale: [] }
  const ls = await runGit(cwd, ['ls-files', '-z', '--', ...missing], signal)
  const inIndex = new Set(ls.ok ? ls.output.split('\0').filter(Boolean) : [])
  const stale: string[] = []
  for (const f of missing) {
    if (inIndex.has(f)) addable.push(f) // deletion not yet staged — git add stages it
    else stale.push(f)                  // gone from the index too — committed externally
  }
  return { addable, stale }
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash
}

/** 把失配类型翻译成一句能指导下一步的话。 */
function describeVersionDiff(kind: VersionDiffKind, expected: CommitVersion, current: CommitVersion, phase?: string): string {
  const suffix = phase ? ` (${phase})` : ''
  if (kind === 'head-changed') return `HEAD moved during commit${suffix}: ${shortHash(expected.head)} → ${shortHash(current.head)}.`
  if (kind === 'index-changed') return `Git index changed during commit${suffix} (another process staged or unstaged files).`
  return `Selected file content changed after the preview was captured${suffix}.`
}

/**
 * 基准读不出来单独成类：这不是「HEAD 变了」，重试也不会变。
 * 旧实现把敏感文件 / 路径逃逸 / git 失败一律报成「HEAD or index changed」，
 * 使用者沿 HEAD 排查两轮才发现方向错了（issue #537）。
 */
function baselineUnavailable(capture: Extract<CommitVersionCapture, { ok: false }>): ScopedCommitResult {
  return {
    ok: false,
    reason: 'version-unavailable',
    detail: `${capture.code}: ${capture.detail}`,
    output: `Cannot read the commit baseline: ${capture.code} (${capture.detail}). No commit was attempted — retrying fails the same way; fix the baseline first.`,
  }
}

export async function commitScopedFiles(input: ScopedCommitInput): Promise<ScopedCommitResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(input.timeoutMs ?? 120_000), ...(input.signal ? [input.signal] : [])])
  signal.throwIfAborted()
  if (!input.message.trim()) return { ok: false, reason: 'empty-message', output: 'Commit message is required.' }

  const files = normalizeFiles(input.cwd, input.files)
  if (files.length === 0) return { ok: false, reason: 'empty-files', output: 'No owned files to commit.' }

  const { addable, stale } = await classifyStalePaths(input.cwd, files, signal)
  if (addable.length === 0) {
    return {
      ok: false,
      reason: 'all-stale',
      output: `No owned files to commit: every owned path is stale — already deleted and committed by another session: ${stale.join(', ')}. Refresh the owned set before retrying.`,
    }
  }
  const staleNote = stale.length > 0
    ? `⚠ Skipped ${stale.length} stale path(s) already committed externally: ${stale.join(', ')}\n`
    : ''

  // 调用方的 expectedVersion 是按「原始提交集合」捕获的，而 current 按剔除 stale
  // 后的 addable 捕获。captureCommitVersion 的 files 哈希输入含路径列表，两个集合
  // 天然不可比——stale 非空时必然失配（issue #537 的 B 项）。stale 存在时按 addable
  // 重新对齐基准：漂移检测窗口从调用方捕获时刻缩短到本函数内，紧随其后的半暂存检查仍在。
  //
  // 判序不可换：先确认基准捕获成功，再看两段是否不同。写反了就会把「基准读不出
  // （敏感文件 / 路径逃逸 / git 失败）」读成「文件内容变了」。
  const expectedCapture: CommitVersionCapture = stale.length === 0 && input.expectedVersion
    ? { ok: true, version: input.expectedVersion }
    : await captureCommitVersionDetailed(input.cwd, addable, { signal })
  if (!expectedCapture.ok) return baselineUnavailable(expectedCapture)
  const expected = expectedCapture.version
  const currentCapture = await captureCommitVersionDetailed(input.cwd, addable, { signal })
  if (!currentCapture.ok) return baselineUnavailable(currentCapture)
  const versionDiff = diffCommitVersion(expected, currentCapture.version)
  if (versionDiff) {
    return { ok: false, reason: versionDiff, output: describeVersionDiff(versionDiff, expected, currentCapture.version) }
  }
  const staged = await runGit(input.cwd, ['diff', '--cached', '--name-only', '-z', '--', ...addable], signal)
  const unstaged = await runGit(input.cwd, ['diff', '--name-only', '-z', '--', ...addable], signal)
  if (!staged.ok || !unstaged.ok) return { ok: false, reason: 'index-unreadable', output: 'Cannot verify selected index contents.' }
  const unstagedPaths = new Set(unstaged.output.split('\0').filter(Boolean))
  if (staged.output.split('\0').some(file => unstagedPaths.has(file))) {
    return { ok: false, reason: 'partially-staged', output: 'Selected file is partially staged. Separate its hunks or explicitly commit the reviewed index in Git; no files were staged.' }
  }

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const retryCapture = await captureCommitVersionDetailed(input.cwd, addable, { signal })
    if (!retryCapture.ok) return baselineUnavailable(retryCapture)
    const retryVersion = retryCapture.version
    if (retryVersion.head !== expected.head || retryVersion.files !== expected.files) {
      const retryKind = retryVersion.head !== expected.head ? 'retry-head-changed' : 'retry-files-changed'
      const baseKind: VersionDiffKind = retryVersion.head !== expected.head ? 'head-changed' : 'files-changed'
      return { ok: false, reason: retryKind, output: describeVersionDiff(baseKind, expected, retryVersion, 'during retry') }
    }
    // add is idempotent — safe to re-run when the commit step hit a lock.
    const add = await runGit(input.cwd, ['add', '--', ...addable], signal)
    if (!add.ok) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt]
      if (delay !== undefined && isLockContention(add.output)) {
        await delayWait(delay, signal)
        continue
      }
      return { ok: false, reason: 'git-add-failed', output: add.output }
    }

    const readyCapture = await captureCommitVersionDetailed(input.cwd, addable, { signal })
    if (!readyCapture.ok) return baselineUnavailable(readyCapture)
    const ready = readyCapture.version
    if (ready.head !== expected.head || ready.files !== expected.files) {
      const stagingKind = ready.head !== expected.head ? 'staging-head-changed' : 'staging-files-changed'
      const baseKind: VersionDiffKind = ready.head !== expected.head ? 'head-changed' : 'files-changed'
      return {
        ok: false,
        reason: stagingKind,
        output: `${describeVersionDiff(baseKind, expected, ready, 'during staging')} Changes remain available for review.`,
      }
    }
    const commit = await runGit(input.cwd, ['-c', 'core.abbrev=64', 'commit', '-m', input.message, '--only', '--', ...addable], signal)
    if (!commit.ok && commit.interrupted) {
      const observed = await captureCommitVersionAsync(input.cwd, addable)
      return {
        ok: false,
        reason: 'commit-interrupted',
        output: observed?.head !== expected.head ? 'Commit outcome uncertain: HEAD changed. Inspect Git before retrying.' : 'Commit interrupted; inspect Git before retrying.',
      }
    }
    if (!commit.ok) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt]
      if (delay !== undefined && isLockContention(commit.output)) {
        await delayWait(delay, signal)
        continue
      }
      // Provide friendlier error for common "nothing changed" case
      const lower = commit.output.toLowerCase()
      if (lower.includes('nothing to commit') || lower.includes('no changes')) {
        return {
          ok: false,
          reason: 'nothing-to-commit',
          output: `No changes in owned files to commit (${addable.join(', ')}). Files may have been committed already or not modified.`,
        }
      }
      return { ok: false, reason: 'git-commit-failed', output: commit.output }
    }
    const commitSha = [...(commit.stdout ?? '').matchAll(/^\[[^\]\r\n]+ ([a-f0-9]{40,64})\]/gm)].at(-1)?.[1]
    return { ok: true, output: staleNote + commit.output, commitSha }
  }
}

function normalizeFiles(cwd: string, files: string[]): string[] {
  const normalized = files
    .map(file => {
      const resolved = resolve(cwd, file)
      const rel = relative(cwd, resolved)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
      return rel.replace(/\\/g, '/')
    })
    .filter((file): file is string => file !== null)
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b))
}

async function delayWait(ms: number, signal: AbortSignal): Promise<void> { await delay(ms, undefined, { signal }) }

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<ScopedCommitResult & { interrupted?: boolean; stdout?: string }> {
  const result = await gitCommand(cwd, args, { signal })
  const output = `${result.stdout}${result.stderr}`.trim()
  return { ok: result.status === 0, output: output || (result.status === 0 ? '' : `git ${args[0] ?? 'command'} failed`), stdout: result.stdout, interrupted: result.interrupted }
}
