import { defaultKeyOf } from './provider-keys.js'
import type { ProviderConfig } from './schema.js'

export interface SetupProviderSyncOptions {
  providerName: string
  apiKey?: string
  apiKeyEnv?: string
}

/**
 * setupProvider 凭据准备与模型池同步：
 * 将 apiKey / apiKeyEnv 同步至 provider 顶层及 defaultKey，
 * 并在存在模型更新时从 defaultKey 初始化 provider 待更新 models。
 */
export function prepareSetupProviderCredentialsAndModels(
  next: ProviderConfig,
  options: SetupProviderSyncOptions,
  hasModelUpdate: boolean,
): void {
  const defaultKey = defaultKeyOf(next)
  if (options.apiKey) {
    next.keyRef = options.providerName
    ;(next as unknown as { apiKey?: string | null }).apiKey = null
    ;(next as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
    if (defaultKey) {
      defaultKey.keyRef = options.providerName
      defaultKey.apiKey = undefined
      defaultKey.apiKeyEnv = undefined
    }
  }
  if (options.apiKeyEnv) {
    next.apiKeyEnv = options.apiKeyEnv
    ;(next as unknown as { apiKey?: string | null }).apiKey = null
    ;(next as unknown as { keyRef?: string | null }).keyRef = null
    if (defaultKey) {
      defaultKey.apiKeyEnv = options.apiKeyEnv
      defaultKey.keyRef = undefined
      defaultKey.apiKey = undefined
    }
  }
  if (defaultKey && hasModelUpdate) {
    next.models = structuredClone(defaultKey.models)
  }
}

/**
 * 将更新后的 models 回写同步至 defaultKey。
 */
export function syncSetupProviderDefaultKeyModels(
  next: ProviderConfig,
  hasModelUpdate: boolean,
): void {
  const defaultKey = defaultKeyOf(next)
  if (defaultKey && hasModelUpdate) {
    defaultKey.models = structuredClone(next.models)
  }
}
