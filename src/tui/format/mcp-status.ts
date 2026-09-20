/**
 * `/mcp`（裸）与 `/debug mcp` 共用的 MCP 状态文本。
 *
 * 从 `slash-commands.ts` 外提——那个文件的源码行数 ceiling 已顶死（加任何行都超），
 * 而本模块只做纯文本呈现、不依赖 slash 命令上下文，是最自然的接缝。
 */
import type { McpManager } from '../../mcp/manager.js'

/** MCP 状态文本。 */
export function mcpStatusText(mgr: McpManager | null | undefined): string {
  if (!mgr) return 'MCP not initialized (no servers configured or MCP disabled).'
  const states = mgr.getStates()
  const tools = mgr.getAllTools()
  const lines = [`MCP Status (${states.length} server(s), ${tools.length} tool(s)):`]
  for (const s of states) {
    const detail = s.status === 'connected'
      ? `connected — ${s.toolCount} tools`
      : s.status === 'error'
        ? `error: ${s.error}`
        : s.status
    lines.push(`  ${s.serverId}: ${detail}`)
  }

  // issue #215：待批准连接的 server 必须**可见**。连接级审批门在 spawn 之前拦下，
  // 未批时不连接、不暴露工具——如果这里不列出来，用户只会看到「服务器不见了」，
  // 既不知道它被拦了，也不知道该批谁。审批要看清「会跑什么命令」，所以列完整的
  // command + args（env 只列键名，值在 server-approval.ts 侧就已遮蔽）。
  const pending = mgr.getPendingApprovals()
  if (pending.length > 0) {
    lines.push(`\nAwaiting approval (${pending.length}) — /mcp approve <serverId> to connect:`)
    for (const p of pending) {
      const what = p.source === 'stdio'
        ? [p.command, ...(p.args ?? [])].filter(Boolean).join(' ')
        : (p.url ?? '(remote)')
      lines.push(`  ${p.serverId}: ${what}`)
      if (p.cwd) lines.push(`      cwd: ${p.cwd}`)
      if (p.envKeys.length > 0) lines.push(`      env: ${p.envKeys.join(', ')}`)
    }
  }

  if (tools.length > 0) {
    lines.push('Tools: ' + tools.map(t => t.definition.name).join(', '))
  }
  return lines.join('\n')
}
