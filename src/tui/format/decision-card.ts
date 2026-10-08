import type { DecisionRequest } from '../engine/decision-controller.js'
import type { LiveRegionLine } from '../engine/live-engine.js'
import type { RivetTheme } from '../theme.js'
import { color } from '../engine/ansi.js'
import { ambiguousWideEnabled, hardWrapToDisplayWidth, truncateToDisplayWidth } from '../width.js'
import { frameInset } from './overlay-frame.js'
import { buildPlanReviewActions } from './plan-review.js'
import { draftToAnswer } from '../../tools/ask-user-question.js'
import { formatMarkdown } from './markdown.js'

export function renderDecisionCard(item: DecisionRequest, width: number, height: number, theme: RivetTheme, count: number, countdown?: number): LiveRegionLine[] {
  const indent = ' '.repeat(frameInset(width))
  const policy = { ambiguousAsWide: ambiguousWideEnabled() }
  const inner = Math.max(1, width - indent.length - 2)
  const lines: LiveRegionLine[] = []
  const add = (text: string, decisionPart?: LiveRegionLine['decisionPart']) => lines.push({ text: truncateToDisplayWidth(`${indent} ${text}`, Math.max(1, width - 1), policy), decisionPart })
  const wrap = (text: string, limit = 2) => text.split('\n').flatMap(s => hardWrapToDisplayWidth(s, inner, policy)).slice(0, limit)
  const q = item.kind === 'question' ? item.questions[item.index] : undefined
  const title = item.kind === 'plan' ? `计划审批 · ${item.info.title}` : `待回答 · ${q ? `${item.index + 1}/${item.questions.length}` : '确认回答'}`
  add(color(truncateToDisplayWidth(title, inner), theme.secondary, { bold: true }), 'title')
  if (item.kind === 'question' && item.questions.length > 1 && height >= 10) {
    const tabs = [...item.questions.map((question, i) => `${i === item.index ? `[${i + 1}]` : i + 1}${draftToAnswer(item.drafts[i]!, question.options) ? '✓' : ''}`),
      item.index === item.questions.length ? '[提交]' : '提交'].join(' · ')
    const label = hardWrapToDisplayWidth(tabs, inner, policy).length === 1 ? tabs
      : `已答 ${item.drafts.filter((draft, i) => draftToAnswer(draft, item.questions[i]!.options)).length}/${item.questions.length} · ${q ? `[${item.index + 1}]` : '[提交]'} · ←→ 切题`
    add(color(label, theme.muted), 'fact')
  }
  if (height >= 10 && item.kind === 'plan' && item.view.date) add(color(item.view.date, theme.muted), 'fact')
  if (item.kind === 'question' && q) for (const line of wrap(q.prompt, height >= 8 ? 2 : 1)) add(color(line, theme.secondary, { bold: true }), 'fact')
  if (count > 1 && height >= 10) add(color(`还有 ${count - 1} 项待决策`, theme.muted))
  if (countdown !== undefined && height >= 8) add(color(`Goal：${countdown}s 后自动批准`, theme.warning), 'fact')
  const hint = item.editing ? 'Enter 确认 · Esc 返回' : item.kind === 'plan'
    ? 'Enter 确认 · Esc 收起 · ↑↓/数字 选择 · Ctrl+E/v 全文 · f 反馈 · PgUp/PgDn 正文'
    : 'Enter 确认 · Esc 收起 · ↑↓/数字 选择 · ←→ 切题 · 空格 多选'
  const hints = wrap(hint, height >= 14 ? 2 : 1)
  const reserved = hints.length + 1 + (item.error ? 1 : 0)
  if (item.submitting) add(color('提交中，请稍候…', theme.warning), 'action')
  else if (item.editing) {
    if (height >= 8) add(color(item.kind === 'plan' ? '反馈输入中 · 驳回反馈' : '自定义回答', theme.warning), 'action')
    const display = item.editor.displayLinesWithCaret({ maxWidth: Math.max(1, inner - 2), maxLines: Math.max(1, Math.min(3, height - lines.length - reserved)) })
    for (const [i, line] of display.lines.entries()) {
      add(line, 'action')
      if (i === display.caret.line) lines[lines.length - 1]!.caretCol = frameInset(width) + 1 + display.caret.col
    }
  } else {
    let entries: { label: string; selected?: boolean; description?: string; recommended?: boolean; reason?: string }[]
    if (item.kind === 'plan') {
      const actions = buildPlanReviewActions(item.info)
      entries = actions.map(a => {
        const option = a.id.startsWith('approve:') ? item.info.options?.[Number(a.id.slice(8))] : a.id === 'approve' ? item.info.options?.[0] : undefined
        return { label: a.label, description: option?.description, recommended: !!option && a.recommended,
          reason: option?.recommendationReason }
      })
      if (height >= 10) add(color(`文档 · /plan-view ${item.info.slug}`, theme.muted), 'fact')
      if (height >= 8) {
        const body = formatMarkdown({ text: item.view.body ?? '（计划正文为空）', columns: inner }, theme)
        const bodyBudget = Math.max(1, Math.min(8, height - lines.length - reserved - entries.length - (item.info.options?.length ? 2 : 0)))
        const start = Math.min(item.scroll, Math.max(0, body.length - bodyBudget))
        for (const line of body.slice(start, start + bodyBudget)) add(line)
      }
    } else if (q) {
      entries = q.options.map((label, i) => ({ label, selected: item.drafts[item.index]!.selected.includes(i),
        description: q.optionDetails?.[i]?.description, recommended: q.optionDetails?.[i]?.recommended,
        reason: q.optionDetails?.[i]?.recommendationReason }))
      entries.push({ label: '输入自定义回答…' }, { label: '在输入框中讨论' })
    } else {
      entries = [{ label: '提交回答' }, { label: '返回输入框' }]
      if (item.kind === 'question') for (const [i, question] of item.questions.entries()) {
        if (lines.length >= height - reserved - 1) break
        const answer = draftToAnswer(item.drafts[i]!, question.options)
        add(truncateToDisplayWidth(`${i + 1}. ${question.prompt} → ${answer ?? '未答，将跳过'}`, inner))
      }
    }
    const recommended = entries.find(e => e.recommended)
    const hasChoices = item.kind === 'plan' ? !!item.info.options?.length : !!q?.options.length
    const reasonRows = hasChoices && height >= 8 ? wrap(`推荐理由：${recommended?.reason || '旧记录未提供推荐理由'}`, height >= 14 ? 2 : 1) : []
    const budget = Math.max(1, height - lines.length - reasonRows.length - reserved)
    const rows = entries.map((e, i) => {
      const box = item.kind === 'question' && q?.allowMultiple && i < q.options.length ? `${e.selected ? '[x]' : '[ ]'} ` : ''
      return wrap(`${i === item.cursor ? '›' : ' '} ${i + 1}. ${box}${e.label}${e.recommended ? '（推荐）' : ''}`, budget)
    })
    // Window whole options around the cursor; a long focused option gets the available rows.
    let start = item.cursor, used = rows[item.cursor]?.length ?? 0
    while (start > 0 && used + rows[start - 1]!.length <= budget) used += rows[--start]!.length
    let remaining = budget
    for (let i = start; i < entries.length && remaining > 0; i++) {
      const focused = i === item.cursor
      if (!focused && rows[i]!.length > remaining) break
      for (const row of rows[i]!.slice(0, remaining)) { add(color(row, focused ? theme.primary : theme.secondary, { bold: focused }), focused ? 'action' : undefined); remaining-- }
      if (focused && entries[i]!.description && remaining > 1) {
        add(color(truncateToDisplayWidth(entries[i]!.description!, inner), theme.muted)); remaining--
      }
    }
    for (const row of reasonRows) add(color(row, theme.muted))
  }
  if (item.error) add(color(truncateToDisplayWidth(`提交失败：${item.error}`, inner), theme.warning), 'fact')
  for (const row of hints) add(color(row, theme.dim), 'footer')
  return lines
}
