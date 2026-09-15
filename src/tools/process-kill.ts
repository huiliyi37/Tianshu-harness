import type { ChildProcess } from 'child_process'
import { spawnSync } from 'node:child_process'

type KillFn = (pid: number, signal: NodeJS.Signals) => void

type KillableChild = Pick<ChildProcess, 'pid' | 'kill'>

/** taskkill 执行器（注入用：测试里替换成记录器，不真杀进程）。 */
export type RunTaskkill = (args: string[]) => void

function defaultRunTaskkill(args: string[]): void {
  try {
    spawnSync('taskkill', args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    })
  } catch {
    // Best-effort
  }
}

/**
 * Windows 上 taskkill 的参数：**始终带 `/F`**。
 *
 * 历史实现分两级：`SIGTERM` → `taskkill /T`（视作"优雅"），3 秒后 `SIGKILL` → `taskkill /F /T`（强制）。
 * 但 issue #144 的实测表明：**不带 `/F` 的 taskkill 对 console 子进程是 no-op** ——
 * 系统会把每个 PID 都回成「无法终止 PID …。原因: 只能强制终止此进程(带 /F 选项)」，
 * 因为 console 子进程收不到 WM_CLOSE。也就是说那 3 秒"优雅期"在 Windows 上纯空转：
 * 端口与文件锁白占 3 秒，而子进程一个都没被回收。
 *
 * 所以 Windows 侧不再区分信号，一律带 `/F`，让超时/中止路径立即回收直接子进程。
 *
 * 注意：这并**不解决** #144 本身（Git Bash/MSYS 派生的后台孙进程仍会逃过 `taskkill /T`，
 * 其 Win32 父链在 `nohup` 处断开）。它是一个独立的、无争议的改进。
 */
export function taskkillArgs(pid: number): string[] {
  return ['/F', '/T', '/PID', String(pid)]
}

/**
 * Cross-platform process tree termination.
 *
 * Unix: uses the `kill` function (defaults to process.kill) with negative PID
 *       for process group termination. Falls back to child.kill() on error.
 * Windows: uses taskkill /F /T (negative PIDs and POSIX signals are not supported;
 *          the non-/F "graceful" pass is a no-op for console children — see
 *          taskkillArgs and issue #144).
 *
 * `platform` / `runTaskkill` are test seams: they let the Windows branch be
 * exercised on any CI host. (Previously the Windows path was untestable, and this
 * module's tests were silently red on Windows because the injected `kill` spy was
 * never reached.)
 */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  kill: KillFn = process.kill,
  platform: NodeJS.Platform = process.platform,
  runTaskkill: RunTaskkill = defaultRunTaskkill,
): void {
  if (!child.pid) return

  if (platform === 'win32') {
    runTaskkill(taskkillArgs(child.pid))
    return
  }

  // Unix: preserve existing behavior (negative PID = process group)
  try {
    kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { }
  }
}
