import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, basename, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')
function probe(base: string, populate: (dir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'runner-probe-')), name = basename(root), dir = join(root, base, name)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    populate(dir)
    return spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'scripts', 'run-node-tests.ts'), name], {
      cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, RIVET_TEST_CONCURRENCY: '1', RIVET_TEST_TIMEOUT: '20000' },
    })
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
test('runner executes real tests while ignoring AppleDouble source companions', () => {
  const run = probe('src', dir => {
    const withinRepo = relative(repo, dir)
    assert.ok(withinRepo.startsWith('..') || isAbsolute(withinRepo), 'runner fixtures must stay outside the real source tree')
    writeFileSync(join(dir, 'fixture.test.ts'), "import { test } from 'node:test'; test('real fixture executes', () => {})\n")
    writeFileSync(join(dir, '._fixture.test.ts'), "throw new Error('metadata must not execute')\n")
  })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /real fixture executes/)
  assert.doesNotMatch(run.stdout + run.stderr, /metadata must not execute/)
})
test('runner discovers release-style mjs tests under scripts', () => {
  const run = probe('scripts', dir => {
    const withinRepo = relative(repo, dir)
    assert.ok(withinRepo.startsWith('..') || isAbsolute(withinRepo), 'runner fixtures must stay outside the real script tree')
    writeFileSync(join(dir, 'fixture.test.mjs'), "import { test } from 'node:test'; test('release fixture executes', () => {})\n")
  })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /release fixture executes/)
})
