import type { ReasoningEffort } from './auto-reasoning.js'
import { normalizeReasoningEffort, type ProviderCapabilities } from '../api/provider.js'

/**
 * 用户显式 defaultEffort（/model 面板随「设为默认」持久化）压过 preset 默认档；
 * 未配置时沿用 preset/模型的 reasoningEffort（auto-reasoning 仍可在其上动态调）。
 */
export function resolveInitialReasoningEffort(
  rawEffort: ReasoningEffort | undefined,
  caps: ProviderCapabilities,
): ReasoningEffort | undefined {
  if (rawEffort === undefined) return undefined
  return normalizeReasoningEffort(rawEffort, caps)
}