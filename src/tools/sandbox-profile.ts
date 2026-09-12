/**
 * Workspace-scoped command sandbox.
 *
 * Goal: let the agent run shell commands full-throttle and unattended while a
 * kernel-level boundary — not a stream of approval prompts — prevents writes
 * outside the workspace. The boundary is the filesystem WRITE scope:
 *   - reads: broad (the agent needs to inspect the system)
 *   - writes: confined to cwd + temp + package caches
 *   - network: allowed (build/test/git need it)
 *
 * Backends (selected per platform):
 *   - macOS  → Seatbelt profile via `sandbox-exec` (built-in)
 *   - Linux  → bwrap (preferred) or firejail (read-only root + writable cwd)
 *   - WSL    → reuse the Linux backend
 *   - native Windows → no lightweight kernel FS scope reachable from pure Node;
 *     fail soft (run unsandboxed with a loud note) and rely on the B2 full
 *     rollback safety net. AppContainer/Job-Object wrapping is a future native
 *     helper.
 *
 * Failure handling (four layers, see
 * docs/superpowers/plans/2026-07-26-sandbox-build-compat.md):
 *   1. attribution  → sandbox-diagnose.ts turns a bare "Operation not permitted"
 *                     into a named path + a request_path_access route
 *   2. escalation   → the model calls request_path_access; grantPath feeds back
 *                     into defaultWritableRoots on the very next wrap
 *   3. pre-flight   → sandbox-toolchain.ts widens the write set from marker
 *                     files (Xcode DerivedData, pnpm store, CocoaPods…)
 *   4. bypass       → sandbox-incompatible.ts lets brew/docker/codesign run
 *                     unwrapped but keeps them fail-closed for approval
 *
 * The pure functions here (profile/command builders, backend selection given
 * injected detectors) are unit-testable on any OS; the actual kernel
 * enforcement is exercised only on the matching platform.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeGrantedRoots } from './path-grants.js'
import { toolchainWritableRoots, currentToolchainCtx } from './sandbox-toolchain.js'
import { sandboxIncompatibleCommand } from './sandbox-incompatible.js'

export type SandboxBackendKind =
  | 'seatbelt'
  | 'bwrap'
  | 'firejail'
  | 'landlock'
  | 'none'

export interface SandboxContext {
  /** Workspace root — the only directory tree commands may write to. */
  cwd: string
  /** Override for tests. Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Override for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Override for tests. Probes whether a binary exists on PATH. */
  which?: (bin: string) => boolean
  /** Override for tests. Reads /proc/version for WSL detection. */
  readProcVersion?: () => string | null
  /** Override for tests. Probes Landlock launcher enforcement on this host
   *  (default: lazy-load the optional dep + real `--probe`, cached). */
  landlockUsable?: () => boolean
}

export interface SandboxDecision {
  /** The (possibly wrapped) command to hand to the shell. */
  command: string
  /** True when a real kernel boundary is in effect. */
  sandboxed: boolean
  backend: SandboxBackendKind
  /** Human-readable explanation (shown in diagnostics / UI). */
  note?: string
  /** The write roots that were in effect for this wrap. Consumed by
   *  classifySandboxDenial to tell "boundary refused it" from "already
   *  writable, so the refusal is something else". Absent when unsandboxed. */
  writableRoots?: readonly string[]
}

/** Escape a string for embedding inside POSIX single quotes. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Escape a path for embedding inside a Seatbelt double-quoted literal. */
function seatbeltQuote(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Default set of directories the sandbox permits writes to. The workspace cwd
 * plus the temp dir and the common package-manager caches so that
 * build/test/install workflows are not broken by the boundary.
 *
 * Extra roots can be appended via RIVET_SANDBOX_WRITABLE (path-list separated
 * by the platform delimiter — ':' on POSIX, ';' on Windows).
 */
export function defaultWritableRoots(ctx: { cwd: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string[] {
  const env = ctx.env ?? process.env
  const home = env.HOME || homedir()
  const tmp = env.TMPDIR || tmpdir()
  const roots = new Set<string>()

  roots.add(ctx.cwd)
  roots.add(tmp)
  roots.add('/tmp')
  // macOS-specific paths — only add on darwin (Linux/WSL doesn't have these;
  // bwrap bind-mount of a non-existent dir causes sandbox init failure).
  const isMac = (ctx.platform ?? process.platform) === 'darwin'
  if (isMac) {
    roots.add('/private/tmp')
    roots.add('/var/folders') // macOS per-user temp lives here
  }

  // Common package-manager / toolchain caches under HOME.
  for (const rel of [
    '.npm', '.cache', '.cargo', 'go', '.rustup', '.bun', '.deno',
    '.gradle', '.m2', '.pnpm-store', '.yarn', '.npm-cache',
    'Library/Caches',
  ]) {
    roots.add(join(home, rel))
  }

  const extra = env.RIVET_SANDBOX_WRITABLE
  if (extra) {
    // Path-list separator is platform-specific: ';' on Windows (where absolute
    // paths carry a drive-letter colon, e.g. C:\data), ':' on POSIX.
    const delim = (ctx.platform ?? process.platform) === 'win32' ? ';' : ':'
    for (const p of extra.split(delim)) {
      const trimmed = p.trim()
      if (trimmed) roots.add(trimmed)
    }
  }

  // Toolchain-implied roots (Xcode DerivedData, pnpm store, CocoaPods…).
  // Marker-file driven and cwd-cached; missing dirs are already filtered out
  // by the probe so bwrap's --bind never sees a non-existent path.
  for (const root of toolchainWritableRoots(
    currentToolchainCtx(ctx.cwd, env, ctx.platform ?? process.platform),
  )) {
    roots.add(root)
  }

  // User-approved out-of-workspace write grants (session or persisted). Recomputed
  // per command-wrap, so a grant approved mid-session takes effect on the next
  // bash call with no restart. Scoped to this command's cwd: the sidecar hosts
  // sessions from multiple workspaces, and a grant approved in workspace A must
  // not widen B's sandbox.
  for (const granted of writeGrantedRoots(ctx.cwd)) roots.add(granted)

  return [...roots]
}

/**
 * Seatbelt matches rules against the CANONICAL path, so a rule naming a
 * symlinked ancestor never fires. On macOS `/var` is a symlink to `/private/var`
 * — which is where the per-user temp dir actually lives — so
 * `(subpath "/var/folders")` denied every `mkdtemp` under $TMPDIR, and with it
 * most of the Node/npm/git toolchain (2026-08-02). `/tmp` had its twin spelled
 * out by hand; do it for every root instead, since cwd, user grants and
 * RIVET_SANDBOX_WRITABLE can traverse symlinks too. Resolving also drops the
 * trailing slash macOS puts on $TMPDIR, which `subpath` does not tolerate.
 */
function withCanonicalTwins(roots: string[], resolve: (p: string) => string): string[] {
  const out = new Set<string>()
  for (const root of roots) {
    out.add(root)
    try {
      out.add(resolve(root))
    } catch {
      // Root does not exist yet — the literal spelling still covers it once the
      // toolchain creates it, provided no symlink sits on the way.
    }
  }
  return [...out]
}

/** Build a Seatbelt profile that allows everything except writes outside roots. */
export function buildSeatbeltProfile(
  writableRoots: string[],
  resolvePath: (p: string) => string = (p) => realpathSync(p),
): string {
  const writeRules = withCanonicalTwins(writableRoots, resolvePath)
    .map(root => `  (subpath "${seatbeltQuote(root)}")`)
    .join('\n')
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    writeRules,
    ')',
    // Character devices that virtually every command needs to write to.
    '(allow file-write-data',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/dtracehelper")',
    ')',
    // Disk device access — hdiutil, diskutil, and DMG creation need to
    // read/write/ioctl /dev/disk* and /dev/rdisk* nodes. Seatbelt's
    // (allow default) already permits IOKit-open, but device nodes are
    // gated by file-read*/file-write*/file-ioctl rules.
    '(allow file-read* file-write* file-ioctl',
    '  (subpath "/dev/disk")',
    '  (subpath "/dev/rdisk")',
    ')',
  ].join('\n')
}

/** Wrap a command for macOS Seatbelt. */
export function buildSeatbeltCommand(command: string, writableRoots: string[]): string {
  const profile = buildSeatbeltProfile(writableRoots)
  return `sandbox-exec -p ${shSingleQuote(profile)} sh -c ${shSingleQuote(command)}`
}

/** Wrap a command for bubblewrap: read-only root, writable cwd + caches, network on. */
export function buildBwrapCommand(command: string, writableRoots: string[]): string {
  // Filter out non-existent directories — bwrap --bind fails on them and aborts
  // the entire sandbox (causing all bash commands to fail with exit 127).
  const validRoots = writableRoots.filter(p => { try { return existsSync(p) } catch { return false } })
  const binds = validRoots
    .map(root => `--bind ${shSingleQuote(root)} ${shSingleQuote(root)}`)
    .join(' ')
  return [
    'bwrap',
    '--ro-bind / /',
    '--dev-bind /dev /dev',
    binds,
    '--',
    `sh -c ${shSingleQuote(command)}`,
  ].join(' ')
}

/** Wrap a command for firejail: read-only root with explicit writable roots. */
export function buildFirejailCommand(command: string, writableRoots: string[]): string {
  const writes = writableRoots
    .map(root => `--read-write=${shSingleQuote(root)}`)
    .join(' ')
  return [
    'firejail',
    '--quiet',
    '--noprofile',
    '--read-only=/',
    writes,
    '--',
    `sh -c ${shSingleQuote(command)}`,
  ].join(' ')
}

/**
 * Wrap a command for the Landlock launcher（`@huiliyi37/node-addon-landlock-run`
 * 的预编译二进制，npm optional dep 自带、Linux 5.13+ 内核原生）。bwrap 需要
 * unprivileged userns/mount 且多数发行版不预装——landlock 是零外部依赖的可用
 * 性兜底 rung：self-restrict-then-exec，规则跨 execve 继承，沙箱内进程不可
 * 卸载。文件效果 allow-list（拒绝方言 EACCES），网络不隔离（与 bwrap 档同
 * 语义——network on）。旗标拼写是 launcher CLI 契约（--ro/--rw/--）的本地
 * 镜像，与包内 grantArgs 同源；此处保持纯函数（不耦合 optional dep），
 * 测试无包也能跑。
 */
export function buildLandlockCommand(
  command: string,
  writableRoots: string[],
  launcher: string = defaultLandlockLauncherPath(),
): string {
  // Filter out non-existent directories — 未创建的 root 拒绝授予（bwrap 同因：
  // 对不存在路径建规则只会得到启动失败）。
  const validRoots = writableRoots.filter(p => { try { return existsSync(p) } catch { return false } })
  const grants = [
    '--ro', '/',
    // /dev/null 必须可写——大量 CLI 把它当默认重定向目标（DSH 同款映射）。
    ...validRoots.flatMap(root => ['--rw', root] as const),
    '--rw', '/dev/null',
  ]
    .map(a => (a.startsWith('--') ? a : shSingleQuote(a)))
    .join(' ')
  return [
    shSingleQuote(launcher),
    grants,
    '--',
    `sh -c ${shSingleQuote(command)}`,
  ].join(' ')
}

/** Landlock 探测结果缓存：probe 是 spawnSync 短命子进程，进程内只跑一次。 */
let _landlockUsable: boolean | null = null

/** 惰性加载 optional dep 并真实探测（missing binary / 未装 / 内核不强制 →
 *  false，fail-closed 不裸奔声明）。require(esm) 在 Node 24 可同步加载纯
 *  ESM 包；安装被跳过（非 Linux 平台包）时 require 抛错 → false。 */
function defaultLandlockUsable(): boolean {
  if (_landlockUsable !== null) return _landlockUsable
  _landlockUsable = false
  if (process.platform !== 'linux') return false
  try {
    // mammoth 同款可选依赖模式：不进 RUNTIME_BUNDLED，缺失时静默降级。
    const req = createRequire(import.meta.url)
    const mod = req('@huiliyi37/node-addon-landlock-run') as {
      probe: (launcher?: string, opts?: { timeoutMs?: number }) => 'full' | 'partial' | 'unusable'
      launcherPath: () => string
    }
    _landlockUsable = mod.probe(mod.launcherPath()) !== 'unusable'
  } catch {
    _landlockUsable = false
  }
  return _landlockUsable
}

/** 惰性解析 launcher 二进制路径（探测通过后 wrap 时复用；不可用时不会被调）。 */
function defaultLandlockLauncherPath(): string {
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@huiliyi37/node-addon-landlock-run') as { launcherPath: () => string }
    return mod.launcherPath()
  } catch {
    return 'landlock-run'
  }
}

/** Detect whether the current Linux kernel is actually WSL. */
export function detectWsl(readProcVersion: () => string | null, env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_DISTRO_NAME) return true
  const version = readProcVersion()
  if (!version) return false
  return /microsoft|wsl/i.test(version)
}

function defaultReadProcVersion(): string | null {
  try {
    if (existsSync('/proc/version')) return readFileSync('/proc/version', 'utf-8')
  } catch { /* ignore */ }
  return null
}

function defaultWhich(bin: string): boolean {
  try {
    execFileSync('which', [bin], { encoding: 'utf-8', timeout: 500, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Choose the sandbox backend for the current platform. Pure given injected
 * detectors so tests can simulate any OS.
 */
export function selectSandboxBackend(ctx: SandboxContext): SandboxBackendKind {
  const platform = ctx.platform ?? process.platform
  const which = ctx.which ?? defaultWhich

  if (platform === 'darwin') {
    return which('sandbox-exec') ? 'seatbelt' : 'none'
  }

  // Linux and WSL share the same backend selection (bwrap > firejail > landlock).
  if (platform === 'linux') {
    if (which('bwrap')) return 'bwrap'
    if (which('firejail')) return 'firejail'
    // landlock 兜底 rung：npm optional dep 自带预编译二进制，不依赖系统预装
    // ——消灭"没装 bwrap 就无沙箱"。探测真实 enforcement（防有 syscall 但
    // 拒绝强制的内核），探测失败回 none（fail-closed）。
    if ((ctx.landlockUsable ?? defaultLandlockUsable)()) return 'landlock'
    return 'none'
  }

  // Native Windows (non-WSL): no pure-Node kernel FS scope.
  return 'none'
}

let _cachedActiveBackend: SandboxBackendKind | null = null

/**
 * Single source of truth for "did the user ask for the sandbox?".
 *
 * Both gates MUST consult this. History: 9a51debd flipped the default from
 * opt-out (RIVET_NO_SANDBOX=1) to opt-in (RIVET_SANDBOX=1) but only updated
 * wrapSandboxCommand + getSandboxStartupNotice — isSandboxActive kept reading
 * the retired RIVET_NO_SANDBOX and therefore reported "boundary in effect" on
 * every macOS box while no boundary was applied. The approval cascade
 * (tool-pipeline.ts) trusted that report and relaxed bash-write approval.
 *
 * 'learn' is the self-healing data-collection mode (see wrapSandboxCommand):
 * it applies a real boundary, so it counts as requested.
 */
export function sandboxRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RIVET_SANDBOX === '1' || env.RIVET_SANDBOX === 'learn'
}

/**
 * Whether a real kernel write-boundary is in effect for the current process.
 * Backend probe is cached (it cannot change mid-run); the env gate is not.
 * Used by the approval cascade: when true, in-workspace bash writes are
 * safe-by-construction (boundary + rollback) and need not interrupt the user;
 * when false we stay fail-closed and keep requiring approval for write commands.
 */
export function isSandboxActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!sandboxRequested(env)) return false
  if (_cachedActiveBackend === null) {
    _cachedActiveBackend = selectSandboxBackend({ cwd: process.cwd() })
  }
  return _cachedActiveBackend !== 'none'
}

/**
 * Couple the sandbox to the approval mode.
 *
 * 2026-09-07 语义变更（用户产品决策）：YOLO = 「完全权限」档——免审批 + 无写沙箱，
 * 全自动无人值守场景可全盘读写（此前 Codex 式"YOLO 免审批 + 自动开沙箱兜底"被否决：
 * 沙箱把 ~/.supabase 等外部路径写入拦死，与全自动冲突）。沙箱现在只由显式
 * RIVET_SANDBOX=1 开启（或 =learn 采集模式）；approval 模式不再影响沙箱。
 *
 * 保留逃生语义：显式 RIVET_SANDBOX 永远赢（本函数对已设置的环境变量 no-op）。
 * 想要沙箱兜底的 YOLO 用户：RIVET_SANDBOX=1（或桌面端保持沙箱开关）。
 *
 * Idempotent; safe to call again on a mid-session mode switch.
 *
 * ⚠️  MUTATES process.env: relies on in-process env mutation being immediately
 * visible to subsequent sandboxRequested() calls within the same event loop.
 * This is the established Node.js contract (process.env writes are synchronous
 * and visible) and is the same pattern used by bootstrap / applyPermission.
 */
export function applySandboxPolicyForApprovalMode(
  approvalMode: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Approval mode no longer drives the sandbox (yolo = full permission).
  // Sandbox is opt-in via explicit RIVET_SANDBOX=1 only.
  void approvalMode
}

/**
 * Config-declared full-permission (agent.unsandboxed) → env default.
 *
 * P1-1（2026-09-07 审查）：bootstrap 曾无条件把 config.unsandboxed 落成
 * RIVET_SANDBOX=0，踩掉用户显式设置的 RIVET_SANDBOX=1——与上方
 * 「显式 RIVET_SANDBOX 永远赢」的逃生语义矛盾。本函数仅当 env 未显式设置
 * 时才落默认 '0'；显式环境变量（含 =1/=learn/=0）一律保留。
 * Idempotent; safe to call at every bootstrap / config reload.
 */
export function applyUnsandboxedEnvDefault(unsandboxed: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (unsandboxed && env.RIVET_SANDBOX === undefined) env.RIVET_SANDBOX = '0'
}

/**
 * Whether a real write boundary covers THIS command. The approval cascade must
 * use this rather than isSandboxActive(): the sandbox is process-level but the
 * incompatible-command bypass is per-command, and a bypassed command must not
 * inherit the boundary's approval exemption.
 */
export function sandboxCoversCommand(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isSandboxActive(env)) return false
  return sandboxIncompatibleCommand(command) === null
}

/** Test-only: reset the cached backend probe. */
export function _resetSandboxBackendCache(): void {
  _cachedActiveBackend = null
}

export interface SandboxNotice {
  level: 'warn' | 'info'
  message: string
}

/**
 * Compute the startup notice about the command sandbox's protection level.
 * Pure (given injected detectors) so it is unit-testable on any OS.
 *
 * Returns:
 *   - a 'warn' when RIVET_SANDBOX=1 but NO kernel write boundary is available,
 *     or on native Windows with no backend — the user asked for protection
 *     and it can't be delivered;
 *   - null when sandbox is OFF by default (normal dev mode) or a real boundary
 *     (seatbelt/bwrap/firejail) is in effect.
 */
export function getSandboxStartupNotice(ctx: SandboxContext): SandboxNotice | null {
  const env = ctx.env ?? process.env
  const platform = ctx.platform ?? process.platform

  if (env.RIVET_SANDBOX === '1') {
    const backend = selectSandboxBackend(ctx)
    if (backend !== 'none') return null // sandbox requested + available → no warning
    
    const base = 'RIVET_SANDBOX=1 已设置，但无可用的沙箱后端；命令以无写边界执行。'
    return {
      level: 'warn',
      message: platform === 'win32'
        ? base + ' 你在原生 Windows 上：命令可写系统目录，风险显著高于 mac/linux。'
        : base,
    }
  }

  return null // sandbox OFF by default — expected, no warning
}

let _emittedNoSandboxWarning = false

/**
 * Emit the no-sandbox warning at most once per process. Wired into startup so
 * the exposure is announced up-front rather than buried in tool output. The
 * logger defaults to console.error (stderr), matching the rest of bootstrap.
 */
export function maybeWarnNoSandbox(
  ctx: SandboxContext,
  log: (msg: string) => void = (m) => console.error(m),
): SandboxNotice | null {
  if (_emittedNoSandboxWarning) return null
  const notice = getSandboxStartupNotice(ctx)
  if (!notice) return null
  _emittedNoSandboxWarning = true
  log(`[sandbox] ${notice.message}`)
  return notice
}

/** Test-only: reset the one-time warning latch. */
export function _resetSandboxWarningLatch(): void {
  _emittedNoSandboxWarning = false
}

/** Test-only: force the cached backend so isSandboxActive() is deterministic. */
export function _setSandboxBackendForTest(kind: SandboxBackendKind): void {
  _cachedActiveBackend = kind
}

/**
 * Wrap a shell command in a workspace-scoped sandbox. Default-OFF.
 * Enable with RIVET_SANDBOX=1 (production/deployment hardening).
 */
export function wrapSandboxCommand(command: string, ctx: SandboxContext): SandboxDecision {
  const env = ctx.env ?? process.env
  const platform = ctx.platform ?? process.platform

  if (!sandboxRequested(env)) {
    return { command, sandboxed: false, backend: 'none' }
  }

  const incompatible = sandboxIncompatibleCommand(command)
  if (incompatible) {
    // Bypass the FS wrap but report sandboxed:false so the approval cascade
    // stays fail-closed for this command (tool-pipeline consults
    // sandboxCoversCommand, not the process-level isSandboxActive).
    return {
      command,
      sandboxed: false,
      backend: 'none',
      note: `沙箱旁路（${incompatible.id}）：${incompatible.reason} — 该命令不受写边界保护，需人工审批`,
    }
  }

  const backend = selectSandboxBackend(ctx)
  const writableRoots = defaultWritableRoots({ cwd: ctx.cwd, env, platform: ctx.platform })

  switch (backend) {
    case 'seatbelt':
      return {
        command: buildSeatbeltCommand(command, writableRoots),
        sandboxed: true,
        backend,
        note: 'macOS Seatbelt (writes confined to workspace + caches, network on)',
        writableRoots,
      }
    case 'bwrap':
      return {
        command: buildBwrapCommand(command, writableRoots),
        sandboxed: true,
        backend,
        note: 'bwrap (read-only root, writable workspace + caches, network on)',
        writableRoots,
      }
    case 'firejail':
      return {
        command: buildFirejailCommand(command, writableRoots),
        sandboxed: true,
        backend,
        note: 'firejail (read-only root, writable workspace + caches, network on)',
        writableRoots,
      }
    case 'landlock':
      return {
        command: buildLandlockCommand(command, writableRoots),
        sandboxed: true,
        backend,
        note: 'Landlock (kernel-native allow-list, read-only root, writable workspace + caches, network on)',
        writableRoots,
      }
    case 'none':
    default: {
      const readProcVersion = ctx.readProcVersion ?? defaultReadProcVersion
      const isWsl = platform === 'linux' && detectWsl(readProcVersion, env)
      const reason = platform === 'win32'
        ? 'native Windows has no lightweight kernel FS sandbox — relying on workspace rollback safety net'
        : isWsl
          ? 'WSL detected but bwrap/firejail not installed — install bubblewrap for a real boundary'
          : 'no sandbox backend available — install bubblewrap (Linux) or use WSL (Windows)'
      return { command, sandboxed: false, backend: 'none', note: reason }
    }
  }
}
