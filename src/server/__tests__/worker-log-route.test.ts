import { persistWorkerResult } from '../../agent/worker-result-store.js'
import { saveWorkerSession } from '../../agent/worker-session-persist.js'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager } from '../session-manager.js'

/**
 * getWorkerLog(W2 失败钻取):活动流(会话 delegation 事件)+ 终态结果
 * (<RIVET_HOME>/subagents/<orderId>.json)+ 转录尾部(<orderId>.session.jsonl)。
 */
describe('getWorkerLog', () => {
  let dir = ''
  let prevHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-wlog-'))
    prevHome = process.env.RIVET_HOME
    process.env.RIVET_HOME = dir
    mkdirSync(join(dir, 'subagents'), { recursive: true })
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  })

  function makeManager() {
    return new RuntimeSessionManager({
      createAgent: () => { throw new Error('no agent needed for log read') },
      defaultCwd: dir,
      watchdogContinueDelayMs: 0,
    })
  }

  it('会话不存在 → undefined', async () => {
    const manager = makeManager()
    assert.equal(await manager.getWorkerLog('nope', 'wo_x'), undefined)
  })

  it('返回该 worker 的活动流 + 终态结果 + 转录尾部(不含其他 worker)', async () => {
    const manager = makeManager()
    const id = manager.createSession({}).id
    const s = (manager as any).sessions.get(id)
    ;(manager as any).append(s, 'delegation', { workOrderId: 'wo_t1', status: 'running', progressLine: '⚙ read_file src/a.ts' })
    ;(manager as any).append(s, 'delegation', { workOrderId: 'wo_other', status: 'running', progressLine: '别的 worker 不应出现' })
    ;(manager as any).append(s, 'delegation', { workOrderId: 'wo_t1', status: 'failed', failureReason: 'timeout' })

    writeFileSync(join(dir, 'subagents', 'wo_t1.json'), JSON.stringify({
      workOrderId: 'wo_t1',
      status: 'failed',
      summary: 'Worker timed out: budget exhausted',
      risks: ['超出轮次预算'],
      model: 'm1',
      provider: 'p1',
      artifacts: [],
      changedFiles: [],
      nextActions: [],
    }))
    writeFileSync(join(dir, 'subagents', 'wo_t1.session.jsonl'), JSON.stringify({
      workOrderId: 'wo_t1',
      profile: 'reviewer',
      objective: 'review x',
      messages: [
        { role: 'user', content: 'review the diff' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'file body' },
        { role: 'assistant', content: 'final verdict' },
      ],
      savedAt: 123,
    }))

    const log = await manager.getWorkerLog(id, 'wo_t1')
    assert.ok(log)
    assert.ok(log.activity.some(l => l.includes('read_file')), '活动流含 progressLine')
    assert.ok(!log.activity.some(l => l.includes('别的 worker')), '不含其他 worker 的活动')
    assert.equal(log.result?.status, 'failed')
    assert.ok(log.result?.summary?.includes('budget exhausted'))
    assert.equal(log.transcript.length, 4)
    assert.equal(log.transcript[1]?.toolName, 'read_file')
    assert.equal(log.transcript[1]?.text, '', '纯工具调用轮 content=null 不崩溃且为空串')
    assert.equal(log.transcript[3]?.text, 'final verdict')
    assert.equal(log.savedAt, 123)
  })

  it('worker 无存档文件时仍返回(空结果/空转录/空活动)', async () => {
    const manager = makeManager()
    const id = manager.createSession({}).id
    const log = await manager.getWorkerLog(id, 'wo_missing')
    assert.ok(log)
    assert.equal(log.result, null)
    assert.deepEqual(log.transcript, [])
    assert.deepEqual(log.activity, [])
  })

  it('运行中 worker 优先读 coordinator 活转录，陈旧落盘存档被忽略', async () => {
    const manager = makeManager()
    const id = manager.createSession({}).id
    // 同 order id 上一轮 resume 的陈旧存档——活快照在场时不得回落到它。
    writeFileSync(join(dir, 'subagents', 'wo_live.session.jsonl'), JSON.stringify({
      workOrderId: 'wo_live',
      profile: 'code_scout',
      objective: 'x',
      messages: [{ role: 'user', content: 'stale previous run' }],
      savedAt: 1,
    }))
    const live = [
      { role: 'user', content: 'live objective' },
      { role: 'assistant', content: 'working on it right now' },
    ]
    manager.setCoordinatorRef(id, () => ({
      getLiveWorkerMessages: (wid: string) => (wid === 'wo_live' ? live : undefined),
    }) as never)

    const log = await manager.getWorkerLog(id, 'wo_live')
    assert.ok(log)
    assert.equal(log.transcript.length, 2)
    assert.equal(log.transcript[1]?.text, 'working on it right now')
    assert.ok(!log.transcript.some(m => m.text.includes('stale')), '不含陈旧存档内容')
    assert.equal(log.savedAt, null, '活快照不是落盘记录,savedAt 为 null')
  })

  it('coordinator 在场但该 worker 已终态(无活快照) → 回落到落盘存档', async () => {
    const manager = makeManager()
    const id = manager.createSession({}).id
    writeFileSync(join(dir, 'subagents', 'wo_done.session.jsonl'), JSON.stringify({
      workOrderId: 'wo_done',
      profile: 'reviewer',
      objective: 'y',
      messages: [{ role: 'assistant', content: 'persisted verdict' }],
      savedAt: 456,
    }))
    manager.setCoordinatorRef(id, () => ({
      getLiveWorkerMessages: () => undefined,
    }) as never)

    const log = await manager.getWorkerLog(id, 'wo_done')
    assert.ok(log)
    assert.equal(log.transcript.length, 1)
    assert.equal(log.transcript[0]?.text, 'persisted verdict')
    assert.equal(log.savedAt, 456)
  })

  it('dispatch-selected log isolates concurrent activity, archived results and transcript', async () => {
    const manager = makeManager(), id = manager.createSession({}).id
    const session = (manager as any).sessions.get(id)
    for (const batch of ['A', 'B']) {
      const dispatchId = `tool_${batch}:batch:0`, attemptId = batch, nonce = `nonce${batch}`
      ;(manager as any).emitDelegationActivity(session, { workOrderId: 'batch:0', dispatchId, attemptId, status: 'completed', progressLine: `${batch} activity` })
      persistWorkerResult({ workOrderId: 'batch:0', dispatchId, attemptId, status: 'passed', summary: `${batch} result`,
        findings: [], changedFiles: [], artifacts: [], risks: [], nextActions: [], evidenceStatus: 'unverified' }, undefined, nonce)
      saveWorkerSession('batch:0', 'code_scout', batch, [{ role: 'assistant', content: `${batch} transcript` }], undefined, undefined, undefined, nonce)
    }
    const a = await manager.getWorkerLog(id, 'batch:0', { dispatchId: 'tool_A:batch:0', attemptId: 'A' })
    assert.deepEqual(a?.activity, ['A activity'])
    assert.equal(a?.result?.summary, 'A result')
    assert.equal(a?.transcript[0]?.text, 'A transcript')
    assert.deepEqual(a?.rounds.map(r => r.nonce), ['nonceA'])
    const unknown = await manager.getWorkerLog(id, 'batch:0', { dispatchId: 'missing' })
    assert.equal(unknown?.result, null)
    assert.deepEqual(unknown?.activity, [])
    assert.deepEqual(unknown?.transcript, [])
    const stub = { getLiveWorkerMessages: (target: string) => target === 'tool_A:batch:0' ? [] : undefined }
    ;(manager as any).coordinatorBySession.set(id, () => stub)
    const emptyLive = await manager.getWorkerLog(id, 'batch:0', { dispatchId: 'tool_A:batch:0' })
    assert.deepEqual(emptyLive?.transcript, [], 'empty active snapshot must not expose stale disk history')
  })

})
