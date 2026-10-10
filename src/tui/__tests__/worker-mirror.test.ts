import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkerMirrorStore, MIRROR_MESSAGE_CAP, MIRROR_WORKER_CAP } from '../worker-mirror.js'
import type { DelegationActivity } from '../../tools/types.js'

function ev(over: Partial<DelegationActivity>): DelegationActivity {
  return { workOrderId: 'wo_1', parentToolId: 'd1', status: 'running', ...over }
}

test('WorkerMirror: text delta 聚合，tool_use 封口成独立消息', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'text', eventDetail: '我先看' }), 1)
  store.apply(ev({ eventKind: 'text', eventDetail: '一下代码' }), 2)
  store.apply(ev({ eventKind: 'tool_use', eventDetail: 'read_file' }), 3)
  store.apply(ev({ eventKind: 'tool_result', eventDetail: 'read_file' }), 4)

  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, 3)
  assert.deepEqual(msgs[0], { kind: 'text', content: '我先看一下代码', at: 1 })
  assert.equal(msgs[1]!.kind, 'tool_use')
  assert.equal(msgs[1]!.content, 'read_file')
  assert.equal(msgs[2]!.kind, 'tool_result')
})

test('WorkerMirror: 进行中的 text 尾巴出现在 getMessages 末尾（未封口）', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'tool_use', eventDetail: 'grep' }), 1)
  store.apply(ev({ eventKind: 'text', eventDetail: '找到了' }), 2)
  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[1]!.kind, 'text')
  assert.equal(msgs[1]!.content, '找到了')
})

test('WorkerMirror: 终态封口 text 并追加 status 消息', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'text', eventDetail: '总结中' }), 1)
  store.apply(ev({ status: 'completed', progressLine: 'all done' }), 2)
  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.content, '总结中')
  assert.equal(msgs[1]!.kind, 'status')
  assert.ok(msgs[1]!.content.includes('completed'))
  assert.ok(msgs[1]!.content.includes('all done'))
})

test('WorkerMirror: thinking/turn 心跳不入镜像', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'thinking', eventDetail: '推理…' }), 1)
  store.apply(ev({ eventKind: 'turn', eventDetail: '1200' }), 2)
  assert.equal(store.getMessages('wo_1').length, 0)
})

test('WorkerMirror: cap 50 — 旧消息滚出', () => {
  const store = new WorkerMirrorStore()
  for (let i = 0; i < MIRROR_MESSAGE_CAP + 10; i++) {
    store.apply(ev({ eventKind: 'tool_use', eventDetail: `tool_${i}` }), i)
  }
  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, MIRROR_MESSAGE_CAP)
  assert.equal(msgs[0]!.content, 'tool_10')
  assert.equal(msgs[msgs.length - 1]!.content, `tool_${MIRROR_MESSAGE_CAP + 9}`)
})

test('WorkerMirror: per-worker 隔离', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ workOrderId: 'a', eventKind: 'tool_use', eventDetail: 'x' }), 1)
  store.apply(ev({ workOrderId: 'b', eventKind: 'tool_use', eventDetail: 'y' }), 1)
  assert.equal(store.getMessages('a').length, 1)
  assert.equal(store.getMessages('b').length, 1)
  assert.equal(store.getMessages('a')[0]!.content, 'x')
})

test('WorkerMirror: 稳定 id 再派发 → 新一轮转录，不续在上一轮后面', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ workOrderId: 'batch:0', eventKind: 'text', eventDetail: '第一轮在看缓存' }), 1)
  store.apply(ev({ workOrderId: 'batch:0', status: 'completed', progressLine: '第一轮结论' }), 2)

  store.apply(ev({ workOrderId: 'batch:0', eventKind: 'text', eventDetail: '第二轮在补测试' }), 10)
  const msgs = store.getMessages('batch:0')
  const joined = msgs.map(m => m.content).join('\n')

  assert.doesNotMatch(joined, /第一轮在看缓存/, '上一轮的转录不得混进本轮')
  assert.doesNotMatch(joined, /第一轮结论/)

  store.apply(ev({ workOrderId: 'batch:0', eventKind: 'tool_use', eventDetail: 'run_tests' }), 11)
  assert.match(store.getMessages('batch:0').map(m => m.content).join('\n'), /第二轮在补测试/)
})

test('WorkerMirror: 同轮内终态重放不清空本轮转录', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ workOrderId: 'batch:0', eventKind: 'text', eventDetail: '本轮正文' }), 1)
  store.apply(ev({ workOrderId: 'batch:0', status: 'completed', progressLine: '结论' }), 2)
  store.apply(ev({ workOrderId: 'batch:0', status: 'completed', progressLine: '结论' }), 3)

  const joined = store.getMessages('batch:0').map(m => m.content).join('\n')
  assert.match(joined, /本轮正文/, '终态重放走的是终态分支，不该被当成新一轮')
})

test('WorkerMirror: worker 记录数封顶 MIRROR_WORKER_CAP — 最旧 worker 淘汰，现存记录不受影响', () => {
  const store = new WorkerMirrorStore()
  const total = MIRROR_WORKER_CAP + 3
  for (let i = 0; i < total; i++) {
    store.apply(ev({ workOrderId: `wo_${i}`, eventKind: 'tool_use', eventDetail: `t${i}` }), i)
  }
  assert.equal(store.has('wo_0'), false, '最旧 worker 镜像应被淘汰')
  assert.equal(store.has('wo_1'), false)
  assert.equal(store.has('wo_2'), false)
  assert.equal(store.has('wo_3'), true, '第 51 条起必须保留')
  assert.equal(store.has(`wo_${total - 1}`), true, '最新 worker 必须保留')
  // 现存记录内容不受淘汰影响
  const last = store.getMessages(`wo_${total - 1}`)
  assert.equal(last.length, 1)
  assert.equal(last[0]!.content, `t${total - 1}`)
  assert.deepEqual(store.getMessages('wo_3').map(m => m.content), ['t3'])
  // 被淘汰的 id 再来事件 → 作为全新记录重建（不复活旧镜像），且仍受封顶约束
  store.apply(ev({ workOrderId: 'wo_0', eventKind: 'tool_use', eventDetail: 'new' }), 999)
  assert.deepEqual(store.getMessages('wo_0').map(m => m.content), ['new'])
  assert.equal(store.has('wo_3'), false, '新建记录触发下一轮最旧淘汰')
})


test('WorkerMirror: concurrent dispatch identities isolate text and late events', () => {
  const store = new WorkerMirrorStore()
  const a = ev({ workOrderId: 'batch:0', dispatchId: 'tool_A:batch:0', eventKind: 'text', eventDetail: 'A text' })
  const b = ev({ workOrderId: 'batch:0', dispatchId: 'tool_B:batch:0', eventKind: 'text', eventDetail: 'B text' })
  store.apply(a); store.apply(b)
  assert.equal(store.getMessages(a.dispatchId!)[0]?.content, 'A text')
  assert.equal(store.getMessages(b.dispatchId!)[0]?.content, 'B text')
  store.apply({ ...a, status: 'completed', eventKind: undefined })
  store.apply({ ...a, eventDetail: 'late A text' })
  assert.equal(store.getMessages(a.dispatchId!)[0]?.content, 'A text')
  assert.equal(store.getMessages(b.dispatchId!)[0]?.content, 'B text')
})
