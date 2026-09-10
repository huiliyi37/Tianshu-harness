import { providerIdentityHeaders } from './caller-identity.js'

/**
 * 动态问候语共享模块(P1-2):算法模板池 + flash LLM 单句生成。
 *
 * 2026-09 从 src/server/greeting-route.ts 提取(提取前原内部符号零外部引用,
 * 仅 serve.ts import buildGreetingRoute)——CLI TUI 欢迎页与桌面端 greeting
 * route 共用同一份模板池与生成逻辑,避免双份漂移。
 *
 * 归属边界:进程内内存缓存(llmCache,按北京日期+时段)留在 route 侧——那是
 * sidecar 进程态(桌面端高频打开欢迎页);CLI 每进程至多一次调用,不需要缓存。
 *
 * 语气池(2026-09,风格化):算法模板按 GreetingVoice 选池——主题风格化需求下,
 * CLI 侧按 active theme 映射 voice(pastel→playful / cyberpunk·gemini→tech),
 * 桌面 route 不传 voice 走 default,行为零变化。文案约束:≤25 字、无 emoji、
 * 纯终端安全字符(颜文字会折行/豆腐,禁用)。
 */

// ── 算法模板池(服务端兜底,CLI 无 key/降级共用)───────────────────────

const TEMPLATES: Record<string, string[]> = {
  morning: [
    '上午好，准备开启什么新任务？',
    '早啊，代码在等你',
    '上午好，今天从哪开始？',
    '早安，一杯咖啡一行代码',
    '上午好，思路清晰的时候最适合开工',
    '早，今天有什么计划？',
    '上午好呀，新的一天新的代码',
    '早安，先跑个测试热热身',
  ],
  noon: [
    '中午好呀，要不要先休息一下',
    '午安，吃饱了才有力气 debug',
    '中午了，起来走动一下吧',
    '午休时间到，代码不会跑的',
    '中午好，眯一会儿下午更清醒',
  ],
  afternoon: [
    '下午好，今天想规划点什么？',
    '下午好，午后的效率最高',
    '下午了，继续冲刺吧',
    '下午好，要不要 review 一下上午的代码',
    '下午好，还有半天可以大干一场',
    '午后阳光正好，写代码正合适',
    '下午好，今天进度怎么样？',
  ],
  evening: [
    '晚上好，整理一下今天的代码库吧',
    '晚上了，总结一下今天的成果',
    '晚上好，夜深人静写代码最专注',
    '晚上好，要不要提交今天的改动',
    '入夜了，测试跑完了吗',
    '晚上好，这时候写代码最有感觉',
    '晚上好，今天的 commit 整理了吗',
    '夜色降临，最好的 debug 时间到了',
  ],
  night: [
    '夜深了，注意休息',
    '凌晨了，明天再战吧',
    '夜深了，代码不会跑，身体要紧',
    '这么晚了还在写代码，记得早点休息',
    '深夜了，保存一下明天继续',
    '夜深人静，但也该休息了',
    '凌晨好，你是夜猫子型开发者吗',
    '夜深了，该和代码说晚安了',
  ],
}

// ── 语气池:playful(粉彩二次元向)/ tech(霓虹科技向)──────────────────
// 主题风格化(2026-09):pastel 主题配 playful、cyberpunk/gemini 配 tech。
// 每池 5 时段 × 4-5 条;措辞守终端纪律——无 emoji、无颜文字、≤25 字。

const VOICE_POOLS: Record<GreetingVoice, Record<string, string[]>> = {
  default: TEMPLATES,
  playful: {
    morning: [
      '早上好呀，今天也要元气满满地写代码',
      '早安~新的一天，代码在等你宠幸',
      '早早早！要不要先跑个测试热热身',
      '上午好呀，思路超清晰，最适合开工',
    ],
    noon: [
      '中午好~吃饱了才有力气 debug',
      '午安！起来伸个懒腰吧',
      '中午啦，代码不会跑，先去吃饭饭',
    ],
    afternoon: [
      '下午好呀，继续冲鸭',
      '下午茶时间到，顺手 review 一波？',
      '下午好~今天进度怎么样啦',
      '午后效率最高，一起加油冲',
    ],
    evening: [
      '晚上好呀，今天的 commit 整理了吗',
      '入夜啦，最适合专心写代码的时刻',
      '晚上好~要不要总结一下今天的成果',
      '夜色正好，debug 也很有感觉哦',
    ],
    night: [
      '夜深啦，早点休息哦',
      '凌晨了还在写代码，身体要紧呀',
      '深夜好~保存一下，明天再战',
      '这么晚了，代码会等你的，去睡吧',
    ],
  },
  tech: {
    morning: [
      '系统启动完毕。今日目标已就绪',
      '晨间自检通过——建议先规划任务',
      '上午好。缓存预热完成，随时开工',
      '新的一天。先跑一轮测试校准状态',
    ],
    noon: [
      '午间维护窗口：建议暂停充电',
      '中午了。代码不会跑，你需要休息',
      '午安。下午的算力已为你就绪',
    ],
    afternoon: [
      '下午好。效率曲线处于峰值区间',
      '午后会话已开启，继续推进主线',
      '下午好。同步一下当前进度？',
      '黄金时段，专注力拉满',
    ],
    evening: [
      '晚间会话开始。提交今日改动？',
      '夜幕降临，进入深度工作模式',
      '晚上好。总结今日成果，规划明日',
      '夜间构建窗口已开启，适合收尾',
    ],
    night: [
      '深夜模式。建议保存并休眠',
      '凌晨了。代码明天还在，健康是硬约束',
      '夜行者你好。注意休息，明日再战',
      '深夜了。当前进度已存档，去睡吧',
    ],
  },
}

/** 语气档:default(中性)/ playful(粉彩活泼)/ tech(科技冷静)。 */
export type GreetingVoice = 'default' | 'playful' | 'tech'

/** 时段分区:5 晨 / 11 午 / 14 午后 / 18 晚 / 23 深夜。 */
export function greetingTimeSlot(hour: number): string {
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 14) return 'noon'
  if (hour >= 14 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

/** 算法模板:按小时随机取一条(兜底路径,零网络零失败)。voice 缺省 default
 *  (桌面 route 与既有调用不变);voice 池缺该时段时回落 default 池。 */
export function pickGreetingTemplate(hour: number, voice: GreetingVoice = 'default'): string {
  const slot = greetingTimeSlot(hour)
  const voicePool = VOICE_POOLS[voice]?.[slot]
  const pool = voicePool && voicePool.length > 0 ? voicePool : TEMPLATES[slot] ?? TEMPLATES.morning!
  return pool[Math.floor(Math.random() * pool.length)]!
}

// ── LLM 生成 ─────────────────────────────────────────────────────────

/** 默认超时:3s(冷启动 fetch 上限;CLI settle 另有 1.2s 竞速窗口在外层收口)。 */
export const GREETING_LLM_TIMEOUT_MS = 3_000

/** 问候语生成的会话标识——固定值：它不是任何真实对话，但上游（OpenCode Go）
 *  对 chat/completions 强制会话头，缺了就永远降级模板池。 */
const GREETING_SESSION_ID = 'tianshu-greeting'

export interface GreetingLlmOptions {
  /** 请求超时(默认 GREETING_LLM_TIMEOUT_MS;测试注入短超时用)。 */
  timeoutMs?: number
  /** 失败回调(server 侧接 serverLogger;CLI 静默不传)。 */
  onError?: (err: unknown) => void
}

function weekdayName(date: Date, locale: string): string {
  const weekdays = locale === 'zh-CN'
    ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return weekdays[date.getDay()]!
}

/**
 * 生成一句中文问候(flash 模型)。任何失败(网络/非 2xx/超长/超时)
 * 一律静默返回 null——问候语是锦上添花,绝不把错误抛给启动路径。
 * 调用方负责降级(pickGreetingTemplate)与超时竞速。
 *
 * 长度两层语义(审查 #4):prompt 要求模型输出 ≤25 字(prompt 目标),
 * 返回守卫放行 ≤50(prompt 有标点/语气词时 25-50 字不算跑题,50 是防
 * 截断伤害的硬上限)——二者并存是设计,不是谓词漂移;UI 侧对算法模板
 * 的 ≤25 断言不适用于 LLM 路径。
 */
export async function generateGreetingLlm(
  baseUrl: string,
  apiKey: string,
  model: string,
  hour: number,
  locale: string,
  opts?: GreetingLlmOptions,
): Promise<string | null> {
  const slot = greetingTimeSlot(hour)
  const slotLabel: Record<string, string> = {
    morning: '上午', noon: '中午', afternoon: '下午', evening: '晚上', night: '深夜',
  }
  const now = new Date()
  const wd = weekdayName(now, locale)

  const systemPrompt = `你是天枢桌面终端的欢迎助手。当前是${wd}${slotLabel[slot] ?? ''}${hour}点左右。请用中文生成一句温暖、有人文关怀的问候语送给开发者。不超过25字。不要加称呼（如"亲爱的"）、不要感叹号堆砌、不要emoji。`

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请给出一句问候语。' },
    ],
    max_tokens: 64,
    temperature: 0.9,
    stream: false,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? GREETING_LLM_TIMEOUT_MS)

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // 欢迎语也走 chat/completions，同样要带出站身份头——OpenCode Go 缺
        // x-opencode-session 会 400，症状是问候语永远走模板池（此处静默降级）。
        ...providerIdentityHeaders(undefined, baseUrl, GREETING_SESSION_ID),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = json.choices?.[0]?.message?.content?.trim()
    return text && text.length > 0 && text.length <= 50 ? text : null
  } catch (err) {
    opts?.onError?.(err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
