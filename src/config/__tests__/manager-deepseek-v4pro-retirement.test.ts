import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { cloneProviderPreset } from '../provider-presets.js'

/**
 * deepseek-v4-pro 退役（2026-09-11 决策，官方 2026-09-14 下线）。
 *
 * preset 已删条目，但 config.json 存的是「应用预设那一刻」的模型快照，而
 * deepMerge 对数组整组替换——**单改 preset 到不了任何已装过的用户**。这组用例
 * 锁的是加载期退役迁移：存量快照里的 v4pro 必须消失，否则强档席位（议事会天府 /
 * 三柱护栏席，瑶光门 tierFloor='strong'）会继续按 3/6 的价格调它，而界面上显示的
 * 还是会话默认的 v4-flash。
 *
 * 同型先例：migrateDeepseekMaxTokens（maxTokens 回归）、migrateV4FlashEffort。
 */
describe('deepseek-v4-pro 退役 — loadConfig 端到端', () => {
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-v4pro-retire-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  /** 存量形态：provider 快照写于 preset 仍含 v4pro 的时期。 */
  function writeStaleDeepseek(extra?: Record<string, unknown>): void {
    writeFileSync(configPath, JSON.stringify({
      ...extra,
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            models: [
              { id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEffort: 'max' },
              { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 384_000, reasoningEffort: 'high' },
            ],
          },
        },
      },
    }))
  }

  it('删掉存量快照里的 v4pro，同 provider 的其他模型原样保留', () => {
    writeStaleDeepseek()
    const models = loadConfig().provider.providers.deepseek!.models

    assert.equal(models.some(m => m.id === 'deepseek-v4-pro'), false, '退役型号不再留在卡池里')
    const flash = models.find(m => m.id === 'deepseek-v4-flash')!
    assert.equal(flash.reasoningEffort, 'max', '同 provider 的邻近模型不被牵连')
    assert.equal(flash.alias, 'v4-flash')
  })

  it('修复回写磁盘——下一次启动不必再迁一遍', () => {
    writeStaleDeepseek()
    loadConfig()
    assert.equal(readFileSync(configPath, 'utf-8').includes('deepseek-v4-pro'), false, 'user config 已原地修复')
  })

  it('idempotent：第二次加载不再改写磁盘，也不报错', () => {
    writeStaleDeepseek()
    loadConfig()
    const afterFirst = readFileSync(configPath, 'utf-8')
    loadConfig()
    assert.equal(readFileSync(configPath, 'utf-8'), afterFirst)
  })

  it('agent.defaultModel 指向 v4pro 时重定向到 deepseek-flash', () => {
    writeStaleDeepseek({ agent: { defaultModel: 'deepseek:deepseek-v4-pro' } })
    assert.equal(loadConfig().agent.defaultModel, 'deepseek:deepseek-flash')
  })

  it('用 alias 写进 defaultModel 的（deepseek:v4-pro）同样接住', () => {
    // main.ts 按 id 或 alias 匹配，两种写法都合法——只接 id 会漏掉一半存量配置。
    writeStaleDeepseek({ agent: { defaultModel: 'deepseek:v4-pro' } })
    assert.equal(loadConfig().agent.defaultModel, 'deepseek:deepseek-flash')
  })

  it('跨 provider 的 defaultModel 不受影响', () => {
    writeStaleDeepseek({ agent: { defaultModel: 'glm:glm-5.2' } })
    assert.equal(loadConfig().agent.defaultModel, 'glm:glm-5.2')
  })

  it('别的 provider 下的同名自建条目保留', () => {
    // 第三方中转常把上游型号名原样透传；退役只针对 deepseek 官方 provider，
    // 否则会误删用户自己接的可用通道。
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: { ...cloneProviderPreset('deepseek'), apiKey: 'sk-test' },
          relay: {
            ...cloneProviderPreset('relay'),
            apiKey: 'sk-relay',
            models: [{ id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 128_000, maxTokens: 8_000, tier: 'strong' }],
          },
        },
      },
    }))
    const relay = loadConfig().provider.providers.relay!
    assert.ok(relay.models.some(m => m.id === 'deepseek-v4-pro'), '中转 provider 的自建条目不动')
  })

  it('userSaved provider 只剩 v4pro 时不删空——空 models 过不了 schema 校验', () => {
    // 这是迁移里唯一一处「宁可留一张坏卡」的取舍：删空会让整个配置加载抛错
    // （ConfigLoadError），代价远大于多留一条即将失效的条目。userSaved 标记
    // 让 migratePresetModelBackfill 也跳过，所以这里是真的只剩一条。
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [{ id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 384_000 }],
          },
        },
      },
    }))
    const models = loadConfig().provider.providers.deepseek!.models
    assert.equal(models.length, 1, '不删空')
    assert.equal(models[0]?.id, 'deepseek-v4-pro')
  })
})
