import { z } from 'zod'
import { loadConfig, saveConfig } from './manager.js'
import { writeSecret } from './secrets-store.js'
import { modelConfigSchema, type Config, type ProviderConfig } from './schema.js'
import { imageGenModelSchema, type ImageGenModelConfigSnapshot } from './image-gen-schema.js'

/**
 * 生图模型的读取与独立 provider 注册（issue #8）。
 *
 * 放在独立模块而非 `config/manager.ts`，理由同 `retry-schema.ts` /
 * `preset-model-backfill.ts` 先例：配置面子面沿接缝拆分，不让点名巨石继续
 * 膨胀。本模块单向依赖 manager（取 loadConfig/saveConfig）与 schema，manager
 * 不反向 import 本模块——无循环。
 */

/** URL 合法性校验。与 manager.ts 的私有 assertValidUrl 同义，就地实现以避免
 *  为一行工具扩大 manager 的导出面。 */
function assertValidUrl(value: string): void {
  try {
    new URL(value)
  } catch {
    throw new Error(`无效的 URL："${value}"`)
  }
}

/** 生图槽快照，供桌面端 / TUI 设置面板读取。
 *  `undefined`（而非 null）——未配置是 fail-closed 信号，`generate_image`
 *  据此不注册。 */
export function getImageGenModelConfig(): ImageGenModelConfigSnapshot | undefined {
  return loadConfig().agent.imageGenModel
}

/** 校验 provider 在 provider.providers 里存在、且该 provider 下有指定 model。
 *  与 manager.ts 的同名私有函数同义，就地实现以避免为它扩大 manager 的导出面。 */
function assertProviderModelExists(cfg: Config, providerName: string, modelId: string, label: string): void {
  const provider = cfg.provider.providers[providerName]
  if (!provider) {
    throw new Error(`${label}：provider "${providerName}" 不在已配置的 provider 列表里（先用 rivet config setup ${providerName} 添加）`)
  }
  if (!provider.models.some(m => m.id === modelId)) {
    throw new Error(`${label}：provider "${providerName}" 下没有模型 "${modelId}"（检查拼写或用 rivet config add-model 添加）`)
  }
}

export interface SetImageGenModelConfigInput {
  provider?: unknown
  model?: unknown
  prompt?: unknown
  size?: unknown
  sizeField?: unknown
  timeoutMs?: unknown
}

/**
 * 写入或清除生图槽。与 `setVisionModelConfig` 同构：传 null 或 provider/model
 * 为空串即清除；写槽前校验 provider/model 存在——不校验时写盘成功而运行时静默
 * 失败，用户以为配了实际没生效（vision 链路踩过的坑）。
 *
 * 本函数**只动槽**，不碰 provider 段：注册专用 provider 是
 * `registerImageGenModelConfig` 的职责。
 */
export function setImageGenModelConfig(
  input: SetImageGenModelConfigInput | null,
): ImageGenModelConfigSnapshot | null {
  const cfg = loadConfig()
  if (input === null || input.provider === '' || input.model === '') {
    delete (cfg.agent as Record<string, unknown>).imageGenModel
    saveConfig(cfg)
    return null
  }
  const parsed = imageGenModelSchema.parse(input)
  assertProviderModelExists(cfg, parsed.provider, parsed.model, '生图模型')
  cfg.agent.imageGenModel = parsed
  saveConfig(cfg)
  return parsed
}

export interface RegisterImageGenModelConfigOptions {
  providerName: string
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  modelId: string
  sizeField?: 'size' | 'image_size'
}

/**
 * 注册一个文生图专用 provider 并把它选为生图模型——一次配置写入完成。
 *
 * 与 `registerVisionModelConfig` 同构（同样的 default provider 拒斥、同样的
 * secret 写失败回滚、同样的「已存在的专用 provider 必须兼容才允许覆盖」），
 * 两处刻意差异：
 *
 *  1. 模型卡打 `supportsImageGen`，**绝不**打 `supportsVision`——后者语义是
 *     「接受图片输入」（图→文），误用会把生图模型泄进 vision auto-bridge
 *     候选池、模型选择器徽章与 settings-persist 的覆盖逻辑。
 *  2. `sizeField` 记录尺寸参数的线上字段名（OpenAI `size` /
 *     SiliconFlow `image_size`）。
 *
 * primary provider 与 default model 全程不动；本条目只经 `agent.imageGenModel`
 * 消费。
 */
export function registerImageGenModelConfig(
  options: RegisterImageGenModelConfigOptions,
): ImageGenModelConfigSnapshot {
  const providerName = z.string().trim().min(1).parse(options.providerName)
  const modelId = z.string().trim().min(1).parse(options.modelId)
  const apiKey = options.apiKey?.trim()
  const apiKeyEnv = options.apiKeyEnv?.trim()
  if (apiKey && apiKeyEnv) {
    throw new Error('Image-gen provider credentials must use either apiKey or apiKeyEnv, not both.')
  }
  if (options.apiKey !== undefined && !apiKey) throw new Error('Image-gen provider apiKey must not be blank.')
  if (options.apiKeyEnv !== undefined && !apiKeyEnv) throw new Error('Image-gen provider apiKeyEnv must not be blank.')
  assertValidUrl(options.baseUrl)

  const model = modelConfigSchema.parse({ id: modelId, supportsImageGen: true })
  const imageGen = imageGenModelSchema.parse({
    provider: providerName,
    model: modelId,
    ...(options.sizeField ? { sizeField: options.sizeField } : {}),
  })
  const provider: ProviderConfig = {
    name: providerName,
    ...(apiKey ? { keyRef: providerName } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    baseUrl: options.baseUrl,
    protocol: 'openai',
    capabilities: {},
    thinking: 'enabled',
    maxTokens: 1024,
    allowProFallback: false,
    models: [model],
    unsupported: [],
    userSaved: true,
  }

  const cfg = loadConfig()
  const existing = cfg.provider.providers[providerName]
  if (providerName === cfg.provider.default) {
    throw new Error(`Image-gen provider "${providerName}" cannot replace the default provider.`)
  }
  if (existing && !isCompatibleImageGenProvider(cfg, existing, providerName, options.baseUrl, apiKey, apiKeyEnv)) {
    throw new Error(`Provider "${providerName}" is not a compatible dedicated image-gen provider.`)
  }

  // 先写凭据、再写 config——这个顺序是刻意的。反过来（先 config 后 secret）会留下一个
  // 危险窗口：config 已指向该 provider 而它的 secret 尚未落盘，此时另一个并发会话读到
  // 配置就会以为「已配好」，实际调用必然 401，且报错指向 provider 而不是「还没配完」，
  // 很难归因。反过来最坏只留一个无人引用的孤儿 secret——无害，下次注册同名 provider
  // 会覆盖它。因此也不需要回滚分支（writeSecret 是原子的，抛错即未写入）。
  if (apiKey) writeSecret(providerName, apiKey)

  cfg.provider.providers[providerName] = provider
  cfg.agent.imageGenModel = imageGen
  saveConfig(cfg)
  return imageGen
}

function isCompatibleImageGenProvider(
  cfg: Config,
  existing: ProviderConfig,
  providerName: string,
  baseUrl: string,
  apiKey: string | undefined,
  apiKeyEnv: string | undefined,
): boolean {
  if (cfg.agent.imageGenModel?.provider !== providerName || existing.baseUrl !== baseUrl) return false
  if (apiKeyEnv) return existing.apiKeyEnv === apiKeyEnv
  if (apiKey) return existing.keyRef === providerName && existing.apiKey === apiKey
  return !existing.keyRef && !existing.apiKeyEnv
}
