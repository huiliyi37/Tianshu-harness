import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rankFiles, listProjectFiles, listDirEntries } from '../file-list.js'

test('rankFiles: empty query returns shallowest paths first', () => {
  const out = rankFiles(['z/deep/x.ts', 'a.ts', 'm/n.ts'], '')
  assert.equal(out[0], 'a.ts')
})

test('rankFiles: basename startsWith ranks above mid-substring, shorter first', () => {
  const out = rankFiles(['x/afoo.ts', 'src/foobar.ts', 'src/foo.ts'], 'foo')
  assert.deepEqual(out, ['src/foo.ts', 'src/foobar.ts', 'x/afoo.ts'])
})

test('rankFiles: non-matching paths are excluded', () => {
  const out = rankFiles(['src/foo.ts', 'lib/bar.ts'], 'zzzqqq')
  assert.deepEqual(out, [])
})

test('rankFiles: fuzzy subsequence matches when no substring hit', () => {
  const out = rankFiles(['alpha/beta.ts', 'gamma.ts'], 'apbt')
  assert.deepEqual(out, ['alpha/beta.ts'])
})

test('rankFiles: respects limit', () => {
  const paths = Array.from({ length: 100 }, (_, i) => `f${i}.ts`)
  assert.equal(rankFiles(paths, '', 10).length, 10)
})

test('listProjectFiles: enumerates files, excludes node_modules and .git', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'filelist-'))
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'sub', 'b.ts'), 'export const b = 2\n')
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'pkg', 'x.js'), 'module.exports = {}\n')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), '[core]\n')

  const files = await listProjectFiles(dir)
  assert.ok(files.includes('a.ts'), 'includes top-level file')
  assert.ok(files.includes('sub/b.ts'), 'includes nested file (posix-relative)')
  assert.ok(!files.some((f) => f.includes('node_modules')), 'excludes node_modules')
  assert.ok(!files.some((f) => f.includes('.git/')), 'excludes .git')
})

test('file enumeration omits filesystem metadata while preserving normal dotfiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'filelist-metadata-'))
  try {
    await writeFile(join(dir, 'doc.txt'), 'document')
    await writeFile(join(dir, '.notes.md'), 'normal dotfile')
    await writeFile(join(dir, '._doc.txt'), 'synthetic sidecar')
    await writeFile(join(dir, '.DS_Store'), 'synthetic Finder metadata')
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'nested', 'child.ts'), 'nested source')
    await writeFile(join(dir, 'nested', '._child.ts'), 'synthetic nested sidecar')
    await mkdir(join(dir, '._metadata'))
    await writeFile(join(dir, '._metadata', 'hidden.ts'), 'metadata directory content')

    assert.deepEqual((await listProjectFiles(dir)).sort(), ['.notes.md', 'doc.txt', 'nested/child.ts'])
    assert.deepEqual((await listDirEntries(dir)).map(entry => entry.name).sort(), ['.notes.md', 'doc.txt', 'nested'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
