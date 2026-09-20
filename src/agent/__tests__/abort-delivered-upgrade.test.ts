/**
 * completed-aborted（2026-09-05 team-76dc14a1 事故修复 B）RED→GREEN。
 *
 * 事故形态（会话取证）：plan_task 600s 硬超时级联 abort 斩杀 worker-team-T4，
 * 其产物（README.ja.md）已完整落盘——worker-session 产 blocked(caller_aborted)
 * → all_required 聚合翻 failed → checkpoint 记 failed，韩文 T5 再也没跑。
 *
 * 本测试的三层断言：
 * - RED 复现：不经升级的 abort 结果被 all_required 翻 failed（事故原貌，用现行
 *   聚合语义直接演示——这半边在任何代码版本上都必须成立）。
 * - GREEN：upgradeAbortedDelivery 单元矩阵 + coordinator delegate/delegateBatch
 *   全链路（产物落盘的 abort → passed + deliveredOnAbort，聚合不再翻 failed；
 *   无产物的 abort → 维持 blocked→failed，「真失败」语义不动）。
 * - 证据门：deliveredOnAbort 豁免只开给系统盖章结果，闸门本体（未验证改动翻
 *   blocked）对普通结果不松。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamClient } from '../../api/stream-client.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import { DelegationCoordinator } from '../coordinator.js'
import {
  buildBlockedWorkerResult,
  createReadOnlyWorkOrder,
  READ_ONLY_WORKER_TOOLS,
  type WorkOrder,
  type WorkerResult,
} from '../work-order.js'
import { upgradeAbortedDelivery } from '../abort-delivery.js'
import { aggregateResults } from '../aggregation.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'
import { profileRegistry } from '../profile-registry.js'
import type { WorkerSessionConfig } from '../worker-session.js'

// ── 共享假件（与 worker-abort-checkpoint-resume.test.ts 同一模式）──────────

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} test tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry() {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) {
      if (!registry.has(tool)) registry.register(fakeTool(tool))
    }
  }
  return registry
}

const cards: ModelCapabilityCard[] = [{
  model: 'test-model',
  toolUseReliability: 0.8,
  jsonStability: 0.8,
  editSuccessRate: 0.7,
  testRepairRate: 0.6,
  contextWindow: 128_000,
  cacheEconomics: 'medium',
  recommendedTasks: ['code_search'],
}]

function makeCoordinator(cwd: string, runWorker: (config: WorkerSessionConfig) => ReturnType<NonNullable<ConstructorParameters<typeof DelegationCoordinator>[0]['runWorker']>>) {
  return new DelegationCoordinator({
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: 2,
    cwd,
    runtimeFactory: (order, card, workerRegistry) => ({
      order,
      client: {} as StreamClient,
      promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd } }),
      toolRegistry: workerRegistry,
      cwd,
      maxTurns: 2,
      contextWindow: card.contextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }),
    runWorker,
  })
}

function abortedBlocked(order: WorkOrder, reason: 'caller_aborted' | 'timeout'): WorkerResult {
  return buildBlockedWorkerResult(order, `Worker aborted (${reason === 'caller_aborted' ? 'parent signal' : 'budget timeout'}). Partial output: …`, reason)
}

function abortedRun(order: WorkOrder) {
  return {
    result: abortedBlocked(order, 'caller_aborted'),
    transcript: { text: '', thinking: '', toolUses: ['write_file'], toolResults: [], errors: [], repairAttempts: 0 },
    session: { getTurnCount: () => 1 } as never,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

function mkOrder(cwdFiles: string[], overrides: Partial<WorkOrder> = {}): WorkOrder {
  return createReadOnlyWorkOrder({
    id: 'team:T4',
    parentTurnId: 't',
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: '生成 README.ja.md 日文翻译分片',
    scope: { files: cwdFiles, symbols: [] },
    constraints: [],
    allowedTools: ['read_file'],
    disallowedTools: [],
    dedupeKey: 'k',
    dependencies: [],
    aggregationPolicy: 'all_required',
    budget: { turns: 4 },
    ...overrides,
  } as never)
}

// ── RED：事故原貌复现（不依赖本次修复，任何版本都必须成立）────────────────

describe('RED 复现 — 产物落盘的 abort 结果被 all_required 误标 failed（事故原貌）', () => {
  it('blocked(caller_aborted) 经 all_required 聚合翻成 failed', () => {
    const order = mkOrder(['README.ja.md'])
    const aborted = abortedBlocked(order, 'caller_aborted')
    // 事故链路的关键一跳：worker-session 产 blocked，all_required 聚合翻 failed——
    // checkpoint 里 T4 的 status:'failed' + failureReason:'caller_aborted' 就是这么来的。
    // （走真实 aggregateResults 入口：changedFiles 为空，证据门透传，聚合同事故。）
    const aggregated = aggregateResults([aborted], 'all_required')
    assert.equal(aggregated[0]!.status, 'failed', 'RED：abort 斩杀被聚合误标 failed（事故原貌）')
    assert.equal(aggregated[0]!.failureReason, 'caller_aborted')
  })
})

// ── GREEN ①：upgradeAbortedDelivery 单元矩阵 ────────────────────────────

describe('upgradeAbortedDelivery — abort 收尾产物校验矩阵', () => {
  it('caller_aborted + scope 产物新建落盘 → passed + deliveredOnAbort + 证据钉死 unverified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-up-'))
    try {
      writeFileSync(join(dir, 'README.ja.md'), '# 天枢\n日文版内容\n', 'utf-8')
      const order = mkOrder(['README.ja.md'])
      const out = upgradeAbortedDelivery(order, dir, Date.now() - 5_000, abortedBlocked(order, 'caller_aborted'))
      assert.equal(out.status, 'passed')
      assert.equal(out.deliveredOnAbort, true)
      assert.equal(out.evidenceStatus, 'unverified', 'abort 切断证据链——不得冒充 verified')
      assert.equal(out.failureReason, 'caller_aborted', 'abort 来源保留，供下游区分「被斩杀」与「干净通过」')
      assert.ok(out.changedFiles.includes('README.ja.md'))
      assert.ok(out.summary.includes('completed-aborted'), `summary 应带语义标记：${out.summary}`)
      assert.ok(out.risks.some(r => r.includes('completed-aborted')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('timeout（预算墙钟）+ 产物落盘 → 同样升级', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-up-'))
    try {
      writeFileSync(join(dir, 'out.md'), 'content\n', 'utf-8')
      const order = mkOrder(['out.md'])
      const out = upgradeAbortedDelivery(order, dir, Date.now() - 5_000, abortedBlocked(order, 'timeout'))
      assert.equal(out.status, 'passed')
      assert.equal(out.failureReason, 'timeout')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('真失败不升级：产物缺失 / 非 abort 原因 / 已 passed / scope 为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-up-'))
    try {
      const missing = mkOrder(['never-written.md'])
      const r1 = upgradeAbortedDelivery(missing, dir, Date.now() - 5_000, abortedBlocked(missing, 'caller_aborted'))
      assert.equal(r1.status, 'blocked', '产物未落盘 = 真失败，维持 blocked')

      const parseFailed: WorkerResult = { ...abortedBlocked(mkOrder(['x.md']), 'caller_aborted'), failureReason: 'json_parse' }
      writeFileSync(join(dir, 'x.md'), 'content\n', 'utf-8')
      const r2 = upgradeAbortedDelivery(mkOrder(['x.md']), dir, Date.now() - 5_000, parseFailed)
      assert.equal(r2.status, 'blocked', 'json_parse 不是 abort 语义，不升级')

      const passed: WorkerResult = { ...abortedBlocked(mkOrder(['x.md']), 'caller_aborted'), status: 'passed' }
      const r3 = upgradeAbortedDelivery(mkOrder(['x.md']), dir, Date.now() - 5_000, passed)
      assert.equal(r3.deliveredOnAbort, undefined, '已 passed 不重复盖章')

      const noScope = mkOrder([])
      const r4 = upgradeAbortedDelivery(noScope, dir, Date.now() - 5_000, abortedBlocked(noScope, 'caller_aborted'))
      assert.equal(r4.status, 'blocked', 'scope 无声明产物 → 无从校验，不升级')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('防误判：scope 文件全部存在但都是旧文件（本次运行没写）→ 不升级', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-up-'))
    try {
      // T2/T3 形态：scope 是既有文件（README.md），worker 一启动就被 abort、一行没写。
      // 没有 mtime 新鲜度闸会把「文件本来就存在」误判成「已交付」。
      writeFileSync(join(dir, 'README.md'), '# existing\n', 'utf-8')
      const old = new Date(Date.now() - 600_000)
      utimesSync(join(dir, 'README.md'), old, old)
      const order = mkOrder(['README.md'])
      const out = upgradeAbortedDelivery(order, dir, Date.now() - 5_000, abortedBlocked(order, 'caller_aborted'))
      assert.equal(out.status, 'blocked', '旧文件不算本次运行的交付')
      assert.equal(out.deliveredOnAbort, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('多文件 scope：全部存在且至少一个新写 → 升级；任一缺失 → 不升级', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-up-'))
    try {
      writeFileSync(join(dir, 'a.md'), 'a\n', 'utf-8')
      const old = new Date(Date.now() - 600_000)
      utimesSync(join(dir, 'a.md'), old, old) // 既有文件，本次不必改
      writeFileSync(join(dir, 'b.md'), 'b new\n', 'utf-8') // 本次新写
      const ok = mkOrder(['a.md', 'b.md'])
      const out = upgradeAbortedDelivery(ok, dir, Date.now() - 5_000, abortedBlocked(ok, 'caller_aborted'))
      assert.equal(out.status, 'passed')

      const missing = mkOrder(['a.md', 'c.md'])
      const out2 = upgradeAbortedDelivery(missing, dir, Date.now() - 5_000, abortedBlocked(missing, 'caller_aborted'))
      assert.equal(out2.status, 'blocked', 'c.md 未落盘 = 产物未齐')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('幂等：已盖章结果不重复改写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-up-'))
    try {
      writeFileSync(join(dir, 'README.ja.md'), 'content\n', 'utf-8')
      const order = mkOrder(['README.ja.md'])
      const once = upgradeAbortedDelivery(order, dir, Date.now() - 5_000, abortedBlocked(order, 'caller_aborted'))
      const twice = upgradeAbortedDelivery(order, dir, Date.now() - 5_000, once)
      assert.equal(twice, once, '第二次调用返回同一对象')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── GREEN ②：证据门豁免 —— 豁免只开给系统盖章，闸门本体不松 ─────────────

describe('verifyWorkerEvidence × deliveredOnAbort 豁免', () => {
  it('系统盖章的 completed-aborted：非 advisory 写 profile 也保 passed（加 unverified risk）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-gate-'))
    try {
      writeFileSync(join(dir, 'README.ja.md'), 'content\n', 'utf-8')
      const order = mkOrder(['README.ja.md'])
      const upgraded = upgradeAbortedDelivery(order, dir, Date.now() - 5_000, abortedBlocked(order, 'caller_aborted'))
      assert.equal(upgraded.status, 'passed')
      // lint_fixer 不在 WRITE_PROFILES_ADVISORY——无豁免时 changedFiles>0 + 非 verified
      // 必被翻 blocked。批末二次过闸（transcript=undefined）走的就是这条。
      const gated = verifyWorkerEvidence(upgraded, 'lint_fixer')
      assert.equal(gated.status, 'passed', 'deliveredOnAbort 豁免除强制 blocked')
      assert.equal(gated.evidenceStatus, 'unverified')
      assert.ok(gated.risks.some(r => r.includes('without verified evidence')), '未验证事实仍留痕')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('闸门本体不松：无 deliveredOnAbort 的同形结果仍被翻 blocked', () => {
    const plain: WorkerResult = {
      workOrderId: 'wo_x',
      status: 'passed',
      summary: 'worker 自报完成但未验证',
      findings: [],
      artifacts: [],
      changedFiles: ['src/a.ts'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified',
    }
    const gated = verifyWorkerEvidence(plain, 'lint_fixer')
    assert.equal(gated.status, 'blocked', '普通未验证写结果必须仍被闸门拦下')
  })
})

// ── GREEN ③：coordinator 全链路 —— 产物落盘的 abort 不再误标 failed ──────

describe('coordinator delegate 全链路（completed-aborted）', () => {
  it('产物已落盘的 abort worker：delegate 返回 passed + deliveredOnAbort（RED→GREEN）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-coord-'))
    try {
      const coordinator = makeCoordinator(dir, async config => {
        // 模拟事故现场的 worker：产物已写盘，随后被 abort 斩杀（报告没来得及产出）。
        writeFileSync(join(dir, 'README.ja.md'), '# 天枢\n日本語版\n', 'utf-8')
        return abortedRun(config.order)
      })
      const run = await coordinator.delegate({
        parentTurnId: 'turn-1',
        objective: 'Translate the README navigation and content into Japanese, writing the complete README.ja.md shard',
        kind: 'patch_proposal',
        profile: 'code_scout',
        scope: { files: ['README.ja.md'] },
      })
      const result = run.results[0]!
      assert.equal(result.status, 'passed', `产物落盘的 abort 应按已交付计入，got ${result.status}: ${result.summary}`)
      assert.equal(result.deliveredOnAbort, true)
      assert.equal(result.failureReason, 'caller_aborted')
      assert.equal(result.evidenceStatus, 'unverified')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('对照组：产物未落盘的 abort → 维持 blocked（真失败语义不动）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-coord-'))
    try {
      const coordinator = makeCoordinator(dir, async config => abortedRun(config.order))
      const run = await coordinator.delegate({
        parentTurnId: 'turn-1',
        objective: 'Translate the README navigation and content into Japanese, writing the complete README.ja.md shard',
        kind: 'patch_proposal',
        profile: 'code_scout',
        scope: { files: ['README.ja.md'] },
      })
      const result = run.results[0]!
      assert.equal(result.status, 'blocked')
      assert.equal(result.failureReason, 'caller_aborted')
      assert.equal(result.deliveredOnAbort, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('delegateBatch all_required：升级的 passed 不再被聚合翻 failed（事故链终点修复）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-coord-'))
    try {
      const coordinator = makeCoordinator(dir, async config => {
        if (config.order.scope.files?.includes('README.ja.md')) {
          writeFileSync(join(dir, 'README.ja.md'), '# 天枢\n日本語版\n', 'utf-8')
          return abortedRun(config.order)
        }
        // 对照 worker（T3 形态）：只读侦察无改动——证据门对 changedFiles 为空的
        // 结果透传，passed 不受影响。
        return {
          result: {
            workOrderId: config.order.id,
            status: 'passed' as const,
            summary: 'navigation links inserted into README.md header, diff inspected line by line',
            findings: [],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'unverified' as const,
          },
          transcript: { text: '', thinking: '', toolUses: ['edit_file'], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getTurnCount: () => 1 } as never,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      })
      const run = await coordinator.delegateBatch([
        {
          parentTurnId: 'wave:T3',
          objective: 'Insert ja/ko language navigation links into the README.md header block and verify with git diff',
          kind: 'patch_proposal',
          profile: 'code_scout',
          scope: { files: ['README.md'] },
        },
        {
          parentTurnId: 'wave:T4',
          objective: 'Translate the README navigation and content into Japanese, writing the complete README.ja.md shard',
          kind: 'patch_proposal',
          profile: 'code_scout',
          scope: { files: ['README.ja.md'] },
        },
      ], 'all_required')
      // T4 的升级结果 changedFiles 含产物文件——按它定位（workOrderId 是派生 id）。
      const t4 = run.results.find(r => r.changedFiles.includes('README.ja.md'))
      assert.ok(t4, 'T4 结果必须存在')
      assert.equal(t4!.status, 'passed', `all_required 不得再把已交付的 abort 翻 failed：${t4!.summary}`)
      assert.equal(t4!.deliveredOnAbort, true)
      const t3 = run.results.find(r => r !== t4)
      assert.equal(t3!.status, 'passed', '正常通过者不受影响')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
