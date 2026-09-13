import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EXPORT_FILE_TOOL, exportFile } from '../export-file.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-export-file-'))
}

describe('export_file', () => {
  it('writes text content to an external path with spaces and unicode', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'Honglin   zhang', '白嫖gpt', '天枢-logo.svg')
      const result = await exportFile({ destination_path: destination, content: '<svg>天枢</svg>' })

      assert.equal(result.path, destination)
      assert.equal(result.mode, 'content')
      assert.equal(readFileSync(destination, 'utf-8'), '<svg>天枢</svg>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('decodes base64 content for image/binary exports', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'logo.png')
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      await exportFile({ destination_path: destination, content: pngHeader.toString('base64'), encoding: 'base64' })

      assert.deepEqual(readFileSync(destination), pngHeader)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies an existing file to an external destination', async () => {
    const dir = tempDir()
    try {
      const source = join(dir, 'source.svg')
      const destination = join(dir, 'mounted drive', '白嫖gpt', 'copy.svg')
      writeFileSync(source, '<svg id="source"/>')

      const result = await exportFile({ destination_path: destination, source_path: source })

      assert.equal(result.mode, 'copy')
      assert.equal(readFileSync(destination, 'utf-8'), '<svg id="source"/>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects ambiguous content plus source_path calls', async () => {
    await assert.rejects(
      () => exportFile({ destination_path: join(tempDir(), 'x.txt'), content: 'x', source_path: '/tmp/source' }),
      /必须且只能提供/,
    )
  })

  it('rejects copying sensitive source files (issue #135)', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'out.txt')
      await assert.rejects(
        () => exportFile({ destination_path: destination, source_path: '~/.ssh/id_rsa' }),
        /拒绝导出敏感文件/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tool execute reports a useful success message', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, '桌面', 'tianshu-logo.svg')
      const result = await EXPORT_FILE_TOOL.execute({
        cwd: process.cwd(),
        toolUseId: 'tu-export',
        input: { destination_path: destination, content: '<svg/>' },
      })

      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('已导出'))
      assert.ok(result.content.includes(destination))
      assert.ok(existsSync(destination))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
