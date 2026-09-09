/**
 * P4 补线 — real git branch list（3.15 裁剪版：仅端点与列表，#3 worktree
 * round-trip 依赖 main 的 worktreeBaseBranch 建会话能力，3.15 无宿主）。
 *
 * Anti-proof table:
 *   #1 "branches are hardcoded presets" → test 1 reads the real repo.
 *   #2 端点返回真实分支列表（欢迎页 branch picker 数据源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class BranchAgent implements ManagedAgent {
  run(_prompt: string): Promise<void> { return Promise.resolve() }
  finish(): void {}
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  callbacks(_cb: Partial<AgentCallbacks>): void {}
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-branches-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' })
  git(dir, ['branch', 'dev'])
  git(dir, ['branch', 'feature/real-branch'])
  return dir
}

test('#1 real branches come from git, not presets', async () => {
  const dir = initRepo()
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new BranchAgent(), defaultCwd: dir })
    const result = await manager.getGitBranches(dir)
    assert.equal(result.notARepo, false)
    assert.equal(result.current, 'main')
    const names = result.branches.map((b) => b.name)
    assert.ok(names.includes('main'))
    assert.ok(names.includes('dev'))
    assert.ok(names.includes('feature/real-branch'))
    assert.equal(result.branches.find((b) => b.name === 'main')?.current, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#2 GET /git/branches returns the real list', async () => {
  const dir = initRepo()
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new BranchAgent(), defaultCwd: dir })
    const router = createRouter(buildSessionRoutes(manager, TOKEN))
    const res = await router('GET', `/git/branches?cwd=${encodeURIComponent(dir)}`, {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { branches?: Array<{ name: string }> }
    assert.ok((body.branches ?? []).some((b) => b.name === 'feature/real-branch'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#3 GET /git/branches rejects non-directory cwd (no arbitrary-path probing)', async () => {
  const manager = new RuntimeSessionManager({ createAgent: () => new BranchAgent(), defaultCwd: tmpdir() })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  // 不存在路径：修复前 spawnGit 以坏 cwd 启动失败被 catch 吞掉，返回
  // notARepo 而非 4xx——调用者可借此探测任意路径是否是 git 仓库。
  const missing = await router('GET', `/git/branches?cwd=${encodeURIComponent(join(tmpdir(), 'no-such-dir-xyz'))}`, {}, AUTH)
  assert.equal(missing.status, 400)
  // 文件而非目录：同样应拒绝。
  const file = await router('GET', `/git/branches?cwd=${encodeURIComponent(import.meta.url)}`, {}, AUTH)
  assert.equal(file.status, 400)
  // 相对路径：无歧义目录锚点，拒绝。
  const rel = await router('GET', `/git/branches?cwd=${encodeURIComponent('relative/path')}`, {}, AUTH)
  assert.equal(rel.status, 400)
})
