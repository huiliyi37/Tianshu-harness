/**
 * Codebase Index — Project Perception Layer
 *
 * Provides a structured, incrementally-maintained index of module responsibilities,
 * CLI entry points, and exported symbols. Injected into agent volatile context so
 * the agent enters each session with project knowledge, eliminating redundant grep
 * exploration.
 *
 * Design principles (from plan docs/superpowers/plans/2026-06-07-project-perception-codebase-wiki.md):
 * - A-class facts (per-file, independent): stored in MeridianDB, incrementally updated
 * - B-class facts (cross-file aggregates): computed at injection time, never persisted
 * - Every persisted fact carries verifiedAtCommit for staleness detection
 * - Index is generated from DB on demand — no shared flat files
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type { MeridianDb } from './meridian-db.js'
import type { ModuleSummaryEntry, CliEntry } from './meridian-types.js'

// ─── Public types ────────────────────────────────────────────────

export type ProjectState = 'empty' | 'cold' | 'indexed'

export interface CodebaseIndexSnapshot {
  modules: ModuleSummaryEntry[]
  cliEntries: CliEntry[]
  dbStats: { files: number; symbols: number; edges: number }
}

// ─── Project state detection ─────────────────────────────────────

/**
 * Detect the project's indexing state.
 * - empty: no source files indexed in DB
 * - cold: has source files in DB but no module_summaries
 * - indexed: module_summaries exist
 */
export function detectProjectState(cwd: string, db: MeridianDb): ProjectState {
  const summaries = db.getModuleSummaries()
  if (summaries.length > 0) return 'indexed'

  // Rely on DB as primary signal — it reflects actual indexed files,
  // not just top-level directory contents (which may be src/ + configs).
  const stats = db.getStats()
  if (stats.files === 0) return 'empty'

  return 'cold'
}

// ─── Directory-based module discovery ────────────────────────────

export interface DiscoveredModule {
  dirPath: string
  files: string[]
  exportedSymbols: Array<{ name: string; kind: string }>
}

/**
 * Group indexed files by their top-level directory under src/,
 * collecting exported symbols for each group.
 */
export function discoverModules(db: MeridianDb): DiscoveredModule[] {
  const allFiles = db.getAllFiles()
  const dirMap = new Map<string, { files: string[]; exports: Map<string, string> }>()

  for (const file of allFiles) {
    // Skip test files and non-src files
    if (file.includes('__tests__') || file.includes('.test.') || file.includes('.spec.')) continue

    const parts = file.split('/')
    if (parts.length < 2) continue
    // Group by first two path segments: src/agent/ or src/tools/
    const dir = parts.length >= 3 ? parts.slice(0, 2).join('/') + '/' : parts[0] + '/'

    if (!dirMap.has(dir)) {
      dirMap.set(dir, { files: [], exports: new Map() })
    }
    const entry = dirMap.get(dir)!
    entry.files.push(file)

    // Collect exported symbols — de-duplicate by name, keep first seen kind
    const symbols = db.getSymbolsForFile(file)
    for (const sym of symbols) {
      if (sym.exported && !entry.exports.has(sym.name)) {
        entry.exports.set(sym.name, sym.kind)
      }
    }
  }

  return Array.from(dirMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirPath, data]) => ({
      dirPath,
      files: data.files,
      exportedSymbols: Array.from(data.exports.entries()).map(([name, kind]) => ({ name, kind })),
    }))
}

// ─── Module summary seeding (static, no LLM) ────────────────────

/**
 * Load module descriptions from AGENTS.md (or AGENTS.md equivalent) in the
 * project root. Parses the architecture table format:
 *
 * | `src/agent/` | description text |
 *
 * Falls back to "module (top-export, next-export, ...)" for unmatched directories.
 * This is project-agnostic — it reads the USER's AGENTS.md, not a hardcoded map.
 */
function loadProjectModuleMap(cwd: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const fileName of ['AGENTS.md', '.rivet.md']) {
    const filePath = join(cwd, fileName)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8')
      // Match table rows: | `src/agent/` | description |
      const rowRe = /\|\s*`([^`]+)`\s*\|\s*([^|]+)\s*\|/g
      let m: RegExpExecArray | null
      while ((m = rowRe.exec(content)) !== null) {
        const dir = m[1]!.trim()
        const desc = m[2]!.trim()
        if (dir.includes('/') && desc.length > 0) {
          result.set(dir, desc)
        }
      }
    } catch { /* ignore */ }
  }
  return result
}

/**
 * Seed module summaries from existing DB data.
 * Reads AGENTS.md/.rivet.md for known descriptions (project-agnostic).
 * Falls back to top exported symbols for unknown modules.
 *
 * Returns the number of modules seeded.
 */
export function seedModuleSummaries(db: MeridianDb, headSha?: string, cwd?: string): number {
  const modules = discoverModules(db)
  if (modules.length === 0) return 0

  const commit = headSha ?? getHeadSha()
  const projectMap = cwd ? loadProjectModuleMap(cwd) : new Map<string, string>()
  let seeded = 0

  for (const mod of modules) {
    const summary = projectMap.get(mod.dirPath)
      ?? `module (${mod.exportedSymbols.slice(0, 3).map(s => s.name).join(', ')})`

    // Aggregate hash from all file content hashes in this module
    const fileHashes = mod.files
      .map(f => db.getSymbolsForFile(f).map(s => s.contentHash).join(','))
      .join(';')

    db.upsertModuleSummary({
      dirPath: mod.dirPath,
      summary,
      keyExports: mod.exportedSymbols.slice(0, 10).map(s => s.name),
      fileCount: mod.files.length,
      status: 'active',
      contentHash: fileHashes,
      verifiedAtCommit: commit || undefined,
    })
    seeded++
  }

  return seeded
}

// ─── CLI entry extraction (static analysis) ──────────────────────

/**
 * Extract CLI flag entries from main.tsx and headless.ts by scanning
 * for common patterns: args[0] ===, args.includes, args.indexOf.
 *
 * IMPORTANT: This records only the source FILE (not line number) as handler.
 * The plan (1.3) explicitly warns that grep-derived line numbers are unreliable
 * because the flag REFERENCE line ≠ the HANDLER line — args.includes('--goal')
 * may appear at line 300 but the actual handler logic is at line 894.  Injecting
 * grep-matched line numbers into the index would create the exact false-green the
 * plan identifies as "陈旧即说谎" — a confidently wrong fact worse than no fact.
 *
 * wired is set to false (unverified) by default. The agent (or a future AST
 * extractor) should verify and flip to true.
 */
export function extractCliEntries(
  mainTsxSource: string,
  headlessSource: string | null,
  mainTsxPath: string,
  headlessPath: string,
  headSha?: string,
): CliEntry[] {
  const entries: CliEntry[] = []
  const commit = headSha ?? getHeadSha()
  const seen = new Set<string>()

  function addEntry(flag: string, sourceFile: string): void {
    if (seen.has(flag)) return
    seen.add(flag)
    entries.push({
      flag,
      handler: sourceFile,
      wired: false,
      verifiedAtCommit: commit || undefined,
      sourceFile,
    })
  }

  // Pattern 1: args[0] === 'serve' / args[0] === '--help' etc.
  const args0Re = /args\[0\]\s*===\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = args0Re.exec(mainTsxSource)) !== null) {
    addEntry(match[1] ?? '', mainTsxPath)
  }

  // Pattern 2: args.includes('--goal') / args.includes('-p')
  const includesRe = /args\.includes\(\s*['"](-[^'"]+)['"]\s*\)/g
  while ((match = includesRe.exec(mainTsxSource)) !== null) {
    addEntry(match[1] ?? '', mainTsxPath)
  }

  // Pattern 3: args.indexOf('--port') / args.indexOf('--provider')
  const indexOfRe = /args\.indexOf\(\s*['"](-[^'"]+)['"]\s*\)/g
  while ((match = indexOfRe.exec(mainTsxSource)) !== null) {
    addEntry(match[1] ?? '', mainTsxPath)
  }

  // Pattern 4: headless.ts flag references — detect presence only
  if (headlessSource) {
    const headlessFlags = ['--json', '--stream-json', '--print', '-p', '--goal', '-g']
    for (const flag of headlessFlags) {
      if (headlessSource.includes(`'${flag}'`) || headlessSource.includes(`"${flag}"`)) {
        addEntry(flag, headlessPath)
      }
    }
  }

  return entries
}

// ─── Index generation for volatile context injection ─────────────

/**
 * Generate a compact codebase-index block for volatile context.
 * Designed to fit within ~500 tokens, covering module summaries
 * and CLI entry status.
 *
 * Staleness: if headSha differs from a fact's verifiedAtCommit,
 * mark it ⚠stale to prompt the agent to re-verify.
 */
export function generateCodebaseIndexBlock(
  db: MeridianDb,
  headSha?: string | null,
): string {
  const modules = db.getModuleSummaries()
  const cliEntries = db.getCliEntries()
  const stats = db.getStats()

  if (modules.length === 0 && cliEntries.length === 0 && stats.files === 0) return ''

  const sha = headSha ?? null
  const parts: string[] = []

  parts.push('<codebase-index>')
  parts.push(`Codebase: ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges`)
  if (!sha) {
    parts.push('(no git — staleness tracking unavailable)')
  }

  // Module summaries — compact table format
  if (modules.length > 0) {
    parts.push('')
    parts.push('Modules:')
    for (const m of modules) {
      const stale = isStale(sha, m.verifiedAtCommit) ? ' ⚠stale' : ''
      const exports = m.keyExports.length > 0 ? ` → ${m.keyExports.slice(0, 5).join(', ')}` : ''
      parts.push(`  ${m.dirPath} ${m.summary}${exports}${stale}`)
    }
  }

  // CLI entries — compact; ❓=unverified, ✅=confirmed wired
  if (cliEntries.length > 0) {
    parts.push('')
    parts.push('CLI:')
    for (const e of cliEntries) {
      const stale = isStale(sha, e.verifiedAtCommit) ? ' ⚠stale' : ''
      const icon = e.wired ? '✅' : '❓'
      parts.push(`  ${e.flag} → ${e.handler} ${icon}${stale}`)
    }
  }

  parts.push('</codebase-index>')
  return parts.join('\n')
}

// ─── Full rebuild (for /index command) ───────────────────────────

/**
 * Perform a full index rebuild:
 * 1. Discover modules from MeridianDB
 * 2. Seed module summaries (static)
 * 3. Extract CLI entries
 * 4. Store everything in DB
 *
 * Returns a summary string for the user.
 */
export function fullRebuild(
  db: MeridianDb,
  mainTsxSource: string,
  headlessSource: string | null,
  mainTsxPath: string,
  headlessPath: string,
  cwd?: string,
): string {
  const headSha = getHeadSha()

  // Seed module summaries
  const moduleCount = seedModuleSummaries(db, headSha, cwd)

  // Clear and re-extract CLI entries
  // (We re-insert all, upsert handles dedup via PK)
  const cliEntries = extractCliEntries(mainTsxSource, headlessSource, mainTsxPath, headlessPath, headSha)
  for (const entry of cliEntries) {
    db.upsertCliEntry(entry)
  }

  const stats = db.getStats()
  return `Index rebuilt: ${moduleCount} modules, ${cliEntries.length} CLI entries (${stats.files} files, ${stats.symbols} symbols indexed)`
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Get current HEAD SHA, or undefined if not in a git repo */
export function getHeadSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000, windowsHide: true }).trim()
  } catch {
    return ''
  }
}

/**
 * Check if a fact is stale relative to current HEAD.
 * Returns true when:
 *   1. We have a valid headSha (non-empty — we're in a git repo)
 *   2. The fact has a verifiedAtCommit
 *   3. They differ
 *
 * In non-git repos, headSha === '', and we conservatively return false
 * (no staleness detection possible). This is documented in the index block
 * as "no git — staleness tracking unavailable" when sha is empty.
 */
export function isStale(headSha: string | null | undefined, verifiedAtCommit: string | null | undefined): boolean {
  if (!headSha || !verifiedAtCommit) return false
  return headSha !== verifiedAtCommit
}
