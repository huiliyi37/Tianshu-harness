import { contractModels } from './contract-models.js'
import { defaultKeyOf } from './provider-keys.js'
import type { ModelConfig, ProviderConfig } from './schema.js'

function syncCompatibilityModels(provider: ProviderConfig): void {
  const key = defaultKeyOf(provider)
  if (key) provider.models = structuredClone(key.models)
}

/** Edit an existing model on its credential owner; new IDs belong to the default key. */
export function upsertProviderPoolModel(
  provider: ProviderConfig,
  model: ModelConfig,
  merge: (existing: ModelConfig, incoming: ModelConfig) => ModelConfig,
  preferred = false,
): void {
  const owner = provider.keys?.find(key => key.models.some(m => m.id === model.id)) ?? defaultKeyOf(provider)
  const models = owner?.models ?? provider.models
  const index = models.findIndex(m => m.id === model.id)
  if (index >= 0) models[index] = merge(models[index]!, model)
  else models.push(model)
  // Preference applies within the owner pool; moving pools would silently change
  // credentials for other duplicated model IDs under this provider.
  if (preferred) {
    const selected = models.splice(models.findIndex(m => m.id === model.id), 1)[0]
    if (selected) models.unshift(selected)
  }
  syncCompatibilityModels(provider)
}

export function addProviderPoolModel(provider: ProviderConfig, model: ModelConfig): void {
  if (contractModels(provider).some(m => m.id === model.id)) {
    throw new Error(`Model "${model.id}" already exists in provider "${provider.name}"`)
  }
  const key = defaultKeyOf(provider)
  ;(key?.models ?? provider.models).push(model)
  syncCompatibilityModels(provider)
}

/** A provider-level row represents this ID across all keys; key-specific edits use the key API. */
export function removeProviderPoolModel(provider: ProviderConfig, modelId: string): void {
  const models = contractModels(provider)
  if (!models.some(m => m.id === modelId)) {
    throw new Error(`Model "${modelId}" not found in provider "${provider.name}"`)
  }
  if (models.length <= 1) {
    throw new Error(`Cannot remove the last model from "${provider.name}". Remove the provider instead, or add another model first.`)
  }
  if (provider.keys?.length) {
    for (const key of provider.keys) key.models = key.models.filter(m => m.id !== modelId)
    syncCompatibilityModels(provider)
  } else {
    provider.models = provider.models.filter(m => m.id !== modelId)
  }
}
