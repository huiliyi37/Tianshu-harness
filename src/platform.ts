/**
 * Cross-platform abstraction layer for shell execution, process termination,
 * path resolution, and environment detection.
 *
 * All Windows-specific logic is isolated here. The rest of the codebase should
 * use these functions instead of platform-dependent Node.js APIs directly.
 */
import { homedir } from 'node:os'
import { spawnSyncHidden } from './tools/spawn-hidden.js'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 as winPath } from 'node:path'
import type { EditorPlatform, EditorEol } from './config/schema.js'
import { TextDecoder } from 'node:util'

/** Result of `getShellCommand()` — the command and args for spawning a shell. */
export interface ShellCommand {
  cmd: string
  /** Args to pass to the shell, WITHOUT the user command appended. */
  args: string[]
  /**
   * Shell family — lets callers pick the correct command wrapping/encoding
   * (e.g. Git Bash needs no encoding prefix; cmd uses WinStreamDecoder
   * auto-detection) by semantics instead of fragile string matching on `cmd`.
   */
  kind: 'bash' | 'powershell' | 'cmd' | 'sh'
}

/** Build the full shell args by appending the user's command. */
export function buildShellArgs(shell: ShellCommand, command: string): string[] {
  return [...shell.args, command]
}

const isWin = process.platform === 'win32'

// ─── Target Conventions ────────────────────────────────────────────────────────
//
// The "target platform" governs file ARTIFACT conventions (line endings) and the
// system-prompt OS hint — NOT command execution. Execution (shell/sandbox/kill)
// always uses the real host `process.platform`, because you can't run PowerShell
// on a macOS host. Resolved once at startup from `editor.platform`/`editor.eol`
// via setTargetConventions(); reads before init safely fall back to the host.

/** Map an `editor.platform` enum value to a concrete NodeJS.Platform. */
function resolveTargetPlatform(platform: EditorPlatform): NodeJS.Platform {
  switch (platform) {
    case 'windows': return 'win32'
    case 'macos': return 'darwin'
    case 'linux': return 'linux'
    case 'auto':
    default: return process.platform
  }
}

let _targetPlatform: NodeJS.Platform = process.platform
let _targetEol: 'crlf' | 'lf' = process.platform === 'win32' ? 'crlf' : 'lf'

/**
 * Resolve and cache the target-OS conventions from config. Call once at startup
 * (after loadConfig) in every entry point (TUI main, server sidecar).
 */
export function setTargetConventions(platform: EditorPlatform, eol: EditorEol): void {
  _targetPlatform = resolveTargetPlatform(platform)
  _targetEol = eol === 'auto' ? (_targetPlatform === 'win32' ? 'crlf' : 'lf') : eol
}

/** The resolved target platform (drives EOL default + prompt OS hint). */
export function getTargetPlatform(): NodeJS.Platform {
  return _targetPlatform
}

/** The resolved default EOL for newly-created files. */
export function getTargetEol(): 'crlf' | 'lf' {
  return _targetEol
}

// ─── Shell ───────────────────────────────────────────────────────────────────

/** Cached shell command to avoid repeated spawnSync on every tool call. */
let _cachedShell: ShellCommand | null = null

/** Cached Git Bash path (string = found, null = absent). undefined = not probed. */
let _cachedGitBash: string | null | undefined

/** Injectable dependencies for {@link resolveGitBashPath} (pure, unit-testable). */
export interface GitBashProbeDeps {
  isWindows: boolean
  env: NodeJS.ProcessEnv
  /** Absolute path to git.exe if on PATH, otherwise undefined. */
  whichGit: () => string | undefined
  /** Absolute path to bash.exe if on PATH, otherwise undefined（2.5 路探针，可选）。 */
  whichBash?: () => string | undefined
  exists: (p: string) => boolean
}

/**
 * Pure resolution of the Git Bash (`bash.exe`) path on Windows. Mirrors
 * claude code's probe order so behavior is predictable across environments:
 *   1. `RIVET_GIT_BASH_PATH` override
 *   2. derive from `where git` (…\Git\cmd\git.exe → …\Git\bin\bash.exe)
 *   2.5. `where bash`——bash.exe 在 PATH 但 git.exe 不在（或 Scoop shim 布局，
 *        第 2 步的 gitRoot 推导必然失败）时的兜底；排除 WSL
 *        （System32\bash.exe，路径语义完全不同，拿它当 shell 是事故）
 *   3. common install locations (Program Files / LocalAppData / Scoop)
 *   4. bundled PortableGit shipped with the desktop app (`RIVET_BUNDLED_GIT_DIR`,
 *      extracted by the Tauri launcher on first run) — LAST so a system Git,
 *      with the user's own version and config, always wins.
 * All path math uses win32 semantics so it's deterministic when unit-tested on
 * POSIX hosts. Returns null when not on Windows or not found.
 */
export function resolveGitBashPath(deps: GitBashProbeDeps): string | null {
  if (!deps.isWindows) return null

  const override = deps.env['RIVET_GIT_BASH_PATH']
  if (override && deps.exists(override)) return override

  const gitPath = deps.whichGit()
  if (gitPath) {
    // git.exe usually lives in …\Git\cmd\ or …\Git\bin\; bash.exe is …\Git\bin\.
    const gitRoot = winPath.dirname(winPath.dirname(gitPath))
    const bashPath = winPath.join(gitRoot, 'bin', 'bash.exe')
    if (deps.exists(bashPath)) return bashPath
  }

  // 2.5: bash.exe itself on PATH（Scoop/MSYS2/自定义 PATH 布局）。WSL 的
  // bash.exe 在 System32——它的根是 Linux 文件系统，/mnt/c 慢且行尾地狱，
  // 绝不用作项目 shell。
  const bashOnPath = deps.whichBash?.()
  if (bashOnPath && !/^[A-Za-z]:\\Windows\\(System32|SysWOW64)\\bash\.exe$/i.test(bashOnPath) && deps.exists(bashOnPath)) {
    return bashOnPath
  }

  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  const localApp = deps.env['LOCALAPPDATA']
  if (localApp) candidates.push(winPath.join(localApp, 'Programs', 'Git', 'bin', 'bash.exe'))
  // Scoop 安装（gitRoot 推导对 ~\scoop\shims 必然失败，常见开发机布局）。
  const scoopRoot = deps.env['SCOOP']
  if (scoopRoot) candidates.push(winPath.join(scoopRoot, 'apps', 'git', 'current', 'bin', 'bash.exe'))
  const userProfile = deps.env['USERPROFILE']
  if (userProfile) candidates.push(winPath.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'))
  for (const c of candidates) {
    if (deps.exists(c)) return c
  }

  // Fallback: bundled PortableGit (desktop app only). Real Git for Windows —
  // its bin\bash.exe wrapper self-assembles PATH (usr/bin coreutils etc.), so
  // no special-casing downstream. May not exist yet on the very first launch
  // (background extraction in progress) — then this probe simply misses.
  const bundledGitDir = deps.env['RIVET_BUNDLED_GIT_DIR']
  if (bundledGitDir) {
    const bundledBash = winPath.join(bundledGitDir, 'bin', 'bash.exe')
    if (deps.exists(bundledBash)) return bundledBash
  }

  return null
}

/** Locate git.exe on PATH via `where` (Windows). Returns first hit or undefined. */
function whichGitWindows(): string | undefined {
  try {
    const result = spawnSyncHidden('where', ['git'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
    if (result.status === 0) {
      const first = result.stdout.toString().split('\n')[0]?.trim()
      return first && first.length > 0 ? first : undefined
    }
  } catch { /* best-effort */ }
  return undefined
}

/** Locate bash.exe on PATH via `where` (Windows)。Returns first hit or undefined. */
function whichBashWindows(): string | undefined {
  try {
    const result = spawnSyncHidden('where', ['bash'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
    if (result.status === 0) {
      const first = result.stdout.toString().split('\n')[0]?.trim()
      return first && first.length > 0 ? first : undefined
    }
  } catch { /* best-effort */ }
  return undefined
}

/**
 * Seed `RIVET_GIT_BASH_PATH` from the persisted config (`env.gitBashPath`) at
 * startup so the shell probe honors a user-chosen Git Bash location. A real OS
 * env var of the same name always wins (explicit override), so this only fills
 * the gap for desktop users who can't easily set system env vars. Idempotent;
 * resets the probe caches so a later getShellCommand() picks up the change.
 * No-op when the value is empty or the env var is already set.
 */
export function applyConfiguredGitBashPath(gitBashPath?: string): void {
  const trimmed = gitBashPath?.trim()
  if (!trimmed) return
  if (process.env['RIVET_GIT_BASH_PATH']) return
  process.env['RIVET_GIT_BASH_PATH'] = trimmed
  _cachedGitBash = undefined
  _cachedShell = null
}

/** Cached, real-IO Git Bash path probe. */
export function findGitBashPath(): string | null {
  if (_cachedGitBash !== undefined) return _cachedGitBash
  _cachedGitBash = resolveGitBashPath({
    isWindows: isWin,
    env: process.env,
    whichGit: whichGitWindows,
    whichBash: whichBashWindows,
    exists: existsSync,
  })
  return _cachedGitBash
}

/** Injectable dependencies for {@link resolveShellCommand} (pure, unit-testable). */
export interface ShellProbeDeps {
  isWindows: boolean
  env: NodeJS.ProcessEnv
  /** Resolved Git Bash path, or null when absent. */
  gitBashPath: string | null
  /** True if the named PowerShell executable is on PATH. */
  hasPwsh: (cmd: string) => boolean
}

/**
 * Pure shell selection. On Windows the priority is Git Bash → PowerShell → cmd:
 * Git Bash gives reliable POSIX execution (claude code's approach) and avoids the
 * `powershell -Command` argument-mangling that silently swallowed commands
 * (exit=0, empty stdout). PowerShell fallback uses -NonInteractive so it can't
 * hang waiting on input. On Unix, plain `sh -c`.
 */
export function resolveShellCommand(deps: ShellProbeDeps): ShellCommand {
  if (deps.isWindows) {
    // Opt-in: force PowerShell even when Git Bash is present (parity with
    // CLAUDE_CODE_USE_POWERSHELL_TOOL). Default stays Git-Bash-first since our
    // model is bash-biased; power users who want native cmdlets set this.
    const forcePwsh = /^(1|true|yes)$/i.test(deps.env['RIVET_USE_POWERSHELL'] ?? '')
    if (!forcePwsh && deps.gitBashPath) {
      // Plain `-c` (对齐 Claude Code)，不走 `-l` 登录 shell。coreutils
      // (ls/cat/grep) 已在 Git 的 usr/bin 内、随 bash.exe 自动上 PATH，无需 -l。
      // `-l` 会源 /etc/profile 重建 PATH，在 MSYS2_PATH_TYPE 非 inherit 时会把
      // 宿主 Windows PATH 洗掉 → 商店版 Python 的 py/python 等原生命令在 Git Bash
      // 里调不动（PowerShell 能用、bash 工具不能用的元凶之一）。去掉 -l 后子进程
      // 直接继承 spawn 传入的完整 Windows PATH，原生命令可正常调用；也更快。
      return { cmd: deps.gitBashPath, args: ['-c'], kind: 'bash' }
    }
    for (const cmd of ['pwsh.exe', 'powershell.exe']) {
      if (deps.hasPwsh(cmd)) {
        return { cmd, args: ['-NoProfile', '-NonInteractive', '-Command'], kind: 'powershell' }
      }
    }
    const comSpec = deps.env['ComSpec'] || 'cmd.exe'
    return { cmd: comSpec, args: ['/c'], kind: 'cmd' }
  }
  return { cmd: 'sh', args: ['-c'], kind: 'sh' }
}

/** True if the named PowerShell executable resolves on PATH (Windows). */
function hasPwshWindows(cmd: string): boolean {
  try {
    const result = spawnSyncHidden('where', [cmd], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
    return result.status === 0 && result.stdout.toString().trim().length > 0
  } catch {
    return false
  }
}

/**
 * Detect the best available shell on the current platform (cached).
 *
 * On Windows: Git Bash (preferred) → PowerShell (pwsh > powershell) → cmd.exe.
 * On Unix: 'sh' (the POSIX shell).
 */
export function getShellCommand(): ShellCommand {
  if (_cachedShell) return _cachedShell
  _cachedShell = resolveShellCommand({
    isWindows: isWin,
    env: process.env,
    gitBashPath: findGitBashPath(),
    hasPwsh: hasPwshWindows,
  })
  return _cachedShell
}

export interface ShellDiagnostics {
  kind: ShellCommand['kind']
  cmd: string
  /** Git Bash path if found, null if probed but not found. */
  gitBashPath: string | null
  /** Why we fell back from Git Bash (Windows only). Undefined when kind === 'bash' or non-Windows. */
  fallbackReason?: string
}

/**
 * 诊断当前 shell 选择——降级时产出可观测原因（"未找到 Git Bash" + 探测路径）。
 * 给 bash.ts 的 spawn ENOENT 和首次执行警告用。
 */
export function getShellDiagnostics(): ShellDiagnostics {
  const shell = getShellCommand()
  const gitBash = findGitBashPath()
  const diag: ShellDiagnostics = { kind: shell.kind, cmd: shell.cmd, gitBashPath: gitBash }
  if (isWin && shell.kind !== 'bash') {
    const bundledNote = process.env['RIVET_BUNDLED_GIT_DIR']
      ? `, 内置 Git（${process.env['RIVET_BUNDLED_GIT_DIR']}——可能仍在首次解压中，稍后重试或重启）`
      : ''
    diag.fallbackReason = gitBash
      ? `Git Bash found at ${gitBash} but not selected (RIVET_USE_POWERSHELL set?)`
      : `Git Bash not found — probed RIVET_GIT_BASH_PATH, \`where git\` → …\\Git\\bin\\bash.exe, C:\\Program Files\\Git, %LOCALAPPDATA%\\Programs\\Git${bundledNote}`
  }
  return diag
}

/**
 * Rewrite Windows CMD-style null redirects (`2>nul`, `>nul`) to POSIX
 * (`2>/dev/null`, `>/dev/null`). Under Git Bash a literal `nul` would create a
 * real file named `nul`, which breaks git and pollutes the workspace. Only meant
 * for the `kind: 'bash'` path. Leaves `2>&1` and other redirects untouched.
 */
export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(
    /(^|\s)(\d?)>\s*nul(?=\s|$|;|&|\|)/gi,
    (_m, pre: string, fd: string) => `${pre}${fd}>/dev/null`,
  )
}

/**
 * Normalize null-device redirects to the PowerShell form `$null`. The model,
 * being bash/cmd-biased, often emits `2>nul` (cmd) or `2>/dev/null` (POSIX) under
 * PowerShell — both create a literal file named `nul`/`null` or just fail. Rewrite
 * either to `2>$null`. Only meant for the `kind: 'powershell'` path. Leaves
 * `2>&1` and other redirects untouched. Safe normalization only — NOT a general
 * bash→PowerShell translator (that fragile path is deliberately avoided).
 */
export function rewritePowershellNullRedirect(command: string): string {
  return command.replace(
    /(^|\s)(\d?)>\s*(?:nul|\/dev\/null)(?=\s|$|;|&|\|)/gi,
    (_m, pre: string, fd: string) => `${pre}${fd}>$null`,
  )
}

// ─── Process Termination ─────────────────────────────────────────────────────

/** Killable subset of ChildProcess used across the codebase. */
export type KillableChild = Pick<ChildProcess, 'pid' | 'kill'>

export function gracefulKill(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSyncHidden('taskkill', ['/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch { /* best-effort */ }
}

export function forceKill(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSyncHidden('taskkill', ['/F', '/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* best-effort */ }
}

export function gracefulKillTree(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSyncHidden('taskkill', ['/T', '/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    try {
      if (isWin) {
        spawnSyncHidden('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 5000,
        })
      } else {
        child.kill('SIGTERM')
      }
    } catch { /* best-effort */ }
  }
}

export function forceKillTree(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSyncHidden('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    try {
      if (isWin) {
        spawnSyncHidden('taskkill', ['/F', '/PID', String(child.pid)], {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 5000,
        })
      } else {
        child.kill('SIGKILL')
      }
    } catch { /* best-effort */ }
  }
}

// ─── Path & Editor ───────────────────────────────────────────────────────────

export function expandHome(path: string): string {
  if (path.startsWith('~')) {
    return homedir() + path.slice(1)
  }
  return path
}

export function getDefaultEditor(): string {
  if (isWin) {
    return process.env['VISUAL'] || process.env['EDITOR'] || 'notepad'
  }
  return process.env['VISUAL'] || process.env['EDITOR'] || 'vi'
}

// ─── Encoding Decoder for Windows Mojibake Prevention ─────────────────────────

const isUtf8Buffer = typeof (Buffer as any).isUtf8 === 'function'
  ? (Buffer as any).isUtf8
  : (buf: Buffer) => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf)
        return true
      } catch {
        return false
      }
    }

/**
 * Streaming decoder for Windows console output to prevent mojibake/gibberish (乱码).
 * Automatically detects whether stdout/stderr stream is encoded in UTF-8 or GBK/OEM code page
 * on the first chunk, and stream-decodes it without splitting multi-byte characters.
 */
export class WinStreamDecoder {
  private decoder: TextDecoder | null = null
  private isUtf8 = true
  private first = true

  write(chunk: Buffer): string {
    if (!isWin) {
      return chunk.toString('utf8')
    }

    if (this.first) {
      this.first = false
      this.isUtf8 = isUtf8Buffer(chunk)
      const encoding = this.isUtf8 ? 'utf-8' : 'gbk'
      this.decoder = new TextDecoder(encoding, { fatal: false })
    }

    if (this.decoder) {
      return this.decoder.decode(chunk, { stream: true })
    }
    return chunk.toString('utf8')
  }

  end(): string {
    if (this.decoder) {
      return this.decoder.decode()
    }
    return ''
  }
}
