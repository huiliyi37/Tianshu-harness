import type { ChildProcess } from 'child_process'
import { killProcessTree, type RunTaskkill } from './process-kill.js'

const activeProcesses = new Set<ChildProcess>()

export function track(child: ChildProcess, _loopId?: string): ChildProcess {
  activeProcesses.add(child)
  child.on('close', () => activeProcesses.delete(child))
  child.on('error', () => activeProcesses.delete(child))
  return child
}

export function getActiveCount(): number {
  return activeProcesses.size
}

// Synchronous variant for exit paths: process.exit() runs before any setTimeout
// fires, so a deferred SIGKILL never executes and children are orphaned
// (PPID=1). This kills inline so the tree dies before the process exits.
//
// 两阶段终止只在**有等待窗口**时才有意义（异步版留 2 秒让 SIGTERM 先生效）。
// 同步路径没有窗口，两次调用紧挨着发出：Windows 上 killProcessTree 忽略 signal
// （process-kill.ts:64-65，一律 `taskkill /F /T`），第二发与第一发参数逐字相同，
// 剩下的只有 spawnSync 空转（每次 timeout 5000；实测单子进程 ~800ms）。故 win32 只发一次。
// 见 issue #185。
//
// `platform` / `runTaskkill` 是测试缝（与 process-kill.ts 同款）：此前本函数不可注入，
// process-tracker.test.ts 断言的是 Unix 回退路径，于是在 Windows 宿主上恒红。
export function killAllSync(
  platform: NodeJS.Platform = process.platform,
  runTaskkill?: RunTaskkill,
): void {
  for (const child of activeProcesses) {
    killProcessTree(child, 'SIGTERM', process.kill, platform, runTaskkill)
    if (platform !== 'win32') {
      killProcessTree(child, 'SIGKILL', process.kill, platform, runTaskkill)
    }
  }
  activeProcesses.clear()
}
