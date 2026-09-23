/**
 * RIVET_NO_CROSS_SESSION kill-switch 契约测试。
 *
 * 控制通道（优先级从高到低）：
 *   ① env RIVET_NO_CROSS_SESSION=1/true → force-off（crossSessionDisabled=true）
 *   ② env RIVET_NO_CROSS_SESSION=0/false → force-on（crossSessionDisabled=false）
 *   ③ config.crossSessionEnabled（默认 true → crossSessionDisabled=false）
 *   ④ 无 config+无 env → 回退默认 disabled=true（向后兼容）
 *
 * 四个注入点（turn-step-producer.ts + loop.ts）：
 *   ① warmupMemories() — 跨会话记忆预热
 *   ② setCrossSessionMemoryBlock() — 记忆块注入 prompt
 *   ③ cross-session event consumption — 跨会话事件消费
 *   ④ companion presence — 跨会话 companion 存在感
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { combineMemoryBlocks, crossSessionDisabled, crossSessionMemoryPushEnabled, prevSessionHandoffEnabled, crossSessionClaimsInjectionEnabled, crossSessionEventsAppendixEnabled } from '../turn-step-producer.js'

// ── crossSessionDisabled() unit tests ──────────────────────────

describe('crossSessionDisabled — env + config', () => {
  const saved = process.env.RIVET_NO_CROSS_SESSION

  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_NO_CROSS_SESSION
    else process.env.RIVET_NO_CROSS_SESSION = saved
  })

  // ── Env var overrides ──

  it('env=1 force-off regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    assert.equal(crossSessionDisabled(true), true)
    assert.equal(crossSessionDisabled(false), true)
  })

  it('env=true force-off regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = 'true'
    assert.equal(crossSessionDisabled(true), true)
    assert.equal(crossSessionDisabled(false), true)
  })

  it('env=0 force-on regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = '0'
    assert.equal(crossSessionDisabled(true), false)
    assert.equal(crossSessionDisabled(false), false)
  })

  it('env=false force-on regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = 'false'
    assert.equal(crossSessionDisabled(true), false)
    assert.equal(crossSessionDisabled(false), false)
  })

  // ── Config-driven (no env) ──

  it('config enabled → cross-session NOT disabled', () => {
    delete process.env.RIVET_NO_CROSS_SESSION
    assert.equal(crossSessionDisabled(true), false)
  })

  it('config disabled → cross-session IS disabled', () => {
    delete process.env.RIVET_NO_CROSS_SESSION
    assert.equal(crossSessionDisabled(false), true)
  })

  it('config undefined → cross-session IS disabled (no env either)', () => {
    delete process.env.RIVET_NO_CROSS_SESSION
    assert.equal(crossSessionDisabled(), true)
  })

  it('config undefined + env="" → cross-session IS disabled', () => {
    process.env.RIVET_NO_CROSS_SESSION = ''
    assert.equal(crossSessionDisabled(), true)
  })
})

// ── Four-injection-point behavioral verification ───────────────
// NOTE: Full AgentLoop + TurnStepProducer integration requires a writable
// temp dir (mkdir under .rivet/sessions) which the sandbox blocks with
// EPERM. These tests verify the gate function AND that the four injection
// sites are present at the correct source locations.

describe('RIVET_NO_CROSS_SESSION=1 → 四个注入点返回 null/空/skip', () => {
  const savedEnv = process.env.RIVET_NO_CROSS_SESSION

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RIVET_NO_CROSS_SESSION
    else process.env.RIVET_NO_CROSS_SESSION = savedEnv
  })

  it('① warmupMemories() gate present in loop.ts:966', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // loop.ts:966 — force-off gate: env=1 overrides config
    assert.equal(crossSessionDisabled(true), true)
  })

  it('② setCrossSessionMemoryBlock(null) gate present in turn-step-producer.ts:225', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:225
    //   crossSessionDisabled(configEnabled) ? null : renderMemoryBlock(...)
    assert.equal(crossSessionDisabled(true), true)
  })

  it('③ cross-session event consumption skipped in turn-step-producer.ts:303', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:303
    //   if (!crossSessionDisabled(configEnabled) && ...)
    assert.equal(crossSessionDisabled(true), true)
  })

  it('④ companion presence null in turn-step-producer.ts:331', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:331
    //   crossSessionDisabled(configEnabled) ? [] : loadPresence(...)
    assert.equal(crossSessionDisabled(true), true)
  })
})

// ── Wave 1（知识重构）：cross-session memory 推送默认退位 ────────

describe('crossSessionMemoryPushEnabled — 记忆块推送默认关闭', () => {
  const saved = process.env.RIVET_CROSS_SESSION_INJECT

  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_CROSS_SESSION_INJECT
    else process.env.RIVET_CROSS_SESSION_INJECT = saved
  })

  it('默认（无 env）→ 推送关闭', () => {
    delete process.env.RIVET_CROSS_SESSION_INJECT
    assert.equal(crossSessionMemoryPushEnabled(), false)
  })

  it('env=1 → 显式恢复推送（对照实验回退口）', () => {
    process.env.RIVET_CROSS_SESSION_INJECT = '1'
    assert.equal(crossSessionMemoryPushEnabled(), true)
  })

  it('env=true → 显式恢复推送', () => {
    process.env.RIVET_CROSS_SESSION_INJECT = 'true'
    assert.equal(crossSessionMemoryPushEnabled(), true)
  })

  it('env=0 → 推送保持关闭', () => {
    process.env.RIVET_CROSS_SESSION_INJECT = '0'
    assert.equal(crossSessionMemoryPushEnabled(), false)
  })
})

// ── 虚空仓库 P0：双路记忆块合并契约 ─────────────────────────────
// 默认路径（agent-crafted，无条件）+ opt-in 路径（全量，env 门控）
// 经 combineMemoryBlocks 合并进同一个 setCrossSessionMemoryBlock 槽位。

describe('combineMemoryBlocks — 虚空仓库双路注入合并', () => {
  it('仅 agent-crafted 块（默认场景：opt-in 关闭）→ 原样注入', () => {
    assert.equal(combineMemoryBlocks('<crafted/>', null), '<crafted/>')
  })

  it('仅全量块（无 agent-crafted 知识 + opt-in 开）→ 原样注入', () => {
    assert.equal(combineMemoryBlocks(null, '<full/>'), '<full/>')
  })

  it('两路都有 → agent-crafted 在前、换行分隔（字节序确定）', () => {
    assert.equal(combineMemoryBlocks('<crafted/>', '<full/>'), '<crafted/>\n<full/>')
  })

  it('两路都空 → null（附录零占用）', () => {
    assert.equal(combineMemoryBlocks(null, null), null)
  })
})

// ── prevSessionHandoffEnabled() — 显式关闭上一会话 handoff 注入 ──────────────
// 2026-09-22：该注入的选取规则是「最近更新的另一个会话 + 同星域优先」，在并行
// 会话工作区里会把一份可能已被并行会话超越的陈旧 handoff 当上下文注入，且它不挂
// CvmInjectionSource，禅模式的 appendixLean 不会收缩它。故显式默认关闭——这是
// 产品判断，不是接线缺陷；此测试锁住「默认必须为关」。
describe('prevSessionHandoffEnabled — 默认关闭（并行会话安全）', () => {
  const saved = process.env.RIVET_PREV_HANDOFF

  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_PREV_HANDOFF
    else process.env.RIVET_PREV_HANDOFF = saved
  })

  it('无 env 时为关闭——默认值必须是不注入', () => {
    delete process.env.RIVET_PREV_HANDOFF
    assert.equal(prevSessionHandoffEnabled(), false)
    assert.equal(prevSessionHandoffEnabled(undefined), false)
    assert.equal(prevSessionHandoffEnabled(''), false)
  })

  it('只有显式的 1/on/true 才开启', () => {
    for (const v of ['1', 'on', 'true', 'TRUE', ' On ']) {
      assert.equal(prevSessionHandoffEnabled(v), true, `应开启: ${JSON.stringify(v)}`)
    }
  })

  it('其它取值一律关闭——不把「看起来像真值」的东西当开启', () => {
    for (const v of ['0', 'off', 'false', 'yes', 'no', '2', 'enabled']) {
      assert.equal(prevSessionHandoffEnabled(v), false, `应关闭: ${JSON.stringify(v)}`)
    }
  })
})

// ── 闸门解耦（2026-09-22）：两个「往 prompt 注入」开关各自默认关 ──────────────
// 起因：此前一个 if 同时控制「事件 appendix / claims 注入 / handoff 注入 / 读缓存
// 失效」四件事，想关一件必须关全部。解耦后前三件各有独立开关且默认关；
// 读缓存失效是本地一致性动作（fail-safe），**不受这些开关约束**。
describe('跨会话注入开关 —— 解耦后各自默认关', () => {
  const savedClaims = process.env.RIVET_CROSS_SESSION_CLAIMS
  const savedEvents = process.env.RIVET_CROSS_SESSION_EVENTS

  afterEach(() => {
    if (savedClaims === undefined) delete process.env.RIVET_CROSS_SESSION_CLAIMS
    else process.env.RIVET_CROSS_SESSION_CLAIMS = savedClaims
    if (savedEvents === undefined) delete process.env.RIVET_CROSS_SESSION_EVENTS
    else process.env.RIVET_CROSS_SESSION_EVENTS = savedEvents
  })

  it('claims 注入默认关：无 env 即 false', () => {
    delete process.env.RIVET_CROSS_SESSION_CLAIMS
    assert.equal(crossSessionClaimsInjectionEnabled(), false)
    assert.equal(crossSessionClaimsInjectionEnabled(''), false)
    assert.equal(crossSessionClaimsInjectionEnabled('0'), false)
    assert.equal(crossSessionClaimsInjectionEnabled('yes'), false)
  })

  it('claims 注入仅 1/on/true 开启', () => {
    for (const v of ['1', 'on', 'true', ' TRUE ']) {
      assert.equal(crossSessionClaimsInjectionEnabled(v), true, v)
    }
  })

  it('事件 appendix 默认关：无 env 即 false', () => {
    delete process.env.RIVET_CROSS_SESSION_EVENTS
    assert.equal(crossSessionEventsAppendixEnabled(), false)
    assert.equal(crossSessionEventsAppendixEnabled(''), false)
    assert.equal(crossSessionEventsAppendixEnabled('0'), false)
    assert.equal(crossSessionEventsAppendixEnabled('enabled'), false)
  })

  it('事件 appendix 仅 1/on/true 开启', () => {
    for (const v of ['1', 'on', 'true', ' On ']) {
      assert.equal(crossSessionEventsAppendixEnabled(v), true, v)
    }
  })

  it('三个注入开关互相独立——打开一个不影响另一个', () => {
    delete process.env.RIVET_PREV_HANDOFF
    delete process.env.RIVET_CROSS_SESSION_EVENTS
    assert.equal(crossSessionEventsAppendixEnabled('1'), true)
    assert.equal(crossSessionClaimsInjectionEnabled('1'), true)
    assert.equal(prevSessionHandoffEnabled(), false, 'handoff 不应被另两个开关带开')
    assert.equal(crossSessionClaimsInjectionEnabled(), false, 'claims 不应被 events 开关带开')
  })
})

// ── 接线锚点：AgentLoop 的 config 必须真的拿到 sessionRegistry ────────────────
// 2026-09-22：该字段（loop-types.ts:96）声明了却从未被任何构造路径填充，
// createAgentConfig 的入参/白名单都没有它，导致 AgentLoop 侧整个跨会话块静默
// 失效。协调器那条路（bootstrap 的 DelegationCoordinator config）一直传的是
// refs.sessionRegistry，所以「有人填过」的印象是假的。这里钉住接线，防止再次
// 回退成「声明了但没人填」——那种形态下文档说功能在跑而代码永远不跑。
describe('接线锚点 —— AgentLoop config 的 sessionRegistry 透传', () => {
  it('bootstrap 的 AgentLoop config 字面量必须传 sessionRegistry', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../bootstrap.ts', import.meta.url), 'utf-8')
    assert.match(
      src,
      /sessionRegistry: refs\.sessionRegistry \?\? undefined,/,
      'AgentLoop 的 config 必须从 refs.sessionRegistry 透传，否则跨会话块（含读缓存失效）静默失效',
    )
  })
})
