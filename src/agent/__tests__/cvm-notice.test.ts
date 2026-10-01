/**
 * CVM 拦截用户可见提示（issue #247 第 1–3 条）——分级判定与文案的唯一来源。
 *
 * 契约要点：
 *  1. 分级按**决策形态**而非 kind：同一 kind 会有多种返回形态
 *     （perspective-locked 既有 candidate 分支，也有 yielded / 冷却静默分支）。
 *  2. 拦截级**不要求** mode === 'active'。默认模式就是 shadow，若要求 active，
 *     默认路径下用户一条都看不到——issue 的立论（"默认关闭会让 CVM 在默认路径下
 *     依然不可见"）就没有解决。
 *  3. shadow 下文案不得宣称「已注入 / 已阻止」——issue 的硬约束是
 *     "提示文案应避免让用户读出「因为拦截了所以失败了」"。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CVM_KIND_LABELS,
  CVM_LEVEL_LABELS,
  buildCvmNotice,
  classifyCvmDecision,
  emitCvmInterception,
  formatCvmNoticeLine,
  type CvmInterceptionNotice,
} from '../cvm-notice.js'
import type { CvmDifficultyKind, CvmVectorDecision } from '../hooks/cognitive-capsule-router.js'

// ── 五种决策形态（逐一取自 evaluator 的真实分支）────────────────
/** 冷却未过的 CV1：命中但已发过，本轮回 null candidate。router:994 */
const coolingSilent: CvmVectorDecision = {
  classification: { kind: 'verification-debt', ruleId: 'CV1', facts: { turn: 9 } },
  candidate: null,
  yielded: null,
}
/** gate-blocked：永不发声（candidate / yielded 恒 null）。router:743 */
const gateBlocked: CvmVectorDecision = {
  classification: { kind: 'gate-blocked', ruleId: undefined, facts: { source: 'obligation-gate', turn: 9 } },
  candidate: null,
  yielded: null,
}
/** CV2 让位给 convergence。router:914 */
const yieldedToConvergence: CvmVectorDecision = {
  classification: { kind: 'perspective-locked', ruleId: 'CV2', facts: { turn: 9 } },
  candidate: null,
  yielded: { ruleId: 'CV2', to: 'convergence-emit' },
}
/** CV1 真发候选。router:998 */
const verificationDebtCandidate: CvmVectorDecision = {
  classification: { kind: 'verification-debt', ruleId: 'CV1', facts: { turn: 9 } },
  candidate: {
    ruleId: 'CV1',
    star: '天权',
    entry: { key: 'cvm-vector-天权-CV1', priority: 0.5, category: 'star_domain', content: '改了文件但交付未验证', ttl: 1 },
  },
  yielded: null,
}
/** 全空：什么都不该发生。router:665 */
const emptyDecision: CvmVectorDecision = { classification: null, candidate: null, yielded: null }

describe('classifyCvmDecision — 按决策形态分级（issue #247 第 1 条）', () => {
  it('candidate 非空 = 拦截（CVM 判定需要干预并产出了纠偏内容）', () => {
    assert.equal(classifyCvmDecision(verificationDebtCandidate), 'intercept')
  })

  it('yielded 非空 = 警告（命中但让位给专用机制）', () => {
    assert.equal(classifyCvmDecision(yieldedToConvergence), 'warn')
  })

  it('仅 classification = 提示（gate-blocked 与冷却静默都是这一类）', () => {
    assert.equal(classifyCvmDecision(gateBlocked), 'info')
    assert.equal(classifyCvmDecision(coolingSilent), 'info')
  })

  it('三者皆空 → null（不产生任何提示，也不计数）', () => {
    assert.equal(classifyCvmDecision(emptyDecision), null)
    assert.equal(buildCvmNotice(emptyDecision, 'shadow', 9), null)
  })
})

describe('formatCvmNoticeLine — 文案', () => {
  const base = { kind: 'verification-debt' as CvmDifficultyKind, ruleId: 'CV1', mode: 'active' as const }

  it('单条：`⛨ CVM <级别>：<类型>（<规则>）— <说明>`', () => {
    const line = formatCvmNoticeLine({ ...base, level: 'intercept' })
    assert.ok(line.startsWith('⛨ CVM 拦截：验证债务（CV1）'), `实际：${line}`)
  })

  it('聚合：`×N` 紧随级别，形如 issue #247 给的「CVM 拦截 ×3：验证债务」', () => {
    const line = formatCvmNoticeLine({ ...base, level: 'intercept', count: 3 })
    assert.ok(line.includes('CVM 拦截 ×3：验证债务'), `实际：${line}`)
  })

  it('单条不带 ×1（issue 的示例只在合并时出现 ×N）', () => {
    assert.ok(!formatCvmNoticeLine({ ...base, level: 'intercept' }).includes('×1'))
    assert.ok(!formatCvmNoticeLine({ ...base, level: 'intercept', count: 1 }).includes('×1'))
  })

  it('active 下拦截级说「已注入」', () => {
    assert.ok(formatCvmNoticeLine({ ...base, level: 'intercept', mode: 'active' }).includes('已注入'))
  })

  it('shadow 下拦截级**不得**宣称「已注入 / 已阻止」——issue 的因果约束', () => {
    const line = formatCvmNoticeLine({ ...base, level: 'intercept', mode: 'shadow' })
    assert.ok(!line.includes('已注入'), `shadow 不该说已注入：${line}`)
    assert.ok(!line.includes('已阻止'), `shadow 不该说已阻止：${line}`)
    assert.ok(line.includes('未注入'), `shadow 应显式说明未注入：${line}`)
  })

  it('警告 / 提示级各自的说明与级别一致', () => {
    const warn = formatCvmNoticeLine({ level: 'warn', kind: 'perspective-locked', ruleId: 'CV2', mode: 'active' })
    assert.ok(warn.includes('CVM 警告：视角锁定（CV2）'), warn)
    const info = formatCvmNoticeLine({ level: 'info', kind: 'gate-blocked', ruleId: null, mode: 'shadow' })
    assert.ok(info.includes('CVM 提示：门禁让位'), info)
  })

  it('ruleId 缺省（gate-blocked）时不渲染空括号', () => {
    const line = formatCvmNoticeLine({ level: 'info', kind: 'gate-blocked', ruleId: null, mode: 'shadow' })
    assert.ok(!line.includes('（）'), line)
    assert.ok(!line.includes('()'), line)
  })
})

describe('级别 / 类型 中文标签覆盖', () => {
  it('三级都有中文名，且逐字取自 issue 的三级表', () => {
    assert.deepEqual(CVM_LEVEL_LABELS, { intercept: '拦截', warn: '警告', info: '提示' })
  })

  it('五个 CvmDifficultyKind 全部有中文名（新增 kind 时必须同步，否则这里红）', () => {
    const kinds: CvmDifficultyKind[] = [
      'gate-blocked', 'context-pressure', 'perspective-locked', 'verification-debt', 'attack-stalled',
    ]
    for (const k of kinds) {
      assert.ok(CVM_KIND_LABELS[k], `缺 ${k} 的中文名`)
    }
    assert.equal(Object.keys(CVM_KIND_LABELS).length, kinds.length, '多出未登记的 kind 标签')
  })

  it('verification-debt 的译名逐字取自 issue 示例「CVM 拦截 ×3：验证债务」', () => {
    assert.equal(CVM_KIND_LABELS['verification-debt'], '验证债务')
  })
})

describe('emitCvmInterception — 计数与通知同源', () => {
  function makeSession() {
    const calls: string[] = []
    return { calls, recordCvmInterception: (k: string) => { calls.push(k) } }
  }

  it('candidate 形态：计数一次 + 推一条拦截级通知', () => {
    const session = makeSession()
    const got: CvmInterceptionNotice[] = []
    emitCvmInterception(session, { onCvmInterception: n => got.push(n) }, verificationDebtCandidate, 'active', 9)
    assert.deepEqual(session.calls, ['verification-debt'])
    assert.equal(got.length, 1)
    assert.equal(got[0]!.level, 'intercept')
    assert.equal(got[0]!.turn, 9)
  })

  it('gate-blocked 形态：**仍计数**（台账口径与 A 一致）但只推提示级', () => {
    const session = makeSession()
    const got: CvmInterceptionNotice[] = []
    emitCvmInterception(session, { onCvmInterception: n => got.push(n) }, gateBlocked, 'shadow', 9)
    assert.deepEqual(session.calls, ['gate-blocked'])
    assert.equal(got[0]!.level, 'info')
  })

  it('全空形态：既不计数也不通知', () => {
    const session = makeSession()
    const got: CvmInterceptionNotice[] = []
    emitCvmInterception(session, { onCvmInterception: n => got.push(n) }, emptyDecision, 'shadow', 9)
    assert.deepEqual(session.calls, [])
    assert.deepEqual(got, [])
  })

  it('宿主没接 onCvmInterception（server / 桌面 / 测试替身）时只计数、不抛', () => {
    const session = makeSession()
    assert.doesNotThrow(() => emitCvmInterception(session, {}, verificationDebtCandidate, 'active', 9))
    assert.doesNotThrow(() => emitCvmInterception(session, undefined, verificationDebtCandidate, 'active', 9))
    assert.deepEqual(session.calls, ['verification-debt', 'verification-debt'])
  })

  it('回调抛错不得冒泡——CVM 提示通路永不阻断主 turn', () => {
    const session = makeSession()
    assert.doesNotThrow(() => emitCvmInterception(
      session,
      { onCvmInterception: () => { throw new Error('宿主渲染炸了') } },
      verificationDebtCandidate, 'active', 9,
    ))
    assert.deepEqual(session.calls, ['verification-debt'], '计数发生在回调之前，不因回调抛错丢失')
  })
})
