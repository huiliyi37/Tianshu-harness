/**
 * LSP server registry — maps file extensions to language servers and detects
 * which are installed, so the agent gets go-to-definition / diagnostics for
 * many languages instead of TypeScript only.
 *
 * Pure + injectable (`which` is passed in) so selection logic is unit-testable
 * without the servers actually being installed.
 */

import { execFileSync } from 'node:child_process'

export interface LspServerDef {
  id: string
  extensions: string[]
  command: string
  args: string[]
  /** LSP languageId base (refined per-extension by the manager). */
  languageId: string
  /** Binary that must exist on PATH (defaults to `command`). */
  binary?: string
  /** True when the launcher (e.g. npx) is assumed present without a PATH probe. */
  alwaysAvailable?: boolean
}

/**
 * Known servers, ordered by extension specificity. TypeScript is launched via
 * `npx -y` (matching the prior behavior) so it is always considered available.
 */
export const LSP_SERVERS: readonly LspServerDef[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'npx',
    args: ['-y', 'typescript-language-server', '--stdio'],
    languageId: 'typescript',
    alwaysAvailable: true,
  },
  { id: 'pyright', extensions: ['.py', '.pyi'], command: 'pyright-langserver', args: ['--stdio'], languageId: 'python' },
  { id: 'gopls', extensions: ['.go'], command: 'gopls', args: [], languageId: 'go' },
  { id: 'rust-analyzer', extensions: ['.rs'], command: 'rust-analyzer', args: [], languageId: 'rust' },
  { id: 'clangd', extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh'], command: 'clangd', args: [], languageId: 'cpp' },
  { id: 'jdtls', extensions: ['.java'], command: 'jdtls', args: [], languageId: 'java' },
]

export type WhichFn = (bin: string) => boolean

export function defaultWhich(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 800,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

function extOf(filePath: string): string {
  const i = filePath.lastIndexOf('.')
  return i >= 0 ? filePath.slice(i).toLowerCase() : ''
}

/** The server def that handles a given extension, or null. */
export function serverDefForExt(ext: string): LspServerDef | null {
  const e = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  return LSP_SERVERS.find(s => s.extensions.includes(e)) ?? null
}

export function isServerAvailable(def: LspServerDef, which: WhichFn = defaultWhich): boolean {
  if (def.alwaysAvailable) return true
  return which(def.binary ?? def.command)
}

/** The available server for a file, or null when unsupported / not installed. */
export function serverForFile(filePath: string, which: WhichFn = defaultWhich): LspServerDef | null {
  const def = serverDefForExt(extOf(filePath))
  if (!def) return null
  return isServerAvailable(def, which) ? def : null
}

/** All servers installed on this machine (for diagnostics / readiness checks). */
export function availableServers(which: WhichFn = defaultWhich): LspServerDef[] {
  return LSP_SERVERS.filter(s => isServerAvailable(s, which))
}
