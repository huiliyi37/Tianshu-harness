import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  goalActualKey,
  parseGoalActualRows,
  persistGoalActual,
  readGoalActualSamples,
  type GoalActualStore,
} from '../goal-actual-index.js'
import { GOAL_BUDGET_BASE, resolveGoalBudget, sizeGoalBudget } from '../goal-budget.js'

/** 内存 store —— 与 meridian db 的前缀查询同形（loadBanditStatesByPrefix 语义）。 */
function fakeStore(): GoalActualStore & { rows: Array<{ kind: string; json: string }>; failWrites: boolean } {
  const rows: Array<{ kind: string; json: string }> = []
  return {
    rows,
    failWrites: false,
    saveBanditState(kind, json) {
      if (this.failWrites) throw new Error('db locked')
      rows.push({ kind, json })
    },
    loadBanditStatesByPrefix(prefix, limit) {
      const hit = rows.filter(r => r.kind.startsWith(prefix))
      return limit === undefined ? hit : hit.slice(0, limit)
    },
  }
}

describe('parseGoalActualRows（坏数据不得炸定价）', () => {
  it('坏 JSON / 缺字段 / 前缀不匹配一律跳过', () => {
    const hash = 'abc123'
    const rows = [
      { kind: `goal_actual:${hash}:1`, json: JSON.stringify({ iterationsUsed: 80, exhausted: true, budget: { maxIterations: 80 } }) },
      { kind: `goal_actual:${hash}:2`, json: '{not json' },
      { kind: `goal_actual:${hash}:3`, json: JSON.stringify({ exhausted: true }) },
      { kind: `worker_actual:${hash}:4`, json: JSON.stringify({ iterationsUsed: 999 }) },
      { kind: `goal_actual:other:5`, json: JSON.stringify({ iterationsUsed: 999 }) },
    ]
    const samples = parseGoalActualRows(rows, hash)
    assert.equal(samples.length, 1)
    assert.equal(samples[0]!.iterationsUsed, 80)
    assert.equal(samples[0]!.exhausted, true)
  })

  it('空输入 = 无样本', () => {
    assert.deepEqual(parseGoalActualRows(undefined, 'h'), [])
    assert.deepEqual(parseGoalActualRows([], 'h'), [])
  })
})

describe('goal_actual 索引读写（往返）', () => {
  it('写入后能按同一 objective 读回，且不串到别的 objective', () => {
    const store = fakeStore()
    persistGoalActual(store, '把整个仓库的 lint 修干净', { iterationsUsed: 42, exhausted: false, budget: { maxIterations: 100 } })
    persistGoalActual(store, '另一个完全不同的任务', { iterationsUsed: 7, exhausted: true, budget: { maxIterations: 10 } })

    const samples = readGoalActualSamples(store, '把整个仓库的 lint 修干净')
    assert.equal(samples.length, 1)
    assert.equal(samples[0]!.iterationsUsed, 42)
    assert.equal(samples[0]!.exhausted, undefined)
    assert.equal(samples[0]!.budget?.maxIterations, 100)

    assert.equal(readGoalActualSamples(store, '另一个完全不同的任务').length, 1)
    assert.equal(readGoalActualSamples(store, '从未跑过的任务').length, 0)
  })

  it('store 缺席 / 写失败 / objective 为空一律静默降级', () => {
    assert.deepEqual(readGoalActualSamples(undefined, 'x'), [])
    assert.deepEqual(readGoalActualSamples(null, 'x'), [])
    assert.deepEqual(readGoalActualSamples(fakeStore(), ''), [])
    assert.doesNotThrow(() => persistGoalActual(undefined, 'x', { iterationsUsed: 1, exhausted: false, budget: { maxIterations: 10 } }))

    const broken = fakeStore()
    broken.failWrites = true
    assert.doesNotThrow(() => persistGoalActual(broken, 'x', { iterationsUsed: 1, exhausted: false, budget: { maxIterations: 10 } }))
  })

  it('key 形状：goal_actual:<hash>:<ts>', () => {
    assert.match(goalActualKey('deadbeef', 1700000000000), /^goal_actual:deadbeef:1700000000000$/)
  })
})

// 全链路（不 mock 中间层）：一次 run 的实际用量落索引 → 下一次同一 objective
// 启动前的定价读到它 → 预算被抬到地板之上。这正是 issue 里"评估不准"想解决的
// 问题的确定性版本。
describe('回馈闭环：实际用量 → 下次定价', () => {
  it('上次耗尽预算 → 下次同 objective 自动抬预算', () => {
    const store = fakeStore()
    const goal = '把 src 下所有模块的 typecheck 错误清干净'

    // 第一次：默认 100 轮，跑满并被 budget_exhausted 掐断
    const first = resolveGoalBudget({ goal })
    assert.equal(first!.maxIterations, GOAL_BUDGET_BASE)
    persistGoalActual(store, goal, { iterationsUsed: 100, exhausted: true, budget: { maxIterations: first!.maxIterations } })

    // 第二次：同一 objective 冷启动，历史样本经索引回灌
    const second = resolveGoalBudget({ goal }, () => readGoalActualSamples(store, goal))
    assert.equal(second!.maxIterations, Math.ceil(100 * 1.15 * 1.3))
    assert.ok(second!.maxIterations > first!.maxIterations, '耗尽过的任务必须拿到更高预算')
  })

  it('上次未逼近预算 → 不抬（没挨过墙的任务不该涨预算）', () => {
    const store = fakeStore()
    const goal = '改一行文案'
    persistGoalActual(store, goal, { iterationsUsed: 12, exhausted: false, budget: { maxIterations: 100 } })
    const d = resolveGoalBudget({ goal }, () => readGoalActualSamples(store, goal))
    assert.equal(d!.maxIterations, GOAL_BUDGET_BASE)
    assert.equal(d!.source, 'base')
  })

  it('显式 --budget 时不读历史（惰性 loader 不被调用）', () => {
    let called = 0
    const d = resolveGoalBudget({ goal: '随便一个任务', budget: 30 }, () => {
      called += 1
      return []
    })
    assert.equal(d!.maxIterations, 30)
    assert.equal(called, 0, '显式值短路，不应为它去开库')
  })

  it('历史 loader 抛错 = 没有历史（定价不受影响）', () => {
    const d = resolveGoalBudget({ goal: '修个错别字' }, () => { throw new Error('db unavailable') })
    assert.equal(d!.maxIterations, GOAL_BUDGET_BASE)
  })

  it('sizeGoalBudget 与索引样本的字段契约一致（直接喂解析结果）', () => {
    const store = fakeStore()
    persistGoalActual(store, 'g', { iterationsUsed: 90, exhausted: true, budget: { maxIterations: 90 } })
    const samples = readGoalActualSamples(store, 'g')
    const d = sizeGoalBudget({ goal: 'g', history: samples })
    assert.equal(d.maxIterations, Math.ceil(90 * 1.15 * 1.3))
  })
})
