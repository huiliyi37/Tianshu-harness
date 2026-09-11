/**
 * Provider-level retry policy schema (issue #75).
 *
 * 拆出自 schema.ts（结构棘轮：schema.ts 是点名巨石，ceiling 只降不升）——
 * 新配置面在此完整定义，schema.ts 只保留一行挂载。
 *
 * 全部字段可选：未配置时重试行为与历史完全一致（分类器默认延迟 + 客户端内置预算）。
 */
import { z } from 'zod'
import { ERROR_CATEGORIES } from '../api/error-classifier.js'

/** 指数退避曲线形状。配置本块即启用统一指数退避（作用于全部可重试类别）；
 *  未配置时保持历史行为（分类器固定延迟 + 抖动）。 */
export const retryBackoffSchema = z.object({
  /** 指数退避起点（ms）。分类器未给出该类延迟时（如 image_strip 的 0）用它。 */
  baseDelayMs: z.number().int().positive().optional(),
  /** 单次等待封顶（ms），默认 30000。 */
  maxDelayMs: z.number().int().positive().optional(),
  /** 抖动比例（0–2）：等待 = capped + random() × ratio × capped，默认 0.5。 */
  jitterRatio: z.number().min(0).max(2).optional(),
})

/** 单个错误类别的覆盖项（键必须是已知类别，拼错即 loadConfig 校验失败）。 */
export const retryOverrideSchema = z.object({
  /** 该类别的重试上限（0 = 该类不重试）。显式值不再被分类器默认值向下夹取。 */
  maxRetries: z.number().int().min(0).max(20).optional(),
  /** 该类别的等待基准（ms）；配置 backoff 时作为该类指数退避的起点。 */
  retryDelayMs: z.number().int().min(0).optional(),
})

/** 客户端令牌桶限速（默认关闭）。进程内按 provider 共享同一只桶。 */
export const retryRateLimitSchema = z.object({
  requestsPerSecond: z.number().positive(),
  /** 桶容量（突发额度），默认 = ceil(requestsPerSecond)。 */
  burst: z.number().int().positive().optional(),
})

export const providerRetrySchema = z.object({
  /** 重试总时长预算（ms）——替代内置的 glm 20min / 其余 10min。 */
  maxTotalDurationMs: z.number().int().positive().optional(),
  backoff: retryBackoffSchema.optional(),
  overrides: z.record(z.enum(ERROR_CATEGORIES), retryOverrideSchema).optional(),
  rateLimit: retryRateLimitSchema.optional(),
})

/** Provider-level retry policy — validated shape carried into the API clients. */
export type ProviderRetryConfig = z.infer<typeof providerRetrySchema>
