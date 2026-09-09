/**
 * T9 格式化函数 — GlanceBar 状态栏。
 *
 * 纯函数，从 `glance-bar.tsx` 的渲染逻辑提取。
 * 单行 ANSI 格式化，包含 4 个 zone。
 */

import { homedir } from 'node:os'
import { formatPermissionChrome } from '../../agent/approval-vocabulary.js'
import { STAR_DOMAINS } from '../../agent/star-domain.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'
import { ANSI, color } from '../engine/ansi.js'

/** 将绝对路径的 home 前缀替换为 ~（跨平台）。非 home 下原样返回。 */
export function shortenCwd(cwd: string): string {
  const home = homedir()
  if (!home) return cwd
  // 规范化比较：Windows 盘符大小写不敏感
  const normHome = home.replace(/\\/g, '/')
  const normCwd = cwd.replace(/\\/g, '/')
  if (normCwd === normHome) return '~'
  if (normCwd.startsWith(normHome + '/')) return '~' + cwd.slice(home.length)
  return cwd
}
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { getActiveThemeName, type RivetTheme } from '../theme.js'
import type { CacheStatus } from '../status-types.js'
import { HANDOFF_NUDGE_RATIO } from '../handoff.js'

/** 星域名称 → 主题语义色键（用于 input border / prompt accent 着色）。 */
export function resolveStarDomainAccent(domainName: string | undefined, theme: RivetTheme): string {
  // 单色克制：claude/antigravity/cobalt/graphite/dawn 主题下输入框边框收敛为统一 accent，
  // 不再按星域变色（避免默认星域的 secondary/warning 在 dawn 下变成金色）。
  const active = getActiveThemeName()
  if (active === 'claude' || active === 'antigravity' || active === 'cobalt' || active === 'graphite' || active === 'dawn') return theme.primary
  if (!domainName) return theme.muted
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.name === domainName || id === domainName) {
      return theme[domain.uiPersona.accent]
    }
  }
  return theme.muted
}

/** 星域名称 → GlanceBar 展示（glyph + 中文名），对齐 Ink glance-bar.tsx findDomain。 */
export function resolveStarDomainDisplay(domainName: string | undefined): { glyph: string; name: string } | null {
  if (!domainName) return null
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.name === domainName || id === domainName) {
      return { glyph: domain.uiPersona.glyph, name: domain.name }
    }
  }
  const custom = starDomainRegistry.list().find(d => d.name === domainName || d.id === domainName)
  if (custom) return { glyph: '◇', name: custom.name }
  return { glyph: '☆', name: domainName }
}

export interface GoalStateSnapshot {
  active: boolean
  status: string
  goal: string
  iteration: number
  maxIterations: number
  elapsedMs: number
  wallClockBudgetMs?: number
  criteria: string[]
  criteriaMet?: number
  criteriaUnmet?: number
  criteriaTotal?: number
}

export interface TodoSummary {
  total: number
  done: number
  inProgress: number
  /** 当前 in_progress 任务的 content（保留字段；徽章改为分态计数后不再渲染）。 */
  current?: string
}

/**
 * Todo 计数徽章（badge-first）：compact 档 `≡2/5`（done/total），
 * full 档分态计数 `◐1 ○3 ✓2`（in_progress / pending / completed）。
 * 无 todo 返回 null（不占位）。flash 时反色高亮（done 增加 / total 变化后 ~1s，
 * 由 app 侧计时；reducedMotion 时 app 不传 flash，保持静态色）。
 */
function formatTodoBadge(t: TodoSummary, compact: boolean, theme: RivetTheme, flash: boolean): string | null {
  if (t.total <= 0) return null
  const pending = Math.max(0, t.total - t.done - t.inProgress)
  const text = compact
    ? `≡${t.done}/${t.total}`
    : `◐${t.inProgress} ○${pending} ✓${t.done}`
  if (flash) return `${ANSI.REVERSE}${text}${ANSI.RESET}`
  return color(text, theme.primary)
}

/**
 * DeepSeek 计价时段徽章：compact `◷闲½`/`◷峰`，full `◷闲时半价`/`◷峰时`。
 * 闲时（半价）用 success 高亮（省钱信号），峰时用 muted（常态不抢眼）。
 * 仅提醒当前计价时段，不改记账口径（费用段 ¥ 数字不按时段折半）。
 */
function formatPricingPhaseBadge(phase: 'peak' | 'offpeak', compact: boolean, theme: RivetTheme): string {
  return phase === 'offpeak'
    ? color(compact ? '◷闲½' : '◷闲时半价', theme.success)
    : color(compact ? '◷峰' : '◷峰时', theme.muted)
}

export interface GlanceBarInput {
  /** 终端宽度 */
  width: number
  /** 当前星域标识 */
  domainGlyph?: string
  domainName?: string
  /** Git 分支名 */
  branch?: string
  /** 当前工作目录（~ 缩写后显示在分支后，帮助多会话/多仓库区分） */
  cwd?: string
  /** 模型名称 */
  modelName?: string
  /** 推理 effort glyph */
  reasoningEffort?: string
  /** 缓存命中率 0-1 */
  cacheHitRate?: number
  /** 缓存健康度状态（projectCacheTelemetry 三态判定） */
  cacheStatus?: CacheStatus
  /** DeepSeek 计价时段（仅 provider 为 deepseek 时给出；缺省不渲染计价段） */
  pricingPhase?: 'peak' | 'offpeak'
  /** 上下文占比 0-1 */
  contextRatio?: number
  /** API 实际 prompt token（用于颜色阈值，反映真实窗口压力） */
  estimatedTokens?: number
  /** 可见对话消息的 token 估算（用于 ◧ Xk/Yk 显示，不含系统提示/工具） */
  conversationTokens?: number
  /** 模型上下文窗口 token 上限（与 estimatedTokens 配套） */
  maxTokens?: number
  /** 本轮费用（美元） */
  cost?: number
  /** 已用时间（毫秒） */
  elapsedMs?: number
  /** 是否窄终端（< 60 列） */
  narrow?: boolean
  /** 会话序号 */
  turnCount?: number
  /** 是否处于 stall（无 token 超过阈值） */
  stalled?: boolean
  /** 当前审批模式 */
  approvalMode?: string
  /** 是否处于 plan mode */
  planMode?: boolean
  /** 当前 goal 状态快照 */
  goal?: GoalStateSnapshot
  /** Goal 计划倒计时自动批准的剩余秒数（armed 时每秒刷新；undefined = 未武装） */
  planAutoApproveSec?: number
  /** todo 摘要 */
  todoSummary?: TodoSummary
  /** todo 徽章瞬时高亮（done 增加 / total 变化后 ~1s，app 侧计时；
   *  reducedMotion 时 app 恒传 false → 静态色）。 */
  todoFlash?: boolean
  /**
   * 信息密度分档（Wave 2 减密）：
   * - 'compact'（TUI 默认）：模型 + effort + cache% + 上下文% + 耗时
   * - 'full'：全量（goal/todo/effort/cache/cost 都上）——`/glance full` 切换
   * 未传按 full 处理（兼容既有直接调用方/测试）。
   */
  density?: 'compact' | 'full'
  /** 当前切入的 worker 视图徽章（例如 "◐ T1"）——非空时显示在左区。 */
  workerBadge?: string
  /** 在跑子代理数（FleetRegistry 读模型）——>0 时右区显示 `◐ N`。 */
  fleetRunning?: number
  /** 终态未读子代理数——无在跑时右区显示 `✓ N`（通知徽章，查看后清除）。 */
  fleetUnread?: number
  /** 在跑后台任务数（JobRegistry 读模型）——>0 时右区显示 `⚙ N`。 */
  jobsRunning?: number
  /** team 编队当前波次——team 运行中右区显示 `◆ w2/3`。 */
  teamWave?: { current: number; total: number }
}

export function formatGlanceLeft(input: GlanceBarInput, theme: RivetTheme): string {
  const narrow = input.narrow ?? input.width < 60
  const domainGlyph = input.domainGlyph ?? ''
  const domainLabel = input.domainName ?? '天枢'
  // 分支带 git 符号——视觉上更醒目，是开发高频关注的信息，用 secondary 中亮色
  // （比此前的 dim 灰更突出，与星域 primary 形成层次）。
  const branchPart = !narrow && input.branch ? ` ${input.branch}` : ''
  // cwd 跟在分支后——辅助信息，用 dim（比 muted 略亮，与分支 secondary 形成层次）。
  // 窄终端（<60列）不显示避免挤爆。
  const cwdPart = !narrow && input.cwd ? ` ${shortenCwd(input.cwd)}` : ''

  // 星域专属 accent 色；单色克制主题降级为 muted
  const accentColor = resolveStarDomainAccent(input.domainName, theme)

  const glyphPart = domainGlyph ? `${color(domainGlyph, accentColor)} ` : ''
  // worker 视图徽章：切入子代理视图时提示当前输入路由目标
  const workerPart = input.workerBadge ? ` ${color(`[${input.workerBadge}]`, theme.secondary)}` : ''
  // 三阶色阶层次：accent(星域·最醒目) → secondary(分支·中亮) → dim(cwd·辅助)
  return `${glyphPart}${color(domainLabel, accentColor)}${color(branchPart, theme.secondary)}${color(cwdPart, theme.dim)}${workerPart}`
}

/** 高占用成本提示：上下文 ≥ HANDOFF_NUDGE_RATIO 在底栏常驻建议开新会话——继续推进会触发压缩
 *  （前缀缓存全量重建，成本高）。compact 档用短文案。与交接提醒同档。 */
function contextNewSessionHint(ratio: number, theme: RivetTheme, compact: boolean): string {
  if (ratio < HANDOFF_NUDGE_RATIO) return ''
  return color(compact ? '·建议新会话' : ' · 上下文偏高建议开新会话（压缩成本高）', theme.warning)
}

export function formatGlanceRight(input: GlanceBarInput, theme: RivetTheme): string {
  const narrow = input.narrow ?? input.width < 60
  const compact = input.density === 'compact'
  const parts: string[] = []

  // 权限/计划模式已收敛到输入框下方的常驻权限行（formatPermissionModeLine），
  // GlanceBar 不再重复显示 badge——单一事实来源。

  // 编排状态徽章（team 波次 / 子代理舰队）——瞬态信息放右区最左，最先被读到。
  // 优先级：team 波次 > 在跑 worker > 终态未读（通知徽章，查看后清除）。
  if (input.teamWave) {
    parts.push(color(`◆ w${input.teamWave.current}/${input.teamWave.total}`, theme.secondary))
  } else if (input.fleetRunning !== undefined && input.fleetRunning > 0) {
    parts.push(color(`◐ ${input.fleetRunning}`, theme.primary))
  } else if (input.fleetUnread !== undefined && input.fleetUnread > 0) {
    parts.push(color(`✓ ${input.fleetUnread}`, theme.success))
  }

  // 后台任务徽章：与编排链互斥逻辑独立（后台 job 与子代理可同时存在），
  // 有 running 即占一席。
  if (input.jobsRunning !== undefined && input.jobsRunning > 0) {
    parts.push(color(`⚙ ${input.jobsRunning}`, theme.primary))
  }

  // Todo 计数徽章：与编排徽章相邻（cache% 之前），compact `≡2/5` / full 分态计数；
  // 变化后 ~1s 反色高亮。无 todo 不占位。
  if (input.todoSummary) {
    const badge = formatTodoBadge(input.todoSummary, compact, theme, input.todoFlash === true)
    if (badge) parts.push(badge)
  }

  // ── compact 档：模型 + effort + cache% + 上下文% + 耗时 ──
  if (compact) {
    if (input.modelName) {
      parts.push(color(narrow ? input.modelName.slice(0, 12) : input.modelName, theme.muted))
    }
    // 推理 effort 强度：◎ + 档位。max 高亮(secondary)、high 主色、medium muted、
    // low/off dim。让用户随时看到当前实际生效的思考强度（auto-reasoning 会动态调整）。
    if (input.reasoningEffort) {
      const eff = input.reasoningEffort
      const effShort = eff === 'medium' ? 'med' : eff
      const effColor = eff === 'max' ? theme.secondary
        : eff === 'high' ? theme.primary
        : eff === 'off' ? theme.dim
        : theme.muted
      parts.push(color(`◎${effShort}`, effColor))
    }
    if (input.cacheHitRate !== undefined) {
      const cachePct = (input.cacheHitRate * 100).toFixed(0)
      const cacheColor = input.cacheStatus === 'degraded' ? theme.warning
        : input.cacheStatus === 'stale' ? theme.dim
        : input.cacheHitRate < 0.5 ? theme.warning : theme.muted
      const label = input.cacheStatus === 'degraded' ? `⚡${cachePct}%冷` : `⚡${cachePct}%`
      parts.push(color(label, cacheColor))
    } else {
      // 无缓存数据时显示占位，避免右侧空洞或误导
      parts.push(color('⚡-', theme.dim))
    }
    // DeepSeek 计价时段：与缓存段相邻（同为费用决策信息）；非 deepseek 缺省不占位
    if (input.pricingPhase) parts.push(formatPricingPhaseBadge(input.pricingPhase, true, theme))
    const cRatio = (input.estimatedTokens && input.maxTokens && input.maxTokens > 0)
      ? input.estimatedTokens / input.maxTokens : 0
    if (input.maxTokens && input.maxTokens > 0 && input.estimatedTokens !== undefined) {
      const tokenColor = cRatio >= 0.9 ? theme.error : cRatio >= 0.75 ? theme.warning : theme.muted
      parts.push(color(`◧${(cRatio * 100).toFixed(0)}%`, tokenColor) + contextNewSessionHint(cRatio, theme, true))
    }
    const zone = parts.join('  ')
    const elapsedStr = input.elapsedMs !== undefined ? formatElapsed(input.elapsedMs) : ''
    const elapsedColored = color(elapsedStr, input.stalled ? theme.warning : theme.muted)
    return [zone, elapsedColored].filter(Boolean).join('  ')
  }

  // Goal 进度（active / paused / blocked 都显示，complete 不显示）
  if (input.goal && input.goal.status !== 'complete') {
    const g = input.goal
    const goalText = narrow
      ? `◆${g.iteration}/${g.maxIterations}`
      : `◆ ${g.iteration}/${g.maxIterations} · ${formatElapsed(g.elapsedMs)}`
    const goalColor = g.status === 'blocked' ? theme.error : g.status === 'paused' ? theme.warning : theme.secondary
    parts.push(color(goalText, goalColor))
  }

  // Goal 计划倒计时自动批准（overlay 收起后仍有持续可见性，goal 不"假死"）
  if (input.planAutoApproveSec !== undefined) {
    parts.push(color(narrow ? `⏳${input.planAutoApproveSec}s` : `⏳ 自动批准 ${input.planAutoApproveSec}s`, theme.warning))
  }

  if (input.modelName) {
    // 模型名是用户要读的信息，muted（dim 只留给装饰）
    parts.push(color(narrow ? input.modelName.slice(0, 12) : input.modelName, theme.muted))
  }
  // 推理 effort 强度：◎ + 档位。max 高亮(secondary)、high 主色、medium muted、
  // low/off dim。让用户随时看到当前实际生效的思考强度（auto-reasoning 会动态调整）。
  if (input.reasoningEffort) {
    const eff = input.reasoningEffort
    const effShort = eff === 'medium' ? 'med' : eff
    const effColor = eff === 'max' ? theme.secondary
      : eff === 'high' ? theme.primary
      : eff === 'off' ? theme.dim
      : theme.muted
    parts.push(color(`◎${effShort}`, effColor))
  }
  if (input.cacheHitRate !== undefined) {
    const cachePct = (input.cacheHitRate * 100).toFixed(0)
    const cacheColor = input.cacheStatus === 'degraded' ? theme.warning
      : input.cacheStatus === 'stale' ? theme.dim
      : input.cacheHitRate < 0.5 ? theme.warning : theme.muted
    const label = input.cacheStatus === 'degraded' ? `⚡${cachePct}%冷` : `⚡${cachePct}%`
    parts.push(color(label, cacheColor))
  } else {
    // 无缓存数据时显示占位，避免右侧空洞或误导
    parts.push(color('⚡-', theme.dim))
  }
  // DeepSeek 计价时段：与缓存段相邻（同为费用决策信息）；非 deepseek 缺省不占位
  if (input.pricingPhase) parts.push(formatPricingPhaseBadge(input.pricingPhase, false, theme))
  const ratio = (input.estimatedTokens && input.maxTokens && input.maxTokens > 0)
    ? input.estimatedTokens / input.maxTokens : 0
  const displayTokens = input.conversationTokens !== undefined ? input.conversationTokens : input.estimatedTokens
  if (!narrow && displayTokens !== undefined && input.maxTokens && input.maxTokens > 0) {
    const tokenColor = ratio >= 0.9 ? theme.error : ratio >= 0.75 ? theme.warning : theme.muted
    const pct = `${(ratio * 100).toFixed(0)}%`
    parts.push(color(`◧${formatTokensK(displayTokens)}/${formatTokensK(input.maxTokens)} ${pct}`, tokenColor) + contextNewSessionHint(ratio, theme, false))
  }
  if (input.cost !== undefined && input.cost > 0) {
    // cost > 0 用 secondary 高亮，让用户感知到花费
    parts.push(color(`¥${input.cost.toFixed(2)}`, theme.secondary))
  }
  const zone3 = parts.join('  ')

  let zone4 = ''
  if (input.elapsedMs !== undefined) {
    zone4 = formatElapsed(input.elapsedMs)
  }
  // elapsed 是用户要读的元信息用 muted；stall 时提升到 warning 作为提示
  const elapsedPart = color(zone4, input.stalled ? theme.warning : theme.muted)

  return [zone3, elapsedPart].filter(Boolean).join('  ')
}

/**
 * 输入框下方常驻权限模式行（CC 的 `⏵⏵ bypass permissions on` 位）。
 * 单一事实来源：GlanceBar 不再显示权限 badge，全部收敛到这一行。
 * 着色沿用旧 badge 映射：自动=muted / ask=warning / 全自动=error / auto-accept=success / plan=primary。
 */
export function formatPermissionModeLine(
  input: { approvalMode?: string; planMode?: boolean; askMode?: boolean; planDraftPath?: string },
  theme: RivetTheme,
): string {
  const hint = color('(shift+tab plan · /ask 问答)', theme.dim)
  if (input.askMode) {
    return `  ${color('⏵ ask mode', theme.warning)} ${hint}`
  }
  if (input.planMode) {
    const draft = input.planDraftPath
      ? ` ${color(truncateToDisplayWidth(input.planDraftPath, 28), theme.dim)}`
      : ''
    return `  ${color('⏵ plan mode', theme.primary)}${draft} ${hint}`
  }
  const mode = input.approvalMode ?? 'auto-safe'
  const chrome = formatPermissionChrome(mode)
  const [label, modeColor] = mode === 'manual' ? [chrome, theme.warning]
    : mode === 'dangerously-skip-permissions' ? [chrome, theme.error]
    : mode === 'auto-accept' ? [chrome, theme.success]
    : [chrome, theme.muted]
  return `  ${color(`⏵ ${label}`, modeColor)} ${hint}`
}

/**
 * 格式化 GlanceBar 为单行 ANSI 字符串。
 *
 * Zone 布局：domain ┃ model cache tokens ┃ … elapsed
 * 运行态相位已收敛到顶部 spinner 状态行（CC 对标），GlanceBar 不再重复显示。
 */
export function formatGlanceBar(input: GlanceBarInput, theme: RivetTheme): string {
  const left = formatGlanceLeft(input, theme)
  const rightFull = formatGlanceRight(input, theme)

  const leftLen = stripAnsiLen(left)
  const maxRight = input.width - 2 - leftLen - 4  // 4 = min gap
  const rightLen = stripAnsiLen(rightFull)

  let right = rightFull
  if (rightLen > maxRight) {
    // If it exceeds, we can fallback to progressive truncation
    const narrow = input.narrow ?? input.width < 60
    const parts: string[] = []
    if (input.modelName) {
      parts.push(color(narrow ? input.modelName.slice(0, 12) : input.modelName, theme.muted))
    }
    const rightSep = '  '
    let accumulated = 0
    right = ''
    for (const item of parts) {
      const itemLen = stripAnsiLen(item)
      const addLen = accumulated > 0 ? rightSep.length + itemLen : itemLen
      if (accumulated + addLen <= maxRight) {
        right = accumulated > 0 ? right + rightSep + item : item
        accumulated += addLen
      } else {
        break
      }
    }
  }

  const gap = Math.max(4, input.width - 2 - leftLen - stripAnsiLen(right))

  return `${left}${' '.repeat(gap)}${right}`
}

export function stripAnsiLen(s: string): number {
  // 必须用 display width（非 .length）：CJK(天枢)/全角符号每字符占 2 列但 .length 计 1。
  // 用 .length 会让 padding/截断欠估 → 状态行被撑到 ≥ 终端宽度 → 末列自动换行 →
  // LiveEngine 行数计算与终端实际换行错位 → clear() 欠擦 → chrome 残留进 scrollback(重复渲染)。
  // 口径须与 rowsForLine 一致（ambiguousAsWide）：星域 glyph(◇☆)/· 等在 CJK 终端按
  // 2 列渲染，narrow(stringWidth) 会欠估 → gap 偏大 → 状态行仍可能溢出折行。
  return displayWidth(s, { ambiguousAsWide: true })
}

/** token 用量进度条：0-1 比例 → 10 格填充条 + 百分比，按水位变色（≥90% error / ≥75% warning）。
 *  侧边面板（side-panel.ts）的「Token 仪表」使用。曾随双行 GlanceBar 特性引入，后该特性
 *  被 revert，但 side-panel 仍依赖此独立函数——此处单独保留它，不复活被 revert 的双行逻辑。 */
export function formatTokenProgressBar(ratio: number, theme: RivetTheme): string {
  const r = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(r * 10)
  const empty = 10 - filled
  const barColor = r >= 0.9 ? theme.error : r >= 0.75 ? theme.warning : theme.dim
  const fillChar = r >= 0.9 ? '▇' : r >= 0.75 ? '▆' : '▅'
  const bar = color(fillChar.repeat(filled), barColor) + color('░'.repeat(empty), theme.dim)
  const pct = color(`${(r * 100).toFixed(0)}%`, barColor)
  return `${bar} ${pct}`
}

/** token 计数压缩为可读单位：
 *  - < 1k   → 原值（"850"）
 *  - < 1M   → 取整 k（"12k"、"200k"）
 *  - ≥ 1M   → 一位小数 M（"1.0M"、"2.5M"，≥10M 改取整以避免视觉过宽）
 *  把 "1000k" 这类宽度怪物压成 "1.0M" 是领航星 2026-06-11 在 T9 GlanceBar 上的
 *  实测诉求——1M 窗口下原显示宽度把 GlanceBar 顶到换行临界。 */
function formatTokensK(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

function formatElapsed(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}
