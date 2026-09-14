import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

interface GitStatusCacheOptions {
  ttlMs: number
  now: () => number
  load: (cwd: string) => Promise<string | undefined>
}

export function formatGitStatus(branch: string, status: string): string | undefined {
  if (!branch && !status) return undefined
  return `Current branch: ${branch}\nStatus:\n${status || '(clean)'}`
}

async function loadGitStatus(cwd: string): Promise<string | undefined> {
  try {
    const [branchResult, statusResult, logResult] = await Promise.all([
      execFileP('git', ['branch', '--show-current'], { cwd, timeout: 5000, windowsHide: true }),
      execFileP('git', ['status', '--short'], { cwd, timeout: 5000, windowsHide: true }),
      execFileP('git', ['log', '--oneline', '-5'], { cwd, timeout: 5000, windowsHide: true }).catch(() => ({ stdout: '' })),
    ])
    const base = formatGitStatus(branchResult.stdout.trim(), statusResult.stdout.trim())
    const log = logResult.stdout.trim()
    if (!base && !log) return undefined
    return log ? `${base ?? ''}\nRecent commits:\n${log}` : base
  } catch {
    return undefined
  }
}

const MAX_CACHED_CWDS = 50

function trimCache<V>(map: Map<string, { value: V; timestamp: number }>, ttlMs: number): void {
  if (map.size <= MAX_CACHED_CWDS) return
  const now = Date.now()
  for (const [key, val] of map) {
    if (now - val.timestamp > ttlMs) map.delete(key)
  }
  while (map.size > MAX_CACHED_CWDS) {
    const [key] = map.keys()
    map.delete(key!)
  }
}

export function createGitStatusCache(options: GitStatusCacheOptions) {
  const values = new Map<string, { value: string | undefined; timestamp: number }>()
  const refreshing = new Map<string, Promise<void>>()

  const isFresh = (cwd: string) => {
    const entry = values.get(cwd)
    return !!entry && options.now() - entry.timestamp < options.ttlMs
  }

  return {
    get(cwd: string): string | undefined {
      trimCache(values, options.ttlMs)
      return values.get(cwd)?.value
    },

    prime(cwd: string, nextValue: string | undefined): void {
      values.set(cwd, { value: nextValue, timestamp: options.now() })
      trimCache(values, options.ttlMs)
    },

    async refresh(cwd: string): Promise<void> {
      const existing = refreshing.get(cwd)
      if (existing) return existing
      const work = options.load(cwd).then(nextValue => {
        values.set(cwd, { value: nextValue, timestamp: options.now() })
        trimCache(values, options.ttlMs)
      }).finally(() => {
        refreshing.delete(cwd)
      })
      refreshing.set(cwd, work)
      return work
    },

    /**
     * Awaitable variant: triggers refresh only if the cache is stale.
     * Call this before building a prompt to eliminate the 30s staleness blind spot
     * while keeping the synchronous get() path side-effect free.
     */
    async refreshIfStale(cwd: string): Promise<void> {
      if (!isFresh(cwd)) {
        await this.refresh(cwd)
      }
    },
  }
}

export const gitStatusCache = createGitStatusCache({
  ttlMs: 30_000,
  now: () => Date.now(),
  load: loadGitStatus,
})

/** Structured git context for worktree-reality detection (avoids regex on display strings). */
export interface GitInjectedContext {
  branch?: string
  head?: string
}

export async function getGitInjectedContext(cwd: string): Promise<GitInjectedContext | undefined> {
  try {
    const [branchResult, headResult] = await Promise.all([
      execFileP('git', ['branch', '--show-current'], { cwd, timeout: 5000, windowsHide: true }),
      execFileP('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000, windowsHide: true }),
    ])
    const branch = branchResult.stdout.trim() || undefined
    const head = headResult.stdout.trim() || undefined
    if (!branch && !head) return undefined
    return { branch, head }
  } catch {
    return undefined
  }
}
