import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Tool } from './types.js'
import type { Config, ProviderConfig } from '../config/schema.js'
import { getImageGenModelConfig } from '../config/image-gen-model.js'
import type { ImageGenModelConfigSnapshot } from '../config/image-gen-schema.js'
import { loadConfig } from '../config/manager.js'
import { resolveApiKey } from '../api/factory.js'
import { expandHome } from '../platform.js'
import { ImageGenerationService, imageGenerationService } from '../api/image-generation-service.js'
import { resolveImageGeneration, imageGenerationNetwork } from '../api/image-generation-parameters.js'
import {
  generateImage as defaultGenerateImage,
  MAX_IMAGE_BYTES,
  type GenerateImageOptions,
  type GeneratedImage,
} from '../api/image-gen-client.js'

/**
 * generate_image — 文生图工具（issue #8 Wave 3）。
 *
 * 三条不变量：
 *  1. **fail-closed**：`agent.imageGenModel` 未配置时 `isEnabled()` 返回 false，
 *     工具不进 registry —— 模型看不到它，就不会产生"调了必然失败"的无效调用。
 *  2. **base64 绝不进上下文**：返回的 content 只有本地路径与体积；图片字节由
 *     `image-gen-client` 直接落到磁盘。这条由返回类型保证（客户端给的是
 *     `Uint8Array`，本工具负责写文件），不靠调用方自觉。
 *  3. **不动 primary**：baseUrl/model/key 全部取自生图槽与它引用的专用 provider；
 *     `agent.defaultModel` 与 `provider.default` 在此路径上从不被读写。
 */

export interface GenerateImageToolDeps {
  /** 生图槽读取。默认走真实 config；测试注入用。 */
  getConfig?: () => ImageGenModelConfigSnapshot | undefined
  /** provider 配置读取（取 baseUrl）。 */
  loadConfig?: () => Config
  /** API key 解析。缺失时此实现会 throw（见 api/factory.ts 的契约）。 */
  resolveApiKey?: (provider: ProviderConfig) => string
  /** 生图客户端。 */
  generateImage?: (options: GenerateImageOptions) => Promise<GeneratedImage>
  /** 默认输出目录的基准。 */
  cwd?: string
  /** 图片字节上限。缺省与 image-gen-client 的 MAX_IMAGE_BYTES 一致；这里留一道
   *  独立防线，因为客户端是可注入的（测试替身、将来的其他实现）。 */
  maxBytes?: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function createGenerateImageTool(deps: GenerateImageToolDeps = {}): Tool {
  const getConfig = deps.getConfig ?? getImageGenModelConfig
  const readConfig = deps.loadConfig ?? loadConfig
  const resolveKey = deps.resolveApiKey ?? resolveApiKey
  const generate = deps.generateImage ?? defaultGenerateImage
  const baseCwd = deps.cwd ?? process.cwd()
  const maxBytes = deps.maxBytes ?? MAX_IMAGE_BYTES
  const service = deps.generateImage ? new ImageGenerationService(undefined, async options => {
    const image = await generate(options)
    if (image.bytes.length > maxBytes) throw new Error('生成的图片过大，超过上限，已放弃写盘')
    return image
  }) : imageGenerationService

  return {
    definition: {
      name: 'generate_image',
      description: `用文生图模型生成位图（PNG/JPEG/WebP），返回本地文件路径。

与 create_image 的区别：create_image 由你手写 SVG 标记，本工具交给真实的生图模型（prompt → 图片字节）。适用于照片级图像、插画、复杂视觉内容。

生成后如需查看效果，用 read_file 读取该路径（主控有视觉能力时），或用 open_path 在系统查看器中打开。

示例：
Good: generate_image(prompt="一只在窗台晒太阳的橘猫，水彩风格")
Good: generate_image(prompt="极简几何 logo，深蓝背景", size="1024x1024")
Bad: 用 create_image 画复杂照片级场景（它只能写 SVG 矢量图）`,
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述。越具体越好。' },
          size: { type: 'string', description: '可选尺寸，如 "1024x1024"。缺省用配置里的默认值。' },
          output_path: { type: 'string', description: '可选输出路径（绝对路径或 ~ 开头）。缺省写到工作区 .rivet/artifacts/images/。' },
        },
        required: ['prompt'],
      },
    },

    async execute(params) {
      try {
        const slot = getConfig()
        if (!slot) {
          return {
            content: '未配置画图服务。请先在 设置 → 画图 里接上一个画图端点'
              + '（如 SiliconFlow 的 /v1/images/generations），或用 `rivet config image-gen` 配置。'
              + '当前 agent.defaultModel 不受影响，会话其余功能照常。',
            isError: true,
          }
        }

        const cfg = readConfig()
        const provider = cfg.provider.providers[slot.provider]
        if (!provider) {
          return {
            content: `错误：生图槽引用的 provider "${slot.provider}" 不在配置里。请重新注册生图 provider。`,
            isError: true,
          }
        }

        const input = params.input as { prompt?: string; size?: string; output_path?: string }
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
        if (!prompt) return { content: '错误：prompt 为必填项', isError: true }

        const size = input.size ?? slot.size
        const cwd = params.cwd || baseCwd
        const selection = { parameters: { provider: slot.provider, model: slot.model, prompt, prefix: slot.prompt, size, sizeField: slot.sizeField, timeoutMs: slot.timeoutMs }, connection: { baseUrl: provider.baseUrl, apiKey: resolveKey(provider), ...imageGenerationNetwork(cfg, provider) } }
        const resolved = deps.generateImage ? selection : resolveImageGeneration(selection.parameters, cfg)
        const started = await service.start({ cwd, requestId: params.toolUseId || randomUUID(), origin: 'chat', signal: params.abortSignal, sessionId: params.sessionId,
          ...resolved,
          ...(input.output_path ? { outputPath: resolve(expandHome(input.output_path.trim())) } : {}),
        })
        const result = await service.wait(cwd, started.id)
        if (result?.state !== 'succeeded' || !result.path) return { content: `错误：${result?.error?.message ?? '生成未完成'}`, isError: true }
        params.onFileWrite?.(result.path)
        return {
          content: `已生成图片（${formatSize(result.bytes ?? 0)}，${slot.model}）：${result.path}${result.recordSaved === false ? '\n图片已保存，历史记录保存失败，可在画图工作台补记。' : ''}`,
          rawPath: result.path,
          generatedImageId: result.id,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `错误：${msg}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    // 这是全库唯一会读配置的 isEnabled（其余工具都是常量 true），因此也是唯一可能
    // 抛异常的。而 registry.getDefinitions() 里的 `.filter(t => t.isEnabled())` 没有
    // try/catch——配置一旦损坏（loadConfig 在 schema 校验失败时抛，且刻意不回退默认
    // 值），异常会冒到 filter 之外，让**整张工具表**构造失败，而不是这一个工具不可用。
    // 这里降级为"未配置"，把故障限制在本工具内。
    isEnabled: () => {
      try {
        return getConfig() !== undefined
      } catch {
        return false
      }
    },
  }
}
