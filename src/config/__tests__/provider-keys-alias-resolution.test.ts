/**
 * 模型引用的别名归一——findModelOwner / findModelInKey 必须接受 preset 短名。
 *
 * 回归背景：这两个函数的注释一直承诺「模型 id 或 alias」，实现却只做
 * `m.id === modelRef` 精确比。配置里写 preset 短名（v4-flash / v4.1-flash 等）会静默
 * 落空，调用方（src/main.ts headless、src/server/serve.ts）随即位置性回退到
 * providerPool[0]——那是另一个档，甚至可能落到上游不认的 id（400）或套餐已到期的卡
 * （429）。归一入口见 src/api/model-aliases.ts 的 canonicalizeModelId。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_KEY_ID, findModelInKey, findModelOwner } from '../provider-keys.js'
import { canonicalizeModelId } from '../../api/model-aliases.js'
import type { ProviderConfig } from '../schema.js'

/** 最小 ProviderConfig 形状——只填被测字段，其余用断言无关的占位。 */
function provider(overrides: Record<string, unknown>): ProviderConfig {
  return {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    capabilities: {},
    thinking: 'enabled',
    maxTokens: 64_000,
    models: [],
    unsupported: [],
    ...overrides,
  } as unknown as ProviderConfig
}

const model = (id: string) => ({ id }) as unknown as ProviderConfig['models'][number]

/** deepseek preset 的模型表，顺序与 src/config/provider-presets.ts 一致。 */
const deepseekModels = [
  model('deepseek-v4-flash'),
  model('deepseek-v4-pro'),
  model('deepseek-flash'),
]

describe('模型引用别名归一', () => {
  it('canonicalizeModelId：短名/旧名归一到 canonical id', () => {
    assert.equal(canonicalizeModelId('v4.1-flash'), 'deepseek-flash')
    assert.equal(canonicalizeModelId('v4-flash'), 'deepseek-v4-flash')
    assert.equal(canonicalizeModelId('deepseek-flash'), 'deepseek-flash')
  })

  it('canonicalizeModelId：表外名字原样返回——不猜、不模糊匹配', () => {
    assert.equal(canonicalizeModelId('totally-unknown-model'), 'totally-unknown-model')
  })

  it('findModelOwner：精确 id 命中，行为与改动前一致', () => {
    const owner = findModelOwner(provider({ models: deepseekModels }), 'deepseek-flash')
    assert.equal(owner?.model.id, 'deepseek-flash')
  })

  it('findModelOwner：旧名归一后命中 canonical 条目，不再落到 models[0]', () => {
    const owner = findModelOwner(provider({ models: deepseekModels }), 'v4.1-flash')
    assert.equal(owner?.model.id, 'deepseek-flash')
    // models[0] 是改动前的错误落点——回退到它就是把请求打到另一个档。
    assert.notEqual(owner?.model.id, 'deepseek-v4-flash')
  })

  it('findModelOwner：表外名字仍 fail-closed（undefined）', () => {
    assert.equal(
      findModelOwner(provider({ models: deepseekModels }), 'deepseek-v9-typo'),
      undefined,
    )
  })

  it('findModelInKey：三段式 `provider:keyId:modelId` 的末段同样接受短名', () => {
    const prov = provider({
      models: [],
      keys: [{ id: DEFAULT_KEY_ID, models: deepseekModels }],
    })
    const owner = findModelInKey(prov, DEFAULT_KEY_ID, 'v4.1-flash')
    assert.equal(owner?.model.id, 'deepseek-flash')
  })

  it('findModelInKey：keyId 不匹配时不跨 key 命中', () => {
    const prov = provider({
      models: [],
      keys: [{ id: DEFAULT_KEY_ID, models: deepseekModels }],
    })
    assert.equal(findModelInKey(prov, 'other-key', 'v4.1-flash'), undefined)
  })
})
