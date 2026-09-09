/**
 * Tool Gating Tiers — 主控工具分层门控
 *
 * 把主控可见工具从 ~37 (kernel 24 + interactive 13) 压到 CORE ~25，
 * 主收益是降认知负荷（工具过多→选择瘫痪→退回不选工具，见 kernel-budget.test.ts）。
 *
 * EXTENDED 工具从主控 getDefinitions() 过滤掉，但保留在 worker 的 baseToolRegistry
 * 全集中，主控需要时经 delegate_task 派子代理调用。
 */

import type { StarDomain } from './star-domain.js'
import { applyDescriptionMode, type ToolDescriptionMode } from '../tools/description-compact.js'

/**
 * CORE 层 — 主控常驻工具（~25）。
 * 这些是每个 turn 都可能需要的工具：读写编辑、搜索、测试、委派、交付。
 */
export const CORE_TOOLS = [
  // 文件读写编辑
  'read_file',
  'write_file',
  'edit_file',
  'hash_edit',
  // 搜索导航
  'grep',
  'glob',
  'semantic_search',
  'web_search',
  'web_fetch',
  'repo_map',
  // 执行
  'bash',
  'run_tests',
  'git',
  'todo',
  // 后台任务控制（bash run_in_background 的配套 await/logs/kill）
  'job',
  // 规划与交付
  'plan',
  'plan_task',
  'deliver_task',
  // 委派
  'delegate_task',
  'delegate_batch',
  // 记忆
  'memory',
  // 用户交互
  'ask_user_question',
  // 路径与技能（首调澄清/路径授权/技能加载依赖，static prompt 直接引用）
  'request_path_access',
  'skill',
  // 换视角方法论：static prompt L80 直接指示使用，必须常驻（与 skill 同源）
  'recall_capsule',
  // 浏览器联调与 UI 视觉验证（2026-07-15 从 EXTENDED 升入）：改 UI 不看渲染
  // 是高频失败模式，browser_debug 是渲染验证闭环的主工具，主控必须恒可见。
  'browser_debug',
  // PAL 攻坚案件账本（2026-07-17 直入 CORE，预算 26→27）：攻坚场景在会话
  // 中期才出现，EXTENDED 中途挂载 = 改 tool fingerprint = 200K 前缀全量重建
  // （DeepSeek V4 创建 ¥3/M、高峰 ¥6/M，一次一两块）；早期窗口挂载则等于
  // 没有这个功能。常驻是唯一缓存零成本方案——schema 字节稳定进冻结前缀。
  'attack_case',
  // 编排入口（2026-07-29 从 EXTENDED 升入 CORE）：team_orchestrate 是唯一
  // 能派发多 worker 波次 + 门禁 + 审查的主控工具，放在 EXTENDED 等于入口
  // 被默认 deny-list 摘除、用户到不了这条链路。T3 修复——与 attack_case
  // 同理由：中途挂载 = 改 tool fingerprint = 前缀全量重建。
  'team_orchestrate',
] as const

/**
 * EXTENDED 层 — 子代理可用，主控需 opt-in 或委派。
 * web/browser/doc/council/team/import/lsp/undo 等低频或重场景工具。
 */
export const EXTENDED_TOOLS = [
  // browser（一次性 headless）与 browser_debug 能力重叠且默认未注册——退役候选。
  'browser',
  'computer_use',
  'repo_graph',
  // capability 能力索引（2026-07-31 装配）：只读查询本机 dev CLI 能力与缺口
  // （preflight），full 档注册。查询面低频——同 repo_graph/semantic_search
  // 定位，不占 CORE 常驻字节；主控需要时 /tools enable 挂回，worker 始终可用。
  'capability',
  // council_convene 留在 EXTENDED（不随 team_orchestrate 升入 CORE）：
  // 议事会是多视角审查决策，使用频率远低于编排、每次调用的成本也更高
  // （fanout 3-5 审查 worker），不适合占 CORE 常驻字节预算。
  // 主控可用 /tools enable council_convene 或通过 team_orchestrate 触发
  // review gate（L3 = council 审查队，语义等价但入口由编排承担）。
  'council_convene',
  'import_resource',
  'apply_patch',
  'undo',
  // 从 CORE 下放（2026-07-01）：低频或被现有工具覆盖的功能，
  // 主控默认不占视野，worker 仍可用、主控可 /tools enable 挂回。
  'read_section',    // read_file 的 offset/limit 已覆盖区间读取
  'diff',            // git 工具覆盖「working tree diff」
  'inspect_project', // 开局一次性定向，repo_map 已给结构；低频
  'related_tests',   // run_tests/grep/repo_map 覆盖；低频
  'file_info',       // bash(stat/ls/wc) 或 read_file 头部覆盖；低频
  'leave_mark',      // 会话结束留痕，消费方 constellation 默认关(opt-in)
  // desktop tools (create_document, create_spreadsheet, etc.)
  'create_document',
  'create_spreadsheet',
  'create_image',
  'create_presentation',
  'create_pdf',
  'export_file',
  'open_path',
] as const

/** 所有已知工具名 — CORE ∪ EXTENDED */
export const ALL_KNOWN_TOOLS: readonly string[] = [...CORE_TOOLS, ...EXTENDED_TOOLS]

/** CORE 工具集合（O(1) 查找） */
const CORE_SET: ReadonlySet<string> = new Set(CORE_TOOLS)

/** EXTENDED 工具集合 */
const EXTENDED_SET: ReadonlySet<string> = new Set(EXTENDED_TOOLS)

/**
 * 解析主控应使用的工具层。
 *
 * @param domain 当前会话域（可选自定义 mainToolTier 覆盖）
 * @param configEnabled config.toolGating.enabled（默认 true）
 * @param coreOverride 可选的 config 级 CORE 覆盖清单
 * @returns 主控可见的工具名列表
 */
export function resolveMainToolTier(
  domain: Pick<StarDomain, 'mainToolTier'> | null | undefined,
  configEnabled: boolean = true,
  coreOverride?: readonly string[],
): readonly string[] {
  // 门控关闭 → 全量（不做过滤）
  if (!configEnabled) return ALL_KNOWN_TOOLS

  // 域级覆盖优先
  if (domain?.mainToolTier && domain.mainToolTier.length > 0) {
    return domain.mainToolTier
  }

  // config 级覆盖
  if (coreOverride && coreOverride.length > 0) {
    return coreOverride
  }

  // 默认 CORE
  return CORE_TOOLS
}

/**
 * 门控状态 — 描述一次 gateToolDefinitions 的全部输入。
 *
 * 语义分两档：
 *  - allow-list（域级 mainToolTier 或 config coreOverride 显式给定时）：只保留清单内工具，
 *    其余一律摘掉（用户显式接管，自负 MCP/LSP 被摘的后果）。
 *  - deny-list（默认）：只摘 EXTENDED_SET 内的工具，CORE 与一切未分类工具
 *    （MCP / LSP / 自定义注册）原样保留——避免误删用户显式装配的 MCP。
 * 两档都对 exempt（extraCore ∪ mountedExtras）放行。
 * disabledTools（config 级静态禁用）在最后施加，优先级高于一切豁免。 */
export interface ToolGatingState {
  /** config.toolGating.enabled。false → 不过滤，返回全集。 */
  enabled: boolean
  /** 域级 mainToolTier 覆盖（allow-list）。 */
  domainTier?: readonly string[]
  /** config.toolGating.coreTools 覆盖（allow-list）。 */
  coreOverride?: readonly string[]
  /** config.toolGating.extraCore — 永久挂回主控的 EXTENDED 工具。 */
  extraCore?: readonly string[]
  /** 运行时经 /tools enable 临时挂回的 EXTENDED 工具。 */
  mountedExtras?: readonly string[]
  /** config.toolGating.disabledTools — session 启动时生效，运行中不变（缓存约束）。 */
  disabledTools?: readonly string[]
  /** prompt.toolDescriptions —— compact 压缩超长描述，保留硬门禁行。
   *  放在门控里而不是各调用点，是为了让构造期与 updateTools() 天然共用
   *  同一变换：两处不一致会让 MCP 注册后的描述回弹、翻转前缀字节。 */
  toolDescriptions?: ToolDescriptionMode
}

/**
 * 主控工具门控的唯一过滤入口（构造期与 updateTools 共用）。
 *
 * @param allDefs 全量工具定义（kernel + interactive + MCP/LSP）
 * @param state   门控状态
 * @returns 过滤后的工具定义（不修改入参）
 */
export function gateToolDefinitions<T extends { name: string; description?: string }>(
  allDefs: readonly T[],
  state: ToolGatingState,
): T[] {
  if (!state.enabled) return applyDescriptionMode(allDefs, state.toolDescriptions)

  const exempt = new Set<string>([...(state.extraCore ?? []), ...(state.mountedExtras ?? [])])

  // allow-list 模式：域级 tier 优先，其次 config coreOverride
  const allowList =
    state.domainTier && state.domainTier.length > 0
      ? state.domainTier
      : state.coreOverride && state.coreOverride.length > 0
        ? state.coreOverride
        : null

  if (allowList) {
    const allow = new Set<string>([...allowList, ...exempt])
    return applyDescriptionMode(allDefs.filter(d => allow.has(d.name)), state.toolDescriptions)
  }

  // deny-list 模式（默认）：只摘 EXTENDED，保留 CORE + 未分类（MCP/LSP/自定义）
  let filtered = allDefs.filter(d => !EXTENDED_SET.has(d.name) || exempt.has(d.name))

  // config 级静态禁用（最高优先级，即使在 exempt 中也剔除）。
  // 缓存约束：disabledTools 在 session 启动时读 config，运行中不变。
  if (state.disabledTools && state.disabledTools.length > 0) {
    const disabled = new Set(state.disabledTools)
    filtered = filtered.filter(d => !disabled.has(d.name))
  }

  return applyDescriptionMode(filtered, state.toolDescriptions)
}

/** 判断工具是否在 CORE 层 */
export function isCoreTool(name: string): boolean {
  return CORE_SET.has(name)
}

/** 判断工具是否在 EXTENDED 层 */
export function isExtendedTool(name: string): boolean {
  return EXTENDED_SET.has(name)
}

/**
 * 不变量校验：mainToolTier ⊆ toolWhitelist
 * （主控不应有其 worker 调不到的工具）
 */
export function validateTierInvariant(
  mainToolTier: readonly string[],
  toolWhitelist: readonly string[],
): void {
  const whitelistSet = new Set(toolWhitelist)
  const violations = mainToolTier.filter(t => !whitelistSet.has(t))
  if (violations.length > 0) {
    throw new Error(
      `mainToolTier ⊆ toolWhitelist invariant violated: [${violations.join(', ')}] not in toolWhitelist`,
    )
  }
}
