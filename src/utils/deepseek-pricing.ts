import type { ModelConfig, ProviderConfig } from '../config/schema.js'
import { deepseekPricingPhase } from './pricing-phase.js'
import { findModelPricing } from './pricing.js'

/** CNY per million tokens, official tariff checked 2026-10-03.
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * Local history is an estimate at this tariff; the platform bill is authoritative.
 */
export const DEEPSEEK_PEAK_PRICING = {
  flash: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 },
  pro: { input: 9, output: 27, cacheRead: 0.30, cacheWrite: 9 },
} as const

export function deepseekOfficialPricing(model: string, timestamp: number): ModelConfig['pricing'] {
  const rate = model === 'deepseek-v4-pro' ? DEEPSEEK_PEAK_PRICING.pro
    : ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model) ? DEEPSEEK_PEAK_PRICING.flash : undefined
  if (!rate) return undefined
  const multiplier = deepseekPricingPhase(timestamp) === 'peak' ? 1 : .5
  return { input: rate.input * multiplier, output: rate.output * multiplier, cacheRead: rate.cacheRead * multiplier, cacheWrite: rate.cacheWrite * multiplier }
}

/** Official endpoint overrides stale saved presets; gateways retain their own tariffs. */
export function findUsagePricing(providers: Record<string, ProviderConfig>, providerName: string | undefined, model: string | undefined, timestamp: number): ModelConfig['pricing'] {
  const provider = providerName ? providers[providerName] : undefined
  if (provider?.auth?.type === 'tianshu-account') return undefined
  if (provider && model) {
    try {
      if (new URL(provider.baseUrl).hostname === 'api.deepseek.com') {
        const official = deepseekOfficialPricing(model, timestamp)
        if (official) return official
      }
    } catch { /* Invalid endpoint has no official tariff. */ }
  }
  return findModelPricing(providers, providerName, model)
}
