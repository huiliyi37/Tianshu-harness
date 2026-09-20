/**
 * Plugin manifest types and validation.
 *
 * Each plugin declares its metadata in its package.json under the `"tianshu"` field.
 * The shape mirrors npm package identity (name/version) plus plugin-specific fields
 * (entry point, tool declarations, permissions, minCoreVersion).
 *
 * Manifest validation uses zod for schema enforcement at plugin load time;
 * illegal manifests cause the plugin to be skipped (fail-safe, per architecture decision 6).
 *
 * NOTE: the `permissions` field is ADVISORY metadata, not a sandbox — it is
 * shown for install review and is NEVER enforced at runtime. See
 * PLUGIN_PERMISSIONS_NOTICE below and docs/plugins.md.
 */

import { z } from 'zod'

/** 插件名约束——同时是安装目录名与卸载目标。禁止分隔符/`..`/绝对路径形态，
 *  阻断 manifest name 路径穿越（安装可新建任意可写目录、removePlugin 可递归删除）。 */
export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// ── Tool descriptor (market display + conflict detection) ──────────

export const toolDescriptorSchema = z.object({
  /** Tool name as it appears in the agent's tool list. Must be unique across
   *  all registered tools (builtin + MCP + other plugins). */
  name: z.string().min(1).max(64),
  /** Human-readable one-liner for market display. */
  description: z.string().min(1).max(200),
})

export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>

// ── Permissions (advisory) ─────────────────────────────────────────
//
// `permissions` is a DECLARATIVE INTENT field, not an enforcement mechanism
// (issue #216). It is collected so install/review UIs can show what a plugin
// says it needs, and it has NO runtime effect. Plugins load via dynamic
// import() into the core process and run with the full privileges of that
// process — filesystem, network, and child_process are all reachable
// regardless of what is declared here. Declaring `{ net: false }` does NOT
// stop a plugin from opening a socket; declaring `{ shell: false }` does NOT
// stop it from spawning a process. Install = trust (see docs/plugins.md).

/** Advisory notice shown wherever declared permissions are surfaced. A
 *  statement of fact, not a promise: the runtime does not enforce these
 *  declarations, so the review step must never be mistaken for a sandbox. */
export const PLUGIN_PERMISSIONS_NOTICE =
  'Declared permissions are advisory only and are NOT enforced at runtime. '
  + 'Plugins run in-process with full Node.js privileges (filesystem, network, '
  + 'subprocesses, environment), so a plugin that declares limited permissions '
  + 'can still use them. Only install plugins you trust.'

export const permissionsSchema = z.object({
  /** Declared intent: plugin reads/writes files. Informational only — NOT enforced. */
  fs: z.boolean().optional(),
  /** Declared intent: plugin makes outbound network requests. Informational only — NOT enforced. */
  net: z.boolean().optional(),
  /** Declared intent: plugin executes shell commands. Informational only — NOT enforced. */
  shell: z.boolean().optional(),
})

export type Permissions = z.infer<typeof permissionsSchema>

// ── Manifest ───────────────────────────────────────────────────────

/** Hook events a plugin can bind. MUST stay in sync with VALID_EVENTS in
 *  src/hooks/user-hooks-runner.ts — duplicated here to avoid the plugins layer
 *  importing from the hooks layer (keeps the schema self-contained + testable). */
export const PLUGIN_HOOK_EVENTS = ['preTurn', 'postTurn', 'postTool', 'postSession', 'onError'] as const
export type PluginHookEvent = typeof PLUGIN_HOOK_EVENTS[number]

/** A single hook declared in the manifest. `script` is a path relative to the
 *  plugin root (resolved to absolute by plugin-loader). */
export const pluginHookSchema = z.object({
  event: z.enum(PLUGIN_HOOK_EVENTS),
  script: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
})
export type PluginHookDeclaration = z.infer<typeof pluginHookSchema>

export const pluginManifestSchema = z.object({
  /** Unique plugin id (npm package name convention). Charset-restricted:
   *  doubles as the install directory name — see PLUGIN_NAME_PATTERN. */
  name: z.string().min(1).max(128).regex(PLUGIN_NAME_PATTERN),
  /** Semver version. */
  version: z.string().min(1).max(32),
  /** Short description for market display. */
  description: z.string().min(1).max(500),
  /** Relative path from plugin root to the compiled JS entry module.
   *  PluginLoader resolves this against the plugin's installation directory. */
  entry: z.string().min(1),
  /** Tools this plugin registers. Used for market preview and conflict detection. */
  tools: z.array(toolDescriptorSchema).min(1),
  /** Declared permissions for install review. ADVISORY ONLY — not enforced at
   *  runtime; see PLUGIN_PERMISSIONS_NOTICE above. */
  permissions: permissionsSchema,
  /** Optional bundled skills — relative paths to directories containing SKILL.md. */
  skills: z.array(z.string().min(1)).optional(),
  /** Optional bundled hooks — event-bound scripts relative to plugin root.
   *  Resolved to absolute paths by plugin-loader; the user-hooks-runner merges
   *  them with project-level .rivet/hooks.json at fire time. */
  hooks: z.array(pluginHookSchema).optional(),
  /** Optional bundled slash commands — relative paths to .md files or
   *  directories under the plugin root. Loaded as /command-name prompts,
   *  same shape as .rivet/commands/*.md. */
  commands: z.array(z.string().min(1)).optional(),
  /** Minimum core version required (semver range, advisory only in v1). */
  minCoreVersion: z.string().optional(),
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>

// ── On-disk wrapper (what we read from package.json) ───────────────

/** The `package.json` shape we care about — just the `tianshu` field. */
export interface PluginPackageJson {
  name?: string
  version?: string
  tianshu?: Record<string, unknown>
}

// ── Validation helpers ─────────────────────────────────────────────

export interface ManifestValidationResult {
  ok: true
  manifest: PluginManifest
}

export interface ManifestValidationError {
  ok: false
  errors: string[]
}

export type ManifestParseResult = ManifestValidationResult | ManifestValidationError

/**
 * Parse and validate a plugin manifest from a raw `tianshu` field.
 * Returns structured result — callers decide whether to skip or abort.
 */
export function parseManifest(raw: unknown): ManifestParseResult {
  const result = pluginManifestSchema.safeParse(raw)
  if (result.success) {
    return { ok: true, manifest: result.data }
  }
  return {
    ok: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  }
}
