/**
 * issue #238 — 运行中排队消息携带附件（与 /prompt 同构）。
 *
 * 装配与 session-routes.test.ts 同源：真实 RuntimeSessionManager + 真实路由，
 * 只把 LLM 侧换成记录型 FakeAgent（不 mock 中间层）。
 * 队列消费走收尾 flush 路径（run settle 后自动起新 run 归并 lane）——与显式
 * 下一条 /prompt 共用 mergeQueuedIntoPrompt 同一实现，且覆盖更严的自动触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, planQueuedImageAllocation, type ManagedAgent } from '../session-manager.js'
import type { PersistedSession, SessionEvent, SessionPersistenceAdapter, SessionRecord } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** 1×1 PNG（与 session-images.test.ts 同源），provider 合法 data URL。 */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PDF_DOC = { name: 'plan.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' }

class RecordingAgent implements ManagedAgent {
  runs: Array<{ prompt: string; images?: string[] }> = []
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  private resolveRun?: () => void

  run(p: string, cb: AgentCallbacks, images?: string[]) {
    this.runs.push(images === undefined ? { prompt: p } : { prompt: p, images })
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  finish() { this.resolveRun?.() }
  enableTool(_name: string) { return { status: 'mounted', cacheImpact: 'none' } as const }
  setActivePlan(_plan: { slug: string; title: string; selectedApproach?: string } | null) {}
  enterPlanMode(_opts?: { planFilePath?: string }) {}
  switchModel(modelId: string): string | null { return modelId }
  getActivePlanFilePath() { return null }
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
  getReasoningEffort() { return undefined }
  setReasoningEffort(_effort: string) {}
}

function setup() {
  const agents: RecordingAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new RecordingAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

/** 起一个运行中的会话，返回 id（首轮 run 挂起中）。 */
async function startBusySession(router: ReturnType<typeof setup>['router']): Promise<string> {
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  assert.equal(created.status, 201)
  return (created.body as { id: string }).id
}

/** run settle 后等收尾 flush 的 setImmediate 链跑完。 */
const settle = () => new Promise((r) => setTimeout(r, 20))

test('queued message carries images into the next run (#238 用例 1)', async () => {
  const { router, agents } = setup()
  const id = await startBusySession(router)

  const queued = await router('POST', `/sessions/${id}/queue`, { text: '看这张图', images: [PNG_1PX] }, AUTH)
  assert.equal(queued.status, 200)

  agents[0]!.finish()
  await settle()

  assert.equal(agents[0]!.runs.length, 2, '收尾 flush 应起新 run 消费 lane')
  const run = agents[0]!.runs[1]!
  assert.match(run.prompt, /看这张图/)
  assert.deepEqual(run.images, [PNG_1PX])
})

test('queued message carries document text, prefixed before its own text (#238 用例 2)', async () => {
  const { router, agents } = setup()
  const id = await startBusySession(router)

  const queued = await router('POST', `/sessions/${id}/queue`, { text: '看这份文档', documents: [PDF_DOC] }, AUTH)
  assert.equal(queued.status, 200)

  agents[0]!.finish()
  await settle()

  const run = agents[0]!.runs[1]!
  const docIdx = run.prompt.indexOf('[document: plan.pdf]')
  const textIdx = run.prompt.indexOf('看这份文档')
  assert.ok(docIdx >= 0, 'prompt 应含文档抽取块')
  assert.ok(textIdx >= 0, 'prompt 应含排队文本')
  assert.ok(docIdx < textIdx, '文档块应排在该条排队文本之前')
})

test('queue rejects when lane image budget would be exceeded (#238 用例 3)', async () => {
  const { router } = setup()
  const id = await startBusySession(router)

  const first = await router('POST', `/sessions/${id}/queue`, { text: '第一批', images: [PNG_1PX, PNG_1PX, PNG_1PX, PNG_1PX] }, AUTH)
  assert.equal(first.status, 200)

  const overflow = await router('POST', `/sessions/${id}/queue`, { text: '再来一张', images: [PNG_1PX] }, AUTH)
  assert.equal(overflow.status, 400)
  assert.match((overflow.body as { error: string }).error, /单轮上限|per-turn limit/)
})

test('steer rejects a lane entry that carries attachments (#238 用例 5)', async () => {
  const { router } = setup()
  const id = await startBusySession(router)

  const queued = await router('POST', `/sessions/${id}/queue`, { text: '带图的排队', images: [PNG_1PX] }, AUTH)
  const laneId = (queued.body as { laneId: string }).laneId

  const steered = await router('POST', `/sessions/${id}/steer`, { laneId }, AUTH)
  assert.equal(steered.status, 409)
  assert.equal((steered.body as { code?: string }).code, 'lane_has_attachments')
})

test('steer rejects inline attachments outright (#238 用例 6)', async () => {
  const { router } = setup()
  const id = await startBusySession(router)

  const steered = await router('POST', `/sessions/${id}/steer`, { text: '插话带图', images: [PNG_1PX] }, AUTH)
  assert.equal(steered.status, 400)
  assert.equal((steered.body as { code?: string }).code, 'attachments_not_steerable')
})

test('planQueuedImageAllocation: 新图优先、排队 FIFO 补足、超出按条目标注 (#238 用例 4)', () => {
  // 本轮新提交 3 张先占额 → 排队 2+2 只有 1 个位置：FIFO 首条保留 1 张，其余 3 张丢弃
  const overlap = planQueuedImageAllocation([2, 2], 3, 4)
  assert.deepEqual(overlap.keepPerEntry, [1, 0])
  assert.deepEqual(overlap.droppedPerEntry, [1, 2])
  assert.equal(overlap.droppedTotal, 3)

  // 无新图 → 排队按 FIFO 吃满配额
  const queuedOnly = planQueuedImageAllocation([2, 3], 0, 4)
  assert.deepEqual(queuedOnly.keepPerEntry, [2, 2])
  assert.deepEqual(queuedOnly.droppedPerEntry, [0, 1])
  assert.equal(queuedOnly.droppedTotal, 1)

  // 新图自己已超配额 → 排队全丢，且不产生负配额
  const promptOver = planQueuedImageAllocation([1], 6, 4)
  assert.deepEqual(promptOver.keepPerEntry, [0])
  assert.deepEqual(promptOver.droppedPerEntry, [1])
  assert.equal(promptOver.droppedTotal, 1)
})

test('并发 /queue 不会把 lane 顶过文档配额（配额判定必须原子）', async () => {
  const { router } = setup()
  const id = await startBusySession(router)
  const doc = (name: string) => ({ name, dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' })

  // 先占 3 个（上限 4）
  const base = await router('POST', `/sessions/${id}/queue`, { text: '基数', documents: [doc('a.pdf'), doc('b.pdf'), doc('c.pdf')] }, AUTH)
  assert.equal(base.status, 200)

  // 并发两条各带 1 个：文档抽取是异步的，路由侧校验与提交之间存在让出点——
  // 只有把权威判定放进 manager.queue（同步）才能保证恰好一条成功。
  const results = await Promise.all([
    router('POST', `/sessions/${id}/queue`, { text: '并发 A', documents: [doc('d.pdf')] }, AUTH),
    router('POST', `/sessions/${id}/queue`, { text: '并发 B', documents: [doc('e.pdf')] }, AUTH),
  ])
  const accepted = results.filter((r) => r.status === 200).length
  assert.equal(accepted, 1, '并发入队必须原子：只剩 1 个文档配额，只能有一条被接受')
  const rejected = results.find((r) => r.status !== 200)!
  assert.equal(rejected.status, 400)
  assert.equal((rejected.body as { code?: string }).code, 'queue_document_budget')
})

// ── 端到端（真实 manager + 真实路由 + 真实持久化，只替 LLM） ──────────────

/** 带图片能力的内存持久化（语义对齐 FileSessionPersistence，不落盘）。 */
class MemoryImagePersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  images = new Map<string, { bytes: Buffer; mime: string }>()
  saveRecord(record: SessionRecord): void { this.records.set(record.id, record) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] { return [] }
  saveImage(sessionId: string, imgId: string, base64: string, mime: string): void {
    this.images.set(`${sessionId}/${imgId}`, { bytes: Buffer.from(base64, 'base64'), mime })
  }
  readImage(sessionId: string, imgId: string) {
    return this.images.get(`${sessionId}/${imgId}`)
  }
}

function setupE2E() {
  const persistence = new MemoryImagePersistence()
  const agents: RecordingAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new RecordingAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    persistence,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router, persistence }
}

type LoggedEvent = { type: string; data: Record<string, unknown> }

async function readEvents(router: ReturnType<typeof setup>['router'], id: string): Promise<LoggedEvent[]> {
  const res = await router('GET', `/sessions/${id}/events?since=0`, {}, AUTH)
  return (res.body as { events: LoggedEvent[] }).events
}

test('端到端：排队附件（1 图 + 1 文档）随收尾 flush 进入 run，图片落盘且事件流契约完整', async () => {
  const { router, agents, persistence } = setupE2E()
  const id = await startBusySession(router)

  const queued = await router(
    'POST',
    `/sessions/${id}/queue`,
    { text: '看这两样', images: [PNG_1PX], documents: [PDF_DOC] },
    AUTH,
  )
  assert.equal(queued.status, 200)

  // 事件流契约（桌面端卡片 chip 的数据源）：只携带计数与文档名，不带 data URL/正文
  const pending = (await readEvents(router, id)).find((e) => e.type === 'queue_pending')
  assert.ok(pending, 'queue_pending 事件应存在')
  assert.equal(pending!.data.imageCount, 1)
  assert.deepEqual(pending!.data.documentNames, ['plan.pdf'])
  assert.equal(
    Object.keys(pending!.data).some((k) => k === 'images' || k === 'attachmentText'),
    false,
    '事件流不得携带 data URL 或文档正文',
  )

  agents[0]!.finish()
  await settle()

  assert.equal(agents[0]!.runs.length, 2, '收尾 flush 应起新 run 消费 lane')
  const run = agents[0]!.runs[1]!
  assert.match(run.prompt, /\[document: plan\.pdf\]/, '文档抽取正文应进 prompt')
  assert.deepEqual(run.images, [PNG_1PX], '排队图片应随该轮 run 发给模型')

  // user 事件 echo 的 imageIds 必须指向已落盘文件（缩略图/回放可读回）
  const userEv = (await readEvents(router, id)).filter((e) => e.type === 'user').pop()!
  assert.equal(userEv.data.imageCount, 1)
  const imageIds = userEv.data.imageIds as string[]
  assert.equal(imageIds.length, 1)
  const stored = persistence.readImage(id, imageIds[0]!)
  assert.ok(stored, 'image 必须已落盘（saveImage 被调用）')
  assert.deepEqual(stored!.bytes, Buffer.from(PNG_1PX.split(',')[1]!, 'base64'))
})

/** 第二张图用 JPEG —— 与 PNG 字节不同，可验证多图时的落盘顺序。 */
const JPEG_1PX =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

test('端到端：多条排队 + 多图时 run.images 与 user 事件 imageIds 逐位对齐（FIFO）', async () => {
  const { router, agents, persistence } = setupE2E()
  const id = await startBusySession(router)

  await router('POST', `/sessions/${id}/queue`, { text: '第一条', images: [PNG_1PX] }, AUTH)
  await router('POST', `/sessions/${id}/queue`, { text: '第二条', images: [JPEG_1PX] }, AUTH)

  agents[0]!.finish()
  await settle()

  const run = agents[0]!.runs[1]!
  assert.deepEqual(run.images, [PNG_1PX, JPEG_1PX], '排队图片按条目 FIFO 顺序进入本轮 run')

  const userEv = (await readEvents(router, id)).filter((e) => e.type === 'user').pop()!
  const imageIds = userEv.data.imageIds as string[]
  assert.equal(imageIds.length, 2)
  // imageIds 必须与 images 同序落盘——错序会让缩略图挂错图
  assert.equal(persistence.readImage(id, imageIds[0]!)!.mime, 'image/png')
  assert.equal(persistence.readImage(id, imageIds[1]!)!.mime, 'image/jpeg')
})

test('空数组附件不触发 steer 的 fail-closed（images: [] 等价于无附件）', async () => {
  const { router } = setup()
  const id = await startBusySession(router)

  const steered = await router('POST', `/sessions/${id}/steer`, { text: '空数组插话', images: [] }, AUTH)
  assert.equal(steered.status, 200, '空数组不该被当作"带附件"拒绝')
})

// 已知盲区（有意不测）：run() 入口归并（session-manager.ts 里 mergeQueuedIntoPrompt
// 的第二个调用点）只在「收尾 flush 让位」的窗口里触发——三条让位条件（watchdog 前缀 /
// archived / running）都无法从外部稳定构造：flush 走 setImmediate，微任务让出后第一个
// 宏任务就是它，抢跑时序在本测试装配里不可靠（实测 manager.run 恒被 running 拒）。
// 该路径的归并本体已由 flush 路径的用例覆盖，未覆盖的仅是「lane 图 + 本轮新图」的拼接与
// 配额截断——其分配规则由 planQueuedImageAllocation 的纯函数矩阵覆盖。

