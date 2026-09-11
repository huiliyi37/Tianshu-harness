import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, DISCIPLINE_REANCHOR_INTERVAL, disciplineReanchorEntry, virtueEncouragementEntry, KEY_COOLDOWN_TURNS } from '../advisory-bus.js'
import type { AdvisoryEntry } from '../advisory-bus.js'

describe('AdvisoryBus', () => {
  it('renders empty when no entries', () => {
    const bus = new AdvisoryBus()
    assert.equal(bus.render(), '')
  })

  it('renders single entry as 星域-advisory XML', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'test', priority: 0.8, category: 'repair', content: 'check file X' })
    const result = bus.render()
    assert.match(result, /<星域-advisory>/)
    assert.match(result, /<entry key="test"/)
    assert.match(result, /check file X/)
    assert.match(result, /<\/星域-advisory>/)
  })

  it('deduplicates by key — keeps highest priority', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'dup', priority: 0.5, category: 'repair', content: 'low' })
    bus.submit({ key: 'dup', priority: 0.9, category: 'immune', content: 'high' })
    const result = bus.render()
    assert.match(result, /high/)
    assert.ok(!result.includes('low'), 'low priority entry should be deduped out')
  })

  it('limits to max 3 entries per turn (Top-3 by priority)', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.3, category: 'repair', content: 'A' })
    bus.submit({ key: 'b', priority: 0.9, category: 'immune', content: 'B' })
    bus.submit({ key: 'c', priority: 0.5, category: 'mistake', content: 'C' })
    bus.submit({ key: 'd', priority: 0.7, category: 'dedup', content: 'D' })
    bus.submit({ key: 'e', priority: 0.1, category: 'dead_end', content: 'E' })
    const result = bus.render()
    // Top 3 by priority: B(0.9), D(0.7), C(0.5)
    assert.match(result, /B/)
    assert.match(result, /D/)
    assert.match(result, /C/)
    assert.ok(!result.includes('A'), 'A (0.3) should be dropped')
    assert.ok(!result.includes('E'), 'E (0.1) should be dropped')
    // Count <entry> tags
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 3)
  })

  it('TTL > 1 keeps entry alive across renders', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'persist', priority: 0.8, category: 'repair', content: 'persistent hint', ttl: 2 })
    const r1 = bus.render()
    assert.match(r1, /persistent hint/)
    // Next render — entry should still be alive (ttl decremented to 1)
    const r2 = bus.render()
    assert.match(r2, /persistent hint/)
    // Third render — ttl exhausted, entry gone
    const r3 = bus.render()
    assert.ok(!r3.includes('persistent hint'), 'TTL exhausted entry should be gone')
  })

  it('reset clears all state including alive entries', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'x', priority: 0.8, category: 'repair', content: 'X', ttl: 5 })
    bus.render()
    bus.reset()
    assert.equal(bus.render(), '')
  })

  it('XML special characters are escaped in content', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'esc', priority: 0.8, category: 'repair', content: 'use <file> & "path"' })
    const result = bus.render()
    assert.match(result, /&lt;file&gt;/)
    assert.match(result, /&amp;/)
    assert.match(result, /&quot;path&quot;/)
  })

  it('renders empty after consuming all entries', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'once', priority: 0.5, category: 'mistake', content: 'one time' })
    const r1 = bus.render()
    assert.match(r1, /one time/)
    const r2 = bus.render()
    assert.equal(r2, '')
  })
})

describe('W2 efficacy 负反馈环 (incident 20b9714e)', () => {
  /** 模拟真实接线：render 送达后 delivered++（AdvisoryReadback.track 的会话统计半边） */
  function makeStatsHarness(bus: AdvisoryBus) {
    const stats = new Map<string, { delivered: number; adopted: number }>()
    bus.setEfficacyStatsProvider(key => stats.get(key) ?? null)
    const trackDelivered = () => {
      for (const d of bus.drainDelivered()) {
        const s = stats.get(d.key) ?? { delivered: 0, adopted: 0 }
        s.delivered++
        stats.set(d.key, s)
      }
    }
    return { stats, trackDelivered }
  }

  it('zero-adoption key: cooldown doubles from the 4th delivery, session-silenced after the 6th', () => {
    const bus = new AdvisoryBus()
    const { trackDelivered } = makeStatsHarness(bus)

    const deliveredAtCycle: number[] = []
    for (let cycle = 1; cycle <= 32; cycle++) {
      bus.submit({ key: 'convergence', priority: 0.65, category: 'discipline', content: '请收敛' })
      const out = bus.render(undefined, cycle)
      if (out.includes('key="convergence"')) deliveredAtCycle.push(cycle)
      trackDelivered()
    }

    // 前 3 次无阻拦；第 4 次起进入冷却翻倍;delivered 到 6 后本会话静默。
    assert.deepEqual(deliveredAtCycle.slice(0, 3), [1, 2, 3], 'first three deliveries unthrottled')
    assert.equal(deliveredAtCycle.length, 6, `delivered cap must be 6, got ${deliveredAtCycle.length} at ${deliveredAtCycle}`)
    const gap45 = deliveredAtCycle[4]! - deliveredAtCycle[3]!
    const gap56 = deliveredAtCycle[5]! - deliveredAtCycle[4]!
    assert.ok(gap56 > gap45, `cooldown must double between deliveries: gaps ${gap45} → ${gap56}`)
    assert.ok(bus.isEfficacySilenced('convergence'), 'key must be session-silenced after 6 zero-adoption deliveries')
  })

  it('adopted key is never throttled or silenced', () => {
    const bus = new AdvisoryBus()
    const { stats, trackDelivered } = makeStatsHarness(bus)
    stats.set('helpful', { delivered: 10, adopted: 2 })

    let rendered = 0
    for (let cycle = 1; cycle <= 10; cycle++) {
      bus.submit({ key: 'helpful', priority: 0.6, category: 'repair', content: '有效提醒' })
      if (bus.render(undefined, cycle).includes('key="helpful"')) rendered++
      trackDelivered()
    }
    assert.equal(rendered, 10, 'adopted > 0 exempts the key from the feedback loop')
    assert.equal(bus.isEfficacySilenced('helpful'), false)
  })

  it('constitutional / high-priority entries are fail-open exempt', () => {
    const bus = new AdvisoryBus()
    const { stats, trackDelivered } = makeStatsHarness(bus)
    stats.set('guard', { delivered: 20, adopted: 0 })
    stats.set('hi-pri', { delivered: 20, adopted: 0 })

    let guardRendered = 0
    let hiPriRendered = 0
    for (let cycle = 1; cycle <= 8; cycle++) {
      bus.submit({ key: 'guard', priority: 0.9, category: 'constitutional', tier: 'constitutional', content: '宪法级' })
      bus.submit({ key: 'hi-pri', priority: 0.85, category: 'repair', content: '高优先级' })
      const out = bus.render(undefined, cycle)
      if (out.includes('key="guard"')) guardRendered++
      if (out.includes('key="hi-pri"')) hiPriRendered++
      trackDelivered()
    }
    assert.equal(guardRendered, 8, 'constitutional tier must never be silenced')
    assert.equal(hiPriRendered, 8, 'priority >= 0.8 must never be silenced')
  })

  it('no provider wired → loop is inert (backwards compatible)', () => {
    const bus = new AdvisoryBus()
    let rendered = 0
    for (let cycle = 1; cycle <= 10; cycle++) {
      bus.submit({ key: 'legacy', priority: 0.6, category: 'repair', content: '旧行为' })
      if (bus.render(undefined, cycle).includes('key="legacy"')) rendered++
    }
    assert.equal(rendered, 10)
  })
})

describe('W6 CVM overhead throttle — Wave 2 统一注入预算', () => {
  it('throttled: budget = 1, only 1 non-exempt entry per render', () => {
    const bus = new AdvisoryBus()
    bus.setOverheadThrottled(true)
    // Submit 3 non-exempt entries — budget of 1 should keep only top-priority one
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'A' })
    bus.submit({ key: 'b', priority: 0.5, category: 'repair', content: 'B' })
    bus.submit({ key: 'c', priority: 0.4, category: 'mistake', content: 'C' })
    const out = bus.render(undefined, 1)
    assert.ok(out.includes('key="a"'), 'top priority non-exempt rendered')
    assert.ok(!out.includes('key="b"'), 'lower priority pruned by budget')
    assert.ok(!out.includes('key="c"'), 'lower priority pruned by budget')
  })

  it('throttled: constitutional / immediate entries exempt from budget', () => {
    const bus = new AdvisoryBus()
    bus.setOverheadThrottled(true)
    // 1 constitutional + 2 non-exempt → constitutional exempt, 1 non-exempt slot
    bus.submit({ key: 'guard', priority: 0.9, tier: 'constitutional', category: 'constitutional', content: 'G' })
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'A' })
    bus.submit({ key: 'b', priority: 0.5, category: 'repair', content: 'B' })
    const out = bus.render(undefined, 1)
    assert.ok(out.includes('key="guard"'), 'constitutional exempt from budget')
    assert.ok(out.includes('key="a"'), 'one non-exempt slot available')
    assert.ok(!out.includes('key="b"'), 'second non-exempt pruned')
  })

  it('unthrottled: budget = 3, all 3 non-exempt entries render', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'A' })
    bus.submit({ key: 'b', priority: 0.5, category: 'repair', content: 'B' })
    bus.submit({ key: 'c', priority: 0.4, category: 'mistake', content: 'C' })
    bus.submit({ key: 'd', priority: 0.3, category: 'dedup', content: 'D' })
    const out = bus.render(undefined, 1)
    assert.ok(out.includes('key="a"'))
    assert.ok(out.includes('key="b"'))
    assert.ok(out.includes('key="c"'))
    assert.ok(!out.includes('key="d"'), '4th entry pruned by Top-3 cap (not budget)')
  })
})

describe('discipline re-anchor (F-fix, session 803d897d)', () => {
  it('exposes a sane re-anchor interval', () => {
    assert.ok(DISCIPLINE_REANCHOR_INTERVAL >= 10 && DISCIPLINE_REANCHOR_INTERVAL <= 30)
  })

  it('renders the discipline summary through the bus, deduped by key', () => {
    const bus = new AdvisoryBus()
    bus.submit(disciplineReanchorEntry())
    bus.submit(disciplineReanchorEntry())
    const rendered = bus.render()
    assert.match(rendered, /category="discipline"/)
    assert.ok(rendered.includes('闭环') || rendered.includes('接线') || rendered.includes('自检') || rendered.includes('节奏') || rendered.includes('分波'), 'discipline content must contain core keyword')
    const occurrences = rendered.split('discipline-reanchor').length - 1
    assert.equal(occurrences, 1, 'same-key entries must dedupe to one line')
  })

  it('does not crowd out higher-priority corrective advisories', () => {
    const bus = new AdvisoryBus()
    bus.submit(disciplineReanchorEntry())
    bus.submit({ key: 'immune-1', priority: 0.9, category: 'immune', content: 'stop repeating failed edit' })
    bus.submit({ key: 'repair-1', priority: 0.8, category: 'repair', content: 'fix type error first' })
    bus.submit({ key: 'dedup-1', priority: 0.7, category: 'dedup', content: 'duplicate output detected' })
    const rendered = bus.render()
    assert.match(rendered, /immune-1/)
    assert.match(rendered, /repair-1/)
    assert.match(rendered, /dedup-1/)
    assert.doesNotMatch(rendered, /discipline-reanchor/, 'discipline anchor yields to top-3 corrective signals')
  })

  it('discipline variants rotate content for anti-habituation', () => {
    const contents = new Set<string>()
    for (let i = 0; i < 30; i++) {
      contents.add(disciplineReanchorEntry().content)
    }
    assert.ok(contents.size >= 2, `expected >=2 unique variants but got ${contents.size}`)
  })
})

// 2026-07-04：deprecated stalenessGateEntry / vigorLowEntry 死代码已删除
//（零生产调用方，宣称的 CCR P2 替代早已被裁）。胶囊召回改为 CCR 触发的
// 一等附属，见 cognitive-capsule-router.test.ts。

describe('star-domain render filter (2026-07-04 触发面修复)', () => {
  it('suppresses static same-domain manifesto entries (frozen-base duplicates)', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'discipline-reanchor', priority: 0.55, category: 'discipline', content: '【天权】静态宣言内容' })
    const rendered = bus.render('天权')
    assert.doesNotMatch(rendered, /discipline-reanchor/, '同星域静态条目应被冻结区 persona 顶掉')
  })

  it('does NOT suppress situational star_domain entries for the active domain', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'ccr-天权-P7', priority: 0.65, category: 'star_domain', content: '【天权】验证连续失败 2 次。换维度。' })
    bus.submit({ key: 'capsule-recall', priority: 0.45, category: 'star_domain', tier: 'informational', content: '【天权·胶囊】方法论 gist——recall_capsule("天权")。' })
    const rendered = bus.render('天权')
    assert.match(rendered, /ccr-天权-P7/, '同星域的情境性改道提醒不是宣言重复，必须渲染')
    assert.match(rendered, /capsule-recall/, '胶囊召回条目同样豁免')
  })

  it('star_domain category does not compete with discipline for MAX_PER_CATEGORY', () => {
    const bus = new AdvisoryBus()
    // 2 条 discipline 吃满类别预算
    bus.submit({ key: 'd1', priority: 0.9, category: 'discipline', content: 'D1' })
    bus.submit({ key: 'd2', priority: 0.85, category: 'discipline', content: 'D2' })
    // CCR 条目在独立类别 — 不再被 discipline 上限挤掉
    bus.submit({ key: 'ccr-瑶光-P1', priority: 0.55, category: 'star_domain', content: '【瑶光】去验证' })
    const rendered = bus.render()
    assert.match(rendered, /ccr-瑶光-P1/, 'star_domain 独立类别，不受 discipline MAX_PER_CATEGORY 影响')
  })
})

describe('advisory delivery ledger (Phase 0 观测)', () => {
  it('counts submitted, rendered and dropped entries', () => {
    const bus = new AdvisoryBus()
    for (let i = 0; i < 5; i++) {
      bus.submit({ key: `op-${i}`, priority: 0.9 - i * 0.1, category: 'repair', content: `OP-${i}` })
    }
    bus.render()
    const ledger = bus.drainLedger()
    assert.equal(ledger.submitted, 5)
    // repair 类别上限 2 → 渲染 2，丢 3
    assert.equal(ledger.rendered, 2)
    assert.equal(ledger.dropped, 3)
    assert.ok(ledger.droppedKeys.includes('op-2'))
  })

  it('drainLedger resets counters', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.5, category: 'repair', content: 'A' })
    bus.render()
    bus.drainLedger()
    const second = bus.drainLedger()
    assert.equal(second.submitted, 0)
    assert.equal(second.rendered, 0)
    assert.equal(second.dropped, 0)
  })

  it('records star-domain filter drops', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'static-persona', priority: 0.5, category: 'discipline', content: '【天枢】常驻宣言' })
    bus.render('天枢')
    const ledger = bus.drainLedger()
    assert.ok(ledger.droppedKeys.includes('static-persona'))
  })
})

describe('priority tier (constitutional/operational/informational)', () => {
  it('constitutional entries bypass Top-3 cap — 4 operational + 1 constitutional → 4 rendered', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'op-a', priority: 0.9, tier: 'operational', category: 'repair', content: 'OP-A' })
    bus.submit({ key: 'op-b', priority: 0.8, tier: 'operational', category: 'immune', content: 'OP-B' })
    bus.submit({ key: 'op-c', priority: 0.7, tier: 'operational', category: 'mistake', content: 'OP-C' })
    bus.submit({ key: 'op-d', priority: 0.6, tier: 'operational', category: 'dedup', content: 'OP-D' })
    bus.submit({ key: 'const', priority: 0.9, tier: 'constitutional', category: 'constitutional', content: 'CONST' })
    const result = bus.render()
    // Constitutional always renders
    assert.match(result, /CONST/)
    // Operational Top-3: OP-A(0.9), OP-B(0.8), OP-C(0.7) render; OP-D(0.6) dropped
    assert.match(result, /OP-A/)
    assert.match(result, /OP-B/)
    assert.match(result, /OP-C/)
    assert.ok(!result.includes('OP-D'), 'OP-D (0.6) should be dropped — operational capped at 3')
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 4, '1 constitutional + 3 operational = 4 entries')
  })

  it('constitutional entries are not subject to category cap', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'c1', priority: 0.9, tier: 'constitutional', category: 'constitutional', content: 'C1' })
    bus.submit({ key: 'c2', priority: 0.8, tier: 'constitutional', category: 'constitutional', content: 'C2' })
    bus.submit({ key: 'c3', priority: 0.7, tier: 'constitutional', category: 'constitutional', content: 'C3' })
    const result = bus.render()
    assert.match(result, /C1/)
    assert.match(result, /C2/)
    assert.match(result, /C3/)
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 3, 'all 3 constitutional entries render despite same category')
  })

  it('operational prioritised over informational for Top-3 slots', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'info-1', priority: 0.9, tier: 'informational', category: 'encouragement', content: 'INFO-HI' })
    bus.submit({ key: 'info-2', priority: 0.8, tier: 'informational', category: 'encouragement', content: 'INFO-MID' })
    bus.submit({ key: 'op-1', priority: 0.5, tier: 'operational', category: 'repair', content: 'OP-LOW' })
    bus.submit({ key: 'op-2', priority: 0.4, tier: 'operational', category: 'immune', content: 'OP-VLOW' })
    bus.submit({ key: 'op-3', priority: 0.3, tier: 'operational', category: 'mistake', content: 'OP-VVLOW' })
    const result = bus.render()
    // All 3 operational should render despite lower numeric priority
    assert.match(result, /OP-LOW/)
    assert.match(result, /OP-VLOW/)
    assert.match(result, /OP-VVLOW/)
    // INFO entries should NOT render — all 3 slots taken by operational
    assert.ok(!result.includes('INFO-HI'), 'INFO-HI should be dropped — operational takes priority')
    assert.ok(!result.includes('INFO-MID'), 'INFO-MID should be dropped — operational takes priority')
  })

  it('informational fills remaining slots after operational', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'op-1', priority: 0.6, tier: 'operational', category: 'repair', content: 'OP' })
    bus.submit({ key: 'info-1', priority: 0.5, tier: 'informational', category: 'encouragement', content: 'INFO1' })
    bus.submit({ key: 'info-2', priority: 0.4, tier: 'informational', category: 'encouragement', content: 'INFO2' })
    const result = bus.render()
    assert.match(result, /OP/)
    assert.match(result, /INFO1/)
    assert.match(result, /INFO2/)
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 3, '1 operational + 2 informational fill 3 slots')
  })

  it('mixed tiers render constitutional first, then by priority', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'op', priority: 0.9, tier: 'operational', category: 'repair', content: 'OP' })
    bus.submit({ key: 'const', priority: 0.5, tier: 'constitutional', category: 'constitutional', content: 'CONST' })
    bus.submit({ key: 'info', priority: 0.8, tier: 'informational', category: 'encouragement', content: 'INFO' })
    const result = bus.render()
    // Constitutional always first despite lower numeric priority
    const constPos = result.indexOf('CONST')
    const opPos = result.indexOf('OP')
    assert.ok(constPos < opPos, 'constitutional should render before operational')
  })

  // ── CVM-vector v3.1 Wave 1: peekPendingKeys 无副作用观察口 ──

  describe('peekPendingKeys', () => {
    it('returns submitted keys before render', () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: 'ccr-瑶光-P1', priority: 0.55, category: 'star_domain', content: 'X' })
      bus.submit({ key: 'self-verify', priority: 0.6, category: 'discipline', content: 'Y' })
      assert.deepEqual(new Set(bus.peekPendingKeys()), new Set(['ccr-瑶光-P1', 'self-verify']))
    })

    it('includes alive (ttl carried) entries after a render', () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: 'persist', priority: 0.8, category: 'repair', content: 'P', ttl: 2 })
      bus.render()
      assert.ok(bus.peekPendingKeys().includes('persist'), 'alive entry should be visible to peek')
    })

    it('has zero side effects — render output byte-identical with and without peek', () => {
      const mkBus = () => {
        const bus = new AdvisoryBus()
        bus.submit({ key: 'a', priority: 0.7, category: 'repair', content: 'AAA', ttl: 2 })
        bus.submit({ key: 'b', priority: 0.5, category: 'mistake', content: 'BBB', expect: { kind: 'verify_attempted' } })
        bus.submit({ key: 'c', priority: 0.9, tier: 'constitutional', category: 'constitutional', content: 'CCC' })
        return bus
      }
      const peeked = mkBus()
      const control = mkBus()
      peeked.peekPendingKeys()
      peeked.peekPendingKeys() // 重复 peek 也不能改变任何东西
      const r1 = peeked.render(undefined, 3)
      const r2 = control.render(undefined, 3)
      assert.equal(r1, r2, 'peek must not perturb render output')
      // 账本与 delivered 快照也必须一致
      assert.deepEqual(peeked.drainLedger(), control.drainLedger())
      assert.deepEqual(peeked.drainDelivered(), control.drainDelivered())
      // 第二轮 render（alive 承接）也逐字节一致
      assert.equal(peeked.render(undefined, 4), control.render(undefined, 4))
    })

    it('does not drain entries — render after peek still delivers them', () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: 'kept', priority: 0.8, category: 'repair', content: 'KEPT' })
      bus.peekPendingKeys()
      assert.match(bus.render(), /KEPT/)
    })
  })

  // ── Wave 1 SR 通道账本修正 ──

  describe('SR channel delivery confirmation (Wave 1)', () => {
    it('Wave 1: SR entries NOT pre-counted as delivered — require confirm callback', () => {
      // 同 turn 内提交 2 条不同 key 的 SR
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })
      bus.submit({
        key: 'turn-call-limit', priority: 0.68, category: 'discipline',
        content: 'API 调用过多', channel: 'system-reminder', immediate: true,
      })

      bus.render(undefined, 5)
      const srs = bus.drainSystemReminders()
      assert.equal(srs.length, 2, '2 SR entries should be drained')

      // Wave 1 修正后：render 不再预记 rendered/delivered
      // SR 在 confirm 回调前不进入 delivered 桶
      const delivered = bus.drainDelivered()
      const srDelivered = delivered.filter(d => d.key === 'readonly-spiral' || d.key === 'turn-call-limit')
      assert.equal(srDelivered.length, 0,
        'Wave 1 GREEN: SR entries not pre-counted — need confirm callback')
    })

    it('GREEN: confirmSrDropped removes SR from delivered bucket', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })
      bus.submit({
        key: 'turn-call-limit', priority: 0.68, category: 'discipline',
        content: 'API 调用过多', channel: 'system-reminder', immediate: true,
      })

      bus.render(undefined, 5)
      const srs = bus.drainSystemReminders()
      assert.equal(srs.length, 2)

      // Simulate SessionContext: first SR delivered, second dropped by cap
      bus.confirmSrDelivered(srs[0]!.key)
      bus.confirmSrDropped(srs[1]!.key)

      const delivered = bus.drainDelivered()
      const srDelivered = delivered.filter(d => d.key === 'readonly-spiral' || d.key === 'turn-call-limit')
      assert.equal(srDelivered.length, 1, 'GREEN: only 1 SR counts as delivered')
      // A3：drain 按 priority 降序——turn-call-limit(0.68) 先于 readonly-spiral(0.65)
      assert.equal(srDelivered[0]!.key, 'turn-call-limit', 'highest-priority SR delivered first')

      // srDropped 不出现在 delivered 桶中
      const ledger = bus.drainLedger()
      assert.equal(ledger.srSubmitted, 2, '2 SR submitted')
      assert.equal(ledger.srDropped, 1, '1 SR dropped by SessionContext cap')
    })

    // ── W2 SR 有界携带 ──

    it('W2: requeueSr puts SR back into systemReminderOut for next-turn drain', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })

      bus.render(undefined, 5)
      let srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, '1 SR drained')
      assert.equal(srs[0]!.srClass, 'discipline', 'default srClass is discipline')

      // Simulate SessionContext cap: requeue instead of drop
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass)

      // Next drain should see the requeued entry
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, 'requeued SR appears in next drain')
      assert.equal(srs[0]!.key, 'readonly-spiral', 'same key carried forward')

      // Confirm delivery — should succeed (still in srPendingDelivery)
      bus.confirmSrDelivered(srs[0]!.key)
      const ledger = bus.drainLedger()
      assert.equal(ledger.srCarried, 1, '1 SR carried across turns')
      assert.equal(ledger.srDropped, 0, 'not dropped — eventually delivered')
    })

    it('W2: requeueSr exceeds carry limit → dropped', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })

      bus.render(undefined, 5)
      let srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1)

      const entry = srs[0]!

      // Carry 3 times (limit is 2) → 3rd should drop
      bus.requeueSr(entry.key, entry.content, entry.srClass)  // carry #1
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, 'carry #1: still in drain')
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass)  // carry #2
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, 'carry #2: still in drain')
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass)  // carry #3 → dropped

      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 0, 'carry #3 exceeded limit — not in drain')

      const ledger = bus.drainLedger()
      assert.equal(ledger.srCarried, 2, '2 carries counted (3rd = dropped, not carried)')
      assert.equal(ledger.srDropped, 1, '1 dropped after carry limit exceeded')
    })

    // ── A4 互斥对：lossy-observation 胜 readonly-spiral ──

    it('A4: lossy 与 readonly-spiral 同周期在场 → spiral 让位（lossy 是事实，spiral 是启发式）', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'lossy-observation', priority: 0.48, category: 'discipline',
        content: '有损观测：禁止负向结论，先交叉验证', ttl: 1,
      })
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读，信息可能已足够，开始行动', channel: 'system-reminder', immediate: true,
      })
      const rendered = bus.render(undefined, 5)
      const srs = bus.drainSystemReminders()
      assert.equal(srs.length, 0, 'readonly-spiral 应被互斥丢弃，不进 SR 通道')
      assert.match(rendered, /有损观测/, 'lossy 照常送达')
    })

    it('A4: spiral 单独在场时照常送达（互斥只在双方同场时生效）', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读，开始行动', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 5)
      const srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1)
      assert.equal(srs[0]!.key, 'readonly-spiral')
    })

    // ── A3 信号互扰治理：SR drain 按 priority + 停放文案刷新 ──

    it('A3: drain 按 priority 降序——高优先级 SR 先出队，不受提交顺序影响', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })
      bus.submit({
        key: 'regression-bisect', priority: 0.85, category: 'constitutional',
        tier: 'constitutional', content: '回归对照', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 5)
      const srs = bus.drainSystemReminders()
      assert.equal(srs.length, 2)
      assert.equal(srs[0]!.key, 'regression-bisect', '高优先级先出队（旧实现按插入序会输给 spiral）')
      assert.equal(srs[1]!.key, 'readonly-spiral')
    })

    it('A3: 停放期间同 key 新内容到达 → 刷新文案而非保留陈旧文案', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'turn-budget', priority: 0.7, category: 'discipline',
        content: '轮数预算：还剩 3 轮', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 5)
      let srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1)
      // discipline 额度耗尽 → skipCarry 停放
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass, true)
      // 下一轮 hook 重新提交同 key，预算数字已更新
      bus.submit({
        key: 'turn-budget', priority: 0.7, category: 'discipline',
        content: '轮数预算：还剩 1 轮', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 6)
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, '同 key 不重复注入')
      assert.ok(srs[0]!.content.includes('还剩 1 轮'),
        `停放文案应刷新为新内容，got: ${srs[0]!.content}`)
    })

    it('A3: requeue 停放条目与新条目共同参与 priority 排序', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'action-intent', priority: 0.62, category: 'discipline',
        content: '行动意图', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 5)
      let srs = bus.drainSystemReminders()
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass, true)
      bus.submit({
        key: 'turn-budget', priority: 0.7, category: 'discipline',
        content: '预算收敛', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 6)
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 2)
      assert.equal(srs[0]!.key, 'turn-budget', '新条目优先级更高，先出队')
      assert.equal(srs[1]!.key, 'action-intent', '停放条目按其原 priority 参与排序')
    })

    it('W2: srClass flow through systemReminderOut with functional class', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'git-clear-after-fail', priority: 0.9, category: 'constitutional',
        tier: 'constitutional', content: '清场告警',
        channel: 'system-reminder', immediate: true,
        srClass: 'functional',
      })

      bus.render(undefined, 5)
      const srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1)
      assert.equal(srs[0]!.srClass, 'functional', 'srClass=functional flows through drain')
      assert.equal(srs[0]!.key, 'git-clear-after-fail')
    })

    it('W2: srCarried counter reset on delivered (P1 regression)', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })

      bus.render(undefined, 5)
      let srs = bus.drainSystemReminders()
      const entry = srs[0]!

      // requeue 2 times (reach carry limit), then deliver — should reset counter
      bus.requeueSr(entry.key, entry.content, entry.srClass)  // carry #1
      srs = bus.drainSystemReminders()
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass)  // carry #2 (at limit)
      srs = bus.drainSystemReminders()
      // Deliver — this must reset carry counter
      bus.confirmSrDelivered(srs[0]!.key)

      // Re-submit same key → fresh incident
      // 缺陷 3 修复后 SR 纳入 key 冷却：readonly-spiral 冷却 3 轮。
      // renderEpoch 语义（跨 run 冷却修复）：冷却按 render 次数计——
      // 送达 epoch=1，需 render 推进到 epoch ≥ 4 才越过 3 轮冷却窗。
      // 先空转 3 次 render 推进 epoch，再重新提交。
      bus.render(undefined, 6)  // epoch 2 — 空转推进
      bus.render(undefined, 7)  // epoch 3
      bus.render(undefined, 8)  // epoch 4 — 冷却期满
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读 again', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 9)
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, 'new submission with same key appears (冷却期满)')

      // requeue again — counter must be fresh (not accumulated from previous incident)
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass)  // carry #1 fresh
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, 'P1 GREEN: fresh carry count after reset — still alive')
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass)  // carry #2 fresh
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, 'P1 GREEN: carry #2 also alive (counter was reset)')
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass)  // carry #3 → should drop
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 0, 'P1 GREEN: carry #3 dropped (fresh counter, limit still 2)')
    })

    // ── P2 测试：额度耗尽停放不烧 carry ──

    it('P2: discipline entry parked without consuming carry when quota exhausted (RED)', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })

      bus.render(undefined, 5)
      const srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1)

      // Simulate P2 drain loop: quota exhausted → requeueSr with skipCarry=true
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass, true)

      // Entry should still be drainable (parked, not dropped)
      const nextDrain = bus.drainSystemReminders()
      assert.equal(nextDrain.length, 1, 'P2: parked entry appears in next drain')

      // Carry count must NOT have been consumed
      const ledger = bus.drainLedger()
      assert.equal(ledger.srCarried, 0, 'P2: skipCarry=true → srCarried=0')
      assert.equal(ledger.srDropped, 0, 'P2: not dropped')

      // Many skipCarry cycles — never drops
      let entry = nextDrain[0]!
      for (let i = 0; i < 10; i++) {
        bus.requeueSr(entry.key, 'content', 'discipline', true)
        const s = bus.drainSystemReminders()
        assert.equal(s.length, 1, `P2: cycle ${i} — still parked`)
        entry = s[0]!
      }

      // Quota restored: deliver → reset carry
      bus.confirmSrDelivered(entry.key)
      const finalLedger = bus.drainLedger()
      assert.equal(finalLedger.srDropped, 0, 'P2: never dropped through parking cycles')
    })

    // ── P3 测试：render 侧去重 ──

    it('P3: render dedup — parked key not pushed twice into systemReminderOut (RED)', () => {
      const bus = new AdvisoryBus()
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读', channel: 'system-reminder', immediate: true,
      })

      // First render + drain
      bus.render(undefined, 5)
      let srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1)

      // Park it: skipCarry requeue
      bus.requeueSr(srs[0]!.key, srs[0]!.content, srs[0]!.srClass, true)

      // While parked, hook fires again → same key submitted and rendered
      bus.submit({
        key: 'readonly-spiral', priority: 0.65, category: 'discipline',
        content: '连续只读 again', channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 6)

      // Drain: must have exactly 1 entry (not double-injected)
      srs = bus.drainSystemReminders()
      assert.equal(srs.length, 1, 'P3 RED: only 1 entry — render dedup must prevent double injection')
    })
  })
})

describe('W2 表扬治理（2026-07-25 advisory-ecology-repair）', () => {
  it('virtueEncouragementEntry 归 encouragement——产出流中被阶段抑制', () => {
    const entry = virtueEncouragementEntry()
    assert.equal(entry.category, 'encouragement', 'category 挂 discipline 会绕过 flow 抑制白名单（C-C 洪流根因）')

    const bus = new AdvisoryBus()
    bus.setFlowStateProvider(() => true)
    bus.submit(virtueEncouragementEntry())
    const out = bus.render(undefined, 1)
    assert.ok(!out.includes('virtue-encouragement'), '产出流中表扬被推迟，不与产出争注意力')
  })

  it('key 级送达冷却：送达后 N 轮内重复提交被吞掉并计入 dropped', () => {
    const cooldown = KEY_COOLDOWN_TURNS.get('virtue-encouragement')!
    assert.ok(cooldown >= 1, 'virtue-encouragement 必须在冷却注册表内')

    const bus = new AdvisoryBus()
    // 第 1 轮：正常送达
    bus.submit(virtueEncouragementEntry())
    const r1 = bus.render(undefined, 1)
    assert.ok(r1.includes('virtue-encouragement'), '首轮正常送达')
    bus.drainLedger()

    // 冷却窗内（第 2 轮起）：每轮结算重复提交，全部被吞
    for (let turn = 2; turn < 1 + cooldown; turn++) {
      bus.submit(virtueEncouragementEntry())
      const out = bus.render(undefined, turn)
      assert.ok(!out.includes('virtue-encouragement'), `第 ${turn} 轮仍在冷却窗内（距送达 ${turn - 1} < ${cooldown}）`)
    }
    const delta = bus.drainLedger()
    assert.equal(delta.dropped, cooldown - 1, '冷却吞掉的条目逐条计入 dropped 遥测')
    assert.ok(delta.droppedKeys.includes('virtue-encouragement'), '丢弃 key 可从遥测回放')

    // 冷却期满：恢复送达
    bus.submit(virtueEncouragementEntry())
    const rAfter = bus.render(undefined, 1 + cooldown)
    assert.ok(rAfter.includes('virtue-encouragement'), '冷却期满恢复送达——治理的是洪流不是消灭')
  })

  it('冷却只约束注册 key——其他条目不受影响', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'guard', priority: 0.6, category: 'discipline', content: '先验证' })
    bus.render(undefined, 1)
    bus.submit({ key: 'guard', priority: 0.6, category: 'discipline', content: '先验证' })
    const out = bus.render(undefined, 2)
    assert.ok(out.includes('guard'), '未注册 key 每轮照常竞争')
  })

  it('缺陷 3：SR 通道纳入 key 冷却——turn-call-limit 送达后冷却窗内不重复注入', () => {
    const cooldown = KEY_COOLDOWN_TURNS.get('turn-call-limit')!
    assert.ok(cooldown >= 1, 'turn-call-limit 必须在冷却注册表内')

    const bus = new AdvisoryBus()
    const srEntry = (): AdvisoryEntry => ({
      key: 'turn-call-limit', priority: 0.68, category: 'discipline',
      content: '本轮已进行 12+ 次 API 调用，请收敛当前动作并输出结论。',
      channel: 'system-reminder', immediate: true,
    })

    // 第 1 轮：SR 正常送达（走完整 confirm 生命周期记账送达轮）
    bus.submit(srEntry())
    bus.render(undefined, 1)
    let srs = bus.drainSystemReminders()
    assert.equal(srs.length, 1, '首轮 SR 正常进入待送队列')
    bus.confirmSrDelivered(srs[0]!.key)
    bus.drainLedger()

    // 冷却窗内（第 2 轮起）：重复提交被吞——不进 SR 待送队列
    for (let turn = 2; turn < 1 + cooldown; turn++) {
      bus.submit(srEntry())
      bus.render(undefined, turn)
      const pending = bus.drainSystemReminders()
      assert.equal(pending.length, 0, `第 ${turn} 轮 SR 在冷却窗内不得重复注入（距送达 ${turn - 1} < ${cooldown}）`)
    }
    const delta = bus.drainLedger()
    assert.ok(delta.dropped >= cooldown - 1, '冷却吞掉的 SR 逐条计入 dropped 遥测')
    assert.ok(delta.droppedKeys.includes('turn-call-limit'), '丢弃 key 可从遥测回放')

    // 冷却期满：恢复送达
    bus.submit(srEntry())
    bus.render(undefined, 1 + cooldown)
    const pendingAfter = bus.drainSystemReminders()
    assert.equal(pendingAfter.length, 1, '冷却期满 SR 恢复送达——治理的是洪流不是消灭')
  })

  it('跨 run 局部 turn 重置后，SR 冷却仍按单调渲染周期到期', () => {
    const cooldown = KEY_COOLDOWN_TURNS.get('turn-call-limit')!
    const bus = new AdvisoryBus()
    const attemptAtTurn12 = (): number => {
      bus.submit({
        key: 'turn-call-limit', priority: 0.68, category: 'discipline',
        content: '本轮已进行 12+ 次 API 调用，请收敛当前动作并输出结论。',
        channel: 'system-reminder', immediate: true,
      })
      bus.render(undefined, 12)
      const pending = bus.drainSystemReminders()
      if (pending[0]) bus.confirmSrDelivered(pending[0].key)
      return pending.length
    }

    assert.equal(attemptAtTurn12(), 1, '首次 run 正常送达')
    for (let run = 2; run <= cooldown; run++) {
      assert.equal(attemptAtTurn12(), 0, `第 ${run} 个 run 仍在冷却窗内`)
    }
    assert.equal(attemptAtTurn12(), 1,
      '局部 turn 每个 run 都回到 12，冷却也必须最终恢复，不能永久静默')
  })
})

describe('W3 穿透让位：验证债 MUTEX 对（2026-07-25 advisory-ecology-repair）', () => {
  const debtKeys = ['self-verify', 'self-verify-scope-mismatch', 'ccr-天权-P3', 'ccr-天权-P7']

  for (const winner of debtKeys) {
    it(`${winner} 在场时 virtue-encouragement 让位`, () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: winner, priority: 0.58, category: 'discipline', content: '验证债在场' })
      bus.submit(virtueEncouragementEntry())
      const out = bus.render(undefined, 1)
      assert.ok(out.includes(winner), 'winner 正常送达')
      assert.ok(!out.includes('virtue-encouragement'), '「你有债」和「干得好」不该同屏')
    })
  }

  it('验证债不在场时表扬照常送达（让位是条件性的，不是封杀）', () => {
    const bus = new AdvisoryBus()
    bus.submit(virtueEncouragementEntry())
    const out = bus.render(undefined, 1)
    assert.ok(out.includes('virtue-encouragement'))
  })

  it('winner 带 observe 挂起观察时 loser 仍须让位（复盘修复：MUTEX × pendingWatch）', () => {
    // 生产的 self-verify 带 observe:{turns:1}——挂起窗内不进竞争池 all，
    // 只扫 all 会让表扬在债观察窗内照常送达。挂起 ≠ 不在场。
    const bus = new AdvisoryBus()
    bus.submit({
      key: 'self-verify', priority: 0.58, category: 'discipline',
      content: '验证债在场', ttl: 1,
      expect: { kind: 'verify_attempted', withinTurns: 2 }, observe: { turns: 1 },
    })
    bus.submit(virtueEncouragementEntry())
    const out = bus.render(undefined, 1)
    assert.ok(!out.includes('self-verify'), '前提自检：winner 本轮在挂起观察，不渲染')
    assert.ok(!out.includes('virtue-encouragement'), '观察窗内「你有债」事实已被指认，表扬必须让位')
  })
})

describe('W6 注入预算 × 送达记账一致性（2026-09-10 audit：假送达修复）', () => {
  it('被预算裁掉的条目不得进 delivered/ledgerRendered——两本账必须与实际渲染一致', () => {
    const bus = new AdvisoryBus()
    bus.setOverheadThrottled(true) // W6 节流 → cvmInjectionBudget = max(1, 3-2) = 1
    bus.submitAll([
      { key: 'turn-call-limit', priority: 0.9, category: 'discipline', content: 'A' },
      { key: 'readonly-spiral', priority: 0.8, category: 'dead_end', content: 'B' },
      { key: 'stale-plan', priority: 0.7, category: 'todo', content: 'C' },
    ])
    const out = bus.render(undefined, 1)
    const delivered = bus.drainDelivered()
    const ledger = bus.drainLedger()
    const renderedKeys = [...out.matchAll(/<entry key="([^"]+)"/g)].map(m => m[1]!)

    assert.equal(renderedKeys.length, 1, '预算=1 只放行 1 条')
    assert.equal(delivered.length, renderedKeys.length,
      'delivered 必须只含真正进 prompt 的条目——被裁条目进 delivered 会污染 readback/efficacy')
    assert.equal(ledger.rendered, renderedKeys.length, 'ledgerRendered 同口径')
    assert.equal(ledger.dropped, 2, '被裁 2 条在 dropped 里只计一次（不得与预算块重复记账）')
    for (const key of ledger.droppedKeys) {
      assert.ok(!delivered.some(d => d.key === key), `被裁 key ${key} 不得出现在 delivered`)
    }
  })

})
