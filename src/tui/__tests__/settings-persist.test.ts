/**
 * `/config` 落盘测试 —— 关键门禁：面板说「已保存」时，磁盘上**只有**用户改过的
 * 块变了。写错块的杀伤面是双向的：既悄悄回退别处的配置，也让用户以为改的那项
 * 生效了。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setRoutingConfig } from '../../config/manager.js'
import { loadSettingsDraft, loadSettingsEnv, saveSettings } from '../settings-persist.js'
import { SettingsFlow } from '../settings-flow.js'
import { dirtyBlocks, type SettingsDraft } from '../settings-model.js'

describe('settings persist', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-settings-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the effective config into a draft', () => {
    const draft = loadSettingsDraft()
    assert.equal(typeof draft.basics.approval, 'string')
    assert.equal(draft.vision, null)
    assert.ok(Object.keys(draft.workers.profiles).length > 0, 'worker 档位应来自默认配置')
    assert.ok(draft.net.searchBackends.includes('bing'))
  })

  it('只写脏块——其余块的磁盘内容逐字不动', () => {
    const before = loadSettingsDraft()
    // 改成一个非默认档（2026-09-23 起默认 minimal）——否则与基线同值测不到脏块。
    const draft: SettingsDraft = {
      ...before,
      basics: { ...before.basics, toolPreset: 'frontend', checkpointEveryTurns: 7 },
    }
    const blocks = dirtyBlocks(before, draft)
    assert.deepEqual(blocks.sort(), ['checkpoint', 'toolPreset'])

    const result = saveSettings({ draft, blocks })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.saved.sort(), ['checkpoint', 'toolPreset'])

    const after = loadSettingsDraft()
    assert.equal(after.basics.toolPreset, 'frontend')
    assert.equal(after.basics.checkpointEveryTurns, 7)
    // 未列入 blocks 的块必须原样
    assert.deepEqual(after.workers, before.workers)
    assert.deepEqual(after.review, before.review)
    assert.equal(after.vision, null)
    assert.deepEqual(after.net, before.net)
    assert.equal(after.basics.defaultDomain, before.basics.defaultDomain)
  })

  it('改子代理路由不会顺手重写审查块', () => {
    // 先在磁盘上留下一个 review 覆盖，模拟别处已有配置。
    setRoutingConfig({ review: { profiles: { reviewer: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, skipAuto: true, skipAutoSpark: false, mechanicalFastPath: true } })
    const before = loadSettingsDraft()
    const draft: SettingsDraft = {
      ...before,
      workers: { ...before.workers, patcherTier: 'strong' },
    }
    const blocks = dirtyBlocks(before, draft)
    assert.deepEqual(blocks, ['workers'])

    saveSettings({ draft, blocks })
    const after = loadSettingsDraft()
    assert.equal(after.workers.patcherTier, 'strong')
    assert.deepEqual(after.review.profiles, { reviewer: { provider: 'deepseek', model: 'deepseek-v4-pro' } })
  })

  it('写识图桥并能再清除', () => {
    const before = loadSettingsDraft()
    const withVision: SettingsDraft = {
      ...before,
      vision: { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 2048 },
    }
    saveSettings({ draft: withVision, blocks: dirtyBlocks(before, withVision) })
    const saved = loadSettingsDraft()
    assert.deepEqual(saved.vision, {
      provider: 'minimax', model: 'MiniMax-M3', prompt: undefined, maxTokens: 2048, fallback: undefined,
    })

    const cleared: SettingsDraft = { ...saved, vision: null }
    saveSettings({ draft: cleared, blocks: dirtyBlocks(saved, cleared) })
    assert.equal(loadSettingsDraft().vision, null)
  })

  // 备用识图桥必须在 draft 里往返：面板不显示的字段一保存就消失，等于两个界面
  // （桌面端 / 面板 / 手写配置）互相抹配置。
  it('备用识图模型能存能读能清', () => {
    const before = loadSettingsDraft()
    const withFallback: SettingsDraft = {
      ...before,
      vision: {
        provider: 'minimax', model: 'MiniMax-M3', maxTokens: 1024,
        fallback: { provider: 'glm', model: 'glm-5.2' },
      },
    }
    saveSettings({ draft: withFallback, blocks: dirtyBlocks(before, withFallback) })
    const saved = loadSettingsDraft()
    assert.deepEqual(saved.vision?.fallback, { provider: 'glm', model: 'glm-5.2' })

    // 只改 maxTokens 不该带走备用桥。
    const bumped: SettingsDraft = { ...saved, vision: { ...saved.vision!, maxTokens: 512 } }
    saveSettings({ draft: bumped, blocks: dirtyBlocks(saved, bumped) })
    assert.deepEqual(loadSettingsDraft().vision?.fallback, { provider: 'glm', model: 'glm-5.2' })

    // 面板里清掉备用桥要真的清掉（省略即保留的语义下必须显式发 null）。
    const dropped: SettingsDraft = { ...bumped, vision: { ...bumped.vision!, fallback: undefined } }
    saveSettings({ draft: dropped, blocks: dirtyBlocks(bumped, dropped) })
    assert.equal(loadSettingsDraft().vision?.fallback, undefined)
  })

  it('搜索后端清空 = 回落默认链，而不是写一个空数组', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, net: { ...before.net, searchBackends: '' } }
    saveSettings({ draft, blocks: dirtyBlocks(before, draft) })
    const backends = loadConfig().search.backends
    assert.ok(backends.length > 0, '空输入不应留下无后端可用的 web_search')
  })

  it('代理地址留空会删键（回落环境变量），而不是写空串', () => {
    const before = loadSettingsDraft()
    const withProxy: SettingsDraft = { ...before, net: { ...before.net, proxy: 'http://127.0.0.1:7890' } }
    saveSettings({ draft: withProxy, blocks: dirtyBlocks(before, withProxy) })
    assert.equal(loadConfig().network.proxy, 'http://127.0.0.1:7890')

    const saved = loadSettingsDraft()
    const cleared: SettingsDraft = { ...saved, net: { ...saved.net, proxy: '' } }
    saveSettings({ draft: cleared, blocks: dirtyBlocks(saved, cleared) })
    assert.equal(loadConfig().network.proxy, undefined)
  })

  it('只拨 lean 开关不写阈值——lean 收紧默认继续生效（审查 HIGH 回归）', () => {
    const before = loadSettingsDraft()
    // 用户只拨 lean 开关 on，不碰阈值
    const draft: SettingsDraft = { ...before, basics: { ...before.basics, runtimeLean: true } }
    saveSettings({ draft, blocks: dirtyBlocks(before, draft) })

    // 磁盘上 lean:true 落盘，但阈值字段必须保持缺失——显式写 16/30min/50MB
    // 会让 resolveSessionPoolOptions 因显式值优先而放弃 lean 收紧。
    const runtime = loadConfig().runtime!
    assert.equal(runtime.lean, true)
    assert.equal(runtime.maxLoadedSessions, undefined, '未编辑的阈值不得显式落盘')
    assert.equal(runtime.idleAgentTtlMs, undefined)
    assert.equal(runtime.maxEventsDiskBytes, undefined)
  })

  it('编辑阈值后落盘该值，且 lean 状态一并保存', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = {
      ...before,
      basics: { ...before.basics, runtimeLean: true, maxLoadedSessions: 8 },
    }
    saveSettings({ draft, blocks: dirtyBlocks(before, draft) })

    const runtime = loadConfig().runtime!
    assert.equal(runtime.lean, true)
    assert.equal(runtime.maxLoadedSessions, 8)
    assert.equal(runtime.idleAgentTtlMs, undefined, '未编辑的阈值保持缺失')
    assert.equal(runtime.maxEventsDiskBytes, undefined)
  })

  it('lean 开启时面板回落显示 lean 收紧值（审查 LOW 回归）', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, basics: { ...before.basics, runtimeLean: true } }
    saveSettings({ draft, blocks: dirtyBlocks(before, draft) })

    const after = loadSettingsDraft()
    // 无显式阈值 + lean → 回落 4 / 10min / 10MB（与运行时生效值一致）
    assert.equal(after.basics.maxLoadedSessions, 4)
    assert.equal(after.basics.idleAgentTtlMs, 10 * 60_000)
    assert.equal(after.basics.maxEventsDiskBytes, 10 * 1024 * 1024)
  })

  it('最小集绑定星域：写 defaultDomain + taiyi 域覆盖（不含 lean），一键启动', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, basics: { ...before.basics, domainBind: 'changgeng' } }
    saveSettings({ draft, blocks: dirtyBlocks(before, draft) })

    assert.equal(loadConfig().agent.defaultDomain, 'changgeng')
    const runtime = loadConfig().runtime!
    assert.equal(runtime.lean, false, '绑定不得写全局 lean（审查 F1：波及所有域且清空不还原）')
    assert.equal(runtime.domains?.changgeng?.lean, undefined, '绑定不写 lean——工具精简集不是资源减配')
    assert.equal(runtime.domains?.changgeng?.toolPreset, 'taiyi')
    // 回读时推断绑定状态
    assert.equal(loadSettingsDraft().basics.domainBind, 'changgeng')

    // 清空绑定 = 恢复默认域（域覆盖保留）
    const bound = loadSettingsDraft()
    const cleared: SettingsDraft = { ...bound, basics: { ...bound.basics, domainBind: '' } }
    saveSettings({ draft: cleared, blocks: dirtyBlocks(bound, cleared) })
    assert.equal(loadConfig().agent.defaultDomain, 'qiming')
    assert.equal(loadConfig().runtime!.domains?.changgeng?.toolPreset, 'taiyi', '域覆盖保留')
  })

  it('单个 setter 失败只报自己那块，其他块照写', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = {
      ...before,
      basics: { ...before.basics, toolPreset: 'full', defaultModel: 'nonexistent-provider:ghost-model' },
    }
    const result = saveSettings({ draft, blocks: dirtyBlocks(before, draft) })
    assert.deepEqual(result.saved, ['toolPreset'])
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!, /defaultModel/)
    assert.equal(loadSettingsDraft().basics.toolPreset, 'full')
  })

  it('审批模式经运行时 hook 落地；hook 拒绝时如实报错', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, basics: { ...before.basics, approval: 'auto-accept' } }
    const seen: string[] = []
    const ok = saveSettings({ draft, blocks: ['approval'] }, {
      onApprovalChange: mode => { seen.push(mode); return true },
    })
    assert.deepEqual(seen, ['auto-accept'])
    assert.deepEqual(ok.saved, ['approval'])

    const rejected = saveSettings({ draft, blocks: ['approval'] }, { onApprovalChange: () => false })
    assert.deepEqual(rejected.saved, [])
    assert.match(rejected.errors[0]!, /approval/)
  })

  it('无 hook 时审批模式仍直接落盘', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, basics: { ...before.basics, approval: 'manual' } }
    saveSettings({ draft, blocks: ['approval'] })
    assert.equal(loadSettingsDraft().basics.approval, 'manual')
  })

  it('保存后回读的基线与磁盘一致（面板不与磁盘分叉）', () => {
    const flow = new SettingsFlow(loadSettingsDraft(), loadSettingsEnv())
    // 走一遍面板：基础 → 工具档位 → 选下一档
    flow.focusCategories()
    for (let i = 0; i < 10; i++) {
      if (flow.view().categories[flow.view().categoryIndex]?.id === 'basics') break
      flow.moveDown()
    }
    flow.focusFields()
    for (let i = 0; i < 20; i++) {
      if (flow.view().fields[flow.view().fieldIndex]?.id === 'tools.preset') break
      flow.moveDown()
    }
    flow.activate()
    flow.moveDown()
    flow.activate()

    const request = flow.saveRequest()
    assert.deepEqual(request.blocks, ['toolPreset'])
    flow.commitSaved(saveSettings(request))

    assert.deepEqual(flow.dirty(), [], '保存后不应还有脏块')
    assert.match(flow.view().status ?? '', /已保存/)
    // 面板从默认 minimal 下移一档选到 frontend，保存后回读应为 frontend（与磁盘一致）。
    assert.equal(loadSettingsDraft().basics.toolPreset, 'frontend')
  })

  it('候选模型来自实际配置，识图候选按 supportsVision 过滤', () => {
    const env = loadSettingsEnv()
    assert.ok(env.models.length > 0)
    assert.ok(env.domains.some(d => d.key === 'auto'))
    for (const m of env.models) assert.equal(typeof m.supportsVision, 'boolean')
  })
})
