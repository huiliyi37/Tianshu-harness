/**
 * Resolve the *real* execution environment (PATH + toolchain vars) for command
 * tools, so the agent finds `mvn`/`git`/`java`/... even when the app is launched
 * from a GUI (Explorer/Finder/Dock) that hands the process a minimal PATH.
 *
 * Why this exists: a TUI launched from a terminal inherits the login shell's full
 * PATH, but a desktop app spawned by the OS shell (especially Windows Explorer)
 * inherits only the system default PATH. Tools installed by the user (Maven, a
 * standalone JDK, sometimes Git) live in dirs that never make it into that
 * minimal PATH, so every `mvn`/`java` call fails with command-not-found.
 *
 * Resolution strategy (host-level, resolved once and cached):
 *  - Windows: read `HKLM\...\Session Manager\Environment` (Machine) and
 *    `HKCU\Environment` (User) via `reg query`; merge their `Path` into the
 *    current PATH (current entries first, registry entries appended) and recover
 *    missing toolchain vars (JAVA_HOME/MAVEN_HOME/...). Then derive `<VAR>\bin`
 *    dirs and append the ones that exist.
 *  - Unix: only when PATH looks suspiciously short (missing /usr/local/bin and
 *    /opt/homebrew/bin) do we dump the login shell env (`$SHELL -lic 'command
 *    env'`, 3s timeout) and merge PATH + toolchain vars. On failure we fall back
 *    to appending common dirs.
 *  - User config (`config.env.extraPath` / `extraVars`) is layered on every call
 *    at the highest priority — a manual escape hatch when auto-resolution misses.
 *
 * All platform IO (registry reader / login-shell dumper / dir prober) is behind
 * an injectable {@link ResolvedEnvDeps} so the pure resolution logic is unit
 * testable on any host without touching the real registry or spawning a shell.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 as winPath, posix as posixPath } from 'node:path'
import { loadConfig } from '../config/manager.js'
import type { EnvConfig } from '../config/schema.js'

/** Toolchain env vars worth recovering from the registry / login shell. */
const TOOLCHAIN_VARS = [
  'JAVA_HOME', 'JDK_HOME', 'JRE_HOME',
  'MAVEN_HOME', 'M2_HOME', 'M2',
  'GRADLE_HOME',
  'GOROOT', 'GOPATH', 'GOBIN',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT',
  'CARGO_HOME', 'RUSTUP_HOME',
  'NVM_DIR', 'PYENV_ROOT', 'SDKMAN_DIR',
  'PNPM_HOME', 'VOLTA_HOME', 'FNM_DIR',
] as const

/** Injectable platform IO so resolution is unit-testable on any host. */
export interface ResolvedEnvDeps {
  platform: NodeJS.Platform
  /** The starting environment (usually process.env). */
  baseEnv: NodeJS.ProcessEnv
  /** Windows: read a hive's Environment values → { key: value }. `{}` on failure. */
  readRegistryEnv: (scope: 'machine' | 'user') => Record<string, string>
  /** Unix: dump login shell env as `KEY=VALUE` lines. `''` on failure/timeout. */
  dumpLoginShellEnv: () => string
  /** Existence check for probed directories (injectable for tests). */
  exists: (p: string) => boolean
}

/** Host-level resolution result: the merged PATH + recovered toolchain vars. */
export interface HostEnvResult {
  /** The env key that holds PATH in baseEnv (`Path` on Windows, `PATH` on Unix). */
  pathKey: string
  /** The merged PATH string (base entries first, discovered entries appended). */
  path: string
  /** Toolchain vars recovered from the registry / login shell (missing in base). */
  vars: Record<string, string>
}

/** Find the actual PATH key in an env (Windows uses `Path`; be case-insensitive). */
function findPathKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') return key
  }
  return 'PATH'
}

function splitPath(value: string, sep: string): string[] {
  return value.split(sep).map(s => s.trim()).filter(Boolean)
}

/** Expand `%VAR%` references (Windows registry values) using baseEnv, case-insensitively. */
function expandWinVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const lower = name.toLowerCase()
    for (const [k, v] of Object.entries(env)) {
      if (k.toLowerCase() === lower && typeof v === 'string') return v
    }
    return whole
  })
}

/** Parse `reg query` output into { key: value }. Handles REG_SZ / REG_EXPAND_SZ. */
export function parseRegQuery(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split(/\r?\n/)) {
    // "    Path    REG_EXPAND_SZ    C:\Windows;C:\Windows\System32;..."
    const m = line.match(/^\s+(\S+)\s+(REG_\w+)\s+(.*)$/)
    if (m) out[m[1]!] = m[3]!.trim()
  }
  return out
}

/** Parse `KEY=VALUE` env dump (login shell output) into a map. */
export function parseEnvDump(dump: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of dump.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

/** A Unix PATH looks "minimal" when it lacks the usual user/brew bin dirs. */
function looksShort(entries: string[]): boolean {
  const set = new Set(entries)
  return !set.has('/usr/local/bin') && !set.has('/opt/homebrew/bin')
}

/** Common Unix dirs to append when a login-shell dump is unavailable. */
function unixProbeDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? ''
  const dirs = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/local/sbin']
  if (home) dirs.push(posixPath.join(home, '.local', 'bin'), posixPath.join(home, 'bin'))
  return dirs
}

/** Derive `<VAR>/bin` (and a few var-specific) dirs from recovered toolchain vars. */
function deriveBinDirs(vars: Record<string, string>, platform: NodeJS.Platform): string[] {
  const path = platform === 'win32' ? winPath : posixPath
  const dirs: string[] = []
  const bin = (v?: string) => { if (v) dirs.push(path.join(v, 'bin')) }
  bin(vars.JAVA_HOME); bin(vars.JDK_HOME); bin(vars.JRE_HOME)
  bin(vars.MAVEN_HOME); bin(vars.M2_HOME); bin(vars.M2)
  bin(vars.GRADLE_HOME)
  bin(vars.GOROOT); bin(vars.GOPATH)
  bin(vars.CARGO_HOME)
  if (vars.GOBIN) dirs.push(vars.GOBIN)
  if (vars.PNPM_HOME) dirs.push(vars.PNPM_HOME)
  bin(vars.VOLTA_HOME)
  if (vars.ANDROID_HOME) {
    dirs.push(path.join(vars.ANDROID_HOME, 'platform-tools'), path.join(vars.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin'))
  }
  return dirs
}

/**
 * Pure host-level environment resolution. Merges the base PATH with entries
 * discovered from the registry (Windows) or login shell (Unix), recovers missing
 * toolchain vars, and appends their `bin` dirs that exist. No caching, no config.
 */
export function resolveHostEnv(deps: ResolvedEnvDeps): HostEnvResult {
  const isWin = deps.platform === 'win32'
  const sep = isWin ? ';' : ':'
  const pathKey = findPathKey(deps.baseEnv)
  const basePath = deps.baseEnv[pathKey] ?? deps.baseEnv.PATH ?? ''
  const pathEntries = splitPath(basePath, sep)

  const seen = new Set(pathEntries.map(e => (isWin ? e.toLowerCase() : e)))
  const addPath = (p: string): void => {
    if (!p) return
    const key = isWin ? p.toLowerCase() : p
    if (seen.has(key)) return
    seen.add(key)
    pathEntries.push(p)
  }

  const vars: Record<string, string> = {}
  const baseHas = (k: string): boolean =>
    Object.keys(deps.baseEnv).some(bk => bk.toLowerCase() === k.toLowerCase())
  const addVar = (key: string, val: string): void => {
    if (!val || vars[key] || baseHas(key)) return
    vars[key] = val
  }

  if (isWin) {
    let regReadOk = false
    for (const scope of ['machine', 'user'] as const) {
      const reg = deps.readRegistryEnv(scope)
      const regPath = reg.Path ?? reg.PATH ?? ''
      if (regPath) regReadOk = true
      for (const e of splitPath(expandWinVars(regPath, deps.baseEnv), sep)) addPath(e)
      for (const v of TOOLCHAIN_VARS) {
        const val = reg[v]
        if (val) addVar(v, expandWinVars(val, deps.baseEnv))
      }
    }
    // Fallback: if reg query failed entirely (empty PATH from GUI launch + reg.exe
    // was unreachable before the SystemRoot fix), probe critical system dirs so
    // basic commands (cmd, powershell, git, python) have a chance of resolving.
    if (!regReadOk) {
      const sysRoot = deps.baseEnv.SystemRoot || deps.baseEnv.windir || 'C:\\Windows'
      for (const dir of [`${sysRoot}\\System32`, `${sysRoot}`, `${sysRoot}\\System32\\Wbem`]) {
        if (deps.exists(dir)) addPath(dir)
      }
      // Common user-installed tool locations.
      const localApp = deps.baseEnv.LOCALAPPDATA
      if (localApp) {
        for (const sub of ['Programs\\Git\\bin', 'Programs\\Git\\cmd', 'Microsoft\\WindowsApps']) {
          if (deps.exists(`${localApp}\\${sub}`)) addPath(`${localApp}\\${sub}`)
        }
      }
    }
  } else if (looksShort(pathEntries)) {
    const dump = deps.dumpLoginShellEnv()
    if (dump) {
      const parsed = parseEnvDump(dump)
      for (const e of splitPath(parsed.PATH ?? '', sep)) addPath(e)
      for (const v of TOOLCHAIN_VARS) {
        if (parsed[v]) addVar(v, parsed[v]!)
      }
    } else {
      for (const dir of unixProbeDirs(deps.baseEnv)) {
        if (deps.exists(dir)) addPath(dir)
      }
    }
  }

  // Derive bin dirs from BOTH recovered vars and pre-existing base toolchain vars
  // (e.g. JAVA_HOME set but its bin never added to PATH).
  const allToolchainVars: Record<string, string> = { ...vars }
  for (const v of TOOLCHAIN_VARS) {
    if (!allToolchainVars[v]) {
      for (const [bk, bv] of Object.entries(deps.baseEnv)) {
        if (bk.toLowerCase() === v.toLowerCase() && typeof bv === 'string') { allToolchainVars[v] = bv; break }
      }
    }
  }
  for (const dir of deriveBinDirs(allToolchainVars, deps.platform)) {
    if (deps.exists(dir)) addPath(dir)
  }

  return { pathKey, path: pathEntries.join(sep), vars }
}

/**
 * Layer user config (`extraPath` appended, `extraVars` highest priority) onto a
 * resolved env. Pure; applied on every call so config edits take effect without
 * restart. Mutates and returns a fresh object.
 */
export function applyConfigEnv(
  base: NodeJS.ProcessEnv,
  config: EnvConfig,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const sep = platform === 'win32' ? ';' : ':'
  const result: NodeJS.ProcessEnv = { ...base }
  const pathKey = findPathKey(result)
  const extraPath = (config.extraPath ?? []).filter(Boolean)
  if (extraPath.length > 0) {
    const current = result[pathKey] ?? ''
    const existing = new Set(splitPath(current, sep).map(e => (platform === 'win32' ? e.toLowerCase() : e)))
    const additions = extraPath.filter(p => !existing.has(platform === 'win32' ? p.toLowerCase() : p))
    result[pathKey] = additions.length > 0 ? [current, ...additions].filter(Boolean).join(sep) : current
  }
  for (const [k, v] of Object.entries(config.extraVars ?? {})) {
    result[k] = v
  }
  return result
}

// ─── Real-IO deps + cached entry point ────────────────────────────────────────

/** Windows: read a hive's Environment values via `reg query`. `{}` on failure.
 *  Uses the absolute path to reg.exe (SystemRoot\System32\reg.exe) so it works
 *  even when the inherited PATH is empty — the classic GUI-launch PATH problem. */
function readRegistryEnvReal(scope: 'machine' | 'user'): Record<string, string> {
  const hive = scope === 'machine'
    ? 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    : 'HKCU\\Environment'
  // Resolve reg.exe via SystemRoot/windir — never depend on PATH being set.
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const regExe = systemRoot + '\\System32\\reg.exe'
  try {
    const res = spawnSync(regExe, ['query', hive], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (res.status !== 0 || typeof res.stdout !== 'string') return {}
    return parseRegQuery(res.stdout)
  } catch {
    return {}
  }
}

/** Unix: dump login shell env with a hard 3s timeout. `''` on any failure. */
function dumpLoginShellEnvReal(): string {
  try {
    const shell = process.env.SHELL || '/bin/bash'
    const res = spawnSync(shell, ['-lic', 'command env'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (res.status !== 0 || typeof res.stdout !== 'string') return ''
    return res.stdout
  } catch {
    return ''
  }
}

function realDeps(): ResolvedEnvDeps {
  return {
    platform: process.platform,
    baseEnv: process.env,
    readRegistryEnv: readRegistryEnvReal,
    dumpLoginShellEnv: dumpLoginShellEnvReal,
    exists: existsSync,
  }
}

/** Host-level resolution is expensive (spawns reg/shell) — cache it per process. */
let _cachedHost: HostEnvResult | null = null

/** Reset the host-resolution cache (tests only). */
export function resetResolvedEnvCache(): void {
  _cachedHost = null
}

/**
 * Environment variables that prevent CLI tools from launching interactive
 * programs which would block waiting for user input (pagers, editors,
 * credential prompts). Inspired by grok-build's `xai-tty-utils::pager_env()`.
 *
 * All spawn points that go through `getResolvedEnv()` inherit these
 * automatically. Spawn points that bypass it must apply `ANTI_INTERACTIVE_ENV`
 * manually.
 */
export const ANTI_INTERACTIVE_ENV: Record<string, string> = {
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GH_PAGER: 'cat',
  MANPAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0', // git never prompts for credentials interactively
  GIT_EDITOR: 'true',       // git never launches an editor
  GIT_SEQUENCE_EDITOR: 'true',
  GPG_TTY: '',              // empty = gpg/pinentry can't grab the tty, fails cleanly
}

/** Merge anti-interactive vars into an env object (last-wins override). */
function withAntiInteractive(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...ANTI_INTERACTIVE_ENV }
}

/**
 * The resolved environment for command execution: real host PATH + toolchain
 * vars + user config overlay. Host resolution is cached; config is re-read and
 * layered on every call so `cwd`-scoped `env.extraPath/extraVars` take effect.
 * When `config.env.resolve` is false, only the config overlay is applied.
 */
export function getResolvedEnv(cwd?: string): NodeJS.ProcessEnv {
  let envConfig: EnvConfig
  try {
    envConfig = loadConfig({ cwd }).env
  } catch {
    envConfig = { resolve: true, extraPath: [], extraVars: {} }
  }

  if (envConfig.resolve === false) {
    return withAntiInteractive(applyConfigEnv({ ...process.env }, envConfig, process.platform))
  }

  if (!_cachedHost) _cachedHost = resolveHostEnv(realDeps())
  const merged: NodeJS.ProcessEnv = { ..._cachedHost.vars, ...process.env }
  merged[_cachedHost.pathKey] = _cachedHost.path
  return withAntiInteractive(applyConfigEnv(merged, envConfig, process.platform))
}

/** PATH diff between the raw process env and the resolved env — for `/doctor`. */
export interface ResolvedPathDiff {
  processPath: string[]
  resolvedPath: string[]
  /** Entries present in resolved PATH but missing from the raw process PATH. */
  added: string[]
}

/** Compute how the resolved PATH differs from the raw process PATH (diagnostics). */
export function getResolvedPathDiff(cwd?: string): ResolvedPathDiff {
  const sep = process.platform === 'win32' ? ';' : ':'
  const rawKey = findPathKey(process.env)
  const processPath = splitPath(process.env[rawKey] ?? process.env.PATH ?? '', sep)
  const resolved = getResolvedEnv(cwd)
  const resKey = findPathKey(resolved)
  const resolvedPath = splitPath(resolved[resKey] ?? resolved.PATH ?? '', sep)
  const existing = new Set(processPath.map(e => (process.platform === 'win32' ? e.toLowerCase() : e)))
  const added = resolvedPath.filter(e => !existing.has(process.platform === 'win32' ? e.toLowerCase() : e))
  return { processPath, resolvedPath, added }
}
