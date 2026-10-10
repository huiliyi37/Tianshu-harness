/**
 * Resolve bare `npx` / `npm` to `node + *-cli.js` so stdio spawns work when
 * shell is forced off (MCP SDK StdioClientTransport) and Windows GUI PATH
 * lacks `npx.cmd`.
 *
 * Layout mirrors the official Node archive / fetch-node-runtime bundling:
 *   Windows: <nodeDir>/node_modules/npm/bin/{npx,npm}-cli.js
 *   Unix:    <nodeDir>/lib/node_modules/npm/bin/{npx,npm}-cli.js
 */
import { existsSync } from 'node:fs'
import { basename, win32 as winPath, posix as posixPath } from 'node:path'

export interface ResolveNodeCliDeps {
  execPath?: string
  platform?: NodeJS.Platform
  existsSync?: (path: string) => boolean
}

export interface ResolvedStdioCommand {
  command: string
  args: string[]
}

/**
 * 判定目录里是否有「真 node」，而不是转发器（issue #408）。
 *
 * 背景：桌面端 bundled 的 node-runtime 目录，Windows 上只有 `node.cmd` 转发器
 * （`@ECHO OFF` + `"%~dp0tianshu-runtime.exe" %*`），没有真 `node.exe`。把这种目录
 * prepend 到 PATH 前部，cmd.exe 解析 `node` 时会命中转发器，劫持用户系统里的真
 * Node——`npm exec` / `npm run` 里经 cmd 层启动 node 的脚本随之失败。
 *
 * 判据：win32 看 `node.exe` 是否在（转发器是 `.cmd` 形态，不构成命中）；POSIX 看 `node`。
 * 只做存在性判定，不试跑——调用方要的是「该目录该不该排在系统 node 前面」，
 * 不是「该目录里的 node 能不能用」。
 */
export function hasRealNode(
  nodeDir: string,
  platform: NodeJS.Platform,
  existsFn: (path: string) => boolean = existsSync,
): boolean {
  const p = pathApi(platform)
  const exe = platform === 'win32' ? 'node.exe' : 'node'
  return existsFn(p.join(nodeDir, exe))
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? winPath : posixPath
}

function bareName(command: string): string {
  const base = basename(command.replace(/\\/g, '/'))
  // Strip Windows .cmd/.bat/.exe so "npx.cmd" still matches.
  return base.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase()
}

function cliCandidates(kind: 'npx' | 'npm', nodeDir: string, platform: NodeJS.Platform): string[] {
  const p = pathApi(platform)
  const file = kind === 'npx' ? 'npx-cli.js' : 'npm-cli.js'
  if (platform === 'win32') {
    return [p.join(nodeDir, 'node_modules', 'npm', 'bin', file)]
  }
  // Packaged desktop: node binary is flat in targetDir, npm under lib/.
  // Official Node archive: binary in bin/, npm under ../lib/.
  return [
    p.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', file),
    p.join(p.dirname(nodeDir), 'lib', 'node_modules', 'npm', 'bin', file),
    p.join(nodeDir, 'node_modules', 'npm', 'bin', file),
  ]
}

/**
 * If `command` is npm/npx (bare or *.cmd), rewrite to the hosting Node binary
 * plus the matching cli.js. Unknown commands / missing cli → pass through.
 */
export function resolveNpmCliCommand(
  command: string,
  args: string[] = [],
  deps: ResolveNodeCliDeps = {},
): ResolvedStdioCommand {
  const name = bareName(command)
  if (name !== 'npx' && name !== 'npm') {
    return { command, args: [...args] }
  }

  const execPath = deps.execPath ?? process.execPath
  const platform = deps.platform ?? process.platform
  const exists = deps.existsSync ?? existsSync
  const p = pathApi(platform)
  const nodeDir = p.dirname(execPath)

  for (const candidate of cliCandidates(name, nodeDir, platform)) {
    if (exists(candidate)) {
      return { command: execPath, args: [candidate, ...args] }
    }
  }

  return { command, args: [...args] }
}

/** Use the current Windows host for Node aliases after the desktop host rename.
 * Explicit external runtimes remain authoritative; only a missing legacy sibling
 * node.exe is migrated. Unknown commands pass through rather than guessing. */
export function resolveNodeStdioCommand(
  command: string,
  args: string[] = [],
  deps: ResolveNodeCliDeps = {},
): ResolvedStdioCommand {
  const platform = deps.platform ?? process.platform
  const execPath = deps.execPath ?? process.execPath
  if (platform === 'win32') {
    const bare = !/[\\/]/.test(command)
    const alias = /^(?:node(?:\.(?:exe|cmd))?|tianshu-runtime\.exe)$/i.test(command)
    const legacySibling = winPath.isAbsolute(command)
      && winPath.basename(command).toLowerCase() === 'node.exe'
      && winPath.basename(execPath).toLowerCase() === 'tianshu-runtime.exe'
      && winPath.dirname(command).toLowerCase() === winPath.dirname(execPath).toLowerCase()
      && !(deps.existsSync ?? existsSync)(command)
    if ((bare && alias) || legacySibling) return { command: execPath, args: [...args] }
  }
  return resolveNpmCliCommand(command, args, deps)
}

/**
 * 基座 PATH 读不到时的系统目录兜底。
 *
 * 为什么需要：npx/npm 解析与安装包时要 spawn `cmd.exe`（Windows）或 `/bin/sh`，
 * 它们在系统目录里，不在 node 目录里。旧实现只把 PATH 写成 nodeDir，于是「基座
 * 没给 PATH」会静默退化成「子进程只能看到一个目录」，失败方式是秒退 + 一句
 * -32000，完全看不出根因（issue #149 的对照实验：PATH 只有 node 目录 → npx
 * 全部 `spawn cmd ENOENT`；补上 System32 后全部成功）。
 *
 * 基座 PATH 的完整性由注入的 getDefaultEnvironment 决定——MCP SDK 的
 * DEFAULT_INHERITED_ENV_VARS 白名单在版本间动过（1.29.0 的 win32 列表含 PATH，
 * 更早的版本不含），本仓库不该把子进程能否启动押在第三方的白名单上。
 *
 * 读 SystemRoot 而不是硬写 C:\Windows：装到非系统盘的机器上硬写会让兜底本身失效。
 * POSIX 不兜底——那里 PATH 缺失罕见，且猜 /bin:/usr/bin 反而可能覆盖掉调用方的
 * 精心配置。
 */
function systemPathFallback(platform: NodeJS.Platform, base: Record<string, string>): string[] {
  if (platform !== 'win32') return []
  const root = (base.SystemRoot ?? base.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows')
    .replace(/[\\/]+$/, '')
  return [`${root}\\System32`, root, `${root}\\System32\\Wbem`]
}

/**
 * 会被 Windows 文件关联「打开」而非执行的脚本宿主扩展。cmd 按 PATHEXT 匹配到
 * 这些扩展即走 ShellExecute（.js → 记事本、.vbs → WSH…），是 issue #149
 * 根因 B 的介质：`cmd /d /s /c <bin名>` 在 CWD 优先搜索时被同名 .js 拦下，
 * PATH 里的 .cmd shim 永远到不了。
 */
const SCRIPT_HOST_EXTS = new Set(['.JS', '.JSE', '.VBS', '.VBE', '.WSF', '.WSH', '.MSC'])

/** 剔除脚本宿主扩展后的安全 PATHEXT——保留 COM/EXE/BAT/CMD 这些真正可执行的
 *  形态（npx 的 .cmd shim 正是靠 .CMD 命中）。 */
const SAFE_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** 剔除 PATHEXT 里的脚本宿主扩展；空/缺失/全被剔时给安全默认值。 */
function sanitizePathext(value: string | undefined): string {
  const base = value?.trim() ? value : SAFE_PATHEXT
  const kept = base.split(';').map(s => s.trim()).filter(Boolean)
    .filter(ext => !SCRIPT_HOST_EXTS.has(ext.toUpperCase()))
  return kept.length > 0 ? kept.join(';') : SAFE_PATHEXT
}

/**
 * Build an env object for MCP stdio transports: always explicit, with the
 * hosting Node directory on PATH so npx-cli can find the same node. User-supplied
 * env is merged, but PATH is written last onto it.
 *
 * PATH 位置取决于目录内容（issue #408）：有真 node → prepend（子进程优先命中它）；
 * 只有转发器（无真 node）→ append 到末尾，让系统真 node 优先，避免劫持。
 */
export function buildStdioEnvWithNodePath(
  userEnv?: Record<string, string>,
  deps: ResolveNodeCliDeps & {
    getDefaultEnvironment?: () => Record<string, string>
  } = {},
): Record<string, string> {
  const getDefault = deps.getDefaultEnvironment
    ?? (() => {
      const out: Record<string, string> = {}
      for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
        const v = process.env[key]
        if (v !== undefined) out[key] = v
      }
      return out
    })
  const base = getDefault()
  const user = userEnv ?? {}
  const execPath = deps.execPath ?? process.execPath
  const platform = deps.platform ?? process.platform
  const p = pathApi(platform)
  const pathSep = platform === 'win32' ? ';' : ':'
  const nodeDir = p.dirname(execPath)
  const pathRest = user.PATH ?? user.Path ?? base.PATH ?? base.Path ?? ''
  const fallback = pathRest ? [] : systemPathFallback(platform, base)
  const merged = { ...base, ...user }
  // issue #408：nodeDir 里只有转发器（无真 node）时不抢占 PATH 首位——改 append 到
  // 末尾，让系统 PATH 里的真 node 优先命中，bundled 目录仍留在 PATH 中可找到；
  // 有真 node 时保持 prepend（issue #149：确保子进程能找到 node）。
  const pathParts = pathRest ? [pathRest] : fallback
  const env: Record<string, string> = {
    ...merged,
    PATH: hasRealNode(nodeDir, platform, deps.existsSync ?? existsSync)
      ? [nodeDir, ...pathParts].join(pathSep)
      : [...pathParts, nodeDir].join(pathSep),
  }
  if (platform === 'win32') {
    // issue #149 根因 B：npx 分发的 bin 由 `cmd /d /s /c <bin名>` 执行，cmd 按
    // PATHEXT 在 CWD 优先匹配——CWD 里的同名 .js 会被文件关联「打开」（记事本），
    // PATH 里的 .cmd shim 永远到不了，子进程秒退 -32000。剔除脚本宿主扩展后
    // cmd 只认真正可执行的扩展。
    // 注意："基座未给 PATHEXT"是常态而非边角：SDK 1.29.0 的 win32 白名单不含
    // PATHEXT（子进程 env 无此变量 → cmd 回落系统默认——含 .JS，正是缺陷介质），
    // 显式补安全默认即主修复路径；带值的场景来自 server 自定义 env / 应用设置。
    delete env.Pathext
    env.PATHEXT = sanitizePathext(merged.PATHEXT ?? merged.Pathext)
  }
  return env
}
