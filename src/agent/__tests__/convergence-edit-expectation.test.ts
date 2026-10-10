/**
 * P1 行为矩阵（《收敛阶段补修》§4 P1 行）：编辑期待投影 × 评分口径。
 *
 * 核心契约：
 * - not-required / unknown：无编辑不再单独把分数压到 L2（错误相位标签不罚正确行为）；
 * - required（缺席默认）：保留原惩罚——"真正需要实施却长期不实施"的正例仍提示；
 * - writeOutcome 三态：changed 计编辑、unchanged 不计、unknown 中性化（不伪造 0/1）；
 * - 重复验证软判据：命中只上探 L2，可被 Todo/等待 veto 压低，不越过等待保护。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateConvergence } from '../convergence-detector.js'
import type { ConvergenceInput } from '../convergence-detector.js'
import type { EditExpectation } from '../edit-expectation.js'

const NOT_REQUIRED: EditExpectation = { kind: 'not-required', source: 'verifying-step', reason: 'test' }
const UNKNOWN: EditExpectation = { kind: 'unknown', source: 'no-classification', reason: 'test' }

/** 与 baseline 同款：6 条成功非编辑工具、六信号满、producingReport。 */
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
      filesRead: new Set(['src/a.ts']),
      deliveryStatus: 'unverified' as const,
    },
    toolFingerprints: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
    textFingerprints: texts,
    noToolTurnCount: 0,
    outputTokens: 0,
  }
}

describe('P1：编辑期待 × 收敛评分', () => {
  it('not-required 时无编辑不再产生 L2（同 baseline 输入，权重归一后满分）', () => {
    const r = evaluateConvergence({ ...nonEditSignalsBase(), phaseClass: 'execute', editExpectation: NOT_REQUIRED })
    assert.ok(Math.abs(r.score - 1.0) < 1e-6, `score=${r.score}（权重归一后应满分）`)
    assert.equal(r.level, 0, '验证/只读步骤不能仅因无编辑被压到 L2')
  })

  it('required（缺席默认）保留原惩罚——正例仍提示', () => {
    const r = evaluateConvergence({ ...nonEditSignalsBase(), phaseClass: 'execute' })
    assert.ok(Math.abs(r.score - 0.30) < 1e-9, `score=${r.score}（旧契约回归）`)
    assert.equal(r.level, 2)
    // 显式 required 与缺席逐位一致
    const explicit = evaluateConvergence({ ...nonEditSignalsBase(), phaseClass: 'execute', editExpectation: { kind: 'required', source: 'task-kind', reason: 't' } })
    assert.equal(explicit.score, r.score)
    assert.equal(explicit.level, r.level)
  })

  it('unknown：不以缺编辑单独认定偏航（不从分数分级），也不冒充只读确认', () => {
    const r = evaluateConvergence({ ...nonEditSignalsBase(), phaseClass: 'execute', editExpectation: UNKNOWN })
    assert.ok(r.score > 0.9, `score=${r.score}（unknown 不被缺编辑压分）`)
    assert.equal(r.level, 0)
  })
})

describe('P1：writeOutcome 三态口径', () => {
  function withWrites(writes: Array<{ writeOutcome?: 'changed' | 'unchanged' | 'unknown'; status?: 'success' | 'failed' }>): Omit<ConvergenceInput, 'phaseClass'> {
    const history = [
      { tool: 'read_file', status: 'success' as const, target: 'src/a.ts', argsHash: 'h1' },
      { tool: 'read_file', status: 'success' as const, target: 'src/b.ts', argsHash: 'h2' },
      ...writes.map((w, i) => ({
        tool: 'edit_file',
        status: w.status ?? ('success' as const),
        target: `src/w${i}.ts`,
        argsHash: `w${i}`,
        ...(w.writeOutcome !== undefined ? { writeOutcome: w.writeOutcome } : {}),
      })),
    ]
    return {
      turn: 30,
      contextWindow: 200_000,
      recentToolHistory: history,
      evidenceState: { filesModified: new Set(['src/w0.ts']), filesRead: new Set(), deliveryStatus: 'unverified' as const },
      noToolTurnCount: 0,
      outputTokens: 0,
    }
  }

  it('changed 计编辑；unchanged（no-op/预览）不计但占分母', () => {
    const r = evaluateConvergence({ ...withWrites([{ writeOutcome: 'unchanged' }, { writeOutcome: 'changed' }]), phaseClass: 'execute' })
    assert.equal(r.signals.editRatio, 1 / 4, '4 条窗口中 1 条 changed')
  })

  it('unknown 效果从分子分母都剔除（不伪造 0/1）；全部不可判时信号不可用（权重处理）', () => {
    const r1 = evaluateConvergence({ ...withWrites([{ writeOutcome: 'unknown' }, { writeOutcome: 'changed' }]), phaseClass: 'execute' })
    assert.equal(r1.signals.editRatio, 1 / 3, 'unknown 条目不占分母：1 / (4-1)')

    const r2 = evaluateConvergence({ ...withWrites([{ writeOutcome: 'unknown' }, { writeOutcome: 'unknown' }]), phaseClass: 'execute' })
    assert.ok(r2.score > 0.9, `score=${r2.score}——全部不可判走权重处理，不拿 0 当证据`)
    assert.equal(r2.level, 0)
  })

  it('无 writeOutcome 的旧条目按旧口径（success 即编辑）——未接线路径逐位不变', () => {
    const r = evaluateConvergence({ ...withWrites([{}, { status: 'failed' }]), phaseClass: 'execute' })
    assert.equal(r.signals.editRatio, 1 / 4, '成功条目计编辑（旧口径）；失败不计')
  })

  it('写工具全族与普通写工具同口径：hash_edit/ast_edit/apply_patch 的真实变化计入编辑（§7 矩阵第 4 行）', () => {
    const base = (toolName: string) => ({
      turn: 30,
      contextWindow: 200_000,
      recentToolHistory: [
        { tool: 'read_file', status: 'success' as const, target: 'src/a.ts', argsHash: 'h1' },
        { tool: 'read_file', status: 'success' as const, target: 'src/b.ts', argsHash: 'h2' },
        { tool: toolName, status: 'success' as const, target: 'src/w.ts', argsHash: 'w1', writeOutcome: 'changed' as const },
      ],
      evidenceState: { filesModified: new Set(['src/w.ts']), filesRead: new Set<string>(), deliveryStatus: 'unverified' as const },
      noToolTurnCount: 0,
      outputTokens: 0,
    })
    const baseline = evaluateConvergence({ ...base('edit_file'), phaseClass: 'execute' }).signals.editRatio
    assert.equal(baseline, 1 / 3, '前置：edit_file 的 changed 计入（1/3）')
    for (const tool of ['write_file', 'hash_edit', 'ast_edit', 'apply_patch']) {
      const r = evaluateConvergence({ ...base(tool), phaseClass: 'execute' })
      assert.equal(r.signals.editRatio, baseline, `${tool} 应与 edit_file 同口径（${r.signals.editRatio} vs ${baseline}）——全族名单回归`)
    }
  })
})

describe('P1：重复验证软判据', () => {
  const base = nonEditSignalsBase()

  it('同一工作版本重复验证 × 无新进展 × 当前仍在重跑 → 上探 L2（只提 L2）', () => {
    const r = evaluateConvergence({
      ...base,
      phaseClass: 'verify',
      repeatedVerification: { count: 2, currentRerun: true, turnsSinceProgress: 20 },
    })
    assert.equal(r.level, 2, '软判据应提出收束/换策略')
    assert.equal(r.shouldAbort, false, '不独立触发 L3')
  })

  it('未达门槛（仅一次/非当前重跑/进展年龄不足）→ 不触发', () => {
    for (const rv of [
      { count: 1, currentRerun: true, turnsSinceProgress: 20 },
      { count: 2, currentRerun: false, turnsSinceProgress: 20 },
      { count: 2, currentRerun: true, turnsSinceProgress: 9 },
    ]) {
      const r = evaluateConvergence({ ...base, phaseClass: 'verify', repeatedVerification: rv })
      assert.equal(r.level, 0, JSON.stringify(rv))
    }
  })

  it('不越过真实等待保护：awaitingVerification veto 仍可压低', () => {
    const r = evaluateConvergence({
      ...base,
      phaseClass: 'verify',
      repeatedVerification: { count: 2, currentRerun: true, turnsSinceProgress: 20 },
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, awaitingVerification: true },
    })
    assert.equal(r.level, 1, '等待保护（cap L1）优先于软判据')
  })

  it('空窗口无有效信号 → scoreQuality=insufficient 且不按分数分级（不补满分/不误伤）', () => {
    const r = evaluateConvergence({
      turn: 40,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: [],
      evidenceState: { filesModified: new Set(), filesRead: new Set(), deliveryStatus: 'unverified' as const },
    })
    assert.equal(r.scoreQuality, 'insufficient')
    assert.equal(r.level, 0)
  })
})
