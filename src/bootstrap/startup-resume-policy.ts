import type { ResolvedModelTarget } from './model-resolution.js'

export interface StartupResumeModelDecision {
  target: ResolvedModelTarget | null
  originalModel?: string
  fallbackUsed: boolean
  degradedWarning?: string
}

/**
 * 启动 resume 模型亲和决策（纯函数，可测）：前缀缓存是 per-model 命名空间，
 * resume 不换回原模型，继承的冻结快照也落不进缓存。显式 --model/--provider
 * 优先（用户意图 > 缓存亲和）；原模型不可用走 resumeFallbackModel 兜底；
 * 兜底也没有 → 警告降级（不 fail-closed——startup 是进程入口，拒跑等于
 * 会话打不开，用户连开新会话都要绕路 --new；与 switchAgentSession 的
 * fail-closed 语义差异是刻意的）。
 */
export function decideStartupResumeModel(input: {
  resumed: boolean
  explicitModel?: string
  explicitProvider?: string
  originalModel?: string
  fallbackModelId?: string
  resolve: (modelId: string) => ResolvedModelTarget | { error: string } | null
}): StartupResumeModelDecision {
  if (!input.resumed || input.explicitModel || input.explicitProvider) {
    return { target: null, fallbackUsed: false }
  }
  if (!input.originalModel) return { target: null, fallbackUsed: false }
  const hit = input.resolve(input.originalModel)
  if (hit && !('error' in hit)) {
    return { target: hit, originalModel: input.originalModel, fallbackUsed: false }
  }
  const fb = input.fallbackModelId ? input.resolve(input.fallbackModelId) : null
  if (fb && !('error' in fb)) {
    return { target: fb, originalModel: input.originalModel, fallbackUsed: true }
  }
  return {
    target: null,
    originalModel: input.originalModel,
    fallbackUsed: false,
    degradedWarning: `⚠ 原模型 ${input.originalModel} 当前不可用，且未配置续跑兜底模型（agent.resumeFallbackModel）——按默认模型续跑，前缀缓存将全量重建。`,
  }
}
