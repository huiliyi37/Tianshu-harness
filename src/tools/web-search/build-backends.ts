import type { Config } from '../../config/schema.js'
import type { ProxyResolverOptions } from '../net/proxy-resolver.js'
import type { SearchBackend, SearchFetch } from './types.js'
import { DuckDuckGoBackend } from './duckduckgo.js'
import { BingBackend } from './bing.js'
import { BraveBackend } from './brave.js'
import { TavilyBackend } from './tavily.js'
import { BochaBackend } from './bocha.js'
import { createProxyAwareFetch } from './proxy-fetch.js'
import { readSecret } from '../../config/secrets-store.js'

export interface BuildBackendsDeps {
  fetch?: SearchFetch
  env?: NodeJS.ProcessEnv
  /**
   * Proxy resolution options sourced from `config.network.{proxy,noProxy}`.
   * When present, the production fetch is wrapped via `createProxyAwareFetch`
   * so search traffic honors the same proxy as web_fetch (config.proxy > env >
   * direct). Injected test fetches are passed through untouched — they model
   * synthetic responses and don't go to the network.
   */
  proxy?: ProxyResolverOptions
}

/**
 * Resolve a search backend's API key using the same fallback chain as
 * `api/factory.ts:tryResolveCredentialKey` for providers:
 *   0. keyRef → secrets.json（AES-256-GCM 密文；config.json 只存指针）
 *   1. inline config value `search.<backend>ApiKey`（运行时物化值 / 旧版明文配置）
 *   2. explicit env var named by `search.<backend>ApiKeyEnv`
 *   3. standard `<BACKEND>_API_KEY` env var
 *
 * Lets users configure search keys either via the desktop UI (落 secrets.json，
 * config.json 留 keyRef 指针) or via environment variables (CLI/server), mirroring
 * how provider API keys work. issue #220：搜索 key 不再明文落 config.json。
 */
export function resolveSearchKey(
  config: Config,
  env: NodeJS.ProcessEnv,
  backend: 'bocha' | 'brave' | 'tavily',
): string | undefined {
  const s = config.search
  // 0. keyRef 指针 → secrets.json。与 provider 的 tryResolveCredentialKey 同序
  //    （keyRef 优先）。loadConfig 已把 secret 物化进 <backend>ApiKey，故对经
  //    loadConfig 的配置这是等价路径；对未物化的 Config（测试/直接构造）则是唯一来源。
  const keyRef = s[`${backend}KeyRef` as keyof typeof s]
  if (typeof keyRef === 'string' && keyRef.length > 0) {
    const secret = readSecret(keyRef)
    if (secret) return secret
  }
  // 1. inline config value（运行时物化值，与 provider.apiKey 同构）
  const inlineKey = s[`${backend}ApiKey` as keyof typeof s]
  if (typeof inlineKey === 'string' && inlineKey.length > 0) return inlineKey
  // 2. 显式 env 变量名（apiKeyEnv 字段，如 BRAVE_API_KEY）
  const envName = s[`${backend}ApiKeyEnv` as keyof typeof s]
  if (typeof envName === 'string' && envName.length > 0) {
    const v = env[envName]
    if (v) return v
  }
  // 3. 标准变量名回退（apiKeyEnv 丢失/手动编辑场景）
  return env[`${backend.toUpperCase()}_API_KEY`]
}

/**
 * Construct the ordered search backend chain from config. API-key backends are
 * always constructed (so their availability is decided at call time by
 * `isAvailable()`), letting a listed-but-unconfigured backend fall through to
 * the next entry. Unknown backend names are skipped. If nothing valid is
 * constructed, DuckDuckGo is added as a zero-config safety net.
 */
export function buildSearchBackends(config: Config, deps: BuildBackendsDeps = {}): SearchBackend[] {
  // Injected test fetches stay as-is; the real global fetch becomes proxy-aware
  // (config.network.proxy > HTTPS_PROXY/HTTP_PROXY env > direct) and is body-size
  // capped via boundedSearchFetch inside createProxyAwareFetch.
  const fetchImpl = deps.fetch ?? createProxyAwareFetch(deps.proxy)
  const env = deps.env ?? process.env

  const backends: SearchBackend[] = []
  for (const name of config.search.backends) {
    switch (name) {
      case 'bing':
        backends.push(new BingBackend(fetchImpl))
        break
      case 'duckduckgo':
        backends.push(new DuckDuckGoBackend(fetchImpl))
        break
      case 'brave':
        backends.push(new BraveBackend(fetchImpl, resolveSearchKey(config, env, 'brave'), config.search.region))
        break
      case 'tavily':
        backends.push(new TavilyBackend(fetchImpl, resolveSearchKey(config, env, 'tavily')))
        break
      case 'bocha':
        // 国内直连 AI 搜索（api.bochaai.com）——Tavily 在国内的替代
        backends.push(new BochaBackend(fetchImpl, resolveSearchKey(config, env, 'bocha')))
        break
      default:
        // Unknown backend name — skip rather than fail the whole chain.
        break
    }
  }

  if (backends.length === 0) {
    backends.push(new DuckDuckGoBackend(fetchImpl))
  }
  return backends
}
