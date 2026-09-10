/**
 * GET /greeting — 桌面端欢迎页动态问候语（算法模板 + flash LLM 混合）。
 *
 * Auth-gated（和 /sessions 同级），返回一句贴合当前时段的中文问候语。
 * 算法模板即时返回；flash LLM 结果缓存当天，跨天自动失效。
 *
 * 2026-09 P1-2:模板池与 LLM 生成逻辑提取至 src/api/greeting.ts(CLI TUI 复用),
 * 本文件保留进程内缓存(llmCache)与路由装配;调用共享模块时注入 serverLogger 作 onError。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { serverLogger } from './logger.js'
import {
  generateGreetingLlm,
  greetingTimeSlot,
  pickGreetingTemplate,
} from '../api/greeting.js'

// ── 内存缓存（sidecar 生命周期内有效，跨天自动失效）────────────────────
// 值只存问候语文本——cacheKey 已内嵌北京日期+时段,date 字段写而不读(审查 #2 清理)。

const llmCache = new Map<string, string>()

function cacheKey(hour: number, locale: string): string {
  const now = new Date()
  const beijingDate = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  return `${beijingDate}:${greetingTimeSlot(hour)}:${locale}`
}

// ── Route builder ────────────────────────────────────────────────────────

export function buildGreetingRoute(
  baseUrl: string,
  apiKey: string,
  getConfig?: () => { enabled: boolean; model: string },
  apiToken?: string,
): Record<string, RouteHandler> {
  const DEFAULT_MODEL = 'deepseek-v4-flash'
  const greetingHandler: RouteHandler = async (_body, params, _headers): Promise<{ status: number; body: GreetingResponse }> => {
      const hour = Number(params?.hour)
      const locale = params?.locale ?? 'zh-CN'

      if (isNaN(hour) || hour < 0 || hour > 23) {
        return { status: 200, body: { greeting: pickGreetingTemplate(new Date().getHours()), source: 'algorithm' } }
      }

      const greetingConfig = getConfig?.() ?? { enabled: true, model: DEFAULT_MODEL }

      // 有 API key 且 greeting LLM 已启用才走 LLM 路径
      if (apiKey && greetingConfig.enabled) {
        const ck = cacheKey(hour, locale)
        const cached = llmCache.get(ck)
        if (cached) {
          return { status: 200, body: { greeting: cached, source: 'llm', cached: true } }
        }

        try {
          const llmResult = await generateGreetingLlm(baseUrl, apiKey, greetingConfig.model, hour, locale, {
            onError: (err) => serverLogger.warn('greeting LLM fetch failed', { error: String(err) }),
          })
          if (llmResult) {
            llmCache.set(ck, llmResult)
            return { status: 200, body: { greeting: llmResult, source: 'llm' } }
          }
        } catch (err) {
          // 防御网(审查 #5):generateGreetingLlm 当前全失败路径内 catch 返回 null
          // 从不抛出,此 catch 不可达——保留以防未来改动引入 throw 时静默炸请求。
          serverLogger.warn('greeting LLM call failed, falling back to template', {
            error: String(err),
          })
        }
      }

      // fallback: 算法模板
      return { status: 200, body: { greeting: pickGreetingTemplate(hour), source: 'algorithm' } }
    }
  // 路由级鉴权（防御纵深，同 speech-routes）——未传 token 的直连消费方保持原行为。
  if (!apiToken) return { 'GET /greeting': greetingHandler }
  return {
    'GET /greeting': async (body, params, headers, res) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      return greetingHandler(body, params, headers, res)
    },
  }
}

interface GreetingResponse {
  greeting: string
  source: 'algorithm' | 'llm'
  cached?: boolean
}
