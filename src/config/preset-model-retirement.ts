/**
 * preset 模型退役 —— 存量配置的加载期清理。
 *
 * 与 preset-model-backfill.ts 同属「preset 与磁盘快照会漂移」这一族问题：config.json
 * 存的是应用预设那一刻的模型快照，而 deepMerge 对数组整组替换，所以**单改 preset
 * 到不了任何已装过的用户**。backfill 那半解决「字段缺失」，这里解决「条目该走了」。
 *
 * 每个退役都应当是一个独立的一次性迁移：preset 删条目只影响新装，存量用户靠这里。
 */

import { findPresetModel } from './provider-presets.js'
import type { ModelConfig } from './schema.js'

/** Rename retired entries in both the legacy snapshot and each authoritative key pool. */
function retireProviderModel(prov: Record<string, unknown> | undefined, retiredId: string, replacementId: string): boolean {
  if (!prov) return false
  let changed = false
  const rewrite = (target: Record<string, unknown>): void => {
    if (!Array.isArray(target.models)) return
    let hasReplacement = target.models.some(m =>
      !!m && typeof m === 'object' && (m as { id?: unknown }).id === replacementId,
    )
    let local = false
    const models: unknown[] = []
    for (const item of target.models) {
      if (!item || typeof item !== 'object' || (item as { id?: unknown }).id !== retiredId) {
        models.push(item)
        continue
      }
      local = true
      if (hasReplacement) continue
      models.push({ ...item, id: replacementId })
      hasReplacement = true
    }
    if (local) {
      target.models = models
      changed = true
    }
  }
  rewrite(prov)
  if (Array.isArray(prov.keys)) {
    for (const key of prov.keys) {
      if (key && typeof key === 'object') rewrite(key as Record<string, unknown>)
    }
  }
  return changed
}

/**
 * 重定向前保证 REPLACEMENT 在契约池中可达（2026-10-06，开源仓 3.28 用户反馈族）。
 *
 * 退役迁移把 defaultModel / visionModel / worker / review 等引用改指 REPLACEMENT，
 * 但池侧补救只有「池里恰有旧 id 条目时改名」一种——用户池子里既没有旧 id 也没有
 * REPLACEMENT（设置页剪枝 userSaved、或 keys 池形态下顶层快照不进契约池）时，
 * 引用指向池外模型：每次启动报「配置的模型 X 不在 provider 下」并位置性回退
 * models[0]（实测：剪到只剩 v4-pro 的池，回退档 v4-pro，Flash 价位静默变 Pro 价位）。
 *
 * 不变量：**迁移不得制造悬空引用**。这里把 REPLACEMENT 的 preset 条目补进
 * 事实源池——keys 池存在时补首个含模型的 key 池（契约层只认 keys 并集），否则
 * 补顶层 models。不做无差别回流（userSaved 的剪枝语义仍由 backfill 尊重），
 * 只在确有引用需要重定向时补——调用方在 redirect 之前调用，幂等由池内查重守卫。
 *
 * Mutates `raw` in place. Returns true if any value was changed.
 */
function ensureReplacementInPool(
  raw: Record<string, unknown>,
  providerName: string,
  replacementId: string,
): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const prov = providers?.[providerName] as Record<string, unknown> | undefined
  if (!prov) return false

  const hasId = (models: unknown): boolean =>
    Array.isArray(models) && models.some(m =>
      !!m && typeof m === 'object' && (m as { id?: unknown }).id === replacementId)

  const preset = findPresetModel(providerName, replacementId)
  const appendPresetEntry = (models: unknown[]): void => {
    if (!preset) return
    models.push({
      id: preset.id,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
      ...(preset.supportsVision ? { supportsVision: true } : {}),
      ...(preset.supportsImageGen ? { supportsImageGen: true } : {}),
      ...(preset.tier ? { tier: preset.tier } : {}),
      ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
      pricing: { ...preset.pricing },
    } satisfies Partial<ModelConfig> & { id: string })
  }

  // 事实源池：keys 池存在 → 首个含模型的 key 池；否则顶层 models（契约层回退路径）。
  const keys = prov.keys
  if (Array.isArray(keys) && keys.length > 0) {
    for (const key of keys) {
      if (!key || typeof key !== 'object') continue
      const slot = key as Record<string, unknown>
      if (!Array.isArray(slot.models) || slot.models.length === 0) continue
      if (hasId(slot.models)) return false
      appendPresetEntry(slot.models as unknown[])
      return true
    }
    // keys 全是空池：契约层会回退顶层 models——检查顶层（有 keys 但顶层也无条目时，补顶层）。
  }
  const models = prov.models
  if (Array.isArray(models)) {
    if (hasId(models)) return false
    appendPresetEntry(models as unknown[])
    return true
  }
  return false
}

/**
 * One-shot migration: 退役 deepseek-v4-flash-vision-exp（2026-09-12 决策；官方文档：
 * 旧名仍可调用，但请求由最新的 Flash 承接，即该档已下线）。preset 已删条目，而存量
 * 用户的 models 快照里仍留着它。
 *
 * 比 v4-pro 退役多一层必要性：该档声明了 supportsVision，只要它排在存量快照视觉档的
 * 首位，**同 provider 自动识图桥就会选中它**。实测（2026-09-12 探针，真实 config）：
 *   detail = "自动选用 deepseek/deepseek-v4-flash-vision-exp"
 * 退役后自动桥自然落到 deepseek-flash（当前正式视觉档）。
 *
 * 同时重定向两个引用：agent.visionModel 指向它时改指正式视觉档——不重定向的话桥会在
 * 启动时报「provider 下没有模型」，图片照旧丢；agent.defaultModel 同理，否则会静默
 * 回退 models[0]（本轮已在 bootstrap/main 两处补了该回退的告警，但仍应避免发生）。
 *
 * 边界：只动 deepseek provider 下 id 完全等于该型号的条目——用户在别的 provider 下
 * 自建的同名模型（第三方中转）不受影响；只剩退役档时改名，保留用户调过的窗口。
 * 幂等：删干净、改到位之后返回 false。Mutates `raw` in place.
 * Returns true if any value was changed.
 */
export function migrateDeepseekVisionExpRetirement(raw: Record<string, unknown>): boolean {
  const RETIRED = 'deepseek-v4-flash-vision-exp'
  const RETIRED_ALIAS = 'v4-vision'
  const REPLACEMENT = 'deepseek-flash'
  let changed = false

  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const ds = providers?.['deepseek'] as Record<string, unknown> | undefined
  if (retireProviderModel(ds, RETIRED, REPLACEMENT)) changed = true

  const agent = raw.agent as Record<string, unknown> | undefined
  if (agent) {
    // 识图桥指向退役档 → 改指正式视觉档（不重定向 = 桥起不来 + 图片照旧丢）
    const vm = agent.visionModel as Record<string, unknown> | undefined
    if (vm && vm['provider'] === 'deepseek' && (vm['model'] === RETIRED || vm['model'] === RETIRED_ALIAS)) {
      if (ensureReplacementInPool(raw, 'deepseek', REPLACEMENT)) changed = true
      agent.visionModel = { ...vm, model: REPLACEMENT }
      changed = true
    }
    // agent.defaultModel 形如 "provider:modelId"；alias 写法同样接住
    const dm = agent.defaultModel
    if (typeof dm === 'string') {
      const sep = dm.indexOf(':')
      const provName = sep >= 0 ? dm.slice(0, sep) : ''
      const modelName = sep >= 0 ? dm.slice(sep + 1) : ''
      if (provName === 'deepseek' && (modelName === RETIRED || modelName === RETIRED_ALIAS)) {
        if (ensureReplacementInPool(raw, 'deepseek', REPLACEMENT)) changed = true
        agent.defaultModel = `deepseek:${REPLACEMENT}`
        changed = true
      }
    }
  }

  return changed
}

/**
 * One-shot migration: 官方 deepseek 供应商退役 deepseek-v4-flash（2026-10-04）。
 * 定价表只剩 deepseek-flash（版本 DeepSeek-V4.1-Flash）与 deepseek-v4-pro。旧名仍可
 * 调用，但模型已下线，请求由 V4.1 Flash 按 Flash 价格承接。
 *
 * 只动 provider 名恰好是 `deepseek` 的条目。火山方舟 / OpenCode Go / 硅基流动上的
 * 同名 id 是那些网关自己的模型名，不在这里改。
 *
 * 快照里已有 deepseek-flash 时删掉旧条目；没有则把旧 id 改名（保留用户调过的窗口）。
 * 缺的视觉/定价由随后的 preset backfill 按新 id 补。同时改写官方 provider 上指向
 * 旧 id 或短名 v4-flash 的 defaultModel / visionModel / worker / review / greeting / compact。
 *
 * 幂等。Mutates `raw` in place. Returns true if any value was changed.
 */
export function migrateDeepseekV4FlashRetirement(raw: Record<string, unknown>): boolean {
  const RETIRED = 'deepseek-v4-flash'
  const RETIRED_ALIAS = 'v4-flash'
  const REPLACEMENT = 'deepseek-flash'
  let changed = false

  const isRetired = (name: unknown): boolean => name === RETIRED || name === RETIRED_ALIAS

  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const ds = providers?.['deepseek'] as Record<string, unknown> | undefined
  if (retireProviderModel(ds, RETIRED, REPLACEMENT)) changed = true

  const redirectRef = (value: string): string | undefined => {
    const parts = value.split(':')
    if (parts.length < 2 || parts[0] !== 'deepseek') return undefined
    if (!isRetired(parts[parts.length - 1])) return undefined
    parts[parts.length - 1] = REPLACEMENT
    return parts.join(':')
  }

  // 引用改指 REPLACEMENT 前保证它在事实源池可达——否则迁移制造悬空引用，
  // 启动报「不在 provider 下」并位置性回退（见 ensureReplacementInPool 头注释）。
  let poolEnsured = false
  const ensurePoolOnce = (): void => {
    if (poolEnsured) return
    poolEnsured = true
    if (ensureReplacementInPool(raw, 'deepseek', REPLACEMENT)) changed = true
  }

  const redirectProfile = (profile: unknown): void => {
    if (!profile || typeof profile !== 'object') return
    const p = profile as Record<string, unknown>
    if (p.provider === 'deepseek' && isRetired(p.model)) {
      ensurePoolOnce()
      p.model = REPLACEMENT
      changed = true
    }
  }

  const agent = raw.agent as Record<string, unknown> | undefined
  if (agent) {
    const vm = agent.visionModel as Record<string, unknown> | undefined
    if (vm && vm.provider === 'deepseek' && isRetired(vm.model)) {
      ensurePoolOnce()
      agent.visionModel = { ...vm, model: REPLACEMENT }
      changed = true
    }
    if (typeof agent.defaultModel === 'string') {
      const next = redirectRef(agent.defaultModel)
      if (next) {
        ensurePoolOnce()
        agent.defaultModel = next
        changed = true
      }
    }
    const greeting = agent.greeting as Record<string, unknown> | undefined
    if (greeting && greeting.model === RETIRED) {
      ensurePoolOnce()
      greeting.model = REPLACEMENT
      changed = true
    }
    const review = agent.review as Record<string, unknown> | undefined
    const reviewProfiles = review?.profiles as Record<string, unknown> | undefined
    if (reviewProfiles) {
      for (const profile of Object.values(reviewProfiles)) redirectProfile(profile)
    }
  }

  const compact = raw.compact as Record<string, unknown> | undefined
  if (compact && compact.model === RETIRED) {
    ensurePoolOnce()
    compact.model = REPLACEMENT
    changed = true
  }

  const workers = raw.workers as Record<string, unknown> | undefined
  const profiles = workers?.profiles as Record<string, unknown> | undefined
  if (profiles) {
    for (const profile of Object.values(profiles)) redirectProfile(profile)
  }

  return changed
}
