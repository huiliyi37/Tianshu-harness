/**
 * paths.ts — Unified runtime data path resolution.
 *
 * All code that needs to read or write under the user-level `.rivet/` tree
 * should go through this module instead of spelling out `join(homedir(), '.rivet', ...)`
 * directly. This is what makes custom storage locations (RIVET_HOME, desktop
 * launcher config, per-project overrides) possible.
 *
 * Resolution priority for the data root:
 *   1. process.env.RIVET_HOME
 *   2. platform default (%LOCALAPPDATA%\.rivet on Windows, ~/.rivet elsewhere)
 *
 * Legacy per-path environment variables still win for their specific scope:
 *   - RIVET_SESSION_DIR
 *   - RIVET_DESKTOP_DIR / RIVET_DESKTOP_SESSION_DIR
 *   - RIVET_CONFIG_PATH
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** Platform default data root, ignoring RIVET_HOME. */
export function defaultRivetHome(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '.rivet')
  }
  return join(homedir(), '.rivet')
}

/** Active data root. Honors RIVET_HOME then falls back to the platform default. */
export function rivetHome(): string {
  return process.env.RIVET_HOME || defaultRivetHome()
}

/** User global config file path. */
export function userConfigPath(): string {
  const fromEnv = process.env.RIVET_CONFIG_PATH
  if (fromEnv) return fromEnv

  const home = rivetHome()
  const candidate = join(home, 'config.json')

  // If the user pointed RIVET_HOME at a new location but there is no config
  // there yet, warn that the old default config still exists. Without this
  // the UI would silently look empty (no providers, no API keys).
  if (process.env.RIVET_HOME && !existsSync(candidate)) {
    const legacyPath = join(defaultRivetHome(), 'config.json')
    if (existsSync(legacyPath)) {
      process.stderr.write(
        `[rivet] RIVET_HOME is set to ${home}, but config.json is missing there.\n` +
        `  The previous config is still at ${legacyPath}.\n` +
        `  Use the desktop Settings > Storage page to migrate, or copy the file manually.\n`
      )
    }
  }

  return candidate
}

/**
 * Convert a cwd into a filesystem-safe session directory slug.
 *
 * Shape: `<basename>-<hash6>`. The hash is computed from the full cwd so
 * different projects never collide.
 *
 * Cross-platform safety (Windows was hit by ENOENT here before):
 *  - Split on both `/` and `\` so `D:\tianshu\proj` does not use the whole
 *    path as the basename (the `D:` colon is illegal in NTFS directory names).
 *  - Sanitize NTFS illegal characters (`\ / : * ? " < > |` and control chars)
 *    to `_`.
 *
 * Backward compatibility: POSIX paths have no `\`, so the split behaves like
 * the old `split('/')`; basenames do not contain illegal chars, so sanitizing
 * is a no-op. Existing macOS/Linux session directory names stay unchanged.
 */
function sanitizePathSegment(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'unknown'
}

export function projectSlug(cwd: string): string {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() || 'unknown'
  const safeName = sanitizePathSegment(name)
  // Canonicalize cwd before hashing: on Windows, D:\Proj and d:\proj must
  // produce the same slug (filesystem is case-insensitive + separator-agnostic).
  // toPosixPath normalizes separators; platform-specific lowercasing mirrors
  // canonicalPathKey's policy.
  const canonicalCwd = process.platform === 'win32'
    ? cwd.replaceAll('\\', '/').toLowerCase()
    : cwd
  const hash = createHash('sha256').update(canonicalCwd).digest('hex').slice(0, 6)
  return `${safeName}-${hash}`
}

/** Session directory for a project. Honors RIVET_SESSION_DIR. */
export function sessionsDir(cwd?: string): string {
  if (process.env.RIVET_SESSION_DIR) return process.env.RIVET_SESSION_DIR
  if (cwd) return join(rivetHome(), 'sessions', projectSlug(cwd))
  return join(rivetHome(), 'sessions')
}

/** Desktop sidecar data root. Honors RIVET_DESKTOP_DIR. */
export function desktopDir(): string {
  return process.env.RIVET_DESKTOP_DIR ?? join(rivetHome(), 'desktop')
}

/** Desktop sidecar session persistence directory. Honors RIVET_DESKTOP_SESSION_DIR. */
export function desktopSessionsDir(): string {
  return process.env.RIVET_DESKTOP_SESSION_DIR ?? join(desktopDir(), 'sessions')
}

/** Cross-session memory directory for a project hash. */
export function memoryDir(hash: string): string {
  return join(rivetHome(), 'memory', hash)
}

/** Checkpoint file path scoped by cwd slug. */
export function checkpointPath(slug: string): string {
  return join(rivetHome(), `checkpoint-${slug}.json`)
}

/** Per-workspace path grants file. */
export function pathGrantsPath(slug: string): string {
  return join(rivetHome(), `path-grants-${slug}.json`)
}

/**
 * Computer Use per-app grant file — machine-level (NOT per-project): once you
 * trust Codex-style GUI automation to drive an app, that trust spans sessions
 * and projects. `base` lets tests inject a temporary home without RIVET_HOME.
 */
export function computerUseGrantsPath(base?: string): string {
  return join(base ?? rivetHome(), 'computer-use-grants.json')
}

/**
 * CDP 浏览器域策略文件 —— 可选；缺省不存在 = 保持现有 allow 行为。
 * 形态见 src/pro/computer-use/browser-policy.ts（or 环境变量
 * RIVET_CU_BROWSER_POLICY 覆盖，JSON 同构）。
 */
export function computerUseBrowserPolicyPath(base?: string): string {
  return join(base ?? rivetHome(), 'computer-use-browser-policy.json')
}

/**
 * computer_use 动作审计日志（JSONL，仅元数据：action/app/耗时/结果/路由；
 * 不含输入文本、URL query、截图）。RIVET_CU_JOURNAL=0 可关闭。
 */
export function computerUseJournalPath(base?: string): string {
  return join(base ?? rivetHome(), 'computer-use-journal.jsonl')
}

/** Directory holding per-cwd last-session pointer files. */
export function lastSessionPointerDir(): string {
  return join(rivetHome(), 'last-session')
}

/** Session registry state directory. */
export function stateDir(): string {
  return join(rivetHome(), 'state')
}

/** TUI command history file. */
export function historyPath(): string {
  return join(rivetHome(), 'history.json')
}

/** Update-check cache file. */
export function updateCheckPath(): string {
  return join(rivetHome(), 'update-check.json')
}

/**
 * /connect wizard draft — unfinished provider setup, saved on Esc and offered
 * for resume next time. Never holds a plaintext key: only a keyRef into
 * secrets.json. TTL/cleanup is owned by the reader. `base` lets tests inject
 * a temporary home without RIVET_HOME.
 */
export function connectDraftPath(base?: string): string {
  return join(base ?? rivetHome(), 'connect-draft.json')
}

/** Directory for durable claims exports from slash commands. */
export function exportsDir(): string {
  return join(rivetHome(), 'exports')
}

/**
 * Directory for persisted subagent/worker session data.
 *
 * `base` lets tests inject a temporary home without relying on RIVET_HOME.
 */
export function subagentsDir(base?: string): string {
  return join(base ?? rivetHome(), 'subagents')
}

/**
 * Directory for user-global workflow definitions.
 *
 * `base` lets tests inject a temporary home without relying on RIVET_HOME.
 */
export function workflowsDir(base?: string): string {
  return join(base ?? rivetHome(), 'workflows')
}

/**
 * Directory for user-global plan templates.
 *
 * `base` lets tests inject a temporary home without relying on RIVET_HOME.
 */
export function planTemplatesDir(base?: string): string {
  return join(base ?? rivetHome(), 'plan-templates')
}
