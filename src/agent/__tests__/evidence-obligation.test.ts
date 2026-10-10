/**
 * Wave 1 波末门禁（evidence-driven-agent-reasoning-loop 计划）：
 * - blocked verification 不满足 RED
 * - 失败目标不匹配不满足 RED
 * - 同目标交叉验证关闭存在性义务
 * 外加 reducer 基础契约：稳定 ID、升级阶梯、final 判定、字节稳定投影、
 * EvidenceTracker 验证事件出口、evidence-gate 分类单一事实源。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VerificationMetadata } from '../../tools/types.js'
import {
  applyProbeEvent,
  applyVerificationEvent,
  blockObligation,
  createObligation,
  deriveObligationId,
  emptyObligationStore,
  escalateAction,
  evaluateFinalCandidate,
  hasRedEvidence,
  recordAttempt,
  renderObligationBlock,
  satisfyObligation,
  supersedeOpenObligations,
  upsertObligation,
  type ObligationStore,
} from '../evidence-obligation.js'
import { EvidenceTracker } from '../evidence.js'
import { classifyEvidenceTool } from '../evidence-gate.js'

function verification(over: Partial<VerificationMetadata>): VerificationMetadata {
  return {
    command: 'npx tsx --test src/agent/__tests__/loop.test.ts',
    status: 'passed',
    scope: 'targeted',
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 100,
    ...over,
  }
}

function storeWith(...obs: ReturnType<typeof createObligation>[]): ObligationStore {
  return { obligations: obs }
}

describe('obligation identity (stable, cache-safe)', () => {
  it('same fact → same id regardless of whitespace; different wording → different id', () => {
    const a = deriveObligationId('existence', 'loop.ts   exports   AgentLoop', ['src/agent/loop.ts'])
    const b = deriveObligationId('existence', ' loop.ts exports AgentLoop ', ['src/agent/loop.ts'])
    const c = deriveObligationId('existence', 'AgentLoop is exported from loop.ts', ['src/agent/loop.ts'])
    assert.equal(a, b, 'whitespace-normalized claims converge')
    assert.notEqual(a, c, 'different wording = different obligation (design intent)')
    assert.match(a, /^ob_[0-9a-f]{12}$/, 'no timestamp / random component')
  })

  it('target order and separators do not change the id', () => {
    const a = deriveObligationId('behavior', 'x', ['b.ts', 'a.ts'])
    const b = deriveObligationId('behavior', 'x', ['a.ts', 'b.ts', 'a.ts'])
    assert.equal(a, b)
  })

  it('upsert merges same fact without resetting progress, uplifts risk only', () => {
    let store = upsertObligation(emptyObligationStore(), { family: 'behavior', claim: 'cache resets on boundary', targets: ['src/cache/x.ts'], risk: 'medium' })
    store = recordAttempt(store, store.obligations[0]!.id, { evidenceRef: 'src/cache/x.ts:10' })
    store = upsertObligation(store, { family: 'behavior', claim: 'cache resets on boundary', targets: ['src/cache/x.ts'], risk: 'high' })
    assert.equal(store.obligations.length, 1, 'no duplicate obligation')
    assert.equal(store.obligations[0]!.attempts, 1, 'progress preserved')
    assert.equal(store.obligations[0]!.risk, 'high', 'risk uplifted')
    const again = upsertObligation(store, { family: 'behavior', claim: 'cache resets on boundary', targets: ['src/cache/x.ts'], risk: 'low' })
    assert.equal(again.obligations[0]!.risk, 'high', 'risk never downgrades')
  })
})

describe('escalation ladder (failure is not repeating the same action)', () => {
  it('repeated failure class escalates the required action', () => {
    const ob = createObligation({ family: 'behavior', claim: 'y', targets: ['a.ts'] })
    let store = storeWith(ob)
    store = recordAttempt(store, ob.id, { failureClass: 'test_failure' })
    assert.equal(store.obligations[0]!.requiredAction, 'read_source', 'first failure: no escalation yet')
    store = recordAttempt(store, ob.id, { failureClass: 'test_failure' })
    assert.equal(store.obligations[0]!.requiredAction, 'micro_probe', 'same class twice → escalate read→probe')
  })

  it('two attempts without new evidence escalate; fresh evidence does not', () => {
    const ob = createObligation({ family: 'regression', claim: 'z', targets: ['b.ts'] })
    let store = storeWith(ob)
    store = recordAttempt(store, ob.id, {})
    store = recordAttempt(store, ob.id, {})
    assert.equal(store.obligations[0]!.requiredAction, 'baseline_diff', 'read-only stall routes to baseline diff')

    const ob2 = createObligation({ family: 'existence', claim: 'w', targets: ['c.ts'] })
    let store2 = storeWith(ob2)
    store2 = recordAttempt(store2, ob2.id, { evidenceRef: 'c.ts:1' })
    store2 = recordAttempt(store2, ob2.id, { evidenceRef: 'c.ts:9' })
    assert.equal(store2.obligations[0]!.requiredAction, 'read_source', 'new evidence per attempt: no escalation')
  })

  it('terminal actions map to themselves', () => {
    assert.equal(escalateAction('environment', 'integration_environment'), 'integration_environment')
    assert.equal(escalateAction('delivery', 'targeted_verification'), 'targeted_verification')
  })
})

describe('RED semantics (Wave 1 hard gate cases)', () => {
  const bugfix = createObligation({
    family: 'bugfix',
    claim: 'salvage drops valid findings',
    targets: ['src/agent/work-order.ts'],
    risk: 'high',
  })

  it('blocked verification is an attempt, NOT RED', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'blocked', exitCode: 1, command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      blockedReason: 'invocation_failure',
    }))
    const ob = store.obligations[0]!
    assert.equal(ob.state, 'attempted', 'blocked → attempted, never satisfied')
    assert.equal(hasRedEvidence(ob), false, 'no RED credit from a run that never executed')
    assert.equal(ob.lastFailureClass, 'verification_blocked')
  })

  it('unrelated failure does NOT satisfy RED (target mismatch)', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'failed', failed: 3, exitCode: 1,
      command: 'npx tsx --test src/tui/__tests__/input-line.test.ts',
      targetFiles: ['src/tui/engine/input-line.ts'],
    }))
    const ob = store.obligations[0]!
    assert.equal(hasRedEvidence(ob), false, 'foreign failure is not a reproduction of THIS defect')
    assert.equal(ob.state, 'open', 'unrelated verification does not even count as an attempt on this obligation')
  })

  it('verification with neither command nor resolvedCommand does not throw (2026-08-31 crash)', () => {
    // 2026-08-31 benchmark 实测：验证元数据两个 command 字段都缺时，
    // verificationMatchesTargets 对 undefined.replaceAll 抛 TypeError，
    // 整个会话以 agent_failed 收尾。回归钉死空值防御。
    const bare = verification({}) as unknown as Record<string, unknown>
    delete bare.command
    delete bare.resolvedCommand
    const store = applyVerificationEvent(storeWith(bugfix), bare as unknown as VerificationMetadata)
    assert.equal(store.obligations[0]!.state, 'open', 'no target match, no crash, obligation stays open')
  })

  it('target-matched failure records RED; subsequent matching pass turns GREEN → satisfied', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'failed', failed: 1, exitCode: 1,
      command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      targetFiles: ['src/agent/work-order.ts'],
    }))
    assert.equal(hasRedEvidence(store.obligations[0]!), true, 'RED recorded')
    assert.equal(store.obligations[0]!.state, 'attempted', 'RED alone does not close the obligation')

    store = applyVerificationEvent(store, verification({
      status: 'passed', passed: 5,
      command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      targetFiles: ['src/agent/work-order.ts'],
    }))
    assert.equal(store.obligations[0]!.state, 'satisfied', 'GREEN after RED closes the bugfix obligation')
  })

  it('pass WITHOUT prior RED does not close a bugfix obligation', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'passed', passed: 5,
      command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      targetFiles: ['src/agent/work-order.ts'],
    }))
    assert.notEqual(store.obligations[0]!.state, 'satisfied', 'a passing test cannot prove the defect ever existed')
  })
})

describe('probe accounting (existence / cross-check / lossy)', () => {
  it('cross-tool probe on the same target closes an existence obligation at cross_check stage', () => {
    const ob = createObligation({
      family: 'existence', claim: 'no other caller of frobnicate', targets: ['src/agent/loop.ts'],
      requiredAction: 'cross_check', risk: 'high',
    })
    let store = storeWith(ob)
    store = applyProbeEvent(store, { tool: 'grep', target: 'src/agent/loop.ts' })
    assert.equal(store.obligations[0]!.state, 'attempted', 'first tool: recorded, not closed')
    store = applyProbeEvent(store, { tool: 'grep', target: 'src/agent/loop.ts' })
    assert.notEqual(store.obligations[0]!.state, 'satisfied', 'same tool again is not independent cross-validation')
    store = applyProbeEvent(store, { tool: 'read_file', target: 'src/agent/loop.ts' })
    assert.equal(store.obligations[0]!.state, 'satisfied', 'second DISTINCT tool on same target closes it')
  })

  it('lossy probe cannot close a negative-existence claim; it only builds escalation pressure', () => {
    const ob = createObligation({ family: 'existence', claim: 'symbol X does not exist', targets: ['src/'] })
    let store = storeWith(ob)
    store = applyProbeEvent(store, { tool: 'semantic_search', target: 'src/', lossy: true })
    assert.equal(store.obligations[0]!.state, 'attempted')
    store = applyProbeEvent(store, { tool: 'semantic_search', target: 'src/', lossy: true })
    assert.equal(store.obligations[0]!.requiredAction, 'cross_check', 'repeated lossy_probe escalates read→cross_check')
    assert.notEqual(store.obligations[0]!.state, 'satisfied')
  })

  it('clean read closes a read_source-stage existence obligation', () => {
    const ob = createObligation({ family: 'existence', claim: 'AgentLoop ctor takes deps', targets: ['src/agent/loop.ts'] })
    let store = storeWith(ob)
    store = applyProbeEvent(store, { tool: 'read_file', target: 'src/agent/loop.ts', evidenceRef: 'src/agent/loop.ts:413' })
    assert.equal(store.obligations[0]!.state, 'satisfied')
    assert.ok(store.obligations[0]!.evidenceRefs.includes('src/agent/loop.ts:413'))
  })
})

describe('delivery / blocked / supersede lifecycle', () => {
  it('full-scope pass closes delivery; blocked never does', () => {
    const delivery = createObligation({ family: 'delivery', claim: 'change verified before claiming done', risk: 'high' })
    let store = storeWith(delivery)
    store = applyVerificationEvent(store, verification({ status: 'blocked', command: 'npm test' }))
    assert.equal(store.obligations[0]!.state, 'attempted', 'blocked verification is not delivery proof')
    store = applyVerificationEvent(store, verification({ status: 'passed', scope: 'full', command: 'npm test' }))
    assert.equal(store.obligations[0]!.state, 'satisfied')
  })

  it('blocked obligation can still be satisfied later by real evidence', () => {
    const ob = createObligation({ family: 'environment', claim: 'staging returns 502', risk: 'high' })
    let store = storeWith(ob)
    store = blockObligation(store, ob.id, 'no_staging_access')
    assert.equal(store.obligations[0]!.state, 'blocked')
    store = satisfyObligation(store, ob.id, 'staging-log:502')
    assert.equal(store.obligations[0]!.state, 'satisfied', 'blocked is not a death sentence')
  })

  it('task boundary supersedes open/attempted/blocked but not satisfied history', () => {
    const a = createObligation({ family: 'behavior', claim: 'a' })
    const b = createObligation({ family: 'behavior', claim: 'b' })
    let store = storeWith(a, b)
    store = satisfyObligation(store, a.id, 'x:1')
    store = supersedeOpenObligations(store)
    assert.equal(store.obligations.find(o => o.id === a.id)!.state, 'satisfied')
    assert.equal(store.obligations.find(o => o.id === b.id)!.state, 'superseded')
  })
})

describe('final gate evaluation (high-risk only — low_risk_small_edit_never_gates_final)', () => {
  it('open high-risk obligation → continue_once with the shortest next action', () => {
    const ob = createObligation({ family: 'bugfix', claim: 'fix the crash', targets: ['a.ts'], risk: 'high' })
    const result = evaluateFinalCandidate(storeWith(ob))
    assert.equal(result.verdict, 'continue_once')
    assert.equal(result.nextAction?.action, 'red_reproduction')
    assert.equal(result.nextAction?.obligationId, ob.id)
  })

  it('low/medium obligations never gate natural-finish', () => {
    const low = createObligation({ family: 'existence', claim: 'x', risk: 'low' })
    const medium = createObligation({ family: 'behavior', claim: 'y', risk: 'medium' })
    const result = evaluateFinalCandidate(storeWith(low, medium))
    assert.equal(result.verdict, 'allow')
  })

  it('only blocked high-risk left → honest_blocked (finish allowed, disclosure required)', () => {
    const ob = createObligation({ family: 'environment', claim: 'needs prod logs', risk: 'high' })
    const store = blockObligation(storeWith(ob), ob.id, 'no_access')
    const result = evaluateFinalCandidate(store)
    assert.equal(result.verdict, 'honest_blocked')
    assert.equal(result.blockedDisclosures.length, 1)
  })

  it('satisfied and superseded obligations do not gate', () => {
    const ob = createObligation({ family: 'bugfix', claim: 'fixed', targets: ['a.ts'], risk: 'high' })
    const store = satisfyObligation(storeWith(ob), ob.id, 'green:test')
    assert.equal(evaluateFinalCandidate(store).verdict, 'allow')
  })
})

describe('cache-stable projection', () => {
  it('identical state renders byte-identical output; empty store renders empty string', () => {
    const ob = createObligation({ family: 'behavior', claim: 'boundary compaction preserves anchors', targets: ['src/compact/x.ts'], risk: 'high' })
    const store = recordAttempt(storeWith(ob), ob.id, { evidenceRef: 'src/compact/x.ts:5' })
    const first = renderObligationBlock(store)
    const second = renderObligationBlock({ obligations: [...store.obligations] })
    assert.equal(first, second, 'no timestamps / randomness / unordered sets')
    assert.match(first, /<evidence-obligation count="1">/)
    assert.match(first, /next=read_source/)
    assert.equal(renderObligationBlock(emptyObligationStore()), '')
  })

  it('satisfied obligations leave the projection (attention released)', () => {
    const ob = createObligation({ family: 'existence', claim: 'x', targets: ['a.ts'], risk: 'high' })
    const store = satisfyObligation(storeWith(ob), ob.id, 'a.ts:1')
    assert.equal(renderObligationBlock(store), '')
  })
})

describe('EvidenceTracker verification event outlet (Wave 1 wiring point)', () => {
  it('listener receives every trackVerification; obligation state independent of TDD counter reset', () => {
    const tracker = new EvidenceTracker()
    let store = storeWith(createObligation({
      family: 'bugfix', claim: 'fix parse', targets: ['src/agent/work-order.ts'], risk: 'high',
    }))
    tracker.setVerificationListener(meta => { store = applyVerificationEvent(store, meta) })

    tracker.trackFileModified('src/agent/work-order.ts')
    tracker.trackVerification(verification({
      status: 'blocked', command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
    }))
    assert.equal(tracker.getGateState().editsSinceLastTest, 0, 'TDD counter reset by ANY verification (unchanged behavior)')
    assert.equal(store.obligations[0]!.state, 'attempted', 'obligation NOT cleared by the same event')
    assert.equal(hasRedEvidence(store.obligations[0]!), false)
  })

  it('listener errors never break evidence tracking', () => {
    const tracker = new EvidenceTracker()
    tracker.setVerificationListener(() => { throw new Error('boom') })
    assert.doesNotThrow(() => tracker.trackVerification(verification({})))
    assert.equal(tracker.getState().verifications.length, 1)
  })
})

describe('classifyEvidenceTool (single classification source, evidence-gate migration)', () => {
  it('classifies probes, decisions, and neutral tools', () => {
    assert.equal(classifyEvidenceTool({ tool: 'read_file', target: 'a.ts' }), 'probe')
    assert.equal(classifyEvidenceTool({ tool: 'run_tests', target: 'a.test.ts' }), 'probe')
    assert.equal(classifyEvidenceTool({ tool: 'bash', command: 'npm run typecheck' }), 'probe')
    assert.equal(classifyEvidenceTool({ tool: 'edit_file', target: 'a.ts' }), 'decision')
    assert.equal(classifyEvidenceTool({ tool: 'bash', command: 'rm -rf dist' }), null)
    assert.equal(classifyEvidenceTool({ tool: 'todo_write' }), null)
  })
})

// ── 误告警抑制：文档/配置变更不触发 bugfix RED 义务 ──

import { isDocOrConfigOnly } from '../turn-step-producer.js'

describe('isDocOrConfigOnly', () => {
  it('returns true for all .md files', () => {
    assert.equal(isDocOrConfigOnly(['README.md', 'docs/spec.md']), true)
  })
  it('returns true for .json/.yaml/.toml/.css/.html', () => {
    assert.equal(isDocOrConfigOnly(['config.json', 'theme.css', 'index.html']), true)
  })
  it('returns false for mixed code + doc', () => {
    assert.equal(isDocOrConfigOnly(['src/agent/loop.ts', 'docs/plan.md']), false)
  })
  it('returns false for .ts source files', () => {
    assert.equal(isDocOrConfigOnly(['src/agent/loop.ts']), false)
  })
  it('returns false for empty array', () => {
    assert.equal(isDocOrConfigOnly([]), false)
  })
})

// ── 冗余验证（星河收编 #2）：redundancy 声明义务需 k 个独立证据才关闭 ──

describe('redundant obligations (quorum evidence)', () => {
  const redundant = { family: 'behavior' as const, claim: 'migration is reversible', targets: ['src/db/migrate.ts'], risk: 'high' as const, redundancy: { kind: 'quorum' as const, k: 2 } }

  it('single satisfy does not close a redundant obligation (state stays attempted)', () => {
    let store = upsertObligation(emptyObligationStore(), redundant)
    const id = store.obligations[0]!.id
    store = satisfyObligation(store, id, 'src/db/migrate.test.ts:40')
    const ob = store.obligations[0]!
    assert.notEqual(ob.state, 'satisfied')
    assert.equal(ob.state, 'attempted')
    assert.equal(ob.satisfyCount, 1)
    assert.deepEqual(ob.evidenceRefs, ['src/db/migrate.test.ts:40'])
  })

  it('second satisfy closes the obligation (k=2)', () => {
    let store = upsertObligation(emptyObligationStore(), redundant)
    const id = store.obligations[0]!.id
    store = satisfyObligation(store, id, 'probe-a')
    store = satisfyObligation(store, id, 'probe-b')
    const ob = store.obligations[0]!
    assert.equal(ob.state, 'satisfied')
    assert.equal(ob.satisfyCount, 2)
    assert.deepEqual(ob.evidenceRefs, ['probe-a', 'probe-b'])
  })

  it('duplicate evidence ref does not double-count', () => {
    let store = upsertObligation(emptyObligationStore(), redundant)
    const id = store.obligations[0]!.id
    store = satisfyObligation(store, id, 'probe-a')
    store = satisfyObligation(store, id, 'probe-a')
    const ob = store.obligations[0]!
    // 同一 ref 重复提交只计一次——k=2 未达成，义务不得 satisfied
    assert.equal(ob.satisfyCount, 1)
    assert.equal(ob.state, 'attempted')
    assert.deepEqual(ob.evidenceRefs, ['probe-a'])
    // 第二个独立证据到达才关闭
    store = satisfyObligation(store, id, 'probe-b')
    const ob2 = store.obligations[0]!
    assert.equal(ob2.satisfyCount, 2)
    assert.equal(ob2.state, 'satisfied')
  })

  it('blocked redundant obligation can still be satisfied by real evidence', () => {
    let store = upsertObligation(emptyObligationStore(), redundant)
    const id = store.obligations[0]!.id
    store = blockObligation(store, id, 'no test runner')
    store = satisfyObligation(store, id, 'manual replay log')
    store = satisfyObligation(store, id, 'staging callback')
    assert.equal(store.obligations[0]!.state, 'satisfied')
  })

  it('non-redundant obligations keep single-evidence close semantics', () => {
    let store = upsertObligation(emptyObligationStore(), { family: 'behavior', claim: 'plain claim', risk: 'high' })
    const id = store.obligations[0]!.id
    store = satisfyObligation(store, id, 'probe-a')
    assert.equal(store.obligations[0]!.state, 'satisfied')
  })

  it('upsert without redundancy does not strip an existing redundancy declaration', () => {
    let store = upsertObligation(emptyObligationStore(), redundant)
    const id = store.obligations[0]!.id
    store = upsertObligation(store, { family: 'behavior', claim: 'migration is reversible', targets: ['src/db/migrate.ts'], risk: 'high' })
    const ob = store.obligations.find(o => o.id === id)!
    assert.ok(ob.redundancy)
    assert.equal(ob.redundancy!.k, 2)
  })
})

/**
 * 无出口义务复核补修（2026-10-10；诊断文档《evidence-obligation：两类永不消解的义务》复核后收口）。
 *
 * 实测形态（改前）：`spec-verify-gate-hook` 创建的 external_claim 义务
 * （requiredAction='micro_probe'）经 3 探针 + 3 验证后仍停在 attempted——
 * 探针侧的 micro_probe 分支只记尝试（语义正确：读文件≠写探针），而验证侧
 * 家族白名单不含 external_claim。两条路都断 = 义务永久悬挂在 prompt 里。
 */
describe('无出口义务复核补修（external_claim 核销 / 空 targets 探针）', () => {
  const externalClaim = {
    family: 'external_claim' as const,
    claim: '诊断文档 docs/handoff-2026-10.md 的声明未经独立验证',
    targets: ['docs/handoff-2026-10.md'],
    risk: 'medium' as const,
    requiredAction: 'micro_probe' as const,
  }

  it('external_claim：独立验证能关闭义务——即使验证载体是代码而非被质疑的文档', () => {
    let store = upsertObligation(emptyObligationStore(), externalClaim)
    // 真实核销形态：跑测试。targetFiles 是代码、命令文本不含 doc 路径——
    // 义务问的是「做没做过独立验证」，证据载体与被质疑的文档天然不同轴。
    store = applyVerificationEvent(store, verification({ targetFiles: ['src/agent/loop.ts'] }))
    assert.equal(store.obligations[0]!.state, 'satisfied', '独立验证通过应关闭 external_claim 义务')
    assert.match(store.obligations[0]!.evidenceRefs[0]!, /^verified:/)
  })

  it('external_claim：验证失败/受阻不关闭（只记尝试，与其它家族同构）', () => {
    let failed = applyVerificationEvent(
      upsertObligation(emptyObligationStore(), externalClaim),
      verification({ status: 'failed', targetFiles: ['src/agent/loop.ts'] }),
    )
    assert.equal(failed.obligations[0]!.state, 'attempted')
    let blocked = applyVerificationEvent(
      upsertObligation(emptyObligationStore(), externalClaim),
      verification({ status: 'blocked', targetFiles: ['src/agent/loop.ts'] }),
    )
    assert.equal(blocked.obligations[0]!.state, 'attempted')
  })

  it('空 targets 的义务：任意探针都算相关（与 verification 侧空 targets 语义同向）', () => {
    for (const family of ['existence', 'behavior', 'external_claim'] as const) {
      let store = upsertObligation(emptyObligationStore(), { family, claim: `${family} 空目标`, risk: 'medium' })
      store = applyProbeEvent(store, { tool: 'read_file', target: 'src/foo.ts' })
      assert.equal(store.obligations[0]!.state, 'satisfied', `空 targets 的 ${family} 不应永久悬挂`)
    }
  })

  it('有损探针仍不关闭空 targets 的义务（保守语义不被削弱）', () => {
    let store = upsertObligation(emptyObligationStore(), { family: 'behavior', claim: '空目标', risk: 'medium' })
    store = applyProbeEvent(store, { tool: 'grep', target: 'src/foo.ts', lossy: true })
    assert.equal(store.obligations[0]!.state, 'attempted', '有损观察不能关闭断言')
  })

  it('非空 targets 的匹配语义不变（回归护栏）', () => {
    let hit = applyProbeEvent(
      upsertObligation(emptyObligationStore(), { family: 'existence', claim: 'x', targets: ['src/foo.ts'], risk: 'medium' }),
      { tool: 'read_file', target: 'src/foo.ts' },
    )
    assert.equal(hit.obligations[0]!.state, 'satisfied')
    let miss = applyProbeEvent(
      upsertObligation(emptyObligationStore(), { family: 'existence', claim: 'x', targets: ['src/foo.ts'], risk: 'medium' }),
      { tool: 'read_file', target: 'src/bar.ts' },
    )
    assert.equal(miss.obligations[0]!.state, 'open', '目标不匹配不得误关')
  })
})
