import { formatPermissionChrome } from '../../agent/approval-vocabulary.js'
import { stripVTControlCharacters } from 'node:util'
import { color } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth, ambiguousWideEnabled } from '../width.js'
import { shortenCwd, formatCvmBadge, formatPricingPhaseBadge } from './glance-bar.js'
import { formatOfficialUsageBadge, type CachePanelOfficial } from './cache-panel.js'
import type { RivetTheme } from '../theme.js'

const policy = () => ({ ambiguousAsWide: ambiguousWideEnabled() })
function fit(text: string, width: number): string {
  if (displayWidth(text, policy()) <= width) return text
  return truncateToDisplayWidth(text, Math.max(0, width - displayWidth('…', policy())), policy()) + '…'
}

export function formatWorkspacePath(cwd: string, columns: number, theme: RivetTheme): string {
  const label = '工作区：', width = Math.max(1, columns - 1)
  const path = stripVTControlCharacters(cwd).replace(/[\r\n\t]/g, ' ')
  const available = width - displayWidth(label, policy())
  if (displayWidth(path, policy()) <= available) return color(label + path, theme.muted)
  if (available < 4) return color(fit(label + path, width), theme.muted)
  const head = truncateToDisplayWidth(path, Math.floor(available / 3), policy())
  const tailWidth = available - displayWidth(head + '…', policy())
  let tail = ''
  const parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(path))
  for (const part of parts.reverse()) {
    if (displayWidth(part.segment + tail, policy()) > tailWidth) break
    tail = part.segment + tail
  }
  return color(label + head + '…' + tail, theme.muted)
}

/** Stable identity belongs to the workspace, never to the editable prompt border. */
export function formatWorkspaceIdentity(input: {
  width: number; rows: number; modelName: string; domainName?: string; domainGlyph?: string; cwd?: string; branch?: string; worker?: string
}, theme: RivetTheme): string[] {
  if (input.rows < 14) return []
  const width = Math.max(1, input.width - 1)
  const brand = `${input.domainGlyph ?? '✦'} 天枢${input.domainName && input.domainName !== '天枢' ? ` · ${input.domainName}` : ''}`
  const cwd = input.cwd ? shortenCwd(input.cwd).replaceAll('\\', '/') : ''
  const project = cwd.split('/').filter(Boolean).at(-1) ?? ''
  const location = input.worker ? `→ ${input.worker}` : width < 80 ? project : cwd
  const left = color(brand, theme.primary, { bold: true })
  const model = color(input.modelName, theme.muted)
  const context = location ? color(location, theme.muted) : ''
  const parts = [left, context, model].filter(Boolean)
  const joined = parts.join('  ')
  if (displayWidth(joined, policy()) <= width) return [left + '  ' + model, color(fit('  ' + stripVTControlCharacters(input.cwd ?? '').replace(/[\r\n\t]/g, ' '), width), theme.muted)]
  const top = [left, context].filter(Boolean).join('  ')
  return [fit(top, width), fit(`  ${model}`, width)]
}

/** One truthful mode row; detailed telemetry and task contents remain in their panels. */
export function formatWorkspaceMode(input: {
  width: number; approvalMode: string; planMode?: boolean; askMode?: boolean; tasks?: number; steps?: number; stashed?: boolean; worker?: string; zenBadge?: string; cvmInterceptions?: number; pricingPhase?: 'peak' | 'offpeak'; officialUsage?: CachePanelOfficial | null
}, theme: RivetTheme): string {
  const mode = input.approvalMode
  const tint = mode === 'manual' ? theme.warning : mode === 'dangerously-skip-permissions' ? theme.error
    : mode === 'auto-accept' ? theme.success : theme.muted
  const permission = color(`权限：${formatPermissionChrome(mode)}`, tint)
  const activity = input.askMode ? '问答' : input.planMode ? '计划' : '对话'
  const parts = [permission, color(activity, input.planMode ? theme.primary : theme.muted)]
  if (input.cvmInterceptions !== undefined) parts.push(formatCvmBadge(input.cvmInterceptions, theme))
  if (input.pricingPhase) parts.push(formatPricingPhaseBadge(input.pricingPhase, input.width < 80, theme))
  // 常驻余额角标（issue #98）——与计价时段相邻（同属「钱」的信号）；
  // loading / 未配置 / 查询失败时 formatOfficialUsageBadge 返回 null → 不占位。
  if (input.officialUsage) {
    const badge = formatOfficialUsageBadge(input.officialUsage, input.pricingPhase, theme)
    if (badge) parts.push(badge)
  }
  if (input.tasks) parts.push(color(`任务 ${input.tasks} · /tasks`, theme.muted))
  if (input.steps) parts.push(color(`步骤 ${input.steps} · Ctrl+X T`, theme.muted))
  if (input.stashed) parts.push(color('草稿已暂存', theme.muted))
  if (input.zenBadge) parts.push(color(input.zenBadge, theme.muted))
  while (parts.length > 1 && displayWidth(parts.join('  '), policy()) > input.width - 1) parts.pop()
  return fit(parts.join('  '), Math.max(1, input.width - 1))
}
