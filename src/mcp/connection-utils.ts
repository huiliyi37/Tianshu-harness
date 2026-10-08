import { classifyMcpError } from './failure-classifier.js'
import { getNetworkConfig } from '../config/manager.js'
import type { McpNetworkConfig } from './stdio-env.js'

/** network 配置读取失败（坏 config.json）不应阻断 MCP 连接——配置错误由
 *  配置加载自己的报错通道负责，这里降级为「无应用代理」。 */
export function readNetworkConfigSafe(): McpNetworkConfig | undefined {
  try {
    const net = getNetworkConfig()
    return { proxy: net.proxy || undefined, noProxy: net.noProxy || undefined }
  } catch {
    return undefined
  }
}
export function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export function formatConnectError(err: unknown, stderrTail: string, context?: { transport?: 'stdio' | 'remote' }): string {
  const base = err instanceof Error ? err.message : String(err)
  // 分类必须拿到 stderr——否则这里拼进去的是通用建议，而同一个 state 上的
  // errorHint 却是细分结果，两个字段对同一故障给出不同诊断。
  const classified = classifyMcpError(err, { ...context, stderr: stderrTail })
  const parts = [base]
  if (stderrTail) {
    const compact = stderrTail.replace(/\n+/g, ' | ').slice(0, 500)
    parts.push(`stderr: ${compact}`)
  }
  if (classified.suggestion) parts.push(classified.suggestion)
  return parts.join(' — ')
}
