/**
 * /plugins/* routes — Plugin management for the desktop settings UI.
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET    /plugins/presets        list plugin presets + installed state
 *   GET    /plugins/installed       list installed plugins with status
 *   POST   /plugins/install         install a plugin from local path
 *   POST   /plugins/enable          enable/disable a plugin by name
 *   DELETE /plugins/:name           remove an installed plugin
 */
import { decodeRouteParam, type RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { loadConfig, saveConfig } from '../config/manager.js'
import { PLUGIN_PRESETS } from '../plugins/plugin-presets.js'
import { installPlugin, removePlugin, getInstalledPlugins, isPluginInstalled, type PluginSource } from '../plugins/plugin-installer.js'
import { invalidatePluginToolsCache } from './plugin-session-cache.js'
import { parseManifest } from '../plugins/manifest.js'
import { cloneGitSource, GitCloneError } from '../plugins/git-source.js'
import { readFileSync, existsSync } from 'node:fs'
import { join, isAbsolute, dirname, sep, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The project root in dev: the parent of dist/ (where main.js is emitted).
 * Packaged installs resolve first-party presets via `bundledPluginsDir()` —
 * `projectRoot()` alone lands on the install root (tsup flat chunks → three
 * dirnames), which does not contain `plugins/`.
 */
function projectRoot(): string {
  // In dev, process.env.RIVET_SIDECAR_ENTRY points to repo's dist/main.js.
  const entry = process.env.RIVET_SIDECAR_ENTRY
  if (entry) return dirname(dirname(entry))
  // Otherwise: module lives under dist/ (or a flat chunk next to main.js);
  // project root is parent of dist/.
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

/**
 * Locate the packaged `plugins/` tree shipped beside `rivet-runtime/`
 * (tauri maps `resources/plugins-staged` → `plugins`). Prefer the explicit
 * override from the desktop shell; fall back to siblings of this module.
 */
export function bundledPluginsDir(): string | null {
  const override = process.env.RIVET_BUNDLED_PLUGINS_DIR
  if (override) {
    try {
      if (existsSync(override)) return override
    } catch {
      /* fall through */
    }
  }
  let base: string
  try {
    base = dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
  // Packaged: rivet-runtime/{main,chunk-*.js} → ../plugins
  // Nested chunk layout (if any) → ../../plugins
  for (const candidate of [
    join(base, '..', 'plugins'),
    join(base, '..', '..', 'plugins'),
  ]) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Resolve a possibly-relative plugin source path to an absolute path.
 * Relative paths prefer the repo project root (dev); packaged presets under
 * `plugins/<id>` fall back to the bundled resources tree.
 */
export function resolveSourcePath(inputPath: string): string {
  if (isAbsolute(inputPath)) return inputPath
  const fromRoot = join(projectRoot(), inputPath)
  if (existsSync(fromRoot)) return fromRoot

  const normalized = normalize(inputPath)
  const pluginsPrefix = `plugins${sep}`
  const pluginsPrefixPosix = 'plugins/'
  if (
    normalized === 'plugins'
    || normalized.startsWith(pluginsPrefix)
    || normalized.startsWith(pluginsPrefixPosix)
  ) {
    const bundled = bundledPluginsDir()
    if (bundled) {
      const rest = normalized === 'plugins'
        ? ''
        : normalized.slice(normalized.startsWith(pluginsPrefix) ? pluginsPrefix.length : pluginsPrefixPosix.length)
      const candidate = rest ? join(bundled, rest) : bundled
      if (existsSync(candidate)) return candidate
    }
  }
  return fromRoot
}

/** Read a plugin manifest from a source WITHOUT installing. Used by the
 *  preflight (confirm=false) phase so the UI can show permissions before the
 *  user commits. Local sources read package.json directly; git sources clone
 *  to a temp dir, read, then clean up (the install path re-clones).
 *  For local sources the ok-result carries `resolvedSource` — the path is
 *  resolved ONCE here and handed to installPlugin, so install never probes a
 *  second time (and can never drift from what preflight validated). */
async function readSourceManifest(source: PluginSource): Promise<
  | { ok: true; manifest: Record<string, unknown>; resolvedSource?: PluginSource }
  | { ok: false; status: 400 | 502; error: string }
> {
  let sourcePath: string
  let cleanup: (() => void) | null = null
  let resolvedLocal: PluginSource | undefined

  if (source.kind === 'git') {
    try {
      const cloned = await cloneGitSource(source.url, source.ref)
      sourcePath = cloned.sourcePath
      cleanup = cloned.cleanup
    } catch (err) {
      const msg = err instanceof GitCloneError ? err.message : `Clone failed: ${(err as Error).message}`
      // 502 = upstream/clone failure (network, auth, repo missing); 400 = bad URL/ref.
      const status = msg.startsWith('Invalid git') ? 400 : 502
      return { ok: false, status, error: msg }
    }
  } else {
    sourcePath = resolveSourcePath(source.path)
    // Resolution fell through to a nonexistent path. In the packaged desktop,
    // projectRoot() is the install root (no repo tree), so a non-`plugins/`
    // relative path can never resolve — name the real problem instead of the
    // downstream "No package.json found" at a meaningless install-root path.
    if (!existsSync(sourcePath)) {
      return {
        ok: false,
        status: 400,
        error: isAbsolute(source.path)
          ? `Plugin path does not exist: ${sourcePath}`
          : `Cannot resolve relative path "${source.path}" (tried ${sourcePath}). In the packaged desktop app, install from an absolute path or a plugins/<id> preset.`,
      }
    }
    resolvedLocal = { kind: 'local', path: sourcePath }
  }

  try {
    const pkgPath = join(sourcePath, 'package.json')
    if (!existsSync(pkgPath)) {
      return { ok: false, status: 400, error: `No package.json found at ${sourcePath}` }
    }
    let manifest: Record<string, unknown> | undefined
    try {
      const raw = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (raw.tianshu && typeof raw.tianshu === 'object') {
        const parsed = parseManifest(raw.tianshu)
        if (parsed.ok) {
          manifest = parsed.manifest as unknown as Record<string, unknown>
        } else {
          return { ok: false, status: 400, error: `Invalid plugin manifest: ${parsed.errors.join('; ')}` }
        }
      }
    } catch {
      return { ok: false, status: 400, error: 'Cannot parse package.json' }
    }
    if (!manifest) {
      return { ok: false, status: 400, error: `No "tianshu" manifest field in package.json — not a Tianshu plugin.` }
    }
    return { ok: true, manifest, ...(resolvedLocal ? { resolvedSource: resolvedLocal } : {}) }
  } finally {
    cleanup?.()
  }
}

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export function buildPluginRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    // GET /plugins/presets — curated plugin catalog + which are installed.
    'GET /plugins/presets': withAuth(() => {
      const installed = getInstalledPlugins()
      const installedNames = new Set(installed.map(p => p.name))
      const cfg = loadConfig()

      // enabled is only meaningful for installed plugins — the config default
      // ("absent means enabled") must not leak `enabled: true` for plugins
      // that are not even installed (confuses the settings UI).
      const presets = PLUGIN_PRESETS.map(p => {
        const installed = installedNames.has(p.id)
        return {
          ...p,
          installed,
          enabled: installed && cfg.plugins.enabled[p.id] !== false,
        }
      })

      return { status: 200, body: { presets } }
    }, apiToken),

    // GET /plugins/installed — installed plugins with details.
    'GET /plugins/installed': withAuth(() => {
      const installed = getInstalledPlugins()
      const cfg = loadConfig()
      const result = installed.map(p => ({
        ...p,
        enabled: cfg.plugins.enabled[p.name] !== false,
      }))
      return { status: 200, body: { plugins: result } }
    }, apiToken),

    // POST /plugins/install — install from local path OR git URL.
    // Body forms (all accepted):
    //   { path: string, confirm?: boolean }                        — legacy local
    //   { source: { kind: 'local', path }, confirm?: boolean }    — new local
    //   { source: { kind: 'git', url, ref? }, confirm?: boolean } — git clone
    // Pre-flight: reads manifest BEFORE install, requires confirm:true to proceed.
    // For git sources, the preflight clones to a temp dir to read the manifest
    // (the install path re-clones — acceptable: clone is cheap, temp is cleaned).
    'POST /plugins/install': withAuth(async (body) => {
      const input = body as { path?: string; source?: PluginSource; confirm?: boolean }
      // Normalize to PluginSource. Legacy { path } == { kind: 'local', path }.
      const source: PluginSource | null = input.source
        ?? (typeof input.path === 'string' ? { kind: 'local', path: input.path } : null)
      if (!source) {
        return { status: 400, body: { error: 'Missing required field: source (or legacy path)' } }
      }
      if (source.kind !== 'local' && source.kind !== 'git') {
        return { status: 400, body: { error: `Unknown source kind: ${String((source as { kind?: string }).kind)}` } }
      }
      if (source.kind === 'git') {
        if (!source.url || typeof source.url !== 'string') {
          return { status: 400, body: { error: 'Missing source.url for git install' } }
        }
      } else if (!source.path || typeof source.path !== 'string') {
        return { status: 400, body: { error: 'Missing source.path for local install' } }
      }

      // Pre-flight: resolve the source to a readable manifest WITHOUT installing.
      // For local: resolve the path + read package.json directly.
      // For git: clone to a temp dir, read manifest, cleanup.
      const preflight = await readSourceManifest(source)
      if (!preflight.ok) {
        return { status: preflight.status, body: { ok: false, error: preflight.error } }
      }

      if (!input.confirm) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'Confirmation required. Review the manifest and permissions, then retry with confirm: true.',
            manifest: preflight.manifest,
            hint: 'Set confirm: true to proceed with installation.',
          },
        }
      }

      // Install from the preflight-resolved source: readSourceManifest
      // resolved the local path once (and validated it exists); reusing it
      // avoids a second resolve and any preflight→install drift. Git sources
      // re-clone by design (preflight's temp clone is already cleaned up).
      const result = await installPlugin(preflight.resolvedSource ?? source)
      if (result.ok) {
        // 插件集合变了——暖场缓存失效重建，下一个新会话拿到新工具（2026-09-12
        // sidecar 插件装配补齐；与路由承诺的 "Available on next session start" 对齐）。
        invalidatePluginToolsCache(loadConfig().plugins, process.cwd())
        return {
          status: 200,
          body: {
            ok: true,
            manifest: result.manifest,
            message: `Installed "${result.manifest.name}". Available on next session start.`,
          },
        }
      }
      return { status: 400, body: { ok: false, error: result.error } }
    }, apiToken),

    // POST /plugins/enable — enable or disable a plugin.
    // Body: { name: string, enabled: boolean }
    'POST /plugins/enable': withAuth((body) => {
      const input = body as { name?: string; enabled?: boolean }
      if (!input.name || typeof input.name !== 'string') {
        return { status: 400, body: { error: 'Missing required field: name' } }
      }
      if (typeof input.enabled !== 'boolean') {
        return { status: 400, body: { error: 'Missing required field: enabled (boolean)' } }
      }

      if (!isPluginInstalled(input.name)) {
        return { status: 404, body: { error: `Plugin "${input.name}" is not installed` } }
      }

      const cfg = loadConfig()
      cfg.plugins.enabled[input.name] = input.enabled
      saveConfig(cfg)
      // 启停即失效重建暖场缓存——"Takes effect on next session" 从此在 sidecar 成立。
      invalidatePluginToolsCache(cfg.plugins, process.cwd())

      return {
        status: 200,
        body: {
          ok: true,
          name: input.name,
          enabled: input.enabled,
          message: `Plugin "${input.name}" ${input.enabled ? 'enabled' : 'disabled'}. Takes effect on next session.`,
        },
      }
    }, apiToken),

    // DELETE /plugins/:name — remove an installed plugin.
    'DELETE /plugins/:name': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) {
        return { status: 400, body: { error: 'Missing plugin name in URL' } }
      }

      const result = removePlugin(name)
      if (result.ok) {
        invalidatePluginToolsCache(loadConfig().plugins, process.cwd())
        return { status: 200, body: { ok: true, message: `Removed plugin "${name}".` } }
      }
      return { status: 404, body: { ok: false, error: result.error } }
    }, apiToken),
  }
}
