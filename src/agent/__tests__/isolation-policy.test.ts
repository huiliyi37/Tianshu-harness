import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideWorkspaceIsolation } from '../isolation-policy.js'

// 判定表穷举：sharedWorktreeEnabled × overlapsPrimary × scopeFiles
// 设计意图见 .rivet/plans/worker-isolation-design.md §7 L1。

test('全局隔离关闭 shared 模式时一律 isolated，即使范围非空', () => {
  const d = decideWorkspaceIsolation({ sharedWorktreeEnabled: false, scopeFiles: ['src/a.ts'] })
  assert.equal(d.isolation, 'isolated')
  assert.equal(d.sharedWorkspace, false)
})

test('全局模式缺省（未设置）按隔离处理——保守默认', () => {
  const d = decideWorkspaceIsolation({ scopeFiles: ['src/a.ts'] })
  assert.equal(d.isolation, 'isolated')
  assert.equal(d.sharedWorkspace, false)
})

test('声明与主控重叠 → isolated（审查链路：scope.files 就是被审文件）', () => {
  const d = decideWorkspaceIsolation({
    sharedWorktreeEnabled: true,
    overlapsPrimary: true,
    scopeFiles: ['src/agent/hands-session.ts'],
  })
  assert.equal(d.isolation, 'isolated')
  assert.equal(d.sharedWorkspace, false)
})

test('声明重叠且范围为空 → isolated（重叠信号优先于范围缺失）', () => {
  const d = decideWorkspaceIsolation({ sharedWorktreeEnabled: true, overlapsPrimary: true })
  assert.equal(d.isolation, 'isolated')
})

test('正交分片：显式非重叠声明 + 范围非空 → shared（I3 性能不回退）', () => {
  const d = decideWorkspaceIsolation({
    sharedWorktreeEnabled: true,
    overlapsPrimary: false,
    scopeFiles: ['src/feature/x.ts', 'src/feature/y.ts'],
  })
  assert.equal(d.isolation, 'shared')
  assert.equal(d.sharedWorkspace, true)
})

test('team 分片真实形态：有范围、无重叠声明 → shared', () => {
  // team-plan.ts 的默认写工是 profile 'patcher' + kind 'patch_proposal'，
  // 与审查链路同 profile 同 kind——所以判据不能落在 profile/kind 上，
  // 只能落在"写入对象是否与主控重叠"这个事实上。
  const d = decideWorkspaceIsolation({ sharedWorktreeEnabled: true, scopeFiles: ['src/shard/a.ts'] })
  assert.equal(d.isolation, 'shared')
})

test('无范围声明的写工 → isolated（无法证明与主控不相交）', () => {
  for (const scope of [undefined, [] as string[]]) {
    const d = decideWorkspaceIsolation({ sharedWorktreeEnabled: true, scopeFiles: scope })
    assert.equal(d.isolation, 'isolated', `scope=${JSON.stringify(scope)}`)
  }
})

test('每个判定都带非空 reason（可诊断，不静默）', () => {
  const cases = [
    { sharedWorktreeEnabled: false, scopeFiles: ['a'] },
    { sharedWorktreeEnabled: true, overlapsPrimary: true, scopeFiles: ['a'] },
    { sharedWorktreeEnabled: true, scopeFiles: ['a'] },
    { sharedWorktreeEnabled: true },
  ]
  for (const input of cases) {
    const d = decideWorkspaceIsolation(input)
    assert.ok(d.reason.length > 0, `reason empty for ${JSON.stringify(input)}`)
  }
})
