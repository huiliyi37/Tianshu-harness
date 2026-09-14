/**
 * `/config` 面板的 I/O 边界：把配置读成 draft，把脏块写回对应 setter。
 *
 * 面板本体（settings-model / settings-flow / format/settings）保持纯函数，
 * 所有 `loadConfig` / `set*Config` 调用只在这里发生。
 *
 * 写入粒度 = 块。每个块对应恰好一个 setter，只写真正改过的块 —— 面板不该
 * 因为用户改了代理地址就顺手重写 workers 路由（覆盖别的会话刚改的值）。
 */

import {
  getCheckpointConfig,
  getDefaultDomainConfig,
  getDefaultModelConfig,
  getFetchConfig,
  getMirrorConfig,
  getNetworkConfig,
  getRoutingConfig,
  getSearchConfig,
  getToolPresetConfig,
  getRuntimeLeanConfig,
  getVisionAutoBridge,
  getVisionModelConfig,
  loadConfig,
  setApprovalMode,
  setCheckpointConfig,
  setDefaultDomainConfig,
  setDefaultModelConfig,
  setFetchConfig,
  setModelSupportsVision,
  setMirrorConfig,
  setNetworkConfig,
  setRoutingConfig,
  setSearchConfig,
  setToolPresetConfig,
  setRuntimeLeanConfig,
  setVisionAutoBridge,
  setVisionModelConfig,
} from '../config/manager.js'
import { buildDomainPickerEntries } from '../agent/domain-picker-entries.js'
import type { SettingsBlockId, SettingsDraft, SettingsEnv } from './settings-model.js'
import { splitModelRef } from './settings-model.js'
import type { SettingsSaveResult } from './settings-flow.js'
import { resolveLeanDefaults } from '../config/runtime-lean.js'
import { contractModels } from '../config/contract-models.js'

/** Runtime side-effects the panel cannot do by itself. */
export interface SettingsHooks {
  /**
   * Approval mode is the one field that must also land on the *running* session,
   * so it is routed through the TUI's existing approval persistence instead of
   * `setApprovalMode` alone. Returns false when it could not be applied.
   */
  onApprovalChange?: (mode: string) => boolean
}

/** Read the current effective config into a panel draft. */
export function loadSettingsDraft(): SettingsDraft {
  const routing = getRoutingConfig()
  const cfg = loadConfig()
  const mirrors = getMirrorConfig()
  const network = getNetworkConfig()
  const search = getSearchConfig()
  const fetchCfg = getFetchConfig()
  const vision = getVisionModelConfig()
  return {
    workers: routing.workers,
    review: routing.review,
    vision: vision
      ? {
          provider: vision.provider,
          model: vision.model,
          prompt: vision.prompt,
          maxTokens: vision.maxTokens,
          fallback: vision.fallback,
        }
      : null,
    visionAutoBridge: getVisionAutoBridge(),
    // modelVision 只存用户在面板里的覆盖；初始为空，display 时 fallback 到模型卡的 supportsVision。
    modelVision: {},
    basics: (() => {
      // 单次 getRuntimeLeanConfig 复用（原 8 次 loadConfig 读盘）；阈值回落
      // 统一调 resolveLeanDefaults——与 settings-model intField get 同源。
      const leanCfg = getRuntimeLeanConfig()
      const leanDefaults = resolveLeanDefaults(leanCfg.lean)
      return {
        toolPreset: getToolPresetConfig().preset ?? 'frontend',
        runtimeLean: leanCfg.lean,
        maxLoadedSessions: leanCfg.maxLoadedSessions ?? leanDefaults.maxLoadedSessions,
        idleAgentTtlMs: leanCfg.idleAgentTtlMs ?? leanDefaults.idleAgentTtlMs,
        maxEventsDiskBytes: leanCfg.maxEventsDiskBytes ?? leanDefaults.maxEventsDiskBytes,
        // 绑定星域：defaultDomain 钉定 + 该域 taiyi 工具档覆盖成立时显示绑定状态
        domainBind: inferDomainBind(),
        approval: cfg.agent.approval,
        checkpointEveryTurns: getCheckpointConfig().checkpointEveryTurns,
        defaultDomain: getDefaultDomainConfig().defaultDomain,
        defaultModel: getDefaultModelConfig().defaultModel ?? '',
      }
    })(),
    net: {
      mirrorsEnabled: mirrors.enabled,
      mirrorsPreset: mirrors.preset,
      proxy: network.proxy ?? '',
      noProxy: network.noProxy ?? '',
      searchBackends: (search.backends ?? []).join(', '),
      jinaBaseUrl: fetchCfg.jinaBaseUrl ?? '',
    },
  }
}

/**
 * Enumerate model / domain choices for the panel.
 *
 * `supportsVision` comes straight from the stored model cards — which is why the
 * preset backfill in `loadConfig` matters here: without it, older configs would
 * present an empty vision candidate list even though the model does support it.
 */
export function loadSettingsEnv(): SettingsEnv {
  const cfg = loadConfig()
  const models: SettingsEnv['models'] = []
  for (const [provider, p] of Object.entries(cfg.provider.providers)) {
    for (const m of contractModels(p)) {
      models.push({ provider, id: m.id, supportsVision: m.supportsVision === true })
    }
  }
  const domains = buildDomainPickerEntries(undefined).map(d => ({ key: d.key, name: d.name }))
  return { models, domains }
}

function parseBackends(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
}

/** 推断「最小集绑定星域」：defaultDomain 钉定某域且该域显式配置了 taiyi
 *  工具档时视为绑定（面板显示）；否则空（不绑定）。
 *  2026-08-15：绑定不再含 lean（资源减配）。taiyi 域经 star-domain-data
 *  内置档兜底——手写 defaultDomain=taiyi 而无域覆盖时行为等价但不显示绑定，
 *  以面板显式绑定为准。 */
function inferDomainBind(): string {
  const leanCfg = getRuntimeLeanConfig()
  const domain = getDefaultDomainConfig().defaultDomain
  if (!domain || domain === 'auto') return ''
  const slice = leanCfg.domains?.[domain]
  return slice?.toolPreset === 'taiyi' ? domain : ''
}

/**
 * Write the dirty blocks. Each block is written independently: one failing
 * setter reports its own error and the rest still land, so a bad proxy string
 * cannot silently swallow a valid routing change.
 */
export function saveSettings(
  request: { draft: SettingsDraft; blocks: SettingsBlockId[] },
  hooks?: SettingsHooks,
): SettingsSaveResult {
  const { draft, blocks } = request
  const saved: SettingsBlockId[] = []
  const errors: string[] = []

  const attempt = (block: SettingsBlockId, write: () => void): void => {
    try {
      write()
      saved.push(block)
    } catch (err) {
      errors.push(`${block}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const block of blocks) {
    switch (block) {
      case 'workers':
        attempt(block, () => setRoutingConfig({ workers: draft.workers }))
        break
      case 'review':
        attempt(block, () => setRoutingConfig({ review: draft.review }))
        break
      case 'vision':
        attempt(block, () => setVisionModelConfig(draft.vision === null ? null : {
          provider: draft.vision.provider,
          model: draft.vision.model,
          prompt: draft.vision.prompt,
          maxTokens: draft.vision.maxTokens,
          // 显式发 null 清除、发对象设置——省略会被 setter 当作"保留现有"，那样面板里
          // 清掉备用桥就无效了。
          fallback: draft.vision.fallback ?? null,
        }))
        break
      case 'visionAuto':
        attempt(block, () => setVisionAutoBridge(draft.visionAutoBridge))
        break
      case 'modelVision': {
        // draft.modelVision 存的是「覆盖值」——只写与磁盘现状不同的模型，避免无谓写盘。
        // setModelSupportsVision 内部做了幂等（相同值 no-op）。
        attempt(block, () => {
          const cfg = loadConfig()
          for (const [ref, value] of Object.entries(draft.modelVision)) {
            const parts = splitModelRef(ref)
            if (!parts) continue
            const provider = cfg.provider.providers[parts.provider]
            const model = provider ? contractModels(provider).find(m => m.id === parts.model) : undefined
            // 只在覆盖值与磁盘现状不同时写入
            if (model && (model.supportsVision === true) !== value) {
              setModelSupportsVision(parts.provider, model.id, value)
            }
          }
        })
        break
      }
      case 'toolPreset':
        attempt(block, () => setToolPresetConfig({ preset: draft.basics.toolPreset }))
        break
      case 'runtimeLean': {
        // 只写发生变化的子字段（审查 HIGH 修复）：阈值未被编辑时保持磁盘无
        // 显式值，让 lean 收紧默认（4/10min/10MB）在消费端继续生效——无条件
        // 把回落值写盘会把「无显式值、lean 默认生效」形态变成显式非 lean 值，
        // resolveSessionPoolOptions 因显式值优先而不再采用 lean 收紧。
        const baseline = loadSettingsDraft().basics
        const patch: {
          lean: boolean
          maxLoadedSessions?: number
          idleAgentTtlMs?: number
          maxEventsDiskBytes?: number
        } = { lean: draft.basics.runtimeLean }
        if (draft.basics.maxLoadedSessions !== baseline.maxLoadedSessions) {
          patch.maxLoadedSessions = draft.basics.maxLoadedSessions
        }
        if (draft.basics.idleAgentTtlMs !== baseline.idleAgentTtlMs) {
          patch.idleAgentTtlMs = draft.basics.idleAgentTtlMs
        }
        if (draft.basics.maxEventsDiskBytes !== baseline.maxEventsDiskBytes) {
          patch.maxEventsDiskBytes = draft.basics.maxEventsDiskBytes
        }
        attempt(block, () => setRuntimeLeanConfig(patch))
        break
      }
      case 'approval':
        attempt(block, () => {
          // 落盘 + 运行时同步。hook 缺失（非交互路径）时只落盘，并如实报告。
          const applied = hooks?.onApprovalChange?.(draft.basics.approval)
          if (applied === undefined) setApprovalMode(draft.basics.approval)
          else if (!applied) throw new Error('运行时未接受该审批模式')
        })
        break
      case 'checkpoint':
        attempt(block, () => setCheckpointConfig({ checkpointEveryTurns: draft.basics.checkpointEveryTurns }))
        break
      case 'defaultDomain':
        attempt(block, () => setDefaultDomainConfig({ defaultDomain: draft.basics.defaultDomain }))
        break
      case 'domainBind': {
        // 最小集绑定：选中域 → 钉定 defaultDomain + 写该域 taiyi 工具档覆盖。
        // 不写 lean（2026-08-15 产品决策：lean 是资源减配，会关掉核心能力——
        // 用户要的是工具精简集，不是减配）；全局 runtime.lean 更不写（波及
        // 所有域且清空绑定不还原，审查 F1）；清空 → 恢复默认域 qiming
        // （域覆盖保留，用户可另行调整）。
        const bind = draft.basics.domainBind ?? ''
        if (bind) {
          attempt(block, () => setDefaultDomainConfig({ defaultDomain: bind }))
          attempt(block, () => setRuntimeLeanConfig({
            domains: { [bind]: { toolPreset: 'taiyi' } },
          }))
        } else {
          attempt(block, () => setDefaultDomainConfig({ defaultDomain: 'qiming' }))
        }
        break
      }
      case 'defaultModel':
        attempt(block, () => setDefaultModelConfig({ defaultModel: draft.basics.defaultModel }))
        break
      case 'mirrors':
        attempt(block, () => setMirrorConfig({ enabled: draft.net.mirrorsEnabled, preset: draft.net.mirrorsPreset }))
        break
      case 'network':
        attempt(block, () => setNetworkConfig({ proxy: draft.net.proxy, noProxy: draft.net.noProxy }))
        // jinaBaseUrl 与 proxy/noProxy 同属 network 块——一起写。空串删键回落默认 r.jina.ai。
        attempt(block, () => setFetchConfig({ jinaBaseUrl: draft.net.jinaBaseUrl }))
        break
      case 'search':
        attempt(block, () => {
          const parsed = parseBackends(draft.net.searchBackends)
          // 清空 = 删键回落默认链（bing/DDG），而不是写一个空数组让 web_search 无后端可用。
          setSearchConfig({ backends: parsed.length > 0 ? parsed : '' })
        })
        break
    }
  }

  // 重新读盘作为新基线：setter 会规范化（schema 默认值、空串删键），
  // 直接把内存 draft 当基线会让面板显示与磁盘内容悄悄分叉。
  return { saved, errors, persisted: saved.length > 0 ? loadSettingsDraft() : undefined }
}
