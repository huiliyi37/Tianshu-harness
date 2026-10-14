import { type SessionContext } from './context.js'
import { type SessionPersist } from './session-persist.js'
import type { OaiMessage } from '../api/oai-types.js'
import { debugLog } from '../utils/debug.js'
import { isHumanInput } from './input-origin.js'
import type { AgentLoop } from './loop.js'
import { randomUUID } from 'node:crypto'
import { proveRewindHistory, type ContinuationPrefixProof, type RewindGenerationAuthorization } from '../api/continuation-prefix.js'

const agentRewindCommits = new WeakMap<AgentLoop['session'], { commit: Promise<void>; prior?: ContinuationPrefixProof }>()
export function rewindAgentSession(agent: AgentLoop, messages: OaiMessage[], liveAgent: () => AgentLoop = () => agent): void {
  const expected = JSON.stringify(messages)
  const prior = agent.config.client.getMainPrefixProof?.() ?? agent.config.promptEngine.getRewindAuthorization()?.prior ?? agentRewindCommits.get(agent.session)?.prior
  agent.session.rewindToMessages(messages)
  agent.config.promptEngine.resetAppendixBaseline()
  const commit = agent.drainPersistWrites().then(async () => {
    let current = liveAgent()
    for (;;) {
      if (JSON.stringify(agent.session.getMessages()) !== expected || JSON.stringify(current.session.getMessages()) !== expected) throw new Error('历史在回退提交期间发生变化')
      const authorization: RewindGenerationAuthorization | undefined = prior ? {
        version: 1, reason: 'explicit_user_rewind', cacheGenerationId: randomUUID(),
        model: current.config.promptEngine.getModel(), history: proveRewindHistory(messages), prior: structuredClone(prior),
      } : undefined
      if (authorization && current.persist) await current.persist.commitFrozenSnapshot({
        ...current.config.promptEngine.exportFrozenSnapshot(), executionSnapshot: authorization.prior, rewindAuthorization: authorization,
      })
      if (current !== liveAgent()) { current = liveAgent(); continue }
      if (JSON.stringify(current.session.getMessages()) !== expected) throw new Error('历史在回退提交期间发生变化')
      if (authorization) current.config.client.restoreRewindAuthorization?.(authorization)
      else current.config.client.authorizeCacheGeneration?.('explicit_user_rewind')
      current.config.promptEngine.authorizeCacheGeneration()
      if (authorization) current.config.promptEngine.authorizeRewindGeneration(authorization)
      if (current.persist) current.config.promptEngine.setExecutionSnapshotCommit(snapshot => current.persist!.commitFrozenSnapshot(snapshot))
      break
    }
  })
  agentRewindCommits.set(agent.session, { commit, prior })
  void commit.catch(() => {})
}
export async function waitForAgentRewind(agent: AgentLoop): Promise<void> {
  await agentRewindCommits.get(agent.session)?.commit
}

type SessionPersistenceListener = { drain: () => Promise<void>; commitCompaction: (expected: OaiMessage[], candidate: OaiMessage[]) => Promise<void> }
const persistenceListeners = new WeakMap<SessionContext, { persist: SessionPersist; listener: SessionPersistenceListener }>()

/**
 * drain 终值快照（2026-10-02 第四批）：meta.tokenUsage 原只在「消息 append」时
 * 由本文件 listener 快照——末次 append 之后的记账（turn 末 side-path 等）没有
 * 快照点，尾账留在内存永失（实测 worker-team-T2 差 4,307 = 恰好最后一条侧路行；
 * worker-batch-0 同类）。drain 是各出口（worker 收尾 / 主会话 shutdown / 压缩前 /
 * /cd 迁移前）共享的耐久屏障：屏障内侧补一次 session 终值快照。
 * 单调守卫：只增不减——宁可少刷不可倒扣（meta 单调递增是对账判据的前提）。
 * best-effort：快照失败不阻断 drain，flush 仍是权威屏障。
 */
export function writeFinalUsageSnapshot(session: SessionContext, persist: SessionPersist): void {
  try {
    const usage = session.getTotalUsage()
    const prevPrompt = persist.loadMetadata()?.tokenUsage?.prompt ?? 0
    if (usage.input_tokens < prevPrompt) return
    persist.updateMetadata({
      tokenUsage: {
        prompt: usage.input_tokens,
        completion: usage.output_tokens,
        total: usage.input_tokens + usage.output_tokens,
      },
    })
  } catch { /* 快照 best-effort；drain 的 flush 仍是权威屏障 */ }
}

/**
 * Wire the SessionContext mutation listener that mirrors every in-memory
 * message change to durable storage. Extracted verbatim from the AgentLoop
 * constructor (W-L5a) — pure persistence concern, no prefix-cache coupling.
 *
 * - append: serialize via a single promise chain to keep file order stable
 *   even when consecutive tool_results fire fast.
 * - replace: full atomic rewrite via compactOai (compaction/reset).
 */
export function attachSessionPersistListener(deps: {
  session: SessionContext
  persist: SessionPersist
}): SessionPersistenceListener {
  const { session, persist } = deps
  const existing = persistenceListeners.get(session)
  if (existing?.persist === persist) return existing.listener
  let writeChain: Promise<void> = Promise.resolve()
  let writeFailure: unknown
  let rewriteActive = false
  let rewriteRevision = 0
  session.setMutationListener((m) => {
    if (rewriteActive) { rewriteRevision++; return }
    if (m.type === 'append') {
      const msg = m.message
      // 2026-09-08 crash-recovery fix: shrink the hard-kill loss window to
      // the in-flight record. Tool calls, their results, and user turns are
      // flushed immediately; streaming assistant deltas keep the 200ms batch.
      const toolCalls = (msg as { tool_calls?: Array<unknown> }).tool_calls
      const flushNow = msg.role === 'user' || msg.role === 'tool' ||
        (msg.role === 'assistant' && !!toolCalls && toolCalls.length > 0)
      writeChain = writeChain
        .then(() => persist.appendOaiWithChecksum(msg, { flush: flushNow }))
        .then(() => {
          // P0-1 trace: verify every message triggers persistence
          debugLog(`[persist] append message role=${msg.role}`)
          // P1: Update metadata on every append. Snapshot once instead of
          // re-reading .meta.json per field — this runs on the hot append
          // path (N tool calls = N appends per turn).
          try {
            const snapshot = persist.loadMetadata()
            const patch: Partial<import('../context/types.js').SessionMetadata> = {}
            // TTSR injects guardrail reminders as <system-reminder>-wrapped
            // role:user messages; they are not real user turns (history-replay
            // also excludes them), so don't title/count them.
            const isReminder = typeof msg.content === 'string' && msg.content.startsWith('<system-reminder>')
            if (msg.role === 'user' && !isReminder) {
              if (isHumanInput(msg.origin) && typeof msg.content === 'string' && !snapshot?.title) {
                patch.title = msg.content.slice(0, 120)
              }
              patch.turnCount = (snapshot?.turnCount ?? 0) + 1
            }
            if (msg.role === 'assistant' && msg.tool_calls) {
              patch.toolCallCount = (snapshot?.toolCallCount ?? 0) + msg.tool_calls.length
            }
            const usage = session.getTotalUsage()
            // Usage.input_tokens is cache-INCLUSIVE by codebase convention
            // (see Usage in api/types.ts). Adding cache_read/cache_creation on
            // top double-counted the prompt exactly 2x for DeepSeek, where
            // input = hit + miss (cache-log 6bfc4465: meta 11.34M vs real 5.67M).
            // 单调守卫（2026-10-02 第四批）：meta.tokenUsage 是累计账，只增不减
            // ——续跑 seed（priorUsage）小于盘上已有值时，快照会把尾账连同更早的
            // 账一起倒扣（实测 worker 案例：meta 冻在更小的旧值）。宁可少刷不可倒扣。
            if (usage.input_tokens >= (snapshot?.tokenUsage?.prompt ?? 0)) {
              patch.tokenUsage = {
                prompt: usage.input_tokens,
                completion: usage.output_tokens,
                total: usage.input_tokens + usage.output_tokens,
              }
            }
            persist.updateMetadata(patch)
          } catch { /* metadata update failures are non-critical */ }
        })
        .catch(err => {
          writeFailure ??= err
          // Persistence failures must not crash the agent loop.
          // Surface to stderr; the in-memory state is still authoritative.
          // eslint-disable-next-line no-console
          console.error('[session-persist] append failed:', err)
        })
    } else {
      // replace is rare (compaction/reset); do it asynchronously after the
      // current append queue drains so the rewrite reflects the latest state.
      writeChain = writeChain
        .then(() => persist.compactOaiAsync(m.messages))
        .catch(err => {
          writeFailure ??= err
          // eslint-disable-next-line no-console
          console.error('[session-persist] compact failed:', err)
        })
    }
  })
  const commitCompaction = (expected: OaiMessage[], candidate: OaiMessage[]): Promise<void> => {
    const operation = writeChain.then(async () => {
      if (writeFailure) throw writeFailure
      await persist.flushSessionBuffer()
      const live = session.getMessages()
      if (live.length !== expected.length || live.some((m, i) => m !== expected[i])) throw new Error('历史在整理期间发生变化，请重新整理')
      rewriteActive = true
      const revision = rewriteRevision
      let restoredRevision = revision
      try {
        await persist.compactOaiAsync(candidate, true)
        if (rewriteRevision !== revision) throw new Error('历史在整理落盘期间发生变化，已取消替换')
        session.replaceMessages(candidate, { alreadyPersisted: true })
      } catch (error) {
        // Rename may already have happened (e.g. directory fsync failed). Restore
        // the authoritative live history before allowing any later append.
        const restore = session.getMessages().slice()
        restoredRevision = rewriteRevision
        try { await persist.compactOaiAsync(restore, true) } catch (restoreError) { writeFailure ??= restoreError }
        throw error
      } finally {
        rewriteActive = false
        if (rewriteRevision !== restoredRevision) {
          // A late hook during rollback is buffered too. Queue one full snapshot,
          // not duplicate appends that may already be present in the rollback.
          const latest = session.getMessages().slice()
          writeChain = writeChain.then(() => persist.compactOaiAsync(latest, true)).catch(err => { writeFailure ??= err })
        }
      }
    })
    // Keep the queue usable after a conflict; the caller still receives rejection.
    writeChain = operation.catch(() => {})
    return operation
  }
  const listener = { commitCompaction, drain: async () => {
    // 终值快照（2026-10-02 第四批）：原 drain 只刷已排队的写入，末次 append
    // 之后的记账（turn 末 side-path 等）没有快照点——尾账永失。见
    // writeFinalUsageSnapshot（单调守卫同处）。
    writeFinalUsageSnapshot(session, persist)
    await writeChain
    // P1 write-behind: drain must also flush the pending batch so /cd
    // migration, shutdown, and abort paths leave no unwritten tail.
    await persist.flushSessionBuffer()
    // Background writes stay handled, but an explicit durability barrier must
    // never acknowledge history that failed to reach disk.
    if (writeFailure) throw writeFailure
  } }
  persistenceListeners.set(session, { persist, listener })
  return listener
}
