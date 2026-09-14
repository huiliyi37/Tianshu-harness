import { findPresetModel, isProviderPresetKey } from './provider-presets.js'
import { resolvePreset } from '../api/pro-registry.js'
import type { Config, ModelConfig, ProviderConfig } from './schema.js'

/**
 * Model fields refilled from the provider preset when the stored config omits
 * them.
 *
 * Deliberately an allowlist rather than "every absent key". These three
 * *describe* a model; the rest either name it (`id`, `alias`) or tune request
 * behavior (`reasoningEffort`), and silently changing either of those on load
 * would be a different, larger promise than repairing capability metadata.
 * Adding a field here is one line — and forces the decision to be explicit.
 *
 * Why this is needed at all: `config.json` stores a *snapshot* of the preset's
 * models, and `deepMerge` replaces arrays wholesale, so the snapshot always
 * beats the preset. A preset gaining `supportsVision: true` therefore never
 * reaches anyone who already has that provider on disk (the same problem
 * `migrateDeepseekMaxTokens` fixed for exactly one field, one provider).
 */
export const BACKFILLED_MODEL_FIELDS = ['supportsVision', 'tier', 'pricing', 'reasoningEffort', 'description'] as const

/**
 * Refill absent capability fields on one stored model from its preset entry.
 *
 * Matching is by `id` only（2026-09 alias 体系废弃后不按短名兜底——存量把
 * 短名存成 id 的条目视为未知模型，不回填）。The stored `alias` deliberately does
 * not participate: a user-chosen alias that happens to collide with another
 * preset model's name would otherwise pull in the wrong model's metadata.
 *
 * Absent means "never expressed an opinion" — every field here is optional
 * with no schema default, so a present value is always a real one and is left
 * untouched. Returns the same object when there is nothing to fill.
 */
export function backfillModelFromPreset(providerName: string, model: ModelConfig): ModelConfig {
  if (!isProviderPresetKey(providerName)) return model
  const preset = findPresetModel(providerName, model.id)
  if (!preset) return model

  let out: Record<string, unknown> | undefined
  for (const field of BACKFILLED_MODEL_FIELDS) {
    const presetValue = preset[field]
    if (presetValue === undefined) continue
    if ((model as Record<string, unknown>)[field] !== undefined) continue
    out ??= { ...model }
    out[field] = structuredClone(presetValue)
  }
  return (out as ModelConfig | undefined) ?? model
}

/** Refill every model of one provider. Same object back when unchanged. */
export function backfillProviderFromPreset(providerName: string, provider: ProviderConfig): ProviderConfig {
  if (!isProviderPresetKey(providerName)) return provider
  let changed = false
  const models = provider.models.map(model => {
    const next = backfillModelFromPreset(providerName, model)
    if (next !== model) changed = true
    return next
  })
  return changed ? { ...provider, models } : provider
}

/**
 * Read-time repair for the whole config, applied by `loadConfig` after schema
 * validation.
 *
 * Read-time rather than a one-shot disk migration on purpose: it fixes every
 * existing install without a write, covers all providers instead of one, and
 * any future preset field added to the allowlist reaches old configs the next
 * time they load. Disk heals as a side effect the next time something calls
 * `saveConfig`, because that starts from a loaded (already repaired) config.
 *
 * Scope limit: only fields of models the user already has. Models the preset
 * added later are *not* injected — a pruned model list is a legitimate choice
 * and re-adding entries would fight the user.
 */
export function backfillPresetModelFields(config: Config): Config {
  const providers = config.provider.providers
  let changed = false
  const next: Record<string, ProviderConfig> = {}
  for (const [name, provider] of Object.entries(providers)) {
    const repaired = backfillProviderFromPreset(name, provider)
    if (repaired !== provider) changed = true
    next[name] = repaired
  }
  if (!changed) return config
  return { ...config, provider: { ...config.provider, providers: next } }
}

/**
 * 预设新增模型回流（2026-08-28）：provider 配置是应用预设时的全量快照，
 * deepMerge 对数组整组替换——新版本预设追加的模型永远不会出现在老用户的
 * 已配置 provider 里（实测：glm-5.3/glm-5.3-flash 进了预设，配置里只有
 * glm-5.2 快照，设置页/`/model` 看不到新模型）。
 *
 * 对每个「当前预设仍存在」的 provider：把预设 models 中配置缺失的条目
 * 追加到末尾（预设序）。用户编辑过的 provider（userSaved=true，
 * setupProvider/removeModel 落盘）尊重用户的模型列表——删减不回流；
 * 回填只服务「从未编辑过的预设快照」无感升级。Mutates `raw`,
 * returns true if changed.
 */
export function migratePresetModelBackfill(raw: Record<string, unknown>): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  if (!providers) return false
  let changed = false
  for (const [name, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== 'object') continue
    const preset = resolvePreset(name)
    if (!preset || !('static' in preset)) continue
    const presetModels = preset.static.provider.models
    const prov = entry as Record<string, unknown>
    if (prov.userSaved === true) continue
    const models = prov.models
    if (!Array.isArray(models)) continue
    const known = new Set(models.map((m) => (m as { id?: unknown })?.id))
    for (const pm of presetModels) {
      if (known.has(pm.id)) continue
      models.push({
        id: pm.id,
        contextWindow: pm.contextWindow,
        maxTokens: pm.maxTokens,
        ...(pm.supportsVision ? { supportsVision: true } : {}),
        pricing: { ...pm.pricing },
      })
      changed = true
    }
  }
  return changed
}
