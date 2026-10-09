import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi, type MakeAppOptions } from './_harness.js'
import { renderDecisionCard } from '../../format/decision-card.js'
import { getTheme } from '../../theme.js'

const question = { requestId: 'visible-question', questions: [{
  id: 'scope', prompt: '问题标题必须可见', allowMultiple: false,
  options: ['第一方案', '第二方案', '第三方案', '第四方案'],
  optionDetails: [{ recommended: true, recommendationReason: '推荐理由必须可见' }, {}, {}, {}],
}] }
const plan = { requestId: 'visible-plan', slug: 'visible-plan', title: '计划标题必须可见', options: [
  { label: '第一方案', description: '方案说明', recommended: true, recommendationReason: '推荐理由必须可见' },
  { label: '第二方案', description: '另一方案' },
] }
const draft = Array.from({ length: 12 }, (_, i) => `保留输入第${i + 1}行`).join('\n')
const todos = Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, content: `任务第${i + 1}项`, status: 'pending' as const }))

async function create(opts: MakeAppOptions) {
  const h = makeApp(opts)
  await (h.app as any).frontend.ready
  if (opts.renderer === 'fullscreen') {
    ;(h.app as any).frontend.startFullscreen(false)
    ;(h.app as any).overlay.setBorrowed(true)
  }
  return h
}

// Force a complete draw and inspect only its emitted text, never earlier frames.
function currentFrame(h: ReturnType<typeof makeApp>): string {
  const app = h.app as any
  if (app.frontend.isFullscreen) app.frontend.invalidate()
  else app.live.clear()
  h.out.clear()
  app.rerender()
  return stripAnsi(h.out.chunks.join(''))
}

function open(h: ReturnType<typeof makeApp>, kind: 'question' | 'plan'): void {
  if (kind === 'question') h.app.openAskUserQuestionPanel(question)
  else h.app.openPlanApprovalPanel(plan, { body: Array.from({ length: 30 }, (_, i) => `正文第${i + 1}行`).join('\n') })
}

for (const renderer of ['classic', 'fullscreen'] as const) {
  for (const kind of ['question', 'plan'] as const) {
    for (const extra of ['none', 'draft', 'todos'] as const) {
      test(`${renderer} ${kind}: final frame keeps the complete decision ahead of ${extra}`, async () => {
        const h = await create({ renderer, cols: 80, rows: 24 })
        try {
          h.app.callbacks.onPhaseChange!('waiting')
          if (extra === 'draft') h.app.setInput(draft)
          if (extra === 'todos') {
            h.app.setTodos(todos)
            h.stdin.dataHandler!('\x18'); h.stdin.dataHandler!('t')
          }
          open(h, kind)
          const screen = currentFrame(h)
          assert.match(screen, kind === 'question' ? /待回答.*1\/1/ : /计划审批.*计划标题必须可见/)
          assert.match(screen, /› 1\./, 'the selected action must survive every later row budget')
          assert.match(screen, /第二方案/)
          assert.match(screen, /推荐理由必须可见/)
          assert.match(screen, /Enter 确认/)
          if (kind === 'question') {
            assert.match(screen, /问题标题必须可见/)
            assert.match(screen, /第四方案/)
            assert.match(screen, /输入自定义回答/)
            assert.match(screen, /在输入框中讨论/)
          } else {
            assert.match(screen, /正文第3行/)
            assert.match(screen, /驳回修订/)
            assert.match(screen, /驳回并退出/)
            assert.match(screen, /Ctrl\+E\/v 全文/)
          }
          if (extra === 'draft') assert.equal(h.app.getInputValue(), draft, 'compact display must preserve the entire draft')
          if (renderer === 'classic') assert.ok((h.app as any).live.lastDisplayRows <= 23, 'no frame may spill past the terminal')
        } finally { h.app.dispose() }
      })
    }

    test(`${renderer} ${kind}: shrinking and restoring keeps title, focus and footer with a long draft`, async () => {
      const h = await create({ renderer, cols: 80, rows: 24 })
      try {
        h.app.setInput(draft)
        open(h, kind)
        for (let i = 0; i < 3; i++) h.stdin.dataHandler!('\x1b[B')
        for (const [cols, rows] of [[40, 10], [35, 8], [80, 24]]) {
          h.out.columns = cols!; h.out.rows = rows!
          const screen = currentFrame(h)
          assert.match(screen, kind === 'question' ? /待回答/ : /计划审批/)
          assert.match(screen, kind === 'question' ? /› 4\. 第四方案/ : /› 4\. 驳回并退出/)
          assert.match(screen, /Enter 确认/)
          assert.equal(h.app.decisions.active?.cursor, 3)
          assert.equal(h.app.getInputValue(), draft)
          if (renderer === 'classic') assert.ok((h.app as any).live.lastDisplayRows < rows!, 'resizing must not overflow')
        }
      } finally { h.app.dispose() }
    })

    for (const expanded of [false, true]) {
      test(`${renderer} ${kind}: ${expanded ? 'expanded' : 'compact'} sidebar cannot grow the budgeted frame on resize`, async () => {
        const h = await create({ renderer, cols: 160, rows: 24 })
        try {
          h.app.setInput(draft)
          h.app.setTodos(expanded ? Array.from({ length: 30 }, (_, i) => ({ ...todos[0]!, id: String(i), content: `任务第${i + 1}项` })) : todos)
          if (expanded) { h.stdin.dataHandler!('\x18'); h.stdin.dataHandler!('t') }
          h.app.setSidePanelOpen(true)
          open(h, kind)
          const screen = currentFrame(h)
          assert.match(screen, kind === 'question' ? /待回答/ : /计划审批/)
          assert.match(screen, /› 1\./)
          assert.match(screen, /第二方案/)
          assert.match(screen, /推荐理由必须可见/)
          assert.match(screen, /Enter 确认/)
          for (let i = 0; i < 3; i++) h.stdin.dataHandler!('\x1b[B')
          for (const rows of [10, 24]) {
            h.out.rows = rows
            const resized = currentFrame(h)
            assert.match(resized, kind === 'question' ? /待回答/ : /计划审批/)
            assert.match(resized, kind === 'question' ? /› 4\. 第四方案/ : /› 4\. 驳回并退出/)
            assert.match(resized, /Enter 确认/)
            assert.equal(h.app.decisions.active?.cursor, 3)
            assert.equal(h.app.getInputValue(), draft)
            if (renderer === 'classic') assert.ok((h.app as any).live.lastDisplayRows < rows)
          }
        } finally { h.app.dispose() }
      })
    }

    test(`${renderer} ${kind}: five-row screen keeps title, focused action and confirmation control`, async () => {
      const h = await create({ renderer, cols: 80, rows: 5 })
      try {
        h.app.setInput(draft)
        open(h, kind)
        for (let i = 0; i < 3; i++) h.stdin.dataHandler!('\x1b[B')
        for (const error of [undefined, '提交失败的详细说明']) {
          h.app.decisions.active!.error = error
          const screen = currentFrame(h)
          assert.match(screen, kind === 'question' ? /待回答/ : /计划审批/)
          assert.match(screen, kind === 'question' ? /› 4\. 第四方案/ : /› 4\. 驳回并退出/)
          assert.match(screen, /Enter 确认/)
          assert.equal(h.app.getInputValue(), draft)
          if (renderer === 'classic') assert.ok((h.app as any).live.lastDisplayRows < 5)
        }
        h.out.rows = 24
        assert.match(currentFrame(h), /提交失败：提交失败的详细说明/)
        assert.equal(h.app.decisions.active?.cursor, 3)
      } finally { h.app.dispose() }
    })

    test(`${renderer} ${kind}: multiline metadata cannot smuggle extra rows past the card budget`, async () => {
      const h = await create({ renderer, cols: 80, rows: 24 })
      try {
        h.app.setInput(draft)
        const description = '说明第一行\n说明第二行\r\t说明第三行\u0085\x1b[2J说明第四行'
        if (kind === 'question') h.app.openAskUserQuestionPanel({ ...question, questions: [{ ...question.questions[0]!,
          optionDetails: [{ ...question.questions[0]!.optionDetails[0], description }, {}, {}, {}],
        }] })
        else h.app.openPlanApprovalPanel({ ...plan, title: '计划标题\n第二行', options: [{ ...plan.options[0]!, description }, plan.options[1]!] }, { body: '计划正文' })
        const lines = renderDecisionCard(h.app.decisions.active!, 80, 17, getTheme(), 1)
        assert.ok(lines.every(line => !/[\r\n\t\u0085]|\x1b\[2J/.test(line.text)), 'each card entry must represent one physical terminal row without cursor controls')
        const screen = currentFrame(h)
        assert.match(screen, kind === 'question' ? /待回答/ : /计划审批/)
        assert.match(screen, /› 1\./)
        assert.match(screen, /推荐理由必须可见/)
        assert.match(screen, /Enter 确认/)
      } finally { h.app.dispose() }
    })

    for (const mode of ['narrow', 'wide', 'full']) {
      test(`${renderer} ${kind}: ${mode} width keeps the same focused action and controls`, async () => {
        const previous = process.env.RIVET_AMBIGUOUS_WIDTH
        process.env.RIVET_AMBIGUOUS_WIDTH = mode
        const h = await create({ renderer, cols: 60, rows: 20 })
        try {
          h.app.setInput(draft)
          open(h, kind)
          h.stdin.dataHandler!('\x1b[B')
          const screen = currentFrame(h)
          assert.match(screen, kind === 'question' ? /待回答/ : /计划审批/)
          assert.match(screen, /› 2\./)
          assert.match(screen, /第二方案/)
          assert.match(screen, /Enter 确认/)
          assert.equal(h.app.getInputValue(), draft)
          assert.equal(h.app.decisions.active?.cursor, 1)
        } finally {
          h.app.dispose()
          if (previous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
          else process.env.RIVET_AMBIGUOUS_WIDTH = previous
        }
      })
    }
  }

  test(`${renderer}: preview return and failed submission preserve a complete plan with the original selection`, async () => {
    const h = await create({ renderer, cols: 80, rows: 24 })
    try {
      h.app.setInput(draft)
      h.app.registerOverlays({ pagerContent: () => ({ content: '计划全文', page: 0 }) })
      h.app.onPlanDecision = async () => ({ ok: false, error: '第一行错误\n第二行错误' })
      open(h, 'plan')
      h.stdin.dataHandler!('\x1b[B'); h.stdin.dataHandler!('\x05')
      assert.equal(h.app.activeOverlayId(), 'pager')
      h.stdin.dataHandler!('\x1b')
      assert.equal(h.app.activeOverlayId(), null)
      assert.match(currentFrame(h), /› 2\. 批准 — 第二方案/)
      await h.app.decisions.settlePlan('approve:1')
      const screen = currentFrame(h)
      assert.match(screen, /计划审批/)
      assert.match(screen, /› 2\. 批准 — 第二方案/)
      assert.match(screen, /提交失败：第一行错误/)
      assert.match(screen, /Enter 确认/)
      assert.equal(h.app.getInputValue(), draft)
      assert.equal(h.app.decisions.plan?.cursor, 1)
    } finally { h.app.dispose() }
  })
}
