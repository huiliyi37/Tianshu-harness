/**
 * issue #223 — `scratchDir` 未校验 → 任意目录删除。
 *
 * `POST /scratch/cleanup` 会递归删除 scratchRoot 的直接子目录，而 scratchRoot
 * 取自这里的 `scratchDir`（scratch-cleanup.ts 的 resolveScratchRoot）。允许它
 * 落在数据根之外 = 任何能写配置的一方都能指定删除目标。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { rivetHome } from '../paths.js'
import { setWorkspaceConfig } from '../workspace-config.js'

/** 每个用例跑在自己的临时数据根里，避免碰真实 config.json。 */
function withTempHome<T>(fn: (home: string) => T): T {
  const prev = process.env.RIVET_HOME
  const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
  process.env.RIVET_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
  }
}

test('scratchDir 落在数据根之外必须被拒（issue #223）', () => {
  withTempHome((home) => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\Temp\\evil-scratch' : '/tmp/evil-scratch'
    assert.throws(() => setWorkspaceConfig({ scratchDir: outside }), /scratchDir/i)
    // `..` 写法同样不能逃出去
    assert.throws(() => setWorkspaceConfig({ scratchDir: join(home, '..', 'escape') }), /scratchDir/i)
  })
})

test('scratchDir 不允许指向数据根本身（issue #223）', () => {
  withTempHome((home) => {
    assert.throws(() => setWorkspaceConfig({ scratchDir: home }), /scratchDir/i)
  })
})

test('scratchDir 落在数据根之内仍然可用（issue #223）', () => {
  withTempHome((home) => {
    const inside = join(home, 'workspace-custom')
    const snap = setWorkspaceConfig({ scratchDir: inside })
    assert.equal(snap.scratchDir, inside)
    assert.equal(rivetHome(), home)
  })
})

test('清除 scratchDir 仍然有效（null / 空串）', () => {
  withTempHome((home) => {
    setWorkspaceConfig({ scratchDir: join(home, 'workspace-custom') })
    assert.equal(setWorkspaceConfig({ scratchDir: null }).scratchDir, null)
    setWorkspaceConfig({ scratchDir: join(home, 'workspace-custom') })
    assert.equal(setWorkspaceConfig({ scratchDir: '   ' }).scratchDir, null)
  })
})

test('defaultDir 指向系统保护目录必须被拒（2026-10-12 审计：已注册工作区投毒）', () => {
  withTempHome(() => {
    const evil = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    assert.throws(() => setWorkspaceConfig({ defaultDir: evil }), /defaultDir/i)
    // 子目录同样不能进 allowlist
    const evilSub = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/ssh'
    assert.throws(() => setWorkspaceConfig({ defaultDir: evilSub }), /defaultDir/i)
    // 大小写 / 尾部斜杠变体同样拦住
    const evilCase = process.platform === 'win32' ? 'c:\\windows\\' : '/ETC/'
    assert.throws(() => setWorkspaceConfig({ defaultDir: evilCase }), /defaultDir/i)
  })
})

test('defaultDir 普通目录仍然可用，null 可清除（2026-10-12 审计）', () => {
  withTempHome(() => {
    // 注意：withTempHome 的目录在 /tmp 下（受保护名单覆盖），故正向用例
    // 取 home 下的路径；校验只看名单不看存在性，无需真实建目录。
    const dir = join(homedir(), `tianshu-audit-proj-${process.pid}`)
    const snap = setWorkspaceConfig({ defaultDir: dir })
    assert.equal(snap.defaultDir, dir)
    assert.equal(setWorkspaceConfig({ defaultDir: null }).defaultDir, null)
  })
})

test('defaultDir 经 symlink 指向系统保护目录必须被拒（审查 M1）', () => {
  // 名单判定只看字面路径 → /Users/.../mylink 不像 /etc，会被放行；
  // 必须 realpath 解析后再判。symlink 建在 home 下（非保护目录），
  // 否则路径本身命中名单，测不出 symlink 语义。
  withTempHome(() => {
    const dir = mkdtempSync(join(homedir(), 'tianshu-audit-link-'))
    const link = join(dir, 'mylink')
    try {
      symlinkSync(process.platform === 'win32' ? 'C:\\Windows' : '/etc', link, process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => setWorkspaceConfig({ defaultDir: link }), /defaultDir/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('defaultDir 指向不存在的路径仍然可用（不做存在性限制）', () => {
  withTempHome(() => {
    const dir = join(homedir(), `tianshu-audit-ghost-${process.pid}`)
    assert.equal(setWorkspaceConfig({ defaultDir: dir }).defaultDir, dir)
    assert.equal(setWorkspaceConfig({ defaultDir: null }).defaultDir, null)
  })
})
