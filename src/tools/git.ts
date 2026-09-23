import { spawnGit } from './spawn-git.js'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'
import { relativePosix } from '../path-format.js'
import { auditCommitTagScope } from './commit-audit.js'
import { createWorkspaceGuard } from '../agent/workspace-guard.js'
import { killProcessTree } from './process-kill.js'
import { detectSensitiveFile } from './sensitive-file-detector.js'

const ACTIONS = ['status', 'diff_summary', 'commit', 'log', 'log_graph', 'stash', 'stash_pop'] as const
type GitAction = (typeof ACTIONS)[number]

const MAX_OUTPUT = 50_000
const GIT_TIMEOUT = 10_000
const FORCE_KILL_DELAY = 3_000

/**
 * Run a git command asynchronously with proper process cleanup on timeout.
 *
 * Uses spawn with detached:true + process-group kill (-pid) to ensure
 * the entire git process tree is killed on timeout — prevents zombie
 * processes that would otherwise accumulate and eventually freeze the TUI.
 */
async function runGit(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // Prefix every git invocation with `-c core.quotePath=false` so non-ASCII
    // file paths in diff/status/log output are emitted verbatim instead of
    // octal-escaped. UTF-8 (rather than WinStreamDecoder's GBK auto-detection)
    // is forced below because git output bytes always mirror the source file
    // (modern git defaults to UTF-8) — a GBK probe only risks misjudging the
    // whole stream when a chunk boundary splits a multibyte character.
    const child = spawnGit(['-c', 'core.quotePath=false', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached: true breaks stdio pipes on Windows — see bash.ts fix for details.
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
    }

    const finish = (output: string, error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(output)
    }

    // 用户中止：协作式取消，沿袭 bash.ts 的 killProcessTree 两级终止模式。
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      killProcessTree(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), FORCE_KILL_DELAY)
      resolve('Aborted by user.')
    }
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    // git output is always UTF-8 (mirrors the source file; modern git defaults
    // to UTF-8). Decode it directly instead of WinStreamDecoder's GBK probe,
    // which misjudges the whole stream when the first chunk splits a multibyte
    // CJK character and turns diff bodies to mojibake on Windows. { stream: true }
    // holds an incomplete trailing sequence across chunks, so a split
    // multibyte boundary is never lost.
    const stdoutDecoder = new TextDecoder('utf-8')
    const stderrDecoder = new TextDecoder('utf-8')

    child.stdout!.on('data', (data: Buffer) => { stdout += stdoutDecoder.decode(data, { stream: true }) })
    child.stderr!.on('data', (data: Buffer) => { stderr += stderrDecoder.decode(data, { stream: true }) })

    child.on('close', (code) => {
      if (settled) return
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      stdout += stdoutDecoder.decode()
      stderr += stderrDecoder.decode()
      if (code !== 0) {
        const err = new Error((stderr || '').trim() || `git 以状态码 ${code} 退出`)
        const gitErr = err as GitExitError
        gitErr.exitCode = code ?? 1
        // Preserve stdout even on non-zero exit — `git diff --no-index` exits 1
        // when files differ but prints the diff on stdout. Callers that need it
        // (getFileDiff fallback) read err.stdout via runGitExitCode.
        gitErr.stdout = stdout
        finish('', err)
      } else {
        let output = stdout
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT) + `\n\n[... 已截断至 ${MAX_OUTPUT} 字符，共 ${output.length}]`
        }
        finish(output)
      }
    })

    child.on('error', (err) => {
      if (settled) return
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      finish('', err)
    })

    // Timeout: SIGTERM first, then SIGKILL after FORCE_KILL_DELAY
    timer = setTimeout(() => {
      killProcessTree(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL')
        finish('', new Error('git 命令超时'))
      }, FORCE_KILL_DELAY)
    }, GIT_TIMEOUT)
  })
}

interface GitExitError extends Error { exitCode: number; stdout?: string }

/** runGit variant that returns exit code instead of throwing — for callers that need to distinguish exit codes.
 *  stdout is preserved on non-zero exit (e.g. `git diff --no-index` exits 1 with the diff on stdout). */
async function runGitExitCode(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const stdout = await runGit(args, cwd, abortSignal)
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const gitErr = err as GitExitError
    if (gitErr.exitCode !== undefined) return { code: gitErr.exitCode, stdout: gitErr.stdout ?? '', stderr: gitErr.message }
    throw err // non-exit errors (spawn failure, timeout) still throw
  }
}

/** runGit that returns {ok, output} instead of throwing — for callers that need error detail. */
async function runGitSafe(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  try {
    const output = await runGit(args, cwd, abortSignal)
    return { ok: true, output }
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err)
    return { ok: false, output }
  }
}

function normalizeProjectRelativePath(cwd: string, filePath: string): string | null {
  const resolved = resolve(cwd, filePath)
  // git pathspec 一律用 POSIX 分隔符：反斜杠在 git 眼里是转义字符，win32 上拿宿主
  // relative() 的结果去匹配会被 git 引号包裹并二次转义（`"a/策略\\涨停.js"`），非 ASCII
  // 路径与桌面端 diff 解析器一并失准。归一后 '..'/绝对路径判据在各平台也口径一致
  // （仓库约定见 path-format.ts）。跨盘符时 relative() 给绝对路径，isAbsolute 仍拦得住。
  const rel = relativePosix(cwd, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

function getScopedCommitFiles(cwd: string, ownedFiles: string[] | undefined, sessionModifiedFiles: string[] | undefined): string[] {
  // B1: prefer ownedFiles (post-baseline) over sessionModifiedFiles (pre-baseline)
  const source = (ownedFiles?.length ? ownedFiles : sessionModifiedFiles) ?? []
  if (!source.length) return []
  const files = source
    .map(filePath => normalizeProjectRelativePath(cwd, filePath))
    .filter((filePath): filePath is string => filePath !== null)
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

async function hasStagedChanges(cwd: string, pathspecs?: string[], abortSignal?: AbortSignal): Promise<boolean> {
  const args = ['diff', '--cached', '--quiet']
  if (pathspecs?.length) args.push('--', ...pathspecs)
  const { code } = await runGitExitCode(args, cwd, abortSignal)
  if (code === 0) return false // no staged changes
  if (code === 1) return true  // has staged changes
  throw new Error(`git diff --cached 失败，退出码 ${code}`)
}

/** Best-effort: create a safety ref before stash so changes are recoverable (P2). */
async function createSafetyRef(cwd: string, abortSignal?: AbortSignal): Promise<void> {
  try {
    const sha = (await runGit(['stash', 'create'], cwd, abortSignal)).trim()
    if (!sha) return
    await runGit(['update-ref', 'refs/kiro-safety/last-stash', sha], cwd, abortSignal)
  } catch { /* best-effort, never block stash */ }
}

/** Run `git log --graph --all --oneline --decorate` for the desktop Git graph view. */
export async function getGitGraph(cwd: string, maxCount = 200): Promise<string> {
  const count = Math.max(1, Math.min(maxCount, 500))
  return runGit(
    ['log', `--max-count=${count}`, '--graph', '--all', '--oneline', '--decorate', '--branches', '--remotes'],
    cwd,
  )
}

/** A single file's working-tree change relative to HEAD. */
export interface WorkingTreeFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
  /** True when the file is matched by the changes-tab ignore rules and is only
   *  visible because the caller passed `includeIgnored=true`. */
  ignored?: boolean
}

/** Parse `git diff HEAD --numstat` (+ untracked via status) into a file list.
 *  numstat gives "added\tdelted\tpath" per file; renames show as "R100\told\tnew". */
function parseWorkingTreeFiles(numstat: string, statusPorcelain: string): WorkingTreeFile[] {
  const files = new Map<string, WorkingTreeFile>()
  // numstat covers tracked changes (modified/added-to-index/deleted/rename)
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addStr, delStr, ...pathParts] = parts
    const path = pathParts.join('\t') // paths with tabs are pathological but safe
    // Binary files show as "-\t-\t..." — count as 0 to avoid NaN
    const additions = addStr === '-' ? 0 : parseInt(addStr!, 10) || 0
    const deletions = delStr === '-' ? 0 : parseInt(delStr!, 10) || 0
    files.set(path, { path, status: 'modified', additions, deletions })
  }
  // porcelain covers untracked (??) + precise status codes
  for (const line of statusPorcelain.split('\n')) {
    if (line.length < 3) continue
    const xy = line.slice(0, 2)
    let rawPath = line.slice(3)
    // rename: "R  old -> new" — porcelain prints the new path with a ->
    if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ').pop()!
    // strip surrounding quotes (core.quotepath)
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) rawPath = rawPath.slice(1, -1)
    const existing = files.get(rawPath)
    if (xy[1] === '?' || xy === '??') {
      // untracked — not in numstat; add with 0/0, status untracked
      if (!existing) files.set(rawPath, { path: rawPath, status: 'untracked', additions: 0, deletions: 0 })
    } else if (existing) {
      // refine status from porcelain xy code
      const code = xy[0] !== ' ' ? xy[0] : xy[1]
      existing.status =
        code === 'A' ? 'added'
        : code === 'D' ? 'deleted'
        : code === 'R' ? 'renamed'
        : 'modified'
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export interface GitBranchEntry {
  name: string
  current: boolean
}

/**
 * P4 补线 — 列出 cwd 仓库的真实本地分支（Codex 对标：branch picker 来自
 * `git for-each-ref`，而非任何硬编码预设）。当前分支由
 * `git rev-parse --abbrev-ref HEAD` 解析；detached HEAD 时 current 缺省。
 */
export async function listGitBranches(cwd: string): Promise<{
  branches: GitBranchEntry[]
  current?: string
  notARepo: boolean
}> {
  try {
    const [listRaw, currentRaw] = await Promise.all([
      runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd),
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    ])
    const current = currentRaw.trim()
    const names = listRaw
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && n !== 'HEAD')
    const seen = new Set<string>()
    const branches: GitBranchEntry[] = []
    for (const name of names) {
      if (seen.has(name)) continue
      seen.add(name)
      branches.push({ name, current: name === current })
    }
    return {
      branches,
      ...(current && current !== 'HEAD' ? { current } : {}),
      notARepo: false,
    }
  } catch {
    return { branches: [], notARepo: true }
  }
}

/**
 * List working-tree changes relative to `baseRef` (default HEAD) for the
 * desktop "changes" tab.
 * Uses `git diff <base> --numstat` (tracked) + `git status --porcelain` (untracked + status codes).
 * Lightweight: file list only, no diff body — the body is fetched per-file on demand via getFileDiff.
 * Returns `notARepo: true` (empty files) if cwd isn't a git repo, so the UI can degrade gracefully.
 *
 * Worktree sessions pass their recorded baseline commit as baseRef so the tab
 * shows the full task delta even after the agent commits mid-task.
 */
export async function getWorkingTreeFiles(
  cwd: string,
  baseRef = 'HEAD',
  includeIgnored = false,
): Promise<{ files: WorkingTreeFile[]; isRepo: boolean }> {
  const base = safeBaseRef(baseRef)
  const { ok: numstatOk, output: numstat } = await runGitSafe(['diff', base, '--numstat'], cwd)
  // git diff <base> fails if the ref doesn't exist (empty repo) — treat as "no tracked diff yet"
  const { ok: statusOk, output: statusOut } = await runGitSafe(['status', '--porcelain', '-uall'], cwd)
  if (!statusOk && !numstatOk) {
    // Both failed — likely not a git repo
    return { files: [], isRepo: false }
  }
  let files = parseWorkingTreeFiles(numstatOk ? numstat : '', statusOk ? statusOut : '')
  if (!includeIgnored) {
    files = files.filter((f) => !isChangesIgnored(f.path))
  } else {
    files = files.map((f) => ({ ...f, ignored: isChangesIgnored(f.path) }))
  }
  // Untracked files aren't in `git diff HEAD --numstat`, so their +N badge would
  // read 0. Backfill the addition count by reading the file and counting lines
  // (cheap, no spawn). Skip oversized/binary/unreadable files — badge stays 0.
  await backfillUntrackedAdditions(cwd, files)
  return { files, isRepo: true }
}

/** Default ignore rules for the desktop "changes" tab. These are runtime /
 *  generated artifacts that are not user source code. Kept separate from
 *  .gitignore so the tab can still show them on demand via `includeIgnored`.
 *
 *  Rule syntax:
 *    - starts with "*." → file extension match
 *    - otherwise      → substring match anywhere in the lower-cased path
 */
export const DEFAULT_CHANGES_IGNORE = [
  // Dependencies / build outputs
  'node_modules/', 'dist/', '.vite/',
  // Runtime / cache directories
  '.rivet/scratch/', '.rivet/plugin-', '.rivet/backups/', '.rivet/vsw/',
  '.rivet/artifacts/', '.rivet/sessions/', '.rivet/runtime/', '.rivet/checkpoints/',
  '.tmp', '.test-tmp', '.tmp-', '.tmp-abort-', '.tmp-iso-',
  // Local data / logs
  'logs/', 'Library/',
  // Release artifacts
  'release/',
  // Binaries / archives
  '*.dmg', '*.tar.gz', '*.tar.gz.sig', '*.app', '*.exe', '*.zip',
  // Temp / misc
  '_test-', '.DS_Store',
] as const

/** Return true if a path matches the default changes-tab ignore rules. */
export function isChangesIgnored(path: string): boolean {
  const lower = path.toLowerCase()
  for (const rule of DEFAULT_CHANGES_IGNORE) {
    const rl = rule.toLowerCase()
    if (rule.startsWith('*.')) {
      if (lower.endsWith(rl.slice(1))) return true
    } else if (lower.includes(rl)) {
      return true
    }
  }
  return false
}

/** Max bytes to read when counting lines of an untracked file for its +N badge. */
const UNTRACKED_COUNT_MAX_BYTES = 1_000_000

async function backfillUntrackedAdditions(cwd: string, files: WorkingTreeFile[]): Promise<void> {
  await Promise.all(
    files
      .filter((f) => f.status === 'untracked' && f.additions === 0)
      .map(async (f) => {
        const rel = normalizeProjectRelativePath(cwd, f.path)
        if (!rel) return
        try {
          const stat = await fsStat(resolve(cwd, rel))
          if (!stat.isFile() || stat.size > UNTRACKED_COUNT_MAX_BYTES) return
          const content = await fsReadFile(resolve(cwd, rel), 'utf8')
          if (content.includes('\u0000')) return // binary — leave badge at 0
          if (content.length === 0) return
          // Count lines like git: a trailing newline doesn't add an empty line.
          const nl = (content.match(/\n/g) ?? []).length
          f.additions = content.endsWith('\n') ? nl : nl + 1
        } catch {
          // unreadable — leave badge at 0
        }
      }),
  )
}

/**
 * Reject base refs that could be parsed as git options or revision ranges.
 * Accepts commit hashes, HEAD, and simple branch/tag names.
 */
function safeBaseRef(ref: string): string {
  const trimmed = ref.trim()
  if (!trimmed || trimmed.startsWith('-') || /[\s~^:.\\]/.test(trimmed)) return 'HEAD'
  return trimmed
}

/**
 * 平台空设备路径，供 `git diff --no-index` 渲染未跟踪文件的整文件 diff。
 * POSIX 是 `/dev/null`；Windows 上必须用裸 `NUL`——Git Bash 会替 shell 做 MSYS
 * 路径转换，但 Node 的 spawn 把参数原样交给原生 git.exe，git 会把 `/dev/null`
 * 当目录前缀拼成 `/dev/null/<rel>` → "Could not access"、stdout 为空。
 * `os.devNull` 在 win32 上给 `\\.\nul`，git 同样不认。
 * 抽成纯函数是为了让这个 win32 分支可在任意宿主上单测。
 */
export function nullDeviceFor(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

/**
 * Fetch the unified diff of a single file relative to `baseRef` (default
 * HEAD), for on-demand rendering in the desktop "changes" tab. Empty string =
 * no textual diff (binary file, or untracked with no base to diff against).
 */
export async function getFileDiff(cwd: string, path: string, baseRef = 'HEAD'): Promise<string> {
  // Guard against path traversal / pathspec injection — pathspec must be relative
  const rel = normalizeProjectRelativePath(cwd, path)
  if (!rel) throw new Error(`无效文件路径：${path}`)
  const base = safeBaseRef(baseRef)
  // Tracked changes (modified/deleted/staged) diff cleanly against the base.
  const tracked = await runGitSafe(['diff', base, '--', rel], cwd)
  if (tracked.ok && tracked.output.trim()) return tracked.output
  // New / untracked file: not in HEAD, so `git diff HEAD` is empty. Render the
  // whole file as additions via --no-index against the platform null device
  // (see nullDeviceFor). This exits 1 when the files differ (the normal case)
  // but prints the diff on stdout, which runGitExitCode preserves. Binary files
  // print "Binary files ... differ".
  const fallback = await runGitExitCode(['diff', '--no-index', '--', nullDeviceFor(), rel], cwd)
  const out = fallback.stdout
  if (out && out.trim()) return normalizeNoIndexHeader(out, rel)
  return tracked.ok ? tracked.output : ''
}

/**
 * Fetch a file's full content at `baseRef` (session task baseline). Used by
 * editor clients (VS Code extension) to render a native two-pane diff: the
 * left side is this base snapshot, the right side is the live working file.
 * Returns `exists:false` for files not present at the base (newly added).
 */
export async function getFileAtBase(
  cwd: string,
  path: string,
  baseRef = 'HEAD',
): Promise<{ exists: boolean; content: string }> {
  const rel = normalizeProjectRelativePath(cwd, path)
  if (!rel) throw new Error(`无效文件路径：${path}`)
  const base = safeBaseRef(baseRef)
  const shown = await runGitSafe(['show', `${base}:${rel}`], cwd)
  if (!shown.ok) return { exists: false, content: '' }
  return { exists: true, content: shown.output }
}

/**
 * `git diff --no-index <null-device> file` emits headers referencing the literal
 * paths (the null device, and the file path without a/ b/ prefixes). Rewrite the
 * `+++` header to the conventional `b/<rel>` form so the desktop diff parser
 * (which strips a leading `b/`) anchors line comments on the right file path.
 * `--- ` is normalized to POSIX `/dev/null` regardless of which null device the
 * platform actually passed — consumers key on that single spelling.
 */
function normalizeNoIndexHeader(diff: string, rel: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++ ')) return `+++ b/${rel}`
      if (line.startsWith('--- ')) return '--- /dev/null'
      return line
    })
    .join('\n')
}


export const GIT_TOOL: Tool = {
  definition: {
    name: 'git',
    description: `结构化 git 操作。Actions:
- status: 显示工作树状态、当前分支和文件改动
- diff_summary: 显示已暂存与未暂存改动的 diff 统计
- commit: 有本会话修改的文件时只提交这些文件；否则只提交已暂存的改动
- log: 显示最近提交历史（默认 20 条，可用 maxCount 配置）
- log_graph: 显示覆盖所有本地与远程引用的 ASCII 分支/合并图
- stash: 暂存当前工作目录改动

复杂 git 操作（branch、merge、rebase、push、pull）改用 bash 工具。`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: '要执行的 git 操作',
        },
        message: {
          type: 'string',
          description: '提交信息（commit action 必填）',
        },
        maxCount: {
          type: 'number',
          description: 'log 条目最大数量（默认 20，用于 log action）',
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams) {
    const action = params.input.action as GitAction
    const cwd = params.cwd

    if (!ACTIONS.includes(action)) {
      return { content: `未知 action：${action}。支持：${ACTIONS.join(', ')}`, isError: true }
    }

    try {
      switch (action) {
        case 'status': {
          const [branch, porcelain, untracked] = await Promise.all([
            runGit(['branch', '--show-current'], cwd, params.abortSignal),
            runGit(['status', '--porcelain'], cwd, params.abortSignal),
            runGit(['ls-files', '--others', '--exclude-standard'], cwd, params.abortSignal),
          ])
          const lines = [`分支：${branch.trim()}`]
          const porcelainTrimmed = porcelain.trim()
          if (!porcelainTrimmed) {
            lines.push('状态：干净')
          } else {
            lines.push('变更：', porcelainTrimmed)
          }
          const untrackedTrimmed = untracked.trim()
          if (untrackedTrimmed) {
            lines.push('未跟踪：', untrackedTrimmed)
          }
          return { content: lines.join('\n') }
        }

        case 'diff_summary': {
          const [staged, unstaged] = await Promise.all([
            runGit(['diff', '--cached', '--stat'], cwd, params.abortSignal),
            runGit(['diff', '--stat'], cwd, params.abortSignal),
          ])
          const lines: string[] = []
          const stagedTrimmed = staged.trim()
          const unstagedTrimmed = unstaged.trim()
          if (stagedTrimmed) lines.push('已暂存：', stagedTrimmed)
          if (unstagedTrimmed) lines.push('未暂存：', unstagedTrimmed)
          if (!stagedTrimmed && !unstagedTrimmed) lines.push('无变更。')
          return { content: lines.join('\n') }
        }

        case 'commit': {
          const message = params.input.message as string
          if (!message) {
            return { content: 'commit 需要 "message" 参数。', isError: true }
          }

          const scopedFiles = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
          // 敏感文件硬门：将要暂存或已暂存的文件名先过 detectSensitiveFile——凭据/密钥
          // 文件不得入库（文件可能经 bash 写入工作区，绕过了文件工具的 validatePath 校验，
          // 这是入库前的最后一道闸）。fail-closed：只按文件名判，白名单照常生效。
          const sensitiveScoped = scopedFiles.filter(f => detectSensitiveFile(f).sensitive)
          if (sensitiveScoped.length > 0) {
            return {
              content: `敏感文件拦截：commit 范围含凭据/密钥文件（${sensitiveScoped.join(', ')}），已中止。阅读或提交凭据/密钥文件不被允许；如确为模板/样例，请改用 .example 后缀或移入 fixtures/ 白名单目录。`,
              isError: true,
            }
          }
          const commitArgs = ['commit', '-m', message]
          if (scopedFiles.length > 0) {
            await runGit(['add', '--', ...scopedFiles], cwd, params.abortSignal)
            commitArgs.push('--only', '--', ...scopedFiles)
          } else if (!(await hasStagedChanges(cwd, undefined, params.abortSignal))) {
            return {
              content: '未提供会话归属文件给 git commit，且不存在已暂存变更。请使用 deliver_task 并设 commit=true 做归属范围内交付，或在你有意手动管理 git 时显式暂存文件。',
              isError: true,
            }
          } else {
            // 无会话归属文件时提交的是「已暂存」内容——暂存名单同样过敏感门。
            const stagedList = await runGitSafe(['diff', '--cached', '--name-only'], cwd, params.abortSignal)
            const sensitiveStaged = stagedList.output
              .split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 0)
              .filter(f => detectSensitiveFile(f).sensitive)
            if (sensitiveStaged.length > 0) {
              return {
                content: `敏感文件拦截：已暂存内容含凭据/密钥文件（${sensitiveStaged.join(', ')}），已中止提交。请先 git restore --staged 排除这些文件。`,
                isError: true,
              }
            }
          }

          const commitResult = await runGitSafe(commitArgs, cwd, params.abortSignal)
          if (!commitResult.ok) {
            const timedOut = /超时|timed out/i.test(commitResult.output)
            return {
              content: `git commit 失败：${commitResult.output}`,
              isError: true,
              ...(timedOut ? { errorKind: 'timeout' as const } : {}),
            }
          }

          // Post-commit truth readback: show actual landed changes + audit tag scope
          const changed = (await runGit(['show', '--stat', '--format=%h%d', 'HEAD'], cwd, params.abortSignal)).trim()
          // --stat file rows contain '|'; this excludes the %h%d header line and the summary line
          const changedFiles = changed.split('\n')
            .filter(l => l.includes('|'))
            .map(l => l.split('|')[0]!.trim())
            .filter(f => f.length > 0)
          const audit = auditCommitTagScope(message, changedFiles)
          const body = `${commitResult.output.trim()}\n\n--- 实际变更（git show --stat）---\n${changed}`
          return { content: audit.ok ? body : `${body}\n\n${audit.message}` }
        }

        case 'log': {
          const maxCount = Math.max(1, Math.min((params.input.maxCount as number) ?? 20, 100))
          const log = (await runGit(['log', `--max-count=${maxCount}`, '--oneline', '--decorate'], cwd, params.abortSignal)).trim()
          return { content: log || '尚无提交。' }
        }

        case 'log_graph': {
          const maxCount = Math.max(1, Math.min((params.input.maxCount as number) ?? 200, 500))
          const graph = (
            await runGit(
              [
                'log',
                `--max-count=${maxCount}`,
                '--graph',
                '--all',
                '--oneline',
                '--decorate',
                '--branches',
                '--remotes',
              ],
              cwd,
              params.abortSignal,
            )
          ).trimEnd()
          return { content: graph || '尚无提交。' }
        }

        case 'stash': {
          const stashStatus = (await runGit(['status', '--porcelain'], cwd, params.abortSignal)).trim()
          if (!stashStatus) {
            return { content: '没有可 stash 的变更。' }
          }

          // B1: scope stash to owned files when available
          if (params.ownedFiles?.length) {
            const scoped = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
            if (scoped.length === 0) {
              return {
                content: '没有可 stash 的归属文件。外部脏文件存在，但已排除在 stash 范围外。',
                isError: true,
              }
            }
            await createSafetyRef(cwd, params.abortSignal)
            await runGit(['stash', 'push', '--', ...scoped], cwd, params.abortSignal)
            return { content: `已 stash ${scoped.length} 个归属文件：${scoped.join(', ')}` }
          }

          await createSafetyRef(cwd, params.abortSignal)
          await runGit(['stash'], cwd, params.abortSignal)
          return { content: '已保存工作区与索引状态。' }
        }

        case 'stash_pop': {
          const stashRef = (params.input.stashRef as string) || 'stash@{0}'
          const safety = await createWorkspaceGuard(cwd).checkStashSafety(stashRef)
          if (safety.blocked) {
            return { content: safety.reasons.join('\n'), isError: true }
          }
          await runGit(['stash', 'pop', stashRef], cwd, params.abortSignal)
          return { content: `已弹出 ${stashRef}（已做安全检查：无覆盖冲突）。` }
        }

        default:
          return { content: `未知 action：${action}。支持：${ACTIONS.join(', ')}`, isError: true }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const timedOut = /超时|timed out/i.test(message)
      return {
        content: `git ${action} 失败：${message}`,
        isError: true,
        ...(timedOut ? { errorKind: 'timeout' as const } : {}),
      }
    }
  },

  requiresApproval(params: ToolCallParams): boolean {
    return (params.input.action as string) === 'commit'
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
