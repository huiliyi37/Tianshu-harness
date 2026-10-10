import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { getCompletions } from '../file-completer.js'

test('filesystem metadata cannot appear in file mentions or consume completion slots', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-completion-metadata-'))
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL
  const previousSystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = join(root, 'nonexistent-global-config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  t.after(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previousSystem
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'nested'))
  mkdirSync(join(root, '._directory'))
  for (const path of ['src.ts', 'src-test.ts', 'note._src.ts', 'other.ts']) {
    writeFileSync(join(root, path), `// ${path}\n`)
  }
  // Ordinary explicit fixtures exercise metadata paths on Windows too.
  for (const path of ['._src.ts', 'nested/._src.ts', '._directory/src.ts', '.DS_Store']) {
    writeFileSync(join(root, path), 'filesystem metadata\n')
  }
  for (const args of [['init', '-q'], ['add', '.']]) {
    execFileSync('git', args, { cwd: root, timeout: 30_000, windowsHide: true, stdio: 'pipe' })
  }

  assert.deepEqual(await getCompletions('src', root, 3), ['src.ts', 'src-test.ts', 'note._src.ts'])
  assert.deepEqual(await getCompletions('', root, 50), ['src.ts', 'other.ts', 'src-test.ts', 'note._src.ts'])
})
