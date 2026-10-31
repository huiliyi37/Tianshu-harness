import { spawnGitSync } from '../tools/spawn-git.js'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface ScopeMaterializeResult {
  /** Relative file paths copied from the base repo into the worker worktree. */
  materialized: string[]
  /**
   * Scope entries that are outside the repo (path escape / absolute path
   * resolving outside the base). These are genuinely unreachable and should
   * cause a worker block.
   */
  missing: string[]
  /**
   * Valid relative paths whose files don't yet exist in the base repo.
   * The worker is expected to CREATE these files — not read them — so
   * consumers should NOT treat these as errors (see T1 fix: the old code
   * lumped these into `missing` and killed all new-file patcher tasks).
   */
  toBeCreated: string[]
}

function normalizeScopePath(baseCwd: string, filePath: string): string | null {
  // 词法收容：把相对/绝对两种形态都先 resolve 到 base 下再判是否仍在 base 内。
  // 旧实现把相对路径原样返回，于是 `../x`、`sub/../../x` 这类条目在 join
  // 之后才归一化出逃逸——workerPath 与 basePath 双双落在 repo 外，收容全靠
  // 调用方事先过滤（hands 路径的 scope 直接来自 work order，无此过滤）。
  // win32 跨盘时 relative 无法表达相对路径，原样返回目标的绝对路径——这同样是
  // 「解析到 repo 外」，必须判为 null。漏判会让 `D:\other\x.ts`
  // 这类跨盘路径落进 toBeCreated、诱导 worker 去"创建"一个 repo 外路径。
  // （`/etc/passwd` 在 Windows 上解析为「当前盘根下的 etc/passwd」，命中的也是这条。）
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(baseCwd, filePath)
  const rel = relative(resolve(baseCwd), resolved)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

function workerGitPath(workerCwd: string, gitPath: string): string | null {
  const result = spawnGitSync(['rev-parse', '--git-path', gitPath], {
    cwd: workerCwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  const resolved = result.stdout.trim()
  if (!resolved) return null
  return isAbsolute(resolved) ? resolved : resolve(workerCwd, resolved)
}

/**
 * Append the materialized path to the worker's git exclude — but ONLY when the
 * worker owns a private exclude file. For a linked worktree (VSW snapshots,
 * worktree-based hands workers) `git rev-parse --git-path info/exclude`
 * resolves to the MAIN repo's shared `.git/info/exclude`; appending there
 * poisons the base repo: the excluded source files vanish from `git status`,
 * the delivery gate demotes them to "historical owned", and `git commit`
 * rejects them as ignored (session 4df36bcd postmortem). Skipping the append
 * for shared excludes is the lesser evil — the worker's status shows the
 * materialized files as untracked, which downstream junk-filtering tolerates.
 */
function excludeFromWorkerDiff(workerCwd: string, relPath: string): void {
  const gitDir = gitRevParse(workerCwd, '--git-dir')
  const commonDir = gitRevParse(workerCwd, '--git-common-dir')
  // Linked worktree: git-dir (.git/worktrees/<id>) differs from common dir
  // (.git) and info/exclude lives in the SHARED common dir. Never write there.
  if (!gitDir || !commonDir || resolve(gitDir) !== resolve(commonDir)) return
  const excludePath = workerGitPath(workerCwd, 'info/exclude')
  if (!excludePath) return
  mkdirSync(dirname(excludePath), { recursive: true })
  appendFileSync(excludePath, `\n/${relPath}\n`)
}

function gitRevParse(workerCwd: string, flag: '--git-dir' | '--git-common-dir'): string | null {
  const result = spawnGitSync(['rev-parse', flag], {
    cwd: workerCwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  const resolved = result.stdout.trim()
  if (!resolved) return null
  return isAbsolute(resolved) ? resolved : resolve(workerCwd, resolved)
}

/**
 * Ensure files explicitly scoped for a hands worker are visible in its isolated
 * worktree. Git worktrees only contain tracked HEAD files; untracked local plan
 * docs or scratch files must be copied in before the worker can read them.
 */
export function materializeScope(
  baseCwd: string,
  workerCwd: string,
  scopeFiles: string[],
): ScopeMaterializeResult {
  const materialized: string[] = []
  const missing: string[] = []
  const toBeCreated: string[] = []

  for (const filePath of scopeFiles) {
    const relPath = normalizeScopePath(baseCwd, filePath)
    if (!relPath) {
      missing.push(filePath)
      continue
    }

    const workerPath = join(workerCwd, relPath)
    if (existsSync(workerPath)) continue

    const basePath = join(baseCwd, relPath)
    if (!existsSync(basePath)) {
      // Valid repo-relative path but file doesn't exist yet — worker is
      // expected to CREATE it (e.g. new source file in a patcher task).
      // Do NOT block: the old behaviour lumped these into `missing` and
      // killed every new-file-creating delegation (T1 fix, 2026-07-29).
      toBeCreated.push(relPath)
      continue
    }

    // 符号链接守卫：copyFileSync 会跟随链接，于是 repo 内一条指向 repo 外的
    // 软链会把外部字节以普通文件形式拷进 worker 工作树——worker 的隔离边界
    // 本是"仅可见 scope 内的 repo 文件"，就此被绕过（candidateSnapshotRef
    // 对同一问题已有 realpath-inside 判定，此处补齐）。指向 repo 内的链接
    // 保持原有复制行为。lstat/realpath 竞态（文件在检查间消失）时落入下
    // 面的复制，让复制本身报出真实错误，不凭空捏造一个 missing。
    try {
      if (lstatSync(basePath).isSymbolicLink()) {
        const target = realpathSync(basePath)
        const inside = relative(realpathSync(baseCwd), target)
        if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
          missing.push(filePath)
          continue
        }
      }
    } catch {
      // fall through to copyFileSync, which reports the real failure
    }

    mkdirSync(dirname(workerPath), { recursive: true })
    copyFileSync(basePath, workerPath)
    excludeFromWorkerDiff(workerCwd, relPath)
    materialized.push(relPath)
  }

  return { materialized, missing, toBeCreated }
}
