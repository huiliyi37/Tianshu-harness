/**
 * 用户附图的视觉分派——多模态主控直通 / text-only 走识图桥 / 无桥则**丢弃并明说**。
 *
 * 从 loop.ts 抽出（该文件行数已顶到棘轮 ceiling，且这段有三条出口、出口文案都是
 * 「模型与用户都得知道发生了什么」，塞在 run() 里既挤又难测）。
 *
 * 三条分支：
 *   ① 主模型声明 supportsVision → 原图照常进请求，本模块不改写任何东西。
 *   ② text-only + 配了识图模型 → 描述注入 userInput，原图从请求移除（原图仍在
 *      imageRegistry 里，供 ask_image 同角度追问命中缓存）。
 *   ③ text-only + 无识图模型 → **丢弃**图片并注入可见提示。此前这条分支会把 image
 *      part 照旧挂进请求与会话历史，而 TUI 气泡早已写着「图片未发送」——文案与实现
 *      不一致，且模型可能对着看不见的图硬猜（静默降级的最贵形状）。与 tool-pipeline
 *      对工具截图「不支持则丢弃」同规。
 */

import type { StreamClient } from '../api/stream-client.js'
import { describeImages, visionCacheKey } from './vision-service.js'
import { debugLog } from '../utils/debug.js'

export interface UserImageDispatchConfig {
  /** 主模型是否接受图片输入（见 loop-types.ts 的 supportsVision）。 */
  supportsVision?: boolean
  /** 专用多模态客户端；缺省 = 无识图桥。 */
  visionClient?: StreamClient
  visionModelPrompt?: string
  visionModelMaxTokens?: number
  /** 本轮图片已寄存的 id（顺序同 images）；用于把首条描述写回首图缓存。 */
  registeredIds?: string[]
  /** 写回首图描述缓存；缺省 no-op（单测不必造 registry）。 */
  cacheDescription?: (imageId: string, cacheKey: string, description: string) => void
  signal?: AbortSignal
  recordUsage?: (usage: Partial<import('../api/types.js').Usage>) => void
  /** Bridge identity for description caching; the client binds the API model. */
  visionModel?: string
}

export interface UserImageDispatchResult {
  /** 可能被注入描述/提示的 userInput（无图或直通时原样返回）。 */
  userInput: string
  /** 主模型请求应携带的图片（data URL）；undefined = 本轮不附图。 */
  images?: string[]
}

/** 无识图桥的可见提示（进 userInput，模型与用户都能看到）。 */
export function formatNoBridgeNotice(imageCount: number): string {
  return `[图片未发送] 用户附了 ${imageCount} 张图片，但当前模型不支持识图、也没有配置识图模型（agent.visionModel）——`
    + '图片未随本轮请求发出。请告知用户这一点（配置识图模型或改用视觉模型后重发即可），'
    + '不要凭记忆描述你看不到的图。\n\n'
}

/**
 * 分派本轮用户附图。**不改写入参**，返回新的 userInput 与 images。
 */
export async function dispatchUserImages(
  userInput: string,
  images: string[] | undefined,
  config: UserImageDispatchConfig,
): Promise<UserImageDispatchResult> {
  if (!images || images.length === 0) return { userInput, images }
  // ① 多模态主控：原生识图，什么都不做（图片进 oaiMessages；registry 已寄存供 ask_image 复用）。
  if (config.supportsVision) return { userInput, images }

  // ③ 无桥：图片没有任何去处——丢弃并说明。放在桥接之前判，避免「先登记再丢弃」的错觉。
  if (!config.visionClient) {
    debugLog(`[vision] 主模型不识图且无识图桥 → 丢弃本轮 ${images.length} 张图片（仅保留可见提示）`)
    return { userInput: formatNoBridgeNotice(images.length) + userInput, images: undefined }
  }

  // ② 桥接：图 → 文字描述。失败不得炸整轮：超时/报错/空描述都降级为一条可见提示，
  // 让主控知道「有图但没读到」而不是静默吞图或整轮 failed。原因落 debugLog。
  // 缓存键必须按**原始** userInput 归类（与 describeImages 内部的模式判定同源）——
  // userInput 下面会被 prepend 改写，故先算好键再改写。
  const descriptionKey = `${config.visionModel ?? 'unknown'}:${visionCacheKey(undefined, config.visionModelPrompt, userInput)}`
  let nextInput = userInput
  let complete = false
  try {
    const description = await describeImages(config.visionClient, images, {
      prompt: config.visionModelPrompt,
      // 随图文本用于自动切通用/精确转写模式（用户没显式配 prompt 时）：
      // "这个报错怎么回事[图]" → 精确 OCR 转写，避免泛泛描述丢掉报错行。
      accompanyingText: userInput,
      maxTokens: config.visionModelMaxTokens,
      signal: config.signal,
      recordUsage: config.recordUsage,
      onOutcome: outcome => { complete = outcome.complete },
    })
    if (description) {
      nextInput = `[图片描述]\n${description}\n\n${userInput}`
      // 首描述写入首图缓存，供 ask_image 同角度追问命中零调用。
      const firstId = config.registeredIds?.[0]
      if (firstId && complete && images.length === 1) config.cacheDescription?.(firstId, descriptionKey, description)
    } else {
      nextInput = `[图片桥接提示] 用户发送了 ${images.length} 张图片，但识图模型返回空描述——`
        + `请告知用户重发或检查识图模型配置。\n\n${userInput}`
      debugLog('[vision] bridge returned empty description')
    }
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err)
    nextInput = `[图片桥接失败] 用户发送了 ${images.length} 张图片，但识图桥接出错（${reason}）——`
      + `请告知用户识图暂不可用，可检查 agent.visionModel 配置或稍后重试。\n\n${userInput}`
    debugLog(`[vision] bridge error: ${reason}`)
  }
  // text-only 主控：图已转描述（或已降级为提示），从 prompt parts 去掉；原图仍在 registry 供二次看。
  return { userInput: nextInput, images: undefined }
}
