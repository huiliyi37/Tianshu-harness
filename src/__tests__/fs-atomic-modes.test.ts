import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileAtomicAsync, writeFileAtomicDurableAsync, writeFileAtomicSync } from '../fs-atomic.js'
import { READ_FILE_TOOL } from '../tools/read-file.js'
import { WRITE_FILE_TOOL } from '../tools/write-file.js'
import { EDIT_FILE_TOOL } from '../tools/edit.js'
import { AST_EDIT_TOOL } from '../tools/ast-edit.js'

for (const [name, write] of [['sync', writeFileAtomicSync], ['async', writeFileAtomicAsync], ['durable', writeFileAtomicDurableAsync]] as const) {
  test(`${name}: explicitly preserves existing project permissions while private writes remain 0600`, { skip: process.platform === 'win32' }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-atomic-modes-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'script.sh')
    for (const mode of [0o755, 0o644, 0o740]) {
      writeFileSync(file, 'old')
      chmodSync(file, mode)
      await write(file, 'new', { preserveMode: true })
      assert.equal(readFileSync(file, 'utf8'), 'new')
      assert.equal(statSync(file).mode & 0o777, mode)
    }
    await write(file, 'private runtime state')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const fresh = join(dir, 'new.txt')
    await write(fresh, 'new', { preserveMode: true })
    assert.equal(statSync(fresh).mode & 0o777, 0o600)
  })
}

for (const tool of [WRITE_FILE_TOOL, EDIT_FILE_TOOL]) {
  test(`${tool.definition.name}: reading then editing a script preserves its executable bit`, { skip: process.platform === 'win32' }, async t => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-tool-modes-'))
    t.after(() => rmSync(cwd, { recursive: true, force: true }))
    const file = join(cwd, 'script.sh')
    writeFileSync(file, '#!/bin/sh\nprintf old\n')
    chmodSync(file, 0o755)
    const observed = await READ_FILE_TOOL.execute({ cwd, input: { file_path: 'script.sh' }, toolUseId: 'mode-read' })
    assert.ok(!observed.isError, observed.content)
    const input = tool === WRITE_FILE_TOOL
      ? { file_path: 'script.sh', content: '#!/bin/sh\nprintf new\n' }
      : { file_path: 'script.sh', old_string: 'old', new_string: 'new' }
    const result = await tool.execute({ cwd, input, toolUseId: 'mode-edit' })
    assert.ok(!result.isError, result.content)
    assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\nprintf new\n')
    assert.equal(statSync(file).mode & 0o777, 0o755)
  })
}

test('ast_edit preserves permissions while applying a real structural edit', { skip: process.platform === 'win32' }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-ast-modes-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const file = join(cwd, 'cli.ts')
  writeFileSync(file, 'var count = 1\n')
  chmodSync(file, 0o755)
  const result = await AST_EDIT_TOOL.execute({ cwd, toolUseId: 'ast-mode-edit', input: {
    ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
    paths: ['cli.ts'], lang: 'TypeScript', dryRun: false,
  } })
  assert.ok(!result.isError, result.content)
  assert.match(readFileSync(file, 'utf8'), /const count = 1/)
  assert.equal(statSync(file).mode & 0o777, 0o755)
})
