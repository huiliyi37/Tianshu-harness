/**
 * E4 helpers — call onClientDelegate before local landing.
 * Returns the client result when handled; null means fail-back to local.
 */

import { relative } from 'node:path'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import type { ToolCallParams, ToolResult } from './types.js'

export type ClientDelegateResult = {
  content: string
  isError?: boolean
  uiContent?: string
  status?: 'ok' | 'rejected'
}

export async function tryClientApplyEdit(
  params: ToolCallParams,
  path: string,
  oldContent: string,
  newContent: string,
): Promise<ClientDelegateResult | null> {
  if (!params.onClientDelegate) return null
  return params.onClientDelegate('apply_edit', { path, oldContent, newContent })
}

export async function tryClientTerminalExec(
  params: ToolCallParams,
  command: string,
  cwd: string,
): Promise<ClientDelegateResult | null> {
  if (!params.onClientDelegate) return null
  return params.onClientDelegate('terminal_exec', { command, cwd })
}

/**
 * Prefer client apply_edit; on null, write locally.
 * `newContent` is the exact byte string that would have been written to disk.
 *
 * Returns a discriminanted union — consumers MUST branch on `kind` so a
 * future refactor that removes the local write path is caught by TypeScript.
 */
export async function landingWriteFile(
  params: ToolCallParams,
  absPath: string,
  oldContent: string,
  newContent: string,
): Promise<{ kind: 'delegated'; delegated: ClientDelegateResult } | { kind: 'wroteLocal' }> {
  const rel = relative(params.cwd, absPath).split('\\').join('/')
  const delegated = await tryClientApplyEdit(params, rel, oldContent, newContent)
  if (delegated) return { kind: 'delegated', delegated }
  await writeFileAtomicAsync(absPath, newContent, { preserveMode: true })
  return { kind: 'wroteLocal' }
}

export function delegatedToToolResult(d: ClientDelegateResult): ToolResult {
  return {
    content: d.content,
    isError: d.isError === true,
    uiContent: d.uiContent,
  }
}

export function isDelegateRejected(d: ClientDelegateResult): boolean {
  return d.status === 'rejected'
}
