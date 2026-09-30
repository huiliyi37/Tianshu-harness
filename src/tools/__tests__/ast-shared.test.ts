import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  LANG_BY_EXT,
  inferLang,
  resolveLang,
  collectFiles,
  collectMetaVarNames,
  DYNAMIC_LANGS,
  isDynamicLang,
} from '../ast-shared.js'

const testDir = join(process.cwd(), '.test-tmp', `ast-shared-${randomBytes(4).toString('hex')}`)

before(async () => {
  await rm(testDir, { recursive: true, force: true })
  await mkdir(testDir, { recursive: true })
  await mkdir(join(testDir, 'sub'), { recursive: true })
  await mkdir(join(testDir, '.hidden-dir'), { recursive: true })
  await mkdir(join(testDir, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(testDir, '.git', 'objects'), { recursive: true })
  await mkdir(join(testDir, '.rivet', 'knowledge'), { recursive: true })

  await writeFile(join(testDir, 'sample.ts'), 'var x = 1')
  await writeFile(join(testDir, 'sample.js'), 'var y = 2')
  await writeFile(join(testDir, 'sub', 'nested.tsx'), 'var z = 3')
  await writeFile(join(testDir, '.hidden-dir', 'hidden.ts'), 'var w = 4')
  await writeFile(join(testDir, 'node_modules', 'pkg', 'index.js'), '')
  await writeFile(join(testDir, '.git', 'objects', 'hash'), '')
  await writeFile(join(testDir, '.rivet', 'knowledge', 'memory.json'), '')
})

after(async () => {
  await rm(testDir, { recursive: true, force: true })
})

/** 归一为 POSIX 形态做子串判据——collectFiles 在 Windows 上返回反斜杠路径，
 *  带 '/' 的 includes 会静默失配（漏收/假绿两类都发生过）。 */
const norm = (p: string): string => p.replaceAll('\\', '/')

// ── LANG_BY_EXT / inferLang / resolveLang ─────────────────────────

describe('language inference', () => {
  it('maps .ts to TypeScript', () => {
    assert.equal(inferLang('/foo/bar.ts'), 'TypeScript')
  })
  it('maps .tsx to Tsx', () => {
    assert.equal(inferLang('/foo/bar.tsx'), 'Tsx')
  })
  it('maps .js to JavaScript', () => {
    assert.equal(inferLang('/foo/bar.js'), 'JavaScript')
  })
  it('maps .jsx to Tsx', () => {
    assert.equal(inferLang('/foo/bar.jsx'), 'Tsx')
  })
  it('maps .html to Html', () => {
    assert.equal(inferLang('/foo/bar.html'), 'Html')
  })
  it('maps .css to Css', () => {
    assert.equal(inferLang('/foo/bar.css'), 'Css')
  })
  it('returns null for unsupported extension', () => {
    assert.equal(inferLang('/foo/bar.rs'), null)
  })
  it('resolveLang prefers explicit over inferred', () => {
    assert.equal(resolveLang('TypeScript', '/foo/bar.js'), 'TypeScript')
  })
  it('resolveLang falls back to inference when explicit is undefined', () => {
    assert.equal(resolveLang(undefined, '/foo/bar.ts'), 'TypeScript')
  })
})

// ── collectFiles ──────────────────────────────────────────────────

describe('collectFiles', () => {
  it('returns files matching directory walk', async () => {
    const files = await collectFiles(testDir)
    const names = files.map(f => norm(f).replace(norm(testDir) + '/', ''))
    assert.ok(names.includes('sample.ts'), `expected sample.ts, got ${names.join(', ')}`)
    assert.ok(names.includes('sample.js'), `expected sample.js`)
  })

  it('skips node_modules', async () => {
    const files = await collectFiles(testDir)
    assert.ok(!files.some(f => f.includes('node_modules')), 'should not include node_modules files')
  })

  it('skips .git', async () => {
    const files = await collectFiles(testDir)
    assert.ok(!files.some(f => norm(f).includes('.git/')), 'should not include .git files')
  })

  it('skips .rivet', async () => {
    const files = await collectFiles(testDir)
    assert.ok(!files.some(f => norm(f).includes('.rivet/')), 'should not include .rivet files')
  })

  it('does NOT skip .hidden-dir (only well-known tool dirs)', async () => {
    const files = await collectFiles(testDir)
    assert.ok(files.some(f => f.includes('.hidden-dir')), 'should include .hidden-dir files')
  })

  it('returns nested files', async () => {
    const files = await collectFiles(testDir)
    assert.ok(files.some(f => norm(f).includes('sub/nested.tsx')), 'should include nested files')
  })

  it('returns single file when path is a file', async () => {
    const files = await collectFiles(join(testDir, 'sample.ts'))
    assert.equal(files.length, 1)
  })
})

// ── collectMetaVarNames ───────────────────────────────────────────

describe('collectMetaVarNames', () => {
  it('extracts single-node meta-variables ($NAME)', () => {
    const vars = collectMetaVarNames('function $NAME($$$ARGS) { $$$BODY }')
    const names = vars.map(v => v.name)
    assert.deepStrictEqual(names.sort(), ['ARGS', 'BODY', 'NAME'].sort())
  })

  it('marks multi-node vars correctly', () => {
    const vars = collectMetaVarNames('function $NAME($$$ARGS) { $$$BODY }')
    const byName: Record<string, boolean> = {}
    for (const v of vars) byName[v.name] = v.multi
    assert.equal(byName['NAME'], false, 'NAME should be single-node')
    assert.equal(byName['ARGS'], true, 'ARGS should be multi-node')
    assert.equal(byName['BODY'], true, 'BODY should be multi-node')
  })

  it('returns empty for pattern with no meta-vars', () => {
    const vars = collectMetaVarNames('function foo() { return 1 }')
    assert.equal(vars.length, 0)
  })

  it('deduplicates repeated meta-var names', () => {
    const vars = collectMetaVarNames('$X = $X')
    assert.equal(vars.length, 1)
    assert.equal(vars[0]!.name, 'X')
  })
})

// ── dynamic languages (python/json) ──────────────────────────────

describe('dynamic language support', () => {
  it('maps .py to python', () => {
    assert.equal(inferLang('foo.py'), 'python')
    assert.equal(inferLang('foo.pyi'), 'python')
  })

  it('maps .json to json', () => {
    assert.equal(inferLang('data.json'), 'json')
    assert.equal(inferLang('data.jsonc'), 'json')
  })

  it('isDynamicLang identifies python and json', () => {
    assert.equal(isDynamicLang('python'), true)
    assert.equal(isDynamicLang('json'), true)
    assert.equal(isDynamicLang('TypeScript'), false)
    assert.equal(isDynamicLang('Tsx'), false)
  })

  it('DYNAMIC_LANGS set contains exactly python and json', () => {
    assert.equal(DYNAMIC_LANGS.size, 2)
    assert.ok(DYNAMIC_LANGS.has('python'))
    assert.ok(DYNAMIC_LANGS.has('json'))
  })

  it('resolveLang returns dynamic lang name for .py files', () => {
    assert.equal(resolveLang(undefined, 'script.py'), 'python')
    // explicit still wins
    assert.equal(resolveLang('TypeScript', 'script.py'), 'TypeScript')
  })
})

// ── configurable exclude dirs (RIVET_AST_EXCLUDE) ────────────────

describe('collectFiles configurable exclusion', () => {
  it('excludes dist/build/out by default (build artifacts)', () => {
    const dir = join(process.cwd(), '.test-tmp', `ast-exclude-${randomBytes(4).toString('hex')}`)
    return (async () => {
      await mkdir(join(dir, 'dist'), { recursive: true })
      await mkdir(join(dir, 'src'), { recursive: true })
      await writeFile(join(dir, 'dist', 'bundle.js'), 'compiled')
      await writeFile(join(dir, 'src', 'real.ts'), 'source')
      const files = await collectFiles(dir)
      assert.ok(files.some(f => f.includes('real.ts')), 'src file should be collected')
      assert.ok(!files.some(f => f.includes('dist')), 'dist should be excluded')
      await rm(dir, { recursive: true, force: true })
    })()
  })

  it('honors RIVET_AST_EXCLUDE for project-specific dirs', () => {
    const dir = join(process.cwd(), '.test-tmp', `ast-env-exclude-${randomBytes(4).toString('hex')}`)
    const prev = process.env.RIVET_AST_EXCLUDE
    return (async () => {
      await mkdir(join(dir, 'vendor'), { recursive: true })  // Go-style vendored deps
      await mkdir(join(dir, 'src'), { recursive: true })
      await writeFile(join(dir, 'vendor', 'dep.go'), 'package dep')
      await writeFile(join(dir, 'src', 'main.rs'), 'source')
      // This example used to be `target`, which now sits in the shared baseline
      // — the override is for dirs the baseline does NOT know about, so the
      // example has to be one of those or it proves nothing.
      let files = await collectFiles(dir)
      assert.ok(files.some(f => f.includes('vendor')), 'vendor collected without env override')

      process.env.RIVET_AST_EXCLUDE = 'vendor, generated'
      files = await collectFiles(dir)
      assert.ok(!files.some(f => f.includes('vendor')), 'vendor excluded via RIVET_AST_EXCLUDE')
      assert.ok(files.some(f => f.includes('main.rs')), 'src still collected')

      await rm(dir, { recursive: true, force: true })
      if (prev === undefined) delete process.env.RIVET_AST_EXCLUDE
      else process.env.RIVET_AST_EXCLUDE = prev
    })()
  })
})
