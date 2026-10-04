export type McpErrorClass =
  | 'config'
  | 'auth'
  | 'network'
  | 'protocol'
  /** stdio 子进程启动后立即退出，且 stderr 没留下可辨特征。 */
  | 'process'
  /** 同为「启动后立即退出」，但 stderr 指向子进程环境：PATH 不完整，npx 连 cmd.exe
   *  都 spawn 不起来（issue #149 的对照实验形态）。 */
  | 'process_env'
  /** 同为「启动后立即退出」，但 stderr 指向包获取失败：包名不存在，或 npm 缓存 /
   *  解包损坏（issue #77 的形态）。 */
  | 'process_install'
  | 'tool_error'

/**
 * 全部 class 的单一真相源。UI 据它判断「这个 class 有没有配套文案」——那份判据
 * 原先是一串字面量写在 McpSettings.tsx 里，新增 class 时漏改不会报错，只会静默
 * 退化成显示英文 suggestion（本地化悄悄失效）。
 */
export const MCP_ERROR_CLASSES: readonly McpErrorClass[] = [
  'config', 'auth', 'network', 'protocol', 'process', 'process_env', 'process_install', 'tool_error',
]

export interface ClassifiedMcpError {
  class: McpErrorClass
  retryable: boolean
  suggestion: string
}

export interface McpErrorContext {
  /** 'stdio' = 本地子进程；'remote' = url 型（Streamable HTTP / SSE）。 */
  transport?: 'stdio' | 'remote'
  /**
   * 子进程 stderr 尾部（仅 stdio 有）。分类器**必须**拿到它才算完整证据：
   * PATH 缺失 / 包不存在 / 缓存损坏三种根因在 err.message 上是同一句
   * `-32000: Connection closed`，唯一的区别就在 stderr 里。不给它，就只能
   * 回落到那句对用户没有任何行动价值的通用提示。
   */
  stderr?: string
}

/**
 * stdio 子进程「启动后立即退出」的细分。三种根因对用户是同一句报错，但下一步
 * 动作完全不同：
 *   - npx 要 spawn cmd.exe，PATH 里没有系统目录 → 这是环境/打包问题，用户改配置
 *     也修不好，应报 bug；
 *   - 包名打错或拉不下来 → 改 args 里的包名 / 换 registry / 清缓存；
 *   - 认不出来 → 老实说认不出来。**不编根因**：谎报比不报更坏，用户会照着错的
 *     方向修半天。
 */
function classifyStdioExit(stderr: string): ClassifiedMcpError {
  if (/spawn cmd ENOENT|is not recognized as an internal or external command/i.test(stderr)) {
    return {
      class: 'process_env',
      retryable: false,
      suggestion: 'The server failed to start because its child process could not find a system '
        + 'executable (typically `cmd.exe` — PATH lacks the system directories, so npx cannot run). '
        + 'This is an environment/packaging problem, not a config mistake: retrying will not help.',
    }
  }
  if (/E404|404 Not Found|is not in this registry/i.test(stderr)) {
    return {
      class: 'process_install',
      retryable: false,
      suggestion: 'The package could not be fetched — check the package name in `args` and that it '
        + 'exists on the configured registry.',
    }
  }
  if (/ENOTEMPTY|integrity checksum failed|tarball.*corrupt/i.test(stderr)) {
    return {
      class: 'process_install',
      retryable: false,
      suggestion: 'The package could not be unpacked — the npm cache looks damaged. Clear it '
        + '(`npm cache clean --force`) and retry.',
    }
  }
  return {
    class: 'process',
    retryable: false,
    suggestion: 'MCP server process exited right after start — check the command, its stderr log, and network/proxy settings.',
  }
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
  // 子进程启动后立刻退出——盲目重试无意义。根因有三种（环境 / 包获取 / 未知），
  // 唯一能把它们分开的证据是 stderr，故走 classifyStdioExit 细分。
  if (context?.transport === 'stdio' && /connection closed|-32000/i.test(msg)) {
    return classifyStdioExit(context.stderr ?? '')
  }

  // Auth errors
  if (/401|403|permission denied|unauthorized|forbidden|scope|oauth|api key/i.test(msg)) {
    return { class: 'auth', retryable: false, suggestion: 'Check API key or OAuth configuration for this MCP server.' }
  }

  // stdio 连接超时：本地管道不存在"网络"。子进程被拉起但始终没有完成 MCP 握手
  // （initialize 已发出、timeoutMs 内无协议有效响应）。实测最常见根因：服务器实现了
  // 传输层但应答不是合法 JSON-RPC（例如缺 `jsonrpc:"2.0"` 字段时客户端静默丢弃，
  // 表现就是干等到超时）；其次是首次冷启动（npx 拉包）超出 timeoutMs。两者重试都
  // 无济于事——与 remote 的瞬时网络超时严格分开（后者才 retryable）。
  if (context?.transport === 'stdio' && /mcp connect .+timed out/i.test(msg)) {
    return {
      class: 'protocol',
      retryable: false,
      suggestion: 'The server process started but never completed the MCP handshake (initialize '
        + 'sent, no protocol-valid response arrived before the timeout). Common causes: the server '
        + 'does not answer with valid JSON-RPC (every response must carry the `jsonrpc:"2.0"` field — '
        + 'malformed responses are silently dropped), or the first start is slow (e.g. npx fetching '
        + 'packages) and exceeds `mcp.timeoutMs`. Retrying will not fix either — fix the server '
        + 'implementation or raise the timeout.',
    }
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
