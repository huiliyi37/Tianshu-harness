/**
 * MCP stdio 子进程的环境组装。
 *
 * MCP SDK 的 StdioClientTransport 只继承一份白名单环境变量（PATH / HOME /
 * TEMP / …）——HTTPS_PROXY 一类代理变量不在其中。结果是：终端里 npx 能走代理
 * 拉包，GUI 启动的 sidecar 里的 npx 完全看不到代理；拉包失败表现为子进程秒退
 * → `MCP error -32000: Connection closed`（issue #72）。
 *
 * 这里对称 whisper 的 buildWhisperFetchChildEnv（src/server/speech-routes.ts）：
 * 把设置页 network.proxy / noProxy 注入标准代理变量。显式设置过的键一律不覆盖
 * ——优先级：server 自己的 env > 应用设置。
 */

import { buildStdioEnvWithNodePath } from '../platform/resolve-node-cli.js'

export interface McpNetworkConfig {
  proxy?: string
  noProxy?: string
}

/**
 * 计算需要补充的代理键（不覆盖 `existing` 中已有的代理变量）。
 * 对称 whisper 的判定：只要 HTTPS_PROXY / HTTP_PROXY（含小写）任一已存在，
 * 就不再写入应用设置里的 proxy——用户显式配置优先。
 */
export function buildMcpProxyEnv(
  existing: Record<string, string | undefined> | undefined,
  network: McpNetworkConfig | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  const configured = network?.proxy?.trim()
  if (configured) {
    const hasHttps = !!(existing?.HTTPS_PROXY?.trim() || existing?.https_proxy?.trim())
    const hasHttp = !!(existing?.HTTP_PROXY?.trim() || existing?.http_proxy?.trim())
    if (!hasHttps && !hasHttp) {
      out.HTTPS_PROXY = configured
      out.HTTP_PROXY = configured
    }
  }
  const noProxy = network?.noProxy?.trim()
  if (noProxy && !existing?.NO_PROXY?.trim() && !existing?.no_proxy?.trim()) {
    out.NO_PROXY = noProxy
  }
  return out
}

/**
 * 组装 stdio 子进程最终 env：
 *   server 静态 env + 动态（OAuth）env + 应用代理 + Node 目录 PATH 注入。
 * 优先级：static > dynamic > network（应用设置）。
 */
export function buildStdioChildEnv(
  staticEnv: Record<string, string> | undefined,
  dynamicEnv: Record<string, string>,
  network: McpNetworkConfig | undefined,
  deps: {
    execPath?: string
    platform?: NodeJS.Platform
    existsSync?: (path: string) => boolean
    getDefaultEnvironment?: () => Record<string, string>
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...(staticEnv ?? {}), ...dynamicEnv }
  const proxyEnv = buildMcpProxyEnv(merged, network)
  return buildStdioEnvWithNodePath({ ...proxyEnv, ...merged }, deps)
}
