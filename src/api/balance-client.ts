/**
 * DeepSeek 余额查询客户端。
 *
 * 官方 API：GET https://api.deepseek.com/user/balance（Authorization: Bearer）
 * 返回 { is_available, balance_infos[]: { currency, total_balance } }。
 *
 * 仅 DeepSeek 官方端点支持此接口（其他 OpenAI 兼容 provider 无此 API）。
 * 非 DeepSeek provider 返回 null，调用方静默处理。
 */
import { fetchWithTimeout } from './fetch-timeout.js'

export interface BalanceInfo {
  currency: string
  totalBalance: string
}

export interface BalanceResult {
  isAvailable: boolean
  balances: BalanceInfo[]
}

/** DeepSeek 官方 baseUrl 域名特征——用于判断 provider 是否为 DeepSeek 官方端点。 */
function isDeepSeekProvider(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  return /api\.deepseek\.com/i.test(baseUrl)
}

/**
 * 余额端点挂在账号域根上（`api.deepseek.com/user/balance`），不在 OpenAI 兼容
 * 层下。`/v1`、`/beta`、`/anthropic` 都只是聊天接口的兼容别名——preset 里的
 * baseUrl 带 `/v1`，直接拼接会得到 `/v1/user/balance`。
 */
export function balanceEndpoint(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/(?:v1|beta|anthropic)$/i, '')
  return `${root}/user/balance`
}

/**
 * 查询 DeepSeek 账户余额。非 DeepSeek provider 返回 null。
 * 10 秒超时；网络错误/API 错误返回 null（静默，不阻断 UI）。
 * dispatcher：issue #545——此前调用方不传 dispatcher，余额查询直连绕过
 * network.proxy 与 provider 级代理；传入 providerDispatcher 的产物即走代理。
 */
export async function queryDeepSeekBalance(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  signal?: AbortSignal,
  dispatcher?: unknown,
): Promise<BalanceResult | null> {
  if (!apiKey || !isDeepSeekProvider(baseUrl)) return null
  const url = balanceEndpoint(baseUrl!)
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    }, 10_000, dispatcher)
    if (!res.ok) return null
    const data = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{ currency?: string; total_balance?: string }>
    }
    return {
      isAvailable: data.is_available ?? false,
      balances: (data.balance_infos ?? []).map((b) => ({
        currency: b.currency ?? 'CNY',
        totalBalance: b.total_balance ?? '0',
      })),
    }
  } catch {
    return null
  }
}
