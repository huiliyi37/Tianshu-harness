/**
 * Provider tunables —— 存量 provider 的可调运行时参数（字段级更新）。
 *
 * 自 manager.ts 拆出（结构棘轮：manager 是点名巨石，ceiling 只降不升；本模块
 * 只依赖 schema.ts，无循环）。桌面端配置面板经 POST /config/providers/tunables
 * 落到这里；CLI/TUI 若将来需要同一通道也复用它。
 */
import { z } from 'zod'
import { providerBaseSchema, type ProviderConfig } from './schema.js'

/**
 * 白名单字段。字段值 undefined 或 null = 删除该键，恢复按名称/baseUrl 的启发式
 * 推导（slowThinking 三态的「默认」档；firstByteTimeoutMs/thinkingStallTimeoutMs
 * 的 undefined = 用推导值）。null 是 JSON.stringify 下唯一可传输的删键编码——
 * undefined 属性会被序列化丢弃（传输层静默失效，见 config-routes 往返测试）。
 */
export const TUNABLE_FIELD_KEYS = [
  'slowThinking',
  'firstByteTimeoutMs',
  'thinkingStallTimeoutMs',
  'maxRetries',
  'retry',
] as const

/**
 * 嵌套对象型 tunable：走子键级合并（见 mergeNestedTunable），不做整体替换。
 */
const NESTED_TUNABLE_KEYS = new Set<string>(['retry'])

/**
 * 就地应用字段级更新到 provider。校验失败抛错——落盘与否由调用方决定
 * （manager 的写入路径在全部字段通过后才 saveConfig）。
 */
export function applyProviderTunables(provider: ProviderConfig, fields: Record<string, unknown>): void {
  const shape = providerBaseSchema.shape as Record<string, z.ZodTypeAny>
  for (const [key, value] of Object.entries(fields)) {
    if (!(TUNABLE_FIELD_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown tunable field "${key}". Allowed: ${TUNABLE_FIELD_KEYS.join(', ')}`)
    }
    if (value === undefined || value === null) {
      delete (provider as unknown as Record<string, unknown>)[key]
      continue
    }
    // 白名单与 schema 的对应关系不是类型强制的——将来白名单加键而忘加 schema
    // 字段时，这里必须报友好错误而不是裸 TypeError。
    const fieldSchema = shape[key]
    if (!fieldSchema) {
      throw new Error(`Internal consistency: tunable field "${key}" has no schema entry — add it to providerSchema`)
    }
    let next: unknown = value
    if (NESTED_TUNABLE_KEYS.has(key)) {
      const existing = (provider as unknown as Record<string, unknown>)[key]
      const merged = mergeNestedTunable(existing, value)
      // 合并后为空 = 全部子键都被删掉：删整块，别留空对象。
      if (Object.keys(merged).length === 0) {
        delete (provider as unknown as Record<string, unknown>)[key]
        continue
      }
      next = merged
    }
    const parsed = fieldSchema.safeParse(next)
    if (!parsed.success) {
      throw new Error(`Invalid value for "${key}": ${parsed.error.message}`)
    }
    ;(provider as unknown as Record<string, unknown>)[key] = parsed.data
  }
}

/**
 * 嵌套 tunable 的**递归**子键级合并：patch 中 null/undefined 删该子键、其余替换，
 * 未提及的子键在**每一层**都保留（数组与非对象值整体替换，不做元素级合并）。
 *
 * 必须是递归而非单层：retry 至少两层（retry.rateLimit.burst、retry.overrides.<类别>.*）。
 * 只并顶层时，桌面 UI 提交 { rateLimit: { requestsPerSecond: 5 } } 会把用户照文档手写的
 * retry.rateLimit.burst 整体吃掉——一次失焦即触发、无提示（对抗审查 F1，有判别用例钉住）。
 */
function mergeNestedTunable(existing: unknown, patch: unknown): Record<string, unknown> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Nested tunable expects an object patch')
  }
  const base: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {}
  for (const [subKey, subValue] of Object.entries(patch as Record<string, unknown>)) {
    if (subValue === null || subValue === undefined) {
      delete base[subKey]
      continue
    }
    const current = base[subKey]
    if (isPlainObject(subValue) && isPlainObject(current)) {
      base[subKey] = mergeNestedTunable(current, subValue)
      continue
    }
    base[subKey] = subValue
  }
  return base
}

/** 纯对象判定（排除 null 与数组）——递归合并只对对象下钻。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
