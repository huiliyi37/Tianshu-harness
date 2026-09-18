/**
 * 派发契约卡 — worker 起跑瞬间写进 scrollback 的内联条目。
 *
 * 只承载「他要去干什么、往哪个方向找」：目标 + 范围。轮次预算、超时、
 * 工具白名单摘要**刻意不进**——那些是机械参数，读者从卡片里得不到判断力。
 * authorityReason 同样不进：`star-domain.ts::resolveAuthorityReason` 多数
 * 情况返回「显式指定」，constraints 多为 profile 输出格式样板，都是噪音。
 *
 * 纯函数出行（`string[]`），不碰 IO——渲染与提交分离，便于单测。
 */

import stringWidth from 'string-width'
import { truncateToDisplayWidth } from '../width.js'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { ContractProjection } from '../../agent/contract-projection.js'
import { shortOrderLabel } from '../../tools/worker-activity-stream.js'
import { profileLabel, authorityStarName } from './profile-labels.js'

/** 字段标签后的正文起始列：3 空格 + 2 字宽标签 + 2 空格。 */
const FIELD_INDENT = 9
/** objective 折行上限——模型偶尔写长文，别让一个 worker 刷掉半屏 scrollback。 */
const MAX_OBJECTIVE_LINES = 4
/** 范围行最多列几个条目，其余折成 "+N"。 */
const MAX_SCOPE_ITEMS = 4

export interface DispatchCardOptions {
  columns: number
  theme: RivetTheme
}

import { ANSI_SEQ_RE } from '../engine/ansi.js'

/**
 * 控制字符清洗。objective 是模型自由文本，本函数的产物直接 write 到
 * scrollback——放行 ESC 等于把光标控制权交给模型输出。先整段剥转义序列，
 * 再清残余控制字符，最后压平空白（换行由折行逻辑接管）。
 */
function sanitize(text: string): string {
  return text
    .replace(ANSI_SEQ_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 按显示宽度折行。CJK 无空格可断，所以先尝试在空格处断，断不出来就硬断。
 * 宽度口径与 overlay 一致（`truncateToDisplayWidth` + `string-width`），
 * 避免全角字符把行撑过终端宽度。
 */
export function wrapByDisplayWidth(text: string, width: number, maxLines = Number.MAX_SAFE_INTEGER): string[] {
  if (width <= 0) return text ? [text] : []
  const out: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (stringWidth(rest) <= width) {
      out.push(rest)
      break
    }
    if (out.length === maxLines - 1) {
      out.push(truncateToDisplayWidth(rest, Math.max(1, width - 1)) + '…')
      break
    }
    const head = truncateToDisplayWidth(rest, width)
    // 只在靠后的空格处断行；太靠前会把一行切得过短，不如硬断。
    const lastSpace = head.lastIndexOf(' ')
    const cut = lastSpace > head.length / 2 ? lastSpace : head.length
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return out
}

/**
 * 范围摘要：files 取 basename（全路径在窄终端里挤不下且信息密度低），
 * symbols 原样追加。两者皆空返回 undefined —— 调用方整行省略，不留空标签。
 */
export function formatScopeSummary(scope: ContractProjection['scope'] | undefined): string | undefined {
  if (!scope) return undefined
  const items: string[] = []
  for (const f of scope.files ?? []) {
    const base = f.split(/[/\\]/).pop()
    if (base) items.push(base)
  }
  for (const s of scope.symbols ?? []) {
    if (s) items.push(s)
  }
  const unique = [...new Set(items)]
  if (unique.length === 0) return undefined
  const shown = unique.slice(0, MAX_SCOPE_ITEMS).join(' · ')
  return unique.length > MAX_SCOPE_ITEMS ? `${shown} +${unique.length - MAX_SCOPE_ITEMS}` : shown
}

/**
 * 派发契约卡。无边框——scrollback 是自然流，不需要等宽对齐，加框反而
 * 在窄终端折行时错位。
 *
 * ```
 *  ◆ 派发 T1 · 天璇 · 侦察·代码
 *    目标  在 src/tui/format/ 下定位 /tasks 舰队行的渲染函数与列宽计算
 *    范围  overlay.ts · fleet-registry.ts
 * ```
 */
export function formatWorkerDispatchCard(
  contract: ContractProjection,
  workOrderId: string,
  opts: DispatchCardOptions,
): string[] {
  const { columns, theme } = opts
  const lines: string[] = []

  const star = authorityStarName(contract.authority)
  const role = profileLabel(contract.profile)
  const headParts = [shortOrderLabel(workOrderId), ...(star ? [star] : []), role]
  lines.push(
    ` ${color('◆', theme.primary)} ${color(`派发 ${headParts.join(' · ')}`, theme.secondary)}`,
  )

  const bodyWidth = Math.max(8, columns - FIELD_INDENT - 1)
  const pad = ' '.repeat(FIELD_INDENT)

  const objective = sanitize(contract.objective)
  if (objective) {
    const wrapped = wrapByDisplayWidth(objective, bodyWidth, MAX_OBJECTIVE_LINES)
    wrapped.forEach((seg, i) => {
      lines.push(i === 0 ? `   ${color('目标', theme.muted)}  ${seg}` : `${pad}${seg}`)
    })
  }

  const scope = formatScopeSummary(contract.scope)
  if (scope) {
    const wrapped = wrapByDisplayWidth(sanitize(scope), bodyWidth, 2)
    wrapped.forEach((seg, i) => {
      lines.push(i === 0
        ? `   ${color('范围', theme.muted)}  ${color(seg, theme.muted)}`
        : `${pad}${color(seg, theme.muted)}`)
    })
  }

  return lines
}
