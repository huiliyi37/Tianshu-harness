/**
 * updateTools 字节级幂等守卫（2026-09-06 缓存碎裂根修 P2）。
 *
 * MCP 重连/插件重复注册/applyFace 重挂会以同一份工具定义反复调用
 * PromptEngine.updateTools——修复前每次都 bump toolsUpdateCount 并重算
 * fingerprint，同名工具重注册也把前缀打碎（主会话 toolsUpdated 碎裂事件）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { ToolDefinition } from '../../api/types.js'

function mkTool(name: string, desc = `${name} tool`): ToolDefinition {
  return { name, description: desc, input_schema: { type: 'object', properties: {} } } as ToolDefinition
}

function mkEngine(tools: ToolDefinition[]): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    staticCtx: { tools },
    volatileCtx: { cwd: '/repo' },
    habituationThreshold: 0,
  })
}

describe('updateTools 字节级幂等守卫', () => {
  it('同内容新数组：fingerprint 与 toolsUpdates 计数均不动', () => {
    const e = mkEngine([mkTool('read_file'), mkTool('bash')])
    const fp = e.getFingerprint().combinedSha256
    const updates0 = e.getCacheEventStats().toolsUpdates

    e.updateTools([mkTool('read_file'), mkTool('bash')])
    e.updateTools([mkTool('read_file'), mkTool('bash')])

    assert.equal(e.getFingerprint().combinedSha256, fp, '字节不变 → 指纹不变（前缀不碎）')
    assert.equal(e.getCacheEventStats().toolsUpdates, updates0, '字节不变 → 不计 toolsUpdated')
  })

  it('真实变化（增工具/改描述）：fingerprint 变、计数递增', () => {
    const e = mkEngine([mkTool('read_file'), mkTool('bash')])
    const fp = e.getFingerprint().combinedSha256
    const updates0 = e.getCacheEventStats().toolsUpdates

    e.updateTools([mkTool('read_file'), mkTool('bash'), mkTool('grep')])
    assert.notEqual(e.getFingerprint().combinedSha256, fp)
    assert.equal(e.getCacheEventStats().toolsUpdates, updates0 + 1)

    e.updateTools([mkTool('read_file'), mkTool('bash', 'bash tool v2'), mkTool('grep')])
    assert.equal(e.getCacheEventStats().toolsUpdates, updates0 + 2, '描述变化也是真实变化')
  })

  it('纯重排：上线字节按数组序 → 视为变化（保守重建，与旧行为一致）', () => {
    const e = mkEngine([mkTool('read_file'), mkTool('bash')])
    const updates0 = e.getCacheEventStats().toolsUpdates
    e.updateTools([mkTool('bash'), mkTool('read_file')])
    assert.equal(e.getCacheEventStats().toolsUpdates, updates0 + 1, '数组序变 = 请求字节变 = 必须重建')
  })

  it('空数组反复更新：幂等不炸', () => {
    const e = mkEngine([])
    const updates0 = e.getCacheEventStats().toolsUpdates
    e.updateTools([])
    assert.equal(e.getCacheEventStats().toolsUpdates, updates0)
  })
})
