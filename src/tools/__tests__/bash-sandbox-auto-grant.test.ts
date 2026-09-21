/**
 * skip 档沙箱拒绝「首触即授 + 重跑」判定矩阵（2026-09-05 用户反馈：全自动档
 * bash 出界写被拦后还要烧一轮 LLM 恢复——拒绝应当场授予并重跑，语义同
 * learn 模式 but 面向生产零打扰承诺）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shouldAutoGrantSandboxDenial } from '../bash.js'

describe('shouldAutoGrantSandboxDenial（沙箱拒绝自动授予判定）', () => {
  it('learn 模式：有拒绝路径即授予（既有语义不变）', () => {
    assert.equal(shouldAutoGrantSandboxDenial('learn', undefined, true), true)
    assert.equal(shouldAutoGrantSandboxDenial('learn', 'manual', true), true)
  })

  it('全自动档（skip）：有拒绝路径即授予——零打扰承诺覆盖沙箱层', () => {
    assert.equal(shouldAutoGrantSandboxDenial('1', 'dangerously-skip-permissions', true), true)
    assert.equal(shouldAutoGrantSandboxDenial(undefined, 'dangerously-skip-permissions', true), true)
  })

  it('无拒绝路径恒不授予（两种触发线都不成立时）', () => {
    assert.equal(shouldAutoGrantSandboxDenial('learn', 'dangerously-skip-permissions', false), false)
    assert.equal(shouldAutoGrantSandboxDenial(undefined, undefined, false), false)
  })

  it('非 learn 且非 skip（manual/auto-safe/缺省）：不授予——审批/自愈走原路径', () => {
    assert.equal(shouldAutoGrantSandboxDenial('1', 'manual', true), false)
    assert.equal(shouldAutoGrantSandboxDenial('1', 'auto-safe', true), false)
    assert.equal(shouldAutoGrantSandboxDenial('0', undefined, true), false)
  })

  it('源码契约：tool-pipeline 每次调用注入 approvalMode + approvalGrantedAt（bare string/number，tools 不反依赖 agent 类型）', () => {
    const pipeline = readFileSync(new URL('../../agent/tool-pipeline.ts', import.meta.url), 'utf8')
    assert.match(pipeline, /toolRegistry\.execute\(tu\.name, \{ \.\.\.params, approvalMode,/)
    assert.match(pipeline, /approvalGrantedAt: shouldAsk \? Date\.now\(\) : undefined/)
    const types = readFileSync(new URL('../types.ts', import.meta.url), 'utf8')
    assert.match(types, /approvalMode\?: string/)
    assert.match(types, /approvalGrantedAt\?: number/)
  })
})
