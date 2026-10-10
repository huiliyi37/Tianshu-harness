/**
 * Project file enumeration + ranking for the desktop @file mention picker.
 *
 * `listProjectFiles` walks a session's cwd applying the same gitignore + silent-
 * layer filters the glob tool uses; the route caches the complete index. `rankFiles` is a pure
 * function (unit-tested) that orders candidates by relevance to a query string.
 *
 * Security: the walk is rooted at the session cwd and never follows symlinks or
 * descends into build/VCS dirs; the route layer passes only `session.cwd`.
 */
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { relativePosix } from '../path-format.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { GitignoreFilter } from '../tools/gitignore.js'
import { classifyPath } from '../context/attention-filter.js'
import { SCAN_EXCLUDE_DIRS } from '../tools/scan-excludes.js'
import { contextFilePriority, isSuggestedContextFile } from './file-context-policy.js'

const EXCLUDE_DIRS = SCAN_EXCLUDE_DIRS
const directoryEntries = (dir: string) => readdir(dir, { withFileTypes: true })

async function walk(
  dir: string,
  root: string,
  results: string[],
  gitignore: GitignoreFilter,
  visited: Set<string>,
): Promise<void> {

  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let entries: Awaited<ReturnType<typeof directoryEntries>>
  try {
    entries = await directoryEntries(dir)
  } catch {
    return
  }

  for (const s of entries) {
    const name = s.name
    if (isFilesystemMetadata(name)) continue
    const fullPath = join(dir, name)
    if (s.isSymbolicLink()) continue
    const rel = relativePosix(root, fullPath)
    const verdict = classifyPath(rel)
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      if (verdict.tier === 'L0_build') continue
      if (gitignore.isIgnored(root, fullPath)) continue
      await walk(fullPath, root, results, gitignore, visited)
    } else if (s.isFile()) {
      if (verdict.silent) continue
      if (gitignore.isIgnored(root, fullPath)) continue
      results.push(rel)
    }
  }
}

/** Enumerate project files under cwd (gitignore + silent-layer filtered). */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const gitignore = await GitignoreFilter.create(cwd)
  const results: string[] = []
  await walk(cwd, cwd, results, gitignore, new Set<string>())
  return results
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/** True if all chars of `q` appear in `s` in order (fuzzy subsequence match). */
function isSubsequence(s: string, q: string): boolean {
  let i = 0
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++
  }
  return i === q.length
}

/**
 * Rank file paths by relevance to `query` and return the top `limit`.
 * Pure + deterministic — unit-tested. Empty query prioritizes human files.
 */
export function rankFiles(paths: string[], query: string, limit = 50): string[] {
  return rankPaths(paths.filter(path => isSuggestedContextFile(path, query)), query, limit)
}

export function rankPaths(paths: string[], query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return [...paths]
      .sort((a, b) => contextFilePriority(a) - contextFilePriority(b) || depth(a) - depth(b) || a.length - b.length || a.localeCompare(b))
      .slice(0, limit)
  }

  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const base = basename(lower)
    let score: number
    if (base === q) score = 0
    else if (base.startsWith(q)) score = 1
    else if (base.includes(q)) score = 2
    else if (lower.includes(q)) score = 3
    else if (isSubsequence(lower, q)) score = 4
    else continue
    scored.push({ path, score })
  }

  scored.sort((a, b) =>
    a.score - b.score ||
    contextFilePriority(a.path) - contextFilePriority(b.path) ||
    a.path.length - b.path.length ||
    a.path.localeCompare(b.path),
  )
  return scored.slice(0, limit).map((s) => s.path)
}

// ── Single-level directory listing (for file browser tree) ──────

export interface DirEntry {
  path?: string
  name: string
  isDirectory: boolean
}

/**
 * List direct children of `dir` — one level only (not recursive).
 * Used by the desktop file browser to lazily build a tree on expand.
 * Excludes common build/dependency directories and gitignored entries.
 * Directories sorted first, then files, both alphabetical.
 * Returns [] for non-existent or unreadable directories.
 */
export async function listDirEntries(dir: string, strict = false): Promise<DirEntry[]> {
  let children: Awaited<ReturnType<typeof directoryEntries>>
  try {
    children = await directoryEntries(dir)
  } catch (err) {
    if (strict) throw err
    return []
  }
  const gitignore = await GitignoreFilter.create(dir)
  const entries: DirEntry[] = []
  for (const s of children) {
    const name = s.name
    if (isFilesystemMetadata(name)) continue
    // Exclude hidden dirs like .git, .rivet — but allow dotfiles (.env.example)
    if (name.startsWith('.') && EXCLUDE_DIRS.has(name)) continue
    const fullPath = join(dir, name)
    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      // 与文件分支同规则：gitignore 目录（.tmp-abort-*、coverage 等）不进树。
      // EXCLUDE_DIRS 只兜底 6 个硬编码常见项，项目自己的忽略规则靠这里生效。
      if (gitignore.isIgnored(dir, fullPath)) continue
      entries.push({ name, isDirectory: true })
    } else if (s.isFile()) {
      if (gitignore.isIgnored(dir, fullPath)) continue
      entries.push({ name, isDirectory: false })
    }
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

function depth(p: string): number {
  let n = 0
  for (let i = 0; i < p.length; i++) if (p[i] === '/') n++
  return n
}
