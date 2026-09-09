import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WRITE_FILE_TOOL } from '../write-file.js'
import type { ToolCallParams } from '../types.js'

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'write-abort-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function makeParams(dir: string, input: Record<string, unknown>, abortSignal?: AbortSignal): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: dir, abortSignal }
}

test('write_file: aborted signal → refused before any disk write (new file not created)', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'new.ts')
    const res = await WRITE_FILE_TOOL.execute(
      makeParams(dir, { file_path: target, content: 'const x = 1\n' }, AbortSignal.abort()),
    )
    assert.equal(res.isError, true, 'aborted call must report error')
    assert.ok((res.content as string).includes('中止'), `must explain the abort, got: ${res.content}`)
    assert.equal(existsSync(target), false, 'file must not be created after abort')
  })
})

test('write_file: aborted signal → existing file left untouched (no late overwrite)', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'keep.ts')
    writeFileSync(target, 'original content\n')
    const res = await WRITE_FILE_TOOL.execute(
      makeParams(dir, { file_path: target, content: 'replacement content\n' }, AbortSignal.abort()),
    )
    assert.equal(res.isError, true)
    assert.equal(readFileSync(target, 'utf-8'), 'original content\n', 'existing file must not be overwritten after abort')
  })
})

test('write_file: append mode with aborted signal → nothing appended', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'log.txt')
    writeFileSync(target, 'head\n')
    const res = await WRITE_FILE_TOOL.execute(
      makeParams(dir, { file_path: target, content: 'tail\n', mode: 'append' }, AbortSignal.abort()),
    )
    assert.equal(res.isError, true)
    assert.equal(readFileSync(target, 'utf-8'), 'head\n', 'append must not land after abort')
  })
})

test('write_file: no abort → write succeeds (control, abort guard must not affect the happy path)', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'ok.ts')
    const res = await WRITE_FILE_TOOL.execute(
      makeParams(dir, { file_path: target, content: 'const ok = 1\n' }),
    )
    assert.ok(!res.isError, 'normal write must succeed')
    assert.ok(existsSync(target), 'file must be created')
    assert.equal(readFileSync(target, 'utf-8'), 'const ok = 1\n')
  })
})
