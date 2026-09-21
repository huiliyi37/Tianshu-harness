import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setupProvider } from '../manager.js'

/**
 * 2026-09 模型保存语义修复的回归锚：
 *  1. 用户在探测列表勾选了哪些模型，落库就是哪些——预设模板其余模型不得混入；
 *  2. 模型只按原 ID 保存——modelConfigSchema 不再接受/持久化 alias 字段；
 *  3. 存量配置加载时自愈：剥 alias、同 provider 内按 id 去重。
 * 症状起点：kimi 保存单模型却落 5 条（含旧预设残留 kimi-k2.7-code@k27-code
 * 与重复 k3），glm-5.3 在 /model 选择器里显示为短名 glm-53。
 */
describe('model save semantics: id-only, selection-only', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-alias-fix-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('setupProvider 传 models 时按勾选整组落库——预设其余模型不混入', () => {
    setupProvider({
      providerName: 'kimi',
      preset: 'kimi',
      apiKey: 'sk-test',
      models: [{ id: 'k3', contextWindow: 1_000_000, maxTokens: 131072 }],
    })
    const models = loadConfig().provider.providers.kimi!.models
    assert.equal(models.length, 1, `只勾选了 k3，落库却是 ${models.map(m => m.id).join(',')}——预设模板混入`)
    assert.equal(models[0]!.id, 'k3')
  })

  it('modelsMode=append：连续批量保存并入既有清单，不清空上一批', () => {
    setupProvider({
      providerName: 'kimi',
      preset: 'kimi',
      models: [{ id: 'k3', contextWindow: 1_000_000, maxTokens: 131072, pricing: { input: 1, output: 2 }, tier: 'strong' }],
    })
    setupProvider({
      providerName: 'kimi',
      models: [{ id: 'k3-256k', contextWindow: 262_144, maxTokens: 131_072 }],
      modelsMode: 'append',
    })
    setupProvider({
      providerName: 'kimi',
      models: [{ id: 'kimi-for-coding', contextWindow: 262_144, maxTokens: 32_768 }],
      modelsMode: 'append',
    })
    // 同 id 再 append：字段合并、位置不变、既有 pricing/tier 不丢。
    setupProvider({
      providerName: 'kimi',
      models: [{ id: 'k3', contextWindow: 900_000, maxTokens: 128_000 }],
      modelsMode: 'append',
    })

    const models = loadConfig().provider.providers.kimi!.models
    assert.deepEqual(models.map(m => m.id), ['k3', 'k3-256k', 'kimi-for-coding'],
      'append 必须保留前几批；整组替换会让连续保存只剩最后一批')
    assert.equal(models[0]!.contextWindow, 900_000)
    assert.equal(models[0]!.maxTokens, 128_000)
    assert.deepEqual(models[0]!.pricing, { input: 1, output: 2 }, 'append 合并不得丢 pricing')
    assert.equal(models[0]!.tier, 'strong', 'append 合并不得丢 tier')
  })

  it('setupProvider 落库的模型不含 alias 字段（id-only）', () => {
    setupProvider({
      providerName: 'kimi',
      preset: 'kimi',
      apiKey: 'sk-test',
      models: [{ id: 'k3', contextWindow: 1_000_000, maxTokens: 131072 }],
    })
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    for (const m of raw.provider.providers.kimi.models) {
      assert.equal('alias' in m, false, `模型 ${m.id} 仍带 alias 字段：${JSON.stringify(m.alias)}`)
    }
  })

  it('前端就算传 alias，schema 也剥掉（strip 而非 reject——旧客户端兼容）', () => {
    setupProvider({
      providerName: 'kimi',
      preset: 'kimi',
      apiKey: 'sk-test',
      models: [{ id: 'k3', alias: 'k3', contextWindow: 1_000_000, maxTokens: 131072 }] as never[],
    })
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.equal(raw.provider.providers.kimi.models.length, 1)
    assert.equal('alias' in raw.provider.providers.kimi.models[0], false)
  })

  it('未传 models 时沿用预设全量（快速路径行为不变），但同样无 alias', () => {
    setupProvider({ providerName: 'kimi', preset: 'kimi', apiKey: 'sk-test' })
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.ok(raw.provider.providers.kimi.models.length >= 1)
    for (const m of raw.provider.providers.kimi.models) {
      assert.equal('alias' in m, false)
    }
  })

  it('存量配置加载自愈：剥 alias + 同 provider 按 id 去重', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      provider: {
        default: 'kimi',
        providers: {
          kimi: {
            name: 'kimi',
            userSaved: true,
            baseUrl: 'https://api.kimi.com/coding/v1',
            apiKeyEnv: 'KIMI_API_KEY',
            protocol: 'openai',
            capabilities: {
              cacheControl: false,
              stripParams: [],
              toolJsonBug: false,
              prefixCache: 'none',
              prefixCompletion: false,
            },
            thinking: 'enabled',
            maxTokens: 131072,
            models: [
              { id: 'kimi-for-coding', alias: 'kimi', contextWindow: 256000, maxTokens: 64000 },
              { id: 'k3', alias: 'k3', contextWindow: 1000000, maxTokens: 131072 },
              { id: 'kimi-k2.7-code', alias: 'k27-code', contextWindow: 262144, maxTokens: 32768 },
              { id: 'k3', alias: 'k3', contextWindow: 1000000, maxTokens: 131072 },
              { id: 'k3-256k', alias: 'k3-256k', contextWindow: 262144, maxTokens: 131072 },
            ],
            unsupported: [],
          },
        },
      },
    }), 'utf8')
    const models = loadConfig().provider.providers.kimi!.models
    assert.equal(models.length, 4, `去重后应 4 条，实际 ${models.length}：${models.map(m => m.id).join(',')}`)
    assert.deepEqual(models.map(m => m.id), ['kimi-for-coding', 'k3', 'kimi-k2.7-code', 'k3-256k'])
    const rawCfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    for (const m of rawCfg.provider.providers.kimi.models) {
      assert.equal('alias' in m, false, `模型 ${m.id} 的 alias 未剥`)
    }
  })

  it('键池 keys[].models 同样剥 alias 去重（自愈覆盖两层存储）', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      provider: {
        default: 'kimi',
        providers: {
          kimi: {
            name: 'kimi',
            userSaved: true,
            baseUrl: 'https://api.kimi.com/coding/v1',
            apiKeyEnv: 'KIMI_API_KEY',
            protocol: 'openai',
            capabilities: {
              cacheControl: false,
              stripParams: [],
              toolJsonBug: false,
              prefixCache: 'none',
              prefixCompletion: false,
            },
            thinking: 'enabled',
            maxTokens: 131072,
            models: [],
            keys: [{
              id: 'k1',
              keyRef: 'kimi/k1',
              models: [
                { id: 'k3', alias: 'k3', contextWindow: 1000000, maxTokens: 131072 },
                { id: 'k3', contextWindow: 1000000, maxTokens: 131072 },
              ],
            }],
            unsupported: [],
          },
        },
      },
    }), 'utf8')
    const key = loadConfig().provider.providers.kimi!.keys![0]!
    assert.equal(key.models.length, 1, `keys 池内同 id 未去重：${key.models.map(m => m.id).join(',')}`)
    assert.equal('alias' in key.models[0]!, false)
  })
})
