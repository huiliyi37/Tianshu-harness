/**
 * Plugin installer — copy + npm install lifecycle for plugin packages.
 *
 * Supports local path sources (Wave 2). Npm package sources deferred.
 * Architecture decisions (per plan):
 *  - Install location: ~/.rivet/plugins/<name>/
 *  - npm install MUST use --ignore-scripts (no postinstall execution)
 *  - Installed plugins take effect next session (cache discipline)
 */

import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { cpSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { rivetHome } from '../config/paths.js'
import { hasRealNode } from '../platform/resolve-node-cli.js'
import { parseManifest, PLUGIN_NAME_PATTERN, type PluginManifest, type PluginPackageJson } from './manifest.js'
import { cloneGitSource, GitCloneError } from './git-source.js'

// ── npm resolution ─────────────────────────────────────────────────

/**
 * Resolve the npm command to use for plugin installs.
 *
 * The packaged desktop app bundles its own Node runtime (and now npm) under
 * `node-runtime/<os>-<arch>/`. When the sidecar is hosted by that runtime,
 * npm lives right next to the Node binary and we should use it so users do
 * not need a system Node/npm install.
 *
 * Falls back to the system `npm` command in dev / test environments where the
 * bundled npm is absent.
 *
 * 2026-09-25 修「存在 ≠ 可用」：判据原为 `existsSync`（文件在就选它），但打包
 * 桌面端内置的 npm 垫片**可能文件在、却跑不起来**——实测
 * `/Applications/Tianshu.app/Contents/Resources/node-runtime/darwin-arm64/bin/npm`
 * require 的 `../lib/cli.js` 不存在（该 runtime 的 `lib/` 下只有 `node_modules`），
 * 一执行即 `Cannot find module '../lib/cli.js'`。存在性检查命中它就返回、不再回落
 * 系统 npm，于是插件安装整条链路失败（`plugin-installer.test.ts` 3 条 +
 * `plugin-api.test.ts` 2 条用例红），且报错被包成
 * `npm install failed: <node 内部栈>`，从错误信息看不出真因是选错了 npm。
 * 现在改为**试跑 `npm --version`**：跑不通就当它不存在，继续回落。
 *
 * 导出供测试断言「返回的命令必须真的能跑」：
 * `__tests__/plugin-installer-npm-resolve.test.ts`。
 */
export function resolveNpmCommand(): string {
  const nodeDir = dirname(process.execPath)
  const isWindows = process.platform === 'win32'

  // Bundled npm layout mirrors the official Node.js archive layout.
  const candidates = isWindows
    ? [join(nodeDir, 'npm.cmd'), join(nodeDir, 'npm')]
    : [join(nodeDir, 'bin', 'npm')]

  for (const candidate of candidates) {
    if (existsSync(candidate) && npmUsable(candidate, nodeDir)) return candidate
  }

  return isWindows ? 'npm.cmd' : 'npm'
}

/** 宿主 node 目录放到 PATH——npm 垫片靠 PATH 解析 node（见 npmInstallArgs 注释）。
 *
 * issue #408：打包桌面端的 node-runtime 目录在 Windows 上只有 `node.cmd` 转发器、
 * 没有真 `node.exe`。把这种目录 prepend 到 PATH 前部会劫持系统真 node——`npm exec` /
 * `npm run` 里经 cmd 层启动 node 的脚本随之失败（报错指向一个不存在的相对路径）。
 * 有真 node → prepend（issue #149：确保子进程能找到 node）；只有转发器 → append 到
 * 末尾，系统真 node 优先命中，bundled 目录仍在 PATH 中可找到。
 *
 * deps 仅供测试注入（平台 / 基座 PATH / 文件系统），生产调用一律走进程真实环境。
 * 导出供 `__tests__/plugin-installer-node-path.test.ts` 断言两种排位。
 */
export function withNodeOnPath(
  nodeDir: string,
  deps: {
    platform?: NodeJS.Platform
    path?: string
    existsSync?: (path: string) => boolean
  } = {},
): string {
  const platform = deps.platform ?? process.platform
  const pathSep = platform === 'win32' ? ';' : ':'
  const currentPath = deps.path ?? process.env.PATH ?? ''
  if (!currentPath) return nodeDir
  return hasRealNode(nodeDir, platform, deps.existsSync ?? existsSync)
    ? `${nodeDir}${pathSep}${currentPath}`
    : `${currentPath}${pathSep}${nodeDir}`
}

/**
 * 试跑 `npm --version` 判定可用性——「文件在」不等于「能跑」。
 *
 * 任何失败（缺文件 / 超时 / 权限 / 非零退出）一律算不可用并回落，不抛错：调用方只
 * 需要知道「该用哪个 cmd」；真跑不通时的报错仍由 `npmInstallArgs` 那条路径负责。
 */
function npmUsable(cmd: string, nodeDir: string): boolean {
  try {
    execSync(`"${cmd}" --version`, {
      stdio: 'pipe',
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, PATH: withNodeOnPath(nodeDir) },
    })
    return true
  } catch {
    return false
  }
}

/**
 * Build the platform-aware shell invocation for npm install.
 *
 * Windows: `npm` is a `.cmd` script; Node's execSync needs `shell: true` to
 * resolve it. We also quote the npm path to handle spaces.
 *
 * Unix: execute the npm script directly (bundled) or via PATH fallback.
 */
function npmInstallArgs(cmd: string): { command: string; options: import('node:child_process').ExecSyncOptions } {
  const baseArgs = ['install', '--ignore-scripts', '--omit=dev']
  const isWindows = process.platform === 'win32'

  // Make sure the Node binary hosting this sidecar is on PATH before npm runs.
  // The packaged desktop app bundles its own Node/npm; npm's launcher script
  // resolves `node` via PATH, so without this it could pick up a system Node
  // (or none at all) and fail or use the wrong ABI.
  const pathWithNode = withNodeOnPath(dirname(process.execPath))

  const options: import('node:child_process').ExecSyncOptions = {
    stdio: 'pipe',
    timeout: 600_000,
    env: { ...process.env, NODE_ENV: 'production', PATH: pathWithNode },
  }

  if (isWindows) {
    // ExecSyncOptions.shell is typed as string in this @types/node version,
    // but the runtime accepts boolean. Use cmd.exe explicitly to satisfy TS.
    options.shell = process.env.ComSpec || 'cmd.exe'
    return { command: `"${cmd}" ${baseArgs.join(' ')}`, options }
  }

  return { command: `${cmd} ${baseArgs.join(' ')}`, options }
}

// ── Types ──────────────────────────────────────────────────────────

/** Discriminated source for installPlugin. `local` is a filesystem path;
 *  `git` clones from an arbitrary git URL (optional ref = branch/tag/commit). */
export type PluginSource =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; ref?: string }

/** Provenance of an installed plugin, persisted as `.tianshu-origin.json`
 *  inside the install dir. Lets the UI show "from github.com/x/y" and supports
 *  future upgrade (re-pull) flows. */
export interface PluginOrigin {
  kind: 'local' | 'git'
  /** Git-only: the cloned URL. */
  url?: string
  /** Git-only: the ref passed at install time (branch/tag/commit). */
  ref?: string
  /** Git-only: resolved commit SHA at clone time. */
  commit?: string
  installedAt: number
}

export interface InstallSuccess {
  ok: true
  manifest: PluginManifest
  installPath: string
}

export interface InstallError {
  ok: false
  error: string
}

export type InstallResult = InstallSuccess | InstallError

export interface RemoveResult {
  ok: boolean
  error?: string
}

/** Lightweight metadata about an installed plugin (for /plugin list). */
export interface InstalledPluginInfo {
  name: string
  version: string
  description: string
  installPath: string
  entry: string
  toolCount: number
  toolNames: string[]
  tools: string
  /** Source provenance (undefined for plugins installed before origin tracking). */
  origin?: PluginOrigin
}

// ── Public API ─────────────────────────────────────────────────────

/** Get the plugins installation root directory. */
export function pluginsDir(): string {
  return join(rivetHome(), 'plugins')
}

/**
 * Install a plugin from a local path or git URL.
 *
 * - `kind: 'local'` — copies the local dir + npm install (legacy behavior)
 * - `kind: 'git'` — clones from an arbitrary git URL (optional ref) into a
 *   temp dir, then runs the same install-from-local flow. The temp clone is
 *   cleaned up in a finally block regardless of success/failure.
 *
 * On git source, clone errors are surfaced as InstallError.error with the git
 * stderr attached, so the user sees "Repository not found" / "Could not read
 * username" etc. instead of an opaque message.
 */
export async function installPlugin(source: PluginSource): Promise<InstallResult> {
  if (source.kind === 'git') {
    let cloned: { sourcePath: string; commit: string; cleanup: () => void } | null = null
    try {
      cloned = await cloneGitSource(source.url, source.ref)
    } catch (err) {
      if (err instanceof GitCloneError) {
        return { ok: false, error: err.stderr ? `${err.message}` : err.message }
      }
      return { ok: false, error: `Clone failed: ${(err as Error).message}` }
    }
    try {
      const origin: PluginOrigin = {
        kind: 'git',
        url: source.url,
        ...(source.ref ? { ref: source.ref } : {}),
        ...(cloned.commit ? { commit: cloned.commit } : {}),
        installedAt: Date.now(),
      }
      return await installFromLocal(cloned.sourcePath, origin)
    } finally {
      cloned.cleanup()
    }
  }
  return installFromLocal(source.path)
}

/**
 * Install from a local directory: validate manifest → cpSync to
 * ~/.rivet/plugins/<name>/ → npm install → write origin metadata (if any).
 *
 * Extracted from the old installPlugin(sourcePath) so the git path can reuse
 * the exact same copy+install+metadata flow after cloning.
 */
async function installFromLocal(sourcePath: string, origin?: PluginOrigin): Promise<InstallResult> {
  // 1. Read package.json from source
  const srcPkgPath = join(sourcePath, 'package.json')
  let pkg: PluginPackageJson
  try {
    const raw = readFileSync(srcPkgPath, 'utf-8')
    pkg = JSON.parse(raw) as PluginPackageJson
  } catch {
    return { ok: false, error: `No valid package.json found at ${sourcePath}` }
  }

  const rawManifest = pkg.tianshu
  if (!rawManifest || typeof rawManifest !== 'object') {
    return { ok: false, error: 'No "tianshu" manifest field in package.json' }
  }

  const parseResult = parseManifest(rawManifest)
  if (!parseResult.ok) {
    return { ok: false, error: `Invalid manifest: ${parseResult.errors.join('; ')}` }
  }

  const manifest = parseResult.manifest
  const installPath = join(pluginsDir(), manifest.name)

  // 2. Check for duplicate
  if (existsSync(installPath)) {
    return { ok: false, error: `Plugin "${manifest.name}" is already installed. Use /plugin remove first.` }
  }

  // 3. Copy source tree
  try {
    mkdirSync(installPath, { recursive: true })
    cpSync(sourcePath, installPath, { recursive: true })
  } catch (err) {
    // Clean up partial copy
    try { rmSync(installPath, { recursive: true, force: true }) } catch {}
    return { ok: false, error: `Failed to copy plugin files: ${(err as Error).message}` }
  }

  // 4. Run npm install. Prefer `node + npm-cli.js` (resolveNpmCliCommand) so
  // we bypass npm.cmd's batch-script path resolution, which breaks on the
  // space-bearing "Program Files (x86)" install path (Cannot find module
  // 'npm\bin\npm-prefix.js'). Falls back to the system npm in dev/test.
  const nodeDir = dirname(process.execPath)
  const cliJs = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const installArgs = ['install', '--ignore-scripts', '--omit=dev']
  // 与 npmInstallArgs / npmUsable 同一处判定（issue #408）：nodeDir 里只有转发器时
  // 不抢占 PATH 首位，避免 npm 子进程解析 `node` 命中转发器。
  const pathWithNode = withNodeOnPath(nodeDir)
  try {
    if (existsSync(cliJs)) {
      // Direct: node <npm-cli.js> install --ignore-scripts --omit=dev
      execFileSync(process.execPath, [cliJs, ...installArgs], {
        cwd: installPath,
        stdio: 'pipe',
        timeout: 600_000,
        env: { ...process.env, NODE_ENV: 'production', PATH: pathWithNode },
        windowsHide: true,
      })
    } else {
      // Dev/test fallback: system npm via shell
      const npmCmd = resolveNpmCommand()
      const { command, options } = npmInstallArgs(npmCmd)
      execSync(command, { ...options, cwd: installPath, windowsHide: true })
    }
  } catch (err) {
    // Clean up failed install
    try { rmSync(installPath, { recursive: true, force: true }) } catch {}
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().slice(0, 500) ?? (err as Error).message
    return { ok: false, error: `npm install failed: ${stderr}` }
  }

  // 5. Persist origin metadata (git source). Best-effort: a failed write does
  // not roll back a successful install — the plugin works, just without
  // provenance for future upgrades.
  if (origin) {
    try {
      writeFileSync(join(installPath, '.tianshu-origin.json'), JSON.stringify(origin, null, 2) + '\n')
    } catch { /* best-effort */ }
  }

  return { ok: true, manifest, installPath }
}

/**
 * Check if a plugin is installed (directory exists with package.json).
 */
export function isPluginInstalled(name: string): boolean {
  const dir = join(pluginsDir(), name)
  return existsSync(join(dir, 'package.json'))
}

/**
 * List all installed plugins with their manifest info.
 */
export function getInstalledPlugins(): InstalledPluginInfo[] {
  const root = pluginsDir()
  if (!existsSync(root)) return []

  const results: InstalledPluginInfo[] = []
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)

    for (const name of entries) {
      const pkgPath = join(root, name, 'package.json')
      try {
        const raw = readFileSync(pkgPath, 'utf-8')
        const pkg = JSON.parse(raw) as PluginPackageJson
        if (pkg.tianshu && typeof pkg.tianshu === 'object') {
          const manifest = pkg.tianshu as Record<string, unknown>
          const tools = Array.isArray(manifest.tools) ? manifest.tools as Array<{ name: string }> : []
          // Origin provenance (git-installed plugins). Absent for legacy installs.
          let origin: PluginOrigin | undefined
          try {
            const originRaw = readFileSync(join(root, name, '.tianshu-origin.json'), 'utf-8')
            const parsed = JSON.parse(originRaw) as PluginOrigin
            if (parsed && typeof parsed.kind === 'string') origin = parsed
          } catch { /* no origin file — legacy local install */ }
          results.push({
            name: (manifest.name as string) ?? name,
            version: (manifest.version as string) ?? 'unknown',
            description: (manifest.description as string) ?? '',
            entry: (manifest.entry as string) ?? '',
            installPath: join(root, name),
            toolCount: tools.length,
            toolNames: tools.map(t => t.name),
            tools: tools.map(t => t.name).join(', '),
            ...(origin ? { origin } : {}),
          })
        }
      } catch {
        // Skip directories without readable package.json
      }
    }
  } catch {
    // best-effort listing
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Remove an installed plugin (deletes its directory).
 */
export function removePlugin(name: string): RemoveResult {
  // name 直接拼进递归 rmSync 的目标——模式校验防路径穿越（纵深防御，
  // 与 manifest schema 同一约束；调用方 name 来自用户/桌面端输入）。
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    return { ok: false, error: `Invalid plugin name: "${name}"` }
  }
  const dir = join(pluginsDir(), name)
  if (!existsSync(dir)) {
    return { ok: false, error: `Plugin "${name}" is not installed.` }
  }

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: `Failed to remove plugin: ${(err as Error).message}` }
  }

  return { ok: true }
}
