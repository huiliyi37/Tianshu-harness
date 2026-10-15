import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, mapProviderModels, tianshuModelInfo, TIANSHU_VENDOR, MODEL_ID } from '../src/chat/model-provider.ts'
import type { ProviderConfigList } from '../src/sidecar/protocol.ts'

// BYOK model provider 的纯函数面：VS Code 不给 chat 路由任何请求，除非有模型注册；
// vendor/model 身份一旦漂移，chat-gate 补丁的 fallback 与 contribution 点都对不上。

test('model id 按 vendor 命名空间', () => {
  assert.equal(TIANSHU_VENDOR, 'tianshu')
  assert.equal(MODEL_ID, `${TIANSHU_VENDOR}/agent`)
})

test('modelInfo 报出稳定身份与正数限额', () => {
  const info = tianshuModelInfo()
  assert.equal(info.id, MODEL_ID)
  assert.equal(info.family, 'tianshu')
  assert.ok(info.maxInputTokens > 0)
  assert.ok(info.maxOutputTokens > 0)
})

test('每次调用返回新对象（调用方改不污染后续）', () => {
  const a = tianshuModelInfo()
  const b = tianshuModelInfo()
  assert.notEqual(a, b)
  assert.deepEqual(a, b)
})

test('estimateTokens：空白为 0、非空白至少 1、单调不减', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('   \n\t '), 0)
  assert.ok(estimateTokens('a') >= 1)
  assert.ok(estimateTokens('a'.repeat(100)) >= estimateTokens('a'))
})

test('capabilities 声明 Agent 模式所需的 toolCalling（fork 模型池按 suitableForAgentMode 过滤）', () => {
  // chat 默认 Agent 模式；fork 的模型池过滤掉 !toolCalling 的模型——
  // 声明 false 会让本模型在默认模式下整体不可选（no-model-at-toolbar-build）。
  // 此通道不推理；真实工具执行在 participant/sidecar——此处是呈现层声明。
  const info = tianshuModelInfo()
  assert.equal(info.capabilities.toolCalling, true)
  assert.equal(info.capabilities.imageInput, false)
})

test('mapProviderModels：内核 provider 目录 → chat 模型信息（id/窗口/视觉/工具）', () => {
  const catalog: ProviderConfigList = {
    providers: [
      {
        name: 'deepseek',
        label: 'DeepSeek 官方',
        isDefault: true,
        keyStatus: { source: 'env', ref: 'DEEPSEEK_API_KEY' },
        isPreset: true,
        models: [
          { id: 'deepseek-v4-pro', description: '旗舰推理档，1M 上下文', contextWindow: 1_000_000, maxTokens: 65_536 },
          { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 8_192, supportsVision: true },
        ],
      },
    ],
    unconfigured: [],
  }
  const mapped = mapProviderModels(catalog)
  assert.equal(mapped.length, 2)
  const [pro, flash] = mapped
  assert.equal(pro?.id, 'deepseek-v4-pro')
  assert.equal(pro?.name, 'deepseek-v4-pro')
  assert.equal(pro?.family, 'deepseek')
  assert.equal(pro?.detail, '旗舰推理档，1M 上下文')
  assert.equal(pro?.maxInputTokens, 1_000_000)
  assert.equal(pro?.maxOutputTokens, 65_536)
  assert.equal(pro?.capabilities.toolCalling, true)
  assert.equal(pro?.capabilities.imageInput, false)
  assert.equal(flash?.capabilities.imageInput, true)
})

test('mapProviderModels：空目录 → 空列表；缺省字段保守兜底、脏数据容错', () => {
  assert.deepEqual(mapProviderModels({ providers: [], unconfigured: [] }), [])
  const sparse = mapProviderModels({
    providers: [
      {
        name: 'kimi',
        label: 'Kimi',
        isDefault: false,
        keyStatus: { source: 'inline', ref: '***fixture' },
        isPreset: false,
        models: [{ id: 'k3' }, { id: '' }, { id: 'k3' }],
      },
    ],
    unconfigured: [],
  })
  // 空 id 丢弃；同 id 去重（内核目录同名模型只应出现一次）
  assert.equal(sparse.length, 1)
  assert.equal(sparse[0]?.id, 'k3')
  assert.equal(sparse[0]?.family, 'kimi')
  assert.equal(sparse[0]?.maxInputTokens, 128_000)
  assert.equal(sparse[0]?.maxOutputTokens, 8_192)
  assert.equal(sparse[0]?.detail, 'Kimi')
})

test('model picker hides unconfigured providers and retains inline, env, OAuth and keyless models', () => {
  const provider = (name: string, extra: object = {}) => ({
    name, label: name, isDefault: false, isPreset: true,
    keyStatus: { source: 'none' as const, ref: '' }, models: [{ id: name }], ...extra,
  })
  const mapped = mapProviderModels({ providers: [
    provider('unconfigured'),
    provider('inline', { keyStatus: { source: 'inline', ref: '***fixture' } }),
    provider('env', { keyStatus: { source: 'env', ref: 'FIXTURE_KEY' } }),
    provider('oauth', { authType: 'oauth', oauthAuthenticated: true }),
    provider('logged-out', { authType: 'oauth', oauthAuthenticated: false }),
    provider('keyless', { keyless: true }),
  ] as ProviderConfigList['providers'], unconfigured: [] })
  assert.deepEqual(mapped.map(model => model.id), ['inline', 'env', 'oauth', 'keyless'])
})

test('model picker checks each model owner instead of the provider default key', () => {
  const mapped = mapProviderModels({ providers: [{
    name: 'deepseek', label: 'fixture', isDefault: false, isPreset: true,
    keyStatus: { source: 'none', ref: '' },
    models: [{ id: 'unconfigured' }, { id: 'secondary' }, { id: 'duplicate' }, { id: 'unowned' }],
    keys: [
      { id: 'default', keyStatus: { source: 'none', ref: '' }, models: [{ id: 'unconfigured' }, { id: 'duplicate' }] },
      { id: 'secondary', keyStatus: { source: 'inline', ref: '***fixture' }, models: [{ id: 'secondary' }, { id: 'duplicate' }] },
    ],
  }] as ProviderConfigList['providers'], unconfigured: [] })
  assert.deepEqual(mapped.map(model => model.id), ['secondary'], 'duplicate ids retain the kernel first-owner rule')
})

test('a ready provider default key cannot expose a model owned by an unconfigured key', () => {
  const mapped = mapProviderModels({ providers: [{
    name: 'deepseek', label: 'fixture', isDefault: false, isPreset: true,
    keyStatus: { source: 'inline', ref: '***fixture' },
    models: [{ id: 'primary' }, { id: 'empty-secondary' }],
    keys: [
      { id: 'default', keyStatus: { source: 'inline', ref: '***fixture' }, models: [{ id: 'primary' }] },
      { id: 'secondary', keyStatus: { source: 'none', ref: '' }, models: [{ id: 'empty-secondary' }] },
    ],
  }] as ProviderConfigList['providers'], unconfigured: [] })
  assert.deepEqual(mapped.map(model => model.id), ['primary'])
})
