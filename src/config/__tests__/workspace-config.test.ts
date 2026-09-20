/**
 * issue #223 — `scratchDir` 未校验 → 任意目录删除。
 *
 * `POST /scratch/cleanup` 会递归删除 scratchRoot 的直接子目录，而 scratchRoot
 * 取自这里的 `scratchDir`（scratch-cleanup.ts 的 resolveScratchRoot）。允许它
 * 落在数据根之外 = 任何能写配置的一方都能指定删除目标。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
