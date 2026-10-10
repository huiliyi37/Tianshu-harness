import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionStore, missionProjectId } from '../mission-store.js'

describe('mission-store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mission-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const makeStore = (now?: () => number) => new MissionStore({ dir, now })

  describe('missionProjectId', () => {
    it('与桌面端 projectId 算法一致（basename-slug + fnv1a base36 前 6 位）', () => {
      const id = missionProjectId('/Users/x/app/my-proj')
      assert.match(id, /^my-proj-[a-z0-9]{1,6}$/)
    })

    it('尾斜杠归一化后 id 稳定', () => {
      assert.equal(missionProjectId('/a/b/proj'), missionProjectId('/a/b/proj/'))
    })

    it('不同路径同 basename 得到不同 id', () => {
      assert.notEqual(missionProjectId('/a/proj'), missionProjectId('/b/proj'))
    })
  })

  describe('create（隐式路径，恒新建）', () => {
    it('同 cwd 同 title 两次 create 得到两个独立 Mission', () => {
      const store = makeStore()
      const m1 = store.create('/p', '修复测试失败')
      const m2 = store.create('/p', '修复测试失败')
      assert.notEqual(m1.id, m2.id)
      assert.equal(store.list('/p').length, 2)
    })

    it('新 Mission 初始 state=active、sessionIds 为空、title 已 trim', () => {
      const store = makeStore()
      const m = store.create('/p', '  任务 A  ')
      assert.equal(m.state, 'active')
      assert.deepEqual(m.sessionIds, [])
      assert.equal(m.title, '任务 A')
    })
  })

  describe('getOrCreate（显式路径，按 projectId+title 去重）', () => {
    it('同项目同 title（忽略大小写与首尾空白）复用已有 Mission', () => {
      const store = makeStore()
      const m1 = store.getOrCreate('/p', 'Fix SSE Reconnect')
      const m2 = store.getOrCreate('/p', '  fix sse reconnect ')
      assert.equal(m2.id, m1.id)
      assert.equal(store.list('/p').length, 1)
    })

    it('不同项目同 title 各自新建', () => {
      const store = makeStore()
      const m1 = store.getOrCreate('/p1', '同名任务')
      const m2 = store.getOrCreate('/p2', '同名任务')
      assert.notEqual(m1.id, m2.id)
    })

    it('归档的 Mission 不参与去重（重开同名任务是新任务）', () => {
      const store = makeStore()
      const m1 = store.getOrCreate('/p', '任务')
      store.archive(m1.id)
      const m2 = store.getOrCreate('/p', '任务')
      assert.notEqual(m2.id, m1.id)
      assert.equal(m2.state, 'active')
    })

    it('跨实例去重（持久化后新 store 扫描目录仍能命中）', () => {
      const m1 = makeStore().getOrCreate('/p', '任务')
      const m2 = makeStore().getOrCreate('/p', '任务')
      assert.equal(m2.id, m1.id)
    })
  })

  describe('addSession', () => {
    it('追加 session 并更新 updatedAt；幂等不重复', () => {
      let t = 1000
      const store = makeStore(() => t)
      const m = store.create('/p', '任务')
      t = 2000
      const after = store.addSession(m.id, 's1')
      assert.deepEqual(after?.sessionIds, ['s1'])
      assert.equal(after?.updatedAt, 2000)
      const again = store.addSession(m.id, 's1')
      assert.deepEqual(again?.sessionIds, ['s1'])
    })

    it('不存在的 mission 返回 null', () => {
      assert.equal(makeStore().addSession('m_nope', 's1'), null)
    })
  })

  describe('removeSession', () => {
    it('摘除已有 session 并保持其余顺序；更新 updatedAt', () => {
      let t = 1000
      const store = makeStore(() => t)
      const m = store.create('/p', '任务')
      store.addSession(m.id, 's1')
      store.addSession(m.id, 's2')
      store.addSession(m.id, 's3')
      t = 3000
      const after = store.removeSession(m.id, 's1')
      assert.deepEqual(after?.sessionIds, ['s2', 's3'])
      assert.equal(after?.updatedAt, 3000)
      assert.equal(after?.state, 'active', '摘空与否都不在 store 里归档')
    })

    it('不在列表里原样返回，不改 updatedAt', () => {
      let t = 1000
      const store = makeStore(() => t)
      const m = store.create('/p', '任务')
      store.addSession(m.id, 's1')
      const before = store.get(m.id)!
      t = 4000
      const again = store.removeSession(m.id, 's-missing')
      assert.deepEqual(again?.sessionIds, ['s1'])
      assert.equal(again?.updatedAt, before.updatedAt)
    })

    it('摘空后仍是 active', () => {
      const store = makeStore()
      const m = store.create('/p', '任务')
      store.addSession(m.id, 's1')
      const after = store.removeSession(m.id, 's1')
      assert.deepEqual(after?.sessionIds, [])
      assert.equal(after?.state, 'active')
    })

    it('不存在的 mission 返回 null', () => {
      assert.equal(makeStore().removeSession('m_nope', 's1'), null)
    })
  })

  describe('update / archive / list', () => {
    it('update 改 title 持久化，get 回读一致', () => {
      const store = makeStore()
      const m = store.create('/p', '旧名')
      store.update(m.id, { title: '新名' })
      assert.equal(makeStore().get(m.id)?.title, '新名')
    })

    it('archive 置 state=archived', () => {
      const store = makeStore()
      const m = store.create('/p', '任务')
      assert.equal(store.archive(m.id)?.state, 'archived')
    })

    it('list 按 updatedAt 倒序、按 cwd 过滤', () => {
      let t = 1
      const store = makeStore(() => t++)
      store.create('/p1', 'a')
      const b = store.create('/p1', 'b')
      store.create('/p2', 'c')
      const all = store.list()
      assert.equal(all.length, 3)
      const p1 = store.list('/p1')
      assert.deepEqual(p1.map(m => m.title), ['b', 'a'])
      assert.equal(p1[0]!.id, b.id)
    })
  })

  describe('磁盘完整性', () => {
    it('坏 JSON 被隔离（.corrupt-*），不毒化 list', () => {
      const store = makeStore()
      store.create('/p', '好任务')
      writeFileSync(join(dir, 'm_badbad12.json'), '{not json', 'utf-8')
      const fresh = makeStore()
      assert.equal(fresh.list().length, 1)
      const files = readdirSync(dir)
      assert.ok(files.some(f => f.startsWith('m_badbad12.json.corrupt-')))
    })

    it('落盘为合法 JSON 且含全字段', () => {
      const store = makeStore()
      const m = store.create('/p', '任务')
      const raw = JSON.parse(readFileSync(join(dir, `${m.id}.json`), 'utf-8')) as Record<string, unknown>
      assert.equal(raw.id, m.id)
      assert.equal(raw.state, 'active')
      assert.equal(raw.projectId, missionProjectId('/p'))
    })
  })
})
