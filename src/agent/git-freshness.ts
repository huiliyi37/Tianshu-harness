import { spawnGit } from '../tools/spawn-git.js'
import { track } from '../tools/process-tracker.js'

/**
 * Execute a short-lived git command and capture its stdout.
 * Returns the trimmed stdout or empty string on any failure.
 */
function gitSpawn(
  args: string[],
  cwd: string,
  // 400ms：100ms 在 Windows（git 冷启动 80–150ms，实测裸启动 75–123ms）与
  // 负载机器上频繁超时，探针静默返回空 → changeRate 恒 0（信号失明，感知
  // 间隔永不按活跃度收缩）。本函数整体异步（turn-orchestrator 后台 .then
  // 调用），最坏 6 次调用 2.4s 也不进主循环路径。
  timeoutMs = 400,
): Promise<string> {
  return new Promise(resolve => {
    const child = track(spawnGit(args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
    }))

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000)
    })

    child.on('close', () => resolve(stdout.trim()))
    child.on('error', () => resolve(''))
  })
}

/**
 * Get the number of tracked files in the git repository.
 * Returns 0 if not a git repo or on any error.
 */
async function getTrackedFileCount(cwd: string): Promise<number> {
  const out = await gitSpawn(['ls-files'], cwd)
  if (!out) return 0
  return out.split('\n').filter(Boolean).length
}

/**
 * Get the number of files changed in the last N commits.
 *
 * Uses `git diff --stat HEAD~N --numstat` to count changed files.
 * Falls back gracefully:
 * - If HEAD~N doesn't exist, progressively tries HEAD~(N-1), HEAD~(N-2), ... HEAD~1
 * - If none exist (only 1 commit in repo), returns 0
 * - If not a git repo, returns 0
 *
 * @param cwd - Working directory (git repo root)
 * @param lookback - Number of commits to look back (default 5)
 * @returns Number of files changed in the lookback window
 */
async function getChangedFileCount(
  cwd: string,
  lookback: number,
): Promise<number> {
  // Progressively reduce lookback until we find a valid ref
  for (let n = lookback; n >= 1; n--) {
    const out = await gitSpawn(
      ['diff', '--numstat', `HEAD~${n}`],
      cwd,
    )
    if (out) {
      return out.split('\n').filter(Boolean).length
    }
  }
  return 0
}

/**
 * Compute the file change rate in a git repository.
 *
 * changeRate = filesChangedInLookback / totalTrackedFiles
 *
 * This is a pure I/O function — no side effects, no LLM overhead.
 * Returns 0 for non-git directories, empty repos, or on any error.
 *
 * @param cwd - Working directory (git repo root)
 * @param lookback - Number of commits to look back (default 5)
 * @returns Change rate in [0, 1]
 */
export async function getGitChangeRate(
  cwd: string,
  lookback = 5,
): Promise<number> {
  const changed = await getChangedFileCount(cwd, lookback)
  if (changed === 0) return 0

  const total = await getTrackedFileCount(cwd)
  if (total === 0) return 0

  return Math.min(1, changed / total)
}

/**
 * Apply exponential moving average smoothing to a change rate signal.
 *
 * Formula: smoothed = α × raw + (1-α) × prev
 * Result is clamped to [0, 1].
 *
 * Inspired by circadian clock entrainment: the raw signal (Zeitgeber)
 * gradually pulls the smoothed value toward it, preventing jitter.
 *
 * @param raw - Raw change rate from the current sampling (0-1)
 * @param prev - Previous smoothed value (0-1)
 * @param alpha - Smoothing factor (0-1). Default 0.3.
 *                Higher = faster response to changes.
 * @returns Smoothed change rate in [0, 1]
 */
export function smoothChangeRate(
  raw: number,
  prev: number,
  alpha = 0.3,
): number {
  const rawClamped = Math.max(0, Math.min(1, raw))
  const smoothed = alpha * rawClamped + (1 - alpha) * prev
  return Math.max(0, Math.min(1, smoothed))
}
