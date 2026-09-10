/**
 * 首启引导开关——「无 key 时自动弹 /connect 向导」的抑制哨兵。
 *
 * 语义：用户在向导里纯取消（无进展未落草稿）即写入哨兵，此后新会话不再自动弹
 * （启动时改为单行 muted 提示）；手动 /connect 不受哨兵影响，随时可开。
 * 修复前：本模块函数仅测试引用（死代码）、哨兵从不落盘、向导每次新会话强制重弹
 * （UX 审计 P1-9）；`/onboarding dismiss` 输入拦截无任何消费方，随本次移除。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rivetHome } from './config/paths.js'

/** 哨兵路径：跟随 rivetHome()（RIVET_HOME 覆盖生效）；参数仅供测试注入。 */
export function onboardingSentinelPath(home?: string): string {
  return join(home ?? rivetHome(), 'onboarding-dismissed')
}

export function getOnboardingState(home?: string): { shouldShow: boolean } {
  return { shouldShow: !existsSync(onboardingSentinelPath(home)) }
}

export function dismissOnboarding(home?: string): void {
  const sentinel = onboardingSentinelPath(home)
  mkdirSync(dirname(sentinel), { recursive: true })
  writeFileSync(sentinel, 'dismissed\n')
}

// ── 欢迎页首启引导哨兵(P1-1,欢迎页分层)────────────────────────────
// 独立于 onboarding-dismissed(语义=provider 向导取消抑制):guide 哨兵只回答
// 「首启引导版欢迎页是否已展示过」。展示即写(无论交互),一次打扰上限。

/** 哨兵路径:rivetHome()/welcome-guide-shown(参数仅供测试注入)。 */
export function welcomeGuideSentinelPath(home?: string): string {
  return join(home ?? rivetHome(), 'welcome-guide-shown')
}

/** 首启判定:guide 哨兵未写 且 未取消过 provider 向导(老用户痕迹)→ 展示引导版。
 *  升级老用户(无 dismiss 痕迹)会见到一次引导版——设计接受,mark 即写后不再出现。 */
export function shouldShowWelcomeGuide(home?: string): boolean {
  return !existsSync(welcomeGuideSentinelPath(home)) && !existsSync(onboardingSentinelPath(home))
}

/** 展示即写(幂等):欢迎页以引导版渲染后立即调用,此后新会话回落定盘星。 */
export function markWelcomeGuideShown(home?: string): void {
  const sentinel = welcomeGuideSentinelPath(home)
  mkdirSync(dirname(sentinel), { recursive: true })
  writeFileSync(sentinel, 'shown\n')
}
