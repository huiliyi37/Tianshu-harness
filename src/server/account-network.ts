import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { resolveProxyForUrl, shouldBypassProxy, type ProxyResolverOptions } from '../tools/net/proxy-resolver.js'
import type { FetchLike } from '../auth/account.js'

const agents = new Map<string, ProxyAgent>()
const renewalAgents = new Map<string, Dispatcher>()
const direct = new Agent({ connectTimeout: 5000 })

/** Resolve persisted network settings when sending, so retry follows new settings. */
export function createAccountFetch(network: () => ProxyResolverOptions): FetchLike {
  return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const routing = network()
    const proxy = resolveProxyForUrl(url, routing)
    if (init?.method === 'POST' && new URL(url).pathname === '/functions/v1/tui-auth-refresh') {
      const key = proxy ?? ''
      let dispatcher = renewalAgents.get(key)
      if (!dispatcher) {
        dispatcher = proxy ? new ProxyAgent({ uri: proxy, connectTimeout: 5000 }) : new Agent({ connectTimeout: 5000 })
        renewalAgents.set(key, dispatcher)
      }
      return undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
    }
    if (!proxy) return shouldBypassProxy(new URL(url).hostname, routing.noProxy)
      ? undiciFetch(url, { ...init, dispatcher: direct } as Parameters<typeof undiciFetch>[1])
      : fetch(input, init)
    let dispatcher = agents.get(proxy)
    if (!dispatcher) {
      dispatcher = new ProxyAgent({ uri: proxy })
      agents.set(proxy, dispatcher)
    }
    return undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
  }) as FetchLike
}
