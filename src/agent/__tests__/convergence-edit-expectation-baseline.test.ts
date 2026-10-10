/**
 * P0 基线（《收敛阶段补修-编辑期待与相位稳定》§1）：锁定修复前的旧行为。
 *
 * 用途：
 * ① P0 证明问题真实可见（旧行为可被测试观察）；
 * ② P4 缺陷还原时作为对照锚点——临时还原修复逻辑后，本组对应断言必须翻红。
 *
 * P1（2026-10-10）已落地：本文件保留为 **required 路径的逐位对照**（editExpectation
 * 缺席 = required——0.30/L2 与 0.95/L0 逐位不变）；not-required/unknown 的新契约
 * 见 convergence-edit-expectation.test.ts。相位往返由 P2 的 work-stage 接管。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateConvergence } from '../convergence-detector.js'
import type { ConvergenceInput } from '../convergence-detector.js'
import { buildStarPhaseContext } from '../perception.js'
import { recentVerification } from '../verification-activity.js'
import type { ToolHistoryEntry } from '../../prompt/volatile.js'

/**
 * §1 探针同款输入：6 条成功非编辑工具（read/grep 各半 → novelty/entropy 满）、
 * 长且互异的文本指纹（producingReport，跳过只读停滞惩罚）、无 no-tool、
 * 无等待/Todo 豁免、outputTokens=0（tokenEfficiency=1）。
 */
function nonEditSignalsBase(): Omit<ConvergenceInput, 'phaseClass'> {
  const history = [
    { tool: 'read_file', status: 'success' as const, target: 'src/a.ts', argsHash: 'h1' },
    { tool: 'grep', status: 'success' as const, target: 'pattern-one', argsHash: 'h2' },
    { tool: 'read_file', status: 'success' as const, target: 'src/b.ts', argsHash: 'h3' },
    { tool: 'grep', status: 'success' as const, target: 'pattern-two', argsHash: 'h4' },
    { tool: 'read_file', status: 'success' as const, target: 'src/c.ts', argsHash: 'h5' },
    { tool: 'grep', status: 'success' as const, target: 'pattern-three', argsHash: 'h6' },
  ]
  const texts = [
    Array.from({ length: 60 }, (_, i) => `alpha${i}`).join(' '),
    Array.from({ length: 60 }, (_, i) => `bravo${i}`).join(' '),
    Array.from({ length: 60 }, (_, i) => `charlie${i}`).join(' '),
  ]
  return {
    turn: 30,
    contextWindow: 200_000,
    recentToolHistory: history,
    evidenceState: {
      filesModified: new Set<string>(),
      filesRead: new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      deliveryStatus: 'unverified' as const,
    },
    toolFingerprints: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
    textFingerprints: texts,
    noToolTurnCount: 0,
    outputTokens: 0,
  }
}

describe('P0 基线：无编辑相位惩罚（待 P1 修复，P4 还原对照）', () => {
  it('同一组非编辑信号：execute=0.30/L2 vs verify=0.95/L0——差异全部来自相位标签', () => {
    const base = nonEditSignalsBase()
    const ex = evaluateConvergence({ ...base, phaseClass: 'execute' })
    const ve = evaluateConvergence({ ...base, phaseClass: 'verify' })

    // 输入事实：editRatio=0，其余六个信号满
    assert.equal(ex.signals.editRatio, 0)
    for (const key of ['targetNovelty', 'toolEntropy', 'errorPenalty', 'tokenEfficiency', 'oscillationPenalty', 'textRepetitionPenalty'] as const) {
      assert.equal(ex.signals[key], 1, `${key} 应为 1（前提出错，基线失效）`)
    }

    // 旧行为：execute 的 editRatio 权重 0.40 落空 → raw 0.60；editRatio<0.1 乘半 → 0.30 → L2
    assert.ok(Math.abs(ex.score - 0.30) < 1e-9, `execute score=${ex.score}（期望 0.30）`)
    assert.equal(ex.level, 2, '无编辑的正常验证轮被压到 L2 —— 问题本体现身')
    // 旧行为：verify 的 editRatio 权重仅 0.05 且无乘半 → 0.95 → L0
    assert.ok(Math.abs(ve.score - 0.95) < 1e-9, `verify score=${ve.score}（期望 0.95）`)
    assert.equal(ve.level, 0)
  })
})

describe('P0 基线：感知链路时间尺度差异（事实锚定）', () => {
  function hist(entries: Array<Partial<ToolHistoryEntry>>): ToolHistoryEntry[] {
    return entries as ToolHistoryEntry[]
  }

  it('isWriting 看整个传入窗口（旧写入不随时间过期）；recentVerification 仅认当前/上一 modelTurn', () => {
    // 第 8 轮发生过写入；第 12 轮时该写入仍在 recentTools/recentToolHistory 窗口里。
    const ctx = buildStarPhaseContext({
      turn: 12,
      maxTurns: 100,
      recentTools: ['read_file', 'read_file', 'write_file'],
      recentToolHistory: hist([
        { tool: 'write_file', status: 'success', target: 'a.ts', modelTurn: 8 },
        { tool: 'read_file', status: 'success', target: 'a.ts', modelTurn: 12 },
      ]),
      modelTurn: 12,
      hasEnteredHighComplexity: false,
    })
    assert.equal(ctx.isWriting, true, '旧写入仍在窗口 → isWriting=true（无时间上限）')
    assert.equal(
      ctx.isRunningTests,
      false,
      '第 8 轮的验证对第 12 轮不可见（recentVerification 只认 11/12）——两信号时间尺度不一致',
    )
  })

  it('recentVerification：仅 modelTurn ∈ {turn-1, turn} 命中，其余过期', () => {
    const history = [
      { verificationAttempted: true, modelTurn: 8 },
      { verificationAttempted: true, modelTurn: 10 },
      { verificationAttempted: true, modelTurn: 11 },
    ]
    assert.equal(recentVerification(history, 10)?.modelTurn, 10, 'turn-1 命中')
    assert.equal(recentVerification(history, 11)?.modelTurn, 11, '当前轮命中')
    assert.equal(recentVerification(history, 13), undefined, '过期验证不命中')
  })
})
