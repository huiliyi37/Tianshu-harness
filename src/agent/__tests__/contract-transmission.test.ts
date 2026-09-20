/**
 * 契约传导（D1–D5，2026-09-21 回流设计版）——worker 拿不到计划契约的四个断点。
 *
 * 背景：计划约束管线本身已经成熟（渲染/截断带指针、三源解析、五处注入点），但
 * worker 侧仍拿不到「段落级契约」与「计划全文」：
 *   D1 指针不可读：截断文案里的 `全文见 <ref>` 在两条主路径上都不成立
 *      （markdown 分支不传 ref → 退化成"全文见 计划"；loop 传裸 slug 文件名 →
 *      worker 从 repo 根 read_file 读不到）
 *   D2 无指针通道：工单没有 planRef，worker prompt 不提计划全文
 *   D3 预算不分级：计划级（[计划 前缀）与任务级共用 12 条 / 400 字，长契约被挤掉或截半
 *   D4 planJson 路径丢待验证假设（markdown 路径已能抽到）
 *   D5 段落级契约（接口契约/瑶光反证）在 checkbox-only 提取里丢失
 *
 * 本文件的断言刻意用**真实函数全链路**（不做中间层 mock），并在 D1 上钉
 * 「指针指到的文件真的能读到」——alpha 版只断言字符串形态，没钉可读性。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planRefFor,
  extractPlanConstraints,
  renderPlanConstraints,
  constraintsFromUnifiedPlan,
  PLAN_CONSTRAINT_PREFIX,
  resolvePlanContract,
} from '../plan-constraints.js'
import { createReadOnlyWorkOrder } from '../work-order.js'
import { buildWorkerPrompt } from '../worker-prompts.js'
import { resolveOrderPlanRef } from '../coordinator.js'
import type { DelegationRequest } from '../coordinator.js'
import { extractContractBlocks, buildTasksFromSections, parseChecklistSections } from '../../tools/plan-task.js'
import { DelegationCoordinator } from '../coordinator.js'
import { executePlanWaves } from '../plan-executor.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { profileRegistry } from '../profile-registry.js'
import type { Tool } from '../../tools/types.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { WorkerSessionConfig } from '../worker-session.js'
import type { WorkerResult } from '../work-order.js'

/** 造一个含 .rivet/plans/<slug>.md 的临时项目。 */
function makeProject(slug: string, body: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'contract-'))
  mkdirSync(join(dir, '.rivet', 'plans'), { recursive: true })
  writeFileSync(join(dir, '.rivet', 'plans', `${slug}.md`), body, 'utf-8')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── D1：planRef 必须是「可读的相对路径」 ─────────────────────────────────

describe('D1 planRef 可读性（回流新增判据）', () => {
  it('slug → .rivet/plans/<slug>.md，且该路径真的能 read_file 读到计划全文', () => {
    const { dir, cleanup } = makeProject('demo-plan', '# 计划标题\n\n正文\n')
    try {
      const ref = planRefFor(dir, 'demo-plan')
      assert.equal(ref, '.rivet/plans/demo-plan.md', '相对 cwd 的可读路径（不是裸文件名、不是绝对路径）')
      // 关键判据：worker（cwd=项目根）按这个 ref 必须读得到。
      assert.match(readFileSync(join(dir, ref!), 'utf-8'), /计划标题/)
    } finally { cleanup() }
  })

  it('已带 .md 的 slug 不重复追加后缀；显式相对路径原样可用', () => {
    const { dir, cleanup } = makeProject('p2', '# x\n')
    try {
      assert.equal(planRefFor(dir, 'p2.md'), '.rivet/plans/p2.md')
      assert.equal(planRefFor(dir, '.rivet/plans/p2.md'), '.rivet/plans/p2.md')
    } finally { cleanup() }
  })

  it('不存在的计划 / 越界路径 → undefined（绝不产出指不到的指针）', () => {
    const { dir, cleanup } = makeProject('p3', '# x\n')
    try {
      assert.equal(planRefFor(dir, 'nope'), undefined)
      assert.equal(planRefFor(dir, '../../../etc/passwd'), undefined)
      assert.equal(planRefFor(dir, '/etc/passwd'), undefined)
    } finally { cleanup() }
  })

  it('resolvePlanContract：从 planPath 解析出 constraints + 可读 planRef', () => {
    const { dir, cleanup } = makeProject('p4', '## 反目标\n\n- 不做 X\n')
    try {
      const contract = resolvePlanContract(dir, { planPath: '.rivet/plans/p4.md' })
      assert.ok(contract.constraints.length > 0, '反目标要解析出来')
      assert.equal(contract.planRef, '.rivet/plans/p4.md')
    } finally { cleanup() }
  })
})

// ── D2：工单 planRef + worker prompt 指针 ────────────────────────────────

describe('D2 工单 planRef 与 worker prompt 注入', () => {
  function order(planRef?: string) {
    return createReadOnlyWorkOrder({
      id: 'wo_ref', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: '侦察契约断点在哪', scope: { files: [], symbols: [] },
      constraints: [], allowedTools: ['read_file'], disallowedTools: [], dedupeKey: 'k',
      dependencies: [], aggregationPolicy: 'all_required', budget: { turns: 4 },
      ...(planRef ? { planRef } : {}),
    } as never)
  }

  it('planRef 进工单，并渲染成「计划全文见 <path>」指针', () => {
    const wo = order('.rivet/plans/demo.md')
    assert.equal(wo.planRef, '.rivet/plans/demo.md')
    const prompt = buildWorkerPrompt(wo)
    assert.match(prompt, /计划全文见：\.rivet\/plans\/demo\.md/, 'worker prompt 必须给出可读指针')
    assert.match(prompt, /read_file/, '要说明怎么取全文')
  })

  it('无 planRef 时 prompt 不多一个字（向后兼容）', () => {
    const prompt = buildWorkerPrompt(order())
    assert.doesNotMatch(prompt, /计划全文见/)
  })

  it('resolveOrderPlanRef：走 coordinator config 钩子，抛错/缺席 fail-open', () => {
    assert.equal(resolveOrderPlanRef('x', {}), undefined)
    assert.equal(resolveOrderPlanRef('x', { getPlanRef: () => '.rivet/plans/a.md' }), '.rivet/plans/a.md')
    assert.equal(resolveOrderPlanRef('x', { getPlanRef: () => { throw new Error('boom') } }), undefined)
  })

  it('显式 request.planRef 优先于钩子（显式来源在场，兜底让位）', () => {
    const config = { getPlanRef: () => '.rivet/plans/fallback.md' }
    assert.equal(resolveOrderPlanRef('x', config, '.rivet/plans/explicit.md'), '.rivet/plans/explicit.md')
  })
})

// ── D3：预算分级（计划级不占任务级预算、不被截断） ────────────────────────

describe('D3 约束预算分级', () => {
  function orderWith(constraints: string[]) {
    return createReadOnlyWorkOrder({
      id: 'wo_budget', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: '预算分级验证', scope: { files: [], symbols: [] },
      constraints, allowedTools: ['read_file'], disallowedTools: [], dedupeKey: 'k',
      dependencies: [], aggregationPolicy: 'all_required', budget: { turns: 4 },
    } as never)
  }

  it('20 条计划级 + 20 条任务级：计划级一条不少且不截断，任务级恰好 12 条 × ≤400', () => {
    const longPlan = `${PLAN_CONSTRAINT_PREFIX}反目标] ${'x'.repeat(800)}`
    const planLevel = [longPlan, ...Array.from({ length: 19 }, (_, i) => `${PLAN_CONSTRAINT_PREFIX}约束] 计划级 ${i}`)]
    const taskLevel = Array.from({ length: 20 }, (_, i) => `任务级约束 ${i} ${'y'.repeat(500)}`)
    const wo = orderWith([...taskLevel, ...planLevel])
    const kept = wo.constraints ?? []
    const keptPlan = kept.filter(c => c.startsWith(PLAN_CONSTRAINT_PREFIX))
    // 工单 constraints = 档案基底（base）+ 本次条目——只数本次传进去的任务级条目。
    const keptTask = kept.filter(c => c.startsWith('任务级约束 '))
    assert.equal(keptPlan.length, 20, '计划级不受任务级 12 条预算挤占')
    assert.ok(keptPlan.some(c => c.endsWith('x'.repeat(800))), '计划级不被 400 字截断（800 个 x 完整保留）')
    assert.equal(keptTask.length, 12, '任务级仍限 12 条')
    assert.ok(keptTask.every(c => c.length <= 400), '任务级仍按 400 截断')
  })

  it('计划级条目去重后不重复；顺序稳定（计划级在前）', () => {
    const plan = `${PLAN_CONSTRAINT_PREFIX}反目标] 不做 X`
    const wo = orderWith([plan, plan, '任务级 A'])
    const kept = wo.constraints ?? []
    assert.equal(kept.filter(c => c === plan).length, 1, '重复计划级条目只留一条')
    assert.ok(kept.indexOf(plan) < kept.indexOf('任务级 A'), '计划级排在前（权威来源先入）')
  })
})

// ── D4：planJson 路径的待验证假设 ────────────────────────────────────────

describe('D4 assumptions 结构化载体', () => {
  it('constraintsFromUnifiedPlan 消费 assumptions → 待验证假设指纹', () => {
    const out = constraintsFromUnifiedPlan({ assumptions: ['假设 A', '假设 B'] })
    assert.equal(out.length, 2)
    assert.ok(out[0]!.includes('假设 A'))
    assert.match(out[0]!, /待验证假设/, '渲染指纹要标明"执行期先验证"的语义')
  })

  it('无 assumptions 字段 → 与改动前逐位一致（只剩 nonGoals）', () => {
    const out = constraintsFromUnifiedPlan({ nonGoals: ['不做 Y'] })
    assert.equal(out.length, 1)
    assert.ok(out[0]!.includes('不做 Y'))
  })
})

// ── D5：段落级契约提取与注入 ─────────────────────────────────────────────

const PLAN_WITH_CONTRACT = [
  '# 计划',
  '',
  '## Wave 1',
  '',
  '- [ ] 实现 resolveZenConfig',
  '',
  '**接口契约**',
  '`resolveZenConfig(cfg): ZenConfig`',
  '- 未知键必须 fail-loud 抛错',
  '',
  '## 瑶光反证',
  '',
  '反证 1：若配置缺省，则不应抛错。',
].join('\n')

describe('D5 段落级契约', () => {
  it('提取「接口契约」「瑶光反证」段落，且都能指到计划全文', () => {
    const blocks = extractContractBlocks(PLAN_WITH_CONTRACT)
    assert.equal(blocks.length, 2)
    assert.match(blocks[0]!, /resolveZenConfig/)
    assert.match(blocks[1]!, /反证 1/)
  })

  it('无契约标记的计划 → 空数组（行为不变）', () => {
    assert.deepEqual(extractContractBlocks('# 计划\n\n## Wave 1\n\n- [ ] 任务 A\n'), [])
  })

  it('超预算段落带指针而非静默截半', () => {
    const big = `**接口契约**\n${'z'.repeat(3000)}`
    const [block] = extractContractBlocks(big)
    assert.ok(block!.length <= 2100, `预算内（实际 ${block!.length}）`)
    assert.match(block!, /全文见/, '截断必须留指针（与 truncateWithPointer 同纪律）')
  })

  it('段落契约注入每个任务的 objective（checkbox-only 提取的断点修复）', () => {
    const sections = parseChecklistSections(PLAN_WITH_CONTRACT)
    const graph = buildTasksFromSections(sections, '总目标', extractContractBlocks(PLAN_WITH_CONTRACT))
    assert.ok(graph.nodes.length >= 1)
    for (const node of graph.nodes) {
      assert.match(node.objective, /resolveZenConfig/, '每个 worker 都要看得到接口契约')
      assert.match(node.objective, /只执行本 task/, '原有纪律行不得丢')
    }
  })
})

// ── 端到端：钩子 → 工单；opts → 每个波次请求（这两处最容易静默失效） ──────

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} test tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) {
      if (!registry.has(tool)) registry.register(fakeTool(tool))
    }
  }
  return registry
}

const CARD: ModelCapabilityCard = {
  model: 'test-model', toolUseReliability: 0.8, jsonStability: 0.8, editSuccessRate: 0.7,
  testRepairRate: 0.6, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: ['code_search'],
}

const PASSED: WorkerResult = {
  workOrderId: 'wo_e2e', status: 'passed', summary: '侦查完成并给出结论（足够长的摘要以跳过扩写轮）',
  findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified',
}

describe('端到端：计划指针真的落到工单/请求上', () => {
  it('coordinator 建单点：config.getPlanRef 钩子 → order.planRef（含 batch 路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-e2e-'))
    const seen: Array<string | undefined> = []
    try {
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: [CARD],
        maxWorkers: 2,
        cwd: dir,
        getPlanRef: () => '.rivet/plans/hooked.md',
        runtimeFactory: (order, card, workerRegistry) => ({
          order, client: {} as never,
          promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: dir } }),
          toolRegistry: workerRegistry, cwd: dir, maxTurns: 2, contextWindow: card.contextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }),
        runWorker: async (config: WorkerSessionConfig) => {
          seen.push(config.order.planRef)
          return {
            result: { ...PASSED, workOrderId: config.order.id },
            transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
            session: { getTurnCount: () => 1 } as never,
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }
        },
      })
      await coordinator.delegate({
        parentTurnId: 'turn-1', objective: '按计划侦察契约传导链路的断点在哪',
        kind: 'code_search', profile: 'code_scout', scope: { files: [] },
      })
      assert.deepEqual(seen, ['.rivet/plans/hooked.md'], '单路建单必须带上钩子给的指针')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('plan-executor opts.planRef → 每个波次请求都带指针（wave 驱动不吞它）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-e2e-'))
    const seen: Array<string | undefined> = []
    const PLAN = '### T1: First edit\n修改 src/a.ts\n\n### T2: Second edit\n修改 src/a.ts\n'
    try {
      await executePlanWaves(
        {
          mode: 'standard', objective: '契约传导 e2e', planMarkdown: PLAN,
          sessionId: `contract-e2e-${Date.now()}`, reviewDepth: 0, cwd: dir, reviewGate: false,
          planRef: '.rivet/plans/wave.md',
        },
        {
          delegateBatch: async (requests: Array<{ parentTurnId: string; planRef?: string }>) => {
            for (const r of requests) seen.push(r.planRef)
            return { status: 'completed', results: requests.map(r => ({ ...PASSED, workOrderId: r.parentTurnId })), packet: 'w' }
          },
        } as never,
      )
      assert.ok(seen.length >= 2, `两波都要派人（实际 ${seen.length}）`)
      assert.ok(seen.every(x => x === '.rivet/plans/wave.md'), `每个请求都要带指针，实际 ${JSON.stringify(seen)}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
