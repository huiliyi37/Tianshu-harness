import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TurnTimeout } from '../src/chat/turn-timeout.ts'

test('reconnect approval snapshots replace pending count and an empty snapshot resumes the timeout', async () => {
  let expired = 0
  const timeout = new TurnTimeout(20, () => { expired++ })
  try {
    timeout.arm()
    timeout.setPendingApprovals(1)
    timeout.setPendingApprovals(1)
    await new Promise(r => setTimeout(r, 35))
    assert.equal(expired, 0)
    timeout.setPendingApprovals(0)
    await new Promise(r => setTimeout(r, 35))
    assert.equal(expired, 1)
  } finally { timeout.dispose() }
})

// 轮超时的审批豁免守卫（turn-timeout.ts）：TURN_TIMEOUT_MS 的语义是「静默的
// sidecar 不应永远占住聊天视图」，但审批弹窗后的等待是用户在处理、不是 sidecar
// 静默——超时弃轮后用户再点「允许一次」，恢复输出在 participant.dispatch 处因
// activeTurn===undefined 无主被丢（实测断点）。守卫把计时与审批状态联动：
// 审批挂起期间暂停；全部完结后开新的静默窗口。

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('静默窗口到点触发 onTimeout（一次）', async () => {
  let fired = 0
  const t = new TurnTimeout(80, () => { fired += 1 })
  t.arm()
  await sleep(200)
  assert.equal(fired, 1)
  t.dispose()
})

test('审批挂起期间暂停：远超窗口的等待也不触发（核心回归）', async () => {
  let fired = 0
  const t = new TurnTimeout(80, () => { fired += 1 })
  t.arm()
  t.approvalRequired()
  await sleep(200)
  assert.equal(fired, 0)
  t.dispose()
})

test('审批完结后开新窗口：窗口内不触发、窗口外触发', async () => {
  let fired = 0
  const t = new TurnTimeout(80, () => { fired += 1 })
  t.arm()
  t.approvalRequired()
  await sleep(200)
  t.approvalResolved()
  await sleep(40)
  assert.equal(fired, 0)
  await sleep(200)
  assert.equal(fired, 1)
  t.dispose()
})

test('多审批并存：全部完结前不重新计时', async () => {
  let fired = 0
  const t = new TurnTimeout(80, () => { fired += 1 })
  t.arm()
  t.approvalRequired()
  t.approvalRequired()
  t.approvalResolved()
  await sleep(200)
  assert.equal(fired, 0)
  t.approvalResolved()
  await sleep(200)
  assert.equal(fired, 1)
  t.dispose()
})

test('无对应挂起的完结信号：不重置运行中的窗口', async () => {
  let fired = 0
  const t = new TurnTimeout(80, () => { fired += 1 })
  t.arm()
  t.approvalResolved()
  await sleep(60)
  assert.equal(fired, 0)
  await sleep(120)
  assert.equal(fired, 1)
  t.dispose()
})

test('dispose 后不再触发（轮已收束）', async () => {
  let fired = 0
  const t = new TurnTimeout(80, () => { fired += 1 })
  t.arm()
  t.dispose()
  await sleep(200)
  assert.equal(fired, 0)
})

test('pause 幂等：重复暂停不改变状态', async () => {
  let fired = 0
  const t = new TurnTimeout(80, () => { fired += 1 })
  t.arm()
  t.pause()
  t.pause()
  await sleep(200)
  assert.equal(fired, 0)
  t.dispose()
})
