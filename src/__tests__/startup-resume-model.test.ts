/**
 * decideStartupResumeModel — 启动 resume 模型亲和决策（纯函数）。
 *
 * 契约：显式 --model/--provider 优先（用户意图 > 缓存亲和）；原模型命中直接用；
 * 不可用走 resumeFallbackModel 兜底；兜底也没有 → 警告降级**不 fail-closed**
 * （startup 是进程入口，拒跑等于会话打不开——与 switchAgentSession 的
 * fail-closed 语义差异是刻意的）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideStartupResumeModel, type ResolvedModelTarget } from '../bootstrap.js'

const baseProviders = {
  deepseek: {
    name: 'deepseek',
    models: [{ id: 'ds-v4', alias: 'v4', contextWindow: 1000000 }],
    apiKey: 'key-ds',
  },
}

function fakeResolve(modelId: string): ResolvedModelTarget | { error: string } | null {
  const found = baseProviders.deepseek.models.find(m => m.id === modelId)
  if (!found) return null
  return {
    provider: baseProviders.deepseek as unknown as ResolvedModelTarget['provider'],
    providerName: 'deepseek',
    apiKey: 'key-ds',
    auth: undefined,
    modelId: found.id,
  }
}

test('非 resume / 显式 flag → 不干预（target=null）', () => {
  assert.equal(decideStartupResumeModel({ resumed: false, originalModel: 'ds-v4', resolve: fakeResolve }).target, null)
  assert.equal(decideStartupResumeModel({ resumed: true, explicitModel: 'other', originalModel: 'ds-v4', resolve: fakeResolve }).target, null)
  assert.equal(decideStartupResumeModel({ resumed: true, explicitProvider: 'glm', originalModel: 'ds-v4', resolve: fakeResolve }).target, null)
})

test('原模型命中 → 用原模型（id 直取，alias 已废弃）', () => {
  const d = decideStartupResumeModel({ resumed: true, originalModel: 'ds-v4', resolve: fakeResolve })
  assert.ok(d.target)
  assert.equal(d.target.modelId, 'ds-v4')
  assert.equal(d.fallbackUsed, false)
  assert.equal(d.degradedWarning, undefined)
})

test('原模型不可用 + 兜底可用 → 兜底 + fallbackUsed 标记（供审计）', () => {
  const d = decideStartupResumeModel({
    resumed: true,
    originalModel: 'ghost-model-x',
    fallbackModelId: 'ds-v4',
    resolve: fakeResolve,
  })
  assert.ok(d.target)
  assert.equal(d.target.modelId, 'ds-v4')
  assert.equal(d.fallbackUsed, true)
  assert.equal(d.originalModel, 'ghost-model-x')
})

test('原模型与兜底都不可用 → 警告降级不 fail-closed', () => {
  const d = decideStartupResumeModel({
    resumed: true,
    originalModel: 'ghost-model-x',
    fallbackModelId: 'ghost-y',
    resolve: fakeResolve,
  })
  assert.equal(d.target, null, '不阻断启动')
  assert.equal(d.fallbackUsed, false)
  assert.match(d.degradedWarning ?? '', /ghost-model-x/)
  assert.match(d.degradedWarning ?? '', /全量重建/)
})

test('meta 无 model 记录（旧会话）→ 不干预', () => {
  const d = decideStartupResumeModel({ resumed: true, originalModel: undefined, resolve: fakeResolve })
  assert.equal(d.target, null)
})
