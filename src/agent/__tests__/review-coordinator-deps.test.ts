import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCoordinatorReviewDeps, formatFinding, type ReviewCoordinator } from '../review-coordinator-deps.js'
import type { CoordinatorRun, DelegationRequest } from '../coordinator.js'
import type { WorkerResult } from '../work-order.js'

function worker(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-test',
    status: 'passed',
    summary: 'verified with tests',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...overrides,
  }
}

function run(results: WorkerResult[], status: CoordinatorRun['status'] = 'completed'): CoordinatorRun {
  return {
    status,
    results,
    packet: results.map(result => result.summary).join('\n'),
  }
}

describe('createCoordinatorReviewDeps', () => {
  it('spawns adversarial verifier with review-depth guard and maps verified evidence', async () => {
    let captured: DelegationRequest | undefined
    const coordinator: ReviewCoordinator = {
      delegate: async request => {
        captured = request
        return run([worker({
          verification: {
            command: 'npm exec -- tsx --test src/agent/__tests__/deliver-task.test.ts',
            status: 'passed',
            scope: 'targeted',
            exitCode: 0,
            passed: 61,
            failed: 0,
            skipped: 0,
            durationMs: 537,
          },
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator, { parentTurnId: 'turn-1', reviewDepth: 2 })
    const result = await deps.spawnVerifier({ files: ['src/agent/deliver-task.ts'], crossModule: false, isFix: true })

    assert.equal(captured?.parentTurnId, 'turn-1')
    assert.equal(captured?.profile, 'adversarial_verifier')
    assert.equal(captured?.kind, 'verify')
    assert.equal(captured?.reviewDepth, 3)
    assert.deepEqual(captured?.scope.files, ['src/agent/deliver-task.ts'])
    assert.match(captured?.objective ?? '', /审查深度: 3/)
    assert.match(captured?.objective ?? '', /审查 worker 不得调用 deliver_task/)
    assert.match(captured?.objective ?? '', /客观审查姿态/)
    assert.match(captured?.objective ?? '', /主动构造反例/)
    assert.match(captured?.objective ?? '', /数据流验证姿态/)
    assert.match(captured?.objective ?? '', /事实流图/)
    assert.match(captured?.objective ?? '', /条件矩阵/)
    assert.match(captured?.objective ?? '', /清单式实现/)
    assert.match(captured?.objective ?? '', /路径边界\/注意力门控审查姿态/)
    assert.match(captured?.objective ?? '', /repo-relative.*absolute inside cwd.*absolute outside cwd.*\.\.\/ traversal/)
    assert.match(captured?.objective ?? '', /producer.*normalizer.*classifier.*consumer.*DB key.*assertion/)
    assert.match(captured?.objective ?? '', /显式目标.*默认发现/)
    assert.match(captured?.objective ?? '', /接线有效性审查姿态/)
    assert.match(captured?.objective ?? '', /零传值=死参数/)
    assert.match(captured?.objective ?? '', /双渲染/)
    assert.match(captured?.objective ?? '', /~0%.*静默关闭/)
    assert.match(captured?.objective ?? '', /不要止步于测试绿/)
    assert.equal(result.verdict, 'verified')
    assert.match(result.evidence, /ran: npm exec -- tsx --test/)
    assert.match(result.evidence, /61 passed/)
  })

  it('maps unverified verifier result to rejected', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([worker({ evidenceStatus: 'unverified', summary: 'read code only' })]),
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnVerifier({ files: ['src/a.ts'], crossModule: false, isFix: true })

    assert.equal(result.verdict, 'rejected')
    assert.match(result.evidence, /read code only/)
  })

  it('spawns patcher and reports patched only when a patch was produced', async () => {
    const requests: DelegationRequest[] = []
    const coordinator: ReviewCoordinator = {
      delegate: async request => {
        requests.push(request)
        return run([worker({
          summary: 'patched deliver-task',
          patchSummary: 'added router gate',
          changedFiles: ['src/agent/deliver-task.ts'],
          evidenceStatus: 'skipped',
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnPatcher(
      { files: ['src/agent/deliver-task.ts'], crossModule: false, isFix: true },
      { verdict: 'rejected', evidence: 'missing review gate' },
    )

    assert.equal(requests[0]?.profile, 'patcher')
    assert.equal(requests[0]?.kind, 'patch_proposal')
    assert.equal(requests[0]?.reviewDepth, 1)
    assert.match(requests[0]?.objective ?? '', /missing review gate/)
    assert.equal(result.patched, true)
  })

  it('spawns squadron through delegateBatch and maps high-severity findings', async () => {
    let capturedPolicy: import('../work-order.js').AggregationPolicy | undefined
    let capturedRequests: DelegationRequest[] = []
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async (requests, policy) => {
        capturedRequests = requests
        capturedPolicy = policy
        return run([worker({
          summary: 'Lifecycle HIGH: race in transition',
          findings: [{ claim: 'HIGH race in transition', evidence: 'src/a.ts:10', confidence: 'high' }],
          evidenceStatus: 'skipped',
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnSquadron({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], crossModule: false, isFix: false })

    assert.equal(capturedPolicy, 'all_required')
    assert.equal(capturedRequests.length, 5)
    assert.ok(capturedRequests.every(request => request.profile === 'reviewer'))
    assert.ok(capturedRequests.every(request => request.kind === 'review'))
    assert.ok(capturedRequests.every(request => request.reviewDepth === 1))
    assert.deepEqual(capturedRequests[0]?.scope.files, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])

    // Every inspector carries the core anti-rubber-stamp stance
    for (const req of capturedRequests) {
      assert.match(req.objective, /客观审查姿态/)
      assert.match(req.objective, /提交存在、测试绿、作者声称已修/)
      assert.match(req.objective, /CRITICAL\/HIGH\/MEDIUM\/LOW/)
      // 契约改造（2026-08-02）：severity/polarity/status 三语义必须进审查指令
      assert.match(req.objective, /polarity/)
      assert.match(req.objective, /confirmation/)
      assert.match(req.objective, /status 表示你的审查任务是否完成/)
    }

    // Prompt economy: stances are assigned per axis, not stacked on all five.
    const security = capturedRequests[0]!.objective
    assert.match(security, /^【安全审查】/m)
    assert.match(security, /路径边界\/注意力门控审查姿态/)
    assert.match(security, /repo-relative.*absolute inside cwd.*absolute outside cwd.*\.\.\/ traversal/)
    assert.doesNotMatch(security, /数据流验证姿态/)
    assert.doesNotMatch(security, /接线有效性审查姿态/)

    const lifecycle = capturedRequests[1]!.objective
    assert.match(lifecycle, /^【生命周期】/m)
    assert.match(lifecycle, /数据流验证姿态/)
    assert.match(lifecycle, /外层超时严格支配内层预算/i)
    assert.doesNotMatch(lifecycle, /路径边界\/注意力门控审查姿态/)

    const dataFlow = capturedRequests[2]!.objective
    assert.match(dataFlow, /^【数据流】/m)
    assert.match(dataFlow, /数据流验证姿态/)
    assert.match(dataFlow, /事实流图/)
    assert.match(dataFlow, /路径边界\/注意力门控审查姿态/)

    const silence = capturedRequests[3]!.objective
    assert.match(silence, /^【静默审查】/m)
    assert.doesNotMatch(silence, /数据流验证姿态/)
    assert.doesNotMatch(silence, /路径边界\/注意力门控审查姿态/)

    const wiring = capturedRequests[4]!.objective
    assert.match(wiring, /^【接线审查】/m)
    assert.match(wiring, /接线有效性审查姿态/)
    assert.match(wiring, /无调用方/)
    assert.match(wiring, /静默特性杀戮/)
    assert.match(wiring, /逐项，附 file:line/)
    assert.doesNotMatch(wiring, /数据流验证姿态/)

    assert.equal(result.findings[0]?.severity, 'HIGH')
    assert.match(result.findings[0]?.claim ?? '', /race/)
    assert.equal(result.findings[0]?.polarity, undefined, 'worker 未上报 polarity 时缺席（blocking 判定 fail-closed 按 defect）')
    assert.deepEqual(result.infraFailures, [])
  })

  it('threads worker-reported finding polarity through to SquadronResult', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async () => run([worker({
        summary: '审查完成：一项缺陷 + 一项确认',
        findings: [
          { claim: 'CRITICAL 降档被钳制', evidence: 'src/a.ts:10', confidence: 'high', polarity: 'defect' },
          { claim: '链路闭合已确认', evidence: 'src/b.ts:20', confidence: 'high', polarity: 'confirmation' },
        ],
        evidenceStatus: 'skipped',
      })]),
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnSquadron({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], crossModule: false, isFix: false })

    assert.equal(result.findings[0]?.polarity, 'defect')
    assert.equal(result.findings[1]?.polarity, 'confirmation')
  })

  it('spawns the auto wiring reviewer as two parallel inspectors (Wiring + Silence, 按文件数缩放预算)', async () => {
    const requests: DelegationRequest[] = []
    const coordinator: ReviewCoordinator = {
      delegate: async request => {
        requests.push(request)
        return run([worker({
          summary: 'Wiring HIGH: budget field never enforced',
          findings: [{ claim: 'HIGH dead wiring: maxTokens never enforced', evidence: 'src/agent/worker-session.ts:210', confidence: 'high' }],
          evidenceStatus: 'skipped',
        })])
      },
      delegateBatch: async (reqs) => {
        for (const r of reqs) requests.push(r)
        return run([worker({
          summary: 'Wiring HIGH: budget field never enforced',
          findings: [{ claim: 'HIGH dead wiring: maxTokens never enforced', evidence: 'src/agent/worker-session.ts:210', confidence: 'high' }],
          evidenceStatus: 'skipped',
        })])
      },
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnWiringReviewer!({ files: ['src/a.ts'], crossModule: false, isFix: false })

    assert.equal(requests.length, 2, 'auto review spawns 2 inspectors (Wiring + Silence)')
    assert.equal(requests[0]?.profile, 'reviewer')
    assert.equal(requests[0]?.kind, 'review')
    assert.equal(requests[0]?.budget?.timeoutMs, 300_000)
    assert.equal(requests[0]?.budget?.maxTurns, 20)
    assert.match(requests[0]?.objective ?? '', /^【接线审查】/m)
    assert.match(requests[0]?.objective ?? '', /预算约束\(20 轮\/300s\)/)
    assert.match(requests[0]?.objective ?? '', /按此节奏收敛/)
    assert.match(requests[1]?.objective ?? '', /^【静默审查】/m)
    assert.ok(result.findings.length >= 0)
  })

  it('keeps squadron worker contract failures separate from real findings', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async () => run([worker({
        status: 'failed',
        summary: 'Worker failed: Worker result did not contain a JSON object',
        findings: [],
        risks: ['all_required: work order wo-test was blocked (unparseable or connectivity issue)'],
        evidenceStatus: 'blocked',
      })]),
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnSquadron({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], crossModule: false, isFix: false })

    assert.deepEqual(result.findings, [])
    assert.equal(result.infraFailures?.[0]?.kind, 'json')
    assert.match(result.infraFailures?.[0]?.claim ?? '', /JSON object/)
  })

  it('F1: parse-salvaged blocked result 透传 salvagedFindings 摘要（价值不丢、不冒充 findings）', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async () => run([worker({
        status: 'blocked',
        summary: 'Worker report JSON was malformed; salvaged 2/3 candidate(s) as findings',
        findings: [
          { claim: 'count 无 range 必失败', evidence: '…', confidence: 'medium' },
          { claim: 'path 误用 ref 校验', evidence: '…', confidence: 'high' },
        ],
        risks: ['parse-salvaged: 2 finding(s) recovered from a malformed report — verify before trusting'],
        evidenceStatus: 'unverified',
        failureReason: 'json_parse',
      })]),
    }

    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnSquadron({ files: ['src/a.ts'], crossModule: false, isFix: false })

    // salvaged findings 不冒充 SquadronResult.findings（不参与 blocking 判定）
    assert.deepEqual(result.findings, [])
    assert.equal(result.infraFailures?.[0]?.kind, 'json')
    const salvaged = result.infraFailures?.[0]?.salvagedFindings ?? []
    assert.equal(salvaged.length, 2)
    assert.equal(salvaged[0]?.claim, 'count 无 range 必失败')
    assert.equal(salvaged[1]?.confidence, 'high')
  })

  it('threads onActivity into DelegationRequest for all four spawns (review-gate UI visibility)', async () => {
    const captured: DelegationRequest[] = []
    const coordinator: ReviewCoordinator = {
      delegate: async request => { captured.push(request); return run([worker()]) },
      delegateBatch: async requests => { captured.push(...requests); return run(requests.map(() => worker())) },
    }
    const onActivity = () => {}
    const deps = createCoordinatorReviewDeps(coordinator)
    const change = { files: ['src/a.ts'], crossModule: false, isFix: true }

    await deps.spawnVerifier(change, undefined, onActivity)
    await deps.spawnPatcher(change, { verdict: 'rejected', evidence: 'x' }, undefined, onActivity)
    await deps.spawnSquadron(change, undefined, onActivity)
    await deps.spawnWiringReviewer!(change, undefined, onActivity)

    // 1 verifier + 1 patcher + 5 squadron inspectors + 2 auto inspectors
    assert.equal(captured.length, 9)
    for (const req of captured) assert.equal(req.onActivity, onActivity)
  })

  it('omits onActivity from DelegationRequest when not provided (serialization hygiene)', async () => {
    let captured: DelegationRequest | undefined
    const coordinator: ReviewCoordinator = {
      delegate: async request => { captured = request; return run([worker()]) },
    }
    const deps = createCoordinatorReviewDeps(coordinator)
    await deps.spawnVerifier({ files: ['src/a.ts'], crossModule: false, isFix: true })
    assert.equal(captured !== undefined && 'onActivity' in captured, false)
  })
})

describe('classifyInfraFailure 的 budget kind（max-turns 耗尽 ≠ 瞬时故障）', () => {
  it('max-turns 耗尽归类为 budget（供重试分流，不与 worker 崩溃混淆）', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async () => run([worker({
        status: 'failed',
        summary: 'max-turns: exhausted without a final turn',
        evidenceStatus: 'skipped',
      })]),
    }
    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnWiringReviewer!({ files: ['src/agent/loop.ts'], crossModule: false, isFix: false })
    assert.equal(result.infraFailures?.[0]?.kind, 'budget')
  })

  it('普通崩溃仍归类为 worker（瞬时可重试）', async () => {
    const coordinator: ReviewCoordinator = {
      delegate: async () => run([]),
      delegateBatch: async () => run([worker({
        status: 'failed',
        summary: 'worker process exited with code 1',
        evidenceStatus: 'skipped',
      })]),
    }
    const deps = createCoordinatorReviewDeps(coordinator)
    const result = await deps.spawnWiringReviewer!({ files: ['src/agent/loop.ts'], crossModule: false, isFix: false })
    assert.equal(result.infraFailures?.[0]?.kind, 'worker')
  })

  // ── evidenceKind E2E: scout finding → formatFinding 渲染链 ──────

  it('formatFinding: firsthand + evidenceRefs → [一手] prefix with file:line', () => {
    const finding = {
      claim: '超时阈值在 3 天前从 15 分钟降为 10 分钟',
      evidence: 'Found in ci.yml:42 via git log',
      confidence: 'high' as const,
      evidenceKind: 'firsthand' as const,
      evidenceRefs: ['ci.yml:42', 'cmd: git log -- ci.yml exit=0'],
    }
    const rendered = formatFinding(finding)
    assert.match(rendered, /^\[一手\]/)
    assert.match(rendered, /ci\.yml:42/)
    assert.match(rendered, /cmd: git log/)
    assert.match(rendered, /超时阈值/)
  })

  it('formatFinding: inferred without refs → [转述] prefix, no refs appended', () => {
    const finding = {
      claim: '可能是 runner 规格不够',
      evidence: 'No direct measurement',
      confidence: 'low' as const,
      evidenceKind: 'inferred' as const,
    }
    const rendered = formatFinding(finding)
    assert.match(rendered, /^\[转述\]/)
    assert.doesNotMatch(rendered, /\(ci\.yml/)
    assert.match(rendered, /可能是 runner/)
  })

  it('formatFinding: no evidenceKind → no prefix (backward compat)', () => {
    const finding = {
      claim: 'old finding',
      evidence: 'some evidence',
      confidence: 'medium' as const,
    }
    const rendered = formatFinding(finding)
    assert.doesNotMatch(rendered, /^\[/)
    assert.match(rendered, /^old finding/)
  })

  it('formatFinding: firsthand with empty evidenceRefs → prefix but no refs', () => {
    const finding = {
      claim: 'claim',
      evidence: 'evidence',
      confidence: 'high' as const,
      evidenceKind: 'firsthand' as const,
      evidenceRefs: [],
    }
    const rendered = formatFinding(finding)
    assert.match(rendered, /^\[一手\]/)
    assert.doesNotMatch(rendered, /\(/)
  })
})
