import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { AgentCallbacks } from '../loop-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { WorkStageConfirmInput } from '../work-stage.js'
import type { ConvergenceScoreSample } from '../score-history.js'

/**
 * P3 计时锚与分数历史口径——loop 真实接线回归。
 *
 * 钉三件事：
 * 1. stageAnchorTurnForCooldown：已确认阶段 → WorkStage.enteredModelTurn
 *    （只随确认切换更新）；未确认 → 任务起点；都以跨 run 单调的
 *    modelObservationTurn 计时——新 run 不虚拟重置阶段宽限。
 * 2. 阶段宽限由该锚驱动：刚进入阶段抑制 productiveStagnation，进入多轮后恢复。
 * 3. 分数历史记录带 regimeKey/quality；确认阶段切换不清空历史（"不能用清空
 *    全部历史治抖动"——冷却/台账不被重置）。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-conv-timing-'))

function idleClient(): StreamClient {
  return {
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    },
  } as unknown as StreamClient
}

function makeAgent(): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: idleClient(),
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 40,
    contextWindow: 200_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

const noCallbacks = {} as unknown as AgentCallbacks

/** 全只读 stall 形态：1 条旧 edit（制造有限 distance）+ 20 条读——检测窗口全非产出。
 *  20 ≥ diagnostic 档的 distance 阈值（windowSize×3=18，窗口全只读时 activityMode=diagnostic）。 */
function stallHistory() {
  return [
    { tool: 'edit_file', status: 'success', target: 'src/old.ts' },
    ...Array.from({ length: 20 }, (_, i) => ({ tool: 'read_file', status: 'success', target: `src/f${i}.ts` })),
  ] as unknown as AgentLoop['recentToolHistory']
}

function confirmStage(agent: AgentLoop, atModelTurn: number, over: Partial<WorkStageConfirmInput> = {}) {
  agent.modelObservationTurn = atModelTurn
  agent.workFacts.beginModelTurn(atModelTurn)
  agent.workStage.confirm({
    modelObservationTurn: atModelTurn,
    snapshot: agent.workFacts.currentSnapshot(),
    verificationExecutions: [],
    rawCandidate: 'execute',
    candidateSource: 'sensorium',
    deliveryReady: false,
    ...over,
  })
}

function asSample(entry: unknown): ConvergenceScoreSample {
  assert.ok(entry !== null && typeof entry === 'object' && 'regimeKey' in entry, 'P3：记录侧条目应为带口径样本')
  return entry as ConvergenceScoreSample
}

describe('P3 计时锚与分数历史口径 — loop 接线', () => {
  it('stageAnchorTurnForCooldown：未确认回落任务起点；确认后读 enteredModelTurn', () => {
    const agent = makeAgent()
    // 未确认、无快照 → 回落当前轮（恒定最小宽限）
    agent.modelObservationTurn = 7
    assert.equal(agent.stageAnchorTurnForCooldown(), 7)

    // 任务边界 + 快照 → 任务起点（跨 run 不变——不再随 run 归零）
    agent.workFacts.recordHumanTaskBoundary() // taskStartTurn = 7
    agent.modelObservationTurn = 9
    agent.workFacts.beginModelTurn(9)
    assert.equal(agent.stageAnchorTurnForCooldown(), 7, '未确认阶段时宽限锚 = 任务起点')

    // 确认（provisional）→ 进入阶段的轮（只随确认切换更新）
    confirmStage(agent, 9)
    assert.equal(agent.stageAnchorTurnForCooldown(), 9, '确认后锚 = enteredModelTurn')
  })

  it('阶段宽限由确认锚驱动：刚进入抑制 productiveStagnation，进入多轮后恢复', async () => {
    const recent = await runStallCheck({ anchorModelTurn: 9, currentModelTurn: 10 })
    const stale = await runStallCheck({ anchorModelTurn: 3, currentModelTurn: 10 })
    assert.equal(recent.level, 0, '进入阶段 2 轮内（宽限）→ stagnation 被抑制、turn<8 分数门未开')
    assert.ok(stale.level >= 1, '进入阶段 8 轮（过冷却）→ 恢复停滞检测')
  })

  it('分数历史记录带口径键与质量；确认阶段切换不清空历史（不重置台账）', async () => {
    const agent = makeAgent()
    agent.modelObservationTurn = 5
    agent.workFacts.recordHumanTaskBoundary()
    confirmStage(agent, 6)

    await agent.runConvergenceCheck(5, 'execute', true, false, noCallbacks)
    const first = asSample(agent.convergenceScoreHistory.at(-1))
    assert.ok(typeof first.regimeKey === 'string' && first.regimeKey.length > 0, '条目带口径键')
    assert.equal(first.quality, agent.latestConvergenceResult!.scoreQuality, '质量与 detector 判定同源')
    const firstKey = first.regimeKey

    // 确认阶段切换（deliver 强事实）→ 历史不清空，仅新条目换 regimeKey
    confirmStage(agent, 7, { deliveryReady: true })
    await agent.runConvergenceCheck(6, 'deliver', true, false, noCallbacks)
    assert.equal(agent.convergenceScoreHistory.length, 2, '阶段切换不得清空分数历史')
    assert.equal(agent.convergenceScoreHistory[0], first, '旧条目原地保留（不清台账）')
    const second = asSample(agent.convergenceScoreHistory.at(-1))
    assert.notEqual(second.regimeKey, firstKey, '确认阶段片段变化 → 新条目换口径键（弱候选不切片，确认才切）')
  })

  it('审查修复：帧候选观测三元组同源——候选清空后 candidateSource 不残留（回滚修复必红）', async () => {
    const agent = makeAgent()
    agent.modelObservationTurn = 5
    agent.workFacts.recordHumanTaskBoundary()
    confirmStage(agent, 6) // provisional 初始化 execute（committed 非空、候选为空）
    // 挂起一个与 committed 不同的弱候选（deliver，1 轮）；source 刻意避开默认值以便区分来源。
    confirmStage(agent, 7, { rawCandidate: 'deliver', candidateSource: 'verification-activity' })
    await agent.runConvergenceCheck(6, 'execute', true, false, noCallbacks)
    const held = agent.latestCognitiveFrame?.facts.work
    assert.equal(held?.candidatePhase, 'deliver')
    assert.equal(held?.candidateSource, 'verification-activity', '候选挂起时 source 与候选同源')
    assert.equal(held?.candidateTurns, 1)

    // 候选回到与 committed 一致 → 引擎清空候选；三元组必须同时清空。
    confirmStage(agent, 8, { rawCandidate: 'execute', candidateSource: 'sensorium' })
    await agent.runConvergenceCheck(7, 'execute', true, false, noCallbacks)
    const cleared = agent.latestCognitiveFrame?.facts.work
    assert.equal(cleared?.candidatePhase, null)
    assert.equal(cleared?.candidateSource, null, '候选清空后 source 不残留（审查 finding 1 回归）')
    assert.equal(cleared?.candidateTurns, 0)
  })

  async function runStallCheck(input: { anchorModelTurn: number; currentModelTurn: number }) {
    const agent = makeAgent()
    agent.modelObservationTurn = input.anchorModelTurn
    agent.workFacts.recordHumanTaskBoundary()
    confirmStage(agent, input.anchorModelTurn)
    agent.modelObservationTurn = input.currentModelTurn
    agent.recentToolHistory = stallHistory()
    await agent.runConvergenceCheck(5, 'execute', true, false, noCallbacks)
    const result = agent.latestConvergenceResult
    assert.ok(result, 'runConvergenceCheck 必须装配 latestConvergenceResult')
    return result
  }
})
