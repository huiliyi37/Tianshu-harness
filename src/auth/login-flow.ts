/**
 * OAuth 登录流程（codex 等 oauth 型 provider）——TUI `/login` 与 CLI
 * `rivet config login` 共用的唯一入口。
 *
 * 背景：connect-flow 曾指引「请运行 /login 完成登录」，但该命令从未注册
 * （幽灵指引）；OAuthAuth.authenticate()（PKCE + 本机回环回调，实现与测试
 * 早已完备）长期零生产调用。本模块把它接到用户面前。
 */
import { execFile } from 'node:child_process'
import { loadConfig } from '../config/manager.js'
import { createOAuthLoginAuth } from './registry.js'

/** 平台浏览器打开（best-effort；失败静默——授权 URL 已由调用方另行展示）。 */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] as const
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const
    : ['xdg-open', [url]] as const
  const child = execFile(cmd, [...args], { windowsHide: true }, () => { /* 打开失败无害 */ })
  child.on('error', () => { /* 无 xdg-open 等环境 */ })
  child.unref()
}

export interface OAuthLoginResult {
  ok: boolean
  message: string
}

/**
 * 跑一次 OAuth 登录。调用方负责展示 message（TUI 静态行 / CLI stdout）。
 * @param onUrl - 收到授权 URL 时调用（开浏览器 + 兜底展示）。
 */
export async function runOAuthLogin(
  providerName: string,
  onUrl: (url: string) => void,
): Promise<OAuthLoginResult> {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) {
    return { ok: false, message: `provider "${providerName}" 未配置——先 /connect 或 rivet config setup ${providerName} 添加` }
  }
  if (provider.auth?.type !== 'oauth') {
    return { ok: false, message: `"${providerName}" 不是 OAuth 型 provider（API key 走 /connect 或 rivet config set-key ${providerName}）` }
  }
  const auth = createOAuthLoginAuth(provider.auth.provider, onUrl)
  try {
    if (auth.isAuthenticated()) {
      return { ok: true, message: `${providerName} 已登录（token 仍有效），无需重复登录` }
    }
    await auth.authenticate()
    return { ok: true, message: `${providerName} 登录成功——token 已落盘，到期自动续期` }
  } catch (err) {
    return { ok: false, message: `登录失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    auth.dispose()
  }
}
