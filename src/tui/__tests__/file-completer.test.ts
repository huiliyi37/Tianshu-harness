/**
 * T9 file completer 测试。
 *
 * 领航星 2026-06-11 诉求：
 * - 误输入表情符号 / 任意非路径字符，不应让 @ 补全炸出错误（容错）
 * - 大仓库下 `git ls-files` 在后台查询，迟缓及挂起回归见 file-completer-async.test.ts
 * - 非 git 目录静默返回空候选，不抛错（@ 补全是「建议」而非「必须」）
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractAtToken, getCompletions, applyCompletion } from '../file-completer.js'
import { makeTestDir, cleanupTestDir } from './_test-tmp.js'

describe('extractAtToken', () => {
  it('returns the partial token after the last @', () => {
    assert.equal(extractAtToken('hello @src/age', 14), 'src/age')
  })

  it('returns null when there is no @ before the cursor', () => {
    assert.equal(extractAtToken('hello world', 11), null)
  })

  it('keeps emoji in the token (does not split at non-ASCII)', () => {
    // 容错：用户复制粘贴的「@🎯 目标.md」「@中文 路径.md」应被当作完整 token。
    // 旧实现若有空白检测问题会把 emoji 切碎。
    const text = 'try @🎯-target.md'
    const cursor = text.length  // 光标在末尾——token 是整段 emoji 路径
    assert.equal(extractAtToken(text, cursor), '🎯-target.md')
    const text2 = 'check @中文/file.ts'
    const cursor2 = text2.length
    assert.equal(extractAtToken(text2, cursor2), '中文/file.ts')
  })

  it('returns empty string when cursor is right after @', () => {
    assert.equal(extractAtToken('hello @', 7), '')
  })
})

describe('applyCompletion', () => {
  it('产出规范形 @file:（mention-parser 可解析——断链修复）', () => {
    // 输入 'open @src/ag' 光标在 10（'@src/' 末尾）——applyCompletion 把
    // @-token 整体替换为规范 mention + 空格，光标后的 'ag' 保留在尾部。
    const out = applyCompletion('open @src/ag', 10, 'src/agent.ts')
    assert.equal(out.text, 'open @file:src/agent.ts ag')
    // 24 = 'open ' (5) + '@file:src/agent.ts '.length (19)
    assert.equal(out.cursor, 24)
  })

  it('含空格路径用引用形', () => {
    const out = applyCompletion('open @Pro', 9, 'Program Files/a.ts')
    assert.equal(out.text, 'open @file:"Program Files/a.ts" ')
  })
})

describe('getCompletions', () => {
  it('returns [] in a non-git directory without throwing (容错)', async () => {
    // 非 git 目录：git 命令会以非零退出码失败——getCompletions 必须静默吞掉。
    const dir = makeTestDir('rivet-nogit-')
    try {
      const out = await getCompletions('any', dir, 8)
      assert.deepEqual(out, [])
    } finally {
      cleanupTestDir(dir)
    }
  })

  it('returns matches from a real git repo', async () => {
    // 用真 git init 的临时仓库验证排序：startsWith 优先于 substring。
    const dir = makeTestDir('rivet-git-')
    try {
      writeFileSync(join(dir, 'src.ts'), '// src')
      writeFileSync(join(dir, 'src-test.ts'), '// src test')
      writeFileSync(join(dir, 'other.ts'), '// other')
      // 手动 init + add 避免依赖 git CLI 之外的工具
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['add', '.'], { cwd: dir })
      const out = await getCompletions('src', dir, 8)
      // 期望：两个匹配项，'src.ts' 在 'src-test.ts' 之前（prefix 优先 + 长度）
      assert.ok(out.includes('src.ts'), `got: ${out}`)
      assert.ok(out.includes('src-test.ts'), `got: ${out}`)
      assert.equal(out.indexOf('src.ts') < out.indexOf('src-test.ts'), true, 'prefix match must come first')
      assert.ok(!out.includes('other.ts'), `non-match leaked: ${out}`)
    } finally {
      cleanupTestDir(dir)
    }
  })

})
