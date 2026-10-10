import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_BUDGET_BASE,
  GOAL_BUDGET_CEIL,
  TURNS_PER_MENTIONED_FILE,
  goalBudgetShapeEnabled,
  countMentionedPaths,
  hasLargeScopeSignal,
  resolveGoalBudget,
  sizeGoalBudget,
} from '../goal-budget.js'

const prev = process.env.RIVET_GOAL_BUDGET_SHAPE
afterEach(() => {
  if (prev === undefined) delete process.env.RIVET_GOAL_BUDGET_SHAPE
  else process.env.RIVET_GOAL_BUDGET_SHAPE = prev
})

describe('countMentionedPaths（goal 文本里的文件清单）', () => {
  it('识别反引号路径与裸路径，并去重', () => {
    const paths = countMentionedPaths('改 `src/a.ts` 与 src/b.ts，顺带看下 src/a.ts')
    assert.deepEqual(paths.sort(), ['src/a.ts', 'src/b.ts'])
  })

  it('无扩展名/无斜杠的词不算文件', () => {
    assert.deepEqual(countMentionedPaths('修个错别字，看看 README'), [])
  })

  it('反引号内的非路径内容被忽略', () => {
    assert.deepEqual(countMentionedPaths('跑 `npm run typecheck` 之后再说'), [])
  })
})

describe('hasLargeScopeSignal（大范围量级信号）', () => {
  it('中英文词根命中', () => {
    assert.equal(hasLargeScopeSignal('重构整个并发链路'), true)
    assert.equal(hasLargeScopeSignal('platform-specific migration'), true)
  })

  it('单点小改不命中', () => {
    assert.equal(hasLargeScopeSignal('改个文案，把按钮上的"确定"换成"保存"'), false)
  })
})

describe('sizeGoalBudget（纯函数核心）', () => {
  it('显式 --budget 全胜，任何形状信号都不覆盖', () => {
    const small = sizeGoalBudget({ goal: '重构整个并发链路', explicitBudget: 20 })
    assert.equal(small.maxIterations, 20)
    assert.equal(small.source, 'explicit')

    const tiny = sizeGoalBudget({ goal: '改 `src/a.ts` `src/b.ts` `src/c.ts`', explicitBudget: 5 })
    assert.equal(tiny.maxIterations, 5)
  })

  it('无信号 = 纯默认（行为零变化）', () => {
    const d = sizeGoalBudget({ goal: '修个错别字' })
    assert.equal(d.maxIterations, GOAL_BUDGET_BASE)
    assert.equal(d.maxIterations, 100)
    assert.equal(d.source, 'base')
  })

  it('单个提及文件不抬价（没有信号就不发声）', () => {
    const d = sizeGoalBudget({ goal: '把 `src/tui/help.ts` 里的帮助文案改掉' })
    assert.equal(d.maxIterations, GOAL_BUDGET_BASE)
    assert.equal(d.source, 'base')
  })

  it('每多一个提及文件 +6 轮（与 budget-shape 同源）', () => {
    const d = sizeGoalBudget({ goal: '改 `src/a.ts` `src/b.ts` `src/c.ts`' })
    assert.equal(d.maxIterations, GOAL_BUDGET_BASE + TURNS_PER_MENTIONED_FILE * 2)
    assert.equal(d.maxIterations, 112)
    assert.equal(d.source, 'shaped')
  })

  it('大范围词根命中 = base × 2', () => {
    const d = sizeGoalBudget({ goal: '把整个平台迁移到新的并发模型上' })
    assert.equal(d.maxIterations, GOAL_BUDGET_BASE * 2)
    assert.equal(d.maxIterations, 200)
  })

  it('双帽：结果永不超过 GOAL_BUDGET_CEIL', () => {
    const many = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`).join(' ')
    const d = sizeGoalBudget({ goal: `逐个改这些文件：${many}` })
    assert.equal(d.maxIterations, GOAL_BUDGET_CEIL)
    assert.equal(d.maxIterations, 200)
  })

  it('只抬不降：自定义 base 是地板，形状/历史只能在它之上抬高', () => {
    const shaped = sizeGoalBudget({ goal: '改 `src/a.ts` `src/b.ts`', base: 150 })
    // 150 + 6×1：形状信号在地板之上抬，而不是把地板缩回 100
    assert.equal(shaped.maxIterations, 156)
    assert.ok(shaped.maxIterations >= 150, '自定义 base 永不被缩小')

    const historical = sizeGoalBudget({
      goal: '修个错别字',
      base: 50,
      history: [{ iterationsUsed: 10, exhausted: true, budget: { maxIterations: 50 } }],
    })
    // ceil(10 × 1.15 × 1.3) = 15 < base 50——地板不降
    assert.equal(historical.maxIterations, 50)
  })

  it('历史样本 exhausted 触发地板抬升', () => {
    const d = sizeGoalBudget({
      goal: '跑一遍完整回归',
      history: [{ iterationsUsed: 100, exhausted: true, budget: { maxIterations: 100 } }],
    })
    assert.equal(d.maxIterations, Math.ceil(100 * 1.15 * 1.3))
    assert.equal(d.maxIterations, 150)
    assert.equal(d.source, 'shaped')
  })

  it('near-miss ≥ 0.8 触发，低于阈值不触发', () => {
    const nearMiss = sizeGoalBudget({
      goal: '跑一遍完整回归',
      history: [{ iterationsUsed: 80, budget: { maxIterations: 100 } }],
    })
    assert.equal(nearMiss.maxIterations, Math.ceil(80 * 1.15 * 1.3))

    const below = sizeGoalBudget({
      goal: '跑一遍完整回归',
      history: [{ iterationsUsed: 79, budget: { maxIterations: 100 } }],
    })
    assert.equal(below.maxIterations, GOAL_BUDGET_BASE)
    assert.equal(below.source, 'base')
  })

  it('空/坏历史样本静默降级为默认', () => {
    assert.equal(sizeGoalBudget({ goal: 'x', history: [] }).maxIterations, GOAL_BUDGET_BASE)
    assert.equal(sizeGoalBudget({ goal: 'x', history: [undefined as never] }).maxIterations, GOAL_BUDGET_BASE)
  })

  it('非法 base 回落 GOAL_BUDGET_BASE', () => {
    assert.equal(sizeGoalBudget({ goal: 'x', base: 0 }).maxIterations, GOAL_BUDGET_BASE)
    assert.equal(sizeGoalBudget({ goal: 'x', base: Number.NaN }).maxIterations, GOAL_BUDGET_BASE)
  })

  // 审查门 L3 发现：显式分支此前只校验 Number.isFinite——负值会原样穿透成
  // maxIterations，而下游 turn-orchestrator 的 `maxTurns > 0` 判据会把上限静默
  // fail-open 成 Number.MAX_SAFE_INTEGER（等于无上限）。真实 CLI 路径由
  // headless.ts 的正值过滤兜底，但本函数是导出的纯函数，防御必须在自己身上。
  it('非法显式值（0 / 负数 / NaN）视为"没给"，不返回非正上限', () => {
    const zero = sizeGoalBudget({ goal: '修个错别字', explicitBudget: 0 })
    assert.equal(zero.source, 'base')
    assert.equal(zero.maxIterations, GOAL_BUDGET_BASE)

    const negative = sizeGoalBudget({ goal: '修个错别字', explicitBudget: -5 })
    assert.ok(negative.maxIterations > 0, '负显式值不得穿透为 maxIterations——下游会 fail-open 成无上限')
    assert.equal(negative.source, 'base')

    const notANumber = sizeGoalBudget({ goal: '修个错别字', explicitBudget: Number.NaN })
    assert.equal(notANumber.maxIterations, GOAL_BUDGET_BASE)
  })

  it('大于 CEIL 的显式值原样保留——帽只约束形状/历史路径，显式即用户意图', () => {
    const d = sizeGoalBudget({ goal: '修个错别字', explicitBudget: GOAL_BUDGET_CEIL + 400 })
    assert.equal(d.maxIterations, GOAL_BUDGET_CEIL + 400)
    assert.equal(d.source, 'explicit')
  })

  it('rationale 记录每条抬升理由（供 run log 对账）', () => {
    const d = sizeGoalBudget({ goal: '重构 `src/a.ts` `src/b.ts` 的并发层' })
    assert.equal(d.source, 'shaped')
    assert.ok(d.rationale.length >= 2, `rationale 应含多条理由，实际：${JSON.stringify(d.rationale)}`)
    assert.ok(d.rationale.some(r => r.includes('files')))
    assert.ok(d.rationale.some(r => r.includes('large-scope')))
  })
})

describe('goalBudgetShapeEnabled（闸门）', () => {
  it('缺省开启；=0 关闭', () => {
    delete process.env.RIVET_GOAL_BUDGET_SHAPE
    assert.equal(goalBudgetShapeEnabled(), true)

    process.env.RIVET_GOAL_BUDGET_SHAPE = '0'
    assert.equal(goalBudgetShapeEnabled(), false)
  })

  it('闸门关闭时退回 base（与 --budget 显式值互不干扰）', () => {
    process.env.RIVET_GOAL_BUDGET_SHAPE = '0'
    const d = sizeGoalBudget({ goal: '重构整个并发链路' })
    assert.equal(d.maxIterations, GOAL_BUDGET_BASE)
    assert.equal(d.source, 'base')

    const explicit = sizeGoalBudget({ goal: '重构整个并发链路', explicitBudget: 33 })
    assert.equal(explicit.maxIterations, 33)
    assert.equal(explicit.source, 'explicit')
  })
})

// 接线契约（main.ts 唯一消费点）：解析层不再预置缺省（headless.ts），
// "缺省 100" 只由 GOAL_BUDGET_BASE 一个来源给出。
describe('resolveGoalBudget（CLI 解析 → 定价决策）', () => {
  it('非 goal 调用不参与定价', () => {
    assert.equal(resolveGoalBudget({}), undefined)
    assert.equal(resolveGoalBudget({ budget: 20 }), undefined)
  })

  it('goal 缺省走形状定价（解析层 undefined ≠ explicit）', () => {
    const d = resolveGoalBudget({ goal: '把整个平台迁移到新的并发模型上' })
    assert.ok(d)
    assert.equal(d!.source, 'shaped')
    assert.equal(d!.maxIterations, GOAL_BUDGET_CEIL)

    const plain = resolveGoalBudget({ goal: '修个错别字' })
    assert.equal(plain!.maxIterations, GOAL_BUDGET_BASE)
    assert.equal(plain!.source, 'base')
  })

  it('显式 --budget 仍然全胜（含低于 base 的值）', () => {
    const d = resolveGoalBudget({ goal: '把整个平台迁移到新的并发模型上', budget: 20 })
    assert.equal(d!.maxIterations, 20)
    assert.equal(d!.source, 'explicit')
  })
})
