import { killAllSync } from '../../tools/process-tracker.js'

export interface ExitCleanupDeps {
  restoreTerminalSync: () => void
  killMcpChildrenSync: () => void
}

/**
 * Last-resort sync hook: even if shutdown() threw or an uncaughtException
 * skipped it, the process-exit event still fires (unless SIGKILL).
 *
 * Terminal modes come first — an uncaught throw skips shutdown()/dispose()
 * entirely, stranding the user with a hidden cursor, bracketed paste still
 * armed and the terminal in raw mode (`tput reset` territory). We deliberately
 * do NOT register an `uncaughtException` listener to do this: that would
 * suppress Node's default crash behaviour for genuine synchronous errors
 * (see platform/eperm-filter.ts). This hook fires either way.
 *
 * MCP child processes (e.g. context7-mcp) are spawned via StdioClientTransport
 * and would otherwise orphan to PPID=1, accumulating across dev restarts.
 * Tracked 子进程（bash 工具、job-store、OOP worker 树）同款：uncaughtException
 * 跳过 shutdown() 时 killAllSync 的常规路径不执行，detached 的 OOP worker 会
 * 成 PPID=1 孤儿继续烧 API 预算。killAllSync 全同步（Unix kill syscall /
 * Windows spawnSync taskkill），exit 钩子内安全。
 */
export function registerExitCleanup(deps: ExitCleanupDeps): void {
  process.on('exit', () => {
    try { deps.restoreTerminalSync() } catch { /* best-effort */ }
    try {
      if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false)
    } catch { /* best-effort */ }
    try { deps.killMcpChildrenSync() } catch { /* best-effort */ }
    try { killAllSync() } catch { /* best-effort */ }
  })
}
