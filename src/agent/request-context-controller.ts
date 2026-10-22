import { randomUUID } from 'node:crypto'
import { buildContextBudget, ContextBudgetExceededError, genericBudgetPolicy, type RequestBudgetPolicy } from '../context/request-budget.js'
import type { AgentLoop } from './loop.js'
import type { AgentCallbacks } from './loop-types.js'
import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { ContextBudgetSnapshot } from '../server/protocol.js'
import { prepareContextRequest } from './context-budget-preparation.js'
import { compactBudgetHistory } from './budget-compaction.js'
import { archiveContextImages } from './context-image-archive.js'
import { COMPACT_HISTORY_TOOL } from '../compact/recall-marker.js'
import { commitCompactedHistory } from './session-persist-listener.js'
import { LocalWorkerPolicyError } from '../api/continuation-prefix.js'

/** 把压缩的拒绝原因翻译成用户能读的中文（供 compact-blocked 相位）。 */
function describeCompactBlock(reason?: string): string {
  if (!reason) return '压缩未执行（压缩模型 / 持久化 / 上下文窗口不可用）'
  const r = reason
  if (r === 'insufficient_reclaim_or_summary_coverage') return '压缩未能回收足够上下文（保留下限已占满，可压缩部分不足）'
  if (r.startsWith('summary_stop:')) return '摘要模型未正常结束（输出被截断）'
  if (r === 'summary_schema_or_budget_rejected') return '摘要格式或预算被拒'
  if (r === 'aborted') return '压缩被中断'
  if (r === 'summary_or_persistence_failed') return '摘要生成或落盘失败'
  return `压缩未生效（${r}）`
}

/** One request budget owner; ordinary observations never mutate the prompt. */
export class RequestContextController {
  snapshot?: ContextBudgetSnapshot
  private revision = 0
  activeUserMessage?: OaiMessage
  private failedAt?: { input: number; model: string; budget: number; userBoundary?: OaiMessage }
  /** 上一次压缩的拒绝原因——仅在预算闸门最终拒绝时用于向 UI 透出（见 describeCompactBlock）。 */
  private lastCompactReason?: string
  constructor(private readonly agent: AgentLoop) {}

  getBudgetPolicy(): RequestBudgetPolicy | undefined {
    return this.agent.config.promptEngine.getRequestBudgetPolicy() ?? genericBudgetPolicy(this.agent.config.contextWindow)
  }

  record(budget: ContextBudgetSnapshot, beginRequest = false): ContextBudgetSnapshot {
    if (!beginRequest && this.snapshot && this.snapshot.requestId !== budget.requestId) return this.snapshot
    this.snapshot = { ...budget, revision: ++this.revision, sampledAt: Date.now() }
    return this.snapshot
  }

  async prepare(build: () => OaiChatRequest, callbacks: AgentCallbacks): Promise<OaiChatRequest> {
    const recovering = this.agent.reasoningRecoveryPending
    const buildRequest = () => {
      const request = build()
      if (recovering) request.diagnostics = { ...request.diagnostics, purpose: 'reasoning_recovery' }
      return request
    }
    const policy = this.getBudgetPolicy()
    if (!policy) { this.agent.reasoningRecoveryPending = false; return buildRequest() }
    try {
      const request = await prepareContextRequest({ build: buildRequest, policy, signal: this.agent.abortController?.signal,
        preview: request => (this.agent.config.primaryClient ?? this.agent.config.client)?.previewContextRequest?.(request) ?? request,
        publish: budget => { const current = this.record(budget, true); callbacks.onContextBudget?.(current) },
        compact: () => this.compact(),
      })
      this.agent.reasoningRecoveryPending = false
      return request
    } catch (error) {
      // 预算闸门最终拒绝 = 压缩没能救回上下文。原因此前只落 session 台账、无消费方，
      // 用户只看到「超限」而不知压缩为何无效。经相位通道 surface（瞬态、不进历史/缓存，
      // 同 body-guard / image-stripped 先例）：TUI 状态行 + 桌面 toast。
      if (error instanceof ContextBudgetExceededError) {
        callbacks.onPhaseChange?.('compact-blocked', { reason: describeCompactBlock(this.lastCompactReason) })
      }
      throw error
    }
  }

  refreshSnapshot(): void {
    const self = this.agent, policy = this.getBudgetPolicy()
    if (!policy) return
    const request = self.config.promptEngine.buildOaiRequest(self.session.getMessages(), self.recentToolHistory, self.config.contextWindow)
    const visible = (self.config.primaryClient ?? self.config.client)?.previewContextRequest?.(request) ?? request
    this.record(buildContextBudget(visible, policy, { requestId: randomUUID(), revision: 0 }), true)
  }

  async compact(force = false, reason: 'explicit_user_compact' | 'context_limit' = force ? 'explicit_user_compact' : 'context_limit', summaryFocus?: string): Promise<boolean> {
    const self = this.agent, budget = this.snapshot
    if (!force && (!budget || budget.inputTokens <= budget.inputBudget)) return false
    // This is explicit or hard-limit recovery, not discretionary ratio compaction.
    if (!self.config.budgetSummaryClient || !self.persist || !self.artifactStore) return false
    const summaryPolicy = this.getBudgetPolicy()
    if (!summaryPolicy) return false
    if (!force && budget && this.failedAt?.model === budget.model && this.failedAt.budget === budget.inputBudget
      && this.failedAt.userBoundary === this.activeUserMessage
      && budget.inputTokens < this.failedAt.input + 32_768) return false
    const signal = self.abortController?.signal
    await self.drainPersistWrites()
    const source = self.session.getMessages().slice()
    const sourceJson = JSON.stringify(source)
    const originalUser = self.session.resolveUserInput(this.activeUserMessage)
    const activeUser = originalUser && (source.includes(originalUser) ? originalUser : source.find(m => m.role === 'user'
      && typeof m.content === 'string' && typeof originalUser.content === 'string'
      && m.content.startsWith(originalUser.content + '\n<system-reminder>')))
    // History repair/rewind may have moved or replaced the user boundary. An
    // unidentified boundary blocks rewriting rather than protecting a tool by index.
    if (originalUser && !activeUser) return false
    const changed = await compactBudgetHistory(source, {
      client: self.config.budgetSummaryClient(),
      model: self.config.promptEngine.getModel(), signal, protectedUser: activeUser,
      targetTokens: budget ? Math.max(1_024, Math.floor(Math.min(budget.inputTokens, budget.inputBudget) * 0.7) - 16_384) : undefined,
      summaryPolicy, summaryMaxTokens: self.config.budgetSummaryMaxTokens,
      summaryFocus,
      // Preserve the paid prefix under ordinary pressure, but do not reject a
      // useful emergency reclaim merely because it is smaller than the 32K cost floor.
      minReclaimTokens: force ? 1 : Math.min(32_768, Math.max(1, budget!.inputTokens - budget!.inputBudget)),
      recordUsage: usage => self.recordSidePathUsage('compact-summary', usage, self.config.promptEngine.getModel()),
      recordEvent: event => { this.lastCompactReason = event.reason; self.session.recordCompactEvent({ turn: self.session.getTurnCount(), tier: 4, createdAt: Date.now(), ...event }) },
      archiveRejectedReport: async (text, reason) => {
        try { return await self.artifactStore!.saveDurable({ tool: 'compact-summary-failure', target: reason, rawContent: text, summary: reason, sections: [] }) }
        catch { return undefined }
      },
      archive: async messages => {
        const images = await archiveContextImages(self.artifactStore!, messages)
        const id = await self.artifactStore!.saveDurable({
          tool: COMPACT_HISTORY_TOOL, target: 'context-budget', rawContent: JSON.stringify(messages),
          summary: 'Full context before budget compaction (including original images and reasoning)', sections: [],
        })
        return { id, images }
      },
      commit: async messages => {
        signal?.throwIfAborted()
        if (JSON.stringify(self.session.getMessages()) !== sourceJson) throw new LocalWorkerPolicyError('历史在压缩摘要期间发生变化；禁止替换')
        const activeIndex = activeUser ? messages.indexOf(activeUser) : -1
        if (activeUser && activeIndex < 0) throw new LocalWorkerPolicyError('压缩候选缺少当前用户边界；禁止替换')
        await commitCompactedHistory(self, source, messages, reason)
        this.activeUserMessage = activeIndex >= 0 ? self.session.getMessages()[activeIndex] : undefined
        self.config.promptEngine.resetAppendixBaseline()
      },
    })
    this.failedAt = changed || !budget ? undefined : { input: budget.inputTokens, model: budget.model, budget: budget.inputBudget, userBoundary: this.activeUserMessage }
    return changed
  }
}
