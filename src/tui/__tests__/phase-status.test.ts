import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { phaseStatusLabel } from '../phase-status.js'

describe('S3: phaseStatusLabel', () => {
  // --- 已有 phase（必须覆盖，否则被吞）---
  it('maps heartbeat with reason', () => {
    assert.equal(phaseStatusLabel('heartbeat', { reason: 'still working — last activity: read_file (20s ago)' }),
      'still working — last activity: read_file (20s ago)')
  })
  it('maps heartbeat without reason', () => {
    assert.equal(phaseStatusLabel('heartbeat'), 'still working')
  })
  it('maps intent-veto with reason', () => {
    assert.equal(phaseStatusLabel('intent-veto', { reason: 'user vetoed intent' }), 'user vetoed intent')
  })
  it('maps intent-veto without reason', () => {
    assert.equal(phaseStatusLabel('intent-veto'), 'intent vetoed')
  })

  // --- 新增 phase ---
  it('maps preparing', () => {
    assert.equal(phaseStatusLabel('preparing'), 'preparing…')
  })
  it('maps working with reason', () => {
    assert.equal(phaseStatusLabel('working', { reason: 'waiting for first token' }), 'waiting for first token')
  })
  it('maps working without reason', () => {
    assert.equal(phaseStatusLabel('working'), 'working…')
  })
  it('maps tool-hint with tool name', () => {
    assert.equal(phaseStatusLabel('tool-hint', { tool: 'read_file' }), 'preparing read_file…')
  })
  it('maps tool-hint without tool name', () => {
    assert.equal(phaseStatusLabel('tool-hint'), 'preparing…')
  })
  it('maps stop-reason with reason', () => {
    assert.equal(phaseStatusLabel('stop-reason', { reason: '✓ 任务完成（模型主动收尾）' }), '✓ 任务完成（模型主动收尾）')
  })
  it('returns null for stop-reason without a reason', () => {
    assert.equal(phaseStatusLabel('stop-reason'), null)
  })

  // --- convergence-warning：熔断前的 L2 警告梯级必须可见（8396ac51 复盘）---
  it('maps convergence-warning with reason into a visible warning line', () => {
    const label = phaseStatusLabel('convergence-warning', { reason: '收敛检测 L2: execute 阶段 22 轮未收敛 (score=0.31)' })
    assert.ok(label?.includes('无明显进展'), `label should explain the situation: ${label}`)
    assert.ok(label?.includes('自动中断'), 'label should warn about the impending circuit-break')
  })
  it('returns null for convergence-warning without a reason', () => {
    assert.equal(phaseStatusLabel('convergence-warning'), null)
  })

  // --- image-stripped：413/图片被拒剥图后模型看不到图，用户必须知道（issue #94）---
  it('maps image-stripped with a reason into a visible line', () => {
    const label = phaseStatusLabel('image-stripped', {
      reason: '图片已从本次请求移除（2 张）——本轮模型看不到这些图',
    })
    assert.ok(label, 'label must be visible')
    assert.ok(label.includes('图片'), `label should name what was dropped: ${label}`)
  })
  it('returns null for image-stripped without a reason', () => {
    assert.equal(phaseStatusLabel('image-stripped'), null)
  })

  // --- 未知 phase → null（不覆盖 heartbeatStatus）---
  it('returns null for unmapped phases', () => {
    assert.equal(phaseStatusLabel('tianshu-planning'), null)
    assert.equal(phaseStatusLabel('random'), null)
  })
})
