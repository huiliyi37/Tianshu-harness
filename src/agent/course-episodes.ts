import type { AgentLoop } from './loop.js'
import type { AgentCallbacks } from './loop-types.js'

/** Internal trusted envelope; legacy strings and worker reminders have no human authority. */
export interface HumanGuidance { origin: 'human'; inputSequence: number; text: string }

/**
 * CourseEpisodes — 课业周期（episode）驱动。P0 后去重事实（Todo/义务/验证）
 * 迁至 WorkProgressFacts 单次消费，本类只负责：按事实的 revision 差值决定
 * 是否开启新 episode，并维护既有核销/ probation 政策。
 *
 * 消费语义（原 fileChanged 布尔模型的 revision 等价实现）：
 * - 文件变化：按 mutationRevision 对比（实时值——轮内写立即可见，不引入延迟）；
 * - 进展（todo/义务/验证）：按 progressRevision 对比（在 beginModelTurn 的
 *   单次消费点更新——不双重消费的代价是发现至多晚一轮，与计划 §3 一致）。
 */
export class CourseEpisodes {
  /** 已消费到的 revision（与 WorkProgressFacts 单调计数对齐）。 */
  private lastMutationRev = 0
  private lastProgressRev = 0
  private waiting: ReturnType<NonNullable<AgentLoop['jobs']>['verificationWaitInfo']> = null
  constructor(private self: AgentLoop) {}

  start(reason: string): void {
    if (reason === 'human-task' || reason === 'human-guidance') {
      this.self.decisionShifts.clearWarning()
      this.self.decisionShifts.discard(reason)
    }
    const keys = this.self.advisoryReadback.startCourseEpisode(reason)
    if (reason === 'human-task' || reason === 'human-guidance') this.self.advisoryBus.grantEpisodeProbation(keys)
    this.self.telemetryWriter.write({ kind: 'course-episode', episodeId: this.self.advisoryReadback.courseEpisode, reason, keys })
    if (reason === 'human-task') {
      // 任务边界：事实层唯一递增 taskEpoch 并重新基线化（清空去重集合 +
      // 存量吞入）；本类把消费点同步到边界值（原「清 fileChanged」语义）。
      this.self.workFacts.recordHumanTaskBoundary()
      this.syncConsumed()
    }
  }

  /** 消费点对齐到当前事实值（任务边界调用；无快照时按原始计数 no-op）。 */
  private syncConsumed(): void {
    this.lastMutationRev = this.self.workFacts.mutationRevision
    this.lastProgressRev = this.self.workFacts.progressRevision
  }

  sample(): void {
    const snap = this.self.workFacts.currentSnapshot()
    if (!snap) return // 尚未装配（首个 beginModelTurn 前）——无事实可消费
    // 等待验证信标（telemetry 观测）：取自同一份轮初快照。
    const waiting = snap.waitingVerification
    if (waiting?.jobId !== this.waiting?.jobId) {
      this.self.telemetryWriter.write({ kind: 'verification-wait-beacon', episodeId: this.self.advisoryReadback.courseEpisode,
        active: waiting !== null, ...(waiting ?? { jobId: this.waiting?.jobId }), reason: waiting ? 'eligible' : this.waiting && Date.now() >= this.waiting.waitUntil ? 'budget-expired' : 'terminal-or-task-boundary' })
      this.waiting = waiting
    }
    const facts = this.self.workFacts
    const fileChanged = facts.mutationRevision > this.lastMutationRev
    const progress = facts.progressRevision > this.lastProgressRev ? snap.lastProgressReason : null
    if (fileChanged || progress) this.start(fileChanged ? 'progress:file-change' : progress!)
    // 无条件推进消费点（原 fileChanged 无条件清零语义）。
    this.lastMutationRev = facts.mutationRevision
    this.lastProgressRev = facts.progressRevision
  }

  callbacks(callbacks: AgentCallbacks): AgentCallbacks {
    if (!callbacks.onHumanGuidanceDrain) return callbacks
    let sequence = -1
    return { ...callbacks, onHumanGuidanceAccepted: item => {
      if (item.origin === 'human' && Number.isSafeInteger(item.inputSequence) && item.inputSequence > sequence && item.text.trim()) {
        sequence = item.inputSequence
        this.self.workFacts.acceptHumanConstraints(item.text)
        this.start('human-guidance')
      }
    } }
  }
}

export async function drainSteerGuidance(callbacks: AgentCallbacks): Promise<{ text: string; accepted: () => void } | null> {
  const item = await callbacks.onHumanGuidanceDrain?.()
  if (item?.text) return { text: item.text, accepted: () => callbacks.onHumanGuidanceAccepted?.(item) }
  const text = await callbacks.onSteerDrain?.()
  return text ? { text, accepted: () => {} } : null
}
