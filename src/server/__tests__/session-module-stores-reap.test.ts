/**
 * 会话级 module store 收割回归——releaseAgent（归档）与 hardDelete（彻底删除）
 * 两条释放链都必须把五张按 sessionId 键控的表清干净，且不误伤他会在用条目。
 *
 * 病灶：wave-results / wave-gate / plan-store / post-commit-review-pending /
 * skill-gate 五张模块级 Map 只注册不清理（clear* 全仓零生产调用方），死会话
 * 把整波 WorkerResult、计划 JSON、待审集永久钉在进程内；cron 每任务新
 * sessionId，长驻 sidecar 日积月累可达百 MB 级堆增长 + GC 停顿。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager } from '../session-manager.js'
import { setWaveResults, getWaveResults } from '../../agent/wave-results-store.js'
import { setWaveGate, getWaveGate, type WaveGateRecord } from '../../agent/wave-gate.js'
import { storePlan, getStoredPlan } from '../../agent/plan-store.js'
import { addPendingReviewFiles, peekPendingReview, clearPendingReview } from '../../agent/post-commit-review-pending.js'
import { recordSkillInvoked, getInvokedSkills } from '../../agent/skill-gate.js'

function seedSessionStores(id: string): void {
  setWaveResults([{ finding: `result-of-${id}` } as never], id)
  const gate: WaveGateRecord = {
    wave: 0, passed: false, checks: [], changedFiles: [], commands: [], checkedAt: 1,
  }
  setWaveGate(gate, id)
  storePlan(`{"plan":"${id}"}`, id)
  addPendingReviewFiles(id, [`/tmp/${id}.ts`])
  recordSkillInvoked('review', id)
}

function assertAllCleared(id: string): void {
  assert.equal(getWaveResults(id), undefined, 'waveResults 未收割')
  assert.equal(getWaveGate(id), undefined, 'waveGate 未收割')
  assert.equal(getStoredPlan(id), null, 'plan-store 未收割')
  assert.equal(peekPendingReview(id), null, 'post-commit-review-pending 未收割')
  assert.equal(getInvokedSkills(id).size, 0, 'skill-gate 未收割')
}

describe('session module stores reap on release', () => {
  let cwd: string
  let manager: RuntimeSessionManager

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'reap-'))
    manager = new RuntimeSessionManager({
      defaultCwd: cwd,
      // 本套用例不构建 agent（归档/硬删走 s.agent 为 null 的轻量路径）；
      // createAgent 为必填项，真被调用即视为测试假设失效
      createAgent: () => { throw new Error('this test must not build a real agent') },
    })
  })

  after(() => {
    manager.shutdownAll()
    rmSync(cwd, { recursive: true, force: true })
    // 测试卫生：五张表是模块级状态
    clearPendingReview(undefined)
  })

  it('archiveSession（unloadSession → releaseAgent 释放链）收割五张表', () => {
    const rec = manager.createSession({ cwd, title: 'reap-archive' })
    seedSessionStores(rec.id)
    seedSessionStores('sess-survivor')

    assert.ok(manager.archiveSession(rec.id), '归档应成功')

    assertAllCleared(rec.id)
    // 不误伤：其他会话的条目原样保留
    assert.ok(getWaveResults('sess-survivor'))
    assert.ok(getWaveGate('sess-survivor'))
    assert.ok(getStoredPlan('sess-survivor'))
    assert.ok(peekPendingReview('sess-survivor'))
    assert.equal(getInvokedSkills('sess-survivor').size, 1)
    clearPendingReview('sess-survivor')
  })

  it('deleteSession（hardDelete 释放链）收割五张表', () => {
    const rec = manager.createSession({ cwd, title: 'reap-delete' })
    // 上一个用例已把该路径的归档做完——这里重新播种后走 归档→硬删
    seedSessionStores(rec.id)
    assert.ok(manager.archiveSession(rec.id))
    // 归档时已清过一轮；重播种后验证 hardDelete 这条链独立生效
    seedSessionStores(rec.id)
    const deleted = manager.deleteSession(rec.id)
    assert.ok(deleted.ok, '归档会话应可硬删')

    assertAllCleared(rec.id)
  })
})

describe('clearPendingReview 只清目标会话', () => {
  it('A 清理不影响 B', () => {
    addPendingReviewFiles('sess-a', ['/a.ts'])
    addPendingReviewFiles('sess-b', ['/b.ts'])
    clearPendingReview('sess-a')
    assert.equal(peekPendingReview('sess-a'), null)
    assert.ok(peekPendingReview('sess-b'))
    assert.equal(peekPendingReview('sess-b')!.files.has('/b.ts'), true)
    clearPendingReview('sess-b')
  })
})
