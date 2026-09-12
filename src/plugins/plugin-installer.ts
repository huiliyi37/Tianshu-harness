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
 */
function resolveNpmCommand(): string {
  const nodeBin = process.execPath
  const nodeDir = dirname(nodeBin)
  const isWindows = process.platform === 'win32'

  // Bundled npm layout mirrors the official Node.js archive layout.
  const candidates = isWindows
    ? [join(nodeDir, 'npm.cmd'), join(nodeDir, 'npm')]
    : [join(nodeDir, 'bin', 'npm')]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return isWindows ? 'npm.cmd' : 'npm'
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
  const nodeDir = dirname(process.execPath)
  const pathSep = isWindows ? ';' : ':'
  const currentPath = process.env.PATH || ''
  const pathWithNode = currentPath ? `${nodeDir}${pathSep}${currentPath}` : nodeDir

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
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const pathWithNode = process.env.PATH ? `${nodeDir}${pathSep}${process.env.PATH}` : nodeDir
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
