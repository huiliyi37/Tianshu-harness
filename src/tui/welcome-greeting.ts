/**
 * 欢迎页问候语 settle(P1-2,设计文档 §P1-2)——从 main.ts 沿接缝拆出:
 * main.ts 是点名巨石(只降不升),settle 逻辑独立成模块后可单测、可复用。
 *
 * 架构事实:欢迎页静态块 append-only,问候语经 commitStatic 追加落在欢迎页
 * 正下方(与 handoff nudge 同路径)。一行原则:LLM(flash)在竞速窗口内返回用
 * LLM 行,超时/失败/无 key 用算法模板行——任何路径至多一行;用户已开始
 * 交互(输入中或 agent busy)则静默放弃,绝不插队对话流。失败全静默:问候语
 * 是锦上添花。
 *
 * 关闭通道:RIVET_WELCOME_GREETING=off / =0(与 RIVET_WELCOME_ANIM 的 '0'
 * 语义对齐,审查 #3:同族 env 值不一致——双认防静默失效);
 * config.agent.greeting.enabled=false 时仅算法模板(不发 LLM)。
 */
import { color } from './engine/ansi.js'
import { getTheme } from './theme.js'
import { getGreetingConfig, loadConfig } from '../config/manager.js'
import { generateGreetingLlm, pickGreetingTemplate, type GreetingVoice } from '../api/greeting.js'

/** LLM 竞速窗口:超过即用算法模板行(快感阈值;迟到 LLM 结果丢弃不追加)。 */
export const GREETING_SETTLE_MS = 1_200

/** RIVET_WELCOME_GREETING 关闭判定:off/0 均关(ANIM 同族用 '0',双认防心智陷阱)。 */
function greetingEnvDisabled(): boolean {
  const v = process.env.RIVET_WELCOME_GREETING
  return v === 'off' || v === '0'
}

export interface WelcomeGreetingDeps {
  /** 跳过欢迎页场景(--skip-welcome / 恢复会话等由调用方裁决)。 */
  enabled: boolean
  /** 非 TTY(管道/CI)零输出,不污染管道。 */
  isTty: boolean
  /** idle 判据:用户已提交首条(agent busy)后不再追加,绝不插队对话流。 */
  isAgentBusy: () => boolean
  /** 输入中判据(审查 #6):竞速窗口内用户已开始输入但未提交时也不追加——
   *  只挡 busy 会漏掉「打字中」窗口,问候语会插到输入框上方。 */
  isInputPending: () => boolean
  /** 追加一行静态文本(落点:欢迎页静态块正下方)。 */
  commitStatic: (text: string) => void
  /** 测试/复用注入:greeting 配置;缺省读用户配置(getGreetingConfig)。 */
  greetingConfig?: { enabled: boolean; model: string }
  /** 测试注入:provider 凭据(apiKey/baseUrl);缺省 loadConfig 按
   *  deepseek provider 优先 → 默认 provider 兜底解析(同 serve.ts 装配)。 */
  provider?: { apiKey?: string; baseUrl?: string }
  /** 测试注入:当前小时(0-23);缺省 new Date().getHours()。 */
  hour?: number
  /** 测试/复用注入:问候语气池;缺省按 active theme 映射
   *  (pastel→playful / cyberpunk·gemini·antigravity→tech / 其余 default)。 */
  voice?: GreetingVoice
}

/** 启动后异步 settle 一行问候语(fire-and-forget,调用方不 await)。 */
export function settleWelcomeGreeting(deps: WelcomeGreetingDeps): void {
  if (!deps.enabled || !deps.isTty || greetingEnvDisabled()) return
  const theme = getTheme()
  const greetingCfg = deps.greetingConfig ?? getGreetingConfig()
  const settleHour = deps.hour ?? new Date().getHours()
  const commitGreeting = (text: string): void => {
    if (deps.isAgentBusy() || deps.isInputPending()) return
    try {
      deps.commitStatic(`${color('✦', theme.secondary)} ${color(text, theme.muted)}`)
    } catch { /* stdout 可能已不可用;显示失败不影响启动 */ }
  }
  void (async () => {
    try {
      let text: string | null = null
      if (greetingCfg.enabled) {
        // provider 解析同 serve.ts greeting 装配:deepseek provider 优先 → 默认兜底。
        // 迟到(>竞速窗口)的 LLM 结果自然丢弃——fetch 由其内部 3s abort 兜底。
        let provider = deps.provider
        if (!provider) {
          const cfg = loadConfig()
          const deepseek = cfg.provider.providers['deepseek']
          const prov = deepseek ?? cfg.provider.providers[cfg.provider.default]
          provider = {
            apiKey: prov?.apiKey ?? (prov?.apiKeyEnv ? process.env[prov.apiKeyEnv] : undefined),
            baseUrl: prov?.baseUrl,
          }
        }
        if (provider.apiKey && provider.baseUrl) {
          text = await Promise.race([
            generateGreetingLlm(provider.baseUrl, provider.apiKey, greetingCfg.model, settleHour, 'zh-CN'),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), GREETING_SETTLE_MS)),
          ])
        }
      }
      commitGreeting(text ?? pickGreetingTemplate(settleHour, deps.voice ?? theme.voice))
    } catch { /* settle 全静默 */ }
  })()
}
