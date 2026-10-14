import { join } from 'node:path'
import type { TuiApp, TuiMetricsProvider } from './engine/app.js'
import type { BootstrapContext } from '../bootstrap.js'
import { sessionsDir } from '../config/paths.js'
import { UIHistory } from './ui-history.js'
import type { SessionContext } from '../agent/context.js'
import type { CompactEvent } from '../context/types.js'
import type { RewindMode } from './format/rewind.js'
import type { FrontendPreferences } from './frontend-preferences.js'
import { collectPostBoundaryEditIds } from '../agent/file-history.js'
import { computeUsageCost, findModelPricing } from '../utils/pricing.js'
import { deepseekPricingPhase } from '../utils/pricing-phase.js'
import { projectCacheTelemetry } from './cache-telemetry.js'
import { rewindAgentSession } from '../agent/loop-factory.js'
import type { CacheStatus } from './status-types.js'

const compactCursors = new WeakMap<TuiApp, { session: SessionContext; last?: CompactEvent }>()

export async function initializeFrontendHistory(app: TuiApp, ctx: BootstrapContext, targetId = ctx.sessionId): Promise<void> {
  compactCursors.set(app, { session: ctx.session, last: ctx.session.getCompactEvents().at(-1) })
  await app.setUIHistorySession(join(sessionsDir(ctx.cwd), targetId, 'ui-history.jsonl'), ctx.session.getMessages().length > 0)
}

/** Runtime-recorded events are success facts; starting a compact is not a boundary. */
export function syncFrontendCompaction(app: TuiApp, ctx: BootstrapContext): void {
  const events = ctx.session.getCompactEvents()
  const cursor = compactCursors.get(app)
  compactCursors.set(app, { session: ctx.session, last: events.at(-1) })
  if (!cursor || cursor.session !== ctx.session) return
  const start = cursor.last ? events.indexOf(cursor.last) + 1 : 0
  for (const event of events.slice(start)) {
    app.markUIHistoryBoundary(`上下文已整理：${event.beforeTokens} → ${event.afterTokens} tokens；阅读历史保留`, 'compact')
  }
}

export function createFrontendMetricsProvider(app: TuiApp, getContext: () => BootstrapContext | null, fallbackWindow = 0): TuiMetricsProvider {
  let prevCacheStatus: CacheStatus = 'healthy'
  return () => {
    const ctx = getContext()
    if (!ctx) return null
    syncFrontendCompaction(app, ctx)
    const session = ctx.session
    const total = session.getTotalUsage()
    const providerName = ctx.agent.config.providerName
    const pricing = findModelPricing(ctx.agent.config.allProviders ?? {}, providerName, ctx.agent.config.promptEngine.getModel())
    const turnNumber = session.getTurnCount()
    const cacheProjection = projectCacheTelemetry(session, turnNumber, prevCacheStatus)
    prevCacheStatus = cacheProjection.status
    return {
      estimatedTokens: session.getRealOccupancy(), conversationTokens: session.getConversationTokens(),
      maxTokens: ctx.agent.config.contextWindow ?? fallbackWindow,
      cacheHitRate: session.getRecentTurnHitRate(3) ?? session.getCacheHitRate(), cacheStatus: cacheProjection.status,
      cost: pricing ? computeUsageCost(total, pricing).total : 0, costSource: pricing ? 'estimate' : 'unknown',
      inputTokens: total.input_tokens, outputTokens: total.output_tokens, lastRealPromptTokens: session.getLastRealPromptTokens(),
      pricingPhase: providerName === 'deepseek' ? deepseekPricingPhase(Date.now()) : undefined,
      cvmInterceptions: ctx.agent.cvmVector.mode === 'off' ? undefined : session.getCvmInterceptions().total,
    }
  }
}

export function applyFrontendSettings(app: TuiApp, preferences: FrontendPreferences): false | (() => void) {
  const current = app.getFrontendPreferences()
  if (!app.setFrontendPreferences({ ...preferences, keymap: current.keymap, welcome: current.welcome, bindings: preferences.keymap === current.keymap ? preferences.bindings : current.bindings })) return false
  return () => { app.setFrontendPreferences(current) }
}

export function resolveFrontendWelcomeCompact(welcome: FrontendPreferences['welcome'], guide: boolean): boolean | undefined {
  return welcome === 'full' ? false : guide ? undefined : true
}

/** Existing rewind behavior, with read-history facts emitted only after successful mutation. */
export function executeFrontendRewind(app: TuiApp, ctx: BootstrapContext, messageIndex: number, mode: RewindMode): void {
  const messages = ctx.session.getMessages()
  const target = messages[messageIndex]
  const content = target && typeof target.content === 'string' ? target.content : ''
  if (mode === 'summarize-from' || mode === 'summarize-to') {
    const scope = mode === 'summarize-from' ? 'from' : 'to'
    app.commitStatic(`⏳ 正在摘要${scope === 'from' ? '此消息之后' : '此消息之前'}的对话…`)
    void ctx.agent.compaction.summarizeRange({ scope, messageIndex }).then(result => {
      if (!result.ok) { app.commitStatic(`摘要失败：${result.reason}`, { isError: true }); return }
      syncFrontendCompaction(app, ctx)
      const saved = result.beforeTokens - result.afterTokens
      app.commitStatic(`⏪ 已把 ${result.replaced} 条消息压成摘要 — ${result.beforeTokens} → ${result.afterTokens} tokens（省 ${saved}）`)
    }, err => app.commitStatic(`摘要失败：${(err as Error).message}`, { isError: true }))
    return
  }
  if (mode === 'code' || mode === 'both') {
    const fh = ctx.agent.getFileHistory()
    if (fh) {
      const ids = collectPostBoundaryEditIds(messages, messageIndex)
      void fh.rewindToBoundary(ids).then(changed => {
        const skipped = changed.skipped
        const skippedNote = skipped.length > 0
          ? `；跳过 ${skipped.length} 个被其他会话编辑中的文件（${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}）`
          : ''
        if (changed.length > 0) app.markUIHistoryBoundary(`已恢复 ${changed.length} 个文件；原阅读历史保留`, 'rewind')
        app.commitStatic(`⏪ 已把 ${changed.length} 个文件恢复到此消息${changed.length ? '' : '（无可恢复的编辑）'}${skippedNote}`)
      }, err => app.commitStatic(`回滚代码失败：${(err as Error).message}`))
    } else app.commitStatic('无文件历史，无法恢复代码。')
  }
  if ((mode === 'convo' || mode === 'both') && messageIndex >= 0) {
    rewindAgentSession(ctx.agent, messages.slice(0, messageIndex), () => ctx.agent)
    if (messageIndex < messages.length) app.markUIHistoryBoundary('对话已回溯到所选消息；原阅读历史保留', 'rewind')
    app.commitStatic('⏪ 已截断对话到此消息 — 已回填输入框。')
    app.setInput(content)
  }
}

export async function previewFrontendSession(cwd: string, id: string): Promise<string> {
  if (!/^[\w-]+$/.test(id)) return '会话ID无效'
  const history = await UIHistory.open(join(sessionsDir(cwd), id, 'ui-history.jsonl'))
  if (!history.count) return '升级前阅读历史不可用；恢复会话仍使用原模型上下文。'
  const records = await history.page(Math.max(0, history.count - 10), 10)
  return records.map(record => `[${record.kind}] ${record.name ?? ''}\n${record.text}`).join('\n\n')
}
