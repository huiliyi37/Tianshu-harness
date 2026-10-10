/**
 * Mirror fallback integration with real Git and an isolated, offline local repo.
 * A fixture Git config rewrites the fake GitHub URL to a missing local path;
 * file-only transport prevents network access. TRACE2 records actual clone URLs
 * so mirror memory is verified by attempts, independent of filesystem speed.
 */
import { describe, test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { cloneGitSource } from '../../git-source.js'
import { GITHUB_MIRRORS } from '../../../tools/mirror-env.js'
import { clearMirrorMemory } from '../../../tools/github-mirror-fallback.js'

// ── fixtures ───────────────────────────────────────────────────────

let workdir: string
let originRepo: string
let savedTemplate: string
let savedConfigPath: string | undefined
let tracePath: string
let savedGitEnv: NodeJS.ProcessEnv = {}
const originalUrl = 'https://github.com/test/repo.git'

function cloneUrls(): string[] {
  return readFileSync(tracePath, 'utf-8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { event?: string; argv?: string[] })
    .filter(row => row.event === 'start' && row.argv?.[1] === 'clone')
    .map(row => row.argv!.at(-2)!)
}

/**
 * Write a config.json with the given mirrors block and point RIVET_CONFIG_PATH
 * at it. Returns a cleanup fn. loadConfig re-reads on every call (no cache),
 * so each test gets an isolated config.
 */
function withConfig(mirrors: Record<string, unknown>): () => void {
  const cfgPath = join(workdir, `config-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(cfgPath, JSON.stringify({ mirrors }))
  const prev = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_CONFIG_PATH = cfgPath
  return () => {
    if (prev === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prev
    try { rmSync(cfgPath, { force: true }) } catch { /* best-effort */ }
  }
}

before(() => {
  workdir = mkdtempSync(join(tmpdir(), 'rivet-mirror-fallback-int-'))
  // Only synthetic Git configuration may affect these real subprocesses.
  savedGitEnv = {}
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('GIT_')) {
      savedGitEnv[name] = process.env[name]
      delete process.env[name]
    }
  }
  const configPath = join(workdir, 'gitconfig')
  const missingUrl = pathToFileURL(join(workdir, 'missing')).href + '/'
  writeFileSync(configPath, `[url "${missingUrl}"]\n\tinsteadOf = https://github.com/\n`)
  process.env.GIT_CONFIG_GLOBAL = configPath
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_ALLOW_PROTOCOL = 'file'
  process.env.GIT_TERMINAL_PROMPT = '0'
  tracePath = join(workdir, 'clone-trace.jsonl')
  originRepo = join(workdir, 'origin')
  mkdirSync(originRepo, { recursive: true })

  // Bootstrap a real local git repo; stage only documents, never sidecars.
  execSync('git init -q', { cwd: originRepo })
  execSync('git config user.email t@t', { cwd: originRepo })
  execSync('git config user.name test', { cwd: originRepo })
  writeFileSync(join(originRepo, 'package.json'), JSON.stringify({ name: 'fake-mirror-repo' }) + '\n')
  writeFileSync(join(originRepo, 'index.js'), "module.exports = {}\n")
  execSync('git add -- package.json index.js', { cwd: originRepo })
  execSync('git commit -q -m init', { cwd: originRepo })

  // Monkey-patch gitcode mirror to point at the local repo.
  // GITHUB_MIRRORS is a mutable `export const` object — direct prop assignment
  // works. We restore the original in after().
  savedTemplate = GITHUB_MIRRORS.gitcode.template
  GITHUB_MIRRORS.gitcode.template = pathToFileURL(originRepo).href
})

after(() => {
  // Strict restore — failure here would pollute other test suites.
  GITHUB_MIRRORS.gitcode.template = savedTemplate
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('GIT_')) delete process.env[name]
  }
  Object.assign(process.env, savedGitEnv)
  try { rmSync(workdir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

beforeEach(() => {
  clearMirrorMemory()
  writeFileSync(tracePath, '')
  process.env.GIT_TRACE2_EVENT = tracePath
  savedConfigPath = process.env.RIVET_CONFIG_PATH
})

afterEach(() => {
  if (savedConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
  else process.env.RIVET_CONFIG_PATH = savedConfigPath
})

// ── tests ──────────────────────────────────────────────────────────

describe('cloneGitSource mirror fallback (real git clone, offline)', () => {
  test('direct github.com fails → gitcode (local) succeeds, files present', async () => {
    // The missing local direct source fails deterministically; allow real local
    // Git enough time under full-suite external-volume I/O contention.
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: true,
      fallbackTimeoutSec: 60,
      fallbackMemoryMinutes: 10,
    })
    try {
      const result = await cloneGitSource(originalUrl)
      assert.deepEqual(cloneUrls(), [originalUrl, GITHUB_MIRRORS.gitcode.template])
      assert.ok(result.sourcePath, 'sourcePath returned')
      // Real clone happened — the local repo's files are present.
      assert.ok(existsSync(join(result.sourcePath, 'package.json')), 'package.json in clone')
      assert.match(result.commit, /^[0-9a-f]{40}$/, 'commit SHA captured')
      result.cleanup()
      // Idempotent cleanup.
      result.cleanup()
      // sourcePath removed after cleanup.
      assert.ok(!existsSync(result.sourcePath), 'temp dir cleaned up')
    } finally {
      restoreConfig()
    }
  })

  test('memory hit → second clone skips direct, only attempts gitcode', async () => {
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: true,
      fallbackTimeoutSec: 60,
      fallbackMemoryMinutes: 10,
    })
    try {
      // First clone seeds memory via fallback (direct fails, gitcode succeeds).
      const r1 = await cloneGitSource(originalUrl)
      r1.cleanup()

      assert.deepEqual(cloneUrls(), [originalUrl, GITHUB_MIRRORS.gitcode.template])

      // Measure real attempts: a cached mirror must omit the direct URL even
      // when the local filesystem takes longer than the former 2s assertion.
      writeFileSync(tracePath, '')
      const r2 = await cloneGitSource(originalUrl)
      r2.cleanup()
      assert.deepEqual(cloneUrls(), [GITHUB_MIRRORS.gitcode.template])
    } finally {
      restoreConfig()
    }
  })

  test('autoFallback=false → direct fails, no mirror attempted, throws', async () => {
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: false,
      fallbackTimeoutSec: 60,
    })
    try {
      await assert.rejects(
        cloneGitSource(originalUrl),
        (err: unknown) => {
          // autoFallback=false path re-throws the direct clone error as-is
          // (not the "All clone attempts failed" aggregate).
          const msg = err instanceof Error ? err.message : String(err)
          assert.ok(!msg.includes('All clone attempts'), 'should not aggregate-error when autoFallback off')
          return true
        },
      )
      assert.deepEqual(cloneUrls(), [originalUrl])
    } finally {
      restoreConfig()
    }
  })

  test('non-github URL (file://) → bypasses fallback, direct clone', async () => {
    // file:// is not a github URL → isGithubUrl false → no fallback path.
    // Should clone the local origin directly, regardless of mirror config.
    const restoreConfig = withConfig({
      enabled: false,
      autoFallback: true,
      fallbackTimeoutSec: 60,
    })
    try {
      const localUrl = pathToFileURL(originRepo).href
      const result = await cloneGitSource(localUrl)
      assert.deepEqual(cloneUrls(), [localUrl])
      assert.ok(result.sourcePath, 'sourcePath returned')
      assert.ok(existsSync(join(result.sourcePath, 'package.json')), 'package.json in clone')
      result.cleanup()
    } finally {
      restoreConfig()
    }
  })
})
