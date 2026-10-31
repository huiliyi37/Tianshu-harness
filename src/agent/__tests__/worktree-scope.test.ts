import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { materializeScope } from '../worktree-scope.js'

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

function gitOutput(cwd: string, args: string[]): string {
  return git(cwd, args).stdout.trim()
}

describe('materializeScope', () => {
  let repoDir: string
  let wtDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'scope-repo-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const x = 1')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
    wtDir = mkdtempSync(join(tmpdir(), 'scope-wt-'))
    rmSync(wtDir, { recursive: true, force: true })
    git(repoDir, ['worktree', 'add', '-b', 'test-wt', wtDir])
  })

  afterEach(() => {
    try { git(repoDir, ['worktree', 'remove', '--force', wtDir]) } catch {}
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('leaves tracked files alone when already visible in worktree', () => {
    const result = materializeScope(repoDir, wtDir, ['tracked.ts'])
    assert.deepEqual(result, { materialized: [], missing: [], toBeCreated: [] })
  })

  it('copies untracked relative files into worker worktree', () => {
    writeFileSync(join(repoDir, 'plan.md'), '# Plan')

    const result = materializeScope(repoDir, wtDir, ['plan.md'])

    assert.deepEqual(result.materialized, ['plan.md'])
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.toBeCreated, [])
    assert.ok(existsSync(join(wtDir, 'plan.md')))
  })

  it('never writes to a linked worktree\'s SHARED info/exclude (base repo poisoning)', () => {
    // In a linked worktree `--git-path info/exclude` resolves to the MAIN
    // repo's .git/info/exclude. Appending there hides the base repo's own
    // untracked files from git status (session 4df36bcd: new source files
    // vanished from status and were rejected at commit).
    writeFileSync(join(repoDir, 'plan.md'), '# Plan')

    materializeScope(repoDir, wtDir, ['plan.md'])

    const excludePath = gitOutput(wtDir, ['rev-parse', '--git-path', 'info/exclude'])
    const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
    assert.doesNotMatch(content, /\/plan\.md/)
  })

  it('still writes the exclude for a standalone worker repo (private exclude)', () => {
    const cloneDir = mkdtempSync(join(tmpdir(), 'scope-clone-'))
    rmSync(cloneDir, { recursive: true, force: true })
    git(repoDir, ['clone', repoDir, cloneDir])
    try {
      writeFileSync(join(repoDir, 'plan.md'), '# Plan')
      const result = materializeScope(repoDir, cloneDir, ['plan.md'])
      assert.deepEqual(result.materialized, ['plan.md'])
      const rawExcludePath = gitOutput(cloneDir, ['rev-parse', '--git-path', 'info/exclude'])
      const excludePath = rawExcludePath.startsWith('/') ? rawExcludePath : join(cloneDir, rawExcludePath)
      assert.match(readFileSync(excludePath, 'utf-8'), /\/plan\.md/)
      // And the BASE repo's exclude stays clean.
      const baseExclude = join(repoDir, '.git', 'info', 'exclude')
      const baseContent = existsSync(baseExclude) ? readFileSync(baseExclude, 'utf-8') : ''
      assert.doesNotMatch(baseContent, /\/plan\.md/)
    } finally {
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('copies untracked absolute files when they are inside the repo', () => {
    const absolute = join(repoDir, 'docs', 'plan.md')
    mkdirSync(join(repoDir, 'docs'), { recursive: true })
    writeFileSync(absolute, '# Plan')

    const result = materializeScope(repoDir, wtDir, [absolute])

    assert.deepEqual(result.materialized, [join('docs', 'plan.md')])
    assert.ok(existsSync(join(wtDir, 'docs', 'plan.md')))
  })

  it('reports files outside repo as missing', () => {
    // POSIX：/etc/passwd 是根路径下的绝对路径；Windows：解析为「当前盘根下的
    // etc/passwd」——两者都在 repo 外，normalizeScopePath 都应拒绝
    // （win32 跨盘时 relative 返回目标绝对路径，同属 repo 外，一并判 null）。
    const result = materializeScope(repoDir, wtDir, ['/etc/passwd'])
    assert.equal(result.missing.length, 1)
    assert.equal(result.materialized.length, 0)
  })

  it('reports non-existent relative files as toBeCreated (worker will create them)', () => {
    const result = materializeScope(repoDir, wtDir, ['missing.md'])
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.toBeCreated, ['missing.md'])
  })

  it('reports relative traversal entries as missing instead of escaping the repo', () => {
    // repoDir 与 wtDir 同在 tmpdir 下：旧实现把相对路径原样返回，join 后
    // 归一化会把 `../x` 落到 tmpdir，与 basePath 恰好是同一文件而被跳过；
    // 但对嵌套更深的 worker 工作树（.rivet/vsw/<session>），`..` 段数不同
    // 会让两端解析到不同位置。收容必须在 join 之前、按 base 归一化判定。
    const escapeName = `scope-escape-${basename(repoDir)}.txt`
    const escapePath = join(tmpdir(), escapeName)
    writeFileSync(escapePath, 'OUTSIDE')
    try {
      for (const entry of [`../${escapeName}`, `sub/../../${escapeName}`]) {
        const result = materializeScope(repoDir, wtDir, [entry])
        assert.deepEqual(result.missing, [entry])
        assert.deepEqual(result.materialized, [])
        assert.deepEqual(result.toBeCreated, [])
        assert.ok(!existsSync(join(wtDir, escapeName)))
      }
    } finally {
      rmSync(escapePath, { force: true })
    }
  })

  it('does not copy symlinks pointing outside the repo into the worker worktree', () => {
    const target = join(tmpdir(), `scope-link-target-${basename(repoDir)}.txt`)
    writeFileSync(target, 'LINK-TARGET-SECRET')
    symlinkSync(target, join(repoDir, 'evil-link.txt'))
    try {
      const result = materializeScope(repoDir, wtDir, ['evil-link.txt'])
      assert.deepEqual(result.missing, ['evil-link.txt'])
      assert.deepEqual(result.materialized, [])
      assert.ok(!existsSync(join(wtDir, 'evil-link.txt')))
    } finally {
      rmSync(target, { force: true })
    }
  })

  it('still copies symlinks resolving inside the repo', () => {
    writeFileSync(join(repoDir, 'inner.md'), '# Inner')
    symlinkSync(join(repoDir, 'inner.md'), join(repoDir, 'inner-link.md'))

    const result = materializeScope(repoDir, wtDir, ['inner-link.md'])

    assert.deepEqual(result.materialized, ['inner-link.md'])
    assert.equal(readFileSync(join(wtDir, 'inner-link.md'), 'utf-8'), '# Inner')
  })
})
