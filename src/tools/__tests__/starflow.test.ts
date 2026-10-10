import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStarflowTool } from '../starflow.js'
import type { Tool, ToolCallParams, ToolResult } from '../types.js'

// ── 假子工具（只计数，零真实派发） ─────────────────────────────────────────

function fakeTool(name: string, execute: (params: ToolCallParams) => Promise<ToolResult>, calls: ToolCallParams[]): Tool {
  return {
    definition: { name, description: `fake ${name}`, input_schema: { type: 'object', properties: {} } },
    async execute(params) { calls.push(params); return execute(params) },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

const COUNCIL_PASS = ['# 议事记录', '', '```council-plan-json', '{"objective":"plan"}', '```'].join('\n')
const TEAM_PASS = 'team standard：派发 2，波次 1，阻塞 0'
const GALAXY_PASS = '🌌 星河集群执行报告 · 2/2 通过\n\n聚合结论: 所有维度通过。'

function makeTool(overrides?: { councilResult?: ToolResult }) {
  const cwd = mkdtempSync(join(tmpdir(), 'starflow-tool-'))
  const calls = { council: [] as ToolCallParams[], team: [] as ToolCallParams[], galaxy: [] as ToolCallParams[] }
  const tool = createStarflowTool({
    councilTool: fakeTool('council_convene', async () => overrides?.councilResult ?? { content: COUNCIL_PASS }, calls.council),
    teamTool: fakeTool('team_orchestrate', async () => ({ content: TEAM_PASS }), calls.team),
    galaxyTool: fakeTool('galaxy', async () => ({ content: GALAXY_PASS }), calls.galaxy),
    cwd,
  })
  return { tool, calls, cwd }
}

const DRAFTS = [
  { id: 'impl', title: '实现', detail: '实现登录逻辑', files: ['src/auth.ts'] },
  { id: 'review', title: '审查', detail: '审查登录逻辑' },
]

const MANY_DRAFTS = [
  ...DRAFTS,
  { id: 'backend', title: 'backend', detail: 'backend logic' },
  { id: 'docs', title: 'docs', detail: 'documentation' },
  { id: 'tests', title: 'tests', detail: 'additional tests' },
]

describe('STARFLOW_TOOL', () => {
  it('confirm 缺省 → 只展示执行方案，三个子工具零调用', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_1',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS },
    })

    assert.equal(result.isError, undefined)
    assert.equal(calls.council.length, 0, 'proposal 阶段不调 council')
    assert.equal(calls.team.length, 0, 'proposal 阶段不调 team')
    assert.equal(calls.galaxy.length, 0, 'proposal 阶段不调 galaxy')
    assert.match(result.content, /星流执行方案/)
    assert.match(result.content, /council 评审/)
    assert.match(result.content, /team 波次/)
    assert.match(result.content, /galaxy 攻坚 — 2 个维度/)
    assert.match(result.content, /confirm: true/)
    // 环境预检（2026-08-18）：确认前必见磁盘余量——makeTool 的 cwd 是真实
    // tmpdir，探测必出值；提案仍零派发（探针只读）。
    assert.match(result.content, /── 环境预检（硬约束，评审\/排期前必核）──/)
    assert.match(result.content, /磁盘（项目卷）：可用 \d+(\.\d+)? GiB/)
    assert.match(result.content, /点火后将持久化到：/)
    assert.doesNotMatch(result.content, /^状态持久化：/m, '预览不落盘，不得用陈述句声称已持久化')
    assert.match(result.uiContent ?? '', /星流方案/)
  })

  // issue #412 回归：预览阶段（confirm:false）宣称落盘却不落盘——文案与
  // 文件系统行为必须一致。预览零落盘，「点火后将持久化到」为未来时态。
  it('confirm 缺省 → 预览不落盘（状态目录与文件均不创建）', async () => {
    const { tool, cwd } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_1b',
      cwd: '/repo',
      input: { objective: '预览不落盘', draftItems: DRAFTS },
    })
    assert.equal(result.isError, undefined)
    assert.match(result.content, /点火后将持久化到：/)
    assert.equal(existsSync(join(cwd, '.rivet', 'starflow')), false, '预览阶段不得创建 .rivet/starflow/')
  })

  it('confirm:false 显式 → 同样零执行', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_2',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS, confirm: false },
    })
    assert.equal(result.isError, undefined)
    assert.equal(calls.council.length + calls.team.length + calls.galaxy.length, 0)
  })

  it('confirm:true → 触发状态机执行，全过后输出交付清单', async () => {
    const { tool, calls } = makeTool()
    const result = await tool.execute({
      toolUseId: 'tu_3',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(calls.council.length, 1)
    assert.equal(calls.team.length, 1)
    assert.equal(calls.galaxy.length, 1)
    assert.equal(result.orchestration?.kind, 'starflow')
    assert.equal(result.orchestration?.phase, 'done')
    assert.equal(result.orchestration?.done, true)
    assert.ok(result.orchestration?.runId)
    assert.ok((result.orchestration?.revision ?? 0) > 0)
    assert.match(result.content, /星流执行报告/)
    assert.match(result.content, /交付检查清单/)
    assert.match(result.uiContent ?? '', /全阶段通过/)
  })

  it('confirm:true 且 council 被禁用 → 返回 blocked 报告且 isError', async () => {
    const { tool, calls } = makeTool({
      councilResult: { content: 'council_convene 已禁用（COUNCIL=0）——未派发任何席位', isError: false },
    })
    const result = await tool.execute({
      toolUseId: 'tu_4',
      cwd: '/repo',
      input: { objective: '加登录功能', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, true, 'blocked 必须向工具管线报失败信号')
    assert.equal(calls.team.length, 0)
    assert.equal(calls.galaxy.length, 0)
    assert.match(result.content, /星流停止于 council 阶段/)
    assert.match(result.uiContent ?? '', /受阻于 council/)
  })

  it('参数错误 → format_error（objective 缺失 / galaxyDims 仅 1 个）', async () => {
    const { tool } = makeTool()
    const missing = await tool.execute({ toolUseId: 'tu_5', cwd: '/repo', input: {} })
    assert.equal(missing.isError, true)
    assert.equal(missing.errorKind, 'format_error')
    const oneDim = await tool.execute({
      toolUseId: 'tu_6',
      cwd: '/repo',
      input: { objective: 'x', galaxyDims: [{ name: 'a', objective: 'b' }] },
    })
    assert.equal(oneDim.isError, true)
    assert.equal(oneDim.errorKind, 'format_error')
  })

  it('invalid Galaxy contract is rejected before council/team/galaxy dispatch', async () => {
    const { tool, calls } = makeTool()
    const invalid = await tool.execute({
      toolUseId: 'tu_contract_preflight',
      cwd: '/repo',
      input: {
        objective: 'validate starflow before dispatch',
        galaxyDims: [
          { name: 'review', objective: 'check', authority: 'yaoguang', authorities: ['yaoguang', 'tianji'] },
          { name: 'backend', objective: 'inspect', authority: 'tianji' },
        ],
        confirm: true,
      },
    })

    assert.equal(invalid.isError, true)
    assert.equal(invalid.errorKind, 'format_error')
    assert.match(invalid.content, /Starflow Galaxy contract validation failed|must set either/i)
    assert.equal(calls.council.length + calls.team.length + calls.galaxy.length, 0)
  })

  it('timeoutMs 覆盖三阶段串行预算（大于任一单工具的 10 分钟）', () => {
    const { tool } = makeTool()
    const budget = tool.timeoutMs?.({ input: { objective: 'x' }, toolUseId: 'tu_7', cwd: '/repo' })
    assert.ok(typeof budget === 'number' && budget > 600_000, `预算应超过单工具 600s 上限，实际 ${budget}`)
  })

  it('autoReview:false removes the extra Galaxy review timeout budget', () => {
    const { tool } = makeTool()
    const galaxyDims = [
      { name: 'impl', objective: 'write', authority: 'tianliang' },
      { name: 'backend', objective: 'inspect', authority: 'tianji' },
    ]
    const withReview = tool.timeoutMs?.({ input: { objective: 'x', galaxyDims, autoReview: true }, toolUseId: 'tu_review_budget', cwd: '/repo' })
    const withoutReview = tool.timeoutMs?.({ input: { objective: 'x', galaxyDims, autoReview: false }, toolUseId: 'tu_no_review_budget', cwd: '/repo' })
    assert.ok(typeof withReview === 'number' && typeof withoutReview === 'number')
    assert.ok(withReview! > withoutReview!)
  })

  it('timeoutMs follows draft-derived dimensions and does not double-count explicit review', () => {
    const { tool } = makeTool()
    const twoDims = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: DRAFTS, autoReview: false },
      toolUseId: 'tu_derived_two',
      cwd: '/repo',
    })
    const fiveDims = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: MANY_DRAFTS, autoReview: false },
      toolUseId: 'tu_derived_five',
      cwd: '/repo',
    })
    assert.ok(typeof twoDims === 'number' && typeof fiveDims === 'number')
    assert.ok(fiveDims! > twoDims!, `five derived dimensions must widen the budget (${fiveDims} vs ${twoDims})`)

    const explicitReview = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: DRAFTS, autoReview: true },
      toolUseId: 'tu_explicit_review',
      cwd: '/repo',
    })
    assert.equal(explicitReview, twoDims, 'a derived review dimension already covers the review wave')
  })

  it('timeoutMs carries derived EP/DP profile, tier, and per-dimension budget inputs', () => {
    const { tool } = makeTool()
    const base = tool.timeoutMs?.({
      input: { objective: 'x', draftItems: DRAFTS, autoReview: false },
      toolUseId: 'tu_budget_base',
      cwd: '/repo',
    })
    const tuned = tool.timeoutMs?.({
      input: {
        objective: 'x',
        autoReview: false,
        galaxyDims: [
          { name: 'impl', objective: 'write', authority: 'tianliang', parallelism: 'data', replicas: 2, tierFloor: 'strong', timeoutMs: 900_000 },
          { name: 'review', objective: 'check', authority: 'yaoguang' },
        ],
      },
      toolUseId: 'tu_budget_tuned',
      cwd: '/repo',
    })
    assert.ok(typeof base === 'number' && typeof tuned === 'number')
    assert.ok(tuned! > base!, `explicit DP/tier/requested budget must widen the timeout (${tuned} vs ${base})`)
  })
})

describe('STARFLOW galaxy 阶段携带计划约束', () => {
  it('council 契约 nonGoals/obligations → 合并进每个 galaxy 维度 constraints', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'starflow-constraints-'))
    const calls = { council: [] as ToolCallParams[], team: [] as ToolCallParams[], galaxy: [] as ToolCallParams[] }
    const contract = {
      version: 1,
      objective: '带约束的星流',
      tasks: [{ id: 'T1', title: 't', objective: 'o', profile: 'patcher', kind: 'patch_proposal', files: [], dependsOn: [], riskTier: 'low' }],
      nonGoals: ['不动 team 归层', '不做运行时动态挂载'],
      obligations: [{ id: 'deferred_decision:0', kind: 'deferred_decision', text: '暂缓项「备选方案B」', source: 'tianquan' }],
      source: 'manual',
      createdAt: Date.now(),
    }
    const tool = createStarflowTool({
      councilTool: fakeTool('council_convene', async () => ({
        content: `# 议事记录\n\n\`\`\`council-plan-json\n${JSON.stringify(contract)}\n\`\`\``,
      }), calls.council),
      teamTool: fakeTool('team_orchestrate', async () => ({ content: TEAM_PASS }), calls.team),
      galaxyTool: fakeTool('galaxy', async () => ({ content: GALAXY_PASS }), calls.galaxy),
      cwd,
    })

    const result = await tool.execute({
      toolUseId: 'tu_starflow_constraints',
      cwd,
      input: { objective: '带约束的星流', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(calls.galaxy.length, 1)
    const dims = (calls.galaxy[0]!.input as { dimensions: Array<{ name: string; constraints?: string[] }> }).dimensions
    assert.ok(dims.length >= 2, `应派发 ≥2 维度，实际 ${dims.length}`)
    for (const d of dims) {
      const c = d.constraints ?? []
      assert.ok(c.includes('[计划反目标] 不动 team 归层'), `${d.name} 缺 nonGoals 约束：${JSON.stringify(c)}`)
      assert.ok(c.includes('[计划反目标] 不做运行时动态挂载'), `${d.name} 缺第二个 nonGoals 约束：${JSON.stringify(c)}`)
      assert.ok(c.includes('[计划约束] 暂缓项「备选方案B」'), `${d.name} 缺 obligations 约束：${JSON.stringify(c)}`)
    }
  })

  it('无 planJson（council 未产出契约）→ 维度不携带额外约束', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'starflow-nocontract-'))
    const calls = { council: [] as ToolCallParams[], team: [] as ToolCallParams[], galaxy: [] as ToolCallParams[] }
    const tool = createStarflowTool({
      councilTool: fakeTool('council_convene', async () => ({
        content: '# 议事记录\n\n（council 未产出契约，无 council-plan-json 块）',
      }), calls.council),
      teamTool: fakeTool('team_orchestrate', async () => ({ content: TEAM_PASS }), calls.team),
      galaxyTool: fakeTool('galaxy', async () => ({ content: GALAXY_PASS }), calls.galaxy),
      cwd,
    })

    const result = await tool.execute({
      toolUseId: 'tu_starflow_nocontract',
      cwd,
      input: { objective: '无契约星流', draftItems: DRAFTS, confirm: true },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(calls.galaxy.length, 1)
    const dims = (calls.galaxy[0]!.input as { dimensions: Array<{ name: string; constraints?: string[] }> }).dimensions
    for (const d of dims) {
      const c = d.constraints ?? []
      assert.ok(!c.some(x => x.startsWith('[计划反目标]')), `${d.name} 不应有派生约束：${JSON.stringify(c)}`)
    }
  })
})
