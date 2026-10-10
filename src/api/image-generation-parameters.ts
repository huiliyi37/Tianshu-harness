import { loadConfig } from '../config/manager.js'
import { resolveApiKey } from './factory.js'
import type { ImageGenerationParameters } from '../server/protocol.js'
import { z } from 'zod'
import type { Config, ProviderConfig } from '../config/schema.js'

export function imageGenerationNetwork(config: Pick<Config, 'network'>, provider?: Pick<ProviderConfig, 'proxy'>) {
  return { proxy: { proxyUrl: provider?.proxy ?? config.network?.proxy, noProxy: config.network?.noProxy }, trustProxyFakeIp: config.network?.trustProxyFakeIp }
}

export const imageSizeSchema = z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/, 'Size must use positive widthxheight, for example 1024x1024')
const parametersSchema = z.object({
  provider: z.string().min(1).optional(), model: z.string().min(1).optional(),
  prompt: z.string().max(20000).optional(), prefix: z.string().max(20000).optional(),
  size: z.union([z.literal(''), imageSizeSchema]).optional(),
  timeoutMs: z.number().int().min(1).max(1800000).optional(),
})

export function resolveImageGeneration(input: Partial<ImageGenerationParameters>, config: Config = loadConfig()) {
  input = parametersSchema.parse(input)
  const slot = config.agent.imageGenModel
  const providerName = input.provider ?? slot?.provider, modelId = input.model ?? slot?.model
  const provider = providerName ? config.provider.providers[providerName] : undefined
  const model = provider?.models.find(model => model.id === modelId)
  const defaults = slot && slot.provider === providerName && slot.model === modelId ? slot : undefined
  if (!provider || !model || !(model.supportsImageGen || defaults && model.supportsImageGen === undefined)) throw new Error('Select a configured image generation model')
  const compatibility = model.imageGen
  const size = input.size === '' ? undefined : input.size ?? defaults?.size ?? compatibility?.defaultSize
  if (size) imageSizeSchema.parse(size)
  if (size && compatibility?.sizes?.length && !compatibility.sizes.includes(size)) throw new Error('This size is not supported by the selected model')
  const timeoutMs = input.timeoutMs ?? defaults?.timeoutMs ?? 180_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_800_000) throw new Error('Timeout must be between 1 and 1800000ms')
  const parameters: ImageGenerationParameters = {
    provider: providerName!, model: modelId!, prompt: input.prompt?.trim() ?? '',
    prefix: input.prefix ?? defaults?.prompt, size,
    sizeField: compatibility?.sizeField ?? defaults?.sizeField ?? 'size', timeoutMs,
  }
  return { parameters, connection: { baseUrl: provider.baseUrl, apiKey: resolveApiKey(provider), ...imageGenerationNetwork(config, provider) } }
}
