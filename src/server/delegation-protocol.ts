/**
 * Client tool-delegation protocol (E4) — transport-agnostic types.
 *
 * Sidecar hangs a `client-executable` tool's final landing step, pushes a
 * `tool_delegate` event, and waits for POST .../delegate/:rid/result.
 * Fork W2 (IPC) and the VS Code extension (HTTP/SSE) share this shape.
 *
 * Fail-back contract: resolve(null) means "no client / timeout / capability
 * miss" → tool-pipeline executes locally. Agent never sees the delegation
 * mechanism. Client reject is a normal tool_result with isError=false.
 */

export const TIANSHU_PROTOCOL_VERSION = 1
export const TIANSHU_PROTOCOL_HEADER = 'x-tianshu-protocol'

/** v1 whitelist — only these kinds may be delegated. */
export type DelegateKind = 'apply_edit' | 'terminal_exec'

export const DELEGATE_KINDS: readonly DelegateKind[] = ['apply_edit', 'terminal_exec']

export const DELEGATE_TIMEOUT_MS: Record<DelegateKind, number> = {
  /** CodeLens 人审窗口。超时 silent → fail-back 内核本地写。插件不再 15s 自动接受。 */
  apply_edit: 5 * 60_000,
  terminal_exec: 5 * 60_000,
}

/** Capability TTL — client must heartbeat before this elapses. */
export const DELEGATE_CAPABILITY_TTL_MS = 60_000

/** E4a — disk-evidence self-heal for apply_edit (issue #61). */
export const DELEGATE_DISK_PROBE_DEFAULT_MS = 1_500

/** Poll interval while an apply_edit delegation is unanswered (tests shorten it). */
export function delegateDiskProbeIntervalMs(): number {
  const v = Number.parseInt(process.env.RIVET_DELEGATE_PROBE_MS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : DELEGATE_DISK_PROBE_DEFAULT_MS
}

/** Default on; set RIVET_DELEGATE_DISK_PROBE=0 or false to disable the probe. */
export function isDelegateDiskProbeEnabled(): boolean {
  const v = process.env.RIVET_DELEGATE_DISK_PROBE
  return v !== '0' && v !== 'false'
}

export interface ApplyEditPayload {
  path: string
  oldContent: string
  newContent: string
}

export interface TerminalExecPayload {
  command: string
  cwd: string
}

export type DelegatePayload = ApplyEditPayload | TerminalExecPayload

/**
 * Result shape aligned with tool_result. Reject is NOT an execution failure:
 * content explains why, isError stays false so the agent treats it as
 * "user rejected this edit" rather than "edit errored".
 */
export interface DelegateResult {
  content: string
  isError?: boolean
  uiContent?: string
  /** apply_edit only — rejected means user dismissed the edit (isError stays false). */
  status?: 'ok' | 'rejected'
}

export interface ToolDelegateEventData {
  requestId: string
  kind: DelegateKind
  payload: DelegatePayload
  /** Wall-clock deadline hint for the client (ms since epoch). */
  deadlineMs: number
}

export function isDelegateKind(v: unknown): v is DelegateKind {
  return v === 'apply_edit' || v === 'terminal_exec'
}

export function parseDelegateKinds(raw: unknown): DelegateKind[] {
  if (!Array.isArray(raw)) return []
  const out: DelegateKind[] = []
  for (const item of raw) {
    if (isDelegateKind(item) && !out.includes(item)) out.push(item)
  }
  return out
}
