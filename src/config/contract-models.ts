/**
 * contract-models — 契约层模型列表的单一事实源。
 *
 * 独立成模块（而不是留在 provider-keys.ts）的原因：provider-keys 依赖 manager
 * （loadConfig/saveConfig），而 CLI 展示层 cli-format.ts 与 manager 同层，直接
 * import provider-keys 会形成环。本模块只依赖 schema，谁都能用。
 */
import type { ModelConfig, ProviderConfig } from './schema.js'
import { parseModelRef } from './provider-keys.js'

/** 契约层模型列表：provider 有 keys 池时取各 key 的并集（按 id 首次出现去重），
 *  否则返回顶层快照。
 *
 *  keys 池是模型的事实源——key 级增删只写 keys[i].models，不回写顶层 models
 *  （顶层是迁移时的快照）。直接读顶层会让消费方继续看到用户已经删掉的模型
 *  （实测：GLM 里删掉 glm-5.3/glm-5.3-flash 后，默认模型下拉与 CLI 列表里仍在），
 *  也会漏掉只在 key 池里的模型。 */
export function contractModels(provider: ProviderConfig): ModelConfig[] {
  if (!provider.keys || provider.keys.length === 0) return provider.models
  const seen = new Set<string>()
  const out: ModelConfig[] = []
  for (const key of provider.keys) {
    for (const model of key.models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      out.push(model)
    }
  }
  return out
}

const match = (m: ModelConfig, id: string) => m.id === id

/** 校验 defaultModel 引用：两段式走契约并集；三段式必须命中指定 key 上的模型。 */
export function assertDefaultModelRef(
  providers: Record<string, ProviderConfig>,
  ref: string,
): void {
  const parsed = parseModelRef(ref)
  const providerName = parsed.provider
  const modelId = parsed.modelRef
  if (!providerName || !modelId) {
    throw new Error('defaultModel must be in "provider:modelId" format')
  }
  const provider = providers[providerName]
  if (!provider) {
    throw new Error(`Provider "${providerName}" not found in configuration`)
  }
  if (parsed.keyId) {
    const key = (provider.keys ?? []).find(k => k.id === parsed.keyId)
    if (!key) {
      throw new Error(`Key "${parsed.keyId}" not found in provider "${providerName}"`)
    }
    if (!key.models.some(m => match(m, modelId))) {
      throw new Error(`Model "${modelId}" not found on key "${parsed.keyId}" of provider "${providerName}"`)
    }
    return
  }
  if (!contractModels(provider).some(m => match(m, modelId))) {
    throw new Error(`Model "${modelId}" not found in provider "${providerName}"`)
  }
}
