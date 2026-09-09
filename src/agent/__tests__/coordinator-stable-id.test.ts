import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveStableWorkOrderId, deriveWorkOrderId } from '../coordinator.js'

// 回归锚点：议事会(council:seat-*)与 team(team:*)一样，结果绑定依赖
// workOrderId 的稳定推导。若 stableId 只认 team:，council parentTurnId 会
// 回退成 wo_<uuid>，runCouncil 的 result.workOrderId === `council:seat-${seat}`
// 全失配 → 所有席位静默降级为空贡献（虚假绿灯，见 2026-06-19 审查）。
describe('deriveStableWorkOrderId', () => {
  it('team: parentTurnId 稳定化为末两段', () => {
    assert.equal(deriveStableWorkOrderId('team:planner-tianquan'), 'team:planner-tianquan')
    assert.equal(deriveStableWorkOrderId('x:team:T1'), 'team:T1')
  })

  it('council: parentTurnId 稳定化（议事会席位结果绑定依赖此）', () => {
    assert.equal(deriveStableWorkOrderId('council:seat-tianquan'), 'council:seat-tianquan')
    assert.equal(deriveStableWorkOrderId('council:seat-fu'), 'council:seat-fu')
  })

  it('batch: parentTurnId 稳定化（delegate_batch 跨任务 dependsOn 依赖此）', () => {
    // delegate_batch 用 `${toolUseId}:batch:${i}`，dependsOn 解析为 batch:N。
    assert.equal(deriveStableWorkOrderId('tu_x:batch:0'), 'batch:0')
    assert.equal(deriveStableWorkOrderId('tu_x:batch:2'), 'batch:2')
  })

  it('普通 parentTurnId 返回 undefined（调用方回退 wo_<uuid>）', () => {
    assert.equal(deriveStableWorkOrderId('turn-42'), undefined)
    assert.equal(deriveStableWorkOrderId('review:loop'), undefined)
  })
})


describe('deriveWorkOrderId（嵌套批命名空间，P0-4）', () => {
  it('顶层批（depth 0）行为不变：仍是稳定 batch:N', () => {
    assert.equal(deriveWorkOrderId('tu_x:batch:0'), 'batch:0')
    assert.equal(deriveWorkOrderId('tu_x:batch:2', 0), 'batch:2')
  })

  it('嵌套批（depth>0）带工具调用前缀，两个并发嵌套批不再碰撞', () => {
    const a = deriveWorkOrderId('toolu_AAA:batch:0', 1)
    const b = deriveWorkOrderId('toolu_BBB:batch:0', 1)
    assert.equal(a, 'toolu_AAA:batch:0')
    assert.equal(b, 'toolu_BBB:batch:0')
    assert.notEqual(a, b, '不同工具调用的嵌套 batch:0 必须有独立命名空间')
  })

  it('嵌套的 team:/council: 不加命名空间（跨波/重派语义不动）', () => {
    assert.equal(deriveWorkOrderId('x:team:T1', 1), 'team:T1')
    assert.equal(deriveWorkOrderId('council:seat-fu', 2), 'council:seat-fu')
  })

  it('galaxy 形态（stableId 非 batch: 开头）任意深度不变', () => {
    assert.equal(deriveWorkOrderId('batch:tu1-galaxy-0:2r1', 1), 'tu1-galaxy-0:2r1')
  })

  it('普通 parentTurnId 返回 undefined（调用方回退 wo_<uuid>）', () => {
    assert.equal(deriveWorkOrderId('turn-42', 1), undefined)
  })
})
