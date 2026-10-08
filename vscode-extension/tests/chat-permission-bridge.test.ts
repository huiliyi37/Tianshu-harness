import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionBridge, levelToMode } from '../src/chat/permission-bridge.ts'
import type { ApprovalMode } from '../src/sidecar/protocol.ts'

// permissionLevel 桥（permission-bridge.ts）：chat UI 的 per-session 权限档位
// （default/assisted/autoApprove/autopilot，经 /yolo 等切换）下行到 sidecar
// 会话 ApprovalMode。状态机（keyed by sidecar sessionId）：
//  - 显式档位变化才动作（幂等：同档位重复同步不再读档/不再调用）
//  - 首次覆盖捕获原档（original），default 还原之并清覆盖
//  - assisted/undefined/未知值完全 no-op（不记忆、不影响覆盖状态）
//  - 还原目标缺失（捕获失败）时 default 不调用

const readOf = (mode: ApprovalMode | undefined, counter?: { n: number }) => async (): Promise<ApprovalMode | undefined> => {
  if (counter) counter.n += 1
  return mode
}

test('levelToMode 映射表：autoApprove/autopilot 覆盖，default 还原，其余 none', () => {
  assert.equal(levelToMode('autoApprove'), 'auto-accept')
  assert.equal(levelToMode('autopilot'), 'dangerously-skip-permissions')
  assert.equal(levelToMode('default'), 'restore')
  assert.equal(levelToMode('assisted'), 'none')
  assert.equal(levelToMode(undefined), 'none')
  assert.equal(levelToMode('whatever'), 'none')
})

test('首次 autoApprove：捕获原档并发出覆盖动作', async () => {
  const bridge = new PermissionBridge()
  const counter = { n: 0 }
  const action = await bridge.sync('s1', 'autoApprove', readOf('manual', counter), async () => {})
  assert.deepEqual(action, { kind: 'set', mode: 'auto-accept' })
  assert.equal(counter.n, 1)
})

test('幂等：同档位连续同步第二次 no-op（不再读档）', async () => {
  const bridge = new PermissionBridge()
  const counter = { n: 0 }
  await bridge.sync('s1', 'autoApprove', readOf('manual', counter), async () => {})
  const again = await bridge.sync('s1', 'autoApprove', readOf('manual', counter), async () => {})
  assert.deepEqual(again, { kind: 'none' })
  assert.equal(counter.n, 1)
})

test('autopilot 映射 skip 档', async () => {
  const bridge = new PermissionBridge()
  const action = await bridge.sync('s1', 'autopilot', readOf('manual'), async () => {})
  assert.deepEqual(action, { kind: 'set', mode: 'dangerously-skip-permissions' })
})

test('default 还原：有覆盖则还原原档；再次 default no-op（覆盖已清）', async () => {
  const bridge = new PermissionBridge()
  await bridge.sync('s1', 'autoApprove', readOf('manual'), async () => {})
  const restore = await bridge.sync('s1', 'default', readOf('manual'), async () => {})
  assert.deepEqual(restore, { kind: 'set', mode: 'manual' })
  const again = await bridge.sync('s1', 'default', readOf('manual'), async () => {})
  assert.deepEqual(again, { kind: 'none' })
})

test('default 无覆盖：no-op 且不读档', async () => {
  const bridge = new PermissionBridge()
  const counter = { n: 0 }
  const action = await bridge.sync('s1', 'default', readOf('manual', counter), async () => {})
  assert.deepEqual(action, { kind: 'none' })
  assert.equal(counter.n, 0)
})

test('覆盖中换档（autoApprove→autopilot）：original 保持最初值，default 还原到最初', async () => {
  const bridge = new PermissionBridge()
  await bridge.sync('s1', 'autoApprove', readOf('manual'), async () => {})
  const swap = await bridge.sync('s1', 'autopilot', readOf('auto-safe'), async () => {})
  assert.deepEqual(swap, { kind: 'set', mode: 'dangerously-skip-permissions' })
  const restore = await bridge.sync('s1', 'default', readOf('auto-safe'), async () => {})
  assert.deepEqual(restore, { kind: 'set', mode: 'manual' })
})

test('assisted/undefined/未知值：完全 no-op，不影响覆盖状态', async () => {
  const bridge = new PermissionBridge()
  await bridge.sync('s1', 'autoApprove', readOf('manual'), async () => {})
  assert.deepEqual(await bridge.sync('s1', 'assisted', readOf('manual'), async () => {}), { kind: 'none' })
  assert.deepEqual(await bridge.sync('s1', undefined, readOf('manual'), async () => {}), { kind: 'none' })
  assert.deepEqual(await bridge.sync('s1', 'bogus', readOf('manual'), async () => {}), { kind: 'none' })
  // 覆盖仍在：同档位 autoApprove 再同步依然幂等（lastSynced 未被弱信号改写）
  assert.deepEqual(await bridge.sync('s1', 'autoApprove', readOf('manual'), async () => {}), { kind: 'none' })
})

test('读当前档失败：覆盖仍生效；还原目标缺失时 default 不调用', async () => {
  const bridge = new PermissionBridge()
  const thrown = async (): Promise<ApprovalMode | undefined> => {
    throw new Error('getSession failed')
  }
  const action = await bridge.sync('s1', 'autoApprove', thrown, async () => {})
  assert.deepEqual(action, { kind: 'set', mode: 'auto-accept' })
  const restore = await bridge.sync('s1', 'default', readOf('manual'), async () => {})
  assert.deepEqual(restore, { kind: 'none' })
})

test('forget 后再同步：重新捕获原档', async () => {
  const bridge = new PermissionBridge()
  const counter = { n: 0 }
  await bridge.sync('s1', 'autoApprove', readOf('manual', counter), async () => {})
  bridge.forget('s1')
  await bridge.sync('s1', 'autoApprove', readOf('auto-safe', counter), async () => {})
  assert.equal(counter.n, 2)
  const restore = await bridge.sync('s1', 'default', readOf('auto-safe'), async () => {})
  assert.deepEqual(restore, { kind: 'set', mode: 'auto-safe' })
})

test('多会话隔离：A 的覆盖不影响 B', async () => {
  const bridge = new PermissionBridge()
  await bridge.sync('A', 'autoApprove', readOf('manual'), async () => {})
  assert.deepEqual(await bridge.sync('B', 'autoApprove', readOf('auto-safe'), async () => {}), { kind: 'set', mode: 'auto-accept' })
  assert.deepEqual(await bridge.sync('A', 'default', readOf('manual'), async () => {}), { kind: 'set', mode: 'manual' })
  assert.deepEqual(await bridge.sync('B', 'default', readOf('auto-safe'), async () => {}), { kind: 'set', mode: 'auto-safe' })
})

test('clearAll：清空全部会话状态（重载路径）', async () => {
  const bridge = new PermissionBridge()
  await bridge.sync('s1', 'autoApprove', readOf('manual'), async () => {})
  bridge.clearAll()
  assert.deepEqual(await bridge.sync('s1', 'autoApprove', readOf('auto-safe'), async () => {}), { kind: 'set', mode: 'auto-accept' })
  assert.deepEqual(await bridge.sync('s1', 'default', readOf('auto-safe'), async () => {}), { kind: 'set', mode: 'auto-safe' })
})
