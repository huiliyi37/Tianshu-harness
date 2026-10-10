import { verificationAttempted } from './verification-activity.js'
import { CourseCorrectionTracker } from './course-correction-tracker.js'
/**
 * Advisory Readback — advisory 采纳核销闭环（P1a, 2026-07-04 生命周期设计）。
 *
 * 问题：advisory 是发后不管的单向广播。submit → render → 没人知道模型是否照做。
 * 账本（Phase 0）只能回答"送达了多少"，回答不了"生效了多少"——习惯化对抗、
 * 降频淘汰、Phase 3 副驾自我优化全都缺数据地基。
 *
 * 机制（航空 readback 借喻：塔台指令要求机组复诵核销）：
 *   1. 送达跟踪 — turn-step-producer 在 render 后 drainDelivered()，把带
 *      expect 谓词的条目交给本模块（deliveredTurn = render 所在轮）。
 *   2. 行为观察 — advisory-readback-hook 的 postTool 半边把 turn 级工具事件
 *      喂进 observeTool()（完整 target + 错误状态，不依赖 traceStore 截断摘要）。
 *   3. 核销评估 — postTurn 半边调 evaluate()：正向谓词在窗口内满足 → adopted；
 *      到期未满足 → ignored；pattern_absent 到期时读文件判定。
 *   4. 账本输出 — 每个判定产出一条 outcome（drainOutcomes 供遥测落盘），
 *      同时维护 per-key 累计统计与 ignoredStreak（P1b 习惯化对抗的输入）。
 *
 * 状态 session-scoped：探针类谓词的观察窗口可跨多轮。
 */

import { readFileSync } from 'node:fs'
import type { AdvisoryExpectation, DeliveredAdvisory } from './advisory-bus.js'
import type { ToolHistoryEntry } from './evidence-gate.js'

/** 单条工具观察 — postTool 喂入,核销评估的证据源 */
export interface ObservedToolEvent {
  turn: number
  name: string
  /** bash → command;写/读类 → file_path;其余 → target 字段 */
  target: string
  isError: boolean
  verificationAttempted?: boolean
  verificationPurpose?: import('./verification-intent.js').VerificationPurpose
  /** 明确只读的 shell 调用（由 bash 活动分类填充）——与 read 族同归一类，
   *  只读侦察换外衣（只读 bash → read_file）不算改道。 */
  readonlyShell?: boolean
}

export type AdvisoryOutcome = 'adopted' | 'ignored'

/** 单次核销判定 — 供遥测落盘（kind: 'advisory-outcome';shadow 判定 kind: 'advisory-holdout'） */
export interface AdvisoryOutcomeEvent {
  deliveryId: string
  profile: 'main' | 'worker'
  key: string
  outcome: AdvisoryOutcome
  episodeId?: number
  expectKind: AdvisoryExpectation['kind']
  deliveredTurn: number
  evaluatedTurn: number
  /** holdout 反事实组:true = 该条被静默扣留,outcome 度量的是"没提醒模型也做了吗" */
  shadow?: boolean
}

/**
 * 会话结束时仍未走完观察窗口的送达 — 观测用，不进 adopted/ignored 账本。
 * 高 unresolved 占比意味着该场景的 expect 窗口比会话本身还长，
 * 说明的是「测不到」而不是「没效果」。
 */
export interface UnresolvedExpectation {
  deliveryId: string
  profile: 'main' | 'worker'
  episodeId?: number
  reason: 'session_ended' | 'superseded' | 'contaminated'
  key: string
  expectKind: AdvisoryExpectation['kind']
  deliveredTurn: number
  /** 距 deadline 还差几轮 */
  turnsShort: number
  shadow?: boolean
}

/** per-key 累计采纳统计 */
export interface AdvisoryKeyStats {
  delivered: number
  adopted: number
  ignored: number
  /** 连续 ignored 次数 — adopted 时清零。P1b 习惯化对抗的触发信号。 */
  ignoredStreak: number
  /** holdout 反事实组:被静默扣留的次数（不计入 delivered） */
  shadowHeld: number
  /** 扣留期内 expect 谓词仍被自发满足的次数——"没提醒也会做"的基线 */
  shadowSatisfied: number
  shadowDecided?: number
}

interface PendingExpectation {
  deliveryId: string
  key: string
  expect: AdvisoryExpectation
  deliveredTurn: number
  /** holdout 反事实组 — 核销进 shadow 桶,不影响 adopted/ignored/streak */
  shadow: boolean
  /** 投递时的策略周期（§3）——周期边界处未决项记 superseded，不跨任务算 ignored。 */
  episode: number
}

/** 各谓词的缺省观察窗口（轮），含送达轮 */
const DEFAULT_WINDOW: Record<AdvisoryExpectation['kind'], number> = {
  tool_appears: 1,
  verify_attempted: 2,
  file_touched: 1,
  // 探针清理合法地可以晚几轮（修完再清）——窗口放宽
  pattern_absent: 4,
  // 改道需要至少一轮新动作：送达轮 + 1
  course_changed: 2,
}

/** 观察日志保留的最大轮跨度 — pattern_absent 最长窗口 + 余量 */
const EVENT_RETENTION_TURNS = 8

/** 跨会话效能先验(EWMA 衰减后,可为小数)— seedPriors 注入 */
export interface EfficacyPriorCounts {
  delivered: number
  adopted: number
  ignored: number
  shadowHeld: number
  shadowSatisfied: number
  shadowDecided?: number
  profile?: 'main' | 'worker'
}

/** 先验对副驾闸门决出样本的贡献上限——防陈旧数据永久锁定闸门方向 */
export const PRIOR_DECIDED_CAP = 20

/** 成熟 lift 的最小决出样本数（会话 + 先验合并后） */
export const MATURE_LIFT_MIN_DECIDED = 5
/** 成熟 lift 的最小 shadow 扣留样本数（会话 + 先验合并后） */
export const MATURE_LIFT_MIN_SHADOW = 3

export class AdvisoryReadback {
  private pending: PendingExpectation[] = []
  private sequence = 0
  private unresolved: UnresolvedExpectation[] = []
  private completedTurns = new Set<number>()
  private profile: 'main' | 'worker' = 'main'
  private requireOpportunity = false
  configure(profile: 'main' | 'worker'): void { this.profile = profile; this.requireOpportunity = true }
  markResponseComplete(turn: number): void {
    this.completedTurns.add(turn)
    for (const t of this.completedTurns) if (t < turn - EVENT_RETENTION_TURNS) this.completedTurns.delete(t)
  }
  hasPending(key: string): boolean { return this.pending.some(p => p.key === key && !p.shadow) }
  drainUnresolved(): UnresolvedExpectation[] { const out = this.unresolved; this.unresolved = []; return out }
  private censor(p: PendingExpectation, turn: number, reason: UnresolvedExpectation['reason']): UnresolvedExpectation {
    return { deliveryId: p.deliveryId, profile: this.profile, episodeId: p.episode, reason, key: p.key, expectKind: p.expect.kind,
      deliveredTurn: p.deliveredTurn, turnsShort: Math.max(0, (p.expect.withinTurns ?? DEFAULT_WINDOW[p.expect.kind]) - this.opportunities(p, turn)), shadow: p.shadow }
  }
  private opportunities(p: PendingExpectation, turn: number): number {
    return this.requireOpportunity ? [...this.completedTurns].filter(t => t >= p.deliveredTurn && t <= turn).length : turn - p.deliveredTurn + 1
  }
  private events: ObservedToolEvent[] = []
  /** 策略核销周期（§3）：周期内首次出现的新族才核销，取代滚动的「前 3 轮」对照窗。 */
  private courseTracker = new CourseCorrectionTracker()
  /** 本策略周期内实际投递过（非 shadow）的 key——周期边界据此授予一次 probation。 */
  private episodeDeliveredKeys = new Set<string>()
  private courseKeys = new Set<string>()
  private stats = new Map<string, AdvisoryKeyStats>()
  private outcomes: AdvisoryOutcomeEvent[] = []
  /** 跨会话效能先验 — 只喂三个消费方(holdout 资格/副驾闸门/Top-N 次级排序),
   *  不进 getTotals/ignoredStreak(guardian meta 保持会话纯度,习惯化保持会话内) */
  private priors = new Map<string, EfficacyPriorCounts>()
  /** pattern_absent 判定用的文件读取器 — 注入以便测试;返回 null = 文件不存在 */
  constructor(private readFile: (path: string) => string | null = defaultReadFile) {}

  /** 注入跨会话先验(会话启动时一次)。 */
  seedPriors(priors: Iterable<[string, EfficacyPriorCounts]>): void {
    this.priors = new Map([...priors].filter(([, p]) => p.profile === this.profile && p.shadowDecided !== undefined))
  }

  /** 送达跟踪 — render 后调用。同 key 重复送达时重置观察窗口（不叠加 pending）。 */
  track(delivered: DeliveredAdvisory[], turn: number): void {
    for (const d of delivered) {
      const s = this.statsFor(d.key)
      const shadow = d.shadow === true
      if (shadow) s.shadowHeld++
      else s.delivered++
      if (!d.expect) continue
      const existing = this.pending.find(p => p.key === d.key)
      if (existing) {
        this.unresolved.push(this.censor(existing, turn, existing.shadow === shadow ? 'superseded' : 'contaminated'))
        this.pending = this.pending.filter(p => p !== existing)
        // A held-out sample following a real delivery is contaminated too.
        if (shadow && !existing.shadow) {
          this.unresolved.push(this.censor({ key: d.key, expect: d.expect, deliveredTurn: turn, shadow, deliveryId: `${this.profile}:${++this.sequence}`, episode: this.courseTracker.episode }, turn, 'contaminated'))
          continue
        }
      }
      const deliveryId = `${this.profile}:${++this.sequence}`
      if (d.expect.kind === 'course_changed') this.courseTracker.deliver(deliveryId)
      if (d.expect.kind === 'course_changed' || ['convergence', 'turn-call-limit'].includes(d.key)) {
        this.courseKeys.add(d.key)
        if (!shadow) this.episodeDeliveredKeys.add(d.key)
      }
      this.pending.push({ deliveryId, key: d.key, expect: d.expect, deliveredTurn: turn, shadow, episode: this.courseTracker.episode })
    }
  }

  /** 行为观察 — postTool 喂入本轮工具事件 */
  observeTool(event: ObservedToolEvent): void {
    this.events.push(event)
    this.courseTracker.observe(event)
    // 按轮跨度修剪（不按条数——重轮次 20+ 工具调用不能把窗口内证据挤掉）
    const cutoff = event.turn - EVENT_RETENTION_TURNS
    if (this.events.length > 0 && this.events[0]!.turn < cutoff) {
      this.events = this.events.filter(e => e.turn >= cutoff)
    }
  }

  /** 核销评估 — postTurn 调用。返回本轮判定数（0 = 无到期谓词）。 */
  evaluate(turn: number): number {
    if (this.pending.length === 0) return 0
    const still: PendingExpectation[] = []
    let decided = 0

    for (const p of this.pending) {
      const window = p.expect.withinTurns ?? DEFAULT_WINDOW[p.expect.kind]
      const expired = this.opportunities(p, turn) >= window

      let outcome: AdvisoryOutcome | null = null
      if (p.expect.kind === 'pattern_absent') {
        // 负向谓词只在到期时判定——过早读文件会把"还没来得及清"误判为忽略
        if (expired) {
          outcome = this.checkPatternAbsent(p.expect) ? 'adopted' : 'ignored'
        }
      } else {
        const satisfied = this.checkPositive(p.expect, p.deliveredTurn, turn, p.deliveryId)
        if (satisfied) outcome = 'adopted'
        else if (expired) outcome = 'ignored'
      }

      if (outcome === null) {
        still.push(p)
        continue
      }
      decided++
      const s = this.statsFor(p.key)
      if (p.shadow) {
        // 反事实组:只进 shadow 桶,不动 adopted/ignored/streak（不污染副驾闸门与习惯化）
        s.shadowDecided = (s.shadowDecided ?? 0) + 1
        if (outcome === 'adopted') s.shadowSatisfied++
      } else if (outcome === 'adopted') {
        s.adopted++
        s.ignoredStreak = 0
      } else {
        s.ignored++
        s.ignoredStreak++
      }
      this.outcomes.push({
        deliveryId: p.deliveryId, profile: this.profile,
        key: p.key,
        outcome,
        expectKind: p.expect.kind,
        deliveredTurn: p.deliveredTurn,
        evaluatedTurn: turn,
        ...(p.shadow ? { shadow: true } : {}),
      })
    }

    this.pending = still
    return decided
  }

  /**
   * 会话结束核销 — postSession 调用。先按当前证据跑一次正常 evaluate（到期的
   * 照常判定），再把仍未到期的 pending 清空并如实报告。
   *
   * 未到期的**不判 ignored**：advisory 在末轮送达时，模型根本没有走完观察窗口
   * 的机会，判忽略会把"没机会响应"记成"听了不做"。这类假 ignored 会经
   * ignoredStreak（习惯化静音）、efficacy 负反馈、跨会话 lift 先验三条路径压低
   * 该 key 的效力评分，最终静音掉本可能有效的提醒。worker 尤其吃这一刀——
   * 中位只跑 2 轮，而 verify_attempted 窗口 2 轮、pattern_absent 4 轮，几乎所有
   * pending 在会话结束时都未到期（实测 88 个 worker 只产出 3 条 outcome）。
   *
   * 所以这里只把它们作为 unresolved 报出去做观测，不进 adopted/ignored 账本。
   */
  flushAtSessionEnd(turn: number): { decided: number; unresolved: UnresolvedExpectation[] } {
    const decided = this.evaluate(turn)
    const unresolved = [...this.drainUnresolved(), ...this.pending.map(p => this.censor(p, turn, 'session_ended'))]
    this.pending = []
    return { decided, unresolved }
  }

  /** 读取并清空本次评估以来的判定事件（遥测落盘用） */
  drainOutcomes(): AdvisoryOutcomeEvent[] {
    const out = this.outcomes
    this.outcomes = []
    return out
  }

  /** per-key 累计统计快照 */
  getStats(): ReadonlyMap<string, AdvisoryKeyStats> {
    return this.stats
  }

  /** 连续忽略次数 — P1b 习惯化对抗的查询入口 */
  getIgnoredStreak(key: string): number {
    return this.stats.get(key)?.ignoredStreak ?? 0
  }

  /** 历史送达次数（含跨会话先验）— holdout 资格判定入口（key 送达 ≥N 次才开始抽样） */
  getDeliveredCount(key: string): number {
    return (this.stats.get(key)?.delivered ?? 0) + (this.priors.get(key)?.delivered ?? 0)
  }

  /**
   * 采纳率（会话实测 + 先验合并)— AdvisoryBus Top-N 同 priority 次级排序键。
   * 无决出样本返回 null(排序时视为中性)。
   */
  getAdoptionRate(key: string): number | null {
    const s = this.stats.get(key)
    const p = this.priors.get(key)
    const adopted = (s?.adopted ?? 0) + (p?.adopted ?? 0)
    const decided = adopted + (s?.ignored ?? 0) + (p?.ignored ?? 0)
    if (decided <= 0) return null
    return adopted / decided
  }

  /**
   * 决出样本数（会话实测 + 先验）— T7 效力排序的置信度分母。
   * 口径与 getAdoptionRate 一致：同源合并，避免"率含先验、样本数不含"的错配。
   */
  getDecidedCount(key: string): number {
    const s = this.stats.get(key)
    const p = this.priors.get(key)
    return (s?.adopted ?? 0) + (s?.ignored ?? 0) + (p?.adopted ?? 0) + (p?.ignored ?? 0)
  }

  /**
   * 反事实 lift — 投递组采纳率减扣留组自发完成率。
   * 正 lift = 提醒有真实增益;lift≈0 = 模型本来就会做（提醒是纯噪音）。
   * 任一组无决出样本时返回 null（数据不足,不下结论）。
   */
  getLift(key: string): number | null {
    const s = this.stats.get(key)
    if (!s) return null
    const decided = s.adopted + s.ignored
    if (decided === 0 || (s.shadowDecided ?? 0) === 0) return null
    return s.adopted / decided - s.shadowSatisfied / s.shadowDecided!
  }

  /**
   * 成熟 lift — 会话实测 + 跨会话先验合并计算,过成熟度门才下结论。
   * 会话内 holdout 积累极慢(单会话通常 0-2 个 shadow 样本),先验是冷启动的
   * 主数据源;EWMA 衰减保证陈旧历史权重递减。样本不足返回 null——
   * 消费端(负 lift 静音/排序升级)对 null 必须视为中性,不得下静音结论。
   */
  getMatureLift(key: string): number | null {
    const s = this.stats.get(key)
    const p = this.priors.get(key)
    const adopted = (s?.adopted ?? 0) + (p?.adopted ?? 0)
    const ignored = (s?.ignored ?? 0) + (p?.ignored ?? 0)
    const shadowDecided = (s?.shadowDecided ?? 0) + (p?.shadowDecided ?? 0)
    const shadowSatisfied = (s?.shadowSatisfied ?? 0) + (p?.shadowSatisfied ?? 0)
    const decided = adopted + ignored
    if (decided < MATURE_LIFT_MIN_DECIDED || shadowDecided < MATURE_LIFT_MIN_SHADOW) return null
    return adopted / decided - shadowSatisfied / shadowDecided
  }

  /**
   * Phase 2 自愈判定 — expect 谓词在 [sinceTurn, nowTurn] 观察窗口内是否已被
   * 自发满足（模型没被提醒就做了该做的事 → 挂起条目撤销,不投递）。
   * pattern_absent 直接读当前文件状态（已不在 = 已自愈）。
   */
  wasSatisfiedBetween(expect: AdvisoryExpectation, sinceTurn: number, nowTurn: number): boolean {
    if (expect.kind === 'pattern_absent') return this.checkPatternAbsent(expect)
    return this.checkPositive(expect, sinceTurn, nowTurn)
  }

  /**
   * T3 证据门数据源：暴露自 sinceTurn 以来的工具事件，
   * 映射为 evidence-gate 的 ToolHistoryEntry 格式。
   * readback 按轮保留（EVENT_RETENTION_TURNS=8），
   * 不受 recentToolHistory 5 条滚动窗口截断限制。
   */
  getRecentToolEvents(sinceTurn: number): ToolHistoryEntry[] {
    return this.events
      .filter(e => e.turn >= sinceTurn)
      .map(e => ({
        tool: e.name,
        target: e.target,
        turn: e.turn,
      }))
  }

  /** 会话累计采纳/忽略计数（guardian meta 摘要用,不含先验——会话纯度） */
  getTotals(): { adopted: number; ignored: number } {
    let adopted = 0
    let ignored = 0
    for (const s of this.stats.values()) {
      adopted += s.adopted
      ignored += s.ignored
    }
    return { adopted, ignored }
  }

  /**
   * 含先验的累计采纳/忽略 — 副驾可行性闸门用（消灭"每会话前十几轮沉睡"的
   * 冷启动)。先验决出样本贡献上限 PRIOR_DECIDED_CAP,按比例缩放保采纳率:
   * 陈旧历史只能开门,不能永久压制会话内的新证据。
   */
  getTotalsWithPriors(): { adopted: number; ignored: number } {
    const session = this.getTotals()
    let pAdopted = 0
    let pIgnored = 0
    for (const p of this.priors.values()) {
      pAdopted += p.adopted
      pIgnored += p.ignored
    }
    const pDecided = pAdopted + pIgnored
    if (pDecided > PRIOR_DECIDED_CAP) {
      const scale = PRIOR_DECIDED_CAP / pDecided
      pAdopted *= scale
      pIgnored *= scale
    }
    return { adopted: session.adopted + pAdopted, ignored: session.ignored + pIgnored }
  }

  /** 周期边界（§3 的结构化信号：人类新任务 / 人工引导 / 真实进展）。周期重启后
   *  此前见过的族重新变「新」，但周期起点时的当前动作继承为基线——重置本身
   *  不得制造新族。
   *
   *  发射侧同步贯通（计划 §3）：旧周期的未决观察记 superseded（那是「上一个任务
   *  里没等到机会」，不是「听了不做」——判 ignored 会经 ignoredStreak / efficacy
   *  负反馈 / lift 先验三条路径把本可能有效的提醒压死）；episode 内 ignoredStreak
   *  归零（不跨任务继承成永久门禁），但会话累计计数保留。返回本周期实际投递过的
   *  key——调用方据此授予 bus 一次 probation 资格（仍受正常候选门禁、预算与
   *  holdout 约束，实际非 shadow 投递后才消费）。
   */
  startCourseEpisode(reason: string, currentFamilies: Iterable<string> = []): string[] {
    const previous = this.courseTracker.episode
    this.courseTracker.startEpisode(reason, currentFamilies)
    // 属于刚结束那个周期的未决项：转 superseded 报出（"没等到机会"≠"听了不做"）。
    const superseded = this.pending.filter(p => p.episode === previous && this.courseKeys.has(p.key))
    for (const p of superseded) this.unresolved.push(this.censor(p, p.deliveredTurn, 'superseded'))
    this.pending = this.pending.filter(p => !superseded.includes(p))
    for (const key of this.courseKeys) { const s = this.stats.get(key); if (s) s.ignoredStreak = 0 }
    const keys = [...this.episodeDeliveredKeys]
    this.episodeDeliveredKeys.clear()
    return keys
  }

  /** 当前策略周期号（观测用）——由 task/guidance/进展边界推进。 */
  get courseEpisode(): number { return this.courseTracker.episode }

  reset(): void {
    this.pending = []
    this.events = []
    this.courseTracker.reset()
    this.courseKeys.clear()
    this.episodeDeliveredKeys.clear()
    this.stats.clear()
    this.outcomes = []
    this.priors.clear()
    this.unresolved = []
    this.completedTurns.clear()
  }

  private statsFor(key: string): AdvisoryKeyStats {
    let s = this.stats.get(key)
    if (!s) {
      s = { delivered: 0, adopted: 0, ignored: 0, ignoredStreak: 0, shadowHeld: 0, shadowSatisfied: 0, shadowDecided: 0 }
      this.stats.set(key, s)
    }
    return s
  }

  private checkPositive(
    expect: Exclude<AdvisoryExpectation, { kind: 'pattern_absent' }>,
    from: number,
    to: number,
    deliveryId?: string,
  ): boolean {
    const windowEvents = this.events.filter(e => e.turn >= from && e.turn <= to)
    switch (expect.kind) {
      case 'tool_appears':
        return windowEvents.some(e => {
          if (expect.tools.length > 0 && !expect.tools.includes(e.name)) return false
          if (expect.targetIncludes && !e.target.includes(expect.targetIncludes)) return false
          return true
        })
      case 'verify_attempted':
        return windowEvents.some(e =>
          e.verificationAttempted ?? verificationAttempted(e.name, { command: e.target }),
        )
      case 'file_touched':
        return windowEvents.some(e => expect.paths.some(p => e.target.includes(p)))
      case 'course_changed':
        // 核销路径（有投递基线）按策略周期判：投递后同周期首次出现的新族才算改道。
        // Phase 2 自愈（挂起条目，无投递）退回「窗口起点后出现新族」——同一族事实，
        // 对照周期内累积而非滚动三轮窗口（滚动窗口曾让同一失败验证每周期重新变「新」）。
        return deliveryId !== undefined
          ? this.courseTracker.satisfies(deliveryId)
          : this.courseTracker.sawNovelFamilySince(from)
    }
  }

  private checkPatternAbsent(expect: Extract<AdvisoryExpectation, { kind: 'pattern_absent' }>): boolean {
    const content = this.readFile(expect.path)
    if (content === null) return true // 文件已删除 = 探针已不存在
    return !expect.needles.some(n => content.includes(n))
  }
}

function defaultReadFile(path: string): string | null {
  try {
    // 仅 pattern_absent 到期时读一次,源码文件同步读可接受
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
