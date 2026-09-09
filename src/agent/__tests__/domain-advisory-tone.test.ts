import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyDomainAdvisoryTone } from '../domain-advisory-tone.js'
import { AdvisoryBus } from '../advisory-bus.js'

describe('applyDomainAdvisoryTone', () => {
  const meta = { key: 'convergence', category: 'discipline' as const }

  it('is identity when no domain is active', () => {
    assert.equal(applyDomainAdvisoryTone(undefined, '换个角度看问题', meta), '换个角度看问题')
    assert.equal(applyDomainAdvisoryTone(null, '换个角度看问题', meta), '换个角度看问题')
  })

  it('is identity for domains without a tone entry', () => {
    assert.equal(applyDomainAdvisoryTone('tianshu', '换个角度看问题', meta), '换个角度看问题')
    assert.equal(applyDomainAdvisoryTone('yaoguang', '换个角度看问题', meta), '换个角度看问题')
  })

  it('tianquan: wraps corrective signals in the weighing protocol (explicit verdict required)', () => {
    const out = applyDomainAdvisoryTone('tianquan', '最近多轮没有验证，请先跑测试。', meta)
    assert.ok(out.startsWith('最近多轮没有验证，请先跑测试。'), 'original content preserved as the evidence')
    assert.ok(out.includes('供你称量'), 'framed as evidence to weigh, not a command')
    assert.ok(out.includes('驳回→给出更强证据'), 'rebuttal path requires stronger evidence')
    assert.ok(out.includes('没有沉默的秤'), 'invokes the domain constitution against silent dismissal')
  })

  it('tianquan: exempts constitutional tier (safety floor stays imperative)', () => {
    const out = applyDomainAdvisoryTone('tianquan', '禁止读取 .env 文件。', {
      key: 'security', category: 'constitutional', tier: 'constitutional',
    })
    assert.equal(out, '禁止读取 .env 文件。')
  })

  it('tianquan: exempts encouragement (positive feedback needs no verdict protocol)', () => {
    const out = applyDomainAdvisoryTone('tianquan', '【瑶光】好的决策——节奏值得保持。', {
      key: 'virtue-encouragement', category: 'encouragement',
    })
    assert.equal(out, '【瑶光】好的决策——节奏值得保持。')
  })

  it('tianquan: leaves the domain own voice untouched', () => {
    const out = applyDomainAdvisoryTone('tianquan', '【天权】称量到位——继续保持审查精度。', meta)
    assert.equal(out, '【天权】称量到位——继续保持审查精度。')
  })
})

describe('AdvisoryBus tone adapter integration', () => {
  it('applies the adapter at the bus render exit', () => {
    const bus = new AdvisoryBus()
    bus.setToneAdapter((content, m) => applyDomainAdvisoryTone('tianquan', content, m))
    bus.submit({ key: 'self-verify', priority: 0.58, category: 'discipline', content: '先验证再继续。' })
    const out = bus.render()
    assert.ok(out.includes('先验证再继续。'), 'original content delivered')
    assert.ok(out.includes('供你称量'), 'tone protocol appended at render')
  })

  it('applies the adapter on the system-reminder channel', () => {
    const bus = new AdvisoryBus()
    bus.setToneAdapter((content, m) => applyDomainAdvisoryTone('tianquan', content, m))
    bus.submit({
      key: 'action-intent', priority: 0.62, category: 'discipline',
      content: '上一轮宣布了写操作但未执行。', channel: 'system-reminder', immediate: true,
    })
    bus.render()
    const reminders = bus.drainSystemReminders()
    assert.equal(reminders.length, 1)
    assert.ok(reminders[0]!.content.includes('供你称量'))
  })

  it('does not double-wrap TTL-carried entries across renders', () => {
    const bus = new AdvisoryBus()
    bus.setToneAdapter((content, m) => applyDomainAdvisoryTone('tianquan', content, m))
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', content: '提醒内容。', ttl: 2 })
    const r1 = bus.render()
    const r2 = bus.render()
    const countWraps = (s: string): number => (s.match(/供你称量/g) ?? []).length
    assert.equal(countWraps(r1), 1)
    assert.equal(countWraps(r2), 1, 'carry-over entry must be wrapped exactly once per render')
  })

  it('adapter errors fall back to original content (never blocks delivery)', () => {
    const bus = new AdvisoryBus()
    bus.setToneAdapter(() => { throw new Error('tone boom') })
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', content: '原文照送。' })
    const out = bus.render()
    assert.ok(out.includes('原文照送。'))
  })

  it('adapter returning undefined falls back to original content (30 轮 goal 收束实证：escapeXml undefined 崩溃)', () => {
    const bus = new AdvisoryBus()
    bus.setToneAdapter(() => undefined as unknown as string)
    bus.submit({ key: 'k', priority: 0.6, category: 'discipline', content: '脏值回退原文。' })
    // 修复前：render 的 XML entry 路径 escapeXml(applyTone(e)) 收到 undefined →
    // TypeError: Cannot read properties of undefined (reading 'replaceAll')。
    let out = ''
    assert.doesNotThrow(() => { out = bus.render() }, '脏 tone 输出不得让 render 崩溃')
    assert.ok(out.includes('脏值回退原文。'), '脏 tone 输出必须回退原文送达')
  })
})
