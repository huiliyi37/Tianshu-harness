/**
 * POST /sessions/:id/handoff — 桌面端 /handoff 入口。
 *
 * 契约：
 * - 会话不存在 404、运行中 409；
 * - ok 路径：交接 run 的 prompt 指向项目内 .rivet/HANDOFF.md（工作区内免审批），
 *   并登记 pendingHandoff 归档任务；
 * - run 收尾时 settleHandoffArchive：项目内文档拷贝归档到会话目录
 *   <id>.handoff.md（loadPrevHandoff 注入管线认的位置）+ system 事件 + 清字段；
 * - 文档缺失/陈旧则跳过拷贝，不阻断 done。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { getSessionDir } from '../../agent/session-persist.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  running = false
  lastPrompt = ''
  run(p: string, cb: AgentCallbacks) {
    this.lastPrompt = p
    this.running = true
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  finish() { const r = this.resolveRun; this.resolveRun = undefined; r?.() }
  setActivePlan(_plan: { slug: string; title: string } | null) {}
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
  private resolveRun?: () => void
}

let home: string
let workDir: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rivet-handoff-home-'))
  workDir = mkdtempSync(join(tmpdir(), 'rivet-handoff-work-'))
  process.env.RIVET_SESSION_DIR = join(home, 'sessions')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
  delete process.env.RIVET_SESSION_DIR
})

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: workDir,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

const tick = () => new Promise(r => setTimeout(r, 20))

test('会话不存在 → 404', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions/nope/handoff', {}, AUTH)
  assert.equal(res.status, 404)
})

test('运行中 → 409', async () => {
  const { router } = setup()
  const s = (await router('POST', '/sessions', { cwd: workDir }, AUTH)).body as { id: string }
  const first = await router('POST', `/sessions/${s.id}/handoff`, {}, AUTH)
  assert.equal(first.status, 200)
  const second = await router('POST', `/sessions/${s.id}/handoff`, {}, AUTH)
  assert.equal(second.status, 409)
})

test('交接 run：prompt 指向项目内文档，收尾归档到 <id>.handoff.md', async () => {
  const { manager, agents, router } = setup()
  const s = (await router('POST', '/sessions', { cwd: workDir }, AUTH)).body as { id: string }
  const res = await router('POST', `/sessions/${s.id}/handoff`, { note: '重点记下缓存方案' }, AUTH)
  assert.equal(res.status, 200)

  const agent = agents[0]!
  assert.ok(agent.lastPrompt.includes(join(workDir, '.rivet', 'HANDOFF.md')), 'prompt 含项目内路径')
  assert.match(agent.lastPrompt, /## 任务目标/)
  assert.match(agent.lastPrompt, /用户补充指示：重点记下缓存方案/)

  // 模拟 agent 写出交接文档（晚于登记时间），然后 run 收尾
  mkdirSync(join(workDir, '.rivet'), { recursive: true })
  const srcPath = join(workDir, '.rivet', 'HANDOFF.md')
  writeFileSync(srcPath, '# Handoff 交接内容\n')
  agent.finish()
  await tick()

  const destPath = join(getSessionDir(workDir), `${s.id}.handoff.md`)
  assert.ok(existsSync(destPath), 'run 收尾应归档到会话目录')
  assert.equal(readFileSync(destPath, 'utf-8'), '# Handoff 交接内容\n')

  // handoff_archived 事件可见 + pendingHandoff 已清（再次 handoff 不再 409）
  const events = manager.getEvents(s.id)?.events ?? []
  assert.ok(events.some(e => e.type === 'handoff_archived' && String(e.data.text ?? '').includes('交接文档已写入')), '应有归档确认 handoff_archived 事件')
  const again = await router('POST', `/sessions/${s.id}/handoff`, {}, AUTH)
  assert.equal(again.status, 200, '归档字段已清，可再次发起')
})

test('文档缺失时跳过拷贝，不阻断收尾', async () => {
  const { agents, router } = setup()
  const s = (await router('POST', '/sessions', { cwd: workDir }, AUTH)).body as { id: string }
  await router('POST', `/sessions/${s.id}/handoff`, {}, AUTH)
  agents[0]!.finish() // agent 没写文件就结束（被 abort/失败）
  await tick()
  const destPath = join(getSessionDir(workDir), `${s.id}.handoff.md`)
  assert.ok(!existsSync(destPath), '无文档不产出归档')
})
