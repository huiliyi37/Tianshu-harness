/**
 * switchAgentRuntime — 模型切换查找/错误路径测试。
 *
 * 仅覆盖 createAgentRuntime 之前可确定性断言的分支（未找到模型 / 缺少 API key），
 * 成功路径会重建完整 AgentLoop（重型依赖），由真终端手验覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderForModel, switchAgentRuntime } from '../bootstrap.js'
import type { BootstrapContext } from '../bootstrap.js'
import { resolveInitialReasoningEffort } from '../bootstrap.js'
import { resolveCapabilities } from '../api/provider.js'

function makeCtx(providers: Record<string, unknown>, currentName = 'p1'): BootstrapContext {
  return {
    config: { provider: { providers } },
    provider: { name: currentName },
  } as unknown as BootstrapContext
}

test('显式 provider 约束只解析该 provider 下的同名模型', () => {
  delete process.env.__RIVET_TEST_WRONG_PROVIDER_KEY__
  const ctx = makeCtx({
    first: { name: 'first', apiKeyEnv: '__RIVET_TEST_WRONG_PROVIDER_KEY__', models: [{ id: 'shared-model' }] },
    second: { name: 'second', apiKey: 'second-key', models: [{ id: 'shared-model' }] },
  })

  const resolved = resolveProviderForModel(ctx, 'shared-model', 'second')
  assert.ok(resolved && !('error' in resolved))
  assert.equal(resolved.providerName, 'second')
  assert.equal(resolved.apiKey, 'second-key')
})

test('未显式指定 provider 时保持按配置顺序解析的旧语义', () => {
  delete process.env.__RIVET_TEST_FIRST_PROVIDER_KEY__
  const ctx = makeCtx({
    first: { name: 'first', apiKeyEnv: '__RIVET_TEST_FIRST_PROVIDER_KEY__', models: [{ id: 'shared-model' }] },
    second: { name: 'second', apiKey: 'second-key', models: [{ id: 'shared-model' }] },
  })

  const resolved = resolveProviderForModel(ctx, 'shared-model')
  assert.ok(resolved && 'error' in resolved)
  assert.match(resolved.error, /first/)
})

test('未知模型返回 not found，不重建 agent', () => {
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'm1', alias: 'mm' }] },
  })
  const res = switchAgentRuntime(ctx, 'does-not-exist')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /not found/i)
})

test('找到模型但缺少 API key → 返回 API key 错误（非 oauth）', () => {
  // 切换目标在另一个 provider 上，无 apiKey / apiKeyEnv 未设
  delete process.env.__RIVET_TEST_MISSING_KEY__
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'cur', alias: 'cur' }] },
    p2: { name: 'p2', apiKeyEnv: '__RIVET_TEST_MISSING_KEY__', models: [{ id: 'target', alias: 't' }] },
  })
  const res = switchAgentRuntime(ctx, 'target')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /API key/i)
})

test('模型存在但缺 key：报 API key 而非 not found（未找到分支不误报）', () => {
  // 判据是「找到了模型、只是 key 缺失」。config 的 model.alias 字段 2026-09 起
  // 废弃（不落盘、不作为模型引用），故这里按 id 引用——按 alias 引用不再解析
  // 是预期的 fail-closed 行为，不再断言。
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'cur' }] },
    p2: { name: 'p2', apiKeyEnv: '__RIVET_TEST_MISSING_KEY2__', models: [{ id: 'real-id' }] },
  })
  const res = switchAgentRuntime(ctx, 'real-id')
  assert.equal(res.ok, false)
  assert.doesNotMatch(res.error ?? '', /not found/i)
  assert.match(res.error ?? '', /API key/i)
})

test('resolveInitialReasoningEffort preserves undefined when no effort configured', () => {
  const caps = resolveCapabilities('deepseek')
  assert.equal(resolveInitialReasoningEffort(undefined, caps), undefined)
})

test('resolveInitialReasoningEffort normalizes DeepSeek aliases (medium -> high, off -> off)', () => {
  const caps = resolveCapabilities('deepseek')
  assert.equal(resolveInitialReasoningEffort('medium', caps), 'high')
  assert.equal(resolveInitialReasoningEffort('off', caps), 'off')
  assert.equal(resolveInitialReasoningEffort('low', caps), 'low')
  assert.equal(resolveInitialReasoningEffort('high', caps), 'high')
  assert.equal(resolveInitialReasoningEffort('max', caps), 'max')
})

test('resolveInitialReasoningEffort normalizes Grok unsupported off -> low and preserves max', () => {
  const caps = resolveCapabilities('grok')
  assert.equal(resolveInitialReasoningEffort('off', caps), 'low')
  assert.equal(resolveInitialReasoningEffort('max', caps), 'max')
})

test('resolveInitialReasoningEffort normalizes StepFun max -> high and off -> low', () => {
  const caps = resolveCapabilities('stepfun')
  assert.equal(resolveInitialReasoningEffort('max', caps), 'high')
  assert.equal(resolveInitialReasoningEffort('off', caps), 'low')
})