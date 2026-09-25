#!/usr/bin/env node
/**
 * Copy the tracked git hooks in scripts/git-hooks/ into this checkout's hooks
 * directory so `pre-push` (root typecheck) is active for every developer.
 *
 * Designed to NEVER break `npm install`:
 *   - No-op when installed as a dependency (scripts/git-hooks is not in the
 *     published `files` list, so consumers simply don't have it).
 *   - No-op when there is no git repo (tarball / CI without a .git dir).
 *   - Resolves the real hooks path via `git rev-parse --git-path hooks`, so it
 *     respects worktrees and a custom core.hooksPath without mutating config.
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const srcDir = join(repoRoot, 'scripts', 'git-hooks')

if (!existsSync(srcDir)) process.exit(0) // installed as a dependency — nothing to do

let hooksDir
try {
  hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  process.exit(0) // not a git repo — skip silently
}
if (!hooksDir) process.exit(0)
if (!isAbsolute(hooksDir)) hooksDir = join(repoRoot, hooksDir)

try {
  mkdirSync(hooksDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const dest = join(hooksDir, name)
    copyFileSync(join(srcDir, name), dest)
    chmodSync(dest, 0o755)
    console.log(`[install-git-hooks] installed ${name} → ${dest}`)
  }
} catch (err) {
  // Never fail the install over a hook copy — just report and move on.
  console.warn(`[install-git-hooks] skipped (${err?.message ?? err})`)
}
