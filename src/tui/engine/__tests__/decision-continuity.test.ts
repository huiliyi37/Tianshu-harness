import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import { formatAskUserQuestion } from '../../format/ask-user-question.js'
import { renderDecisionCard } from '../../format/decision-card.js'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'

const question = { requestId: 'continuity-question', questions: [
  { id: 'release', prompt: '现在发布吗？', options: ['立即发布', '稍缓'], allowMultiple: false },
  { id: 'desktop', prompt: '桌面端怎么安排？', options: ['先修补池', '直接重打'], allowMultiple: false },
] }
const plan = { requestId: 'continuity-plan', slug: 'fix-panels', title: '修复交互区域' }

test('answered questions flow directly into the chosen answers without repeating unused options', async () => {
  const { app } = makeApp({ cols: 244, rows: 65 })
  try {
    app.decisionPanelsAttached = true
    app.onSubmit(() => {})
    app.openAskUserQuestionPanel(question)
    app.callbacks.onToolResult(question.requestId, 'ask_user_question', '等待回答', false, undefined,
      '1. 现在发布吗？\n  1. 立即发布\n  2. 稍缓\n2. 桌面端怎么安排？\n  1. 先修补池\n  2. 直接重打')
    app.decisions.chooseQuestion('0')
    app.decisions.chooseQuestion('0')
    await app.decisions.submitAnswers()
    const history = stripAnsi((app as any).commit.getContent())
    assert.match(history, /现在发布吗？ → 立即发布/)
    assert.match(history, /桌面端怎么安排？ → 先修补池/)
    assert.doesNotMatch(history, /稍缓|直接重打/, 'settlement must not reprint all unchosen options')
    assert.doesNotMatch(history, /[┌┐└┘│]/, 'history must remain a continuous conversation')
    assert.equal((history.match(/已提交回答/g) ?? []).length, 1)
  } finally { app.dispose() }
})

test('unanswered questions retain every option in a narrow, open transcript', () => {
  const content = '中文选项👨‍👩‍👧‍👦'.repeat(8)
  const lines = formatAskUserQuestion({ content, columns: 35 }, getTheme()).map(stripAnsi)
  assert.ok(lines.every(line => displayWidth(line) <= 35))
  assert.doesNotMatch(lines.join('\n'), /[┌┐└┘│]/)
  assert.equal(lines.slice(1).map(line => line.trimStart()).join(''), content)
})

test('plan review exposes the document and enough Markdown to read before choosing an action', () => {
  const { app } = makeApp()
  try {
    app.openPlanApprovalPanel(plan, { body: Array.from({ length: 30 }, (_, i) => `文档正文第${i + 1}行`).join('\n') })
    const lines = renderDecisionCard(app.decisions.plan!, 80, 18, getTheme(), 1)
    const view = stripAnsi(lines.map(line => line.text).join('\n'))
    assert.match(view, /\/plan-view fix-panels/, 'the plan can be reopened from this conversation')
    assert.match(view, /文档正文第5行/, 'review should use available height for the document')
    assert.match(view, /批准并执行/)
    assert.ok(lines.length <= 18)
  } finally { app.dispose() }
})

test('Ctrl+E previews the plan and returns to the same selection without approving it', () => {
  const { app, stdin } = makeApp()
  try {
    app.registerOverlays({ pagerContent: () => ({ content: '完整 Markdown 计划正文', page: 0 }) })
    app.openPlanApprovalPanel(plan, { body: '审批正文' })
    stdin.dataHandler!('\x1b[B')
    const selected = app.decisions.plan!.cursor
    stdin.dataHandler!('\x05')
    assert.equal(app.activeOverlayId(), 'pager')
    assert.equal(app.getPlanPreview()?.slug, 'fix-panels')
    stdin.dataHandler!('\x1b')
    assert.equal(app.activeOverlayId(), null)
    assert.equal(app.decisions.plan!.cursor, selected)
    assert.equal(app.decisions.plan!.id, plan.requestId)
  } finally { app.dispose() }
})

test('Ctrl+E still edits feedback normally instead of opening a preview', () => {
  const { app, stdin } = makeApp()
  try {
    app.openPlanApprovalPanel(plan)
    stdin.dataHandler!('f')
    stdin.dataHandler!('反馈正文')
    stdin.dataHandler!('\x01')
    stdin.dataHandler!('\x05')
    assert.equal(app.activeOverlayId(), null)
    assert.equal(app.decisions.plan!.editor.cursor, '反馈正文'.length)
  } finally { app.dispose() }
})

test('plan preview wraps long Markdown and searches the rendered rows without hiding code', () => {
  const { app, out, stdin } = makeApp({ cols: 35, rows: 14 })
  try {
    const content = '# 审查计划\n\n' + '很长的计划正文'.repeat(30) + '唯一标记\n\n```ts\n'
      + Array.from({ length: 70 }, (_, i) => `const step${i + 1} = ${i + 1}`).join('\n') + '\n```'
    app.registerOverlays({ pagerContent: () => ({ content, page: 0 }) })
    out.clear()
    app.openPlanPreview(plan.slug)
    assert.doesNotMatch(stripAnsi(out.chunks.join('')), /# 审查计划/, 'Markdown headings are rendered')
    for (const query of ['唯一标记', 'step70']) {
      out.clear()
      stdin.dataHandler!('/')
      stdin.dataHandler!(query)
      stdin.dataHandler!('\r')
      assert.match(stripAnsi(out.chunks.join('')), new RegExp(query), 'search exposes the complete matching row')
      stdin.dataHandler!('\x1b')
    }
  } finally { app.dispose() }
})

test('plan mode exposes a draft preview entry above the composer without the side panel', () => {
  const { app, out } = makeApp({ cols: 80, rows: 24 })
  try {
    app.setPlanModeProvider(() => true)
    app.setPlanDraftProvider(() => ({ path: '.rivet/plans/active-draft.md', bytes: 128 }))
    out.clear()
    ;(app as any).renderLive()
    const screen = stripAnsi(out.chunks.join(''))
    assert.match(screen, /计划草稿/)
    assert.match(screen, /\/plan-view/)
  } finally { app.dispose() }
})

test('question tabs expose completed answers and the current question without framing the conversation', () => {
  const { app } = makeApp()
  try {
    app.openAskUserQuestionPanel(question)
    app.decisions.chooseQuestion('0')
    const lines = renderDecisionCard(app.decisions.question!, 80, 18, getTheme(), 1)
    const view = stripAnsi(lines.map(line => line.text).join('\n'))
    assert.match(view, /1✓/)
    assert.match(view, /\[2\]/)
    assert.match(view, /提交/)
    assert.doesNotMatch(view, /[┌┐└┘│]/)
  } finally { app.dispose() }
})

test('decision rows respect CJK terminal width policies without triggering automatic line wraps', () => {
  const previous = process.env.RIVET_AMBIGUOUS_WIDTH
  const { app } = makeApp()
  try {
    app.openAskUserQuestionPanel(question)
    for (const mode of ['wide', 'full']) {
      process.env.RIVET_AMBIGUOUS_WIDTH = mode
      for (const width of [35, 60, 80]) {
        const lines = renderDecisionCard(app.decisions.question!, width, 18, getTheme(), 1)
        assert.ok(lines.every(line => displayWidth(line.text, { ambiguousAsWide: true }) < width), `${mode}: ${width} columns`)
      }
    }
  } finally {
    if (previous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = previous
    app.dispose()
  }
})

test('plan search finds a phrase split by soft wrapping and stays on it after a resize', () => {
  const { app, out, stdin } = makeApp({ cols: 35, rows: 14 })
  try {
    const content = '甲'.repeat(14) + '唯一标记\n\n' + Array.from({ length: 40 }, (_, i) => `尾部第${i}行`).join('\n')
    app.registerOverlays({ pagerContent: () => ({ content, page: 0 }) })
    app.openPlanPreview(plan.slug)
    stdin.dataHandler!('/')
    stdin.dataHandler!('唯一标记')
    stdin.dataHandler!('\r')
    const nav = (app as any).overlayController.nav()
    assert.equal(nav.pagerSearchCurrent, 1, 'soft wrapping must not change search semantics')
    out.clear()
    out.columns = 100
    ;(app as any).renderLive()
    ;(app as any).overlay.rerender()
    assert.match(stripAnsi(out.chunks.join('')), /唯一标记/, 'resize keeps the current search match visible')
  } finally { app.dispose() }
})

test('plan reading retains its logical paragraph when the window width changes', () => {
  const { app, out, stdin } = makeApp({ cols: 35, rows: 14 })
  try {
    const content = '甲'.repeat(100) + '\n\n目标段落\n\n' + Array.from({ length: 40 }, (_, i) => `尾部第${i}行`).join('\n')
    app.registerOverlays({ pagerContent: () => ({ content, page: 0 }) })
    app.openPlanPreview(plan.slug)
    for (let i = 0; i < 8; i++) stdin.dataHandler!('\x1b[B')
    out.clear()
    out.columns = 100
    ;(app as any).renderLive()
    ;(app as any).overlay.rerender()
    assert.match(stripAnsi(out.chunks.join('')), /目标段落/)
  } finally { app.dispose() }
})

test('plan tables preserve searchable cell text across narrow wrapping', () => {
  const { app, stdin } = makeApp({ cols: 35, rows: 14 })
  try {
    const content = '| AAAAAAAAAA | Value |\n| --- | --- |\n| a | ' + '甲'.repeat(6) + '唯一标记 |'
    app.registerOverlays({ pagerContent: () => ({ content, page: 0 }) })
    app.openPlanPreview(plan.slug)
    stdin.dataHandler!('/')
    stdin.dataHandler!('唯一标记')
    stdin.dataHandler!('\r')
    assert.equal((app as any).overlayController.nav().pagerSearchCurrent, 1)
  } finally { app.dispose() }
})

test('leaving search after a resize returns to the original logical reading position', () => {
  const { app, out, stdin } = makeApp({ cols: 35, rows: 14 })
  try {
    const content = '甲'.repeat(100) + '\n\n原阅读段落\n\n' + Array.from({ length: 40 }, (_, i) => `尾部第${i}行`).join('\n')
    app.registerOverlays({ pagerContent: () => ({ content, page: 0 }) })
    app.openPlanPreview(plan.slug)
    for (let i = 0; i < 8; i++) stdin.dataHandler!('\x1b[B')
    stdin.dataHandler!('/')
    stdin.dataHandler!('尾部第20行')
    stdin.dataHandler!('\r')
    out.columns = 100
    ;(app as any).renderLive()
    ;(app as any).overlay.rerender()
    out.clear()
    stdin.dataHandler!('\x1b')
    assert.match(stripAnsi(out.chunks.join('')), /原阅读段落/)
  } finally { app.dispose() }
})
