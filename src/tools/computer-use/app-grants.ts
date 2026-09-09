/**
 * Computer Use app grants — per-application "always allow" persistence.
 *
 * GUI automation is a broad attack surface (see, click, type in any app), so
 * the default is fail-closed: every action targeting an ungranted app goes
 * through the approval gate. When the user approves with "always allow", the
 * app is recorded here and future actions skip the prompt.
 *
 * Machine-level (NOT per-project): trusting an app to be driven is a property
 * of this machine's user, not of any one workspace. Stored at
 * ~/.rivet/computer-use-grants.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { computerUseGrantsPath } from '../../config/paths.js'

export interface ComputerUseGrant {
  /** App name (matches the target app of a computer_use action). */
  app: string
  /** Unix ms when the grant was recorded. */
  grantedAt: number
}

interface GrantsFile {
  version: 1
  apps: ComputerUseGrant[]
}

function readGrantsFile(path: string): GrantsFile {
  if (!existsSync(path)) return { version: 1, apps: [] }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<GrantsFile>
    if (!parsed || !Array.isArray(parsed.apps)) return { version: 1, apps: [] }
    // Defensive: keep only well-formed entries.
    const apps = parsed.apps.filter(
      (g): g is ComputerUseGrant => !!g && typeof g.app === 'string' && g.app.length > 0,
    )
    return { version: 1, apps }
  } catch {
    // Corrupt file — treat as empty (fail-closed: no grants).
    return { version: 1, apps: [] }
  }
}

function writeGrantsFile(path: string, file: GrantsFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf-8')
}

/** Normalize for comparison — app names are matched case-insensitively. */
function norm(app: string): string {
  return app.trim().toLowerCase()
}

/** List all granted apps (newest first). */
export function listGrantedApps(base?: string): ComputerUseGrant[] {
  const file = readGrantsFile(computerUseGrantsPath(base))
  return [...file.apps].sort((a, b) => b.grantedAt - a.grantedAt)
}

/** Whether the given app has an "always allow" grant. */
export function isAppGranted(app: string, base?: string): boolean {
  if (!app.trim()) return false
  const file = readGrantsFile(computerUseGrantsPath(base))
  const wanted = norm(app)
  return file.apps.some((g) => norm(g.app) === wanted)
}

/**
 * Record an "always allow" grant for an app. Idempotent — re-granting refreshes
 * the timestamp rather than duplicating. `now` is injectable for tests.
 */
export function grantApp(app: string, opts: { base?: string; now?: () => number } = {}): void {
  const name = app.trim()
  if (!name) return
  const path = computerUseGrantsPath(opts.base)
  const file = readGrantsFile(path)
  const wanted = norm(name)
  const existing = file.apps.find((g) => norm(g.app) === wanted)
  const ts = (opts.now ?? Date.now)()
  if (existing) {
    existing.grantedAt = ts
  } else {
    file.apps.push({ app: name, grantedAt: ts })
  }
  writeGrantsFile(path, file)
}

/** Remove an app's grant. Returns true if an entry was removed. */
export function revokeApp(app: string, base?: string): boolean {
  const path = computerUseGrantsPath(base)
  const file = readGrantsFile(path)
  const wanted = norm(app)
  const before = file.apps.length
  file.apps = file.apps.filter((g) => norm(g.app) !== wanted)
  if (file.apps.length === before) return false
  writeGrantsFile(path, file)
  return true
}
