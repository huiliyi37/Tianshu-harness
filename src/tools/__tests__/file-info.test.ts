import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FILE_INFO_TOOL, formatPermissions } from '../file-info.js'

function makeParams(input: Record<string, unknown>, cwd: string) {
  return { input, toolUseId: 'test', cwd }
}

describe('FILE_INFO_TOOL', () => {
  let tmpCwd: string

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'fileinfo-test-'))
    mkdirSync(join(tmpCwd, 'src'), { recursive: true })
    writeFileSync(join(tmpCwd, 'src', 'app.ts'), 'const x = 1\nconst y = 2\n')
    writeFileSync(join(tmpCwd, 'src', 'data.json'), '{"key": "value"}')
    writeFileSync(join(tmpCwd, 'src', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    mkdirSync(join(tmpCwd, 'src', 'sub'))
    writeFileSync(join(tmpCwd, 'src', 'sub', 'deep.ts'), 'export const z = 3')
  })

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true })
  })

  it('reports file metadata for a text file', async () => {
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'src/app.ts' }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Exists: true/)
    assert.match(result.content, /Type: file/)
    assert.match(result.content, /Extension: \.ts/)
    assert.match(result.content, /Encoding: text/)
    assert.match(result.content, /Size:/)
    assert.match(result.content, /Modified:/)
    assert.match(result.content, /Permissions:/)
  })

  it('reports binary encoding for non-text files', async () => {
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'src/image.png' }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Encoding: binary/)
    assert.match(result.content, /Extension: \.png/)
  })

  it('reports directory metadata with file count and total size', async () => {
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'src' }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Type: directory/)
    assert.match(result.content, /Files: \d+/)
    assert.match(result.content, /Total size:/)
  })

  it('reports non-existent path', async () => {
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'nonexistent.ts' }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Exists: false/)
  })

  it('reports symlink target info', async (t) => {
    try {
      symlinkSync(join(tmpCwd, 'src', 'app.ts'), join(tmpCwd, 'link.ts'), 'file')
    } catch {
      t.skip('symlink unavailable on this platform (Windows requires developer mode/admin)')
      return
    }
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'link.ts' }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Type: symlink/)
    assert.match(result.content, /Target type: file/)
  })

  it('rejects paths outside project directory', async () => {
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: '/tmp' }, tmpCwd))
    assert.match(result.content, /项目目录外|outside project/)
  })

  it('returns error for empty path', async () => {
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: '' }, tmpCwd))
    assert.equal(result.isError, true)
    assert.match(result.content, /path 参数必填/)
  })

  it('requiresApproval is false', () => {
    assert.equal(FILE_INFO_TOOL.requiresApproval(makeParams({ path: 'x' }, tmpCwd)), false)
  })

  it('isConcurrencySafe is true', () => {
    assert.equal(FILE_INFO_TOOL.isConcurrencySafe(), true)
  })

  it('has correct definition name', () => {
    assert.equal(FILE_INFO_TOOL.definition.name, 'file_info')
  })

  it('handles absolute paths within project', async () => {
    const absPath = join(tmpCwd, 'src', 'app.ts')
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: absPath }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Exists: true/)
  })

  it('skips nested build trees and says the tally is partial', async () => {
    // Each file costs a stat, so the tally has to prune what it cannot afford
    // to count: the tree this stands in for held 19433 files.
    mkdirSync(join(tmpCwd, 'src', 'target', 'debug', 'deps'), { recursive: true })
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(tmpCwd, 'src', 'target', 'debug', 'deps', `dep${i}.rlib`), 'x'.repeat(1024))
    }
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'src' }, tmpCwd))
    assert.equal(result.isError, undefined)
    // 4 real sources; the 30 artefacts must not be in the count.
    assert.match(result.content, /Files: ≥4\b/, `counted the build tree: ${result.content}`)
    assert.match(result.content, /partial tally/)
  })

  it('reports an exact count when nothing was skipped', async () => {
    // The "≥" has to mean something — an ordinary tree must not carry it.
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'src' }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Files: 4\b/)
    assert.doesNotMatch(result.content, /partial tally/)
  })

  it('counts a build tree the caller asked for by name', async () => {
    // Pruning applies to trees found inside another walk, not to an explicit
    // request — "how big is target/" is a fair question.
    mkdirSync(join(tmpCwd, 'target'), { recursive: true })
    writeFileSync(join(tmpCwd, 'target', 'artifact.bin'), 'x'.repeat(512))
    const result = await FILE_INFO_TOOL.execute(makeParams({ path: 'target' }, tmpCwd))
    assert.equal(result.isError, undefined)
    assert.match(result.content, /Files: 1\b/)
  })
})

describe('formatPermissions', () => {
  it('returns POSIX octal on non-Windows platforms', () => {
    assert.equal(formatPermissions(0o755, 'linux'), '0755')
    assert.equal(formatPermissions(0o644, 'darwin'), '0644')
  })

  it('reports read-write / read-only on Windows (octal is meaningless there)', () => {
    assert.equal(formatPermissions(0o666, 'win32'), 'read-write')
    assert.equal(formatPermissions(0o444, 'win32'), 'read-only')
  })
})
