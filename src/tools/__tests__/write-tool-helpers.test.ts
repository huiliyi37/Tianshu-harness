import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  WRITE_TOOL_NAMES,
  extractWriteContents,
  extractWriteFilePaths,
  extractPatchContents,
  extractPatchTargetPathsFromDiff,
} from '../write-tool-helpers.js'
import { extractPatchTargetPaths } from '../apply-patch.js'

describe('write-tool-helpers', () => {
  describe('WRITE_TOOL_NAMES', () => {
    it('covers all four edit tools + apply_patch', () => {
      assert.ok(WRITE_TOOL_NAMES.has('edit_file'))
      assert.ok(WRITE_TOOL_NAMES.has('write_file'))
      assert.ok(WRITE_TOOL_NAMES.has('hash_edit'))
      assert.ok(WRITE_TOOL_NAMES.has('ast_edit'))
      assert.ok(WRITE_TOOL_NAMES.has('apply_patch'))
    })
  })

  describe('extractWriteContents', () => {
    it('extracts from edit_file', () => {
      const r = extractWriteContents('edit_file', { file_path: 'src/a.ts', old_string: 'x', new_string: 'console.log("dbg")' })
      assert.equal(r.length, 1)
      assert.equal(r[0]!.filePath, 'src/a.ts')
      assert.equal(r[0]!.content, 'console.log("dbg")')
    })
    it('extracts from write_file', () => {
      const r = extractWriteContents('write_file', { file_path: 'src/a.ts', content: 'hello' })
      assert.equal(r[0]!.content, 'hello')
    })
    it('extracts from hash_edit', () => {
      const r = extractWriteContents('hash_edit', { file_path: 'src/a.ts', new_string: 'x' })
      assert.equal(r[0]!.content, 'x')
    })
    it('extracts from ast_edit with paths and ops (dryRun:false = real write)', () => {
      const r = extractWriteContents('ast_edit', {
        paths: ['src/a.ts', 'src/b.ts'],
        ops: [{ find: 'var $X', replace: 'console.log("p1")' }, { find: 'var $Y', replace: 'debugger' }],
        dryRun: false,
      })
      assert.equal(r.length, 4)
      assert.equal(r[0]!.filePath, 'src/a.ts')
      assert.equal(r[0]!.content, 'console.log("p1")')
      assert.equal(r[3]!.filePath, 'src/b.ts')
      assert.equal(r[3]!.content, 'debugger')
    })
    it('returns empty for ast_edit dryRun:true', () => {
      const r = extractWriteContents('ast_edit', { paths: ['src/a.ts'], ops: [{ find: 'x', replace: 'y' }], dryRun: true })
      assert.equal(r.length, 0)
    })
    it('returns empty for ast_edit with dryRun omitted — the default IS a preview (ast-edit.ts:105)', () => {
      // 工具真值 `const dryRun = input.dryRun !== false`：缺省即预览、不落盘。
      // 此前按 `=== true` 判定，缺省形态漏过——未落盘的内容被送进安全/探针扫描，
      // 且假命中会占掉 tracker 的跨轮去重位，把随后真写入的提醒吞掉。
      const r = extractWriteContents('ast_edit', {
        paths: ['src/a.ts'],
        ops: [{ find: 'x', replace: 'el.innerHTML = userInput' }],
      })
      assert.equal(r.length, 0, 'a preview writes nothing — there is nothing to scan')
    })
    it('returns empty for non-write tools', () => {
      assert.equal(extractWriteContents('read_file', { file_path: 'x' }).length, 0)
    })
  })

  describe('extractWriteFilePaths', () => {
    it('extracts from single-file tools', () => {
      assert.deepEqual(extractWriteFilePaths('edit_file', { file_path: 'src/a.ts' }), ['src/a.ts'])
      assert.deepEqual(extractWriteFilePaths('write_file', { file_path: 'src/b.ts' }), ['src/b.ts'])
      assert.deepEqual(extractWriteFilePaths('hash_edit', { file_path: 'src/c.ts' }), ['src/c.ts'])
    })
    it('extracts from ast_edit paths', () => {
      const r = extractWriteFilePaths('ast_edit', { paths: ['src/a.ts', 'src/b.ts'] })
      assert.deepEqual(r, ['src/a.ts', 'src/b.ts'])
    })
    it('returns empty for ast_edit dryRun', () => {
      const r = extractWriteFilePaths('ast_edit', { paths: ['src/a.ts'], dryRun: true })
      assert.equal(r.length, 0)
    })
    it('extracts apply_patch targets from the diff headers', () => {
      // apply_patch 的 input schema 是 { diff, check_only }——没有 path/file 字段。
      // 曾按 input.path ?? input.file 取，对真实调用恒为空（文件级追踪静默失效）。
      const diff = [
        'diff --git a/src/foo.ts b/src/foo.ts',
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n')
      assert.deepEqual(extractWriteFilePaths('apply_patch', { diff }), ['src/foo.ts'])
    })
    it('returns empty for apply_patch without a diff string', () => {
      assert.deepEqual(extractWriteFilePaths('apply_patch', { path: 'src/foo.ts' }), [])
    })
  })

  describe('extractPatchContents', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const keep = 1',
      '-const gone = 2',
      '+eval(userInput)',
      '+const added = 3',
      'diff --git a/src/b.py b/src/b.py',
      '--- /dev/null',
      '+++ b/src/b.py',
      '@@ -0,0 +1 @@',
      '+yaml.load(f)',
    ].join('\n')

    it('collects added lines per target file', () => {
      const r = extractPatchContents(diff)
      assert.equal(r.length, 2)
      assert.equal(r[0]!.filePath, 'src/a.ts')
      assert.equal(r[0]!.content, 'eval(userInput)\nconst added = 3')
      assert.equal(r[1]!.filePath, 'src/b.py')
      assert.equal(r[1]!.content, 'yaml.load(f)')
    })

    it('ignores context and removed lines', () => {
      const r = extractPatchContents(diff)
      assert.ok(!r[0]!.content.includes('const keep'), 'context 行不是本次写入的内容')
      assert.ok(!r[0]!.content.includes('const gone'), '删除行不该出现')
    })

    it('skips /dev/null targets (pure deletion)', () => {
      const deletion = ['--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n')
      assert.deepEqual(extractPatchContents(deletion), [])
    })

    it('returns empty for empty or non-string input', () => {
      assert.deepEqual(extractPatchContents(''), [])
      assert.deepEqual(extractPatchContents(undefined as unknown as string), [])
    })

    it('路径归一与 apply-patch.ts 的 extractPatchTargetPaths 一致（防分叉）', () => {
      // 两处各有一份 `+++ ` 解析：这里为了不把 apply-patch.ts 的重依赖链拖进
      // hook 层，实现是独立的。规则一旦分叉，安全扫描和交付校验就会看到不同的
      // 文件集，所以用同一份 diff 锁住两者输出相同。
      const quoted = [
        '+++ "b/src/with space.ts"\t2026-07-30 12:00:00',
        '@@ -0,0 +1 @@',
        '+x',
      ].join('\n')
      for (const sample of [diff, quoted]) {
        assert.deepEqual(
          extractPatchTargetPathsFromDiff(sample).sort(),
          extractPatchTargetPaths(sample).sort(),
        )
      }
    })
  })
})
