import { z } from 'zod'
import { mcpOAuthConfigSchema } from './oauth/types.js'

export const mcpToolPolicySchema = z.object({
  capability: z.enum(['read', 'write', 'execute', 'network']),
  requireApproval: z.literal(true).optional(),
})

export const mcpServerPolicySchema = z.object({
  /** Keys are original MCP tool names, before rivet prefixes them. */
  tools: z.record(mcpToolPolicySchema).default({}),
})

/** Transport hint — explicit opt-in for transport selection on url-based servers.
 *  `streamableHttp` (default when absent): use Streamable HTTP transport (post-2025-03-26 spec).
 *  `sse`: force legacy SSE transport (pre-2025 spec, deprecated but still in wide use).
 *  Ignored for stdio servers. */
export const transportHintSchema = z.enum(['streamableHttp', 'sse']).optional()

/** 子 Agent 派发的工作区策略（issue #147）——天枢侧对 MCP 工具参数的处置口径。 */
export const subAgentWorkspacePolicySchema = z.enum(['reuse-session', 'isolated', 'no-project', 'off'])

/**
 * server 级工作区声明（issue #147）：告诉天枢「这个 server 的哪个参数是工作区路径」。
 * 未声明的 server 一律不干预——不改写参数、也不加明示行，保持生态中立。
 */
export const mcpServerWorkspaceSchema = z.object({
  /** 工作区路径参数名（tianshu-mcp 为 'projectPath'）。 */
  arg: z.string().min(1),
  /** agent 选择参数名（可选，用于无项目模式判定）。 */
  agentArg: z.string().optional(),
  /** 支持「省略工作区参数 = 无项目模式」的 agent 取值（如 ['zcode']）。 */
  noProjectAgents: z.array(z.string()).optional(),
  /** 结果回执：meta 块标记与其中的路径字段名（可选，用于明示对方实际工作区）。 */
  metaMarker: z.string().optional(),
  pathField: z.string().optional(),
})

export const mcpServerConfigSchema = z.object({
  // stdio fields
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  /** 工作区参数声明（issue #147）——未声明则天枢不改写该 server 的调用参数。 */
  workspace: mcpServerWorkspaceSchema.optional(),
  // remote fields
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  /** Explicit transport selection (url-based servers). When unset, Streamable HTTP is
   *  preferred. Set to 'sse' to force legacy SSE transport. */
  transportHint: transportHintSchema,
  /** OAuth-based authentication for this server.
   *  When set, env/headers secrets are obtained via OAuth flow instead of manual entry. */
  auth: mcpOAuthConfigSchema.optional(),
  /** Missing tool policies are treated as unknown and require confirmation. */
  policy: mcpServerPolicySchema.optional(),
  // shared
  disabled: z.boolean().optional(),
}).refine(
  (v) => {
    const hasCommand = 'command' in v && v.command
    const hasUrl = 'url' in v && v.url
    return (hasCommand && !hasUrl) || (!hasCommand && hasUrl)
  },
  { message: 'MCP server must have either "command" (stdio) or "url" (SSE/Streamable HTTP), but not both' },
)

export const mcpHealthCheckConfigSchema = z.object({
  /** Health check interval in milliseconds (default: 60000 = 1 minute) */
  intervalMs: z.number().int().positive().optional(),
  /** Health check timeout in milliseconds (default: 10000 = 10 seconds) */
  timeoutMs: z.number().int().positive().optional(),
  /** Number of consecutive failures before marking degraded (default: 3) */
  failureThreshold: z.number().int().positive().optional(),
  /** Base delay for exponential backoff in milliseconds (default: 5000 = 5 seconds) */
  retryBackoffBaseMs: z.number().int().positive().optional(),
  /** Maximum number of retry attempts (default: 10) */
  maxRetries: z.number().int().positive().optional(),
})

export const mcpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * 子 Agent 派发工作区策略（issue #147）。缺省按 `reuse-session` 处理
   * （消费侧 readSubAgentWorkspacePolicy 兜底，避免与 DEFAULT_CONFIG 形成
   * 两个默认值来源）。`reuse-session` = 仅在模型**未给**工作区参数时注入当前
   * 会话 cwd，绝不覆写显式值——「可预期」优先于「自动化」。`off` = 完全不干预
   * （与改造前逐字节一致）。仅对声明了 workspace 的 server 生效。
   */
  subAgentWorkspace: subAgentWorkspacePolicySchema.optional(),
  /** Health check configuration for MCP servers (default: enabled with 60s interval) */
  healthCheck: mcpHealthCheckConfigSchema.optional(),
})

export type SubAgentWorkspacePolicy = z.infer<typeof subAgentWorkspacePolicySchema>
export type McpServerWorkspaceDeclaration = z.infer<typeof mcpServerWorkspaceSchema>

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>
export type McpConfig = z.infer<typeof mcpConfigSchema>
export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>
export type McpHealthCheckConfig = z.infer<typeof mcpHealthCheckConfigSchema>
