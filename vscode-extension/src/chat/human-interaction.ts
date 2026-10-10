/**
 * 人类交互桥：把聊天会话轮内的审批/提问事件转成 VS Code 原生对话框。
 * 审批与提问回答经 REST 定向回原 session；全局 chat.open 无会话身份，用户在
 * 弹窗期间切换聊天时会误投。提问之后的输出在座舱查看，成功时明确提示。
 *
 * dismiss（不回答）一律保持原状：审批继续 pending（agent 保持阻塞），
 * 提问视为未作答（可稍后自行回复）——与座舱卡片同一保守姿势。
 *
 * 同一 requestId/toolUseId 只弹一次（SSE 重连重放防抖）；多个请求排队串行弹窗，
 * 避免对话框风暴。
 * @module
 */
import * as vscode from 'vscode'
import type { SidecarClient } from '../sidecar/client.js'
import type { ChatQuestion } from './turn-events.js'
import { approvalAnswerFrom, APPROVAL_CHOICES, composeQuestionAnswer } from './human-forms.js'

/** 审批对话框 detail 里的输入摘要上限（防超长 JSON 撑爆对话框）。 */
const INPUT_PREVIEW_LIMIT = 500

export class ChatHumanInteraction implements vscode.Disposable {
  /** 已弹过窗的审批 requestId。 */
  private readonly seenApprovals = new Set<string>()
  /** 已弹过窗的提问 toolUseId（空串不可去重，跳过登记）。 */
  private readonly seenQuestions = new Set<string>()
  /** 对话框串行链：同时到达的多个请求逐一弹窗。 */
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  /**
   * @param getClient - 解析 sidecar 客户端（回答时用；必要时触发内核启动）。
   * @param log - 诊断的输出通道落点。
   */
  constructor(
    private readonly getClient: () => Promise<SidecarClient>,
    private readonly log: (line: string) => void,
  ) {}

  dispose(): void {
    this.disposed = true
  }

  /** 排队处理一个审批请求（事件回调里即发即忘）。 */
  handleApproval(sessionId: string, requestId: string, toolName: string, input: unknown): void {
    if (this.seenApprovals.has(requestId)) return
    this.seenApprovals.add(requestId)
    this.enqueue(() => this.askApproval(sessionId, requestId, toolName, input))
  }

  /** 排队处理一组提问。 */
  handleQuestion(sessionId: string, toolUseId: string, questions: ChatQuestion[]): void {
    if (toolUseId !== '' && this.seenQuestions.has(toolUseId)) return
    if (toolUseId !== '') this.seenQuestions.add(toolUseId)
    this.enqueue(() => this.askQuestions(sessionId, questions))
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.log(`[human] dialog task failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async askApproval(sessionId: string, requestId: string, toolName: string, input: unknown): Promise<void> {
    if (this.disposed) return
    let detail: string | undefined
    try {
      const text = JSON.stringify(input)
      if (text !== undefined && text !== 'null' && text !== '{}') {
        detail = text.length > INPUT_PREVIEW_LIMIT ? `${text.slice(0, INPUT_PREVIEW_LIMIT)}…` : text
      }
    } catch {
      // 不可序列化的 input 不展示摘要
    }
    this.log(`[human] approval dialog: ${toolName} (${requestId})`)
    const picked = await vscode.window.showWarningMessage(
      `允许工具调用 ${toolName}？`,
      { modal: true, ...(detail !== undefined ? { detail } : {}) },
      ...APPROVAL_CHOICES,
    )
    if (this.disposed) return
    const answer = approvalAnswerFrom(picked)
    if (answer === undefined) {
      this.log(`[human] approval ${requestId} left pending (dialog dismissed)`)
      return
    }
    try {
      const client = await this.getClient()
      await client.answerApproval(sessionId, requestId, answer)
      this.log(`[human] approval ${requestId} responded: ${answer.decision}${answer.remember === true ? ' (remember)' : ''}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`[human] approval respond failed: ${message}`)
      void vscode.window.showErrorMessage(`天枢审批回答发送失败: ${message}`)
    }
  }

  private async askQuestions(sessionId: string, questions: ChatQuestion[]): Promise<void> {
    if (this.disposed) return
    this.log(`[human] question dialog: ${questions.map((q) => q.id).join(',')}`)
    const picked: Record<string, string[]> = {}
    for (const q of questions) {
      const selected = await this.askOne(q)
      if (this.disposed) return
      if (selected === undefined) {
        this.log(`[human] question ${q.id} left unanswered (dialog dismissed)`)
        return
      }
      picked[q.id] = selected
    }
    const text = composeQuestionAnswer(questions, picked)
    try {
      const client = await this.getClient()
      if (this.disposed) return
      const steered = await client.steer(sessionId, text)
      if (this.disposed) return
      if (steered !== 'queued') await client.prompt(sessionId, text)
      if (this.disposed) return
      this.log(`[human] question answered → original session ${sessionId} (${steered === 'queued' ? 'steer' : 'prompt'})`)
      void vscode.window.showInformationMessage('回答已发送至原会话，请在天枢座舱查看后续结果。')
    } catch (error) {
      if (this.disposed) return
      const message = error instanceof Error ? error.message : String(error)
      this.log(`[human] question answer failed: ${message}`)
      void vscode.window.showErrorMessage(`天枢提问回答发送失败: ${message}`)
    }
  }

  /** 单题：有选项走 QuickPick（allowMultiple → 多选）；无选项走 InputBox。 */
  private async askOne(q: ChatQuestion): Promise<string[] | undefined> {
    if (q.options.length > 0) {
      // ignoreFocusOut：问卷不因用户切窗口而消失（截图实证背景下问卷曾"没人看到"
      // ——默认失焦即关，用户回来时已经什么都没有）。
      const picked = await vscode.window.showQuickPick(q.options, {
        title: q.prompt,
        placeHolder: q.prompt,
        canPickMany: q.allowMultiple,
        ignoreFocusOut: true,
      })
      if (picked === undefined) return undefined
      return Array.isArray(picked) ? picked : [picked]
    }
    const custom = await vscode.window.showInputBox({ title: '天枢提问', prompt: q.prompt, ignoreFocusOut: true })
    if (custom === undefined) return undefined
    return custom === '' ? [] : [custom]
  }
}
