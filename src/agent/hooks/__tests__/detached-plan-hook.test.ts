/**
 * detached-plan-hook —— plan_task 脱离等待后的 preTurn 通知（2026-09-21 回流补测）。
 *
 * 为什么补：本 hook 是「后台执行完成通知」的**唯一通道**——它坏了不会报错，
 * 只会让模型与用户永远等不到那条提醒（静默失效）。此前本体与装配点均零覆盖。
 *
 * 覆盖：
 *  - settle 通知：成败两种都投 system-reminder，失败条带 checkpoint 续跑指引；
 *  - 遗言只投一次：drain 即移除，第二次 run 不再投；
 *  - 运行中 awareness：informational + ttl:1，且 category 独立为 'detached-plan'
 *    ——回流偏差修正点（alpha 归在 'background'，会挤 MAX_PER_CATEGORY=2 的
 *    每类别预算，把其它后台提醒挤掉）；
 *  - session 隔离：多会话并发互不串扰；
 *  - 装配点：create-runtime-hooks 真有 hooks.push(createDetachedPlanHook(...))。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDetachedPlanHook } from '../detached-plan-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { PlanExecutorWavesResult } from '../../plan-executor.js'
import {
  clearDetachedPlanRuns,
  listDetachedPlanRuns,
  trackDetachedPlanRun,
} from '../../detached-plan-registry.js'

const SESSION = 'sess-detached-hook'

/** 收集型 sink：只实现 hook 依赖的 submit。 */
function makeSink() {
  const entries: AdvisoryEntry[] = []
  return { entries, bus: { submit: (e: AdvisoryEntry) => { entries.push(e) } } }
}

/** 让 execution 的 settle 回调跑完（trackDetachedPlanRun 内是异步 then）。 */
const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

/** 最小 PlanExecutorWavesResult stub：只喂 summarizeWavesResult 读的字段。 */
function fakeWavesResult(passed: number, failed = 0): PlanExecutorWavesResult {
  const results = [
    ...Array.from({ length: passed }, (_, i) => ({ workOrderId: `wo_p${i}`, status: 'passed', summary: 'ok' })),
    ...Array.from({ length: failed }, (_, i) => ({ workOrderId: `wo_f${i}`, status: 'failed', summary: 'boom' })),
  ]
  return {
    runs: [{}, {}],
    run: { summary: { run: { results } } },
  } as unknown as PlanExecutorWavesResult
}

function reg(obj: { objective: string; sessionId?: string }, execution: Promise<PlanExecutorWavesResult>) {
  return trackDetachedPlanRun(
    {
      sessionId: obj.sessionId ?? SESSION,
      objective: obj.objective,
      groupId: `grp-${obj.objective}`,
      startedAt: Date.now() - 5_000,
      timeoutMs: 600_000,
    },
    execution,
  )
}

describe('detached-plan-hook — settle 通知', () => {
  beforeEach(() => { clearDetachedPlanRuns(SESSION) })

  it('成功 settle → system-reminder，含计划名与「完成」语义', async () => {
    const { entries, bus } = makeSink()
    const exec = Promise.resolve(fakeWavesResult(3))
    reg({ objective: '重构 X 模块' }, exec)
    await exec
    await tick()

    createDetachedPlanHook({ advisoryBus: bus, sessionId: SESSION }).run({} as never)

    assert.equal(entries.length, 1, '一次 settle 只投一条')
    const e = entries[0]!
    assert.match(String(e.content), /后台计划执行完成/)
    assert.match(String(e.content), /重构 X 模块/)
    assert.equal(e.channel, 'system-reminder')
    assert.equal(e.srClass, 'functional')
    assert.equal(e.immediate, true)
  })

  it('失败 settle → 投递，且带 checkpoint 与续跑指引（模型能自救援）', async () => {
    const { entries, bus } = makeSink()
    const exec = Promise.reject(new Error('worker 全军覆没'))
    reg({ objective: '失败的编排' }, exec)
    await exec.catch(() => {})
    await tick()

    createDetachedPlanHook({ advisoryBus: bus, sessionId: SESSION }).run({} as never)

    assert.equal(entries.length, 1)
    const content = String(entries[0]!.content)
    assert.match(content, /后台计划执行失败/)
    assert.match(content, /team_orchestrate/)
    assert.match(content, /checkpoints\/grp-失败的编排\.json/)
  })

  it('遗言只投一次：drain 即移除，第二次 run 不再投', async () => {
    const { entries, bus } = makeSink()
    const exec = Promise.resolve(fakeWavesResult(1))
    reg({ objective: '一次性' }, exec)
    await exec
    await tick()

    const hook = createDetachedPlanHook({ advisoryBus: bus, sessionId: SESSION })
    hook.run({} as never)
    assert.equal(entries.length, 1)
    hook.run({} as never)
    assert.equal(entries.length, 1, '第二次 run 不得重复投递同一条遗言')
  })

  it('mixed 结果：摘要如实报通过数，并列出首个未通过', async () => {
    const { entries, bus } = makeSink()
    const exec = Promise.resolve(fakeWavesResult(2, 1))
    reg({ objective: '部分失败' }, exec)
    await exec
    await tick()

    createDetachedPlanHook({ advisoryBus: bus, sessionId: SESSION }).run({} as never)

    const content = String(entries[0]!.content)
    assert.match(content, /2\/3 worker 通过/)
    assert.match(content, /wo_f0/)
  })
})

describe('detached-plan-hook — 运行中 awareness 与隔离', () => {
  beforeEach(() => { clearDetachedPlanRuns(SESSION) })

  it('未 settle 条目 → informational + ttl:1 + 独立 category（回流偏差修正点）', () => {
    const { entries, bus } = makeSink()
    reg({ objective: '长跑计划' }, new Promise(() => { /* 永不 settle */ }))

    createDetachedPlanHook({ advisoryBus: bus, sessionId: SESSION }).run({} as never)

    const e = entries.find(x => x.key === 'detached-plan-running')
    assert.ok(e, '运行中应有 awareness 提醒')
    assert.equal(e.tier, 'informational')
    assert.equal(e.ttl, 1)
    assert.equal(e.category, 'detached-plan', "独立 category——归 'background' 会挤掉其它后台提醒")
    assert.match(String(e.content), /勿重复派发/)
  })

  it('session 隔离：A 会话的 run 不被 B 会话的 hook 看见', async () => {
    const exec = Promise.resolve(fakeWavesResult(1))
    reg({ objective: 'A 的计划', sessionId: 'sess-A' }, exec)
    await exec
    await tick()

    const { entries, bus } = makeSink()
    createDetachedPlanHook({ advisoryBus: bus, sessionId: 'sess-B' }).run({} as never)

    assert.equal(entries.length, 0, 'B 不得看到 A 的条目')
    // 且 A 的条目未被 B 的 drain 吞掉——B 跑完，A 仍能取到自己的遗言
    assert.equal(listDetachedPlanRuns('sess-A').length, 1)
    clearDetachedPlanRuns('sess-A')
  })
})

describe('detached-plan-hook — 装配接线', () => {
  it('create-runtime-hooks 真的 hooks.push 了该 hook（防死接线）', () => {
    const src = readFileSync(new URL('../../create-runtime-hooks.ts', import.meta.url), 'utf8')
    assert.match(src, /import \{ createDetachedPlanHook \} from '\.\/hooks\/detached-plan-hook\.js'/)
    assert.match(
      src,
      /hooks\.push\(createDetachedPlanHook\(\{ advisoryBus: deps\.advisoryBus, sessionId: deps\.sessionId \}\)\)/,
    )
  })
})
