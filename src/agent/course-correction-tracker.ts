/**
 * 策略核销周期（收敛改道补修计划 §3「修复 B」）。
 *
 * 问题形态（已实测复现）：`course_changed` 粗签名原先只跟「前 3 轮」对照，而窗口
 * 是滚动的——反复「读三轮 → 同一失败 npm test」每周期都能让 verify 族重新变
 * 「新」，六周期六次假 adopted。对照实验（`.rivet/scratch/plan-course-cycle-repro.ts`，
 * 父提交 be0a5d361 隔离树）：同一轨迹在旧签名下六次 ignored，族级签名下六次
 * adopted——这正是核销环被反复清零、静音永不生效的机制。
 *
 * 修复方向不是把签名再改细，而是换**核销周期**：一个「有真实进展之前」的策略
 * 周期内累积已见工具族；只有投递之后、同周期内**首次**出现的族才算改道。周期由
 * 结构化边界（人类新任务 / 人工引导 / 真实进展）重启，既不是每张提醒重建前三轮
 * 集合，也不是会话终身集合永远禁止再次采纳。
 *
 * 它只判「是否换了种做法」，不判成功：一次首次尝试的新验证即使失败也算采纳行动
 * （失败不开启新周期）；采纳也不是成功，不泄漏到任何通过语义里。
 */

import { isVerificationIntent } from './verification-activity.js'

/** 观察到的工具事件（与 advisory-readback 的 ObservedToolEvent 同形）。 */
export interface CourseEvent {
  turn: number
  name: string
  target: string
  /** 明确只读的 shell 调用（由 bash 活动分类填充）——与 read 族同归一类。 */
  readonlyShell?: boolean
  verificationAttempted?: boolean
  verificationPurpose?: import('./verification-intent.js').VerificationPurpose
}

/** 工具族映射。未列出的工具以**自身稳定工具名**为族——绝不用 target 自由文本
 *  （那会让每个新文件路径都成为一族，回到"恒满足"的老路）。 */
const TOOL_FAMILY: ReadonlyMap<string, string> = new Map([
  ['edit_file', 'edit'], ['write_file', 'edit'], ['hash_edit', 'edit'],
  ['apply_patch', 'edit'], ['ast_edit', 'edit'],
  ['read_file', 'read'], ['read_section', 'read'], ['grep', 'read'],
  ['glob', 'read'], ['list_dir', 'read'], ['file_info', 'read'],
  ['run_tests', 'verify'], ['typecheck', 'verify'], ['lsp_diagnostics', 'verify'],
])

/** 族判定：读/写/验证按表归并；bash 细分出 verify（验证类命令）与 read（明确只读）——
 *  「只读侦察换个外衣」（只读 bash → read_file）不得算改道。 */
export function courseFamily(e: CourseEvent): string {
  const family = TOOL_FAMILY.get(e.name) ?? e.name
  if (family !== 'bash') return family
  if (e.verificationPurpose !== undefined ? e.verificationPurpose !== 'none'
    : e.verificationAttempted || isVerificationIntent(e.target)) return 'verify'
  if (e.readonlyShell) return 'read'
  return 'bash'
}

interface DeliveryBaseline {
  /** 投递时的周期号——跨周期一律不核销（旧提醒已被进展/新任务替代）。 */
  episode: number
  /** 投递时刻的事件序号（解决同一轮内多个工具与投递的先后）。 */
  seq: number
  /** 投递时刻的不可变族集合。 */
  baseline: ReadonlySet<string>
}

const MAX_BASELINES = 128

export class CourseCorrectionTracker {
  private seq = 0
  private episodeId = 0
  private seen = new Set<string>()
  private firstSeen = new Map<string, { seq: number; turn: number }>()
  private lastFamily: string | null = null
  private baselines = new Map<string, DeliveryBaseline>()
  /** 周期开启原因（有界观测）——task / guidance / progress 分别可查。 */
  private reasons: string[] = []

  /** 当前周期号（观测用）。 */
  get episode(): number { return this.episodeId }
  /** 本周期已见族（观测/测试用）。 */
  get seenFamilies(): ReadonlySet<string> { return this.seen }
  /** 最近一次周期开启原因（观测：task / guidance / progress）。 */
  get lastEpisodeReason(): string | null { return this.reasons.at(-1) ?? null }

  /** 工具观察——普通动作不断累积族集合。 */
  observe(e: CourseEvent): void {
    const family = courseFamily(e)
    this.seq++
    if (!this.seen.has(family)) this.firstSeen.set(family, { seq: this.seq, turn: e.turn })
    this.seen.add(family)
    this.lastFamily = family
  }

  /** 改道投递——记录周期号、当时事件序号与不可变基线。 */
  deliver(deliveryId: string): void {
    this.baselines.set(deliveryId, { episode: this.episodeId, seq: this.seq, baseline: new Set(this.seen) })
    while (this.baselines.size > MAX_BASELINES) {
      const oldest = this.baselines.keys().next().value
      if (oldest === undefined) break
      this.baselines.delete(oldest)
    }
  }

  /** 本次投递是否被「同周期内首次出现的新族」满足。无基线记录时保守返回 false
   *  （不凭观察窗猜——猜错就是又一次假采纳）。 */
  satisfies(deliveryId: string): boolean {
    const b = this.baselines.get(deliveryId)
    if (!b) return false
    if (b.episode !== this.episodeId) return false
    return [...this.firstSeen].some(([family, e]) => e.seq > b.seq && !b.baseline.has(family))
  }

  /**
   * 自 `turn` 起是否出现过「相对该时点已见集合」的新族——供 Phase 2 自愈判定
   * （挂起条目在观察窗内被自发满足 → 撤销不投递）。与核销路径共用同一族事实，
   * 但对照的是**周期内累积**而非滚动三轮窗口。
   */
  sawNovelFamilySince(turn: number): boolean {
    return [...this.firstSeen.values()].some(e => e.turn >= turn)
  }

  /**
   * 开启新周期（人类新任务 / 人工引导 / 真实进展的结构化边界）。
   *
   * `currentFamilies` 之外的族一律重新变「新」——周期不是会话终身集合；但
   * **当前动作**自动继承进新周期基线：否则"重置那一刻正在做的事"会在下一轮
   * 立刻自证为改道（重置本身不得制造新族）。
   */
  startEpisode(reason: string, currentFamilies: Iterable<string> = []): void {
    this.episodeId++
    this.reasons.push(reason)
    if (this.reasons.length > 32) this.reasons.shift()
    const inherited = new Set(currentFamilies)
    if (this.lastFamily) inherited.add(this.lastFamily)
    this.seen = inherited
    this.firstSeen.clear()
    for (const [id, b] of this.baselines) if (b.episode !== this.episodeId) this.baselines.delete(id)
  }

  /** 会话切换 / profile 切换清理。 */
  reset(): void {
    this.seq = 0
    this.episodeId = 0
    this.seen = new Set()
    this.firstSeen.clear()
    this.lastFamily = null
    this.baselines.clear()
    this.reasons = []
  }
}
