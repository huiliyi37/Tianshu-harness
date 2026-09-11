import type { ChildProcess } from 'child_process'
import { spawnSyncHidden } from './spawn-hidden.js'

type KillFn = (pid: number, signal: NodeJS.Signals) => void

type KillableChild = Pick<ChildProcess, 'pid' | 'kill'>

const isWin = process.platform === 'win32'

/**
 * Cross-platform process tree termination.
 *
 * Unix: uses the `kill` function (defaults to process.kill) with negative PID
 *       for process group termination. Falls back to child.kill() on error.
 * Windows: uses taskkill /T (graceful) or /T /F (force), since negative PIDs
 *          and POSIX signals are not supported.
 */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  kill: KillFn = process.kill,
): void {
  if (!child.pid) return

  if (isWin) {
    const args = signal === 'SIGKILL'
      ? ['/F', '/T', '/PID', String(child.pid)]
      : ['/T', '/PID', String(child.pid)]
    try {
      spawnSyncHidden('taskkill', args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } catch {
      // Best-effort
    }
    return
  }

  // Unix: preserve existing behavior (negative PID = process group)
  try {
    kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { }
  }
}
