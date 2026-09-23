import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { GIT_TOOL, getWorkingTreeFiles, getFileDiff, getFileAtBase, nullDeviceFor } from '../git.js'

// 测试 repo 必须建在系统 tmpdir（仓库外）且路径每次唯一（mkdtemp）。
// 曾用工作树内固定路径（.git-test-tmp）：多会话并发跑测试时，一个进程的
// afterEach rmSync 恰好删掉另一进程刚 init 的 .git，后者的 `git config`
// 找不到本地 repo 便向上爬到主仓库 → user.name/email 被写成 Test，
// 之后所有会话的提交作者全部污染（发生一次即永久）。tmpdir 外无 repo
// 可爬，竞态只会响亮报错；mkdtemp 唯一路径则让竞态本身消失。
let TMP: string

describe('GIT_TOOL', () => {
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'rivet-git-tool-'))
    execSync('git init', { cwd: TMP })
    execSync('git config user.email "test@test.com"', { cwd: TMP })
    execSync('git config user.name "Test"', { cwd: TMP })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('has correct definition name', () => {
    assert.equal(GIT_TOOL.definition.name, 'git')
  })

  it('returns status for clean repo', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'status' },
      toolUseId: 'tu_1',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('干净'))
  })

  it('returns diff summary', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'a.txt'), 'modified')

    const result = await GIT_TOOL.execute({
      input: { action: 'diff_summary' },
      toolUseId: 'tu_2',
      cwd: TMP,
    })
    assert.ok(result.content.includes('a.txt'))
  })

  it('commits staged changes with message when no session files are available', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'b.txt'), 'new file')
    execSync('git add .', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'Add b.txt' },
      toolUseId: 'tu_3',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Add b.txt'))
  })

  it('commits only session modified files and leaves unrelated worktree changes alone', async () => {
    writeFileSync(join(TMP, 'owned.txt'), 'base owned')
    writeFileSync(join(TMP, 'other.txt'), 'base other')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })

    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    writeFileSync(join(TMP, 'new-owned.txt'), 'new owned')
    writeFileSync(join(TMP, 'other.txt'), 'other session change')
    writeFileSync(join(TMP, 'other-new.txt'), 'other new')

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'Commit owned files' },
      toolUseId: 'tu_scoped',
      cwd: TMP,
      sessionModifiedFiles: [join(TMP, 'owned.txt'), join(TMP, 'new-owned.txt')],
    })
    assert.equal(result.isError, undefined)

    const committedFiles = execSync('git show --name-only --pretty=format: HEAD', { cwd: TMP, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .sort()
    assert.deepEqual(committedFiles, ['new-owned.txt', 'owned.txt'])

    const status = execSync('git status --porcelain', { cwd: TMP, encoding: 'utf-8' })
    assert.match(status, / M other\.txt/)
    assert.match(status, /\?\? other-new\.txt/)
    assert.ok(!status.includes('owned.txt'))
    assert.ok(!status.includes('new-owned.txt'))
  })

  it('refuses to commit unstaged changes when session ownership is unknown', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    const headBefore = execSync('git rev-parse --short HEAD', { cwd: TMP, encoding: 'utf-8' }).trim()
    writeFileSync(join(TMP, 'a.txt'), 'dirty')

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'Should not auto stage' },
      toolUseId: 'tu_unscoped_dirty',
      cwd: TMP,
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /deliver_task.*commit=true/)
    assert.equal(execSync('git rev-parse --short HEAD', { cwd: TMP, encoding: 'utf-8' }).trim(), headBefore)
  })

  it('blocks commit when owned (scoped) files include a sensitive file', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    const headBefore = execSync('git rev-parse --short HEAD', { cwd: TMP, encoding: 'utf-8' }).trim()
    // .env 可能经 bash 写入（绕过文件工具校验）——入库前最后一道闸必须拦下
    writeFileSync(join(TMP, '.env'), 'KEY=1')
    writeFileSync(join(TMP, 'src-change.txt'), 'x')

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'leak creds' },
      toolUseId: 'tu_sens_scoped',
      cwd: TMP,
      sessionModifiedFiles: [join(TMP, '.env'), join(TMP, 'src-change.txt')],
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /敏感文件拦截/)
    assert.match(result.content, /\.env/)
    assert.equal(execSync('git rev-parse --short HEAD', { cwd: TMP, encoding: 'utf-8' }).trim(), headBefore)
  })

  it('blocks commit when already-staged content includes a sensitive file', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    const headBefore = execSync('git rev-parse --short HEAD', { cwd: TMP, encoding: 'utf-8' }).trim()
    writeFileSync(join(TMP, 'credentials'), 'token=x')  // 无扩展名 credentials（M4 新模式）
    execSync('git add credentials', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'staged leak' },
      toolUseId: 'tu_sens_staged',
      cwd: TMP,
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /敏感文件拦截/)
    assert.equal(execSync('git rev-parse --short HEAD', { cwd: TMP, encoding: 'utf-8' }).trim(), headBefore)
  })

  it('rejects unknown action', async () => {
    const result = await GIT_TOOL.execute({
      input: { action: 'push' },
      toolUseId: 'tu_4',
      cwd: TMP,
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('未知 action'))
  })

  it('requires approval for commit action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'commit' }, toolUseId: 't', cwd: '/' }), true)
  })

  it('does not require approval for status action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'status' }, toolUseId: 't', cwd: '/' }), false)
  })

  it('truncates git output over 50KB', async () => {
    const bigContent = 'x'.repeat(60_000)
    writeFileSync(join(TMP, 'big.txt'), bigContent)
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'big.txt'), 'y'.repeat(60_000))

    const result = await GIT_TOOL.execute({
      input: { action: 'diff_summary' },
      toolUseId: 'tu_big',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.length < 55_000, `Output too large: ${result.content.length}`)
  })

  it('returns git log with default count', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'b.txt'), 'world')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "second"', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'log' },
      toolUseId: 'tu_log',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('second'))
    assert.ok(result.content.includes('init'))
  })

  it('returns git log with maxCount', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "first"', { cwd: TMP })
    writeFileSync(join(TMP, 'b.txt'), 'world')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "second"', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'log', maxCount: 1 },
      toolUseId: 'tu_log2',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('second'))
    assert.ok(!result.content.includes('first'))
  })

  it('git stash saves working changes', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'a.txt'), 'dirty')

    const result = await GIT_TOOL.execute({
      input: { action: 'stash' },
      toolUseId: 'tu_stash',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('已保存'))
  })

  it('creates safety ref before stash for reversible recovery (P2)', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'a.txt'), 'dirty')

    await GIT_TOOL.execute({
      input: { action: 'stash' },
      toolUseId: 'tu_safety',
      cwd: TMP,
    })

    const refResult = execSync('git show-ref refs/kiro-safety/last-stash', { cwd: TMP, encoding: 'utf-8' }).trim()
    assert.ok(refResult.length > 0, 'safety ref should exist')
    // Verify it points to a valid commit
    const [sha] = refResult.split(' ')
    assert.ok(sha && sha.length === 40, `expected 40-char sha, got: ${sha?.length ?? 0}`)
  })

  it('does not require approval for log action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'log' }, toolUseId: 't', cwd: '/' }), false)
  })

  it('does not require approval for stash action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'stash' }, toolUseId: 't', cwd: '/' }), false)
  })
})

describe('getWorkingTreeFiles / getFileDiff (desktop changes tab)', () => {
  let TMP2: string

  beforeEach(() => {
    TMP2 = mkdtempSync(join(tmpdir(), 'rivet-git-wt-'))
    execSync('git init', { cwd: TMP2 })
    execSync('git config user.email "test@test.com"', { cwd: TMP2 })
    execSync('git config user.name "Test"', { cwd: TMP2 })
    writeFileSync(join(TMP2, 'base.txt'), 'base\n')
    execSync('git add .', { cwd: TMP2 })
    execSync('git commit -m "init"', { cwd: TMP2 })
  })

  afterEach(() => {
    rmSync(TMP2, { recursive: true, force: true })
  })

  it('renders a full-addition diff for a new/untracked file', async () => {
    writeFileSync(join(TMP2, 'fresh.txt'), 'line1\nline2\nline3\n')
    const diff = await getFileDiff(TMP2, 'fresh.txt')
    assert.ok(diff.includes('+line1'), 'new file lines should appear as additions')
    assert.ok(diff.includes('+line2'))
    assert.ok(diff.includes('+line3'))
    assert.ok(diff.includes('b/fresh.txt'), 'header should anchor on b/<rel>')
  })

  it('counts additions for an untracked file in the working-tree list', async () => {
    writeFileSync(join(TMP2, 'fresh.txt'), 'a\nb\nc\n')
    const { files, isRepo } = await getWorkingTreeFiles(TMP2)
    assert.equal(isRepo, true)
    const fresh = files.find((f) => f.path === 'fresh.txt')
    assert.ok(fresh, 'untracked file should be listed')
    assert.equal(fresh!.status, 'untracked')
    assert.equal(fresh!.additions, 3)
  })

  it('selects the platform null device for the --no-index base', () => {
    // Windows 上原生 git.exe 既不认 '/dev/null'（Node spawn 不做 MSYS 路径转换，
    // git 会把空设备当目录前缀拼成 '/dev/null/<rel>'），也不认 os.devNull 给的
    // '\\.\nul'，只有裸 NUL 可用；POSIX 侧保持 /dev/null。抽成纯函数就是为了让
    // 这个真机跑不到的分支能在任意宿主上被钉住。
    assert.equal(nullDeviceFor('win32'), 'NUL')
    assert.equal(nullDeviceFor('darwin'), '/dev/null')
    assert.equal(nullDeviceFor('linux'), '/dev/null')
  })

  it('still diffs a tracked modified file against HEAD', async () => {
    writeFileSync(join(TMP2, 'base.txt'), 'base changed\n')
    const diff = await getFileDiff(TMP2, 'base.txt')
    assert.ok(diff.includes('-base'), 'old content should appear as deletion')
    assert.ok(diff.includes('+base changed'), 'new content should appear as addition')
  })

  it('returns notARepo gracefully outside a git repo', async () => {
    // Must live outside the project repo, else git finds the parent repo.
    const nonRepo = mkdtempSync(join(tmpdir(), 'git-nonrepo-'))
    try {
      const { files, isRepo } = await getWorkingTreeFiles(nonRepo)
      assert.equal(isRepo, false)
      assert.equal(files.length, 0)
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  it('keeps committed changes visible when diffing against a baseline ref', async () => {
    const baseline = execSync('git rev-parse HEAD', { cwd: TMP2, encoding: 'utf-8' }).trim()
    // Commit some work mid-task, then leave more work uncommitted.
    writeFileSync(join(TMP2, 'base.txt'), 'base changed\n')
    execSync('git add . && git commit -m "mid-task commit"', { cwd: TMP2 })
    writeFileSync(join(TMP2, 'wip.txt'), 'wip\n')

    // Against HEAD, the committed change is invisible.
    const headView = await getWorkingTreeFiles(TMP2)
    assert.ok(!headView.files.some((f) => f.path === 'base.txt'), 'committed file hidden vs HEAD')

    // Against the baseline, both committed and uncommitted work show up.
    const baselineView = await getWorkingTreeFiles(TMP2, baseline)
    const paths = baselineView.files.map((f) => f.path).sort()
    assert.deepEqual(paths, ['base.txt', 'wip.txt'])

    const diff = await getFileDiff(TMP2, 'base.txt', baseline)
    assert.ok(diff.includes('-base'), 'baseline diff shows old content')
    assert.ok(diff.includes('+base changed'), 'baseline diff shows committed change')
  })

  it('returns base content for a tracked file and exists=false for a new one', async () => {
    writeFileSync(join(TMP2, 'base.txt'), 'base changed\n')
    writeFileSync(join(TMP2, 'fresh.txt'), 'new\n')
    const tracked = await getFileAtBase(TMP2, 'base.txt')
    assert.equal(tracked.exists, true)
    assert.equal(tracked.content, 'base\n')
    const fresh = await getFileAtBase(TMP2, 'fresh.txt')
    assert.equal(fresh.exists, false)
    assert.equal(fresh.content, '')
  })

  it('getFileAtBase rejects path traversal', async () => {
    await assert.rejects(() => getFileAtBase(TMP2, '../outside.txt'), /无效文件路径/)
  })

  // Regression (Windows mojibake, 2026-07-29): the desktop "Changes" tab diffs
  // a UTF-8 file with CJK comments. git output bytes mirror the source (modern
  // git defaults to UTF-8), so the Chinese must survive verbatim — NOT be
  // misjudged as GBK and turned to gibberish by a chunk-boundary GBK probe.
  it('keeps UTF-8 CJK comments intact in getFileDiff (no GBK mojibake)', async () => {
    writeFileSync(join(TMP2, 'strategy.js'), '// 依赖 get_stock_list 获取股票列表\nconst limit_up = 1\n')
    const diff = await getFileDiff(TMP2, 'strategy.js')
    assert.ok(
      diff.includes('// 依赖 get_stock_list 获取股票列表'),
      `CJK comment mojibake'd in getFileDiff:\n${diff}`,
    )
  })

  // core.quotePath=false must keep non-ASCII paths verbatim so the desktop
  // diff parser can anchor line comments on the right file.
  it('keeps non-ASCII file paths unescaped in getFileDiff headers', async () => {
    mkdirSync(join(TMP2, '策略'), { recursive: true })
    writeFileSync(join(TMP2, '策略', '涨停.js'), 'export const up = 1\n')
    const diff = await getFileDiff(TMP2, '策略/涨停.js')
    assert.ok(diff.includes('策略/涨停.js'), `non-ASCII path escaped:\n${diff}`)
  })

  it('falls back to HEAD for a malicious or malformed base ref', async () => {
    writeFileSync(join(TMP2, 'base.txt'), 'base changed\n')
    const diff = await getFileDiff(TMP2, 'base.txt', '--output=/tmp/evil')
    assert.ok(diff.includes('+base changed'), 'behaves like HEAD diff, no option injection')
  })

  it('filters runtime/generated files by default', async () => {
    mkdirSync(join(TMP2, 'src'), { recursive: true })
    writeFileSync(join(TMP2, 'src', 'code.ts'), 'export const a = 1\n')
    mkdirSync(join(TMP2, '.rivet', 'plugin-abc'), { recursive: true })
    writeFileSync(join(TMP2, '.rivet', 'plugin-abc', 'index.js'), 'x\n')
    mkdirSync(join(TMP2, 'release'), { recursive: true })
    writeFileSync(join(TMP2, 'release', 'app.dmg'), 'binary')
    writeFileSync(join(TMP2, '_test-docx.html'), '<html>')

    const { files } = await getWorkingTreeFiles(TMP2)
    const paths = files.map((f) => f.path)
    assert.ok(paths.includes('src/code.ts'), 'source file should be visible')
    assert.ok(!paths.includes('.rivet/plugin-abc/index.js'), 'plugin runtime should be hidden')
    assert.ok(!paths.includes('release/app.dmg'), 'release binary should be hidden')
    assert.ok(!paths.includes('_test-docx.html'), 'temp test file should be hidden')
  })

  it('includes ignored files when includeIgnored is true', async () => {
    mkdirSync(join(TMP2, 'src'), { recursive: true })
    writeFileSync(join(TMP2, 'src', 'code.ts'), 'export const a = 1\n')
    mkdirSync(join(TMP2, '.rivet', 'plugin-abc'), { recursive: true })
    writeFileSync(join(TMP2, '.rivet', 'plugin-abc', 'index.js'), 'x\n')

    const { files } = await getWorkingTreeFiles(TMP2, 'HEAD', true)
    const paths = files.map((f) => f.path)
    assert.ok(paths.includes('src/code.ts'), 'source file should still be visible')
    assert.ok(paths.includes('.rivet/plugin-abc/index.js'), 'ignored file should appear when requested')
  })
})
