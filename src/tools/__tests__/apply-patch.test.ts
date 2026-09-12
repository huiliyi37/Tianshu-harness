import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { applyPatch, APPLY_PATCH_TOOL, extractPatchTargetPaths } from '../apply-patch.js'

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('applyPatch', () => {
  let repoDir: string
  const validDiff = `diff --git a/file.txt b/file.txt
index 2e65efe..a2005b8 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-original
+patched
`

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'patch-test-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'file.txt'), 'original\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('applies valid patch', async () => {
    const result = await applyPatch(repoDir, { diff: validDiff })
    assert.equal(result.ok, true, result.error)
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'patched')
  })

  it('check-only mode does not modify files', async () => {
    const result = await applyPatch(repoDir, { diff: validDiff, checkOnly: true })
    assert.equal(result.ok, true, result.error)
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'original')
  })

  it('returns error for conflicting patch', async () => {
    writeFileSync(join(repoDir, 'file.txt'), 'already changed\n')
    const result = await applyPatch(repoDir, { diff: validDiff })
    assert.equal(result.ok, false)
    assert.ok(
      /patch does not apply|does not match index|repository lacks the necessary blob|和索引不匹配/i.test(result.error),
      result.error,
    )
  })

  it('successful apply echoes the diff into uiContent (display-only)', async () => {
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: validDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.ok(!result.isError, result.content)
    // model-facing content stays a short summary
    assert.equal(result.content, '补丁应用成功。')
    // display-only uiContent carries the diff for colored rendering
    assert.ok(result.uiContent && /^@@/m.test(result.uiContent), 'uiContent has hunk header')
    assert.ok(/^-original$/m.test(result.uiContent!))
    assert.ok(/^\+patched$/m.test(result.uiContent!))
  })

  it('tool validates non-empty diff input', async () => {
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: '' },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /需要非空/)
  })

  it('normalizes Windows-style backslash paths in diff headers', async () => {
    const windowsDiff = validDiff.replace(/a\/file\.txt/g, 'a\\file.txt').replace(/b\/file\.txt/g, 'b\\file.txt')
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: windowsDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.ok(!result.isError, result.content)
    assert.ok(result.uiContent!.includes('--- a/file.txt'), 'header path was normalized')
    assert.ok(result.uiContent!.includes('+++ b/file.txt'), 'header path was normalized')
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'patched')
  })

  it('rejects a collapsed history pointer as diff input', async () => {
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: '[patch applied to 2 file(s): a.py, b.py — 4 hunks, 9000 chars. Use read_file / git diff to inspect.]' },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /历史消息里的显示指针/)
  })

  // 交叉 echo 的另一半：PR #25 让 apply_patch 的指针能被别的工具识别（出方向），
  // 这里补 apply_patch 识别别的工具的指针（入方向）。write_file 侧的守卫早就
  // 「Checks ALL pointer prefixes」，apply_patch 此前只认自己那一个前缀。
  it('rejects another tool pointer echoed into diff (cross-tool, inbound)', async () => {
    const writePtr = '[file written to /x/y.ts — 40 lines, 900 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]'
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: writePtr },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /显示指针/)
  })

  it('rejects a plan pointer echoed into diff', async () => {
    const planPtr = '[plan persisted to .rivet/plans/x.md — 5 lines, 100 chars. 已成功落盘，勿重贴——历史正常截断，查看用 read_file。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]'
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: planPtr },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.equal(result.isError, true)
    // 必须断言是「守卫」拦的：光看 isError 区分不出——守卫不拦时 diff 会走到
    // git apply，那边同样会失败返回 isError，测试照样绿（弱断言）。
    assert.match(result.content, /显示指针/)
  })

  // marker 决定这次拦截会不会被计数：pointer-regurgitation-hook 的
  // WRITE_CLASS_TOOLS 本就含 apply_patch 但靠该 marker 识别，
  // tool-history-recorder 也靠它把这类格式错标 transient（不计入 errorPenalty）。
  it('tags pointer rejections with the guard marker so the hook can count them', async () => {
    for (const diff of [
      '[patch applied to 2 file(s): a.py, b.py — 4 hunks, 9000 chars. Use read_file / git diff to inspect.]',
      '[file written to /x/y.ts — 40 lines, 900 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]',
    ]) {
      const result = await APPLY_PATCH_TOOL.execute({ input: { diff }, toolUseId: 'toolu_test', cwd: repoDir })
      assert.equal(result.isError, true)
      assert.match(result.content, /pointer placeholder from message history/, `missing marker for: ${diff.slice(0, 30)}`)
    }
  })

  it('still applies a real diff that merely mentions a pointer prefix in context', async () => {
    // 真实 diff 的正文里出现方括号文本不该被误拦——守卫要的是「整行是指针」。
    const diffWithText = `diff --git a/file.txt b/file.txt
index 2e65efe..a2005b8 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-original
+see [patch applied to] note in docs
`
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: diffWithText },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.ok(!result.isError, result.content)
  })

  it('rolls back a patch that introduces a fatal Python syntax error', async () => {
    writeFileSync(join(repoDir, 'mod.py'), 'def foo():\n    return 1\n')
    git(repoDir, ['add', 'mod.py'])
    git(repoDir, ['commit', '-m', 'add mod'])
    // Patch turns a valid def into an unbalanced one — python3 ast.parse fails.
    const badDiff = `diff --git a/mod.py b/mod.py
--- a/mod.py
+++ b/mod.py
@@ -1,2 +1,2 @@
-def foo():
+def foo(:
     return 1
`
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: badDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    // If python3 is unavailable, syntax check degrades to OK and the patch
    // stays applied — only assert rollback when the corruption was detected.
    if (result.isError) {
      assert.match(result.content, /已自动回滚/)
      assert.equal(readFileSync(join(repoDir, 'mod.py'), 'utf-8'), 'def foo():\n    return 1\n')
    }
  })

  it('extractPatchTargetPaths parses +++ headers and skips /dev/null', () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
diff --git a/gone.txt b/gone.txt
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`
    assert.deepEqual(extractPatchTargetPaths(diff), ['x.ts'])
  })

  it('truncates oversized diffs in uiContent', async () => {
    const bigFile = join(repoDir, 'big.txt')
    const beforeLines = Array.from({ length: 1200 }, (_, i) => `line-${i}`)
    writeFileSync(bigFile, beforeLines.join('\n') + '\n')
    git(repoDir, ['add', 'big.txt'])
    git(repoDir, ['commit', '-m', 'add big'])
    const afterLines = beforeLines.map(l => `patched-${l}`)
    const hunks = beforeLines.map((l, i) => `-${l}\n+${afterLines[i]}`).join('\n')
    const bigDiff = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,1200 +1,1200 @@\n${hunks}\n`
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: bigDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.ok(!result.isError, result.content)
    const lines = result.uiContent!.split('\n')
    assert.ok(lines.length <= 602, `expected truncation, got ${lines.length} lines`)
    assert.ok(result.uiContent!.includes('行 diff，Ctrl+O'))
  })

  // `git apply --3way` 报失败（exit 1）之后，状态可能已经被改过：干净文件被
  // 整体套用并 staged、冲突文件留下冲突标记与 UU（unmerged）索引条目。工具若
  // 只报"失败"就返回，模型会按"失败=没发生"重试同一补丁，而 UU 条目还会让标准
  // 恢复命令 `git checkout -- <file>` 报 "path is unmerged"。
  //
  // 本用例走的是「和索引不匹配」路径：补丁没有 index 行 → 三方合并所需 blob
  // 不可得，git 回落到直接应用并整体拒绝，本就不留残留。它守护的是失败文案与
  // "不留 UU / 不留暂存产物"的契约；真正走三方合并、失败前真半套用的路径见下
  // 一条用例。
  it('rolls back the half-applied tree when --3way reports a conflict', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'base-a\n')
    writeFileSync(join(repoDir, 'b.txt'), 'base-b\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'add a b'])
    // a.txt 本地漂移（未提交）→ 补丁以已提交内容为前置 → 拒绝应用
    writeFileSync(join(repoDir, 'a.txt'), 'local-edit\n')
    const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-base-a
+patched-a
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-base-b
+patched-b
`
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })

    assert.equal(result.isError, true, 'conflicting patch must fail')
    assert.match(result.content, /已回滚到补丁前状态/)
    // 工作树回到补丁前状态：a.txt 是用户的本地漂移内容，不是冲突标记
    assert.equal(readFileSync(join(repoDir, 'a.txt'), 'utf-8'), 'local-edit\n')
    // 干净文件 b.txt 不留补丁内容、不留在暂存区
    assert.equal(readFileSync(join(repoDir, 'b.txt'), 'utf-8'), 'base-b\n')
    const status = git(repoDir, ['status', '--porcelain']).stdout ?? ''
    assert.ok(!status.includes('UU'), `index must not keep unmerged entries:\n${status}`)
    assert.ok(!/^M  b\.txt$/m.test(status), `b.txt must not stay staged:\n${status}`)
    // 标准恢复命令不再被毒化（修复前：error: path 'a.txt' is unmerged）
    const checkout = git(repoDir, ['checkout', '--', 'a.txt'])
    assert.equal(checkout.status, 0, `git checkout -- a.txt must work after rollback: ${checkout.stderr}`)
    assert.equal(readFileSync(join(repoDir, 'a.txt'), 'utf-8'), 'base-a\n', 'checkout restores the committed base (drift was unstaged)')
  })

  // 真三方合并：补丁基于更早的提交生成（`git diff` 带 index 行 → 三方合并所需
  // blob 在对象库中可得），目标文件随后被再次提交改动。此时 git 真的执行三方
  // 合并：冲突文件写冲突标记并留 UU，干净文件被套用并 staged（git 自己会打印
  // "成功应用补丁到 'b.txt'"）。这条路径才是回滚逻辑的服务对象——断言必须落在
  // 磁盘与索引状态上，否则测试会因为"本来就什么都没留下"而假绿。
  it('rolls back a real three-way merge conflict (UU index + staged clean file)', async () => {
    const baseA = 'shared\noriginal\n'
    writeFileSync(join(repoDir, 'a.txt'), baseA)
    writeFileSync(join(repoDir, 'b.txt'), 'base-b\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'v1'])

    // 补丁基于 v1 生成
    writeFileSync(join(repoDir, 'a.txt'), 'shared\npatched\n')
    writeFileSync(join(repoDir, 'b.txt'), 'patched-b\n')
    const diff = String(git(repoDir, ['diff']).stdout)
    assert.ok(/^index /m.test(diff), `fixture must carry index lines to reach the three-way path:\n${diff}`)
    writeFileSync(join(repoDir, 'a.txt'), baseA)
    writeFileSync(join(repoDir, 'b.txt'), 'base-b\n')

    // 目标文件在补丁生成后被提交改动 → 三方合并必然冲突
    writeFileSync(join(repoDir, 'a.txt'), 'shared\nconflicting\n')
    git(repoDir, ['add', 'a.txt'])
    git(repoDir, ['commit', '-m', 'v2'])

    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })

    assert.equal(result.isError, true, 'conflicting three-way merge must fail')
    assert.match(result.content, /已回滚到补丁前状态/)
    const status = git(repoDir, ['status', '--porcelain']).stdout ?? ''
    assert.ok(!status.includes('UU'), `index must not keep unmerged entries:\n${status}`)
    assert.ok(!/^M  b\.txt$/m.test(status), `b.txt must not stay staged:\n${status}`)
    // 冲突标记不得留在磁盘上（下游语法检查会把它们当成"已应用"的输入）
    assert.equal(readFileSync(join(repoDir, 'a.txt'), 'utf-8'), 'shared\nconflicting\n',
      'a.txt must be back to its committed content, without conflict markers')
    // 干净合并的那一半也必须回滚——失败路径不做部分应用
    assert.equal(readFileSync(join(repoDir, 'b.txt'), 'utf-8'), 'base-b\n',
      'b.txt must not keep the cleanly-merged patch content')
    const checkout = git(repoDir, ['checkout', '--', 'a.txt'])
    assert.equal(checkout.status, 0, `git checkout -- a.txt must work after rollback: ${checkout.stderr}`)
  })
})
