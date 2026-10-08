import { InputLine } from './input-line.js'
import type { KeyPress } from './input-handler.js'
import type { AskUserQuestionInfo, PlanSubmittedInfo } from '../../tools/types.js'
import { composeAnswers, draftToAnswer, type AskAnswerDraft } from '../../tools/ask-user-question.js'
import { buildPlanReviewActions, recommendedPlanReviewAction } from '../format/plan-review.js'

export interface PlanReviewView { body?: string; date?: string; revision?: string; info?: PlanSubmittedInfo }
export interface PlanDecision {
  requestId: string
  info: PlanSubmittedInfo
  revision?: string
  action: string
  feedback?: string
}
export type PlanDecisionResult = { ok: true } | { ok: false; error: string; refresh?: PlanReviewView }
export interface DecisionHost {
  changed(): void
  reveal(): void
  preview(slug: string): void
  participate(): void
  plan(decision: PlanDecision): Promise<PlanDecisionResult>
  answer(text: string, requestId: string): Promise<void>
  record(text: string): void
}
interface BaseRequest {
  id: string
  visible: boolean
  cursor: number
  submitting: boolean
  error?: string
  editor: InputLine
  editing: boolean
}
export interface PlanRequest extends BaseRequest {
  kind: 'plan'
  info: PlanSubmittedInfo
  view: PlanReviewView
  scroll: number
}
export interface QuestionRequest extends BaseRequest {
  kind: 'question'
  questions: AskUserQuestionInfo['questions']
  index: number
  drafts: AskAnswerDraft[]
}
export type DecisionRequest = PlanRequest | QuestionRequest

/** Pending decisions outlive their presentation. Only successful settlement removes them. */
export class DecisionController {
  private plans: PlanRequest[] = []
  private questions: QuestionRequest[] = []
  private settled = new Set<string>()
  private nonce = 0
  private generation = 0
  private busy = false
  private answering = false
  constructor(private readonly host: DecisionHost) {}

  get epoch(): number { return this.generation }
  get plan(): PlanRequest | undefined { return this.plans[0] }
  get question(): QuestionRequest | undefined { return this.questions[0] }
  get active(): DecisionRequest | undefined { return this.question ?? (!this.busy && !this.answering ? this.plan : undefined) }
  get count(): number { return this.plans.length + this.questions.length }
  get focused(): boolean { return this.active?.visible === true }
  get editing(): boolean { return this.focused && this.active?.editing === true }
  private base(id?: string): BaseRequest {
    return { id: id ?? `decision-${++this.nonce}`, visible: true, cursor: 0, submitting: false, editor: new InputLine(), editing: false }
  }
  openPlan(info: PlanSubmittedInfo, view: PlanReviewView = {}): void {
    if (info.requestId && this.settled.has(info.requestId)) return
    const existing = this.plans.find(p => p.info.slug === info.slug)
    if (existing && ((!info.requestId || existing.id === info.requestId) && (!view.revision || view.revision === existing.view.revision))) {
      existing.view = { ...existing.view, ...view }
      this.host.changed()
      return
    }
    const first = !this.count
    const actions = buildPlanReviewActions(info)
    const item: PlanRequest = { ...this.base(info.requestId), kind: 'plan', info, view, scroll: 0 }
    item.cursor = Math.max(0, actions.indexOf(recommendedPlanReviewAction(actions)!))
    if (existing) this.plans[this.plans.indexOf(existing)] = item
    else this.plans.push(item)
    if (first) this.host.reveal()
    this.host.changed()
  }
  openQuestions(info: AskUserQuestionInfo): void {
    if (!info.questions.length || (info.requestId && (this.settled.has(info.requestId) || this.questions.some(q => q.id === info.requestId)))) return
    const first = !this.count
    this.questions.push({ ...this.base(info.requestId), kind: 'question', questions: info.questions, index: 0,
      drafts: info.questions.map(() => ({ selected: [], otherSelected: false, otherText: '', skipped: false })) })
    if (first) this.host.reveal()
    this.host.changed()
  }
  clear(): void { this.generation++; this.plans = []; this.questions = []; this.settled.clear(); this.answering = false; this.busy = false; this.host.changed() }
  removePlan(slug?: string): void { if (slug) this.plans = this.plans.filter(p => p.info.slug !== slug); else this.plans.shift(); this.host.changed() }
  removeQuestions(): void { this.questions.shift(); this.host.changed() }
  setBusy(busy: boolean): void { this.busy = busy; if (!busy) this.answering = false; if (this.count) this.host.changed() }
  collapse(): void { if (this.active) this.active.visible = false; this.host.changed() }
  restore(): void { if (this.active) this.active.visible = true; this.host.changed() }
  paste(text: string): boolean {
    if (!this.focused) return false
    if (this.editing && !this.active!.submitting) this.active!.editor.insertText(text)
    this.host.changed()
    return true
  }
  private edit(item: DecisionRequest): void {
    this.host.participate()
    item.editing = true
    if (item.kind === 'question') item.editor.setValue(item.drafts[item.index]?.otherText ?? '')
    this.host.changed()
  }
  chooseQuestion(id: string): void {
    const item = this.question
    const q = item?.questions[item.index]
    if (!item || !q) return
    const draft = item.drafts[item.index]!
    if (id === '__other__') {
      if (!item.editor.value.trim()) return
      if (!q.allowMultiple) draft.selected = []
      draft.otherSelected = true; draft.otherText = item.editor.value.trim(); draft.skipped = false
      item.editing = false
      this.advance(item)
    } else {
      const index = Number(id)
      if (!Number.isInteger(index) || index < 0 || index >= q.options.length) return
      if (q.allowMultiple) draft.selected = draft.selected.includes(index) ? draft.selected.filter(i => i !== index) : [...draft.selected, index]
      else { draft.selected = [index]; draft.otherSelected = false; draft.otherText = ''; this.advance(item) }
      draft.skipped = false
    }
    this.host.changed()
  }
  advance(item = this.question): void {
    if (!item) return
    const next = item.questions.findIndex((q, i) => i > item.index && !draftToAnswer(item.drafts[i]!, q.options))
    item.index = next >= 0 ? next : item.questions.length
    item.cursor = 0
    item.editing = false
    this.host.changed()
  }
  async settlePlan(action: string): Promise<void> {
    const item = this.active
    if (!item || item.kind !== 'plan' || item.submitting) return
    const generation = this.generation
    item.submitting = true; item.error = undefined
    this.host.participate(); this.host.changed()
    try {
      const result = await this.host.plan({ requestId: item.id, info: item.info, revision: item.view.revision,
        action, ...(action === '__reject_comment__' ? { feedback: item.editor.value.trim() } : {}) })
      if (this.generation !== generation || !this.plans.includes(item)) return
      if (result.ok) {
        this.settled.add(item.id)
        this.plans = this.plans.filter(p => p !== item)
        this.host.record(`计划「${item.info.title}」· ${action.startsWith('approve') ? '已批准' : '已驳回'}`)
      } else {
        item.error = result.error
        if (result.refresh) { item.view = result.refresh; if (result.refresh.info) item.info = result.refresh.info; item.cursor = 0; item.editing = false; item.scroll = 0 }
      }
    } catch (err) { if (this.generation === generation && this.plans.includes(item)) item.error = String(err instanceof Error ? err.message : err) }
    finally { item.submitting = false; if (this.generation === generation) this.host.changed() }
  }
  async submitAnswers(): Promise<void> {
    const item = this.question
    if (!item || item.submitting) return
    const generation = this.generation
    item.submitting = true; item.error = undefined; this.answering = true
    this.host.participate(); this.host.changed()
    try {
      await this.host.answer(composeAnswers(item.questions, item.drafts, '已全部跳过'), item.id)
      if (this.generation !== generation || !this.questions.includes(item)) return
      this.settled.add(item.id)
      this.questions = this.questions.filter(q => q !== item)
    } catch (err) {
      if (this.generation === generation && this.questions.includes(item)) { item.error = err instanceof Error ? err.message : String(err); this.answering = false }
    } finally { item.submitting = false; if (this.generation === generation) this.host.changed() }
  }
  handleKey(key: KeyPress, composerEmpty: boolean, completion: boolean): boolean {
    const item = this.active
    if (!item) return false
    if (!item.visible) {
      if (key.name === 'tab' && composerEmpty && !completion) { this.restore(); return true }
      return false
    }
    if (key.name === 'ctrl_c' || key.name.startsWith('f') && /^f\d+$/.test(key.name)) return false
    if (item.submitting) return true
    if (item.editing) {
      if (key.name === 'escape') {
        if (item.kind === 'question') item.drafts[item.index]!.otherText = item.editor.value
        item.editing = false; this.host.changed(); return true
      }
      if (key.name === 'return') {
        if (item.kind === 'plan') void this.settlePlan('__reject_comment__')
        else this.chooseQuestion('__other__')
      } else { item.editor.handleKey(key.name, key.char, !!key.ctrl, !!key.meta, !!key.shift); this.host.changed() }
      return true
    }
    if (key.name === 'ctrl_e' && item.kind === 'plan') {
      this.host.participate()
      this.host.preview(item.info.slug)
      return true
    }
    if (key.ctrl || key.meta || key.name.startsWith('ctrl_') || key.name === 'shift_tab') return false
    if (key.name === 'escape' || key.name === 'tab') { this.collapse(); return true }
    if (['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'return'].includes(key.name) || /^[1-9vf ]$/i.test(key.char)) this.host.participate()
    if (item.kind === 'plan') {
      const actions = buildPlanReviewActions(item.info)
      if (key.name === 'up' || key.name === 'down') item.cursor = (item.cursor + (key.name === 'up' ? -1 : 1) + actions.length) % actions.length
      else if (key.name === 'pageup' || key.name === 'pagedown') item.scroll = Math.max(0, item.scroll + (key.name === 'pageup' ? -6 : 6))
      else if (key.char.toLowerCase() === 'v') this.host.preview(item.info.slug)
      else if (key.char.toLowerCase() === 'f') this.edit(item)
      else if (key.name === 'return') void this.settlePlan(actions[item.cursor]!.id)
      else if (/^[1-9]$/.test(key.char) && actions[Number(key.char) - 1]) void this.settlePlan(actions[Number(key.char) - 1]!.id)
    } else {
      if (key.name === 'left' || key.name === 'right') { item.index = Math.max(0, Math.min(item.questions.length, item.index + (key.name === 'left' ? -1 : 1))); item.cursor = 0 }
      else {
        const q = item.questions[item.index]
        const rows = q ? q.options.length + 2 : 2
        if (key.name === 'up' || key.name === 'down') item.cursor = (item.cursor + (key.name === 'up' ? -1 : 1) + rows) % rows
        else if (/^[1-9]$/.test(key.char) && Number(key.char) <= rows) {
          item.cursor = Number(key.char) - 1
          this.confirmQuestion(item, true)
        } else if (key.name === 'return' || key.char === ' ') this.confirmQuestion(item, key.char === ' ')
      }
    }
    this.host.changed()
    return true
  }
  private confirmQuestion(item: QuestionRequest, toggle: boolean): void {
    const q = item.questions[item.index]
    if (!q) { if (item.cursor === 0) void this.submitAnswers(); else this.collapse(); return }
    if (item.cursor === q.options.length) { this.edit(item); return }
    if (item.cursor > q.options.length) { this.collapse(); return }
    if (q.allowMultiple && !toggle) { this.advance(item); return }
    this.chooseQuestion(String(item.cursor))
  }
}
