import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { serverLogger } from './logger.js'

// POST /settings/intent — 自然语言改设置的 LLM 兜底（Wave 3，回流自
// `origin/tianshu-alpha-3.14` 的 2e0109f63，按 3.15 主线能力面裁剪）。
// 桌面端规则引擎（desktop/src/lib/settings-intent/rules.ts）未命中时调用。
// 单次非流式 chat（stream:false，照 greeting-route 的手工 fetch 模式），
// system prompt 内嵌设置 schema 紧凑版，要求输出严格 JSON；
// 解析失败/LLM 失败统一降级 matched:false——前端展示引导文案，功能不中断。

const INTENT_TIMEOUT_MS = 10_000

/** 意图 schema（与 desktop/src/lib/settings-intent/schema.ts 双源）。
 *  契约测试 settings-intent.test.ts 断言两端 key+values 逐项一致——
 *  新增设置项时必须同步此处，否则 LLM 兜底对新项静默失效。
 *
 *  与 alpha 版本的差异（同步裁剪，勿各自漂移）：无 lineHeight / fontSizeOffset
 *  两项（主线尚无对应 setter），fontFamily 无 custom，chatFontSize 无 17。 */
export const SETTINGS_INTENT_SCHEMA = [
  { key: 'fontSize', label: '界面字号', values: ['compact', 'normal', 'medium', 'large', 'xlarge'] },
  { key: 'chatFontSize', label: '会话字号', values: ['follow', '12', '13', '14', '15', '16', '18'] },
  { key: 'fontFamily', label: 'UI 字体', values: ['sans', 'inter', 'lxgw-wenkai', 'source-han', 'fira-code', 'jetbrains-mono', 'cascadia', 'kaiti', 'geometric', 'mono'] },
  { key: 'codeFont', label: '代码字体', values: ['default', 'system', 'sf', 'menlo', 'cascadia'] },
  { key: 'fontWeight', label: '字重', values: ['normal', 'medium', 'bold'] },
  { key: 'uiDensity', label: '界面密度', values: ['compact', 'cozy', 'spacious'] },
  { key: 'uiScale', label: '界面缩放', values: ['0.8', '0.9', '1', '1.1', '1.25', '1.5'] },
] as const satisfies ReadonlyArray<{ key: string; label: string; values: readonly string[] }>

const SCHEMA_JSON = JSON.stringify(SETTINGS_INTENT_SCHEMA)

/** LLM 返回的 key/value 在服务端按 schema 白名单复验（防御纵深）。今天唯一
 *  消费方（桌面端）另有自己的白名单，但端点契约一旦有第二个消费方（CLI/脚本）
 *  信任它，幻觉 key/value 即穿透——schema 就在手边，校验成本一行。 */
function inSchema(key: string, value: string): boolean {
  return SETTINGS_INTENT_SCHEMA.some(e => e.key === key && (e.values as readonly string[]).includes(value))
}

export interface SettingsIntentResponse {
  matched: boolean
  key?: string
  value?: string
  message?: string
}

/**
 * 从 LLM 输出中提取首个完整 JSON 对象（容忍前后缀噪音）。
 * 整串优先；失败后括号深度扫描（含字符串内引号/转义处理），
 * 取第一个 '{' 到其闭合 '}'——比 indexOf/lastIndexOf 切片稳，
 * 支持嵌套对象与多 JSON 对象前缀场景。
 */
function extractJson(text: string): Record<string, unknown> | null {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  try {
    const direct = JSON.parse(text)
    if (isObj(direct)) return direct
  } catch {
    // fall through to depth scan
  }
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1))
          return isObj(parsed) ? parsed : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

async function llmIntent(
  text: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<SettingsIntentResponse> {
  const systemPrompt = `你是天枢桌面端的设置意图解析器。用户想用自然语言修改设置。
可用设置项（key: label, 取值列表）：
${SCHEMA_JSON}

把用户输入映射到最匹配的设置项与取值。只输出一个 JSON 对象：
命中：{"matched":true,"key":"<key>","value":"<取值>"}
未命中：{"matched":false,"message":"<一句引导，不超过30字>"}
不要输出任何其他内容。`

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    max_tokens: 128,
    temperature: 0,
    stream: false,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS)

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return { matched: false, message: '解析服务暂不可用，请稍后再试' }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) return { matched: false, message: '解析服务暂不可用，请稍后再试' }
    const parsed = extractJson(content)
    if (parsed && parsed.matched === true && typeof parsed.key === 'string' && typeof parsed.value === 'string'
        && inSchema(parsed.key, parsed.value)) {
      return { matched: true, key: parsed.key, value: parsed.value }
    }
    if (parsed && parsed.matched === false && typeof parsed.message === 'string') {
      return { matched: false, message: parsed.message }
    }
    return { matched: false, message: '未能理解，换个说法试试' }
  } catch (err) {
    serverLogger.warn('settings-intent LLM fetch failed', { error: String(err) })
    return { matched: false, message: '解析服务暂不可用，请稍后再试' }
  } finally {
    clearTimeout(timer)
  }
}

export function buildSettingsIntentRoutes(opts: {
  /** 请求时求值（配置热重载即时生效——首启无 key 后在 Settings 配好 key、
   *  或切换默认 provider 时，按值捕获会让兜底永久失效）。 */
  getBaseUrl: () => string
  getApiKey: () => string
  /** 请求时求值（模型切换即时生效，与 greeting 的 getConfig 模式一致）。 */
  getModel: () => string
  apiToken?: string
}): Record<string, RouteHandler> {
  const handler: RouteHandler = async (body): Promise<{ status: number; body: SettingsIntentResponse }> => {
    const { text } = (body ?? {}) as { text?: unknown }
    if (typeof text !== 'string' || !text.trim()) {
      return { status: 400, body: { matched: false, message: '空文本' } }
    }
    // 设置意图是短输入；超长文本只会白烧 token 并撞 10s 超时。
    if (text.length > 200) {
      return { status: 400, body: { matched: false, message: '文本过长' } }
    }
    const result = await llmIntent(text.trim(), opts.getBaseUrl(), opts.getApiKey(), opts.getModel())
    return { status: 200, body: result }
  }

  // Fail-closed 恒成立：本端点每次调用都烧一次 LLM token，绝不裸奔。
  // isAuthorizedRequest 对 apiToken 缺省（未配置鉴权）一律 401——无鉴权配置
  // 时端点等效停用，而不是对局域网开放（greeting 的豁免模式对它不适用）。
  return {
    'POST /settings/intent': async (body, params, headers, res) => {
      if (!isAuthorizedRequest({ body, headers }, opts.apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      return handler(body, params, headers, res)
    },
  }
}
