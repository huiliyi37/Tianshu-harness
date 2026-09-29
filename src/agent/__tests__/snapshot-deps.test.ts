import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { provisionSnapshotDeps, isWorkspaceRepo } from '../snapshot-deps.js'

const tempDirs: string[] = []

function makeBaseAndWorktree(): { base: string; wt: string } {
  const base = mkdtempSync(join(tmpdir(), 'snapdeps-base-'))
  const wt = mkdtempSync(join(tmpdir(), 'snapdeps-wt-'))
  tempDirs.push(base, wt)
  return { base, wt }
}

/** 环境能否创建目录符号链接——Windows 无开发者模式/特权时 EPERM。
 *  生产逻辑对失败已有 'error'+warning 兜底；能力缺席时测试跳过断言。 */
function canSymlinkDir(dir: string): boolean {
  const probe = join(dir, '.symlink-probe')
  try {
    symlinkSync(dir, probe, 'dir')
    rmSync(probe, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('snapshot-deps — dependency provisioner', () => {
  it('symlinks node_modules from the base repo into the worktree', (t) => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(base, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    if (!canSymlinkDir(wt)) {
      t.skip('当前环境不允许创建符号链接（Windows 无特权/开发者模式）')
      return
    }

    const result = provisionSnapshotDeps(base, wt)

    const nm = result.links.find(l => l.name === 'node_modules')
    assert.equal(nm?.status, 'linked')
    assert.ok(lstatSync(join(wt, 'node_modules')).isSymbolicLink(), 'should be a symlink')
    // Resolves through the symlink to the real tree.
    assert.ok(existsSync(join(wt, 'node_modules', 'left-pad', 'index.js')))
    assert.equal(result.installCommand, undefined)
  })

  it('reports source-absent when the base repo has no node_modules', () => {
    const { base, wt } = makeBaseAndWorktree()
    const result = provisionSnapshotDeps(base, wt)
    assert.equal(result.links.find(l => l.name === 'node_modules')?.status, 'source-absent')
    assert.equal(result.links.find(l => l.name === '.venv')?.status, 'source-absent')
  })

  it('symlinks an existing .venv', (t) => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, '.venv', 'bin'), { recursive: true })
    if (!canSymlinkDir(wt)) {
      t.skip('当前环境不允许创建符号链接（Windows 无特权/开发者模式）')
      return
    }
    const result = provisionSnapshotDeps(base, wt)
    assert.equal(result.links.find(l => l.name === '.venv')?.status, 'linked')
    assert.ok(lstatSync(join(wt, '.venv')).isSymbolicLink())
  })

  it('skips node_modules symlink for a pnpm workspace and recommends install', () => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, 'node_modules'), { recursive: true })
    writeFileSync(join(base, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')

    assert.equal(isWorkspaceRepo(base), true)
    const result = provisionSnapshotDeps(base, wt)

    assert.equal(result.links.find(l => l.name === 'node_modules')?.status, 'skipped-workspace')
    assert.equal(existsSync(join(wt, 'node_modules')), false, 'no wrong single symlink for workspace')
    assert.deepEqual(result.installCommand, ['pnpm', 'install', '--frozen-lockfile'])
    assert.ok(result.warnings.some(w => w.includes('Workspace')))
  })

  it('skips when the target already exists in the worktree', () => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, 'node_modules'), { recursive: true })
    mkdirSync(join(wt, 'node_modules'), { recursive: true })
    const result = provisionSnapshotDeps(base, wt)
    assert.equal(result.links.find(l => l.name === 'node_modules')?.status, 'skipped-exists')
  })
})
