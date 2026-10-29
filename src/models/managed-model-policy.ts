import type { ProviderConfig, ModelConfig } from '../config/schema.js'
import { OfficialError, type Catalog, type Binding, type Purpose } from './official-contract.js'
import { DEFAULT_CAPABILITIES, type ProviderCapabilities } from '../api/provider.js'

export const closed = (code: 'auth_required' | 'model_unavailable' | 'capability_unknown' | 'pricing_changed' | 'account_changed' | 'catalog_unavailable') => new OfficialError(code, undefined, false)

export function validatePurpose(model: Catalog['models'][number], binding: Binding, purpose: Purpose): void {
  if (model.status !== 'available') throw closed('model_unavailable')
  if (purpose === 'image-generation' || purpose === 'embedding') {
    if (binding.operation !== purpose) throw closed('model_unavailable')
    return
  }
  if (!['chat', 'responses', 'messages', 'generate-content'].includes(binding.operation) || !binding.stream) throw closed('capability_unknown')
  if (!model.contextWindow || !model.maxOutputTokens) throw closed('capability_unknown')
  if (purpose === 'agent' && (model.capabilities?.tools !== true || binding.capabilities?.tools !== true)) throw closed('capability_unknown')
  if (purpose === 'vision' && (model.capabilities?.vision !== true || binding.capabilities?.vision !== true)) throw closed('capability_unknown')
}

export function thinkingCapabilities(model: Catalog['models'][number], binding: Binding, local: ModelConfig, provider: ProviderConfig): ProviderCapabilities {
  const base: ProviderCapabilities = { ...DEFAULT_CAPABILITIES, supportsCacheControl: false, stripParams: [], effortCap: {} }
  const policy = binding.thinkingPolicy
  if (!policy || policy === 'none' || provider.thinking === 'disabled' || local.reasoningEffort === 'off') return base
  if (model.capabilities?.thinking !== true || binding.capabilities?.thinking !== true) return base
  const wires: Record<string, readonly string[]> = { reasoning_effort: ['openai', 'openai-responses'], thinking_budget: ['anthropic'], adaptive: ['anthropic'], gemini_budget: ['gemini'], preserved_reasoning: ['openai'] }
  if (!Object.hasOwn(wires, policy) || !wires[policy]?.includes(binding.protocol)) throw closed('capability_unknown')
  base.supportsThinking = true
  if (policy === 'reasoning_effort') { base.effortFormat = 'reasoning_effort'; base.effortCap = { max: 'high' } }
  if (policy === 'thinking_budget') { base.thinkingBlockType = 'enabled'; base.thinkingBudgetField = 'budget_tokens' }
  if (policy === 'adaptive') { base.thinkingBlockType = 'adaptive'; base.effortFormat = 'output_config'; base.effortCap = { max: 'high' } }
  if (policy === 'preserved_reasoning') { base.thinkingBlockType = 'enabled'; base.effortFormat = 'reasoning_effort'; base.preservedThinkingProtocol = true; base.effortCap = { off: 'none', medium: 'high' } }
  const ladder = policy === 'preserved_reasoning' ? ['none', 'low', 'high', 'max'] : policy === 'thinking_budget' || policy === 'gemini_budget' ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high']
  for (const [level, cap] of Object.entries({ ...provider.capabilities.effortCap, ...local.capabilities?.effortCap })) {
    const original = base.effortCap?.[level] ?? level
    if (ladder.includes(cap) && ladder.indexOf(cap) <= ladder.indexOf(original)) base.effortCap![level] = cap
  }
  return base
}

export function publicModel(source: Catalog['models'][number], binding: Binding, local: ModelConfig, caps: ProviderCapabilities): ModelConfig {
  return { ...local, pricing: undefined, id: source.id, managed: { bindingId: binding.id }, contextWindow: source.contextWindow ?? 0, maxTokens: Math.min(source.maxOutputTokens ?? 0, local.maxTokens || Infinity), supportsVision: local.supportsVision !== false && source.capabilities?.vision === true && binding.capabilities?.vision === true, supportsImageGen: binding.operation === 'image-generation', capabilities: { thinkingBlock: caps.thinkingBlockType, effortFormat: caps.effortFormat, effortCap: caps.effortCap, thinkingBudgetField: caps.thinkingBudgetField, preservedThinkingProtocol: caps.preservedThinkingProtocol } }
}
