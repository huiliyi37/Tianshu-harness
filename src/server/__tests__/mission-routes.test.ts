import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildMissionRoutes } from '../mission-routes.js'
import { MissionStore, missionProjectId } from '../mission-store.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { Mission } from '../mission-protocol.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  run(_p: string, cb: AgentCallbacks) {
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  listArtifacts() { return [] }
  readArtifact(_id: string) { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
  private resolveRun?: () => void
}

describe('mission-routes + session-manager Mission 关联', () => {
  let dir: string
  let store: MissionStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mission-routes-'))
    store = new MissionStore({ dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const makeManager = () => new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: '/tmp/work',
    missionStore: store,
  })

  const makeRouter = () => createRouter(buildMissionRoutes(store, TOKEN))

  // ── 路由层 ──────────────────────────────────────────────────────────────

  test('未带 token 全部 401（fail-closed）', async () => {
    const router = makeRouter()
    for (const [method, path] of [
      ['GET', '/missions'], ['GET', '/missions/x'],
      ['POST', '/missions/x/archive'], ['POST', '/missions/x/rename'],
    ] as const) {
      const res = await router(method, path, {})
      assert.equal(res.status, 401, `${method} ${path}`)
    }
  })

  test('GET /missions 列表 + ?cwd= 按项目过滤', async () => {
    store.create('/proj-a', '任务A')
    store.create('/proj-b', '任务B')
    const router = makeRouter()
    const all = await router('GET', '/missions', undefined, AUTH)
    assert.equal(all.status, 200)
    assert.equal((all.body as Mission[]).length, 2)
    const filtered = await router('GET', `/missions?cwd=${encodeURIComponent('/proj-a')}`, undefined, AUTH)
    const list = filtered.body as Mission[]
    assert.equal(list.length, 1)
    assert.equal(list[0]!.title, '任务A')
  })

  test('GET /missions/:id 命中与 404', async () => {
    const m = store.create('/p', '任务')
    const router = makeRouter()
    const hit = await router('GET', `/missions/${m.id}`, undefined, AUTH)
    assert.equal(hit.status, 200)
    assert.equal((hit.body as Mission).id, m.id)
    const miss = await router('GET', '/missions/m_nope', undefined, AUTH)
    assert.equal(miss.status, 404)
  })

  test('POST archive 置 archived；POST rename 改标题、空标题 400', async () => {
    const m = store.create('/p', '旧名')
    const router = makeRouter()
    const renamed = await router('POST', `/missions/${m.id}/rename`, { title: ' 新名 ' }, AUTH)
    assert.equal(renamed.status, 200)
    assert.equal((renamed.body as Mission).title, '新名')
    const bad = await router('POST', `/missions/${m.id}/rename`, { title: '  ' }, AUTH)
    assert.equal(bad.status, 400)
    const archived = await router('POST', `/missions/${m.id}/archive`, {}, AUTH)
    assert.equal((archived.body as Mission).state, 'archived')
  })

  // ── createSession 显式路径 ──────────────────────────────────────────────

  test('createSession(title) 自动 getOrCreate Mission 并回写 record.missionId', () => {
    const manager = makeManager()
    const rec = manager.createSession({ cwd: '/proj', title: '修复 SSE 重连' })
    assert.ok(rec.missionId, 'record 应带 missionId')
    const mission = store.get(rec.missionId!)
    assert.equal(mission?.title, '修复 SSE 重连')
    assert.equal(mission?.projectId, missionProjectId('/proj'))
    assert.deepEqual(mission?.sessionIds, [rec.id])
  })

  test('同项目同 title 第二个 session 复用 Mission，sessionIds 追加', () => {
    const manager = makeManager()
    const r1 = manager.createSession({ cwd: '/proj', title: '同一任务' })
    const r2 = manager.createSession({ cwd: '/proj', title: '同一任务' })
    assert.equal(r2.missionId, r1.missionId)
    assert.deepEqual(store.get(r1.missionId!)?.sessionIds, [r1.id, r2.id])
  })

  test('显式传 missionId 直接关联，不新建', () => {
    const manager = makeManager()
    const m = store.create('/proj', '既有任务')
    const rec = manager.createSession({ cwd: '/proj', missionId: m.id })
    assert.equal(rec.missionId, m.id)
    assert.deepEqual(store.get(m.id)?.sessionIds, [rec.id])
    assert.equal(store.list().length, 1)
  })

  test('无 title 无 missionId → 不建 Mission（等待隐式路径）', () => {
    const manager = makeManager()
    const rec = manager.createSession({ cwd: '/proj' })
    assert.equal(rec.missionId, undefined)
    assert.equal(store.list().length, 0)
  })

  test('未注入 missionStore 的 manager 建带 title 会话不写 Mission（旧行为兼容）', () => {
    const manager = new RuntimeSessionManager({
      createAgent: () => new FakeAgent(),
      defaultCwd: '/tmp/work',
    })
    const rec = manager.createSession({ cwd: '/proj', title: '任务' })
    assert.equal(rec.missionId, undefined)
    assert.equal(store.list().length, 0)
  })

  // ── 隐式路径（rev2 — maybeAutoTitle 起标题成功时挂载）────────────────────

  type WithImplicit = {
    attachImplicitMission(s: unknown, title: string): void
    sessions: Map<string, { record: { id: string; missionId?: string; cwd: string } }>
  }

  test('隐式路径：起标题成功 → 恒新建 Mission（同名不去重）', () => {
    const manager = makeManager()
    const r1 = manager.createSession({ cwd: '/proj' })
    const r2 = manager.createSession({ cwd: '/proj' })
    const inner = manager as unknown as WithImplicit
    inner.attachImplicitMission(inner.sessions.get(r1.id), '修复测试失败')
    inner.attachImplicitMission(inner.sessions.get(r2.id), '修复测试失败')
    const m1 = manager.getSession(r1.id)?.missionId
    const m2 = manager.getSession(r2.id)?.missionId
    assert.ok(m1 && m2, '两个会话都应获得 Mission')
    assert.notEqual(m1, m2, '自动标题撞名 ≠ 同一任务')
    assert.deepEqual(store.get(m1!)?.sessionIds, [r1.id])
  })

  test('永久删除只摘掉被删会话；同 Mission 还有会话时保持 active', () => {
    const manager = makeManager()
    const r1 = manager.createSession({ cwd: '/proj', title: '同一任务' })
    const r2 = manager.createSession({ cwd: '/proj', title: '同一任务' })
    assert.equal(manager.archiveSession(r1.id), true)
    assert.deepEqual(store.get(r1.missionId!)?.sessionIds, [r1.id, r2.id], '仅归档不摘除')
    assert.equal(manager.deleteSession(r1.id).ok, true)
    const mission = store.get(r2.missionId!)
    assert.deepEqual(mission?.sessionIds, [r2.id])
    assert.equal(mission?.state, 'active')
  })

  test('永久删除最后一条会话后 Mission 归档且文件仍在', () => {
    const manager = makeManager()
    const rec = manager.createSession({ cwd: '/proj', title: '单独任务' })
    assert.equal(manager.archiveSession(rec.id), true)
    assert.equal(manager.deleteSession(rec.id).ok, true)
    const mission = store.get(rec.missionId!)
    assert.deepEqual(mission?.sessionIds, [])
    assert.equal(mission?.state, 'archived')
  })

  test('record 没有 missionId 时，仍从 sessionIds 反查摘除', () => {
    const manager = makeManager()
    const rec = manager.createSession({ cwd: '/proj' })
    const mission = store.create('/proj', '手工挂上')
    store.addSession(mission.id, rec.id)
    assert.equal(manager.getSession(rec.id)?.missionId, undefined)
    assert.equal(manager.archiveSession(rec.id), true)
    assert.equal(manager.deleteSession(rec.id).ok, true)
    const after = store.get(mission.id)
    assert.deepEqual(after?.sessionIds, [])
    assert.equal(after?.state, 'archived')
  })

  test('隐式路径双检：显式路径已关联的 session 不重复创建', () => {
    const manager = makeManager()
    const rec = manager.createSession({ cwd: '/proj', title: '显式任务' })
    const inner = manager as unknown as WithImplicit
    inner.attachImplicitMission(inner.sessions.get(rec.id), '自动标题')
    assert.equal(manager.getSession(rec.id)?.missionId, rec.missionId)
    assert.equal(store.list().length, 1)
  })
})
