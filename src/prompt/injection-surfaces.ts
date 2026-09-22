/**
 * 注入点申报表 —— 「runtime 往模型上下文里写了什么」的唯一机读清单。
 *
 * ## 为什么需要它
 *
 * 前缀缓存（DeepSeek 精确前缀）对字节极度敏感：任何在**已缓存区间内部**发生的
 * 写入都会让该点之后全部重算。而本仓往模型上下文写字节的地方分散在
 * `buildDynamicAppendixParts` 的 27 个 push 点、frozen/fresh 两套 volatile trailer、
 * system-reminder 与 runtime hook 载荷至少四个通道里，各自用自己的条件门控。
 * 原先这些知识只以**注释**形式散落在实现旁边（例如 volatile.ts 的 strip list
 * 自称 "SINGLE SOURCE OF TRUTH"），没有任何机器可校验的东西——新增一个 appender
 * 不会触发任何红灯，只能靠人读 diff。
 *
 * 这张表把「哪个注入点 / 走哪条通道 / 变更的代价 / 谁生产 / 有没有计量」变成
 * 数据，由 `scripts/verify-injection-surfaces.ts` 与代码逐条对账：
 * 锚点必须存在、CVM 计量源必须被全覆盖、frozen 分区必须与 strip list 完全一致、
 * appendix 推送点必须与源码顺序逐一对应。**加了注入点不更新本表 = 门禁红。**
 *
 * ## 通道划分（与 engine.ts 请求布局一一对应）
 *
 * 一个 user 边界上的请求，字节布局是：
 *
 * ```text
 * [system-static]                     ← 请求位置 0，会话内冻结
 * user: [trailer-frozen/fresh][用户原文][appendix]
 * assistant / tool …
 * ```
 *
 * - `system-static`：`buildSystemPrompt(staticCtx)`，只含静态锚。
 * - `trailer-frozen`：`buildStableVolatileBlock` 的产物，挂在**每条** user 消息
 *   前面；历史消息用它落下来的快照（`frozenUserMerged`），故块内字段一旦变化
 *   就是全量重建，只有 session-constant 字段允许在此。
 * - `trailer-fresh`：同一函数带完整 ctx 的产物，每个 user 边界重建一次并缓存
 *   （`cachedFreshForUser`），该边界内的后续 tool 轮复用缓存 → 1 次 user 消息
 *   50 次工具调用只付一次重建。
 * - `appendix`：`<context-update>` 子块，追加在用户原文之后；`appendixDelta`
 *   只发变化过的子块。
 * - `ephemeral`：每轮一次性认知提示，**不进** delta context-update（否则会被
 *   「缺席=沿用上轮」协议永久固化）。
 * - `reminder`：`session.appendSystemReminder` 追加进消息流（细断点、只追加尾部）。
 * - `ui-only`：**明确不进 prompt** 的通道。登记它们是为了让「不要把它塞进上下文」
 *   这个决定可被检索——历史上 companion presence 就曾被误注入。
 *
 * ## 代价口径
 *
 * - `append-tail`：只在尾部追加，已缓存前缀逐字节保留。
 * - `boundary-rebuild`：每个 user 边界重建一次，重建尖峰有界且与会话长度解耦。
 * - `prefix-replace`：替换既有请求字节 → 该点之后的全部 token 失效。
 * - `none`：不进 prompt。
 *
 * @module
 */

import type { CvmInjectionSource } from '../context/pressure-monitor.js'

/** 注入通道。见文件头「通道划分」。 */
export type InjectionChannel =
  | 'system-static'
  | 'trailer-frozen'
  | 'trailer-fresh'
  | 'appendix'
  | 'ephemeral'
  | 'reminder'
  | 'ui-only'

/** 该注入点变化时的缓存代价。 */
export type InjectionCost =
  | 'append-tail'
  | 'boundary-rebuild'
  | 'prefix-replace'
  | 'none'

/** 变化节律——appendix 内要求按此从稳定到易变排序。 */
export type InjectionVolatility =
  /** 会话内恒定，字节永不变。 */
  | 'session-constant'
  /** 仅状态迁移时变（任务切换、证据更新、计划审批）。 */
  | 'transition'
  /** 每个 user 边界都可能变。 */
  | 'per-boundary'
  /** 每轮都可能变。 */
  | 'per-turn'

/** 一个注入点的申报记录。 */
export interface InjectionSurface {
  /** 稳定标识，形如 `<通道>.<块名>`。全局唯一。 */
  readonly id: string
  readonly channel: InjectionChannel
  readonly cost: InjectionCost
  readonly volatility: InjectionVolatility
  /** 生产者：源码里的表达式（`ctx.x` / `tag:<x>` / `<fn>()`）。 */
  readonly producer: string
  /** 代码锚点；校验器断言 `symbol` 确实出现在 `file` 中。 */
  readonly anchor: { readonly file: string; readonly symbol: string }
  /** CVM 计量源；缺省 = 该块不计量（未挂 source 的普通附录块）。 */
  readonly metered?: CvmInjectionSource
  /** 仅 `appendix` 通道：在 `buildDynamicAppendixParts` 中的推送序号（0 起）。 */
  readonly order?: number
  /**
   * 源码里的 push 点个数，缺省 1。>1 表示该块在源码里由多个互斥分支产出
   * （例如 git-status 的 if/else 各有一条腿）。校验器按此核对重数，
   * 防止有人复制一个块到新分支却不申报。
   */
  readonly pushSites?: number
  /**
   * 由**渲染函数间接消费**的 ctx 字段。
   *
   * 顶层 push 只看得见 `push(ctx.x)` 这种直读；像 `renderProgressBlock(ctx)`
   * 这样在函数内部读 `ctx.sessionState` 的消费，光看 push 点是看不见的——
   * 校验器 V8 会把函数体里的 `ctx.*` 引用与这里逐一对账（双向），
   * 补上「表格自称为唯一清单、却有字段绕过它进入上下文」的缺口。
   */
  readonly consumes?: readonly string[]
  /** `consumes` 所属的函数名；缺省从 producer 的 `fn()` 形式推导。 */
  readonly consumesIn?: string
  /** 一句话说清：这块是什么、什么时候变。 */
  readonly note: string
}

/**
 * `buildDynamicAppendixParts` 的受保护块——在附录预算压力下也必须整块渲染。
 * 顺序即源码顺序，二者由校验器对齐。
 */
export const APPENDIX_PROTECTED_SURFACES: readonly InjectionSurface[] = [
  {
    id: 'appendix.invoked-skills',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.invokedSkillsBlock',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'ctx.invokedSkillsBlock' },
    order: 0,
    note: '显式召回的 skill 正文。按用户意图为高显著性，只应随 skill 完成消失，不被 Top-K 挤出。',
  },
  {
    id: 'appendix.permission-note',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'session-constant',
    producer: 'renderPermissionNote()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'renderPermissionNote(ctx.approvalMode)' },
    order: 1,
    note: '「问是否已被批准」的行为约束，硬约束而非建议，故豁免预算裁剪。',
  },
]

/**
 * appendix 普通块（参与 GWT Top-K 预算）。`order` 必须与
 * `buildDynamicAppendixParts` 内的 push 顺序一致——该顺序本身就是缓存设计：
 * 少变的在前、每轮变的在后。
 */
export const APPENDIX_SURFACES: readonly InjectionSurface[] = [
  {
    id: 'appendix.historical-lessons',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'session-constant',
    producer: 'tag:historical-lessons',
    anchor: { file: 'src/prompt/volatile.ts', symbol: '<historical-lessons>' },
    order: 0,
    note: 'playbook 教训池，每会话只查一次（habituation 不抖前缀）；lean 档关闭。',
  },
  {
    id: 'appendix.cognitive-projection',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.cognitiveProjection',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.cognitiveProjection' },
    metered: 'projection',
    order: 1,
    note: '任务契约 + 验证缺口 + 认知镜像 + 不确定性框定；只在状态迁移时变。',
  },
  {
    id: 'appendix.progress',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'renderProgressBlock()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'function renderProgressBlock' },
    consumes: ['decisions', 'sessionState', 'taskProgress'],
    consumesIn: 'renderProgressBlock',
    order: 2,
    note: 'session-state / task-progress / decisions 三源合一，替代原先三块重复。',
  },
  {
    id: 'appendix.read-file-dedup-hint',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'tag:read-file-dedup-hint',
    anchor: { file: 'src/prompt/volatile.ts', symbol: '<read-file-dedup-hint>' },
    order: 3,
    note: '已读文件单行快照，防重复读取；条件门（>5 文件或历史 >8 条）才渲染。',
  },
  {
    id: 'appendix.excluded-paths',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'tag:excluded-paths',
    anchor: { file: 'src/prompt/volatile.ts', symbol: '<excluded-paths' },
    order: 4,
    note: 'spark 会话专属：wire 层推理截断丢失的「已排除路径」回灌；非 spark 恒空。',
  },
  {
    id: 'appendix.current-goal',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'tag:current-goal',
    anchor: { file: 'src/prompt/volatile.ts', symbol: '<current-goal' },
    order: 5,
    note: 'spark 会话专属：目标从首轮位置复制到每轮最新位置，对抗长会话注意力稀释。',
  },
  {
    id: 'appendix.git-status',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'tag:git-status',
    anchor: { file: 'src/prompt/volatile.ts', symbol: '<git-status>' },
    order: 6,
    pushSites: 2,
    note: '工作区状态。2026-07-06 从 frozen 移出至此——每轮都变，留在 frozen 就是全量重建。两条源码位置：拆分成功时的 statusPart 与拆分失败时的整块兜底。',
  },
  {
    id: 'appendix.recent-commits',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'tag:recent-commits',
    anchor: { file: 'src/prompt/volatile.ts', symbol: '<recent-commits>' },
    order: 7,
    note: '与 git-status 同源拆出的提交列表块（同一 push 分支的两条腿）。',
  },
  {
    id: 'appendix.intent-retrieval-route',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.intentRetrievalRoute',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.intentRetrievalRoute)' },
    order: 8,
    note: '本轮检索路由建议；置于 git 感知之后、认知策略提示之前。',
  },
  {
    id: 'appendix.task-depth-advisory',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.taskDepthAdvisory',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.taskDepthAdvisory)' },
    order: 9,
    note: '接线/系统类任务的 TDD 策略建议。',
  },
  {
    id: 'appendix.plan-methodology-advisory',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.planMethodologyAdvisory',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.planMethodologyAdvisory)' },
    order: 10,
    note: '计划方法论模板选择（lightweight / full）。',
  },
  {
    id: 'appendix.plan-executing',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.planExecutingBlock',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.planExecutingBlock)' },
    order: 11,
    note: '已批准计划的执行纪律；activePlanPointer 置位时挂载，下次进入 plan mode 清除。',
  },
  {
    id: 'appendix.skill-advisory',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.skillAdvisoryBlock',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.skillAdvisoryBlock)' },
    order: 12,
    note: 'skill 建议块（与 protected 的 invokedSkillsBlock 不同者：这块参与预算裁剪）。',
  },
  {
    id: 'appendix.cross-session-memory',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.crossSessionMemoryBlock',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.crossSessionMemoryBlock)' },
    order: 13,
    note: '跨会话项目记忆召回块。',
  },
  {
    id: 'appendix.mention-context',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.mentionContextBlock',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.mentionContextBlock)' },
    order: 14,
    note: '@ 提及上下文块。',
  },
  {
    id: 'appendix.cross-session-events',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.crossSessionEvents',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.crossSessionEvents)' },
    order: 15,
    note: '跨会话事件（稀有），刻意排在靠后位置。',
  },
  {
    id: 'appendix.tool-context',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.toolContext',
    anchor: { file: 'src/prompt/volatile.ts', symbol: "push(ctx.toolContext, 'tool-context')" },
    metered: 'tool-context',
    order: 16,
    note: 'theta + EFE + top-3 排序的统一工具上下文，取代旧的 affordance-hint/policy-guidance 两块。',
  },
  {
    id: 'appendix.plan-cache-advisory',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.planCacheAdvisory',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.planCacheAdvisory)' },
    order: 17,
    note: '仅本轮的信息性提示，靠近策略指引以便影响规划而不沉淀为稳定提示词。',
  },
  {
    id: 'appendix.plan-trace',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.planTraceAppendix',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.planTraceAppendix)' },
    order: 18,
    note: 'U6：序列化的执行轨迹，压缩时刷新，使计划基线与进度在历史剪枝后存活。',
  },
  {
    id: 'appendix.active-plan-pointer',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.activePlanPointer',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'push(ctx.activePlanPointer)' },
    order: 19,
    note: '计划指针（slug/标题/路径）；正文在盘上按需读，避免审批/修订触发 frozen 重建。',
  },
  {
    id: 'appendix.harness-advisory',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'ctx.harnessAdvisoryBlock',
    anchor: { file: 'src/prompt/volatile.ts', symbol: "push(ctx.harnessAdvisoryBlock, 'advisory-appendix')" },
    metered: 'advisory-appendix',
    order: 20,
    note: 'A1 harness-advisory 总线统一收编的纠正性指引（最多 3 条）。',
  },
  {
    id: 'appendix.control-plane',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'ctx.controlPlaneBlock',
    anchor: { file: 'src/prompt/volatile.ts', symbol: "push(ctx.controlPlaneBlock, 'control-appendix')" },
    metered: 'control-appendix',
    order: 21,
    note: 'Wave 4 控制面附录：仅 active-mode，按 revision 驱动，模型可见状态不变则字节不变。',
  },
  {
    id: 'appendix.worktree-warning',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'tag:worktree-warning',
    anchor: { file: 'src/prompt/volatile.ts', symbol: '<worktree-warning' },
    order: 22,
    note: 'worktree 现实核对不一致告警；severity=green 不渲染。',
  },
  {
    id: 'appendix.plan-mode',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'renderPlanModeBlock()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'renderPlanModeBlock(ctx.activePlanFilePath)' },
    order: 23,
    note: 'planning 态的整体规划纪律块（只读 + 计划质量 + 图表骨架）。',
  },
  {
    id: 'appendix.plan-exit-reminder',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'renderPlanExitReminder()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'renderPlanExitReminder()' },
    order: 24,
    note: '退出 plan mode 的提醒，与 plan-mode 块互斥（else-if 分支）。',
  },
  {
    id: 'appendix.ask-mode',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'renderAskModeBlock()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'renderAskModeBlock()' },
    order: 25,
    note: 'Ask Mode 指令块，UI 层与 plan 互斥。',
  },
  {
    id: 'appendix.terseness-nudge',
    channel: 'appendix',
    cost: 'boundary-rebuild',
    volatility: 'per-turn',
    producer: 'renderTersenessNudge()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'renderTersenessNudge(tersenessEscalate)' },
    consumes: ['tersenessEnabled', 'tersenessEscalate'],
    consumesIn: 'resolveTersenessFlags',
    order: 26,
    note: '输出冗长度转向；基础档 opt-in（RIVET_TERSE=1），doom-loop 轮自动升级。',
  },
]

/**
 * 非 appendix 通道的注入点。这些不是「块」，而是整条通道的写入约定。
 */
export const CHANNEL_SURFACES: readonly InjectionSurface[] = [
  {
    id: 'system.static',
    channel: 'system-static',
    cost: 'prefix-replace',
    volatility: 'session-constant',
    producer: 'buildSystemPrompt()',
    anchor: { file: 'src/prompt/engine.ts', symbol: 'buildSystemPrompt(config.staticCtx)' },
    note: '请求位置 0 的静态锚。改动即整段前缀失效——所有注入都应优先走尾部通道而非这里。',
  },
  {
    id: 'trailer.frozen',
    channel: 'trailer-frozen',
    cost: 'prefix-replace',
    volatility: 'session-constant',
    producer: 'buildStableVolatileBlock()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'export function buildStableVolatileBlock' },
    note: '会话常量 trailer。历史 user 消息用它落下的快照（frozenUserMerged），故块内任何字段变化都是全量重建。',
  },
  {
    id: 'trailer.fresh',
    channel: 'trailer-fresh',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'buildVolatileBlockInternal()',
    anchor: { file: 'src/prompt/engine.ts', symbol: 'cachedFreshForUser' },
    note: '每 user 边界重建一次后缓存；该边界内 50 次工具调用复用同一份 → 工具轮不破前缀。',
  },
  {
    id: 'trailer.consolidated',
    channel: 'trailer-fresh',
    cost: 'boundary-rebuild',
    volatility: 'transition',
    producer: 'buildConsolidatedBlock()',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'export function buildConsolidatedBlock' },
    note: 'habituation 提升后的常量块，按 key 排序保证确定性字节序。',
  },
  {
    id: 'ephemeral.cognitive-hints',
    channel: 'ephemeral',
    cost: 'boundary-rebuild',
    volatility: 'per-boundary',
    producer: 'withEphemeralProjection()',
    anchor: { file: 'src/prompt/engine.ts', symbol: 'withEphemeralProjection' },
    metered: 'ephemeral',
    note: '一次性认知提示（sycophancy / 瑶光 / immune），刻意不进 delta context-update，否则被「缺席=沿用」协议永久固化。',
  },
  {
    id: 'reminder.system-reminder',
    channel: 'reminder',
    cost: 'append-tail',
    volatility: 'per-boundary',
    producer: 'session.appendSystemReminder()',
    anchor: { file: 'src/agent/advisory-bus.ts', symbol: "'system-reminder'" },
    metered: 'system-reminder',
    note: 'advisory 总线细断点通道：追加进消息流，模型必读；只追加尾部，不重写历史。',
  },
  {
    id: 'reminder.runtime-payload',
    channel: 'reminder',
    cost: 'append-tail',
    volatility: 'per-boundary',
    producer: 'addUserMessage()',
    anchor: { file: 'src/agent/loop.ts', symbol: 'appendSystemReminder(message)' },
    metered: 'runtime-payload',
    note: 'runtime hook 的 injectUserMessage 载荷（MCTS 种子、scout 包、兜底建议）当伪 user 消息追加到末条 user 消息，而非新开消息条目。',
  },
  {
    id: 'ui.status-channel',
    channel: 'ui-only',
    cost: 'none',
    volatility: 'per-turn',
    producer: 'AdvisoryChannel = status',
    anchor: { file: 'src/agent/advisory-bus.ts', symbol: "'bus' | 'system-reminder' | 'status'" },
    note: '仅进 TUI 状态区，不进 prompt（dark cockpit 单感官通道）；无 status sink 时回退 bus 渲染，宁可占预算也不静默消失。',
  },
  {
    id: 'ui.companion-presence',
    channel: 'ui-only',
    cost: 'none',
    volatility: 'per-turn',
    producer: '(removed 2026-06-23)',
    anchor: { file: 'src/prompt/volatile.ts', symbol: 'companionPresence rendering removed' },
    note: '登记一条已撤销的注入：companion presence 只服务桌面端 UI，注入 prompt 会伪造多智能体协作信号。留档防止被重新加回。',
  },
]

/** 全表。 */
export const INJECTION_SURFACES: readonly InjectionSurface[] = [
  ...APPENDIX_PROTECTED_SURFACES,
  ...APPENDIX_SURFACES,
  ...CHANNEL_SURFACES,
]

/**
 * frozen trailer 的保留字段（session-constant，允许进冻结前缀）。
 * 由校验器与 `buildVolatileBlockInternal` 的实际渲染字段对账。
 *
 * 这些字段全部来自 `createVolatileSnapshot`（`src/prompt/volatile-snapshot.ts`）
 * ——会话启动期构造一次并 `Object.freeze`，中途改配置不生效。**新增字段前先回答
 * 「它在会话中途会不会变」**：会变就必须走 strip list + appendix，否则每轮都在
 * 改字节 0 之后的字节，整段前缀每轮失效。
 */
export const FROZEN_KEEP_FIELDS: readonly string[] = [
  'activeDomain',
  'cwdRelation',
  'knowledgeManifestBlock',
  'projectIndexBlock',
  'projectMemoryBlock',
  'rivetMd',
  'seedCapsuleBlock',
  'sessionMemoryBlock',
  'workingSet',
]

/**
 * frozen trailer 的剥离字段（每会话或更频繁变化，**不得**进冻结前缀）。
 * 由校验器与 `buildStableVolatileBlock` 的 strip list 逐字对账——
 * 任一侧新增而另一侧未跟进，门禁红。
 */
export const FROZEN_STRIPPED_FIELDS: readonly string[] = [
  'activeClaims',
  'askModeState',
  'contextLedger',
  'controlPlaneBlock',
  'decisions',
  'gitStatus',
  'harnessAdvisoryBlock',
  'intentRetrievalRoute',
  'planCacheAdvisory',
  'planExitReminderPending',
  'planModeState',
  'planTraceAppendix',
  'playbookLessons',
  'taskProgress',
  'toolContext',
  'toolHistory',
  'worktreeReality',
]

/** 按 id 取一条申报（未申报返回 undefined，不抛）。 */
export function findSurface(id: string): InjectionSurface | undefined {
  return INJECTION_SURFACES.find(s => s.id === id)
}

/** appendix 普通块的推送顺序（校验器用它与源码 push 顺序逐位比对）。 */
export function appendixPushOrder(): readonly string[] {
  return [...APPENDIX_SURFACES]
    .sort((a, b) => (a.order ?? -1) - (b.order ?? -1))
    .map(s => s.producer)
}

/** appendix 受保护块的顺序。 */
export function protectedPushOrder(): readonly string[] {
  return [...APPENDIX_PROTECTED_SURFACES]
    .sort((a, b) => (a.order ?? -1) - (b.order ?? -1))
    .map(s => s.producer)
}
