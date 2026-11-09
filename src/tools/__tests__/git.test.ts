import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, linkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { GIT_TOOL, getWorkingTreeFiles, getFileDiff, getFileAtBase, nullDeviceFor, isPathClean } from '../git.js'

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
    writeFileSync(join(TMP, '.git', 'info', 'exclude'), '._*\n.DS_Store\n')
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

  // pathspec 字面化（安全审计 2026-11-09 实证）：归属文件名本身含 glob 字符
  // 时，`git add -- 'foo*'` 会把 foo1.txt、foo2.txt 一并暂存，commit --only
  // 同理越界。--literal-pathspecs 后只动字面文件。
  it('commits only the literal file when an owned filename contains glob characters', async () => {
    writeFileSync(join(TMP, 'foo1.txt'), 'base 1')
    writeFileSync(join(TMP, 'foo2.txt'), 'base 2')
    writeFileSync(join(TMP, 'foo*'), 'base star')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })

    writeFileSync(join(TMP, 'foo1.txt'), 'change 1')
    writeFileSync(join(TMP, 'foo2.txt'), 'change 2')
    writeFileSync(join(TMP, 'foo*'), 'change star')

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'Commit glob-named file' },
      toolUseId: 'tu_glob',
      cwd: TMP,
      sessionModifiedFiles: [join(TMP, 'foo*')],
    })
    assert.equal(result.isError, undefined, result.content)

    const committedFiles = execSync('git show --name-only --pretty=format: HEAD', { cwd: TMP, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .sort()
    assert.deepEqual(committedFiles, ['foo*'])

    const status = execSync('git status --porcelain', { cwd: TMP, encoding: 'utf-8' })
    assert.match(status, / M foo1\.txt/)
    assert.match(status, / M foo2\.txt/)
  })

  it('stashes only the literal file when an owned filename contains glob characters', async () => {
    writeFileSync(join(TMP, 'foo1.txt'), 'base 1')
    writeFileSync(join(TMP, 'foo2.txt'), 'base 2')
    writeFileSync(join(TMP, 'foo*'), 'base star')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })

    writeFileSync(join(TMP, 'foo1.txt'), 'change 1')
    writeFileSync(join(TMP, 'foo2.txt'), 'change 2')
    writeFileSync(join(TMP, 'foo*'), 'change star')

    const result = await GIT_TOOL.execute({
      input: { action: 'stash' },
      toolUseId: 'tu_stash_glob',
      cwd: TMP,
      ownedFiles: [join(TMP, 'foo*')],
    })
    assert.equal(result.isError, undefined, result.content)

    const stashed = execSync('git stash show --name-only stash@{0}', { cwd: TMP, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .sort()
    assert.deepEqual(stashed, ['foo*'])

    const status = execSync('git status --porcelain', { cwd: TMP, encoding: 'utf-8' })
    assert.match(status, / M foo1\.txt/)
    assert.match(status, / M foo2\.txt/)
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
    writeFileSync(join(TMP2, '.git', 'info', 'exclude'), '._*\n.DS_Store\n')
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

  // 硬链接门禁（#491 在 path-validate.ts 的门禁未覆盖 git.ts 的独立读取路径）：
  // 工作区内的硬链接可指向任意 inode（`ln ~/.ssh/id_rsa proj/notes.txt`），
  // lstat 是普通文件、realpath 不越界、文件名门禁不触发，而 git diff 的读取
  // 用 open() 跟随硬链接——未修复前 getFileDiff 会把目标全文当 additions 返回。
  it('refuses a hardlink inside cwd pointing outside it (fail-closed)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'rivet-git-hl-out-'))
    try {
      const target = join(outside, 'id_rsa_mock')
      writeFileSync(target, 'POC-SYNTHETIC-SECRET\n')
      linkSync(target, join(TMP2, 'notes.txt'))
      await assert.rejects(() => getFileDiff(TMP2, 'notes.txt'), /无效文件路径/)
      await assert.rejects(() => getFileDiff(TMP2, 'notes.txt', 'HEAD~1'), /无效文件路径/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('skips addition backfill for a hardlink (no out-of-workspace read)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'rivet-git-hl-out2-'))
    try {
      const target = join(outside, 'data.txt')
      writeFileSync(target, 'a\nb\nc\nd\ne\n')
      linkSync(target, join(TMP2, 'linked.txt'))
      const { files } = await getWorkingTreeFiles(TMP2)
      const linked = files.find((f) => f.path === 'linked.txt')
      assert.ok(linked, 'hardlink should still be listed')
      assert.equal(linked!.additions, 0, 'backfill must not read through the hardlink')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still diffs a normal new file after the hardlink gate', async () => {
    writeFileSync(join(TMP2, 'ok.txt'), 'fine\n')
    assert.ok((await getFileDiff(TMP2, 'ok.txt')).includes('+fine'))
  })

  it('rejects directory pathspecs and keeps tracked hardlink statistics at zero', async () => {
    mkdirSync(join(TMP2, 'sub'))
    const tracked = join(TMP2, 'sub', 'notes.txt')
    writeFileSync(tracked, 'baseline\n')
    execSync('git add -- sub/notes.txt && git commit -m fixture', { cwd: TMP2 })
    const outside = mkdtempSync(join(tmpdir(), 'rivet-git-tracked-hl-'))
    try {
      const source = join(outside, 'fixture.txt')
      writeFileSync(source, 'SYNTHETIC_CANARY\nline2\nline3\n')
      rmSync(tracked)
      linkSync(source, tracked)
      await assert.rejects(() => getFileDiff(TMP2, 'sub'), /无效文件路径/)
      const { files } = await getWorkingTreeFiles(TMP2)
      const entry = files.find(file => file.path === 'sub/notes.txt')
      assert.ok(entry)
      assert.equal(entry.additions, 0)
      assert.equal(entry.deletions, 0)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })

  it('diffs wildcard characters as literal filenames without reading their siblings', async () => {
    if (process.platform === 'win32') return
    writeFileSync(join(TMP2, 'match*.txt'), 'literal baseline\n')
    writeFileSync(join(TMP2, 'match-other.txt'), 'sibling baseline\n')
    execSync('git add -- "match*.txt" match-other.txt && git commit -m fixture', { cwd: TMP2 })
    writeFileSync(join(TMP2, 'match*.txt'), 'literal changed\n')
    writeFileSync(join(TMP2, 'match-other.txt'), 'SIBLING_CONTENT\n')
    const diff = await getFileDiff(TMP2, 'match*.txt')
    assert.ok(diff.includes('+literal changed'))
    assert.ok(!diff.includes('SIBLING_CONTENT'))
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

// Regression (issue #358): the session cwd is not the boundary of the work.
// An agent may write a deliverable outside the workspace (a project-owned
// staging area, a handoff directory); that absolute path enters the session
// file history, and the client still has to render its diff. Before the fix
// both helpers threw `无效文件路径` for any path outside cwd, and the three
// routes calling them had no catch — the response degraded to a bare 500 and
// the Changes view showed nothing for the file.
describe('getFileDiff / getFileAtBase outside the session cwd (#358)', () => {
  let INSIDE: string
  let OUTSIDE: string

  beforeEach(() => {
    INSIDE = mkdtempSync(join(tmpdir(), 'rivet-git-inside-'))
    OUTSIDE = mkdtempSync(join(tmpdir(), 'rivet-git-outside-'))
    execSync('git init', { cwd: INSIDE })
    writeFileSync(join(INSIDE, '.git', 'info', 'exclude'), '._*\n.DS_Store\n')
    execSync('git config user.email "test@test.com"', { cwd: INSIDE })
    execSync('git config user.name "Test"', { cwd: INSIDE })
    writeFileSync(join(INSIDE, 'base.txt'), 'base\n')
    execSync('git add .', { cwd: INSIDE })
    execSync('git commit -m "init"', { cwd: INSIDE })
  })

  afterEach(() => {
    rmSync(INSIDE, { recursive: true, force: true })
    rmSync(OUTSIDE, { recursive: true, force: true })
  })

  it('renders a full-addition diff for an absolute path outside cwd', async () => {
    const outside = join(OUTSIDE, 'report.md')
    writeFileSync(outside, 'line1\nline2\n')
    const diff = await getFileDiff(INSIDE, outside)
    assert.ok(diff.includes('+line1'), `outside file lines should render as additions:\n${diff}`)
    assert.ok(diff.includes('+line2'))
    // The header must carry the absolute path verbatim. git relativizes it
    // against the filesystem root (`a/tmp/...`, leading slash dropped), which
    // would desync the desktop diff parser's (file, oldLine, newLine) comment
    // anchors from the path the client asked for.
    assert.ok(diff.includes(`+++ b/${outside}`), `header should anchor on the absolute path:\n${diff}`)
  })

  it('reports exists=false at baseline for a file outside cwd', async () => {
    const outside = join(OUTSIDE, 'report.md')
    writeFileSync(outside, 'content\n')
    assert.deepEqual(await getFileAtBase(INSIDE, outside), { exists: false, content: '' })
  })

  it('returns an empty diff when the outside file no longer exists', async () => {
    // The judgement is pure string math and never touches the filesystem, so
    // the path survives in session history after the file is moved/deleted.
    // The diff must degrade quietly instead of rejecting the request.
    assert.equal(await getFileDiff(INSIDE, join(OUTSIDE, 'gone.md')), '')
  })

  it('still rejects relative traversal outside cwd', async () => {
    await assert.rejects(() => getFileDiff(INSIDE, '../outside.md'), /无效文件路径/)
    await assert.rejects(() => getFileAtBase(INSIDE, '../outside.md'), /无效文件路径/)
  })

  // The out-of-workspace branch must not degenerate into an unbounded text-file
  // read channel (`?path=~/.ssh/id_rsa`). The repository already has an upper
  // bound for out-of-workspace access (request-path-access, issue #117):
  // filesystem/system roots and sensitive filenames are never readable. The
  // diff readers must agree with that single source of truth.
  it('refuses an absolute path under a system root or a sensitive name', async () => {
    const systemFiles = process.platform === 'win32'
      ? ['C:\\Windows\\fixture.txt', 'C:\\Program Files\\fixture.txt', 'C:\\Users\\fixture.txt']
      : ['/etc/passwd']
    const sensitive = [
      join(homedir(), '.ssh', 'id_rsa'),
      join(homedir(), '.env'),
      join(homedir(), 'credentials.json'),
      ...systemFiles,
    ]
    for (const target of sensitive) {
      await assert.rejects(() => getFileDiff(INSIDE, target), /无效文件路径/, `should refuse ${target}`)
      await assert.rejects(() => getFileAtBase(INSIDE, target), /无效文件路径/, `should refuse ${target}`)
    }
  })

  it('still serves a plain absolute path outside cwd (the issue #358 shape)', async () => {
    // Guard-rail regression: the refusal above must not swallow the legitimate
    // outside-workspace write target this fix exists to render.
    const outside = join(OUTSIDE, 'report.md')
    writeFileSync(outside, 'ok\n')
    assert.ok((await getFileDiff(INSIDE, outside)).includes('+ok'))
  })

  // A whole file rendered as additions puts every source line behind a '+'
  // prefix — so a source line that already starts with '++ ' surfaces as
  // '+++ ', indistinguishable from a header by a bare startsWith. Rewriting it
  // as a header silently drops the line from the rendered diff. The header pass
  // must therefore stop at the first hunk marker.
  it('keeps a content line that begins with "++ " intact', async () => {
    const outside = join(OUTSIDE, 'weird.md')
    writeFileSync(outside, '++ not a header\n')
    const diff = await getFileDiff(INSIDE, outside)
    assert.ok(diff.includes('+++ not a header'), `content line mangled into a header:\n${diff}`)
  })

  // 工作区外分支同样有独立读取路径（assertOutsidePathReadable 是纯文件名/
  // 路径字面判断）：staging 区里一个名字无害的硬链接指向敏感文件，
  // resolve() 不解引用，文件名门禁不触发——git diff --no-index 会跟随读出内容。
  it('refuses a hardlink outside cwd even when its own name is innocuous', async () => {
    const target = join(OUTSIDE, 'id_rsa_mock')
    writeFileSync(target, 'POC-SYNTHETIC-SECRET\n')
    const link = join(OUTSIDE, 'staging-notes.txt')
    linkSync(target, link)
    await assert.rejects(() => getFileDiff(INSIDE, link), /无效文件路径/)
  })
})

// v2（认领即租约）：L3 判据的唯一实现点。用非仓库 / 干净 / 脏 / 未跟踪 / 仅目标路径
// 五种形状钉住语义——判错方向会让「自动接管」要么夺走他人未提交的活，要么永不生效。
describe('isPathClean — v2 claim-lease 的工作区干净判据', () => {
  let dir: string

  const initRepo = (): void => {
    execSync('git init', { cwd: dir })
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '._*\n.DS_Store\n')
    execSync('git config user.email "test@test.com"', { cwd: dir })
    execSync('git config user.name "Test"', { cwd: dir })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-ispathclean-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('非仓库 → true（无版本状态需保护，staleness 才是主守卫）', async () => {
    assert.equal(await isPathClean(dir, 'whatever.ts'), true)
  })

  it('已提交且无改动 → true', async () => {
    initRepo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    execSync('git add . && git commit -m init', { cwd: dir })
    assert.equal(await isPathClean(dir, 'a.txt'), true)
  })

  it('有未提交改动 → false', async () => {
    initRepo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    execSync('git add . && git commit -m init', { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'changed')
    assert.equal(await isPathClean(dir, 'a.txt'), false)
  })

  it('未跟踪文件（??）→ false', async () => {
    initRepo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    execSync('git add . && git commit -m init', { cwd: dir })
    writeFileSync(join(dir, 'new.txt'), 'x')
    assert.equal(await isPathClean(dir, 'new.txt'), false)
  })

  it('只对目标路径判定——别的文件的改动不干扰（-uall 限路径的语义）', async () => {
    initRepo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    execSync('git add . && git commit -m init', { cwd: dir })
    writeFileSync(join(dir, 'b.txt'), 'dirty')
    assert.equal(await isPathClean(dir, 'a.txt'), true)
    assert.equal(await isPathClean(dir, 'b.txt'), false)
  })

  // ignored 盲区（2026-10-08 审查实证）：.gitignore 命中的文件（.env、.rivet/plans/*）
  // 旧探测（无 --ignored）恒返回空 → 判干净 → 对方 10 分钟未触碰即被 L2 自动接管并
  // 覆盖，且 checkpoint 快照同盲区、无回滚兜底。ignored 文件天然无 git 保护，存在
  // 即「对方未入版本库的内容」，失效方向选「多问少夺」：命中 `!!` 即不 clean。
  it('ignored 文件（.gitignore 命中且已存在）→ false', async () => {
    initRepo()
    writeFileSync(join(dir, '.gitignore'), '.env\nplans/\n')
    writeFileSync(join(dir, 'a.txt'), 'hello')
    execSync('git add . && git commit -m init', { cwd: dir })
    writeFileSync(join(dir, '.env'), 'KEY=1')
    mkdirSync(join(dir, 'plans'), { recursive: true })
    writeFileSync(join(dir, 'plans', 'p.md'), 'plan')

    assert.equal(await isPathClean(dir, '.env'), false)
    assert.equal(await isPathClean(dir, 'plans/p.md'), false, 'ignored 目录内的文件同样算不干净')
    // 不误伤：未被 ignore 的干净路径、以及根本不存在于工作区的 ignored 路径仍判干净
    assert.equal(await isPathClean(dir, 'a.txt'), true)
    assert.equal(await isPathClean(dir, 'plans/missing.md'), true)
  })

  // Windows 反斜杠盲区（2026-10-08 审查实证）：preWriteClaimPaths 的 norm 只剥 cwd
  // 前缀、保留入参分隔符，Windows 上认领键是 `sub\a.txt` 形；反斜杠在 git 眼里是
  // 转义/字面字符，pathspec 恒不匹配 → 静默恒干净。POSIX 宿主上用词法同形的键
  // 复现：不归一就探测不到真实脏文件。
  it('Windows 反斜杠认领键 → 归一为 POSIX pathspec 后正确探测', async () => {
    initRepo()
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'a.txt'), 'hello')
    execSync('git add . && git commit -m init', { cwd: dir })
    writeFileSync(join(dir, 'sub', 'a.txt'), 'changed')

    assert.equal(await isPathClean(dir, 'sub\\a.txt'), false, '反斜杠键形必须命中真实脏文件')
    assert.equal(await isPathClean(dir, 'sub\\missing.txt'), true)
  })

  // pathspec 字面化（安全审计 2026-11-09 实证）：认领键本身是含 glob/magic
  // 字符的文件名时，旧探测会把模式展开——`foo*` 命中脏的 foo1.txt 而误报
  // 不干净，`:(exclude)*` 则排除一切而误报干净（L3 守卫被绕过）。
  // --literal-pathspecs 后只按字面文件名判定。
  it('glob 文件名按字面判定——同模式的脏文件不干扰', async () => {
    initRepo()
    writeFileSync(join(dir, 'foo1.txt'), 'hello')
    writeFileSync(join(dir, 'foo*'), 'star')
    execSync('git add . && git commit -m init', { cwd: dir })
    writeFileSync(join(dir, 'foo1.txt'), 'changed')

    assert.equal(await isPathClean(dir, 'foo*'), true, '字面文件干净时，同模式脏文件不应干扰')
    writeFileSync(join(dir, 'foo*'), 'changed')
    assert.equal(await isPathClean(dir, 'foo*'), false, '字面文件本身脏时必须判不干净')
  })

  it('pathspec magic 文件名按字面判定——:(exclude) 不再排除一切', async () => {
    initRepo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    writeFileSync(join(dir, ':(exclude)*'), 'magic')
    execSync('git add . && git commit -m init', { cwd: dir })
    writeFileSync(join(dir, ':(exclude)*'), 'changed')

    assert.equal(await isPathClean(dir, ':(exclude)*'), false, 'magic 文件名本身脏时必须判不干净')
    assert.equal(await isPathClean(dir, 'a.txt'), true)
  })
})
