import { describe, it, beforeEach } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validatePathSafe } from '../path-validate.js'
import { grantPath, _resetGrantsForTest } from '../path-grants.js'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { GREP_TOOL, resetRgResolvedPath } from '../grep.js'
import { resetResolvedEnvCache } from '../resolved-env.js'

function link(t: TestContext, target: string, path: string, type: 'file' | 'dir' = 'file'): boolean {
  try { symlinkSync(target, path, type); return true }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Symbolic links unavailable on this host'); return false
    }
    throw error
  }
}

describe('dangling-link write boundaries', () => {
  beforeEach(() => _resetGrantsForTest())

  it('refuses append through an ungranted link to a missing outside file', async t => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-link-boundary-'))
    try {
      const cwd = join(root, 'project'); mkdirSync(cwd)
      const outside = join(root, 'outside.txt')
      if (!link(t, outside, join(cwd, 'alias.txt'))) return
      assert.equal(validatePathSafe(cwd, 'alias.txt', 'write').ok, false)
      const result = await WRITE_FILE_TOOL.execute({ cwd, input: { file_path: 'alias.txt', content: 'DUMMY_APPEND', mode: 'append' }, toolUseId: 'deny-dangling' })
      assert.equal(result.isError, true)
      assert.equal(existsSync(outside), false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('resolves missing directory tails and chained links before checking containment', t => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-link-tail-'))
    try {
      const cwd = join(root, 'project'); mkdirSync(cwd)
      if (!link(t, join(root, 'missing-dir'), join(cwd, 'dir-alias'), 'dir')) return
      assert.equal(validatePathSafe(cwd, 'dir-alias/new.txt', 'write').ok, false)
      if (!link(t, join(root, 'missing.txt'), join(cwd, 'second.txt'))) return
      if (!link(t, 'second.txt', join(cwd, 'first.txt'))) return
      assert.equal(validatePathSafe(cwd, 'first.txt', 'write').ok, false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('allows a missing in-workspace link target and an explicitly granted outside target', async t => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-link-granted-'))
    try {
      const cwd = join(root, 'project'); mkdirSync(cwd)
      const inside = join(cwd, 'new.txt')
      if (!link(t, inside, join(cwd, 'inside-alias.txt'))) return
      assert.equal(validatePathSafe(cwd, 'inside-alias.txt', 'write').ok, true)
      const insideResult = await WRITE_FILE_TOOL.execute({ cwd, input: { file_path: 'inside-alias.txt', content: 'DUMMY_INSIDE', mode: 'append' }, toolUseId: 'allow-inside' })
      assert.ok(!insideResult.isError, insideResult.content)
      assert.equal(readFileSync(inside, 'utf8'), 'DUMMY_INSIDE')
      const outside = join(root, 'outside'); mkdirSync(outside)
      const target = join(outside, 'new.txt')
      if (!link(t, target, join(cwd, 'granted-alias.txt'))) return
      grantPath(outside, 'write', { cwd })
      assert.equal(validatePathSafe(cwd, 'granted-alias.txt', 'write').ok, true)
      const grantedResult = await WRITE_FILE_TOOL.execute({ cwd, input: { file_path: 'granted-alias.txt', content: 'DUMMY_GRANTED', mode: 'append' }, toolUseId: 'allow-granted' })
      assert.ok(!grantedResult.isError, grantedResult.content)
      assert.equal(readFileSync(target, 'utf8'), 'DUMMY_GRANTED')
    } finally { rmSync(root, { recursive: true, force: true }); _resetGrantsForTest() }
  })

  it('fails closed on link cycles', t => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-link-cycle-'))
    try {
      if (!link(t, 'b.txt', join(root, 'a.txt'))) return
      if (!link(t, 'a.txt', join(root, 'b.txt'))) return
      assert.equal(validatePathSafe(root, 'a.txt', 'write').ok, false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('directory grep shares file-level read policy', () => {
  it('preserves matching files across bounded ripgrep argument chunks', async t => {
    if (spawnSync('rg', ['--version']).status !== 0) { t.skip('ripgrep unavailable'); return }
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-grep-chunks-'))
    try {
      for (let i = 0; i < 150; i++) {
        const file = `${String(i).padStart(3, '0')}-${'long-name-'.repeat(12)}.ts`
        writeFileSync(join(cwd, file), i === 0 || i === 149 ? `export const value = "DUMMY_CHUNK_${i}"\n` : 'export const value = 0\n')
      }
      resetResolvedEnvCache(); resetRgResolvedPath()
      const result = await GREP_TOOL.execute({ cwd, input: { path: '.', pattern: 'DUMMY_CHUNK_', literal: true }, toolUseId: 'grep-chunks' })
      assert.ok(!result.isError, result.content)
      assert.ok(!result.content.includes('已使用慢速回退'), 'must exercise chunked ripgrep')
      assert.ok(result.content.includes('DUMMY_CHUNK_0'), result.content)
      assert.ok(result.content.includes('DUMMY_CHUNK_149'), result.content)
    } finally { rmSync(cwd, { recursive: true, force: true }); resetRgResolvedPath() }
  })

  for (const backend of ['ripgrep', 'native']) {
    it(`excludes sensitive files with ${backend} while retaining ordinary matches`, async t => {
      if (backend === 'ripgrep' && spawnSync('rg', ['--version']).status !== 0) {
        t.skip('ripgrep unavailable'); return
      }
      const cwd = mkdtempSync(join(tmpdir(), 'rivet-grep-policy-'))
      const previousPath = process.env.PATH
      try {
        writeFileSync(join(cwd, 'credentials.json'), '{"marker":"DUMMY_DENIED_NEEDLE"}\n')
        writeFileSync(join(cwd, 'Credentials.YAML'), 'marker: DUMMY_DENIED_NEEDLE\n')
        writeFileSync(join(cwd, 'public.ts'), 'export const marker = "DUMMY_ALLOWED_NEEDLE"\n')
        assert.equal(validatePathSafe(cwd, 'credentials.json').ok, false)
        if (backend === 'native') {
          writeFileSync(join(cwd, '.rivet-config.json'), JSON.stringify({ env: { resolve: false } }))
          process.env.PATH = join(cwd, 'no-binaries')
        }
        resetResolvedEnvCache(); resetRgResolvedPath()
        const result = await GREP_TOOL.execute({ cwd, input: { path: '.', pattern: 'DUMMY_', literal: true }, toolUseId: `grep-policy-${backend}` })
        assert.ok(!result.isError, result.content)
        assert.ok(result.content.includes('DUMMY_ALLOWED_NEEDLE'), result.content)
        assert.ok(!result.content.includes('DUMMY_DENIED_NEEDLE'), result.content)
        if (backend === 'ripgrep') assert.ok(!result.content.includes('已使用慢速回退'), 'must test the actual ripgrep path')
        else assert.ok(result.content.includes('已使用慢速回退'))
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        resetResolvedEnvCache(); resetRgResolvedPath()
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }
})
