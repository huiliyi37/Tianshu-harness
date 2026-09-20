/**
 * git_scout（只读 git 侦察，回流自 3.14alpha）——反证表：
 *   #1「写动作偷偷能跑」     → 写 action 必须被拒且提示支持的只读集合
 *   #2「ref 可注入 flag」    → 以 - 开头 / 含 shell 元字符的 ref 一律拒
 *   #3「含空格路径被误拒」   → path 宽松校验（回归 alpha 2026-09-06 审查 MEDIUM）
 *   #4「输出格式随 git 版本漂」→ 钉住 log 的 `sha|月-日 时:分|主题` 与 count 的数字
 *   #5「失败当异常抛」       → 坏 ref / 非仓库目录都返回 isError 结果，不抛
 *   #6「只读语义被改」       → requiresApproval=false + concurrency-safe 是它的立身之本
 *   #7「profile 没接线」     → readonly profile（code_scout/doc_scout）真的拿得到它，
 *                              且补了只读 git 侦察后仍不算 write-capable
 *
 * 夹具纪律（照 git.test.ts 的教训）：**每个用例各自 mkdtemp**，绝不共用一个固定
 * 临时路径——并发会话下 afterEach 会删掉别人刚 init 的 .git，被删者 git config
 * 向上爬到主仓库，把 user.name/email 写成 Test，污染所有后续提交（发生一次即永久）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT_SCOUT_TOOL } from '../git-scout.js'
import type { ToolCallParams } from '../types.js'
import { profileRegistry, profileIsWriteCapable } from '../../agent/profile-registry.js'

let TMP: string

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: TMP, encoding: 'utf8' }).trim()
}

async function scout(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  return (await GIT_SCOUT_TOOL.execute({ input, cwd: TMP } as unknown as ToolCallParams)) as {
    content: string
    isError?: boolean
  }
}

describe('GIT_SCOUT_TOOL', () => {
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'rivet-git-scout-'))
    execSync('git init', { cwd: TMP })
    execSync('git config user.email "test@test.com"', { cwd: TMP })
    execSync('git config user.name "Test"', { cwd: TMP })
    writeFileSync(join(TMP, 'a.txt'), 'one\n')
    git('add a.txt')
    git('commit -m "first commit"')
    writeFileSync(join(TMP, 'a.txt'), 'two\n')
    git('add a.txt')
    git('commit -m "second commit"')
    git('tag v1.0.0')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('定义与只读语义：git_scout + 免审批 + 可并发', () => {
    assert.equal(GIT_SCOUT_TOOL.definition.name, 'git_scout')
    assert.equal(GIT_SCOUT_TOOL.requiresApproval?.({ input: { action: 'log' }, cwd: TMP } as unknown as ToolCallParams), false)
    assert.equal(GIT_SCOUT_TOOL.isConcurrencySafe?.(), true, '并发安全（readonly 并行侦察语义）')
  })

  it('#1 写动作被拒（readonly 工具不该有写面）', async () => {
    for (const action of ['commit', 'checkout', 'reset', 'stash', 'push', 'clean']) {
      const r = await scout({ action })
      assert.equal(r.isError, true, `${action} 必须被拒`)
      assert.match(r.content, /只读侦察工具/, '提示要说明这是只读工具')
      assert.match(r.content, /log/, '提示要给出支持的 action 集合')
    }
  })

  it('#4 log：格式与上限', async () => {
    const r = await scout({ action: 'log' })
    assert.equal(r.isError, undefined)
    const lines = r.content.split('\n')
    assert.equal(lines.length, 2, '两个提交')
    // <短sha>|<月-日 时:分>|<主题>
    assert.match(lines[0]!, /^[0-9a-f]{7,}\|\d{2}-\d{2} \d{2}:\d{2}\|second commit$/)
    assert.match(lines[1]!, /first commit$/)

    const limited = await scout({ action: 'log', maxCount: 1 })
    assert.equal(limited.content.split('\n').length, 1)
    assert.equal((await scout({ action: 'log', maxCount: 0 })).isError, true)
    assert.equal((await scout({ action: 'log', maxCount: 9999 })).isError, true)
  })

  it('#4 count：缺省数 HEAD，range 生效', async () => {
    const all = await scout({ action: 'count' })
    assert.equal(all.content, '2')
    const one = await scout({ action: 'count', range: 'HEAD~1..HEAD' })
    assert.equal(one.content, '1')
  })

  it('tags / branches / resolve / show', async () => {
    assert.equal((await scout({ action: 'tags' })).content, 'v1.0.0')
    assert.match((await scout({ action: 'branches' })).content, /\*/)
    const sha = (await scout({ action: 'resolve', ref: 'v1.0.0' })).content
    assert.match(sha, /^[0-9a-f]{40}$/)
    const shown = (await scout({ action: 'show', commit: 'HEAD' })).content
    assert.match(shown, /second commit/)
    assert.match(shown, /\d{4}-\d{2}-\d{2}/, 'iso 日期')
  })

  it('ancestry / merge_base / diff', async () => {
    assert.equal((await scout({ action: 'ancestry', a: 'HEAD~1', b: 'HEAD' })).content, 'YES')
    assert.equal((await scout({ action: 'ancestry', a: 'HEAD', b: 'HEAD~1' })).content, 'NO')
    const base = await scout({ action: 'merge_base', a: 'HEAD~1', b: 'HEAD' })
    assert.match(base.content, /^[0-9a-f]{40}$/)
    const diff = await scout({ action: 'diff', a: 'HEAD~1', b: 'HEAD' })
    assert.match(diff.content, /a\.txt/)
  })

  it('#2 ref 注入面被封死', async () => {
    for (const bad of ['-x', '--upload-pack=evil', 'HEAD; rm -rf /', 'a b', 'HEAD$(whoami)', 'x|y']) {
      const r = await scout({ action: 'resolve', ref: bad })
      assert.equal(r.isError, true, `ref "${bad}" 必须被拒`)
    }
    assert.equal((await scout({ action: 'log', range: '-n 5' })).isError, true)
  })

  it('#3 含空格 / 特殊字符的合法路径放行（回归审查 MEDIUM）', async () => {
    const weird = 'weird name & more.txt'
    writeFileSync(join(TMP, weird), 'x\n')
    git(`add "${weird}"`)
    git('commit -m "add weird file"')
    const r = await scout({ action: 'log', path: weird })
    assert.equal(r.isError, undefined, `含空格路径不该被拒：${r.content}`)
    assert.match(r.content, /add weird file/)
    // 空 path 仍然拒（不是路径）
    assert.equal((await scout({ action: 'log', path: '' })).isError, true)
  })

  it('#5 失败是结果不是异常：坏 ref / 空区间 / 非仓库目录', async () => {
    const badRef = await scout({ action: 'show', commit: 'no-such-ref-xyz' })
    assert.equal(badRef.isError, true)
    const empty = await scout({ action: 'log', range: 'HEAD..HEAD' })
    assert.equal(empty.isError, undefined)
    assert.match(empty.content, /无提交/, '空结果是正常返回（0 条提交），不是错误')

    const notRepo = mkdtempSync(join(tmpdir(), 'rivet-git-scout-norepo-'))
    try {
      const r = (await GIT_SCOUT_TOOL.execute({ input: { action: 'log' }, cwd: notRepo } as unknown as ToolCallParams)) as {
        content: string
        isError?: boolean
      }
      assert.equal(r.isError, true, '非仓库目录必须如实报错而不是抛')
    } finally {
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  // 回流 alpha 断言（alpha 199 行版有、主线首版移植时漏了）：工具写出来是给
  // readonly worker 用的，profile 若不接线，工具再正确也没人拿得到。
  it('#7 profile 接线：readonly profile 拿到 git_scout，写权判定不变', () => {
    const codeScout = profileRegistry.get('code_scout')
    assert.ok(codeScout, 'code_scout profile 必须存在')
    assert.ok(codeScout.allowedTools.includes('git_scout'), 'code_scout 必须放行 git_scout')
    assert.ok(profileRegistry.get('doc_scout')?.allowedTools.includes('git_scout'), 'doc_scout 同理')
    // 安全不变量：加了只读 git 侦察后 readonly 仍不算 write-capable（无 bash/git 写权）
    assert.equal(profileIsWriteCapable('code_scout'), false)
    assert.equal(profileIsWriteCapable('doc_scout'), false)
  })
})
