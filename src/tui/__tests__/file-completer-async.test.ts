import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { getCompletions } from '../file-completer.js'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

test('real git failure outside a repository or for an absent cwd resolves to no suggestions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-completion-nongit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(await getCompletions('', root, 8), [])
  assert.deepEqual(await getCompletions('', join(root, 'absent'), 8), [])
})

test('a delayed real git query keeps the event loop responsive and preserves ignored/metadata filtering', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-completion-async-'))
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  mkdirSync(repo); mkdirSync(bin)
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  execFileSync(git, ['init', '-q'], { cwd: repo, timeout: 30_000 })
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', '中文.ts'), '')
  writeFileSync(join(repo, 'src', '._中文.ts'), '')
  writeFileSync(join(repo, 'src', 'ignored.ts'), '')
  writeFileSync(join(repo, '.gitignore'), 'src/ignored.ts\n')
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 0.65\nexec ${quote(git)} "$@"\n`, { mode: 0o755 })
  const oldPath = process.env.PATH
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  process.env.GIT_CONFIG_GLOBAL = join(root, 'absent-config')
  t.after(() => {
    process.env.PATH = oldPath
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal
    rmSync(root, { recursive: true, force: true })
  })

  let ticked = false
  const heartbeat = new Promise<void>(resolve => setTimeout(() => { ticked = true; resolve() }, 20))
  const started = performance.now()
  const pending = getCompletions('中文', repo, 8)
  assert.ok(performance.now() - started < 300, 'starting completion must not block input for the old 500ms timeout')
  await heartbeat
  assert.equal(ticked, true)
  assert.deepEqual(await pending, ['src/中文.ts'], 'git slower than 500ms must still supply valid candidates')
  assert.deepEqual(await getCompletions('src\\中文', repo, 8), ['src/中文.ts'], 'Windows query separators match Git paths')
})

test('a hanging git command is bounded in the background', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-completion-hang-'))
  writeFileSync(join(root, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
  const oldPath = process.env.PATH
  process.env.PATH = `${root}:${oldPath ?? ''}`
  t.after(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }) })
  const started = performance.now()
  const pending = getCompletions('', root, 8)
  assert.ok(performance.now() - started < 300, 'a hung git must not stall the keyboard')
  assert.deepEqual(await pending, [])
  assert.ok(performance.now() - started < 4_000, 'background query must stop after its 3s deadline')
})
