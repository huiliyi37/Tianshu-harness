/**
 * Plugin loader — scans ~/.rivet/plugins/, validates manifests, dynamically
 * imports entry modules, and registers tools into the tool registry.
 *
 * Architecture decisions (per plan):
 *  - Entry: compiled JS file path relative to plugin root (方案 A).
 *  - Loading: async dynamic import, call during session startup alongside MCP init.
 *  - Failure isolation: single plugin failure → skip + warning, never block startup.
 *  - Conflict detection: plugin tool names vs registry → reject plugin, log conflict details.
 *  - Cache discipline: tools are registered during startup ONLY; mid-session
 *    install/enable takes effect next session.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rivetHome } from '../config/paths.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import { validatePathSafe } from '../tools/path-validate.js'
import { parseManifest, type PluginManifest, type PluginPackageJson } from './manifest.js'
import { skillRegistry, parseSkillMarkdown } from '../skills/skill-loader.js'

// ── Types ──────────────────────────────────────────────────────────

export interface PluginLoadResult {
  pluginName: string
  status: 'loaded' | 'skipped_disabled' | 'skipped_no_manifest' | 'skipped_invalid_manifest' | 'skipped_no_entry' | 'skipped_import_error' | 'skipped_conflict' | 'skipped_no_tools'
  toolCount?: number
  skillCount?: number
  hookCount?: number
  commandCount?: number
  error?: string
  /** Resolved hooks contributed by this plugin (only present when status='loaded'). */
  hooks?: PluginHookEntry[]
  /** Resolved commands contributed by this plugin (only present when status='loaded'). */
  commands?: PluginCommandEntry[]
}

/** A hook contributed by a plugin, with its script resolved to an absolute path.
 *  Merged into the user-hooks-runner alongside project-level .rivet/hooks.json. */
export interface PluginHookEntry {
  pluginName: string
  event: 'preTurn' | 'postTurn' | 'postTool' | 'postSession' | 'onError'
  /** Absolute path to the script inside the plugin directory. */
  script: string
  timeoutMs?: number
}

/** A slash command contributed by a plugin, with its .md resolved to an absolute
 *  path. Merged into the commands loader alongside .rivet/commands/*.md. */
export interface PluginCommandEntry {
  pluginName: string
  /** Command name (basename without .md). */
  name: string
  /** Absolute path to the .md prompt file. */
  file: string
}

export interface PluginsInitResult {
  scanned: number
  loaded: number
  skipped: number
  totalTools: number
  results: PluginLoadResult[]
  warnings: string[]
  /** Built-in tool names to suppress because a plugin has taken over. */
  suppressTools: string[]
  /** Hooks contributed by all loaded plugins (merged from manifest.hooks). */
  hooks: PluginHookEntry[]
  /** Slash commands contributed by all loaded plugins (merged from manifest.commands). */
  commands: PluginCommandEntry[]
}

/** Minimal config subset needed by the plugin loader. */
export interface PluginConfig {
  enabled?: Record<string, boolean>
}

/**
 * When a plugin loads successfully, remove these built-in tool names from the
 * registry. This is the "让位" (surrender) mechanism — plugins replace HTML
 * fallback tools with native format tools.
 *
 * Key: plugin name. Value: built-in tool names to suppress.
 */
export const PLUGIN_TOOL_SUPPRESS_MAP: Record<string, string[]> = {
  'office-pdf': ['create_pdf'],
  'office-excel': ['create_spreadsheet'],
  'office-ppt': ['create_presentation'],
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Initialize plugins: scan, validate, load, and register tools.
 *
 * @param pluginConfig - Config.plugins (enabled state). If undefined, all installed plugins are enabled.
 * @param toolRegistry - The ToolRegistry to register plugin tools into.
 * @param cwd - Session working directory for path validation.
 * @returns Structured result with per-plugin status and summary.
 */
export async function initializePlugins(
  pluginConfig: PluginConfig | undefined,
  toolRegistry: ToolRegistry,
  cwd: string,
): Promise<PluginsInitResult> {
  const pluginsDir = join(rivetHome(), 'plugins')
  const warnings: string[] = []
  const results: PluginLoadResult[] = []

  if (!existsSync(pluginsDir)) {
    return { scanned: 0, loaded: 0, skipped: 0, totalTools: 0, results, warnings, suppressTools: [], hooks: [], commands: [] }
  }

  let entries: string[]
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    warnings.push(`[plugins] Cannot read plugins directory: ${pluginsDir}`)
    return { scanned: 0, loaded: 0, skipped: 0, totalTools: 0, results, warnings, suppressTools: [], hooks: [], commands: [] }
  }

  const enabled = pluginConfig?.enabled ?? {}
  // Cross-plugin dedup set for slash command names (first-loaded wins).
  const commandNameSeen = new Set<string>()

  for (const dirName of entries) {
    const result = await loadOnePlugin(dirName, pluginsDir, enabled, toolRegistry, cwd, warnings, commandNameSeen)
    results.push(result)
    if (result.error) {
      warnings.push(`[plugins] ${result.pluginName}: ${result.error}`)
    }
  }

  const loaded = results.filter(r => r.status === 'loaded')
  const totalTools = loaded.reduce((sum, r) => sum + (r.toolCount ?? 0), 0)
  const suppressTools = loaded.flatMap(r => PLUGIN_TOOL_SUPPRESS_MAP[r.pluginName] ?? [])
  // Merge hooks + commands across all loaded plugins.
  const hooks = loaded.flatMap(r => r.hooks ?? [])
  const commands = loaded.flatMap(r => r.commands ?? [])

  return {
    scanned: entries.length,
    loaded: loaded.length,
    skipped: results.length - loaded.length,
    totalTools,
    results,
    warnings,
    suppressTools,
    hooks,
    commands,
  }
}

// ── Path safety wrapper ────────────────────────────────────────────

/** Path-like parameter names that the wrapper intercepts. */
const PATH_PARAM_NAMES = new Set(['file_path', 'destination_path', 'path', 'input_path', 'output_path', 'reference_path', 'actual_path'])

/** Parameter names that indicate a write operation. */
const WRITE_PARAM_NAMES = new Set(['destination_path', 'output_path'])

/** Tool names that indicate the tool writes files — used as fallback mode hint. */
const WRITE_TOOL_PATTERNS = [/write/, /create/, /generate/]

function inferPathMode(toolName: string, paramName: string): 'read' | 'write' {
  if (WRITE_PARAM_NAMES.has(paramName)) return 'write'
  for (const re of WRITE_TOOL_PATTERNS) {
    if (re.test(toolName)) return 'write'
  }
  return 'read'
}

/**
 * Wrap a plugin tool's execute as the plugin ABI adapter + path safety guard.
 *
 * ABI adapter (the load-bearing part): the core pipeline calls
 * `tool.execute(params: ToolCallParams)` with the model's arguments nested in
 * `params.input` — but the plugin convention (docs/plugins.md, all first-party
 * plugins) reads flat arguments (`params.file_path`). Without this adapter
 * every plugin tool receives undefined arguments in a real session while unit
 * tests calling the flat shape stay green. The adapter extracts `params.input`
 * and invokes the plugin with a flat args object, so plugin authors never
 * need to know ToolCallParams internals.
 *
 * Path safety: every parameter with a path-like name is validated through
 * validatePathSafe BEFORE the plugin runs, and the validated value is
 * SUBSTITUTED with the canonicalized absolute path — plugins resolving
 * relative paths against process.cwd() (≠ session cwd in server mode) was a
 * silent cross-session hazard.
 *
 * NOT a permission boundary (issue #216): this wrapper never consults
 * `manifest.permissions`. It only normalizes/validates PATH arguments; the
 * plugin's full Node privileges (fs/net/shell) are untouched. Declared
 * permissions are advisory — see PLUGIN_PERMISSIONS_NOTICE in ./manifest.ts.
 */
function wrapPluginTool(tool: Tool, loadCwd: string): Tool {
  const originalExecute = tool.execute.bind(tool)
  const props = (tool.definition.input_schema as Record<string, unknown>)?.properties as Record<string, unknown> | undefined

  const pathParams: Array<{ key: string; mode: 'read' | 'write' }> = []
  for (const key of Object.keys(props ?? {})) {
    if (PATH_PARAM_NAMES.has(key)) {
      pathParams.push({ key, mode: inferPathMode(tool.definition.name, key) })
    }
  }

  const adaptedExecute = async (params: ToolCallParams): Promise<ToolResult> => {
    const input = params?.input && typeof params.input === 'object' ? params.input : {}
    const args: Record<string, unknown> = { ...input }
    // Per-call session cwd wins over load-time cwd (multi-session server).
    const cwd = typeof params?.cwd === 'string' && params.cwd.length > 0 ? params.cwd : loadCwd

    for (const { key, mode } of pathParams) {
      const value = args[key]
      if (typeof value !== 'string' || value.length === 0) continue

      const result = validatePathSafe(cwd, value, mode)
      if (!result.ok) {
        return { content: `Path rejected: ${result.error}`, isError: true }
      }
      // Hand the plugin the canonicalized absolute path, not the raw input.
      args[key] = result.path
    }
    return originalExecute(args as unknown as ToolCallParams)
  }

  return {
    ...tool,
    execute: adaptedExecute,
  }
}

// ── Plugin skill loading ───────────────────────────────────────────

function pathStaysInDir(resolved: string, baseDir: string): boolean {
  return resolved === baseDir || resolved.startsWith(baseDir + sep)
}

/**
 * Load bundled skills declared in the plugin manifest.
 * Skill name conflicts skip individual skills (warn only); tool conflicts still reject the plugin.
 */
function loadPluginSkills(
  manifest: PluginManifest,
  pluginDir: string,
  warnings: string[],
): number {
  const skillPaths = manifest.skills
  if (!skillPaths || skillPaths.length === 0) return 0

  let loaded = 0
  for (const relPath of skillPaths) {
    const skillDir = resolve(pluginDir, relPath)
    if (!pathStaysInDir(skillDir, pluginDir)) {
      warnings.push(`[plugins] ${manifest.name}: skill path "${relPath}" escapes plugin directory`)
      continue
    }
    const skillFile = join(skillDir, 'SKILL.md')
    if (!existsSync(skillFile)) {
      warnings.push(`[plugins] ${manifest.name}: no SKILL.md at "${relPath}"`)
      continue
    }
    try {
      const folderName = relPath.split(/[/\\]/).filter(Boolean).pop() ?? manifest.name
      const def = parseSkillMarkdown(readFileSync(skillFile, 'utf-8'), folderName)
      if (skillRegistry.get(def.name)) {
        warnings.push(`[plugins] ${manifest.name}: skill "${def.name}" conflicts with existing skill — skipped`)
        continue
      }
      def.source = 'plugin'
      def.bodyPath = skillFile
      def.skillDir = skillDir
      skillRegistry.register(def)
      loaded++
    } catch (err) {
      warnings.push(`[plugins] ${manifest.name}: failed to load skill at "${relPath}": ${(err as Error).message}`)
    }
  }
  return loaded
}

/**
 * Load bundled hooks declared in the plugin manifest. Resolves each script to
 * an absolute path inside the plugin dir (path-escape guard). Returns the
 * resolved entries; the caller (initializePlugins) merges them across all
 * plugins and hands them to the user-hooks-runner. Does NOT write to
 * .rivet/hooks.json — plugin hooks stay in-memory + resolve from the plugin
 * directory, so removing the plugin instantly removes its hooks.
 */
function loadPluginHooks(
  manifest: PluginManifest,
  pluginDir: string,
  warnings: string[],
): PluginHookEntry[] {
  const decls = manifest.hooks
  if (!decls || decls.length === 0) return []

  const out: PluginHookEntry[] = []
  for (const decl of decls) {
    const scriptAbs = resolve(pluginDir, decl.script)
    if (!pathStaysInDir(scriptAbs, pluginDir)) {
      warnings.push(`[plugins] ${manifest.name}: hook script "${decl.script}" escapes plugin directory`)
      continue
    }
    if (!existsSync(scriptAbs)) {
      warnings.push(`[plugins] ${manifest.name}: hook script not found at "${decl.script}"`)
      continue
    }
    out.push({
      pluginName: manifest.name,
      event: decl.event,
      script: scriptAbs,
      ...(decl.timeoutMs !== undefined ? { timeoutMs: decl.timeoutMs } : {}),
    })
  }
  return out
}

/**
 * Load bundled slash commands declared in the plugin manifest. Each entry is
 * a path relative to the plugin root — either a single .md file or a directory
 * (scanned for *.md, like .rivet/commands/). Returns resolved entries; the
 * caller merges them across plugins. Command name conflicts skip the later
 * plugin's command (first-loaded wins), mirroring the skill conflict policy.
 */
function loadPluginCommands(
  manifest: PluginManifest,
  pluginDir: string,
  warnings: string[],
  seenNames: Set<string>,
): PluginCommandEntry[] {
  const paths = manifest.commands
  if (!paths || paths.length === 0) return []

  const out: PluginCommandEntry[] = []
  for (const relPath of paths) {
    const abs = resolve(pluginDir, relPath)
    if (!pathStaysInDir(abs, pluginDir)) {
      warnings.push(`[plugins] ${manifest.name}: command path "${relPath}" escapes plugin directory`)
      continue
    }
    if (!existsSync(abs)) {
      warnings.push(`[plugins] ${manifest.name}: command path not found at "${relPath}"`)
      continue
    }
    // Directory → scan *.md; file → single entry (must be .md).
    const stat = statSync(abs)
    const files: string[] = stat.isDirectory()
      ? readdirSync(abs).filter(f => f.endsWith('.md')).map(f => join(abs, f))
      : abs.endsWith('.md') ? [abs] : []
    for (const file of files) {
      const name = basename(file, '.md')
      if (seenNames.has(name)) {
        warnings.push(`[plugins] ${manifest.name}: command "/${name}" conflicts — skipped`)
        continue
      }
      seenNames.add(name)
      out.push({ pluginName: manifest.name, name, file })
    }
  }
  return out
}

// ── Per-plugin loading ─────────────────────────────────────────────

async function loadOnePlugin(
  dirName: string,
  pluginsDir: string,
  enabled: Record<string, boolean>,
  registry: ToolRegistry,
  cwd: string,
  warnings: string[],
  commandNameSeen: Set<string>,
): Promise<PluginLoadResult> {
  const pluginDir = join(pluginsDir, dirName)
  const pkgPath = join(pluginDir, 'package.json')

  // 1. Read package.json
  let pkg: PluginPackageJson
  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    pkg = JSON.parse(raw) as PluginPackageJson
  } catch {
    return { pluginName: dirName, status: 'skipped_no_manifest', error: 'Cannot read package.json' }
  }

  // 2. Extract and validate manifest
  const rawManifest = pkg.tianshu
  if (!rawManifest || typeof rawManifest !== 'object') {
    return { pluginName: dirName, status: 'skipped_no_manifest', error: 'No "tianshu" field in package.json' }
  }

  const parseResult = parseManifest(rawManifest)
  if (!parseResult.ok) {
    return {
      pluginName: rawManifest.name && typeof rawManifest.name === 'string' ? rawManifest.name : dirName,
      status: 'skipped_invalid_manifest',
      error: `Invalid manifest: ${parseResult.errors.join('; ')}`,
    }
  }

  const manifest: PluginManifest = parseResult.manifest

  // 3. Check enabled state (default: enabled)
  if (enabled[manifest.name] === false) {
    return { pluginName: manifest.name, status: 'skipped_disabled' }
  }

  // 4. Resolve entry path — must stay within pluginDir (prevent path traversal)
  const resolvedEntry = resolve(pluginDir, manifest.entry)
  if (!resolvedEntry.startsWith(pluginDir + sep) && resolvedEntry !== pluginDir) {
    return {
      pluginName: manifest.name,
      status: 'skipped_import_error',
      error: `Entry path "${manifest.entry}" escapes plugin directory`,
    }
  }

  // 5. Dynamic import — use pathToFileURL for cross-platform safety.
  //    Windows absolute paths (C:\...) are interpreted as URL protocol by
  //    ESM, causing ERR_UNSUPPORTED_ESM_URL_SCHEME.
  let pluginModule: unknown
  try {
    pluginModule = await import(pathToFileURL(resolvedEntry).href)
  } catch (err) {
    return {
      pluginName: manifest.name,
      status: 'skipped_import_error',
      error: `Cannot import entry "${manifest.entry}": ${(err as Error).message}`,
    }
  }

  // 6. Extract tools — the module must export `tools: Tool[]`
  const mod = pluginModule as Record<string, unknown>
  const tools: Tool[] | undefined = Array.isArray(mod.tools) ? mod.tools as Tool[] : undefined

  if (!tools || tools.length === 0) {
    return {
      pluginName: manifest.name,
      status: 'skipped_no_tools',
      error: 'Plugin module exports no "tools" array',
    }
  }

  // 6b. Wrap plugin tools with the ABI adapter + path safety guards.
  //     ABI: pipeline passes args nested in params.input; plugins read flat
  //     args — the wrapper bridges the two (without it plugin tools receive
  //     undefined arguments in real sessions).
  //     Safety: plugin tools bypass the core pipeline's validatePathSafe —
  //     xlsx_read could read ~/.ssh/id_rsa, pdf_create could write anywhere.
  //     The wrapper validates file-path params and substitutes canonicalized
  //     absolute paths (session-cwd-anchored, not process.cwd()).
  const wrappedTools = tools.map(t => wrapPluginTool(t, cwd))

  // 7. Conflict detection — reject entire plugin if any tool name collides
  const existingNames = new Set(registry.getAllNames())
  const conflicts: string[] = []
  for (const tool of wrappedTools) {
    if (existingNames.has(tool.definition.name)) {
      conflicts.push(tool.definition.name)
    }
  }
  if (conflicts.length > 0) {
    return {
      pluginName: manifest.name,
      status: 'skipped_conflict',
      error: `Tool name conflicts with existing registry entries: ${conflicts.join(', ')}`,
    }
  }

  // 8. Register tools
  for (const tool of wrappedTools) {
    registry.register(tool)
  }

  // 9. Load bundled skills (after tools succeed — skill conflict skips, never rejects plugin)
  const skillCount = loadPluginSkills(manifest, pluginDir, warnings)
  // 10. Load bundled hooks + commands (same fail-safe policy as skills).
  const hooks = loadPluginHooks(manifest, pluginDir, warnings)
  const commands = loadPluginCommands(manifest, pluginDir, warnings, commandNameSeen)

  return {
    pluginName: manifest.name,
    status: 'loaded',
    toolCount: tools.length,
    skillCount,
    hookCount: hooks.length,
    commandCount: commands.length,
    hooks,
    commands,
  }
}
