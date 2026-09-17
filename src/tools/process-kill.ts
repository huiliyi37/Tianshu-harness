import type { ChildProcess } from 'child_process'
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ─────────────────────────────────────────────────────────────────────────────
// 作业持有者（job-launch.exe）接线 —— issue #144 的本体修复
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 解析 Windows 作业持有者（`job-launch.exe`）。解析不到返回 `null`，调用方走现状（fail-open）。
 *
 * 为什么需要它：Git Bash/MSYS 的 `nohup node &` 会逃过 `taskkill /T`（Win32 父链在 `nohup` 处断开，
 * 已实测）。更关键的是**「先把壳 spawn 出来、再 assign 进作业」实测无效**——MSYS 只认"出生就在作业里"：
 * 事后 assign 的壳自己在作业里（`ours=True`），但它之后 fork 的 node `ours=False anyjob=False`，
 * 终止收不到（见 PR #163 的 `PLAN-MECHANISM-2026-09-16.md`）。
 *
 * 所以必须由一个**已经属于作业**的进程去创建壳：helper 自建作业 → 自己先入作业 → 再 spawn 真正的
 * shell。bash 直接继承 Node 给的 stdio 句柄，因此**零中转**：管道、退出码、退出事件语义都不变。
 * 终止时只要杀掉 helper，它持有的作业句柄随之关闭，`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 把整棵树
 * （shell + nohup 出来的 node + 它自己的 fork 链）一起带走——不需要枚举进程表，也不需要归属校验。
 *
 * 查找顺序：`RIVET_JOB_LAUNCHER` 覆盖 → 从本模块所在目录**逐级上溯**（≤5 跳），每级先看
 * `<dir>/native/` 再看 `<dir>/dist/native/`（同级 native/ 优先）。
 *
 * 为什么不能是固定 `../../`：那个写法只在源码布局（`src/tools/*.ts`）恰好命中仓根。产物态下
 * `dist/main.js` / `dist/chunk-*.js` / `dist/cli/entry.js` 的 `import.meta.url` 都在 `dist/` 下，
 * 固定两级会**跳出安装根**，于是生产包永远解析不到 `dist/native/job-launch.exe`——而 fail-open
 * 会让这个缺口在源码态下完全看不见（上游移植时在开发仓库补上，见 PR #166）。
 *
 * 5 跳的上限与 `src/repo/native-resolver.ts` 同口径：最深真实调用方是 `dist/<area>/<sub>/*.js`
 * （3 跳到 `dist`），5 留了余量，又不至于走到安装根之外、撞上无关的 `native/`。
 */
const MAX_NATIVE_LOOKUP_DEPTH = 5

/**
 * 纯核心：从 `startDir` 逐级上溯找 helper。
 *
 * `exists` 可注入——四种布局（源码态 / `dist` 根 / `dist/cli/` 子目录 / 均不存在）只有注入才锁得住，
 * 不可能靠真在磁盘上造一棵安装树来测。与 `killProcessTree` 的 `platform`、`spawnShell` 的
 * `launcher`/`spawnFn` 同风格。
 */
export function findJobLauncher(
  startDir: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  let dir = startDir
  for (let depth = 0; depth <= MAX_NATIVE_LOOKUP_DEPTH; depth++) {
    // 同级优先顺序固定：先 native/，再 dist/native/。
    for (const candidate of [
      join(dir, 'native', 'job-launch.exe'),
      join(dir, 'dist', 'native', 'job-launch.exe'),
    ]) {
      try {
        if (exists(candidate)) return candidate
      } catch {
        // 探测失败就当这个候选不存在，继续下一个
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break // 文件系统根
    dir = parent
  }
  return null
}

/** `resolveJobLauncher` 的可注入依赖（测试用；与 `killProcessTree` 的 `platform` 同风格）。 */
export interface JobLauncherDeps {
  /** 上溯起点，缺省为本模块所在目录。 */
  here?: string
  /** 文件探测，缺省 `existsSync`。 */
  exists?: (candidate: string) => boolean
  /** 平台，缺省 `process.platform`——显式传入才能让 win32 分支在任意 CI 主机上被测到。 */
  platform?: NodeJS.Platform
}

/** 位置探测的进程级缓存：上溯起点 → 结果。生产只有一个 `HERE`，键用起点是因为它可注入。 */
const launcherMemo = new Map<string, string | null>()

export function resolveJobLauncher(deps: JobLauncherDeps = {}): string | null {
  if ((deps.platform ?? process.platform) !== 'win32') return null

  // 覆盖变量**永远实时读**：一次属性访问 + 至多一次 existsSync，成本可忽略；而且
  // 「刚把 helper 编译出来」的正解就是设它——不该被位置缓存挡住。
  const override = process.env.RIVET_JOB_LAUNCHER
  if (override) {
    try {
      if (existsSync(override)) return override
    } catch {
      // 覆盖路径探测失败 → 落到常规查找
    }
  }

  const here = deps.here ?? HERE
  // 为什么缓存：逐级上溯最多 12 次 existsSync，而本函数**每次 spawn 都被求值**
  // （`spawnShell` 的默认参数）。实测本机单次 ~1.4ms、一次 spawn ~29ms——纯常数开销；
  // 缓存后同一个 here 的重复求值降到亚微秒级。
  if (launcherMemo.has(here)) return launcherMemo.get(here) ?? null
  const path = findJobLauncher(here, deps.exists ?? existsSync)
  launcherMemo.set(here, path)
  return path
}

/**
 * 丢弃位置探测的进程级缓存。
 *
 * 两个用途：测试隔离；以及**运行中才把 helper 编译出来**的场景——那时需要调它
 * （或直接设 `RIVET_JOB_LAUNCHER`，那条路永远实时）。缓存带来的语义变化就这一处：
 * 位置探测是进程级的，热装不 invalidate 时要等下一个进程才生效。
 */
export function invalidateJobLauncherCache(): void {
  launcherMemo.clear()
}

/** helper 的 argv 契约：`job-launch.exe [--cwd <dir>] [--parent-pid <pid>] <exe> [args...]` */
export function jobLaunchArgv(
  shell: { cmd: string; args: string[] },
  command: string,
  cwd: string,
  parentPid: number = process.pid,
): string[] {
  return ['--cwd', cwd, '--parent-pid', String(parentPid), shell.cmd, ...shell.args, command]
}

/**
 * 统一的 shell 启动出口：Windows 且 helper 可用时由 helper 持有作业；否则原样 `spawn`（行为不变）。
 *
 * `launcher` / `spawnFn` 是测试接缝（与 `killProcessTree` 的 `platform` / `runTaskkill` 同风格），
 * 让"走没走 helper、argv 拼得对不对"能在任意 CI 主机上断言。
 */
export function spawnShell(
  shell: { cmd: string; args: string[] },
  command: string,
  options: SpawnOptions,
  launcher: string | null = resolveJobLauncher(),
  spawnFn: typeof spawn = spawn,
): ChildProcess {
  if (!launcher) return spawnFn(shell.cmd, [...shell.args, command], options)
  const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd()
  return spawnFn(launcher, jobLaunchArgv(shell, command, cwd), options)
}
