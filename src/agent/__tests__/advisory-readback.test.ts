import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryReadback, type ObservedToolEvent } from '../advisory-readback.js'
import { AdvisoryBus, type AdvisoryExpectation } from '../advisory-bus.js'
import { createAdvisoryReadbackHooks, extractObservedTarget } from '../hooks/advisory-readback-hook.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'

function tool(turn: number, name: string, target = '', isError = false): ObservedToolEvent {
  return { turn, name, target, isError }
}

function deliver(rb: AdvisoryReadback, key: string, expect: AdvisoryExpectation, turn: number): void {
  rb.track([{ key, category: 'discipline', expect }], turn)
}

describe('AdvisoryReadback — 谓词矩阵（P1a 核销闭环）', () => {
  // ── tool_appears ──────────────────────────────────────────────

  it('tool_appears: 窗口内出现指定工具 → adopted', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'git-clear-after-fail', { kind: 'tool_appears', tools: ['read_file', 'grep'], withinTurns: 2 }, 5)
    rb.observeTool(tool(5, 'grep', 'src/foo.ts'))
    assert.equal(rb.evaluate(5), 1)
    const outcomes = rb.drainOutcomes()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]!.outcome, 'adopted')
    assert.equal(outcomes[0]!.expectKind, 'tool_appears')
  })

  it('tool_appears: 窗口到期未出现 → ignored', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'k', { kind: 'tool_appears', tools: ['read_file'], withinTurns: 2 }, 5)
    rb.observeTool(tool(5, 'bash', 'ls'))
    assert.equal(rb.evaluate(5), 0, '窗口未到期不判定')
    rb.observeTool(tool(6, 'edit_file', 'src/x.ts'))
    assert.equal(rb.evaluate(6), 1)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'ignored')
  })

  it('tool_appears: tools=[] 表示任意工具（无工具僵局打破 = tool_stops 反向谓词）', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'convergence', { kind: 'tool_appears', tools: [], withinTurns: 1 }, 3)
    rb.observeTool(tool(3, 'glob', '**/*.ts'))
    rb.evaluate(3)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  it('tool_appears: targetIncludes 约束 — 工具对了但目标不含片段 → 不算', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'external-claim-unverified', {
      kind: 'tool_appears', tools: ['read_file'], targetIncludes: 'src/agent/loop.ts', withinTurns: 1,
    }, 4)
    rb.observeTool(tool(4, 'read_file', 'src/tools/grep.ts'))
    rb.evaluate(4)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'ignored')
  })

  it('tool_appears: targetIncludes 命中 → adopted', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'external-claim-unverified', {
      kind: 'tool_appears', tools: ['read_file'], targetIncludes: 'src/agent/loop.ts', withinTurns: 1,
    }, 4)
    rb.observeTool(tool(4, 'read_file', '/abs/path/src/agent/loop.ts'))
    rb.evaluate(4)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  // ── verify_attempted ─────────────────────────────────────────

  it('verify_attempted: run_tests 出现 → adopted', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'ccr-瑶光-P1', { kind: 'verify_attempted', withinTurns: 2 }, 7)
    rb.observeTool(tool(7, 'run_tests', 'src/agent/__tests__/x.test.ts'))
    rb.evaluate(7)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  it('verify_attempted: bash 测试命令（npm test / tsc）也算', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'a', { kind: 'verify_attempted', withinTurns: 1 }, 2)
    rb.observeTool(tool(2, 'bash', 'npm run typecheck'))
    rb.evaluate(2)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')

    deliver(rb, 'b', { kind: 'verify_attempted', withinTurns: 1 }, 3)
    rb.observeTool(tool(3, 'bash', 'git status'))
    rb.evaluate(3)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'ignored')
  })

  // ── file_touched ─────────────────────────────────────────────

  it('file_touched: 目标路径被工具触达 → adopted', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'k', { kind: 'file_touched', paths: ['src/agent/loop.ts'], withinTurns: 1 }, 1)
    rb.observeTool(tool(1, 'edit_file', 'src/agent/loop.ts'))
    rb.evaluate(1)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  // ── course_changed（B1/M4 改道核销） ──────────────────────────

  // 2026-10-10 方向 3（狂轰事故 20261009c40f5c2262ea）：旧实现 read/edit 带文件面进签名，
  // 活跃会话每轮自然换文件 → 「前置窗未见过的新签名」恒真 → 每张卡假采纳续命
  // （现场 5/8 adopted，efficacy/习惯化静默被反复清零）。收紧为族级签名：
  // 换文件面（同族）不再计采纳——改道的定义回到「换了种做法」。
  it('course_changed: 换文件面（同族）不再计采纳——族级签名（方向3）', () => {
    const rb = new AdvisoryReadback()
    rb.observeTool(tool(8, 'read_file', 'src/a.ts'))
    rb.observeTool(tool(9, 'read_file', 'src/a.ts'))
    deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 10)
    rb.observeTool(tool(10, 'read_file', 'src/b.ts'))
    assert.equal(rb.evaluate(10), 0, '窗口未到期不判定')
    assert.equal(rb.evaluate(11), 1)
    const o = rb.drainOutcomes()[0]!
    assert.equal(o.outcome, 'ignored')
    assert.equal(o.expectKind, 'course_changed')
  })

  // 计划 §6 矩阵行：反复「读三轮 → 同一失败验证」跨六周期只首次核销——滚动的
  // 「前 3 轮」窗口会遗忘旧策略，让同一失败验证每周期重新变「新」（实测回归形态：
  // 父提交六次 ignored ↔ 族级签名六次 adopted）。
  it('course_changed: 六周期「读三轮 → 同一失败验证」只首次核销（核销周期）', () => {
    const rb = new AdvisoryReadback()
    let adopted = 0
    for (let cycle = 0; cycle < 6; cycle++) {
      const base = cycle * 6 + 1
      rb.observeTool(tool(base, 'read_file', `m${base}.ts`))
      rb.observeTool(tool(base + 1, 'read_file', `l${base}.ts`))
      rb.observeTool(tool(base + 2, 'bash', `sed -n 1,40p s${base}.sh`))
      deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, base + 3)
      rb.observeTool(tool(base + 3, 'bash', 'npm test'))
      rb.evaluate(base + 3)
      rb.evaluate(base + 4)
      for (const o of rb.drainOutcomes()) if (o.outcome === 'adopted') adopted++
    }
    assert.equal(adopted, 1, `同一失败验证重复六周期只应首次核销，得 ${adopted}`)
  })

  it('course_changed: bash 只读循环 → 验证类 bash（verify 族）→ adopted（bash 细分）', () => {
    const rb = new AdvisoryReadback()
    rb.observeTool(tool(8, 'bash', 'sed -n 1,20p scripts/x.sh'))
    rb.observeTool(tool(9, 'bash', 'sed -n 21,40p scripts/x.sh'))
    deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 10)
    rb.observeTool(tool(10, 'bash', 'npm run test:unit'))
    assert.equal(rb.evaluate(10), 1)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  it('course_changed: 换工具族（前置窗只读 a.ts,观察窗改写 a.ts）→ adopted', () => {
    const rb = new AdvisoryReadback()
    rb.observeTool(tool(9, 'read_file', 'src/a.ts'))
    deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 10)
    rb.observeTool(tool(10, 'edit_file', 'src/a.ts'))
    rb.evaluate(10)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  it('course_changed: 观察窗仍是同一签名（同族同文件）→ 到期 ignored', () => {
    const rb = new AdvisoryReadback()
    rb.observeTool(tool(9, 'read_file', 'src/a.ts'))
    deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 10)
    rb.observeTool(tool(10, 'read_file', 'src/a.ts'))
    assert.equal(rb.evaluate(10), 0, '窗口未到期不判定')
    rb.observeTool(tool(11, 'grep', 'src/a.ts')) // grep 与 read_file 同 read 族+同文件 = 同签名
    assert.equal(rb.evaluate(11), 1)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'ignored')
  })

  it('course_changed: 前置窗无事件（no-tool 僵局）→ 观察窗任意工具即 adopted', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 3)
    rb.observeTool(tool(3, 'glob', '**/*.ts'))
    rb.evaluate(3)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  it('course_changed: 观察窗到期无任何事件 → ignored', () => {
    const rb = new AdvisoryReadback()
    rb.observeTool(tool(9, 'read_file', 'src/a.ts'))
    deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 10)
    assert.equal(rb.evaluate(10), 0)
    assert.equal(rb.evaluate(11), 1)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'ignored')
  })

  // ── pattern_absent（负向谓词） ─────────────────────────────────

  it('pattern_absent: 到期时 needle 已不在文件 → adopted;还在 → ignored', () => {
    let content: string | null = 'const x = 1\nconsole.log("debug probe")\n'
    const rb = new AdvisoryReadback(() => content)
    deliver(rb, 'probe-tracking', {
      kind: 'pattern_absent', path: 'src/x.ts', needles: ['console.log("debug probe")'], withinTurns: 3,
    }, 10)

    // 到期前不判定（过早读文件会把"还没来得及清"误判为忽略）
    assert.equal(rb.evaluate(10), 0)
    assert.equal(rb.evaluate(11), 0)

    // 到期时探针已清 → adopted
    content = 'const x = 1\n'
    assert.equal(rb.evaluate(12), 1)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  it('pattern_absent: 到期时 needle 仍在 → ignored', () => {
    const rb = new AdvisoryReadback(() => 'console.log("probe")\n')
    deliver(rb, 'probe-tracking', {
      kind: 'pattern_absent', path: 'src/x.ts', needles: ['console.log("probe")'], withinTurns: 1,
    }, 5)
    rb.evaluate(5)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'ignored')
  })

  it('pattern_absent: 文件已删除（readFile 返回 null）→ adopted', () => {
    const rb = new AdvisoryReadback(() => null)
    deliver(rb, 'probe-tracking', {
      kind: 'pattern_absent', path: 'src/gone.ts', needles: ['debugger'], withinTurns: 1,
    }, 5)
    rb.evaluate(5)
    assert.equal(rb.drainOutcomes()[0]!.outcome, 'adopted')
  })

  // ── 统计与习惯化信号 ───────────────────────────────────────────

  it('ignoredStreak 连续累计,adopted 时清零（P1b 习惯化对抗输入）', () => {
    const rb = new AdvisoryReadback()
    for (const turn of [1, 2]) {
      deliver(rb, 'k', { kind: 'tool_appears', tools: ['run_tests'], withinTurns: 1 }, turn)
      rb.evaluate(turn)
    }
    assert.equal(rb.getIgnoredStreak('k'), 2)

    deliver(rb, 'k', { kind: 'tool_appears', tools: ['run_tests'], withinTurns: 1 }, 3)
    rb.observeTool(tool(3, 'run_tests'))
    rb.evaluate(3)
    assert.equal(rb.getIgnoredStreak('k'), 0)

    const stats = rb.getStats().get('k')!
    assert.equal(stats.delivered, 3)
    assert.equal(stats.adopted, 1)
    assert.equal(stats.ignored, 2)
  })

  it('同 key 重复送达重置观察窗口而非叠加 pending', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'k', { kind: 'tool_appears', tools: ['grep'], withinTurns: 1 }, 1)
    deliver(rb, 'k', { kind: 'tool_appears', tools: ['grep'], withinTurns: 1 }, 2)
    rb.observeTool(tool(2, 'grep', 'x'))
    assert.equal(rb.evaluate(2), 1, '只有一条 pending,不重复判定')
    assert.equal(rb.drainOutcomes().length, 1)
  })

  it('无 expect 的送达只计 delivered,不产生判定', () => {
    const rb = new AdvisoryReadback()
    rb.track([{ key: 'plain', category: 'discipline' }], 1)
    assert.equal(rb.evaluate(1), 0)
    assert.equal(rb.getStats().get('plain')!.delivered, 1)
  })

  it('getTotals 汇总跨 key 的采纳/忽略', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'a', { kind: 'tool_appears', tools: [], withinTurns: 1 }, 1)
    rb.observeTool(tool(1, 'grep'))
    rb.evaluate(1)
    deliver(rb, 'b', { kind: 'tool_appears', tools: ['run_tests'], withinTurns: 1 }, 2)
    rb.evaluate(2)
    assert.deepEqual(rb.getTotals(), { adopted: 1, ignored: 1 })
  })
})

describe('AdvisoryBus.drainDelivered — 送达快照（P1a）', () => {
  it('render 输出的条目（含 expect）进入 delivered,drain 后清空', () => {
    const bus = new AdvisoryBus()
    bus.submit({
      key: 'k1', priority: 0.6, category: 'discipline', content: 'x',
      expect: { kind: 'verify_attempted', withinTurns: 2 },
    })
    bus.submit({ key: 'k2', priority: 0.5, category: 'star_domain', content: 'y' })
    bus.render()

    const delivered = bus.drainDelivered()
    assert.equal(delivered.length, 2)
    const k1 = delivered.find(d => d.key === 'k1')!
    assert.equal(k1.expect?.kind, 'verify_attempted')
    assert.equal(bus.drainDelivered().length, 0, 'drain 后清空')
  })

  it('被预算挤掉的条目不进 delivered（未送达不核销）', () => {
    const bus = new AdvisoryBus()
    // 5 条同类 operational — MAX_PER_CATEGORY=2 会挤掉 3 条
    for (let i = 0; i < 5; i++) {
      bus.submit({ key: `k${i}`, priority: 0.5 + i * 0.01, category: 'discipline', content: `c${i}` })
    }
    bus.render()
    const delivered = bus.drainDelivered()
    assert.equal(delivered.length, 2, '只有实际渲染的 2 条进 delivered')
  })
})

describe('AdvisoryBus 习惯化对抗（P1b）', () => {
  function busWithStreak(streaks: Record<string, number>): AdvisoryBus {
    const bus = new AdvisoryBus()
    bus.setHabituationPolicy({ getIgnoredStreak: k => streaks[k] ?? 0 })
    return bus
  }

  it('streak >= 2：升级措辞 — 条目前标注连续未执行次数', () => {
    const bus = busWithStreak({ k: 2 })
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', expect: { kind: 'verify_attempted' }, content: '先验证再继续' })
    const out = bus.render()
    assert.ok(out.includes('已连续 2 次未见执行'), `expected escalation prefix, got: ${out}`)
    assert.ok(out.includes('先验证再继续'), '原文保留')
  })

  it('streak >= 3：静音 N 个渲染周期,期满 probation 放行一次', () => {
    const streaks: Record<string, number> = { k: 3 }
    const bus = busWithStreak(streaks)

    // 第 1 次渲染:触发静音（本轮即被过滤）
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', expect: { kind: 'verify_attempted' }, content: 'x' })
    assert.ok(!bus.render().includes('key="k"'), '静音起始轮被过滤')

    // 静音期内持续投递,持续被过滤（HABITUATION_SILENCE_RENDERS=4,起始轮算第 1 个）
    for (let i = 0; i < 3; i++) {
      bus.submit({ key: 'k', priority: 0.6, category: 'discipline', expect: { kind: 'verify_attempted' }, content: 'x' })
      assert.ok(!bus.render().includes('key="k"'), `静音期第 ${i + 2} 轮仍被过滤`)
    }

    // 期满 probation:同 streak 不再触发新静音 → 放行（带升级措辞）
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', expect: { kind: 'verify_attempted' }, content: 'x' })
    const out = bus.render()
    assert.ok(out.includes('key="k"'), `probation 轮应放行,got: ${out}`)

    // streak 加深（放行后又被忽略）→ 再次静音
    streaks.k = 4
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', expect: { kind: 'verify_attempted' }, content: 'x' })
    assert.ok(!bus.render().includes('key="k"'), 'streak 加深触发新一轮静音')
  })

  it('constitutional tier 永不静音也不改写', () => {
    const bus = busWithStreak({ 'git-clear-after-fail': 5 })
    bus.submit({
      key: 'git-clear-after-fail', priority: 0.9, category: 'constitutional',
      tier: 'constitutional', content: '⚠ 硬闸门',
    })
    const out = bus.render()
    assert.ok(out.includes('⚠ 硬闸门'), '宪法条目照常渲染')
    assert.ok(!out.includes('未见执行'), '措辞不被改写')
  })

  it('静音丢弃计入投递账本（不静默消失）', () => {
    const bus = busWithStreak({ k: 3 })
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', expect: { kind: 'verify_attempted' }, content: 'x' })
    bus.render()
    const ledger = bus.drainLedger()
    assert.ok(ledger.droppedKeys.includes('k'), `dropped keys 应含被静音的 k,got: ${JSON.stringify(ledger.droppedKeys)}`)
  })

  it('无 habituation policy 时行为不变（向后兼容）', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', expect: { kind: 'verify_attempted' }, content: 'plain' })
    const out = bus.render()
    assert.ok(out.includes('plain'))
    assert.ok(!out.includes('未见执行'))
  })
})

describe('advisory-readback-hook — 运行时接线', () => {
  function ctxAt(turn: number): RuntimeHookContext {
    return {
      snapshot: { cwd: '/tmp', turn, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null },
      effects: {
        setSensorium() {}, setStrategy() {}, setVigor() {}, setGitChangeRate() {},
        injectUserMessage() {}, requestThetaCheck() {}, emitPhaseChange() {},
        emitDecisionShift() {}, markClaimStale() {},
      },
    }
  }

  it('postTool 观察 + postTurn 核销 + 遥测/totals 回调', () => {
    const rb = new AdvisoryReadback()
    const telemetry: Array<Record<string, unknown>> = []
    let totals: { adopted: number; ignored: number } | null = null
    const [observer, evaluator] = createAdvisoryReadbackHooks({
      readback: rb,
      writeTelemetry: r => telemetry.push(r),
      onOutcomes: t => { totals = t },
    })

    deliver(rb, 'ccr-瑶光-P1', { kind: 'verify_attempted', withinTurns: 1 }, 3)
    observer.run(ctxAt(3), { name: 'run_tests', success: true, input: {} })
    evaluator.run(ctxAt(3))

    assert.equal(telemetry.length, 1)
    assert.equal(telemetry[0]!.kind, 'advisory-outcome')
    assert.equal(telemetry[0]!.outcome, 'adopted')
    assert.deepEqual(totals, { adopted: 1, ignored: 0 })
  })

  it('无判定时不写遥测不回调', () => {
    const rb = new AdvisoryReadback()
    const telemetry: unknown[] = []
    let called = false
    const [, evaluator] = createAdvisoryReadbackHooks({
      readback: rb,
      writeTelemetry: r => telemetry.push(r),
      onOutcomes: () => { called = true },
    })
    evaluator.run(ctxAt(1))
    assert.equal(telemetry.length, 0)
    assert.equal(called, false)
  })

  it('extractObservedTarget: bash → command,写类 → file_path,grep → pattern', () => {
    assert.equal(extractObservedTarget({ name: 'bash', success: true, input: { command: 'npm test' } }), 'npm test')
    assert.equal(extractObservedTarget({ name: 'edit_file', success: true, input: { file_path: 'src/a.ts' } }), 'src/a.ts')
    assert.equal(extractObservedTarget({ name: 'grep', success: true, input: { pattern: 'foo' } }), 'foo')
    assert.equal(extractObservedTarget({ name: 'x', success: true, target: 't' }), 't')
  })

  // CVM-vector v3.1：recall_capsule 的 star 字段结构化提取——
  // 没有它 tool_appears+targetIncludes('天璇') 谓词恒空串不匹配（伪 expect）
  it('extractObservedTarget: recall_capsule → star 字段', () => {
    assert.equal(extractObservedTarget({ name: 'recall_capsule', success: true, input: { star: '天璇' } }), '天璇')
  })

  it('tool_appears+targetIncludes(star) 经 recall_capsule 事件可核销', () => {
    const rb = new AdvisoryReadback()
    const [observer, evaluator] = createAdvisoryReadbackHooks({ readback: rb })
    deliver(rb, 'cvm-vector-天璇-CV2', { kind: 'tool_appears', tools: ['recall_capsule'], targetIncludes: '天璇', withinTurns: 3 }, 5)
    observer.run(ctxAt(6), { name: 'recall_capsule', success: true, input: { star: '天璇' } })
    evaluator.run(ctxAt(6))
    const stats = rb.getStats().get('cvm-vector-天璇-CV2')
    assert.equal(stats?.adopted, 1)
    assert.equal(stats?.ignored, 0)
  })

  it('tool_appears+targetIncludes(star) 召回别的星域不算采纳', () => {
    const rb = new AdvisoryReadback()
    const [observer, evaluator] = createAdvisoryReadbackHooks({ readback: rb })
    deliver(rb, 'cvm-vector-天璇-CV2', { kind: 'tool_appears', tools: ['recall_capsule'], targetIncludes: '天璇', withinTurns: 1 }, 5)
    observer.run(ctxAt(5), { name: 'recall_capsule', success: true, input: { star: '瑶光' } })
    evaluator.run(ctxAt(5))
    const stats = rb.getStats().get('cvm-vector-天璇-CV2')
    assert.equal(stats?.adopted, 0)
    assert.equal(stats?.ignored, 1)
  })
})


// ── §3 周期边界发射侧贯通：旧周期未决项不算"听了不做"，episode streak 不跨任务
// 继承成永久门禁，相关 key 拿一次再投递机会 ──
describe('周期边界发射侧贯通（§3）', () => {
  it('startCourseEpisode：旧 episode 未决观察记 superseded，不判成新周期的 ignored', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 5)
    rb.startCourseEpisode('human-task')
    const un = rb.drainUnresolved()
    assert.equal(un.length, 1, '旧周期未决项应转 unresolved 报出')
    assert.equal(un[0]!.reason, 'superseded')
    assert.equal(un[0]!.key, 'convergence')
  })

  it('startCourseEpisode：episode ignoredStreak 归零，会话累计计数保留', () => {
    const rb = new AdvisoryReadback()
    deliver(rb, 'convergence', { kind: 'tool_appears', tools: ['edit_file'], withinTurns: 1 }, 1)
    assert.equal(rb.evaluate(2), 1, '窗口到期应判定')
    assert.equal(rb.getIgnoredStreak('convergence'), 1)
    rb.startCourseEpisode('human-task')
    assert.equal(rb.getIgnoredStreak('convergence'), 0, '新任务不继承旧 streak（不成为永久门禁）')
    assert.equal(rb.getTotals().ignored, 1, '会话累计计数保留（不调用全局 reset）')
  })

  it('startCourseEpisode：只返回本周期实际投递过的 key（shadow 不算）', () => {
    const rb = new AdvisoryReadback()
    rb.track([{ key: 'a', category: 'discipline', expect: { kind: 'course_changed', withinTurns: 1 } }], 3)
    rb.track([{ key: 'b', category: 'discipline', expect: { kind: 'course_changed', withinTurns: 1 }, shadow: true }], 3)
    assert.deepEqual(rb.startCourseEpisode('human-task'), ['a'], '只有真实投递过的 key 拿二次机会')
  })
})

it('course episode leaves unrelated obligations and streaks intact', () => {
  const rb = new AdvisoryReadback()
  deliver(rb, 'self-verify', { kind: 'verify_attempted', withinTurns: 1 }, 1)
  rb.evaluate(2)
  assert.equal(rb.getIgnoredStreak('self-verify'), 1)
  deliver(rb, 'self-verify', { kind: 'verify_attempted', withinTurns: 2 }, 3)
  deliver(rb, 'convergence', { kind: 'course_changed', withinTurns: 2 }, 3)
  assert.deepEqual(rb.startCourseEpisode('human-follow-up'), ['convergence'])
  assert.equal(rb.getIgnoredStreak('self-verify'), 1)
  assert.deepEqual(rb.drainUnresolved().map(p => p.key), ['convergence'])
  rb.observeTool({ turn: 4, name: 'run_tests', target: '', isError: false })
  rb.evaluate(4)
  assert.equal(rb.drainOutcomes().at(-1)?.key, 'self-verify')
  rb.reset()
  assert.deepEqual(rb.startCourseEpisode('human-task'), [])
})
