/**
 * 天枢 BYOK 语言模型 provider（呈现层占位）。
 *
 * VS Code 在没有任何模型注册时不路由 chat 请求（扩展宿主在 participant handler
 * 之前抛出 "Language model unavailable"），且 chat 的 setup 门在 BYOK 键点亮前
 * 持续索要 Copilot 登录。注册表的半边由本 provider 提供；门那半边由 fork 的
 * chat-gate 补丁负责（hasByokModels 强制点亮）。
 *
 * 它故意不回答：真正的对话走 @tianshu participant + sidecar agent 运行时。
 * 在本通道假装推理会是无声的谎言——落进来的请求被告知真正的入口。
 * @module
 */
import type * as vscode from 'vscode'
import type { ProviderConfigList, ProviderListItem } from '../sidecar/protocol.js'

/** vendor id；必须与 package.json 的 contributes.languageModelChatProviders[].vendor 一致。 */
export const TIANSHU_VENDOR = 'tianshu'

/** 窗口尺寸缺省兜底（内核契约未带 contextWindow/maxTokens 时保守取值）。 */
const DEFAULT_MAX_INPUT_TOKENS = 128_000
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/** 上报给 VS Code 的模型家族。 */
export const TIANSHU_FAMILY = 'tianshu'

/** 模型 id，按 provider 契约带 vendor 命名空间。 */
export const MODEL_ID = `${TIANSHU_VENDOR}/agent`

/** 请求被路由到本通道（而非 participant）时的提示。 */
export const UNAVAILABLE_NOTE = '天枢的对话入口是 `@tianshu`：本模型只用于让 Chat 视图可用，不在此通道推理。请把问题发给 `@tianshu 你的问题`，回答会经本地 sidecar 的 agent 运行时流式返回。'

/**
 * 本 provider 唯一的模型描述。
 *
 * 每次调用返回新对象：VS Code 不缓存此处，调用方改返回值也不会污染后续调用。
 * @returns VS Code 用于提供模型选择的模型信息。
 */
export function tianshuModelInfo(): vscode.LanguageModelChatInformation {
  return {
    id: MODEL_ID,
    name: '天枢 agent',
    family: TIANSHU_FAMILY,
    version: '1',
    detail: '经本地 sidecar 的 agent 运行时',
    maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    // toolCalling: true 是「模型在 Agent 模式可选」的前置：fork 的模型池按
    // suitableForAgentMode 过滤掉 !toolCalling 的模型，而 chat 默认就是 Agent
    // 模式——声明 false 会让本模型整体不可选（no-model-at-toolbar-build）。
    // 此通道不推理；真实工具执行在 participant/sidecar——此处是呈现层声明。
    capabilities: { imageInput: false, toolCalling: true },
  }
}

function modelCredentialsReady(provider: ProviderListItem, model: ProviderListItem['models'][number]): boolean {
  if (provider.authType === 'oauth') return provider.oauthAuthenticated === true
  if (provider.oauthAuthenticated === true || provider.keyless === true) return true
  const status = provider.keys?.length
    ? provider.keys.find(key => key.models.some(owned => owned.id === model.id))?.keyStatus
    : provider.keyStatus
  return status?.source === 'inline' || status?.source === 'env'
}

/**
 * 把内核 provider 目录投影为 chat 的模型信息列表（chat 模型选择器的真实数据源）。
 *
 * 按凭据就绪状态列出可调用的模型；keys 池以模型的首个归属 key 为准。
 * 用户在 picker 的选择
 * 由 participant 同步到 sidecar 会话（POST /sessions/:id/model 热切换，保留历史）。
 * 窗口尺寸取自内核契约（contextWindow / maxTokens），缺失时保守兜底；空 id 丢弃、
 * 同 id 去重（内核 /config/providers 的 id/alias 为全局解析域）。
 * toolCalling 是对 chat 的呈现层声明：真实工具执行在 participant/sidecar 内核，
 * 而 Agent 模式（chat 默认）的模型池按 !toolCalling 过滤——不声明会整体不可选。
 * @param catalog - GET /config/providers 的响应。
 * @returns 按目录序的模型信息列表；无可用模型时为空数组（调用方决定是否兜底占位）。
 */
export function mapProviderModels(catalog: ProviderConfigList): vscode.LanguageModelChatInformation[] {
  const out: vscode.LanguageModelChatInformation[] = []
  const seen = new Set<string>()
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (!modelCredentialsReady(provider, model)) continue
      const id = model.id.trim()
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: id,
        family: provider.name,
        version: '1',
        detail: model.description ?? provider.label,
        maxInputTokens: model.contextWindow ?? DEFAULT_MAX_INPUT_TOKENS,
        maxOutputTokens: model.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        capabilities: { imageInput: model.supportsVision === true, toolCalling: true },
      })
    }
  }
  return out
}

/**
 * 仅用于上下文计数的粗略估算，不用于计费。
 * @param text - 待估算文本。
 * @returns 非负估算值；纯空白内容恰为 0。
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : Math.max(1, Math.ceil(trimmed.length / 4))
}
