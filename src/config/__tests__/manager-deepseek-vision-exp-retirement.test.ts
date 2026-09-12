import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { cloneProviderPreset } from '../provider-presets.js'

/**
 * deepseek-v4-flash-vision-exp 退役（2026-09-12 决策；官方文档：旧名仍可调用，
 * 但请求由最新的 Flash 承接，即该档已下线）。
 *
 * 与 v4-pro 退役同族：preset 删条目到不了存量快照（deepMerge 对数组整组替换）。
 * 但它多一层必要性——该档声明了 supportsVision，只要它排在存量快照的视觉档首位，
 * 同 provider 自动识图桥就会选中它。实测（2026-09-12 探针，真实 config）：
 *   detail = "自动选用 deepseek/deepseek-v4-flash-vision-exp"
 * 退役后自动桥落到 deepseek-flash；指向它的 defaultModel / visionModel 一并重定向，
 * 否则会静默回退 models[0] 或在启动时报「模型不存在」。
 */
describe('deepseek-v4-flash-vision-exp 退役 — loadConfig 端到端', () => {
  const RETIRED = 'deepseek-v4-flash-vision-exp'
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-vision-exp-retire-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  /** 存量形态：快照写于 preset 仍含视觉实验档的时期（顺序照实测：-exp 在前）。 */
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
              { id: RETIRED, alias: 'v4-vision', contextWindow: 1_000_000, maxTokens: 384_000, supportsVision: true },
              { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 384_000, supportsVision: true },
            ],
          },
        },
      },
    }))
  }

  it('删掉存量快照里的视觉实验档，同 provider 的其他模型原样保留', () => {
    writeStaleDeepseek()
    const models = loadConfig().provider.providers.deepseek!.models

    assert.equal(models.some(m => m.id === RETIRED), false, '退役型号不再留在卡池里')
    assert.ok(models.some(m => m.id === 'deepseek-flash'), '正式视觉档不受牵连')
    assert.equal(models.find(m => m.id === 'deepseek-flash')!.supportsVision, true, '视觉声明保留')
  })

  it('修复回写磁盘——下一次启动不必再迁一遍', () => {
    writeStaleDeepseek()
    loadConfig()
    assert.equal(readFileSync(configPath, 'utf-8').includes(RETIRED), false, 'user config 已原地修复')
  })

  it('idempotent：第二次加载不再改写磁盘，也不报错', () => {
    writeStaleDeepseek()
    loadConfig()
    const afterFirst = readFileSync(configPath, 'utf-8')
    loadConfig()
    assert.equal(readFileSync(configPath, 'utf-8'), afterFirst)
  })

  it('agent.visionModel 指向退役档时重定向到 deepseek-flash', () => {
    // 不重定向的话，桥会在启动时报「provider 下没有模型」（图片照旧丢）。
    writeStaleDeepseek({ agent: { visionModel: { provider: 'deepseek', model: RETIRED, maxTokens: 1024 } } })
    assert.equal(loadConfig().agent.visionModel?.model, 'deepseek-flash')
  })

  it('visionModel 用 alias（v4-vision）写的同样接住', () => {
    writeStaleDeepseek({ agent: { visionModel: { provider: 'deepseek', model: 'v4-vision', maxTokens: 1024 } } })
    assert.equal(loadConfig().agent.visionModel?.model, 'deepseek-flash')
  })

  it('visionModel 指向别的 provider 时不动', () => {
    writeStaleDeepseek({ agent: { visionModel: { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 1024 } } })
    assert.equal(loadConfig().agent.visionModel?.model, 'MiniMax-M3')
  })

  it('agent.defaultModel 指向退役档时重定向到 deepseek-flash', () => {
    writeStaleDeepseek({ agent: { defaultModel: `deepseek:${RETIRED}` } })
    assert.equal(loadConfig().agent.defaultModel, 'deepseek:deepseek-flash')
  })

  it('别的 provider 下的同名自建条目保留', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: { ...cloneProviderPreset('deepseek'), apiKey: 'sk-test' },
          relay: {
            ...cloneProviderPreset('relay'),
            apiKey: 'sk-relay',
            models: [{ id: RETIRED, contextWindow: 1_000_000, maxTokens: 384_000, supportsVision: true }],
          },
        },
      },
    }))
    assert.ok(
      loadConfig().provider.providers.relay!.models.some(m => m.id === RETIRED),
      '中转 provider 的自建条目不动——退役只针对 deepseek 官方',
    )
  })

  it('userSaved provider 只剩退役档时不删空', () => {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...cloneProviderPreset('deepseek'),
            apiKey: 'sk-test',
            userSaved: true,
            models: [{ id: RETIRED, contextWindow: 1_000_000, maxTokens: 384_000, supportsVision: true }],
          },
        },
      },
    }))
    assert.equal(loadConfig().provider.providers.deepseek!.models.length, 1, '空 models 过不了 schema 校验，宁可留一张坏卡')
  })
})
