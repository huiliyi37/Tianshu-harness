import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { RUNTIME_BUNDLED } from '../external-deps.js'
import { findInstallRoot, formatVersionLine } from '../../src/cli/version.js'

const scripts = fileURLToPath(new URL('../', import.meta.url))

function packageAt(dir: string, dependencies: Record<string, string> = {}, code = 'module.exports = {}', optionalDependencies: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'index.js', dependencies, optionalDependencies }))
  writeFileSync(join(dir, 'index.js'), code)
}

function fixture(roots = true) {
  const root = mkdtempSync(join(tmpdir(), 'tianshu-stage-closure-'))
  mkdirSync(join(root, 'scripts'))
  for (const file of ['stage-runtime-deps.js', 'runtime-platform-filter.js', 'tree-sitter-wasm-keep.js', 'typescript-stage-trim.js', 'staged-runtime-verify.js', 'external-deps.js']) {
    cpSync(join(scripts, file), join(root, 'scripts', file))
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tianshu-harness', version: '9.9.9', type: 'module' }))
  if (roots) for (const name of RUNTIME_BUNDLED) packageAt(join(root, 'node_modules', name))
  const sqlite = join(root, 'node_modules', 'better-sqlite3')
  packageAt(sqlite)
  mkdirSync(join(sqlite, 'lib'))
  writeFileSync(join(sqlite, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
  writeFileSync(join(sqlite, 'lib', 'index.js'), 'module.exports = class { exec() {} prepare() { return { run() {}, get() { return { c: 1 } } } } close() {} }')
  mkdirSync(join(root, 'dist', 'native'), { recursive: true })
  writeFileSync(join(root, 'dist', 'native', 'better_sqlite3.node'), '')
  return root
}

function stage(root: string) {
  const env = { ...process.env }
  delete env.NODE_PATH
  delete env.STAGE_SKIP_SQLITE_CHECK
  return spawnSync(process.execPath, [join(root, 'scripts', 'stage-runtime-deps.js')], { cwd: root, env, encoding: 'utf8' })
}

test('staging traverses nested versions and preserves their hoisted dependency resolution outside the source tree', () => {
  const root = fixture()
  const closed = mkdtempSync(join(tmpdir(), 'tianshu-closed-runtime-'))
  try {
    const modules = join(root, 'node_modules')
    packageAt(join(modules, 'esbuild'), { 'readable-stream': '3' })
    packageAt(join(modules, 'readable-stream'), {}, 'module.exports = "new"')
    packageAt(join(modules, 'exceljs'), { lazystream: '1' }, 'module.exports = require("lazystream")')
    packageAt(join(modules, 'lazystream'), { 'readable-stream': '2' }, 'module.exports = require("readable-stream")')
    packageAt(join(modules, 'lazystream', 'node_modules', 'readable-stream'), { 'process-nextick-args': '1', 'core-util-is': '1', 'concat-map': '1' }, 'module.exports = ["old", require("process-nextick-args"), require("core-util-is"), require("concat-map")]')
    for (const name of ['process-nextick-args', 'core-util-is', 'concat-map']) packageAt(join(modules, name), {}, `module.exports = ${JSON.stringify(name)}`)
    const result = stage(root)
    assert.equal(result.status, 0, result.stderr)
    renameSync(join(root, 'dist'), join(closed, 'dist'))
    const env = { ...process.env }
    delete env.NODE_PATH
    const probe = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./dist/node_modules/exceljs")))'], { cwd: closed, env, encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    assert.deepEqual(JSON.parse(probe.stdout), ['old', 'process-nextick-args', 'core-util-is', 'concat-map'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(closed, { recursive: true, force: true })
  }
})

test('missing required roots fail staging and retain the incomplete marker even when SQLite loads', () => {
  const root = fixture(false)
  try {
    const result = stage(root)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    for (const name of RUNTIME_BUNDLED) assert.ok(result.stderr.includes(name), name)
    assert.ok(existsSync(join(root, 'dist', 'node_modules', '.staging-incomplete')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('absent optional dependencies do not fail a complete required-root closure', () => {
  const root = fixture()
  try {
    packageAt(join(root, 'node_modules', 'exceljs'), {}, 'module.exports = {}', { 'absent-optional-package': '1' })
    const result = stage(root)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(root, 'dist', 'node_modules', '.staging-incomplete')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a staged standalone runtime reports its product version independently of ancestor projects', () => {
  const root = fixture()
  const closed = mkdtempSync(join(tmpdir(), 'tianshu-version-runtime-'))
  try {
    const result = stage(root)
    assert.equal(result.status, 0, result.stderr)
    writeFileSync(join(closed, 'package.json'), JSON.stringify({ name: 'another-project', version: '1.2.3' }))
    renameSync(join(root, 'dist'), join(closed, 'dist'))
    const entry = join(closed, 'dist', 'cli', 'entry.js')
    mkdirSync(dirname(entry))
    writeFileSync(entry, '')
    assert.equal(formatVersionLine(entry), 'tianshu-harness v9.9.9\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(closed, { recursive: true, force: true })
  }
})

test('staged product metadata does not replace the source or npm installation root', () => {
  const root = fixture()
  try {
    const result = stage(root)
    assert.equal(result.status, 0, result.stderr)
    const entry = join(root, 'dist', 'cli', 'entry.js')
    mkdirSync(dirname(entry))
    writeFileSync(entry, '')
    assert.equal(findInstallRoot(entry), realpathSync(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('staging excludes filesystem metadata while preserving real dependency files', () => {
  const root = fixture()
  try {
    const pkg = join(root, 'node_modules', 'esbuild')
    writeFileSync(join(pkg, '._metadata-only.js'), 'filesystem metadata')
    writeFileSync(join(pkg, '.DS_Store'), 'filesystem metadata')
    const sqlite = join(root, 'node_modules', 'better-sqlite3', 'lib')
    writeFileSync(join(sqlite, '._metadata-only.js'), 'filesystem metadata')
    const result = stage(root)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(existsSync(join(root, 'dist', 'node_modules', 'better-sqlite3', 'lib', '._metadata-only.js')), false)
    const staged = join(root, 'dist', 'node_modules', 'esbuild')
    assert.ok(existsSync(join(staged, 'index.js')), 'real dependency remains staged')
    assert.equal(existsSync(join(staged, '._metadata-only.js')), false, 'AppleDouble must not be copied')
    assert.equal(existsSync(join(staged, '.DS_Store')), false, 'Finder metadata must not be copied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
