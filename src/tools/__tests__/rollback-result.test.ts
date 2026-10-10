import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { APPLY_PATCH_TOOL } from '../apply-patch.js'
import { AST_EDIT_TOOL } from '../ast-edit.js'
import { cpuPool } from '../../workers/cpu-pool.js'
import type { AstEditComputeResult } from '../../workers/cpu-tasks.js'

for (const kind of ['apply_patch', 'ast_edit'] as const) {
  test(`${kind} reports failed rollback when target restoration is denied`, async (t) => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'rollback-result-'))
    const target = join(cwd, 'fixture.json')
    const originalWrite = fs.writeFile.bind(fs)
    try {
      await originalWrite(target, '{"value":1}\n')
      if (kind === 'apply_patch') {
        for (const args of [['init'], ['config', 'user.name', 'QA'], ['config', 'user.email', 'qa@example.invalid'], ['add', 'fixture.json'], ['commit', '-m', 'fixture']]) {
          const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
          assert.equal(result.status, 0, result.stderr)
        }
      } else {
        const compute: AstEditComputeResult = {
          files: [{ file: target, newSource: '{"value":]}\n', changes: [{ before: '1', after: ']', line: 1 }], syntaxOk: true, existingEol: 'lf' }],
          errors: [],
        }
        t.mock.method(cpuPool, 'run', async (task: string) => {
          assert.equal(task, 'astEditComputeRaw')
          return compute
        })
      }
      t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]) === target) throw Object.assign(new Error('target is locked'), { code: 'EACCES' })
        return originalWrite(...args)
      })
      syncBuiltinESMExports()
      const result = kind === 'apply_patch'
        ? await APPLY_PATCH_TOOL.execute({ cwd, toolUseId: 'patch-locked', input: { diff: '--- a/fixture.json\n+++ b/fixture.json\n@@ -1 +1 @@\n-{"value":1}\n+{"value":]}\n' } })
        : await AST_EDIT_TOOL.execute({ cwd, toolUseId: 'ast-locked', input: { paths: ['fixture.json'], ops: [{ find: '1', replace: ']' }], dryRun: false } })
      assert.match(result.content, /回滚失败/, 'a failed restore must not be reported as a successful rollback')
      assert.equal(result.isError, true)
      assert.equal(await fs.readFile(target, 'utf8'), '{"value":]}\n', 'the denied restore leaves the corrupt target and must be reported honestly')
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 })
    }
  })
}
