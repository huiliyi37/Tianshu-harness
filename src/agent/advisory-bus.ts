import type { SrClass } from './context.js'

/**
 * 统一劝导总线 — 将五条独立纠偏通道收敛为单一 <星域-advisory> 汇聚器。
 *
 * 通道来源：
 *   1. immune projection（loop.ts — 自体免疫投射）
 *   2. repair-hint appendix（volatile.ts — 修复提示）
 *   3. MistakeNotebook（tool-pipeline.ts — 工具错误模式匹配）
 *   4. dedup-guard（dedup-guard-hook.ts — 重复输出检测）
 *   5. stigmergy dead-end（signal-consumer-hook.ts — 死路信号）
 *
 * 约束：
 *   - constitutional tier 条目永不被截断
 *   - non-constitutional 条目每轮最多 3 条（operational 优先，informational 填空）
 *   - 同 key 去重（同一劝导不在同轮重复出现）
 */

export type AdvisoryTier = 'constitutional' | 'operational' | 'informational'

/**
 * expect 谓词 — 描述"这条提醒被采纳时,后续轮次应该能观察到什么行为"。
 *
 * P1a（2026-07-04 advisory 生命周期设计）：advisory 此前是发后不管的
 * 单向广播——没人知道模型是否照做。expect 让每条提醒携带一个可客观核销
 * 的行为签名,postTurn 由 advisory-readback-hook 对照 turn 级工具事件核销,
 * 产出 adopted/ignored 账本（习惯化对抗与 Phase 3 降频的数据地基）。
 *
 * 语义约定:
 *   - `withinTurns`: 观察窗口（含送达轮）,缺省 1 = 只看送达当轮。
 *   - `tool_appears` 的 `tools: []` 表示"任意工具调用即算采纳"
 *     （即计划中的 tool_stops 反向谓词:无工具僵局被打破）。
 *   - `pattern_absent` 是负向谓词:到期时目标文件不再包含任何 needle
 *     （子串匹配,如探针残留的行内容）→ 采纳。文件消失也算采纳。
 */
export type AdvisoryExpectation =
  | {
      kind: 'tool_appears'
      tools: string[]
      /** 可选 target 约束 — 工具的 target 需包含此片段（如特定文件路径） */
      targetIncludes?: string
      withinTurns?: number
    }
  | { kind: 'verify_attempted'; withinTurns?: number }
  | { kind: 'file_touched'; paths: string[]; withinTurns?: number }
  | { kind: 'pattern_absent'; path: string; needles: string[]; withinTurns?: number }
  | {
      /** 改道核销（B1/M4，2026-07-23 信号互扰治理）：观察窗内出现前置对照窗
       *  （送达前 3 轮）未见过的 (工具族×文件面) 粗签名 → adopted。前置窗
       *  无事件时任意工具事件即 adopted（与 tool_appears tools:[] 的
       *  "打破无工具僵局"语义一致）。 */
      kind: 'course_changed'
      withinTurns?: number
    }

/**
 * Phase 2 投递通道（2026-07-04 生命周期设计）：
 *   'bus'（缺省）— `<星域-advisory>` 附录块,下个请求构建时可见（粗断点）
 *   'system-reminder' — session.appendSystemReminder 进消息流（细断点,
 *     模型必读通道；缓存安全:只追加尾部,不重写历史）
 *   'status' — 仅进 TUI 状态区不进 prompt（dark cockpit 单感官通道）。
 *     无 status sink 时回退 bus 渲染——宁可占预算不静默消失。
 */
export type AdvisoryChannel = 'bus' | 'system-reminder' | 'status'

export interface AdvisoryEntry {
  /** 去重键 — 同 key 在同轮只保留优先级最高的一条 */
  key: string
  /** 优先级，越高越靠前（0-1 归一化） */
  priority: number
  /** 分类标签 */
  category: AdvisoryCategory
  /** 渲染内容 — 单行纯文本，不包含 XML 标签 */
  content: string
  /** 优先级层 — constitutional 永不被截断，operational 参与 Top-N，informational 填空 */
  tier?: AdvisoryTier
  /** TTL（轮次），默认为 1（仅本轮） */
  ttl?: number
  /** 采纳核销谓词 — 缺省则该条不参与采纳率统计（只计送达） */
  expect?: AdvisoryExpectation
  // ── Phase 2 生命周期字段 ──
  /** 跳过挂起观察与阶段抑制,直达投递（按 hook 语义标记,如 git-clear 事后守护） */
  immediate?: boolean
  /** 挂起观察:先挂 N 个渲染周期。窗口内 expect 谓词已被自发满足 → 自愈撤销
   *  （不投递）;被其他条目 corroborates 指认 → 提前确认;到期 → 强制送达。
   *  constitutional / immediate 条目忽略此字段。 */
  observe?: { turns: number }
  /** 多信号确认:本条目作为独立信号,可提前确认这些 key 的挂起条目
   *  （独立性由提交方保证:不同 phase 或不同 category 的 hook 才互相指认） */
  corroborates?: string[]
  /** 投递通道,缺省 'bus' */
  channel?: AdvisoryChannel
  /** W2 通道分级：SR 载荷类别，缺省 'discipline'。仅 channel='system-reminder' 的条目使用。
   *  'functional' 类不限流（调用方自带 run 级闩锁），仅 git-clear-after-fail 标记。 */
  srClass?: SrClass
}

/** render() 实际送达的条目快照 — 供 readback 跟踪（send 侧账本的"已送达"半边） */
export interface DeliveredAdvisory {
  key: string
  category: AdvisoryCategory
  tier?: AdvisoryTier
  expect?: AdvisoryExpectation
  /** holdout 反事实组:该条赢得渲染位但被静默扣留（未渲染）,readback 核销进 shadow 桶 */
  shadow?: boolean
}

export type AdvisoryCategory =
  | 'immune'
  | 'repair'
  | 'mistake'
  | 'dedup'
  | 'dead_end'
  | 'cerebellar'
  | 'discipline'
  | 'encouragement'
  | 'constitutional'
  | 'delegation'
  | 'typecheck'
  | 'todo'
  | 'background'
  /** Monitor 工具的事件流（monitor-hook 投递）——独立类别，不与 background
   *  争 MAX_PER_CATEGORY 预算（background-jobs hook 每轮也占 1 条）。 */
  | 'monitor'
  /** 星域路由（CCR）与胶囊召回 — 独立类别，不与 discipline 争 MAX_PER_CATEGORY
   *  预算（2026-07-04 触发面修复：discipline 赛道扩容后 CCR 0.55 常被挤出）。 */
  | 'star_domain'

/**
 * 宪法级优先级 — 构成性规则（不可违抗的行为底线）。
 *
 * 高于所有管制性条目（discipline/repair/mistake 等最高 0.65），
 * 确保宪法 violation 信号不会被习惯化对抗 / 纪律重锚条目挤掉。
 * 用于信念宪法退化的恢复：当 sycophancy trap 检测到连续投降 +
 * confidence 递减模式时，courage-hook 通过 advisory bus 投递的
 * 宪法级 entry 必须始终获得渲染位（不受每轮 3 条上限挤压）。
 */
export const CONSTITUTIONAL_PRIORITY = 0.9

/** 每轮最大渲染条数（non-constitutional 上限） */
const MAX_ADVISORIES_PER_TURN = 3
/** 天权/瑶光等自主判断型星域的上限——这些星域有自己的判断力，过度提醒是噪音 */
const SELF_DIRECTED_DOMAIN_BUDGET = 1

/** 星域感知的 advisory 轮预算：自主判断型（天权/瑶光）减量，其余保持全局上限 */
function advisoryBudgetForDomain(activeStarDomain?: string): number {
  if (activeStarDomain === '天权' || activeStarDomain === '瑶光') return SELF_DIRECTED_DOMAIN_BUDGET
  return MAX_ADVISORIES_PER_TURN
}

/** 每个 category 最多保留条数，防止单一信号源垄断 advisory 预算 */
const MAX_PER_CATEGORY = 2
/** W2 SR 有界携带：SR 被 cap 拦截后最多 requeue 次数（跨轮延迟送达上限） */
const SR_CARRY_LIMIT = 2

/** A4 互斥对（2026-07-23 信号互扰治理 H4；机制回收自 V4 桌面变体）：
 *  同一 render 周期内语义冲突的两个信号同时在场时，确定度低的一方（loser）
 *  让位丢弃。首个已知冲突：lossy-observation（观测确实被截断——事实）胜过
 *  readonly-spiral（"信息可能已足够，开始行动"——启发式）。观测有损时
 *  "已足够"不成立，同轮双发会同时催"继续交叉验证"和"停止读取"。 */
const MUTEX_PAIRS: ReadonlyArray<{ winner: string; loser: string }> = [
  { winner: 'lossy-observation', loser: 'readonly-spiral' },
  // W3 穿透让位（2026-07-25 advisory-ecology-repair）：验证债在场时表扬让位。
  // 「你有债」和「干得好」同屏是语义冲突——714c5d9b 里 self-verify 被忽略、
  // 同轮表扬照发，验证债类缺陷（contract 死接线）从提醒眼皮底下逃逸。
  // 匹配是精确 key 等值，不支持通配——CCR 验证债 key 增多时逐条补录。
  { winner: 'self-verify', loser: 'virtue-encouragement' },
  { winner: 'self-verify-scope-mismatch', loser: 'virtue-encouragement' },
  { winner: 'ccr-天权-P3', loser: 'virtue-encouragement' },
  { winner: 'ccr-天权-P7', loser: 'virtue-encouragement' },
]

/** W2 结算限流（2026-07-25 advisory-ecology-repair）：key 级送达冷却。
 *  注册表中的 key 距上次实际送达不足 N 轮时，本轮参赛条目直接吞掉并计入
 *  dropped 遥测。动机：virtue-settlement-hook 每次美德结算提交一次表扬
 *  （实测 9-88 次/会话），表扬的信息量在节奏确认而非重复计数。
 *  门禁放 bus 层而非 hook 层——送达历史在 bus 手边，且天然覆盖未来任何调用方。 */
export const KEY_COOLDOWN_TURNS: ReadonlyMap<string, number> = new Map([
  ['virtue-encouragement', 5],
  // 系统提醒冷却（2026-07-28 session 0087edf0）：readonly-spiral 和
  // turn-call-limit 在 advisory 洪水期反复弹窗加剧噪音。key 级冷却确保
  // 同一提醒不在连续轮次重复注入。
  ['readonly-spiral', 3],
  ['turn-call-limit', 3],
])

// ─── F-fix（session 803d897d）：纪律抗习惯化重锚 ─────────────────────
// execute 阶段 field habituation（alpha=0.35）让 activeDomain 纪律约 4 轮后
// 移入 consolidated 区；单轮 20+ 工具调用后纪律文本落后数万 token。
// 每 N 次工具调用经 advisory bus 重锚一行纪律摘要——走 dynamic appendix
// 单一出口，缓存安全，不豁免习惯化、不动 frozen 前缀。

/** 每多少次工具调用重锚一次纪律摘要 */
export const DISCIPLINE_REANCHOR_INTERVAL = 15

/**
 * 纪律同义改写池 — 每次重锚随机选取一个表述。
 * 同义替换让长会话中同一纪律点以不同字节出现，
 * 抵抗 attention-level 习惯化（字段级习惯化由 FieldHabituationTracker 处理，
 * 这里处理文本级习惯化）。
 */
const DISCIPLINE_VARIANTS: string[] = [
  '【天梁】交付纪律重锚：新增字段/符号先 grep 读侧消费方（0 消费方 = 死接线）；改行为先跑 related_tests；闭环 = 从生产入口正向追到改动点，typecheck 绿 ≠ 闭环。',
  '【天梁】接线检查：新增 export 前 grep 谁会 import 它——无消费方说明接线断裂。改逻辑后 related_tests 必须跑过。验证闭环 = 入口到改动点全路径通。',
  '【天梁】交付前自检：新符号有消费方吗？行为变更有测试覆盖吗？从真实入口能追踪到你的改动吗？三个"是"才算闭环。',
  '【天梁】节奏检查：读→改→验证→提交，这四步跳了哪步？改了什么就验证什么，不积累未验证的改动。',
  '【天梁】分波纪律：当前铺开了几个任务？>=4 就该分波。"完成感"压过验证纪律是分波要防的失败模式。',
  '【天梁】闭环追踪：改了数据流字段？grep 所有消费方。新建了模块？验证至少一个调用方在使用。管道通了不算完，数据走通才算。',
]

/** 单行交付纪律摘要 — 每次调用随机选取同义表述以抵抗文本级习惯化 */
export function disciplineReanchorEntry(): AdvisoryEntry {
  const variant = DISCIPLINE_VARIANTS[Math.floor(Math.random() * DISCIPLINE_VARIANTS.length)]!
  return {
    key: 'discipline-reanchor',
    priority: 0.55,
    category: 'discipline',
    content: variant,
  }
}

// 死代码清理（2026-07-04）：deprecated 的 stalenessGateEntry / vigorLowEntry 已删除。
// 它们声称"被 CCR P2/P3 替代"，但 P2 早已被裁（c43660f0）且两函数零生产调用方——
// 胶囊召回的提醒通路由此断裂。召回现在是 CCR 触发的一等附属（见 cognitive-capsule-router.ts）。

// ─── 正向激励条目 ─────────────────────────────────────────────────
// 当 agent 做出好的决策时，通过 advisory bus 注入简短的正向反馈。
// 归属到对应的星域，让 agent 感知到多元认知场的存在。

const VIRTUE_ENCOURAGEMENT_VARIANTS: string[] = [
  '【瑶光】好的决策——你在验证之前没有跳到下一个任务。这种节奏值得保持。',
  '【天权】称量到位——改动和验证形成了闭环。继续保持这个审查精度。',
  '【天梁】执行节奏优秀——读→改→验证→提交，四步无遗漏。',
]

export function virtueEncouragementEntry(): AdvisoryEntry {
  const variant = VIRTUE_ENCOURAGEMENT_VARIANTS[Math.floor(Math.random() * VIRTUE_ENCOURAGEMENT_VARIANTS.length)]!
  return {
    key: 'virtue-encouragement',
    priority: 0.4,
    // W2 表扬治理（2026-07-25）：正向激励归 'encouragement'——进 flow 抑制白名单，
    // 产出流中自动推迟。此前挂 'discipline' 绕过阶段抑制，高产会话被自己的表扬刷屏
    // （实测 9-88 次结算/会话，见 docs/design/2026-07-25-advisory-ecology-repair.md C-C）。
    category: 'encouragement',
    content: variant,
    ttl: 1,
  }
}

// 死代码清理（2026-07-25 W2）：testPassEncouragementEntry / vigorRecoveryEntry 已删除。
// 两函数自引入起零调用方——定义至今无人接线说明该正向反馈点从未被需要过。
// 若日后要在测试通过 / vigor 恢复处发声，按彼时语境重写（category 用 'encouragement'）。

/**
 * 投递账本快照 — 自上次 drain 以来的投递/渲染/丢弃计数。
 * Phase 0 观测：advisory 被预算挤掉时不再静默——被丢弃的 key 可从遥测回放。
 */
export interface AdvisoryLedgerDelta {
  /** submit/submitAll 收到的条目数 */
  submitted: number
  /** render 实际输出的条目数 */
  rendered: number
  /** 参与竞争但未获渲染位的条目数（含星域过滤、类别上限、Top-N 截断） */
  dropped: number
  /** 被丢弃条目的 key（去重后，最多保留最近 50 个） */
  droppedKeys: string[]
  /** 负 lift 静音丢弃数（"没提醒也会做"的纯噪音 key,已计入 dropped） */
  liftMuted: number
  /** Phase 2:进入挂起观察 / 被阶段抑制推迟的条目数（挂起 ≠ 丢弃） */
  deferred: number
  /** Phase 2:挂起期内自愈撤销的条目数（模型自发做了该做的事,提醒作废） */
  revoked: number
  /** holdout:赢得渲染位但被反事实扣留的条目数 */
  heldOut: number
  /** Wave 1:SR 通道提交数（经 drainSystemReminders 取出前计数） */
  srSubmitted: number
  /** Wave 1:SR 被 SessionContext cap 丢弃数（未进入 delivered 桶） */
  srDropped: number
  /** W2:SR 被 cap 拦截后 requeue 携带次数（跨轮延迟送达） */
  srCarried: number
}

const LEDGER_DROPPED_KEYS_CAP = 50

// ─── P1b 习惯化对抗 ────────────────────────────────────────────────
// 核销账本（AdvisoryReadback）显示某 key 连续被忽略时的两级反应：
//   streak >= 2 → 升级措辞：在条目前标注"已连续 N 次未见执行"——被忽略的
//     事实本身是新信息，比原文重复更能穿透注意力习惯化。
//   streak >= 3 → 有界静音：连续无效的提醒是纯噪音，静音 N 个渲染周期。
//     期满放行一次（probation）：若那次被采纳则 streak 清零恢复正常；
//     仍被忽略（streak 增长）才再次静音。constitutional tier 永不静音。

/** 触发升级措辞的最低连续忽略次数 */
export const HABITUATION_ESCALATE_STREAK = 2
/** 触发静音的最低连续忽略次数 */
export const HABITUATION_SILENCE_STREAK = 3
/** 每次静音持续的渲染周期数 */
export const HABITUATION_SILENCE_RENDERS = 4

/** 负 lift 静音的渲染周期数（期满 probation 放行一次收集新证据） */
export const LIFT_MUTE_RENDERS = 10
/** lift ≤ 此阈值判定为"提醒无真实增益"（成熟样本前提下） */
export const LIFT_MUTE_THRESHOLD = 0

// ─── W2 efficacy 负反馈环（incident 20b9714e）────────────────────────
// efficacy 台账一直在如实记录 delivered/adopted，但发射侧从不回读——
// convergence advisory 同会话送达 32 次、采纳 0 次仍照发不误。
// 规则（仅会话内生效，不做跨会话全局静默）：
//   delivered ≥ 3 且 adopted = 0 → 进入冷却，每次送达冷却翻倍（2→4→8…）
//   delivered ≥ 6 仍零采纳 → 本会话静默该 key
// fail-open 豁免：constitutional tier 或 priority ≥ 0.8 的条目不受此环约束。

/** 进入冷却翻倍的最低会话内送达次数（零采纳前提） */
export const EFFICACY_COOLDOWN_DELIVERED = 3
/** 触发会话内静默的送达次数（零采纳前提） */
export const EFFICACY_SILENCE_DELIVERED = 6
/** 冷却初值（渲染周期），此后每次送达翻倍 */
export const EFFICACY_BASE_COOLDOWN_RENDERS = 2

/** 会话内 per-key 效能计数查询 — 由 AdvisoryReadback 会话统计实现 */
export interface EfficacyStatsProvider {
  (key: string): { delivered: number; adopted: number } | null
}

// ─── T7 效力排序（2026-08-04 advisory 反馈环）──────────────────────
// 效力数据此前只在 priority 完全相等时做 tie-break（compareEntries 的
// secondaryScore），而各 hook 的 priority 高度分散（0.4/0.45/0.55/0.58/
// 0.6/0.65/0.68/0.7/0.79），精确相等极罕见——adoptionRate 与 lift 排序在
// 生产中近乎死代码。两天日志实测：self-verify（priority 0.58、采纳率 77%）
// 被丢弃 319 次全场最多，而 todo-missing（priority 0.70、采纳率 12%）稳定
// 占用槽位——0.70 恒大于 0.58，效力数据一次都没被查询过。
//
// 改为让效力在有界区间内调整有效优先级，使"说了有人听"的提醒能跨 priority
// 赢得预算。三道防线沿用 T6 正向臂：不 mutation 条目（alive 跨渲染周期持有
// 同一批引用，原地累加会复合）、cap 不越 0.8 fail-open 豁免线、无样本视为
// 中性零调整（无数据时行为与改动前逐位一致）。

/** 效力对有效优先级的最大调整幅度（±）。可用 RIVET_ADVISORY_EFFICACY_SPAN 覆盖。 */
export const DEFAULT_EFFICACY_PRIORITY_SPAN = 0.15
/** 采纳率达到满置信度所需的决出样本数；不足按比例缩放调整幅度 */
export const EFFICACY_CONFIDENT_SAMPLES = 5
/** 调整后的有效优先级下限——再低也保留参赛资格，不等于静音 */
export const EFFICACY_PRIORITY_FLOOR = 0.05
/** 调整后的有效优先级上限——不得触及 0.8 的 efficacy fail-open 豁免线 */
export const EFFICACY_PRIORITY_CAP = 0.79

/** RIVET_ADVISORY_EFFICACY_SPAN 解析：合法 [0,0.5] 数字生效，'0' 关闭调整，非法/缺省用默认值 */
export function parseEfficacySpan(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_EFFICACY_PRIORITY_SPAN
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 0.5) return DEFAULT_EFFICACY_PRIORITY_SPAN
  return n
}

/**
 * 效力信号 — 供有效优先级做有界调整。
 * `score` 归一 [0,1]（0.5 = 中性），`confidence` 归一 [0,1]（样本充分度）。
 * null = 无样本，排序零调整。
 */
export interface EfficacySignalProvider {
  (key: string): { score: number; confidence: number } | null
}

/** 习惯化查询接口 — 由 AdvisoryReadback 实现（结构化鸭子类型，便于测试） */
export interface HabituationPolicy {
  getIgnoredStreak(key: string): number
}

// ─── Holdout 反事实抽样（因果账本,2026-07-04 天枢复核版）────────────
// 采纳率度量的是相关性——"送达后 2 轮内出现验证"可能是模型本来就要做。
// 按小概率把赢得渲染位的条目静默扣留（不渲染,照常核销 expect）,对比
// 投递组采纳率 vs 扣留组自发完成率 → 每 key 的真实 lift。
// 本轮只度量不自动退役;lift 数据积累后再做规则退役。

/** holdout 缺省抽样率。可用 RIVET_ADVISORY_HOLDOUT 环境变量覆盖（0 关闭）。 */
export const DEFAULT_HOLDOUT_RATE = 0.1
/** key 历史送达 ≥N 次才开始抽样——冷 key 先积累投递组基数 */
export const HOLDOUT_MIN_DELIVERED = 3

/** RIVET_ADVISORY_HOLDOUT 解析:合法 [0,1] 数字生效,'0' 关闭,非法/缺省用默认率 */
export function parseHoldoutRate(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_HOLDOUT_RATE
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_HOLDOUT_RATE
  return n
}

/** holdout 策略 — 资格历史判定由调用方注入（AdvisoryReadback / 效能信息素先验） */
export interface HoldoutPolicy {
  /** 抽样率 [0,1],0 = 关闭 */
  rate: number
  /** key 级资格（如历史送达 ≥ HOLDOUT_MIN_DELIVERED） */
  isEligible(key: string): boolean
  /** 可注入 RNG（测试确定性）,缺省 Math.random */
  rng?: () => number
}

// ─── Phase 2 打断调度常量 ─────────────────────────────────────────
// 阶段抑制白名单（天枢建议,已核准）：仅抑制锦上添花类信号。
// discipline / constitutional / star_domain 不受阶段抑制——抑制判据（产出流）
// 与守护触发判据（如连续无工具）不是同一信号,全局静音会误杀守护。
const FLOW_SUPPRESSIBLE_CATEGORIES: ReadonlySet<AdvisoryCategory> = new Set(['encouragement', 'typecheck'])
/** 阶段抑制最多推迟的渲染周期数 — 到限强制送达（TTL 强制送达红线） */
const FLOW_SUPPRESS_MAX_DEFERRALS = 2

export class AdvisoryBus {
  private entries: AdvisoryEntry[] = []
  /** 存活条目 — 未过期的跨轮条目 */
  private alive: AdvisoryEntry[] = []
  // ── 投递账本（Phase 0 观测）──
  private ledgerSubmitted = 0
  private ledgerRendered = 0
  private ledgerDropped = 0
  private ledgerDroppedKeys: string[] = []
  // ── P1a 核销闭环：render 实际送达的条目（供 advisory-readback 追踪采纳） ──
  private delivered: DeliveredAdvisory[] = []
  // ── P1b 习惯化对抗 ──
  private habituation: HabituationPolicy | null = null
  /** key → 剩余静音渲染周期数 */
  private silenceRemaining = new Map<string, number>()
  /** key → 上次触发静音时的 ignoredStreak（防止同一 streak 反复静音，保证 probation 放行） */
  private lastSilencedStreak = new Map<string, number>()
  // ── Phase 2 状态机 ──
  private ledgerDeferred = 0
  private ledgerRevoked = 0
  /** 挂起观察中的条目（candidate → pending）。挂起态不渲染 = 不产生附录抖动。 */
  private pendingWatch: Array<{ entry: AdvisoryEntry; startTurn: number; waitedRenders: number }> = []
  /** 阶段抑制推迟的条目（保 TTL 强制送达:deferrals 到上限必须投递） */
  private suppressedCarry: Array<{ entry: AdvisoryEntry; deferrals: number }> = []
  /** 自愈判定 — 挂起窗口内 expect 谓词是否已被自发满足（wire 到 AdvisoryReadback） */
  private selfHealCheck: ((expect: AdvisoryExpectation, sinceTurn: number, nowTurn: number) => boolean) | null = null
  /** 产出流判定 — true 时对白名单类别做阶段抑制（navigator 沉默规则） */
  private flowStateProvider: (() => boolean) | null = null
  /** status 通道 sink — 未设置时 status 条目回退 bus 渲染（不静默消失） */
  private statusSink: ((entries: AdvisoryEntry[]) => void) | null = null
  /** system-reminder 通道待送内容（drainSystemReminders 取走）。
   *  Wave 1 SR 账本修正：改为 `{key, content}` 对，供调用方回调确认送达/丢弃。
   *  W2 通道分级：增加 srClass 字段供调用方透传给 SessionContext。
   *  A3（信号互扰治理 H6）：增加 priority——drain 按优先级降序出队，
   *  discipline 每用户轮 1 条的额度归最高优先级信号，不再插入序先到先得。 */
  private systemReminderOut: Array<{ key: string; content: string; srClass: SrClass; priority: number }> = []
  /** Wave 1：等待回调确认的 SR 条目（render 产出但尚未经 SessionContext 确认）。 */
  private srPendingDelivery = new Map<string, AdvisoryEntry>()
  /** W2：key → requeue 携带次数（跨轮延迟送达追踪，超 SR_CARRY_LIMIT 则 dropped）。 */
  private srCarryCount = new Map<string, number>()
  /** W2 结算限流：KEY_COOLDOWN_TURNS 注册 key → 上次实际送达的单调渲染序号。 */
  private lastDeliveredRenderByKey = new Map<string, number>()
  /** 会话内单调渲染序号。不能使用 render(turn) 的 run-local turn；它每次 run 都从 0 重置。 */
  private renderEpoch = 0
  /** Wave 1 账本：SR 提交数与被 SessionContext cap 丢弃数。 */
  private ledgerSrSubmitted = 0
  private ledgerSrDropped = 0
  /** W2：SR requeue 携带次数（跨轮延迟送达计数）。 */
  private ledgerSrCarried = 0
  // ── Holdout 反事实抽样 ──
  private holdout: HoldoutPolicy | null = null
  private ledgerHeldOut = 0
  /** Top-N 同 priority 次级排序键 — 历史采纳率（跨会话先验 + 会话实测,B）。
   *  null = 无数据,视为中性(排两者之后不如有正数据的,先于有负数据的)。 */
  private adoptionRateProvider: ((key: string) => number | null) | null = null
  /** 星域措辞适配 — 渲染出口处按当前域改写条目内容（见 domain-advisory-tone.ts）。
   *  null = 恒等。只影响送达文本,不影响 key/expect/账本。 */
  private toneAdapter: ((content: string, meta: { key: string; category: AdvisoryCategory; tier?: AdvisoryTier }) => string) | null = null
  // ── Lift 消费端（因果账本闭环,2026-07-04 第四轮）──
  /** 成熟 lift 查询 — null = 样本不足不下结论。 */
  private liftProvider: ((key: string) => number | null) | null = null
  /** T7 效力排序：有界调整有效优先级的信号源。null = 效力不参与排序（旧行为）。 */
  private efficacySignal: EfficacySignalProvider | null = null
  /** 效力调整幅度 — 构造期解析一次，避免每轮 render 读 env。 */
  private readonly efficacySpan = parseEfficacySpan(process.env.RIVET_ADVISORY_EFFICACY_SPAN)
  /** key → 负 lift 静音的剩余渲染周期数（与习惯化 silenceRemaining 独立,遥测可区分） */
  private liftMuteRemaining = new Map<string, number>()
  /** 静音期满后的 probation 名单 — 放行一次送达以收集新证据,之后 lift 仍 ≤0 才再静音 */
  private liftProbation = new Set<string>()
  private ledgerLiftMuted = 0
  // ── W6 CVM 开销节流（由 pressure-monitor 设置，Wave 2 统一预算消费）──
  private overheadThrottled = false
  // ── W2 efficacy 负反馈环 ──
  private efficacyStats: EfficacyStatsProvider | null = null
  /** 本会话被 efficacy 环静默的 key（delivered ≥ 6 且零采纳） */
  private efficacySilenced = new Set<string>()
  /** key → 剩余冷却渲染周期数 */
  private efficacyCooldownRemaining = new Map<string, number>()
  /** key → 上次冷却长度（下次送达时翻倍） */
  private efficacyCooldownLength = new Map<string, number>()

  /** P1b：注入习惯化查询源（AdvisoryReadback）。缺省 = 不做习惯化对抗。 */
  setHabituationPolicy(policy: HabituationPolicy): void {
    this.habituation = policy
  }

  /** Phase 2：注入自愈判定（挂起观察需要;缺省 = 挂起只按 TTL 到期送达）。 */
  setSelfHealCheck(check: (expect: AdvisoryExpectation, sinceTurn: number, nowTurn: number) => boolean): void {
    this.selfHealCheck = check
  }

  /** Phase 2：注入产出流判定（阶段抑制需要;缺省 = 不抑制）。 */
  setFlowStateProvider(provider: () => boolean): void {
    this.flowStateProvider = provider
  }

  /** Phase 2：注入 TUI 状态区 sink。设置后 channel='status' 条目改走此通道。 */
  setStatusSink(sink: (entries: AdvisoryEntry[]) => void): void {
    this.statusSink = sink
  }

  /** Holdout：注入反事实抽样策略。缺省 = 不抽样（全量投递）。 */
  setHoldoutPolicy(policy: HoldoutPolicy): void {
    this.holdout = policy
  }

  /** B：注入历史采纳率查询 — Top-N 预算竞争同 priority 时的次级排序键。 */
  setAdoptionRateProvider(provider: (key: string) => number | null): void {
    this.adoptionRateProvider = provider
  }

  /** 星域措辞适配器 — 在渲染出口（bus 附录块 + system-reminder 通道）改写
   *  条目文本。惰性求值:适配器每次渲染时执行,域切换自动生效。 */
  setToneAdapter(adapter: (content: string, meta: { key: string; category: AdvisoryCategory; tier?: AdvisoryTier }) => string): void {
    this.toneAdapter = adapter
  }

  /** 应用措辞适配（无适配器 = 恒等）。适配器抛错时回退原文——措辞是增强,
   *  永不阻断送达。 */
  private applyTone(e: AdvisoryEntry): string {
    if (!this.toneAdapter) return e.content
    try {
      const toned = this.toneAdapter(e.content, { key: e.key, category: e.category, tier: e.tier })
      // toneAdapter 脏值（undefined/非串，30 轮 goal 收束实证）回退原文
      return typeof toned === 'string' ? toned : e.content
    } catch { return e.content }
  }

  /** Lift 消费端：注入成熟 lift 查询（AdvisoryReadback.getMatureLift）。
   *  缺省 = 不消费 lift（不静音,排序回退采纳率）。 */
  setLiftProvider(provider: (key: string) => number | null): void {
    this.liftProvider = provider
  }

  /** W2：注入会话内 efficacy 计数查询（AdvisoryReadback 会话统计）。
   *  缺省 = 不做负反馈环（全回退旧行为）。 */
  setEfficacyStatsProvider(provider: EfficacyStatsProvider): void {
    this.efficacyStats = provider
  }

  /** T7：注入效力信号（成熟 lift 优先，回退置信度加权的采纳率）。
   *  缺省 = 效力只做同 priority 的 tie-break（改动前的行为）。 */
  setEfficacySignalProvider(provider: EfficacySignalProvider): void {
    this.efficacySignal = provider
  }

  /** W6 开销节流：由 pressure-monitor 设置。Wave 2 统一预算消费此信号。 */
  setOverheadThrottled(throttled: boolean): void {
    this.overheadThrottled = throttled
  }

  /** 该 key 是否已被本会话 efficacy 环静默 — decision-shift 卡片同步抑制入口。 */
  isEfficacySilenced(key: string): boolean {
    return this.efficacySilenced.has(key)
  }

  /** 静音中的 key（习惯化 + 负 lift）— cockpit advisory 面板观测口。 */
  getSilencedKeys(): Array<{ key: string; remaining: number; reason: 'habituation' | 'lift' }> {
    return [
      ...[...this.silenceRemaining].map(([key, remaining]) => ({ key, remaining, reason: 'habituation' as const })),
      ...[...this.liftMuteRemaining].map(([key, remaining]) => ({ key, remaining, reason: 'lift' as const })),
    ]
  }

  /** 挂起观察中的条目数 — cockpit advisory 面板观测口。 */
  getPendingWatchCount(): number {
    return this.pendingWatch.length
  }

  /** Phase 2 (Wave 1)：取走 system-reminder 通道的待送内容，含 key 供调用方回调确认。
   *  W2 通道分级：增加 srClass 字段供调用方透传给 SessionContext。
   *  A3：按 priority 降序出队（stable sort，同优先级保持提交序）——
   *  discipline 配额竞争由优先级裁决，不再是 Map 插入序先到先得。 */
  drainSystemReminders(): Array<{ key: string; content: string; srClass: SrClass; priority: number }> {
    const out = this.systemReminderOut
    this.systemReminderOut = []
    return out.sort((a, b) => b.priority - a.priority)
  }

  /** Wave 1：调用方确认 SR 已成功送达（经 SessionContext 放行）。 */
  confirmSrDelivered(key: string): void {
    const entry = this.srPendingDelivery.get(key)
    if (!entry) return
    this.srPendingDelivery.delete(key)
    // P1 修复：送达后重置 carry 计数——carry 上限是 per-incident 而非 lifetime。
    // 同 key 后续再次被 cap 拦截时从头计数，不因历史 carry 被永久丢弃。
    this.srCarryCount.delete(key)
    this.ledgerRendered++
    this.delivered.push({ key: entry.key, category: entry.category, tier: entry.tier, expect: entry.expect })
    this.recordDeliveredRender([entry.key], this.renderEpoch)
  }

  /** W2 结算限流：记录注册 key 的实际送达渲染序号（非注册 key 零开销跳过）。 */
  private recordDeliveredRender(keys: Iterable<string>, renderEpoch: number): void {
    for (const key of keys) {
      if (KEY_COOLDOWN_TURNS.has(key)) this.lastDeliveredRenderByKey.set(key, renderEpoch)
    }
  }

  /** Wave 1：调用方确认 SR 被 SessionContext cap 拦截丢弃。不进入 delivered 桶。 */
  confirmSrDropped(key: string): void {
    this.srPendingDelivery.delete(key)
    this.ledgerSrDropped++
  }

  /** W2：SR 被 SessionContext cap 拦截后 requeue 回 bus 参与下轮 drain。
   *  携带上限 SR_CARRY_LIMIT 次，超限则 confirmSrDropped（永久丢弃）。
   *  此为跨轮延迟送达——条目保留在 systemReminderOut 等待下轮排水。
   *  suppressCarry 是轮内延迟（同一 render 周期），requeueSr 是跨轮延迟。
   *  P3 修复：同 key 已在 systemReminderOut 中时跳过（render 可能重新提交了同 key）。
   *  P2 修复：skipCarry=true 时不消耗携带计数（用于 discipline 额度耗尽的被动等待）。 */
  requeueSr(key: string, content: string, srClass: SrClass, skipCarry = false): void {
    // P3: 去重——同 key 已在 systemReminderOut 等待排水，跳过以避免双重注入
    if (this.systemReminderOut.some(e => e.key === key)) return
    if (!skipCarry) {
      const carryCount = (this.srCarryCount.get(key) ?? 0) + 1
      if (carryCount > SR_CARRY_LIMIT) {
        this.srCarryCount.delete(key)
        this.confirmSrDropped(key)
        return
      }
      this.srCarryCount.set(key, carryCount)
    }
    // 回注 systemReminderOut 供下轮 drain 重试。
    // A3：priority 从 srPendingDelivery 恢复（条目在 confirm 前一直在 map 里），
    // 停放条目与新条目在下轮 drain 共同参与优先级排序。
    const priority = this.srPendingDelivery.get(key)?.priority ?? 0.5
    this.systemReminderOut.push({ key, content, srClass, priority })
    if (!skipCarry) this.ledgerSrCarried++
  }

  /**
   * 只读观察口（CVM-vector v3.1 Wave 1）：当前可能参与本轮 render 的条目 key
   * （本轮已提交 + 跨轮存活 + 阶段抑制携带）。让位判定用——render 前判断
   * "同类声音是否已在场"。无副作用：不 drain、不重排、不触碰任何账本，
   * peek 后的 render 输出与未 peek 时逐字节一致（测试锁定）。
   */
  peekPendingKeys(): string[] {
    const keys = new Set<string>()
    for (const e of this.entries) keys.add(e.key)
    for (const e of this.alive) keys.add(e.key)
    for (const c of this.suppressedCarry) keys.add(c.entry.key)
    return [...keys]
  }

  /** 投递一条劝导 */
  submit(entry: AdvisoryEntry): void {
    this.entries.push(entry)
    this.ledgerSubmitted++
  }

  /** 批量投递 */
  submitAll(entries: AdvisoryEntry[]): void {
    this.entries.push(...entries)
    this.ledgerSubmitted += entries.length
  }

  /** 读取并清零投递账本（自上次 drain 以来的增量） */
  drainLedger(): AdvisoryLedgerDelta {
    const delta: AdvisoryLedgerDelta = {
      submitted: this.ledgerSubmitted,
      rendered: this.ledgerRendered,
      dropped: this.ledgerDropped,
      droppedKeys: [...new Set(this.ledgerDroppedKeys)],
      deferred: this.ledgerDeferred,
      revoked: this.ledgerRevoked,
      heldOut: this.ledgerHeldOut,
      liftMuted: this.ledgerLiftMuted,
      srSubmitted: this.ledgerSrSubmitted,
      srDropped: this.ledgerSrDropped,
      srCarried: this.ledgerSrCarried,
    }
    this.ledgerSubmitted = 0
    this.ledgerRendered = 0
    this.ledgerDropped = 0
    this.ledgerDroppedKeys = []
    this.ledgerDeferred = 0
    this.ledgerRevoked = 0
    this.ledgerHeldOut = 0
    this.ledgerLiftMuted = 0
    this.ledgerSrSubmitted = 0
    this.ledgerSrDropped = 0
    this.ledgerSrCarried = 0
    return delta
  }

  /**
   * 读取并清空"已送达"条目快照（自上次 drain 以来 render 输出过的条目）。
   * turn-step-producer 在 render 后立刻 drain 并交给 AdvisoryReadback 跟踪。
   */
  drainDelivered(): DeliveredAdvisory[] {
    const out = this.delivered
    this.delivered = []
    return out
  }

  private recordDropped(keys: Iterable<string>): void {
    for (const key of keys) {
      this.ledgerDropped++
      this.ledgerDroppedKeys.push(key)
    }
    if (this.ledgerDroppedKeys.length > LEDGER_DROPPED_KEYS_CAP) {
      this.ledgerDroppedKeys = this.ledgerDroppedKeys.slice(-LEDGER_DROPPED_KEYS_CAP)
    }
  }

  /**
   * 渲染本轮劝导为 `<星域-advisory>` XML 块。
   *
   * 分层规则：
   *   constitutional tier — 永不被截断，仅按 key 去重
   *   operational tier — 参与 Top-3 竞争（先于 informational）
   *   informational tier — 填充剩余槽位
   *
   * @param activeStarDomain — active star domain name (e.g. '天枢'). When set,
   *   static manifesto-style entries tagged with the same star name are
   *   suppressed (they duplicate the persona already rendered in the frozen
   *   base). Situational entries (category 'star_domain' — CCR routing and
   *   capsule recall) are exempt: a 【天权】 course-correction fired while the
   *   天权 domain is active is contextual advice, not a duplicate manifesto.
   *   (2026-07-04 触发面修复：旧逻辑按内容前缀无差别过滤，同星域的改道提醒
   *   被静态 persona 顶掉——静音栈的一环。)
   */
  render(activeStarDomain?: string, turn = 0): string {
    // `turn` 是 TurnOrchestrator.run 内的局部序号，每个用户 run 都从 0 重置。
    // key 冷却必须使用会话内单调时钟，否则 B2 固定在 turn=12 触发后会永久静默。
    const renderEpoch = ++this.renderEpoch
    // T6 正向臂 keys——render 周期内 accumulated，在 effectivePriority 消费后随 render 结束丢弃
    let positiveArmKeys = new Set<string>()
    // ── Phase 2 状态机:candidate → pending → confirmed/revoked ──
    // A. 先处理既有挂起（新条目在 B 段才入队——观察进度从下个渲染周期起算,
    //    否则 observe.turns=1 会在挂起当轮就被判到期,挂起形同虚设）:
    //    corroborate 提前确认 → 自愈撤销 → TTL 到期强制送达
    const corroboratedKeys = new Set<string>()
    for (const e of [...this.alive, ...this.entries]) {
      for (const k of e.corroborates ?? []) corroboratedKeys.add(k)
    }
    const promoted: AdvisoryEntry[] = []
    const stillPending: typeof this.pendingWatch = []
    for (const p of this.pendingWatch) {
      if (corroboratedKeys.has(p.entry.key)) {
        // 多信号确认:独立信号（不同 phase/category 的 hook）指认 → 提前送达
        promoted.push(p.entry)
        continue
      }
      if (this.selfHealCheck && p.entry.expect && this.selfHealCheck(p.entry.expect, p.startTurn, turn)) {
        // 自愈撤销:模型在挂起期已自发做了该做的事——提醒作废（ICU 延迟确认降误报）
        this.ledgerRevoked++
        continue
      }
      p.waitedRenders++
      if (p.waitedRenders >= p.entry.observe!.turns) {
        promoted.push(p.entry) // 挂起不等于丢弃:max-wait 到期必须投递
      } else {
        stillPending.push(p)
      }
    }
    this.pendingWatch = stillPending

    // B. intake:opt-in observe 的新条目进入挂起观察（挂起态不渲染,缓存安全）。
    //    本轮刚被提前确认/到期送达的 key 不再重新挂起（避免送达轮重复入队）。
    const promotedKeys = new Set(promoted.map(e => e.key))
    const directEntries: AdvisoryEntry[] = []
    for (const e of this.entries) {
      if (e.observe && !e.immediate && e.tier !== 'constitutional' && !promotedKeys.has(e.key)) {
        const existing = this.pendingWatch.find(p => p.entry.key === e.key)
        if (existing) {
          existing.entry = e // 条件仍在:刷新内容,保留观察进度
        } else {
          this.pendingWatch.push({ entry: e, startTurn: turn, waitedRenders: 0 })
          this.ledgerDeferred++
        }
        continue
      }
      directEntries.push(e)
    }
    this.entries = directEntries

    // C. 阶段抑制推迟的条目回到竞争池（到限强制送达在 E 段判定）
    const carried = this.suppressedCarry
    this.suppressedCarry = []

    let all = [...this.alive, ...this.entries, ...promoted, ...carried.map(c => c.entry)]
    const deferralsByKey = new Map(carried.map(c => [c.entry.key, c.deferrals]))

    // ── W2 key 级送达冷却：注册 key 距上次实际送达不足 N 轮 → 吞掉计 dropped ──
    // 放在一切竞争逻辑之前——冷却中的条目不该占 MUTEX/预算/挂起任何一席。
    // 缺陷 3 修复（会话 aa9737bb 审查）：SR 通道此前豁免冷却——B2 turn-call-limit
    // 走 SR 通道，KEY_COOLDOWN_TURNS 注册的 3 轮冷却形同虚设，每个 run 都重复注入
    // 收敛提醒（实测 82 渲染仅 5 采纳）。现 SR 也检查冷却：冷却期内吞掉（计 dropped）。
    // 调用方（B2 等）按 run 重新 submit，冷却过后自动恢复送达——吞掉 ≠ 永久丢失。
    // 不用 requeueSr：requeue 的条目进 systemReminderOut 后绕过 render 冷却检查，
    // 下轮 drain 即送达，冷却形同虚设；且 SR_CARRY_LIMIT=2 会在 3 轮冷却期内
    // 永久丢弃（confirmSrDropped），不如吞掉等调用方重提。
    {
      const cooled: AdvisoryEntry[] = []
      const swallowed: string[] = []
      for (const e of all) {
        const cooldown = KEY_COOLDOWN_TURNS.get(e.key)
        const last = cooldown !== undefined ? this.lastDeliveredRenderByKey.get(e.key) : undefined
        if (cooldown !== undefined && last !== undefined && renderEpoch - last < cooldown) {
          swallowed.push(e.key)
        } else {
          cooled.push(e)
        }
      }
      if (swallowed.length > 0) {
        this.recordDropped(swallowed)
        all = cooled
      }
    }

    // ── A4 互斥对：语义冲突信号同场时 loser 让位（跨通道，在 SR 分流前生效）──
    // 复盘修复（2026-07-25）：winner 判定并入 pendingWatch——带 observe 的
    // winner（如 self-verify）在挂起观察窗内不进竞争池 `all`，只扫 `all`
    // 会让 loser（表扬）在债观察窗内照常送达，「有债仍表扬」的主路径没挡住。
    // 挂起 ≠ 不在场：事实已被 hook 指认，只是送达被延迟确认。
    const pendingWinnerKeys = new Set(this.pendingWatch.map(p => p.entry.key))
    for (const pair of MUTEX_PAIRS) {
      const winnerPresent = all.some(e => e.key === pair.winner) || pendingWinnerKeys.has(pair.winner)
      if (winnerPresent && all.some(e => e.key === pair.loser)) {
        this.recordDropped(all.filter(e => e.key === pair.loser).map(e => e.key))
        all = all.filter(e => e.key !== pair.loser)
      }
    }

    // ── P1b 习惯化对抗（constitutional 豁免） ──
    if (this.habituation) {
      // 静音计时按渲染周期流逝（无论该 key 本轮是否被投递）
      for (const [k, v] of this.silenceRemaining) {
        if (v <= 1) this.silenceRemaining.delete(k)
        else this.silenceRemaining.set(k, v - 1)
      }
      const droppedSilenced = new Set<string>()
      const kept: AdvisoryEntry[] = []
      for (const e of all) {
        if (e.tier === 'constitutional') {
          kept.push(e)
          continue
        }
        if (this.silenceRemaining.has(e.key)) {
          droppedSilenced.add(e.key)
          continue
        }
        const streak = this.habituation.getIgnoredStreak(e.key)
        // streak 加深才触发新静音 — 期满 probation 放行一次，采纳则 streak 清零
        if (streak >= HABITUATION_SILENCE_STREAK && streak > (this.lastSilencedStreak.get(e.key) ?? 0)) {
          this.lastSilencedStreak.set(e.key, streak)
          this.silenceRemaining.set(e.key, HABITUATION_SILENCE_RENDERS)
          droppedSilenced.add(e.key)
          continue
        }
        if (streak >= HABITUATION_ESCALATE_STREAK) {
          // 升级措辞："被忽略"这个事实本身是新信息，比原文重复更穿透习惯化
          kept.push({ ...e, content: `（此提醒已连续 ${streak} 次未见执行——若你有意跳过请在回复中说明理由）${e.content}` })
          continue
        }
        kept.push(e)
      }
      this.recordDropped(droppedSilenced)
      all = kept
    }

    // ── W2 efficacy 负反馈环:发射前回读会话内 delivered/adopted ──
    // delivered ≥ 3 且零采纳 → 冷却翻倍;delivered ≥ 6 仍零采纳 → 会话内静默。
    // 与习惯化静音（ignoredStreak,依赖 expect 谓词）互补:无 expect 的 key
    // （如 convergence 的多数变体）ignored 永远是 0,只有这条环能拦住它。
    if (this.efficacyStats) {
      for (const [k, v] of this.efficacyCooldownRemaining) {
        if (v <= 1) this.efficacyCooldownRemaining.delete(k)
        else this.efficacyCooldownRemaining.set(k, v - 1)
      }
      const droppedByEfficacy = new Set<string>()
      const kept: AdvisoryEntry[] = []
      for (const e of all) {
        // fail-open:constitutional / 高优先级条目永不受负反馈环约束
        if (e.tier === 'constitutional' || e.priority >= 0.8) {
          kept.push(e)
          continue
        }
        if (this.efficacySilenced.has(e.key)) {
          droppedByEfficacy.add(e.key)
          continue
        }
        const stats = this.efficacyStats(e.key)
        if (!stats || stats.adopted > 0) {
          kept.push(e)
          continue
        }
        if (stats.delivered >= EFFICACY_SILENCE_DELIVERED) {
          this.efficacySilenced.add(e.key)
          droppedByEfficacy.add(e.key)
          continue
        }
        if (stats.delivered >= EFFICACY_COOLDOWN_DELIVERED) {
          if (this.efficacyCooldownRemaining.has(e.key)) {
            droppedByEfficacy.add(e.key)
            continue
          }
          // 放行本次送达,并把下次冷却翻倍（2→4→8…）
          const next = (this.efficacyCooldownLength.get(e.key) ?? EFFICACY_BASE_COOLDOWN_RENDERS / 2) * 2
          this.efficacyCooldownLength.set(e.key, next)
          this.efficacyCooldownRemaining.set(e.key, next)
        }
        kept.push(e)
      }
      this.recordDropped(droppedByEfficacy)
      all = kept

      // ── T6 efficacy 正向臂：累计采纳 ≥3 → 冷却减半，有效 priority 排序加成 ──
      // 负向臂让"说了没人听"的 key 退场，正向臂让"说了有人听"的 key 加速送达。
      // 设计写"连续采纳 ≥3"，当前实现为累计 adopted ≥3（readback 无 adoptedStreak）。
      // 累积口径 + 不 mutation + cap 0.79 三道防线确保不击穿豁免线。
      // 注意：不 mutation e.priority——alive 跨渲染周期持有同一批引用，
      // 原地 +=0.05 会复合累加，且 0.85 越 0.8 fail-open 豁免线导致永久逃逸负向臂。
      // 有效 priority 仅在 render 周期内用于排序比较，不写入条目对象。
      positiveArmKeys = new Set<string>()
      for (const e of all) {
        const stats = this.efficacyStats(e.key)
        if (!stats || stats.adopted < 3) continue
        positiveArmKeys.add(e.key)
        // 冷却减半（作用于下次 cooldown，安全——修改的是 Map 不是条目对象）
        const currentLen = this.efficacyCooldownLength.get(e.key)
        if (currentLen && currentLen > 1) {
          this.efficacyCooldownLength.set(e.key, Math.max(1, Math.floor(currentLen / 2)))
        }
      }
    }

    // ── W6 CVM 开销节流：overheadThrottled 信号由 pressure-monitor 设置 ──
    // Wave 2 统一注入预算消费：节流态下预算从 3 降到 1，替代旧的隔周期 skip。
    // 此处不移除条目——预算逻辑在 render() 出口统一执行。overheadThrottled
    // 仅作为信号保留，不在此处做过滤。
    // （旧 W6 隔周期 skip 已移除——统一预算闸门替代）

    // ── Lift 消费端:负 lift 自动静音（"没提醒也会做"= 纯噪音）──
    // 成熟 lift ≤ 0 → 静音 LIFT_MUTE_RENDERS 周期;期满 probation 放行一次
    // 收集新证据,之后 lift 仍 ≤0 才再静音（避免数据不更新导致永久静音）。
    // 豁免与 holdout 资格同源:constitutional / immediate / star_domain 永不静音。
    if (this.liftProvider) {
      for (const [k, v] of this.liftMuteRemaining) {
        if (v <= 1) {
          this.liftMuteRemaining.delete(k)
          this.liftProbation.add(k) // 期满 → 下次出现放行一次
        } else {
          this.liftMuteRemaining.set(k, v - 1)
        }
      }
      const droppedByLift = new Set<string>()
      const kept: AdvisoryEntry[] = []
      for (const e of all) {
        const exempt = e.tier === 'constitutional' || e.immediate === true || e.category === 'star_domain'
        if (exempt) {
          kept.push(e)
          continue
        }
        if (this.liftMuteRemaining.has(e.key)) {
          droppedByLift.add(e.key)
          continue
        }
        if (this.liftProbation.has(e.key)) {
          this.liftProbation.delete(e.key) // probation 送达,消费一次
          kept.push(e)
          continue
        }
        const lift = this.liftProvider(e.key)
        if (lift !== null && lift <= LIFT_MUTE_THRESHOLD) {
          this.liftMuteRemaining.set(e.key, LIFT_MUTE_RENDERS)
          droppedByLift.add(e.key)
          continue
        }
        kept.push(e)
      }
      this.ledgerLiftMuted += droppedByLift.size
      this.recordDropped(droppedByLift)
      all = kept
    }

    // Star-domain dedup — static entries only; situational star_domain exempt
    if (activeStarDomain) {
      const tag = `【${activeStarDomain}】`
      const isFrozenDuplicate = (e: AdvisoryEntry): boolean =>
        e.content.startsWith(tag) && e.category !== 'star_domain'
      this.recordDropped(all.filter(isFrozenDuplicate).map(e => e.key))
      all = all.filter(e => !isFrozenDuplicate(e))
    }

    // ── Phase 2 阶段抑制（category 白名单,navigator 沉默规则）──
    // 主控处于产出流时推迟锦上添花类信号;到 FLOW_SUPPRESS_MAX_DEFERRALS 强制送达。
    if (this.flowStateProvider?.()) {
      const kept: AdvisoryEntry[] = []
      for (const e of all) {
        const suppressible = !e.immediate
          && e.tier !== 'constitutional'
          && (FLOW_SUPPRESSIBLE_CATEGORIES.has(e.category) || e.tier === 'informational')
        const deferrals = deferralsByKey.get(e.key) ?? 0
        if (suppressible && deferrals < FLOW_SUPPRESS_MAX_DEFERRALS) {
          this.suppressedCarry.push({ entry: e, deferrals: deferrals + 1 })
          this.ledgerDeferred++
          continue
        }
        kept.push(e)
      }
      all = kept
    }

    // ── Phase 2 通道分流（bus 竞争前分走,不占 Top-N 预算）──
    // system-reminder:细断点,直接计送达(delivered)并出队给调用方注入消息流。
    // status:仅当 sink 存在时分流;否则回退 bus(宁可占预算不静默消失)。
    const srEntries = all.filter(e => e.channel === 'system-reminder')
    if (srEntries.length > 0) {
      all = all.filter(e => e.channel !== 'system-reminder')
      const srDeduped = new Map<string, AdvisoryEntry>()
      for (const e of srEntries) {
        const existing = srDeduped.get(e.key)
        if (!existing || e.priority > existing.priority) srDeduped.set(e.key, e)
      }
      for (const e of srDeduped.values()) {
        // Wave 1：不预记 rendered/delivered——由 turn-step-producer 回调确认
        // A3（H6 陈旧文案修复）：同 key 已停放时不再跳过，而是用新内容刷新——
        // hook 每轮重算的文案（如"还剩 N 轮"预算数字）以最新一次为准，
        // 旧行为保留陈旧停放内容会把过期数字注入下一用户轮。
        // P2 放大了停放窗口：discipline 条目可能在整个用户轮剩余时长停在
        // systemReminderOut 中，刷新语义在长停放下尤其重要。
        const parked = this.systemReminderOut.find(o => o.key === e.key)
        if (parked) {
          parked.content = this.applyTone(e)
          parked.srClass = e.srClass ?? 'discipline'
          parked.priority = e.priority
          this.srPendingDelivery.set(e.key, e)
          continue
        }
        this.srPendingDelivery.set(e.key, e)
        this.systemReminderOut.push({ key: e.key, content: this.applyTone(e), srClass: e.srClass ?? 'discipline', priority: e.priority })
      }
      this.ledgerSrSubmitted += srDeduped.size
    }
    if (this.statusSink) {
      const statusEntries = all.filter(e => e.channel === 'status')
      if (statusEntries.length > 0) {
        all = all.filter(e => e.channel !== 'status')
        this.statusSink(statusEntries)
        this.ledgerRendered += statusEntries.length
        this.delivered.push(...statusEntries.map(e => ({ key: e.key, category: e.category, tier: e.tier, expect: e.expect })))
        this.recordDeliveredRender(statusEntries.map(e => e.key), renderEpoch)
      }
    }

    // Separate by tier — constitutional bypasses all caps
    const constitutional = all.filter(e => e.tier === 'constitutional')
    const nonConstitutional = all.filter(e => e.tier !== 'constitutional')

    // Constitutional: key dedup only, no category cap, no count limit
    const constDeduped = new Map<string, AdvisoryEntry>()
    for (const entry of constitutional) {
      const existing = constDeduped.get(entry.key)
      if (!existing || entry.priority > existing.priority) {
        constDeduped.set(entry.key, entry)
      }
    }

    // Non-constitutional: key dedup + category cap
    const deduped = new Map<string, AdvisoryEntry>()
    for (const entry of nonConstitutional) {
      const existing = deduped.get(entry.key)
      if (!existing || entry.priority > existing.priority) {
        deduped.set(entry.key, entry)
      }
    }

    // 竞争排序:priority 主键;同 priority 时因果口径优先——成熟 lift 可用时
    // 用 lift（归一到 [0,1],0 lift = 中性 0.5,与采纳率同刻度）,否则回退
    // 历史采纳率(先验+实测)。实测有真实增益的提醒优先占预算。
    const secondaryScore = (key: string): number => {
      const lift = this.liftProvider?.(key)
      if (lift !== undefined && lift !== null) return (lift + 1) / 2
      return this.adoptionRateProvider?.(key) ?? 0.5
    }
    // T7 效力调整量：跨 priority 让"说了有人听"的提醒赢得预算。
    // 豁免集与负 lift 静音同源——宪法级 / 立即送达 / 星域条目不参与效力排序。
    // 返回 0 表示不调整（无 provider、豁免、或无样本），此时优先级原样透传，
    // 不进 clamp——否则 CONSTITUTIONAL_PRIORITY(0.9) 会被压到 0.79。
    const efficacyAdjust = (e: AdvisoryEntry): number => {
      if (!this.efficacySignal) return 0
      if (e.tier === 'constitutional' || e.immediate === true || e.category === 'star_domain') return 0
      const sig = this.efficacySignal(e.key)
      if (!sig) return 0
      const score = Math.max(0, Math.min(1, sig.score))
      const confidence = Math.max(0, Math.min(1, sig.confidence))
      return (score - 0.5) * 2 * this.efficacySpan * confidence
    }
    const effectivePriority = (e: AdvisoryEntry): number => {
      const base = positiveArmKeys.has(e.key)
        ? Math.max(e.priority, Math.min(0.79, e.priority + 0.05)) // 单调不减，cap 不越 0.8 豁免线
        : e.priority
      const delta = efficacyAdjust(e)
      if (delta === 0) return base
      return Math.max(EFFICACY_PRIORITY_FLOOR, Math.min(EFFICACY_PRIORITY_CAP, base + delta))
    }
    const compareEntries = (a: AdvisoryEntry, b: AdvisoryEntry): number => {
      const pa = effectivePriority(a)
      const pb = effectivePriority(b)
      if (pb !== pa) return pb - pa
      if (!this.adoptionRateProvider && !this.liftProvider) return 0
      return secondaryScore(b.key) - secondaryScore(a.key)
    }

    const catCounts = new Map<AdvisoryCategory, number>()
    const catFiltered: AdvisoryEntry[] = []
    for (const entry of [...deduped.values()].sort(compareEntries)) {
      const count = catCounts.get(entry.category) ?? 0
      if (count < MAX_PER_CATEGORY) {
        catCounts.set(entry.category, count + 1)
        catFiltered.push(entry)
      }
    }

    // Operational first, then informational fills remaining
    const operational = catFiltered.filter(e => e.tier !== 'informational')
    const informational = catFiltered.filter(e => e.tier === 'informational')
    const budget = advisoryBudgetForDomain(activeStarDomain)
    const taken: AdvisoryEntry[] = []
    for (const e of operational) {
      if (taken.length >= budget && e.category !== 'star_domain') break
      taken.push(e)
    }
    for (const e of informational) {
      if (taken.length >= budget && e.category !== 'star_domain') break
      taken.push(e)
    }

    // ── Holdout 反事实抽样:赢得渲染位的条目按小概率静默扣留（不渲染,照常
    // 核销 expect → shadow 桶）。资格白名单与习惯化静音豁免同构:
    // constitutional / immediate / star_domain 永不扣留;必须带 expect 谓词
    // （无谓词无法核销,扣留没有度量意义）;key 级历史资格由注入方判定。
    const heldOut: AdvisoryEntry[] = []
    if (this.holdout && this.holdout.rate > 0) {
      const rng = this.holdout.rng ?? Math.random
      for (let i = taken.length - 1; i >= 0; i--) {
        const e = taken[i]!
        const eligible = !e.immediate
          && e.tier !== 'constitutional'
          && e.category !== 'star_domain'
          && e.expect !== undefined
          && this.holdout.isEligible(e.key)
        if (eligible && rng() < this.holdout.rate) {
          heldOut.push(e)
          taken.splice(i, 1)
        }
      }
    }

    // Combine: constitutional always first, then by priority
    let sorted: AdvisoryEntry[] = [...constDeduped.values()]
    taken.sort(compareEntries)
    sorted.push(...taken)

    // ── Wave 2 统一注入预算 ──
    // 上游 8 层降频机制各自判断后，此处单点约束最终进入 prompt 的总数。
    // W6 throttle 信号 → 削减预算（替代隔周期 skip）；正常态预算 = 3。
    // 必须先于下面的送达记账执行：被预算裁掉的条目从未进入 prompt，
    // 若先记账再裁剪，它们会同时落在 delivered（假送达）与 dropped 两本账上，
    // readback 会把它们误判为 ignored、推进习惯化静音与 efficacy 冷却。
    const CVM_INJECTION_BASE_BUDGET = 3
    const busCount = sorted.length
    const srPending = this.srPendingDelivery.size
    // ⚠ 按 key 数计数初期足够（SR 天然低频），后续可按 injectedTokens 加权校准
    const cvmInjectionBudget = this.overheadThrottled
      ? Math.max(1, CVM_INJECTION_BASE_BUDGET - 2)
      : CVM_INJECTION_BASE_BUDGET

    // constitutional / immediate 完全豁免——不占预算配额，nonexempt 独立计数
    const exempt = sorted.filter(e => e.tier === 'constitutional' || e.immediate === true)
    const nonexempt = sorted.filter(e => e.tier !== 'constitutional' && e.immediate !== true)
    if (nonexempt.length > cvmInjectionBudget) {
      const keep = [...exempt, ...nonexempt.slice(0, cvmInjectionBudget)]
      // 不在这里 recordDropped——下游账本过滤器（renderedKeys 已是裁剪后形态）
      // 会自然覆盖这批 key；双记会让 ledger.dropped 对每个被裁 key 计 2 次
      // （对抗审查 F1，收编 PR #82 时修正）。
      sorted = keep
    }

    // 账本：本轮参与竞争但没拿到渲染位的条目（类别上限 / Top-N 截断 / 注入预算）。
    // holdout 扣留 ≠ 丢弃（单独计 heldOut,且照常进 delivered 核销）。
    const renderedKeys = new Set(sorted.map(e => e.key))
    const heldKeys = new Set(heldOut.map(e => e.key))
    this.recordDropped([...deduped.keys()].filter(k => !renderedKeys.has(k) && !heldKeys.has(k)))
    this.ledgerRendered += sorted.length
    this.ledgerHeldOut += heldOut.length

    // P1a 核销闭环：记录实际送达的条目（含 expect 谓词），供 readback 追踪
    this.delivered.push(...sorted.map(e => ({
      key: e.key,
      category: e.category,
      tier: e.tier,
      expect: e.expect,
    })))
    // W2 冷却记账只算真实送达（holdout 扣留条目模型没看到，不占冷却窗）
    this.recordDeliveredRender(sorted.map(e => e.key), renderEpoch)
    // holdout 反事实组:扣留但照常核销（shadow 桶,自发完成率基线）
    this.delivered.push(...heldOut.map(e => ({
      key: e.key,
      category: e.category,
      tier: e.tier,
      expect: e.expect,
      shadow: true,
    })))

    if (sorted.length === 0) {
      this.entries = []
      this.alive = []
      return ''
    }

    // 渲染声明的是条目自身的 priority，不是排序用的有效优先级：效力信号与
    // 正向臂逐轮变化，把它们写进注入文本会让同一条 ttl>1 的建议在 alive 周期
    // 内字节抖动，而 advisory 走 appendix 通道（前缀缓存敏感）。有效优先级只
    // 参与 Top-N 竞争，不进 prompt。
    const lines = sorted.map(e =>
      `  <entry key="${escapeXml(e.key)}" priority="${e.priority.toFixed(2)}" category="${e.category}">${escapeXml(this.applyTone(e))}</entry>`,
    )

    // TTL 递减：TTL > 1 的条目保留到 alive，下轮继续
    this.alive = sorted
      .filter(e => (e.ttl ?? 1) > 1)
      .map(e => ({ ...e, ttl: (e.ttl ?? 1) - 1 }))

    this.entries = []

    return `<星域-advisory>\n${lines.join('\n')}\n</星域-advisory>`
  }

  /** 清空所有状态 */
  reset(): void {
    this.entries = []
    this.alive = []
    this.ledgerSubmitted = 0
    this.ledgerRendered = 0
    this.ledgerDropped = 0
    this.ledgerDroppedKeys = []
    this.delivered = []
    this.silenceRemaining.clear()
    this.lastSilencedStreak.clear()
    this.ledgerDeferred = 0
    this.ledgerRevoked = 0
    this.pendingWatch = []
    this.suppressedCarry = []
    this.systemReminderOut = []
    this.srPendingDelivery.clear()
    this.srCarryCount.clear()
    this.lastDeliveredRenderByKey.clear()
    this.renderEpoch = 0
    this.ledgerSrSubmitted = 0
    this.ledgerSrDropped = 0
    this.ledgerSrCarried = 0
    this.ledgerHeldOut = 0
    this.liftMuteRemaining.clear()
    this.liftProbation.clear()
    this.ledgerLiftMuted = 0
    this.efficacySilenced.clear()
    this.efficacyCooldownRemaining.clear()
    this.efficacyCooldownLength.clear()
  }
}

function escapeXml(text: string | null | undefined): string {
  return (text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
