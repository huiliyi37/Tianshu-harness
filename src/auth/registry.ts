import { createManagedAccountAuth } from '../models/model-runtime.js'
import type { AuthProvider } from './types.js'
import { ApiKeyAuth } from './api-key.js'
import { OAuthAuth, type OAuthConfig } from './oauth-auth.js'
import { TokenStore } from './token-store.js'
import { skipCodexCliImport } from './codex-cli-auth.js'
import type { AuthConfig } from '../config/schema.js'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import type { ProviderNetwork } from '../api/provider-network.js'

const CODEX_OAUTH_CONFIG: OAuthConfig = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  authorizeBase: 'https://auth.openai.com/oauth/authorize',
  redirectPort: 1455,
}

/**
 * Create an AuthProvider from config.
 * @param authConfig - The auth config from provider config (optional for backward compat)
 * @param env - Environment variables (defaults to process.env)
 * @param legacyApiKey - Fallback: explicit apiKey from legacy config
 */
export function createAuthProvider(
  authConfig: AuthConfig | undefined,
  env: Record<string, string | undefined>,
  legacyApiKey?: string,
  network?: ProviderNetwork,
): AuthProvider {
  if (authConfig?.type === 'tianshu-account') return createManagedAccountAuth()
  if (!authConfig || authConfig.type === 'api-key') {
    const keyEnv = authConfig?.type === 'api-key' ? authConfig.keyEnv : undefined
    const key = (keyEnv ? env[keyEnv] : undefined) ?? legacyApiKey
    if (!key) {
      throw new Error(
        `No API key configured. Set apiKey in config or the ${keyEnv ?? 'API_KEY'} environment variable.`,
      )
    }
    return new ApiKeyAuth(key)
  }

  if (authConfig.type === 'oauth') {
    const oauthConfig = authConfig.provider === 'codex' ? CODEX_OAUTH_CONFIG : null
    if (!oauthConfig) {
      throw new Error(`Unknown OAuth provider: ${authConfig.provider}`)
    }
    return new OAuthAuth({ ...oauthConfig, network })
  }

  throw new Error(`Unknown auth type: ${(authConfig as { type: string }).type}`)
}

/**
 * 登录流程专用构造器：带 onUserCode 钩子（浏览器打开授权 URL）的 OAuthAuth。
 * 与 createAuthProvider 的运行时实例分开——登录是一次性用户动作，不进 agent 装配。
 * （背景：authenticate() 曾长期零生产调用，connect-flow 指引的 /login 是幽灵命令。）
 */
export function createOAuthLoginAuth(provider: string, onUserCode?: (url: string) => void, network?: ProviderNetwork): OAuthAuth {
  const base = provider === 'codex' ? CODEX_OAUTH_CONFIG : null
  if (!base) throw new Error(`Unknown OAuth provider: ${provider}`)
  return new OAuthAuth({ ...base, network, ...(onUserCode ? { onUserCode } : {}) })
}

/**
 * 登出 OAuth 型 provider：清掉本地 token store（codex 等），并立「不再从官方
 * CLI 导入」的抑制标记——否则 ~/.codex/auth.json 还在，下一次 loadWithImport
 * 会把刚登出的账号当场拉回来（登出永远无效）。用户重新走 PKCE 登录成功时
 * 标记摘除（oauth-auth authenticate()）。返回是否真的执行了清除。
 */
export function clearOAuthLogin(provider: string): boolean {
  if (provider !== 'codex') return false
  const authDir = join(rivetHome(), 'auth')
  new TokenStore(authDir, provider).clear()
  skipCodexCliImport(authDir)
  return true
}
