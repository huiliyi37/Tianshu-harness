import type { Usage } from './api/types.js'
import type { AgentCallbacks, AgentLoop } from './agent/loop.js'
import { tapAgentCallbacks, type EventSink } from './agent/event-tap.js'
import { serializeEvent } from './stream-json.js'
import { redactText, redactValue } from './server/redact.js'

export interface HeadlessCliArgs {
  headless: boolean
  prompt?: string
  json: boolean
  streamJson: boolean
  goal?: string
  budget?: number
}

export interface HeadlessJsonOutput {
  success: boolean
  text: string
  usage?: Partial<Usage>
  error?: string
}

export interface HeadlessRunResult {
  exitCode: number
  stdout: string
  stderr?: string
  json?: HeadlessJsonOutput
}

export interface HeadlessAgent {
  run(prompt: string, callbacks: AgentCallbacks): Promise<void>
}

export interface HeadlessRunConfig {
  prompt: string
  json: boolean
  streamJson: boolean
  /** For the stream-json `system/init` + `result` envelopes. Optional so the
   *  existing text/json callers stay unchanged. */
  sessionId?: string
  model?: string
  /**
   * `--stream-events <path>` 的落点：把本次 run 镜像成与 TUI / sidecar attach
   * 同一 schema 的 `SessionEvent` 流。缺省 = 不接线（老调用方零改动）。
   */
  eventSink?: EventSink
  createAgent: () => Pick<AgentLoop, 'run'> | HeadlessAgent
}

export function parseCliArgs(args: string[]): HeadlessCliArgs {
  const printIndex = args.findIndex(arg => arg === '-p' || arg === '--print')
  const goalIndex = args.findIndex(arg => arg === '--goal')
  const json = args.includes('--json')
  const streamJson = args.includes('--stream-json')

  if (goalIndex >= 0) {
    const goal = args[goalIndex + 1]
    // 预算缺省在此**不定价**：解析层只回答"用户是否显式给了值"。缺省值由
    // goal 预算定价层决定（main.ts → agent/goal-budget.ts）——此前这里直接填
    // 100，会被定价层当成 explicitBudget 而短路成显式值，形状定价形同虚设。
    // 非法/非正值一并归为"没给"：NaN 会一路传到 maxTurns，而 turn-orchestrator
    // 的 `maxTurns > 0` 判据会把上限静默变成 Number.MAX_SAFE_INTEGER。
    const budgetIndex = args.indexOf('--budget')
    const parsedBudget = budgetIndex >= 0 ? parseInt(args[budgetIndex + 1]!, 10) : Number.NaN
    const budget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : undefined
    return { headless: true, prompt: undefined, json, streamJson, goal, budget }
  }

  if (printIndex === -1) return { headless: false, json, streamJson }

  const prompt = args[printIndex + 1]
  return { headless: true, prompt, json, streamJson }
}

export async function runHeadless(config: HeadlessRunConfig): Promise<HeadlessRunResult> {
  const agent = config.createAgent()
  const streamJson = config.streamJson
  let text = ''
  let usage: Partial<Usage> | undefined
  let error: string | undefined

  // 脱敏纪律与 sidecar/event-tap 同口径：stdout 进 CI 日志即成泄漏面。
  const emit = (ev: import('./stream-json.js').StreamJsonEvent) => process.stdout.write(serializeEvent(ev))

  // 回调集恒为**全量**，不再按 streamJson 二分成两套（2026-09-18 无头
  // --stream-events 0 字节事故的根因之一）：事件 tap 只在 inner **定义了**某个
  // 回调时才包装它（event-tap.ts 里 onPhaseChange / onDelegationActivity 都是条件
  // 挂载），所以"非 stream-json 就少定义几个"会让 --stream-events 的事件流随输出
  // 开关静默变薄——同一面审计镜换个开关就少两类事件。现在统一全量定义，stdout 侧
  // 仍由 streamJson 逐处 gate，输出字节不变。
  const base: AgentCallbacks = {
    onTextDelta: delta => {
      text += delta
      if (streamJson) emit({ type: 'text_delta', text: redactText(delta) })
    },
    onThinkingDelta: delta => { if (streamJson) emit({ type: 'thinking_delta', text: redactText(delta) }) },
    onToolUse: (id, name, input) => {
      if (streamJson) emit({ type: 'tool_use', id, name, input: redactValue(input) as Record<string, unknown> })
    },
    onToolResult: (id, name, result, isError) => {
      if (isError) error = result
      if (streamJson) emit({ type: 'tool_result', id, name, result: redactText(result), isError: isError ?? false })
    },
    onTurnComplete: (turnUsage, turnNumber, isFinal) => {
      usage = turnUsage
      if (streamJson) emit({ type: 'turn_complete', usage: turnUsage, turn: turnNumber, is_final: isFinal ?? false })
    },
    onPhaseChange: (phase, detail) => {
      if (streamJson) emit({ type: 'phase', phase, tool: detail?.tool, reason: detail?.reason })
    },
    onDelegationActivity: activity => {
      if (!streamJson) return
      emit({
        type: 'worker',
        work_order_id: activity.workOrderId,
        parent_tool_id: activity.parentToolId,
        status: activity.status,
        profile: activity.profile,
        authority: activity.authority,
        objective: activity.objective,
        progress_line: activity.progressLine ? redactText(activity.progressLine) : undefined,
        tool_use_count: activity.toolUseCount,
        token_count: activity.tokenCount,
        model: activity.model,
        failure_reason: activity.failureReason,
      })
    },
    onError: err => {
      error = err.message
      if (streamJson) emit({ type: 'error', error: redactText(err.message) })
    },
    onAbort: () => { error = 'Aborted' },
    onApprovalRequired: async () => false,
    // 事件面与 TUI 对齐：tap 只在 inner **定义了**回调时才投影对应的 SessionEvent，
    // 而 TUI 侧 bridge 定义了 checkpoint / domain_drift / intent_note
    // （src/tui/engine/bridge.ts），无头缺定义就会在 --stream-events 的文件里静默
    // 少掉这三类。三者都不改 stdout 契约——StreamJsonEvent 里没有对应信封，
    // 所以 stdout 字节与从前完全一致，受益的只有事件文件。
    //
    // 代价说明：onCheckpoint / onDomainDrift 是**免费**的（值在调用点已经算好，
    // 只有回调调用被 `?.` gate）；onIntentNote 是**门槛式**的——turn-intent.ts 里
    // `!input.onIntentNote` 直接早退，定义它会启用 buildIntentPreview 的本地计算
    //（纯内存、有 MAX_INTENT_NOTES 上限与指纹去重）。这正是 TUI 的行为，
    // 无头对齐它换来的是"agent 当时想往哪走"这一条审计信息。
    onCheckpoint: () => {},
    onDomainDrift: () => {},
    onIntentNote: () => {},
  }

  // tap 自身对 text/thinking/result 做脱敏（与 sidecar 同口径）并合并 delta，
  // 所以 sink 里落的是脱敏后的记录，不会把 stdout 的泄漏面挪进文件里。
  const tapped = config.eventSink ? tapAgentCallbacks(base, config.eventSink) : null
  const callbacks: AgentCallbacks = tapped ?? base

  if (streamJson) {
    emit({ type: 'system', subtype: 'init', session_id: config.sessionId ?? '', model: config.model ?? '', cwd: process.cwd() })
  }

  await agent.run(config.prompt, callbacks)

  // tap 把 text/thinking delta 合并到 4000 字符才落一笔；run 收尾时若还压着尾段，
  // 必须在调用方 close() sink **之前** flush——否则丢的正好是收尾那段文本。
  tapped?.flush()

  const success = !error
  if (streamJson) {
    emit({
      type: 'result',
      subtype: success ? 'success' : 'error',
      session_id: config.sessionId ?? '',
      is_error: !success,
      result: redactText(success ? text : (error ?? 'Unknown error')),
      ...(usage ? { usage } : {}),
    })
  }

  const payload: HeadlessJsonOutput = success
    ? { success: true, text, ...(usage ? { usage } : {}) }
    : { success: false, text, error: error ?? 'Unknown error' }

  const stdout = config.json ? JSON.stringify(payload) : streamJson ? '' : payload.text

  return {
    exitCode: success ? 0 : 1,
    stdout,
    // 失败必须有出口：非 JSON 模式下 stdout 只承载 payload.text，模型一个字
    // 没输出就失败时（provider 报错、鉴权失败、模型名非法）text 为空串，
    // error 又只存在于 payload.json——json 未开时整条错误信息就此蒸发，
    // 用户看到的是 exit 1 加全空输出。stderr 字段此前定义了却从未被写过。
    ...(success ? {} : { stderr: error ?? 'Unknown error' }),
    // streamJson 的终止态已由 result 信封承载——遗留 payload 一并输出会在同一条
    // NDJSON 流里出现两个 schema 的收尾（且无 type 字段），消费者按 type 分派
    // 会在最后一行拿到 undefined。
    json: config.json ? payload : undefined,
  }
}
