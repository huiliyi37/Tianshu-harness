export type McpErrorClass = 'config' | 'auth' | 'network' | 'protocol' | 'process' | 'tool_error'

export interface ClassifiedMcpError {
  class: McpErrorClass
  retryable: boolean
  suggestion: string
}

export interface McpErrorContext {
  /** 'stdio' = 本地子进程；'remote' = url 型（Streamable HTTP / SSE）。 */
  transport?: 'stdio' | 'remote'
}

export function classifyMcpError(error: unknown, context?: McpErrorContext): ClassifiedMcpError {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  const lower = msg.toLowerCase()

  // Config errors
  if (/enoent|invalid json|bad command|spawn.*enoent|cannot find module.*config/i.test(msg)) {
    return { class: 'config', retryable: false, suggestion: 'Check MCP server config: command path, args, and environment.' }
  }

  // Process lifecycle (stdio): SDK 在子进程管道关闭时把在途请求 reject 成
  // "MCP error -32000: Connection closed"。对 stdio 而言这不是网络瞬断，而是
  // 子进程启动后立刻退出（命令不可执行 / 依赖损坏 / npx 拉包失败）——盲目重试
  // 无意义，先看子进程 stderr 与命令/网络配置（issue #72 的现场形态）。
  if (context?.transport === 'stdio' && /connection closed|-32000/i.test(msg)) {
    return {
      class: 'process',
      retryable: false,
      suggestion: 'MCP server process exited right after start — check the command, its stderr log, and network/proxy settings.',
    }
  }

  // Auth errors
  if (/401|403|permission denied|unauthorized|forbidden|scope|oauth|api key/i.test(msg)) {
    return { class: 'auth', retryable: false, suggestion: 'Check API key or OAuth configuration for this MCP server.' }
  }

  // Network errors
  if (/econnrefused|etimedout|timed out|socket hang up|econnreset|fetch failed|transport.*close|disconnected|connection closed|-32000/i.test(msg)) {
    return { class: 'network', retryable: true, suggestion: 'Transient network error. Retry may succeed.' }
  }

  // Protocol errors
  if (/invalidparams|invalid params|capability mismatch|malformed|parse error|json-rpc/i.test(msg)) {
    return { class: 'protocol', retryable: false, suggestion: 'Check tool input schema against MCP server definition.' }
  }

  // Default: tool error
  return { class: 'tool_error', retryable: false, suggestion: 'Read the error output for details.' }
}
