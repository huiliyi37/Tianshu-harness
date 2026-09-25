/**
 * Incremental test runner — runs only tests affected by the current branch changes.
 *
 * Logic:
 * 1. git diff main...HEAD to find changed files
 * 2. Map changed source files to test files via naming convention
 *    (src/X/foo.ts → src/X/__tests__/foo.test.ts)
 * 3. If no source changes found, exit with message (skip tests)
 * 4. Run tsx --test on affected test files
 * 5. Write results to .rivet/test-results.json for cross-session sharing
 *
 * Usage: npm run test:incremental
 *         npm run test:fast      (excludes TUI tests, known to time out)
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CWD = process.cwd()
const RESULTS_DIR = join(CWD, '.rivet')
const RESULTS_FILE = join(RESULTS_DIR, 'test-results.json')

function getChangedFiles(): string[] {
  try {
    const output = execSync('git diff --name-only main...HEAD', { encoding: 'utf-8', cwd: CWD, windowsHide: true })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    // If git command fails (e.g., no main branch, shallow clone), fall back to empty
    return []
  }
}

/**
 * Map a source file to its corresponding test file(s) using the project convention:
 *   src/<area>/foo.ts  →  src/<area>/__tests__/foo.test.ts
 *
 * Returns empty array if no matching test file exists on disk.
 */
function sourceToTestFiles(changedFile: string): string[] {
  // Already a test file — include it directly
  if (changedFile.endsWith('.test.ts') || changedFile.endsWith('.test.tsx')) {
    return [changedFile]
  }

  // Only handle source files
  if (!changedFile.endsWith('.ts') && !changedFile.endsWith('.tsx')) {
    return []
  }

  // Derive test path: src/<rest>/<name>.ts → src/<rest>/__tests__/<name>.test.ts
  const match = changedFile.match(/^(src\/.+)\/([^/]+)\.(ts|tsx)$/)
  if (!match) return []

  const dir = match[1]!
  const name = match[2]!

  // Skip test directories
  if (dir.includes('__tests__')) return []

  const candidates = [
    join(dir, '__tests__', `${name}.test.ts`),
    join(dir, '__tests__', `${name}.test.tsx`),
  ]

  return candidates.filter(f => existsSync(join(CWD, f)))
}

function main(): void {
  const changedFiles = getChangedFiles()

  if (changedFiles.length === 0) {
    console.log('No source changes detected against main, skipping incremental tests.')
    process.exit(0)
  }

  console.log(`Changed files (${changedFiles.length}):`)
  for (const f of changedFiles) {
    console.log(`  ${f}`)
  }

  // Map to test files
  const testFiles = new Set<string>()
  for (const f of changedFiles) {
    const tests = sourceToTestFiles(f)
    for (const t of tests) testFiles.add(t)
  }

  if (testFiles.size === 0) {
    console.log('\nNo matching test files found for changed sources. Skipping.')
    process.exit(0)
  }

  const testList = [...testFiles].sort()
  console.log(`\nRunning ${testList.length} affected test file(s):`)
  for (const t of testList) {
    console.log(`  ${t}`)
  }

  const testArgs = testList.join(' ')
  const command = `npx tsx --test ${testArgs}`

  console.log(`\nCommand: ${command}\n`)

  const startTime = Date.now()
  let exitCode = 0
  let stdout = ''
  let stderr = ''

  try {
    stdout = execSync(command, { encoding: 'utf-8', cwd: CWD, stdio: 'pipe', timeout: 120_000, windowsHide: true })
  } catch (err: any) {
    exitCode = err.status ?? 1
    stdout = err.stdout?.toString() ?? ''
    stderr = err.stderr?.toString() ?? ''
  }

  const durationMs = Date.now() - startTime

  // Parse test results from node:test output
  const passCount = (stdout.match(/✔/g) || []).length
  const failCount = (stdout.match(/✖/g) || []).length
  const skipCount = (stdout.match(/○/g) || []).length

  // Write results for cross-session sharing
  mkdirSync(RESULTS_DIR, { recursive: true })
  const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', cwd: CWD, windowsHide: true }).trim()
  const results = {
    timestamp: new Date().toISOString(),
    commit,
    durationMs,
    exitCode,
    testCount: testList.length,
    passCount,
    failCount,
    skipCount,
    files: testList,
  }
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + '\n', 'utf-8')

  console.log(`\nResults: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`)
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`Results saved to ${RESULTS_FILE}`)

  process.exit(exitCode)
}

main()
