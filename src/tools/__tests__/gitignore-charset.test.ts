/**
 * gitignore 通配字符集：`?` 单字符、`[...]` 字符类、未闭合 `[`（2026-10-10）。
 *
 * **全部期望值取自真值基准 `git check-ignore`**（真实 git 仓库逐例实测，见
 * 复核记录），不是从实现或文档推断的。既有 `gitignore.test.ts` 覆盖 `*`/目录/
 * 根锚定/双星，未覆盖这里的三类——缺陷区恰好是测试盲区。
 *
 * 实测基线要点：
 *   - `?` 与 `[...]` 都**不跨目录分隔符**（`a?c` vs `a/c`、`a[bc]` vs `a/b` 均不忽略）；
 *   - 未闭合 `[` 使**整条模式不匹配**（`x[` vs `x[` 也不忽略——精确匹配通路不得命中）；
 *   - 类内的 `/` 不参与匹配（`[a/]b` 对 `ab` 仍忽略）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GitignoreFilter } from '../gitignore.js'

/** 建一个临时目录，写 .gitignore（单条模式），返回 cwd。 */
function repoWith(pattern: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-gitignore-'))
  writeFileSync(join(cwd, '.gitignore'), pattern + '\n')
  return cwd
}

/** 在真值仓库里问实现：pattern 是否忽略 path。 */
function implIgnores(pattern: string, path: string): boolean {
  const cwd = repoWith(pattern)
  try {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), 'x')
    return new GitignoreFilter(cwd, [pattern]).isIgnored(cwd, join(cwd, path))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('GitignoreFilter — ? 单字符通配（git check-ignore 真值）', () => {
  it('matches exactly one non-separator character', () => {
    for (const [pattern, path] of [
      ['file?.txt', 'file1.txt'],
      ['a?c', 'abc'],
      ['config?.json', 'config1.json'],
    ] as const) {
      assert.equal(implIgnores(pattern, path), true, `${pattern} 应忽略 ${path}（git 真值 IGNORED）`)
    }
  })

  it('does NOT cross directory separators', () => {
    // git 真值：`a?c` vs `a/c` → not ignored
    assert.equal(implIgnores('a?c', 'a/c'), false, '? 不得匹配 /')
  })

  it('does not match zero or two characters', () => {
    assert.equal(implIgnores('a?c', 'ac'), false)
    assert.equal(implIgnores('a?c', 'abbc'), false)
  })
})

describe('GitignoreFilter — [...] 字符类（git check-ignore 真值）', () => {
  it('matches a character set, a range and a negation', () => {
    for (const [pattern, path] of [
      ['br[oa]d', 'brod'],
      ['[abc].txt', 'b.txt'],
      ['secret[0-9].txt', 'secret3.txt'],
      ['[!abc].txt', 'z.txt'],
      ['[a-c]x', 'bx'],
      ['[abc]', 'a'],
    ] as const) {
      assert.equal(implIgnores(pattern, path), true, `${pattern} 应忽略 ${path}（git 真值 IGNORED）`)
    }
  })

  it('does NOT cross directory separators, and ignores `/` inside the class body', () => {
    // git 真值：`a[bc]` vs `a/b` → not ignored；`[a/]b` vs `ab` → ignored
    assert.equal(implIgnores('a[bc]', 'a/b'), false, '字符类不得匹配 /')
    assert.equal(implIgnores('[a/]b', 'ab'), true, '类内的 / 不参与匹配')
  })

  it('does not match a character outside the set', () => {
    assert.equal(implIgnores('[abc].txt', 'z.txt'), false)
    assert.equal(implIgnores('secret[0-9].txt', 'secretX.txt'), false)
  })

  it('combines with ** and other glob syntax', () => {
    // git 真值：`a/**/[bc]x` vs `a/d/bx` → ignored；`*.[ch]` vs `a.c` → ignored
    assert.equal(implIgnores('a/**/[bc]x', 'a/d/bx'), true)
    assert.equal(implIgnores('*.[ch]', 'a.c'), true)
  })
})

describe('GitignoreFilter — 未闭合 `[` 使整条模式不匹配（git check-ignore 真值）', () => {
  it('never matches when the class is unterminated', () => {
    // git 真值：`[abc` vs `a` → not ignored
    assert.equal(implIgnores('[abc', 'a'), false)
  })

  it('does not fall through to the literal exact-match path', () => {
    // git 真值：`x[` vs 同名文件 `x[` → not ignored。
    // 修复前 `matchGlob` 首行 `pattern === str` 会命中 → 误拦（方向与「漏判」相反）。
    assert.equal(implIgnores('x[', 'x['), false, '未闭合类的模式不得由精确匹配通路命中')
    assert.equal(implIgnores('a[b', 'a[b'), false)
  })
})

describe('GitignoreFilter — 既有 `*` 语义回归护栏', () => {
  it('keeps star behaviour unchanged', () => {
    assert.equal(implIgnores('*.log', 'app.log'), true)
    // git 真值：`*.log` 不忽略 `app.log.1`（模式要求以 .log 结尾，`*` 不跨分隔符）
    assert.equal(implIgnores('*.log', 'app.log.1'), false)
    assert.equal(implIgnores('*.min.js', 'app.min.js'), true)
    assert.equal(implIgnores('*.log', 'app.txt'), false)
  })

  it('keeps literal and directory matching unchanged', () => {
    assert.equal(implIgnores('node_modules', 'node_modules/x.js'), true)
    assert.equal(implIgnores('.min.js', 'app.min.js'), true)
  })
})
