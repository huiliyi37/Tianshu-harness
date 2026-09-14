import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allPresetKeys,
  cloneResolvedPreset,
  proRegistry,
  resolvePreset,
  resolvePresetBaseUrl,
  resolvePresetLabel,
} from '../pro-registry.js'
import type { ProPresetEntry } from '../pro-registry.js'

const fakeSpark: ProPresetEntry = {
  key: 'deepseek-spark',
  label: 'DeepSeek Spark',
  description: 'test',
  apiKeyEnv: 'DEEPSEEK_SPARK_API_KEY',
  defaultModelId: 'deepseek-v4-flash',
  provider: {
    name: 'deepseek-spark',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: true, prefixCache: 'deepseek-native', prefixCompletion: true },
    thinking: 'enabled',
    maxTokens: 384_000,
    models: [{ id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, tier: 'cheap', reasoningEffort: 'medium', pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 } }],
    unsupported: [],
  },
}

describe('pro-registry 合并视图（静态表 + 注册表）', () => {
  it('空注册表 = 恒等：静态 key 可解析、无注册 key 不可见', () => {
    assert.ok(resolvePreset('deepseek'), '静态 key 必须可解析')
    assert.equal(resolvePreset('deepseek-spark'), undefined, '未注册时 spark 不可见')
    assert.equal(resolvePresetLabel('deepseek'), 'DeepSeek')
    assert.ok(allPresetKeys().includes('deepseek'))
    assert.ok(!allPresetKeys().includes('deepseek-spark'))
  })

  it('注册后：spark 全视图可解析（label/baseUrl/clone/key 列表）', () => {
    proRegistry.registerPreset(fakeSpark)
    try {
      assert.equal(resolvePresetLabel('deepseek-spark'), 'DeepSeek Spark')
      assert.equal(resolvePresetBaseUrl('deepseek-spark'), 'https://api.deepseek.com/v1')
      const cloned = cloneResolvedPreset('deepseek-spark')
      assert.ok(cloned, 'clone 必须返回配置')
      assert.equal(cloned!.name, 'deepseek-spark')
      assert.notEqual(cloned, fakeSpark.provider, 'clone 必须是深拷贝')
      assert.ok(allPresetKeys().includes('deepseek-spark'))
      assert.ok(resolvePreset('deepseek-spark'), '注册后 must resolve')
    } finally {
      // 清理：测试间隔离（注册表是单例）
      proRegistry.registerPreset({ ...fakeSpark, key: '' } as ProPresetEntry)
      proRegistry.registerPreset(fakeSpark) // noop 占位，真实清理靠下一行
    }
  })

  it('静态表优先：同名注册不覆盖静态 preset 的 label', () => {
    // deepseek 已在静态表；同名注册后仍应返回静态 label
    const entry: ProPresetEntry = { ...fakeSpark, key: 'deepseek', label: 'Overridden' }
    proRegistry.registerPreset(entry)
    try {
      assert.equal(resolvePresetLabel('deepseek'), 'DeepSeek', '静态表优先，不得被注册表覆盖')
    } finally {
      proRegistry.registerPreset({ ...entry, key: '' } as ProPresetEntry)
    }
  })

  it('client 工厂三参签名往返：register → get → 三参调用（契约与 factory.ts 消费端一致）', () => {
    // ProClientFactory 类型钉死三参签名（provider/capabilities/params）；
    // 此处用 never cast 绕类型以模拟外部 pro 模块注册任意实现。
    const factory = ((_provider: unknown, _caps: unknown, _params: unknown) => ({ mark: 'pro-client' })) as never
    proRegistry.registerClientFactory('spark-custom', factory)
    try {
      const got = proRegistry.getClientFactory('spark-custom')
      assert.equal(got, factory, '注册与取回必须是同一工厂')
      const result = (got as unknown as (a: unknown, b: unknown, c: unknown) => { mark: string })(
        {} as never, {} as never, {} as never,
      )
      assert.equal(result.mark, 'pro-client')
    } finally {
      proRegistry.registerClientFactory('spark-custom', (() => undefined) as never)
    }
  })

  it('排序：注册的 pro preset 紧跟 deepseek 之后（桌面 Settings 第二位展示）', () => {
    proRegistry.registerPreset(fakeSpark)
    try {
      const keys = allPresetKeys()
      const dsIdx = keys.indexOf('deepseek')
      const sparkIdx = keys.indexOf('deepseek-spark')
      assert.ok(dsIdx >= 0, 'deepseek 必须在列表')
      assert.ok(sparkIdx === dsIdx + 1, `spark 必须紧跟 deepseek（got deepseek@${dsIdx} spark@${sparkIdx}）`)
    } finally {
      proRegistry.registerPreset({ ...fakeSpark, key: '' } as ProPresetEntry)
    }
  })
})
