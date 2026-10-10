/**
 * `@tianshu` 聊天 participant：聊天输入（不带 @ 前缀也可）直接路由到 sidecar 的
 * agent 运行时，回答经该会话的 SSE 订阅流回聊天视图。
 *
 * 一段 chat 会话 ↔ 一个 sidecar 会话；prompt 经 queue/prompt 双通道发送（busy 排队、
 * idle 回退，与桌面端「输入不丢」同一约定）。
 * @module
 */
import * as vscode from 'vscode'
import type { SidecarClient } from '../sidecar/client.js'
import type { SessionEvent } from '../sidecar/protocol.js'
import { interpretSessionEvent, type ChatTurnEvent } from './turn-events.js'
import { toolStartPart, toolDonePart } from './chat-parts.js'
import { SubscriptionGate } from './subscription-gate.js'
import { TurnTimeout } from './turn-timeout.js'
import { PermissionBridge } from './permission-bridge.js'
import { MODEL_ID } from './model-provider.js'
import type { ChatHumanInteraction } from './human-interaction.js'

/** participant id；必须与 package.json 的 contributes.chatParticipants[].id 一致。 */
const PARTICIPANT_ID = 'tianshu.default'

/** 单轮时间上限：静默的 sidecar 不应永远占住聊天视图。 */
const TURN_TIMEOUT_MS = 10 * 60 * 1000

/** 进行中的一轮：其会话、回复接收端、以及 dispatch 调用的收束钩子。 */
interface ActiveTurn {
  sessionId: string
  stream: vscode.ChatResponseStream
  /** 是否有助手文本到达过视图（静默轮结束时据此说明）。 */
  sawText: boolean
  /** 静默超时守卫：审批挂起期间暂停（见 turn-timeout.ts）。 */
  timeout: TurnTimeout
  settle(event: ChatTurnEvent): void
}

interface RequestOwnership {
  sessionId?: string
  abort?: () => void
}

/**
 * 注册 `@tianshu` participant，把 sidecar 事件桥进聊天视图。
 *
 * prompt 串行：上一条还在流式返回时，第二条请求被明确拒绝而不是交错——一个
 * sidecar 会话承载一条有序对话。
 */
export class TianshuChatParticipant implements vscode.Disposable {
  private readonly participant: vscode.ChatParticipant
  private activeTurn: ActiveTurn | undefined
  private requestOwner: RequestOwnership | undefined
  private cancelRequest: (() => void) | undefined
  private sessionId: string | undefined
  /** 单例订阅的代际守卫（见 subscription-gate.ts）。 */
  private readonly gate = new SubscriptionGate()
  /** chat UI 权限档位 → sidecar 审批档的覆盖状态机（见 permission-bridge.ts）。 */
  private readonly permission = new PermissionBridge()
  /** 上次同步到内核的模型选择（避免同值重复热切；内核按会话记住模型）。 */
  private lastSyncedModel: { sessionId: string; modelId: string } | undefined
  /** 用量上报的差分基线（内核 output 为会话累计快照；换会话即按 sessionId 重置）。 */
  private usageBaseline: { sessionId: string; outputTotal: number } | undefined
  /** 工具 id → 参数全文（完成更新回填折叠卡 Input 区；结果到达即删，换会话清空）。 */
  private readonly toolInputs = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, { requestId: string; toolName: string; input: unknown }>()
  private unsubscribeCurrent: (() => void) | undefined

  /**
   * @param getClient - 解析 sidecar 客户端；必要时触发内核启动。
   * @param log - participant 诊断的输出通道落点。
   * @param human - 审批/提问的原生对话框桥。
   */
  constructor(
    private readonly getClient: () => Promise<SidecarClient>,
    private readonly log: (line: string) => void,
    private readonly human: ChatHumanInteraction,
  ) {
    this.participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, (request, context, stream, token) =>
      this.handleRequest(request, context, stream, token),
    )
  }

  /** 注销 participant 并丢弃进行中的轮与订阅。 */
  dispose(): void {
    this.cancelRequest?.()
    this.activeTurn = undefined
    this.unsubscribeCurrent?.()
    this.unsubscribeCurrent = undefined
    this.permission.clearAll()
    this.toolInputs.clear()
    this.pendingApprovals.clear()
    this.participant.dispose()
  }

  /** 把一条聊天轮事件落进视图，或在终结事件上收束本轮。 */
  private dispatch(event: ChatTurnEvent | undefined): void {
    const turn = this.activeTurn
    if (event?.kind === 'approval' || event?.kind === 'approval-snapshot' || event?.kind === 'approval-resolved') {
      const sessionId = this.gate.currentSession()
      if (!sessionId) return
      if (event.kind === 'approval-resolved') {
        this.pendingApprovals.delete(event.requestId)
      } else {
        const rows = event.kind === 'approval' ? [event] : event.approvals
        const previous = new Set(this.pendingApprovals.keys())
        if (event.kind === 'approval-snapshot') this.pendingApprovals.clear()
        for (const row of rows) {
          this.pendingApprovals.set(row.requestId, row)
          if (!previous.has(row.requestId)) {
            turn?.stream.markdown(`\n\n> ⏸ 审批请求：${row.toolName}——请在弹出对话框中确认。`)
            this.human.handleApproval(sessionId, row.requestId, row.toolName, row.input)
          }
        }
      }
      turn?.timeout.setPendingApprovals(this.pendingApprovals.size)
      return
    }
    if (event === undefined || turn === undefined) return
    if (event.kind === 'delta') {
      turn.sawText = true
      turn.stream.markdown(event.text)
      return
    }
    if (event.kind === 'tool') {
      // 工具条目：原生 part 两段式（运行态→完成态）——「它在干什么」以折叠卡呈现；
      // 也标记本轮已有内容（不再落到「可能只产生了工具调用」的兜底文案）。
      turn.sawText = true
      if (event.id !== '') {
        const spec = toolStartPart(event)
        const part = new vscode.ChatToolInvocationPart(event.name, event.id)
        part.enablePartialUpdate = true
        part.isComplete = false
        part.invocationMessage = spec.invocationMessage
        part.toolSpecificData = spec.toolSpecificData
        turn.stream.push(part)
        this.toolInputs.set(event.id, event.inputText)
      } else {
        // 老内核无工具 id（无法与结果更新配对）：降级为文本行。
        turn.stream.markdown(`\n\n⏺ \`${event.name}\`${event.detail !== '' ? ` · ${event.detail}` : ''}`)
      }
      return
    }
    if (event.kind === 'tool-result') {
      // partial 帧是流式进度 chunk（v1 忽略，留待「运行中输出」实时预览）；
      // 终态更新：同 toolCallId 收束为完成态（pastTense 文案 + input/output 折叠数据）。
      if (event.partial) return
      turn.sawText = true
      const inputText = this.toolInputs.get(event.id) ?? ''
      this.toolInputs.delete(event.id)
      const spec = toolDonePart(event, inputText)
      const part = new vscode.ChatToolInvocationPart(event.name, event.id, spec.errorMessage)
      part.enablePartialUpdate = true
      part.isComplete = true
      part.pastTenseMessage = spec.pastTenseMessage
      part.toolSpecificData = spec.toolSpecificData
      turn.stream.push(part)
      return
    }
    if (event.kind === 'thinking') {
      // 思考增量：交给宿主合并为思考块（连续非空增量自动追加；工具/文本到达自然分段）。
      turn.sawText = true
      turn.stream.thinkingProgress({ text: event.text })
      return
    }
    if (event.kind === 'usage') {
      // 上下文占用圆环的数据源：promptTokens 已是「当前上下文」（turn-events 归一，
      // contextTokens 优先）；completionTokens 是内核累计 output——差分出本轮产出
      // 再上报（否则圆环把会话累计流量当占用显示，实测 276.0K 之误）。
      const prevOutput = this.usageBaseline?.sessionId === turn.sessionId ? this.usageBaseline.outputTotal : 0
      const outputDelta = Math.max(0, event.completionTokens - prevOutput)
      this.usageBaseline = { sessionId: turn.sessionId, outputTotal: Math.max(prevOutput, event.completionTokens) }
      turn.stream.usage?.({ promptTokens: event.promptTokens, completionTokens: outputDelta })
      return
    }
    if (event.kind === 'question') {
      turn.stream.markdown('\n\n> ❓ 天枢向你提问——请在弹出对话框中作答。')
      this.human.handleQuestion(turn.sessionId, event.toolUseId, event.questions)
      return
    }
    this.activeTurn = undefined
    turn.settle(event)
  }

  /**
   * 回答一条聊天请求：解析会话、发送 prompt、把该会话的事件流回视图直到
   * 本轮收束或 token 取消。
   */
  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> {
    if (this.requestOwner !== undefined || this.activeTurn !== undefined) {
      stream.markdown('上一个回答还在进行中——等它结束或点停止后再提问。')
      return
    }
    const owner: RequestOwnership = {}
    this.requestOwner = owner
    let cancelled = false
    let resolveCancellation!: (result: vscode.ChatResult | void) => void
    const cancellation = new Promise<vscode.ChatResult | void>((resolve) => { resolveCancellation = resolve })
    const cancelRequest = () => {
      if (cancelled) return
      cancelled = true
      if (this.requestOwner === owner) {
        const turn = this.activeTurn
        turn?.timeout.dispose()
        turn?.settle({ kind: 'end', reason: 'aborted' })
        this.activeTurn = undefined
        this.requestOwner = undefined
      }
      owner.abort?.()
      resolveCancellation(owner.sessionId ? { metadata: { tianshuSessionId: owner.sessionId } } : undefined)
    }
    this.cancelRequest = cancelRequest
    let cancelSubscription: vscode.Disposable | undefined
    const current = () => !cancelled && this.requestOwner === owner
    try {
      cancelSubscription = token.onCancellationRequested(cancelRequest)
      if (token.isCancellationRequested) cancelRequest()
      if (!current()) return await cancellation
      return await Promise.race([this.runRequest(request, context, stream, owner, current), cancellation])
    } finally {
      cancelSubscription?.dispose()
      if (this.requestOwner === owner) this.requestOwner = undefined
      if (this.cancelRequest === cancelRequest) this.cancelRequest = undefined
    }
  }

  private async runRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    owner: RequestOwnership,
    current: () => boolean,
  ): Promise<vscode.ChatResult | void> {
    let client: SidecarClient
    try {
      client = await this.getClient()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stream.markdown(`天枢内核未就绪：${message}`)
      return
    }
    if (!current()) return

    // 立即的活性反馈：建会话、发 prompt 到首 token 可能数秒，期间聊天视图是空的。
    stream.progress('天枢思考中…')

    let sessionId: string
    try {
      sessionId = await this.resolveSession(client, context, current)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`[chat] session resolve failed: ${message}`)
      stream.markdown(`无法准备天枢会话：${message}`)
      return
    }
    if (!current()) return
    owner.sessionId = sessionId

    try {
      await this.syncPermissionLevel(client, sessionId, request.permissionLevel)
    } catch (error) {
      stream.markdown(`权限同步失败，消息尚未发送：${error instanceof Error ? error.message : String(error)}`)
      return { metadata: { tianshuSessionId: sessionId } }
    }
    if (!current()) return

    // chat 的模型选择 → 内核会话模型（选中真实模型时；占位壳/同值跳过）。
    await this.syncModelChoice(client, sessionId, request.model?.id)
    if (!current()) return

    // 订阅管理：单例 + 代际（见 subscription-gate.ts——subscribe 的取消不中止
    // 在途投递，per-turn 订阅会留下继续投递的连接，同一事件成倍重复）。
    const acquired = this.gate.acquire(sessionId)
    if (!acquired.reuse || !this.unsubscribeCurrent) {
      this.unsubscribeCurrent?.()
      this.unsubscribeCurrent = undefined
      this.pendingApprovals.clear()
      let since: number
      try {
        since = (await client.getSession(sessionId)).lastSeq
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stream.markdown(`无法读取天枢会话状态：${message}`)
        return
      }
      if (!current() || !this.gate.isCurrent(acquired.generation)) return
      const generation = acquired.generation
      this.unsubscribeCurrent = client.subscribe(
        sessionId,
        since,
        (ev: SessionEvent) => {
          if (!this.gate.isCurrent(generation)) return
          this.dispatch(interpretSessionEvent(ev))
        },
      )
    }

    let settle: (event: ChatTurnEvent) => void = () => {}
    const outcome = new Promise<ChatTurnEvent>((resolve) => { settle = resolve })

    // 轮超时 = 静默窗口 + 审批豁免：审批挂起期间暂停计时（等待用户不是
    // sidecar 静默——照常计时会把随后「允许一次」的恢复输出丢成无主轮），
    // 审批完结后开新窗口（见 turn-timeout.ts）。
    let settleTimeout: (event: ChatTurnEvent) => void = () => {}
    const timedOut = new Promise<ChatTurnEvent>((resolve) => { settleTimeout = resolve })
    const timeout = new TurnTimeout(TURN_TIMEOUT_MS, () => {
      settleTimeout({
        kind: 'error',
        message: `等待回答超过 ${Math.round(TURN_TIMEOUT_MS / 60_000)} 分钟，已放弃等待（任务可能仍在 sidecar 中继续）。`,
      })
    })

    const turn: ActiveTurn = { sessionId, stream, sawText: false, timeout, settle }
    this.activeTurn = turn

    owner.abort = () => {
      void client.abort(sessionId).catch((error: unknown) => {
        this.log(`[chat] cancel failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    timeout.arm()
    timeout.setPendingApprovals(this.pendingApprovals.size)

    try {
      const queued = await client.queue(sessionId, request.prompt)
      if (!current()) return { metadata: { tianshuSessionId: sessionId } }
      if (queued === 'idle') {
        await client.prompt(sessionId, request.prompt)
      }
      this.log(`[chat] prompt accepted session=${sessionId}`)

      const settled = await Promise.race([outcome, timedOut])
      if (settled.kind === 'error') {
        stream.markdown(`\n\n> ${settled.message}`)
      } else if (settled.kind === 'end' && settled.reason !== 'completed') {
        stream.markdown(`\n\n> 本轮以 \`${settled.reason}\` 结束。`)
      }
      if (!turn.sawText) {
        // sawText=false 意味着视图里没有文本/工具/思考任何内容（如静默收束、超时）。
        stream.markdown('（本轮没有回复内容；任务可能仍在「天枢 Sidecar」中继续。）')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`[chat] prompt failed: ${message}`)
      stream.markdown(`发送失败：${message}`)
    } finally {
      timeout.dispose()
      if (this.activeTurn === turn) this.activeTurn = undefined
    }
    return { metadata: { tianshuSessionId: sessionId } }
  }

  /**
   * 由宿主保存的 response metadata 恢复对应 sidecar 会话；缺少身份的历史
   * 开新会话，避免继承另一原生聊天的上下文。
   */
  private async resolveSession(client: SidecarClient, context: vscode.ChatContext, current: () => boolean = () => true): Promise<string> {
    let resolved: string | undefined
    for (const turn of [...context.history].reverse()) {
      if (!('result' in turn) || turn.participant !== PARTICIPANT_ID) continue
      const id: unknown = turn.result.metadata?.tianshuSessionId
      if (typeof id === 'string' && id.length > 0) { resolved = id; break }
    }
    resolved ??= await this.createSession(client)
    if (!current()) return resolved
    if (this.sessionId !== resolved) this.toolInputs.clear()
    this.sessionId = resolved
    return resolved
  }

  /**
   * chat UI 权限档位下行到 sidecar 会话（见 permission-bridge.ts）：仅显式
   * 档位变化时调 `setApprovalMode`，服务端确认后才记录同步结果。
   */
  private async syncPermissionLevel(client: SidecarClient, sessionId: string, level: string | undefined): Promise<void> {
    try {
      const action = await this.permission.sync(sessionId, level, async () => {
        const record = await client.getSession(sessionId)
        return record.approvalMode
      }, async mode => { await client.setApprovalMode(sessionId, mode) })
      if (action.kind === 'set') {
        this.log(`[chat] approval mode synced: ${action.mode} (ui-level=${String(level)})`)
      }
    } catch (error) {
      this.log(`[chat] approval mode sync failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /**
   * chat 的模型选择同步到内核会话（POST /model 热切换，保留对话历史）。
   * 占位壳（MODEL_ID）不映射——保持内核当前模型；同值不重复调（热切重建
   * agent loop 有成本）；失败（如 running 中 409）只记日志，不阻塞本轮投递。
   */
  private async syncModelChoice(client: SidecarClient, sessionId: string, modelId: string | undefined): Promise<void> {
    if (!modelId || modelId === MODEL_ID) return
    if (this.lastSyncedModel?.sessionId === sessionId && this.lastSyncedModel.modelId === modelId) return
    try {
      await client.switchModel(sessionId, modelId)
      this.lastSyncedModel = { sessionId, modelId }
      this.log(`[chat] model synced: ${modelId}`)
    } catch (error) {
      this.log(`[chat] model sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 以第一个工作区目录为根创建一个 sidecar 会话。 */
  private async createSession(client: SidecarClient): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    const record = await client.createSession({ cwd })
    this.log(`[chat] session created ${record.id} @ ${cwd}`)
    return record.id
  }
}
