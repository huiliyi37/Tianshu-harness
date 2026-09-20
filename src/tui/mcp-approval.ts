/**
 * `/mcp approve|deny <serverId>` 的实现（issue #215）。
 *
 * 从 `slash-commands.ts` 外提——那个文件的源码行数 ceiling 已顶死，而这段逻辑
 * 只依赖 McpManager，与 slash 命令上下文无关。
 */
import type { McpManager } from '../mcp/manager.js'

export interface McpApprovalCommandResult {
  text: string
  isError?: boolean
}

/**
 * 批准 / 拒绝一个待连接的 MCP server，返回要展示给用户的文本。
 *
 * 批准会持久化「该 command+args 指纹」，之后不再重复询问；拒绝会记下拒绝态并断开
 * 已有连接。两者都由 manager 侧落盘（`server-approval.ts`）。
 */
export async function runMcpApprovalCommand(
  mgr: McpManager | null | undefined,
  action: 'approve' | 'deny',
  serverId: string,
): Promise<McpApprovalCommandResult> {
  if (!mgr) return { text: 'MCP manager not initialized.', isError: true }
  try {
    if (action === 'approve') {
      const tools = await mgr.approveServerConnection(serverId)
      return { text: `✓ ${serverId} approved — connected with ${tools.length} tool(s).` }
    }
    await mgr.denyServerConnection(serverId)
    return { text: `${serverId} denied — it will not connect until you approve it.` }
  } catch (err) {
    return { text: `Approval failed: ${(err as Error).message}`, isError: true }
  }
}
