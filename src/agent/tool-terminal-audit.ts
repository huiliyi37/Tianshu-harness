import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import { recordTraceEvent } from './trace-store.js'
import type { ToolPipelineDeps, ToolExecResult } from './tool-pipeline.js'
import type { AgentCallbacks } from './loop-types.js'
import { runtimeObservation } from '../utils/runtime-provenance.js'
import { OfficialError } from '../models/official-contract.js'
type ToolUse = { id: string; name: string; input: Record<string, unknown>; argsTruncated?: boolean }

/**
 * Unconditional tool-result trace — always writes (no sampling gate). This is the
 * primary diagnostic log for TUI rendering-loss bugs. Every tool result passing
 * through the pipeline is recorded BEFORE the onToolResult callback.
 *
 * Log path: ~/.rivet/sessions/<project-slug>/<sessionId>/tool-result-trace.jsonl
 * On Windows: %LOCALAPPDATA%\.rivet\sessions\<project-slug>\<sessionId>\tool-result-trace.jsonl
 *
 * Each line is JSON with: { ts, id, name, isError, contentLen, source }
 *   source: "pipeline" = emitted just before callbacks.onToolResult
 *           "bridge"   = received by TUI bridge
 *           "tui"      = processed by TUI handleToolResult
 *
 * To find the log file on any platform:
 *   1. Look at the "Watching" header line printed at TUI startup
 *   2. Or check %LOCALAPPDATA%\.rivet\sessions\ on Windows
 *   3. Or run: dir %LOCALAPPDATA%\.rivet\sessions\ /s /b | findstr tool-result-trace
 */
async function emitToolResultTrace(input: {
  observation: ReturnType<typeof runtimeObservation>
  cwd: string
  sessionId?: string
  id: string
  name: string
  isError: boolean | undefined
  dispatched?: boolean
  contentLen: number; errorKind?: string; errorReason?: string
  source: 'pipeline' | 'bridge' | 'tui'
}): Promise<void> {
  try {
    const sessionDir = input.sessionId
      ? join(getSessionDir(input.cwd), input.sessionId)
      : join(getSessionDir(input.cwd), 'unknown')
    await mkdir(sessionDir, { recursive: true })
    const line = JSON.stringify({
      ...input.observation,
      ts: new Date().toISOString(),
      id: input.id,
      name: input.name,
      isError: input.isError,
      contentLen: input.contentLen,
      source: input.source, errorKind: input.errorKind, errorReason: input.errorReason, dispatched: input.dispatched,
    })
    await appendFile(join(sessionDir, 'tool-result-trace.jsonl'), `${line}\n`, 'utf8')
  } catch {
    // Diagnostics must never affect tool execution or pollute model-visible output.
  }
}

export async function withToolTerminalAudit(
  tu: { id: string; name: string; input: Record<string, unknown>; argsTruncated?: boolean },
  deps: ToolPipelineDeps, callbacks: AgentCallbacks, turn: number, checkpointAlreadyCreated: boolean,
  run: (tu: ToolUse, deps: ToolPipelineDeps, callbacks: AgentCallbacks, turn: number, checkpoint: boolean) => Promise<ToolExecResult>,
): Promise<ToolExecResult> {
  let terminalExtras: unknown[] = []
  let settled = false, dispatched = false
  const startedAt = Date.now()
  const observation = runtimeObservation()
  const wrappedDeps: ToolPipelineDeps = { ...deps, onToolExecutionStart: () => { dispatched = true; deps.onToolExecutionStart?.() } }
  const wrapped: AgentCallbacks = { ...callbacks, onToolResult: (id, name, content, isError, ...rest) => {
    if (!settled && isError === undefined) callbacks.onToolResult(id, name, content, isError, ...rest)
    else if (!settled) terminalExtras = rest
  } }
  let result: ToolExecResult
  let officialFailure: OfficialError | undefined
  try { result = await run(tu, wrappedDeps, wrapped, turn, checkpointAlreadyCreated) }
  catch (error) {
    if (error instanceof OfficialError) officialFailure = error
    const interrupted = dispatched ? '未确认完成，查询已有执行和文件状态后再决定后续动作。' : '本次工具主体未执行；保留已有准备记录，核对后再决定后续动作。'
    result = { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: error instanceof Error && error.name === 'AbortError' ? `Tool ${tu.name} interrupted; ${interrupted}` : String(error), is_error: true }, traceStore: deps.traceStore, importGraph: deps.importGraph, lastConflictCheckCount: deps.lastConflictCheckCount, checkpointCreated: checkpointAlreadyCreated, latestRisk: deps.latestRisk, errorKind: /timed out/.test(String(error)) ? 'timeout' : 'unknown' }
  }
  settled = true
  const block = result.toolResult
  const content = block.type === 'tool_result' && typeof block.content === 'string' ? block.content : ''
  const isError = block.type === 'tool_result' && !!block.is_error
  const prior = result.traceStore.events.find(event => event.id === tu.id)
  result.traceStore = recordTraceEvent({ ...result.traceStore, events: result.traceStore.events.filter(event => event.id !== tu.id) }, {
    ...prior, id: tu.id, terminal: true, dispatched, turn, kind: 'tool', name: tu.name,
    status: isError ? dispatched ? 'failed' : 'blocked' : 'passed', startedAt,
    endedAt: Date.now(), durationMs: Date.now() - startedAt, summary: prior?.summary ?? content.slice(0, 120),
  })
  await emitToolResultTrace({ observation, cwd: deps.cwd, sessionId: deps.sessionId, id: tu.id, name: tu.name, isError, contentLen: content.length, source: 'pipeline', errorKind: result.errorKind, errorReason: result.errorReason, dispatched })
  callbacks.onToolResult(tu.id, tu.name, content, isError, ...(terminalExtras as [string?, string?, Parameters<AgentCallbacks['onToolResult']>[6]?]))
  if (officialFailure) throw officialFailure
  return result
}
