/**
 * T9 格式化函数 — 内联子代理舰队面板（live 区）。
 *
 * 从 FleetRegistry 的 per-worker 快照渲染一个紧凑的多行结构化总览。
 * 仅依赖 fleet-registry 视图类型 + ansi/theme + profile-labels，框架无关。
 *
 * 设计取舍：live 区寸土寸金，默认只展示在跑 worker（终态摘要随委派工具卡片
 * 进入 scrollback）。行数有上限，溢出折叠为 "…(+N)"。
 *
 * V2：去掉 UUID 前缀和英文 profile——用序号 #N + 中文职能名。
 *     去掉假进度条——用简洁计数行。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { FleetWorkerView } from '../fleet-registry.js'
import { formatElapsed } from '../worker-panel-model.js'
import { formatWorkerIdentity, statusWord } from './profile-labels.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'

export interface WorkerFleetSummary {
  done: number
  total: number
  running: number
}

function statusGlyph(status: FleetWorkerView['status']): string {
  switch (status) {
    case 'running': return '◐'
    case 'completed': return '✓'
    case 'failed': return '✗'
    case 'blocked': return '⊗'
    case 'escalated': return '↑'
  }
}

/** 状态词（行尾右对齐，对齐 kimi-code 子代理块的可读状态列）。
 *  已上移至 profile-labels.ts 共享（detail 头部同口径）。 */

const WIDE = { ambiguousAsWide: true }

/** 状态 → 主题色键：与主区/侧栏共用，保证宽窄屏切换时颜色不突变。
 *  completed + review-findings（审查拦截）→ warning 黄，区别于系统失败的 error 红。 */
function statusColorKey(status: FleetWorkerView['status'], failureReason?: string): keyof RivetTheme {
  if (status === 'completed' && failureReason === 'review-findings') return 'warning'
  switch (status) {
    case 'running': return 'primary'
    case 'completed': return 'success'
    case 'failed': return 'error'
    default: return 'warning'
  }
}

function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  // 压平空白：activity/summary 是自由文本，嵌入 \n 会让 live region 单行
  // 占多个显示行，破坏 LiveEngine 行数追踪（输入框重影）。渲染层兜底压平。
  const flat = text.replace(/\s+/g, ' ').trim()
  // 宽度账按显示列数而非字符数——CJK objective 按字符放行必折行（树形崩坏、
  // live 行高估），且 slice 可劈开代理对。与同文件 formatWorkerRow 同口径。
  if (displayWidth(flat, WIDE) <= max) return flat
  const ellipsisWidth = displayWidth('…', WIDE)
  if (max < ellipsisWidth) return truncateToDisplayWidth(flat, max, WIDE)
  return `${truncateToDisplayWidth(flat, max - ellipsisWidth, WIDE)}…`
}

/**
 * 为 worker 列表分配序号：同 profile 内从 1 开始递增。
 * 单个 profile 只有一个 worker 时不显示序号。
 */
function assignLabels(workers: FleetWorkerView[]): string[] {
  const profileCount = new Map<string, number>()
  const profileSeen = new Map<string, number>()
  // 第一遍：统计每个 profile 出现次数
  for (const w of workers) {
    profileCount.set(w.profile, (profileCount.get(w.profile) ?? 0) + 1)
  }
  // 第二遍：分配标签。身份与续行/详情/派发卡同源（formatWorkerIdentity），
  // 需要 #N 序号时在其返回值后追加——同屏不得出现两种拼法。
  return workers.map(w => {
    const label = formatWorkerIdentity({ profile: w.profile, authority: w.authority })
    const count = profileCount.get(w.profile) ?? 1
    if (count <= 1) return label
    const seq = (profileSeen.get(w.profile) ?? 0) + 1
    profileSeen.set(w.profile, seq)
    return `${label} #${seq}`
  })
}

/** 紧凑 token 数：1234 → "1.2k"，890 → "890"。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface FleetLine {
  text: string
  kind: 'header' | 'worker' | 'activity' | 'overflow' | 'hint'
  status?: FleetWorkerView['status']
}

/**
 * 树形两行结构（CC Task 进度对标）：
 *  分支行 `├─/└─ glyph label · N 工具 · Xk tok · elapsed   状态词`
 *  活动行 `│  ⎿ 最新活动`（末支用空白续行；无活动时省略）
 * 状态词右对齐成一列（对齐到最长分支行 + 2，不贴终端右缘——宽屏下避免悬空）。
 */
function buildEntries(
  workers: FleetWorkerView[],
  summary: WorkerFleetSummary | undefined,
  width: number,
  maxRows: number,
  compact = false,
): FleetLine[] {
  const rule = Math.min(Math.max(40, width), 80)
  const lines: FleetLine[] = []

  const running = summary?.running ?? workers.filter(w => w.status === 'running').length
  const maxElapsedStr = formatElapsed(workers.reduce((n, w) => Math.max(n, w.elapsedMs), 0))
  if (summary && summary.total > 0) {
    const parts: string[] = []
    if (running > 0) {
      parts.push(`${running} 执行中`)
    }
    if (summary.done > 0) {
      parts.push(`${summary.done}/${summary.total} 完成`)
    }
    if (maxElapsedStr) parts.push(maxElapsedStr)
    lines.push({ text: ` ◐ 子代理 · ${parts.join(' · ') || `${summary.total} 个`}`, kind: 'header' })
  } else {
    const suffix = maxElapsedStr ? ` · ${maxElapsedStr}` : ''
    lines.push({ text: ` ◐ 子代理 · ${workers.length} 执行中${suffix}`, kind: 'header' })
  }

  const visible = workers.slice(0, maxRows)
  const overflow = workers.length - visible.length
  const labels = assignLabels(visible)

  for (let i = 0; i < visible.length; i++) {
    const w = visible[i]!
    const isLast = i === visible.length - 1 && overflow <= 0
    const branch = isLast ? '└─' : '├─'
    const cont = isLast ? '  ' : '│ '
    const glyph = statusGlyph(w.status)
    const elapsed = formatElapsed(w.elapsedMs)

    // 主行：任务优先。有 objective 用 objective，否则回退身份。
    // 预算 = 总宽 − 前缀（` ├─ ● ` 6 列）− 实际尾（elapsed），不再用偏小的
    // 常数 8——尾部 `  12m30s` 一类最坏就到 8 列，常数预算在长尾时仍会折行。
    const objective = w.contract?.objective
    const identity = formatWorkerIdentity({ profile: w.profile, authority: w.authority })
    const stats: string[] = []
    if (w.toolUseCount > 0) stats.push(`${w.toolUseCount} 工具`)
    if (w.tokenCount > 0) stats.push(`${fmtTokens(w.tokenCount)} tok`)

    // 紧凑档（live 区）：身份 + 目标 + 计数压进同一行——对标 CC 的
    // `● general-purpose  {描述}  7m 44s · 68.6k tokens`。每 worker 恒 1 行，
    // 舰队规模不再按 2 倍放大 live region 高度。
    if (compact) {
      const prefix = ` ${branch} ${glyph} ${identity}  `
      const tailParts = [...stats]
      if (elapsed) tailParts.push(elapsed)
      const tail = tailParts.length > 0 ? `  ${tailParts.join(' · ')}` : ''
      const budget = rule - displayWidth(prefix, WIDE) - displayWidth(tail, WIDE)
      const mainText = truncate(objective ?? labels[i]!, Math.max(8, budget))
      lines.push({ text: `${prefix}${mainText}${tail}`, kind: 'worker', status: w.status })
      continue
    }

    // 主行：任务优先。有 objective 用 objective，否则回退身份。
    // 预算 = 总宽 − 前缀（` ├─ ● ` 6 列）− 实际尾（elapsed），不再用偏小的
    // 常数 8——尾部 `  12m30s` 一类最坏就到 8 列，常数预算在长尾时仍会折行。
    const prefix = ` ${branch} ${glyph} `
    const tail = elapsed ? `  ${elapsed}` : ''
    const mainText = truncate(objective ?? labels[i]!, rule - displayWidth(prefix, WIDE) - displayWidth(tail, WIDE))
    lines.push({ text: `${prefix}${mainText}${tail}`, kind: 'worker', status: w.status })

    // 续行：身份 · 计数 · 状态词（objective 已在主行时，身份下沉到这里）。
    const metaParts = [identity, ...stats, statusWord(w.status)]
    const head = ` ${cont}   `
    const metaLine = truncate(metaParts.join(' · '), Math.max(0, rule - displayWidth(head, WIDE)))
    lines.push({ text: `${head}${metaLine}`, kind: 'activity', status: w.status })
  }

  if (overflow > 0) {
    lines.push({ text: ` └─ …(+${overflow})`, kind: 'overflow' })
  }

  // 退路提示（kimi-code 的 Ctrl+B 提示对标）：让管理入口随块可见，不靠记忆。
  // 紧凑档省掉整行——入口由调用方并进汇总头（见 app.ts 的 chrome 段）。
  if (running > 0 && !compact) {
    lines.push({ text: ' ⎿ /tasks 管理面板（↑↓ 选择 · f 切入 · x 停止）', kind: 'hint' })
  }

  return lines
}

/**
 * 生成内联舰队面板的纯文本行（无颜色，便于测试）。
 * 第一行是汇总头，其后每个 worker 一到两行（分支行 + 可选活动行）。
 */
export function buildWorkerFleetLines(
  workers: FleetWorkerView[],
  summary: WorkerFleetSummary | undefined,
  width = 80,
  maxRows = 6,
  compact = false,
): string[] {
  return buildEntries(workers, summary, width, maxRows, compact).map(l => l.text)
}

/**
 * 渲染内联舰队面板为带色 ANSI 行：
 *  汇总头/折叠/活动行 → muted · running → primary · passed → success · 其余 → warning。
 */
export function formatWorkerFleet(
  workers: FleetWorkerView[],
  theme: RivetTheme,
  width = 80,
  summary?: WorkerFleetSummary,
  maxRows = 6,
  compact = false,
): string[] {
  const entries = buildEntries(workers, summary, width, maxRows, compact)
  return entries.map(l => {
    if (l.kind === 'worker') {
      if (l.status === 'running') return color(l.text, theme.primary)
      if (l.status === 'completed') return color(l.text, theme.success)
      return color(l.text, theme.warning)
    }
    if (l.kind === 'hint') return color(l.text, theme.dim)
    return color(l.text, theme.muted)
  })
}

/**
 * 渲染完成沉淀卡（settle card）：委派组整体终态后，以与 live 树同构的
 * 树形静态卡「落」进 scrollback（spatial consistency——形态恒定）。
 *
 * 与 live 树的差异：无活动续行，每 worker 一行附带终态摘要尾（≤50 字符）；
 * 头行聚合全组统计（通过数/总工具/总 token/最长耗时）。超过 maxRows 折叠
 * 为 `…(+N)`。workers 应为同一委派组的终态视图（FleetRegistry.clearGroup
 * 返回值的 settled 字段）。
 *
 * 头行配色：全部通过 → success；任一失败/受阻 → warning。
 */
export function formatWorkerFleetSettled(
  workers: FleetWorkerView[],
  theme: RivetTheme,
  width = 80,
  maxRows = 8,
): string[] {
  if (workers.length === 0) return []
  const rule = Math.min(Math.max(40, width), 80)
  const passed = workers.filter(w => w.status === 'completed').length
  const totalTools = workers.reduce((n, w) => n + w.toolUseCount, 0)
  const totalTokens = workers.reduce((n, w) => n + w.tokenCount, 0)
  const maxElapsed = workers.reduce((n, w) => Math.max(n, w.elapsedMs), 0)

  const headParts = [`${passed}/${workers.length} 通过`]
  if (totalTools > 0) headParts.push(`${totalTools} 工具`)
  if (totalTokens > 0) headParts.push(`${fmtTokens(totalTokens)} tok`)
  const maxElapsedStr = formatElapsed(maxElapsed)
  if (maxElapsedStr) headParts.push(maxElapsedStr)
  const allPassed = passed === workers.length
  const header = color(` ◆ 子代理组 · ${headParts.join(' · ')}`, allPassed ? theme.success : theme.warning)

  const lines: string[] = [header]
  const visible = workers.slice(0, maxRows)
  const overflow = workers.length - visible.length
  const labels = assignLabels(visible)
  for (let i = 0; i < visible.length; i++) {
    const w = visible[i]!
    const isLast = i === visible.length - 1 && overflow <= 0
    const branch = isLast ? '└─' : '├─'
    const glyph = statusGlyph(w.status)
    const stats: string[] = []
    if (w.toolUseCount > 0) stats.push(`${w.toolUseCount} 工具`)
    if (w.tokenCount > 0) stats.push(`${fmtTokens(w.tokenCount)} tok`)
    const statsStr = stats.length > 0 ? ` · ${stats.join(' · ')}` : ''
    const elapsed = formatElapsed(w.elapsedMs)
    const tail = elapsed ? `  ${elapsed}` : ''
    const plain = ` ${branch} ${glyph} ${labels[i]!}${statsStr}${tail}`
    const summary = w.activity ? ` — ${w.activity}` : ''
    const budget = Math.max(0, rule - plain.length - 1)
    const text = summary ? `${plain}${truncate(summary, budget)}` : plain
    lines.push(color(text, theme[statusColorKey(w.status, w.failureReason)] as string))
  }
  if (overflow > 0) {
    lines.push(color(` └─ …(+${overflow})`, theme.muted))
  }
  return lines
}

/**
 * 渲染单个 worker 行（带色 ANSI）—— 主区与侧栏共用，保证宽窄屏切换时字段不突变。
 *
 * 字段顺序与 formatWorkerFleet 单行一致：`glyph label [activity] elapsed`
 *  - glyph：statusGlyph（◐/✓/✗/⊗/↑）
 *  - label：星名 · 中文职能名（同主区）
 *  - activity：仅当 width 充足时显示（窄列省略，避免挤压 label）
 *  - elapsed：formatElapsed
 *  - 颜色：statusColorKey（running=primary / passed=success / failed=error / 其余=warning）
 *
 * @param worker 单个 worker 视图
 * @param theme 主题
 * @param width 该行可用宽度（display-width 口径，含 ambiguousAsWide）。≤0 时不渲染。
 */
export function formatWorkerRow(worker: FleetWorkerView, theme: RivetTheme, width: number): string {
  if (width <= 0) return ''
  const WIDE = { ambiguousAsWide: true }
  const glyph = statusGlyph(worker.status)
  // 身份与 formatWorkerIdentity 同源——主区行/侧栏/续行/详情不得两种拼法。
  const labelBase = formatWorkerIdentity({ profile: worker.profile, authority: worker.authority })
  const elapsed = formatElapsed(worker.elapsedMs)
  const colorKey = statusColorKey(worker.status, worker.failureReason)
  // theme[colorKey] 在类型上是 string | 函数（部分主题键是 formatter），但语义色键
  // （primary/success/error/warning/muted/dim）恒为 ANSI 字符串。断言为 string 即可。
  const accent = theme[colorKey] as string

  // 头部：`  glyph label`（前导 2 空格与主区缩进一致）
  const head = `   ${glyph} ${labelBase}`
  const tail = elapsed ? `  ${elapsed}` : ''
  // activity 仅在剩余空间 ≥ 6 列（含分隔）时显示，否则省略。
  const headW = displayWidth(head, WIDE)
  const tailW = displayWidth(tail, WIDE)
  const activityBudget = width - headW - tailW - 2
  let activity = ''
  if (worker.activity && activityBudget >= 6) {
    // 同 truncate：压平嵌入换行，live region 单行槽位不得携带 \n。
    const flat = worker.activity.replace(/\s+/g, ' ').trim()
    const ellipsisW = displayWidth('…', WIDE)
    activity = ' ' + (displayWidth(flat, WIDE) > activityBudget
      ? `${truncateToDisplayWidth(flat, activityBudget - ellipsisW, WIDE)}…`
      : flat)
  }
  return color(`${head}${activity}${tail}`, accent)
}
