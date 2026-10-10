import type { BootstrapContext } from '../bootstrap.js'
import { contractModels } from '../config/contract-models.js'
import { listPlans, rejectPlan, resolvePlanOptionLabel, resolvePlanRef } from '../plan/plan-store.js'
import { planRevision } from '../plan/plan-revision.js'
import type { RecoveryOutput } from './output.js'

export const RECOVERY_HELP = `Text commands (Enter to submit):
/help                         Show commands
/model [provider:model]       List or switch configured models
/abort                        Interrupt the current run
/exit, /quit                  Exit (also interrupts an active run)
/approve, /reject              Answer the currently displayed tool approval
/plan-list                    List plans
/plan-view <slug>             Read a plan and its options
/plan-approve <slug> [option]  Human approval and guarded execution
/plan-reject <slug>           Reject a submitted plan
/skip                        Skip a displayed question
Answer questions with option numbers (comma separated for multiple selections) or your own text.`

export class RecoveryCommands {
  constructor(private ctx: BootstrapContext, private output: RecoveryOutput, private canCommit: () => boolean) {}
  async handle(line: string): Promise<{ handled: boolean; prompt?: string }> {
    if (!this.canCommit()) return { handled: true }
    if (!line.startsWith('/')) return { handled: false }
    const [command, ...parts] = line.split(/\s+/)
    const arg = parts.join(' ')
    const say = (text: string) => this.output.line(text)
    if (command === '/help') say(RECOVERY_HELP)
    else if (command === '/abort') say('[recovery] No active run.')
    else if (command === '/approve' || command === '/reject') say('[recovery] No tool approval is pending.')
    else if (command === '/model') {
      if (!arg) {
        const providers = this.ctx.config?.provider?.providers ?? {}
        for (const [name, provider] of Object.entries(providers)) {
          for (const model of contractModels(provider)) say(`${name}:${model.id}${model.description ? ` — ${model.description}` : ''}`)
        }
        const current = this.ctx.agent.config?.promptEngine?.getModel()
        if (current) say(`[model] Current: ${current}`)
      } else {
        const { switchAgentRuntime } = await import('../bootstrap.js')
        // Qualified model refs are resolved by the shared bootstrap contract.
        if (!this.canCommit()) return { handled: true }
        const result = switchAgentRuntime(this.ctx, arg)
        say(result.ok ? `[model] ${result.modelName}` : `[error] ${result.error}`)
      }
    } else if (command?.startsWith('/plan-')) {
      return await this.plan(command, parts)
    } else say(`[recovery] Unknown command: ${command}. Type /help.`)
    return { handled: true }
  }
  private async plan(command: string, parts: string[]): Promise<{ handled: boolean; prompt?: string }> {
    const say = (text: string) => this.output.line(text)
    const plans = await listPlans(this.ctx.cwd)
    if (!this.canCommit()) return { handled: true }
    if (command === '/plan-list') {
      say(plans.length ? plans.map(p => `${p.slug} — ${p.title} [${p.status}]`).join('\n') : '[plan] No plans.')
      return { handled: true }
    }
    if (!['/plan-view', '/plan-approve', '/plan-reject'].includes(command)) {
      say('[recovery] Unknown plan command. Type /help.')
      return { handled: true }
    }
    const submitted = plans.filter(p => p.status === 'submitted')
    const ref = parts[0] ?? (submitted.length === 1 ? submitted[0]!.slug : '')
    const resolution = resolvePlanRef(plans, ref)
    if (resolution.kind !== 'match') {
      say(resolution.kind === 'ambiguous' ? `[plan] Ambiguous reference: ${resolution.slugs.join(', ')}` : `[plan] Use ${command} <slug>; /plan-list shows available plans.`)
      return { handled: true }
    }
    const plan = resolution.plan
    if (command === '/plan-view') {
      say(plan.content)
      if (plan.options?.length) say(plan.options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`).join('\n'))
      return { handled: true }
    }
    if (plan.status !== 'submitted') { say('[plan] Only submitted plans can be approved or rejected.'); return { handled: true } }
    const revision = planRevision(plan.content)
    if (command === '/plan-reject') {
      const rejected = await rejectPlan(this.ctx.cwd, plan.slug, revision, this.canCommit)
      if (rejected && this.canCommit()) this.ctx.agent.enterPlanMode({ planFilePath: `.rivet/plans/${plan.slug}.md` })
      say(rejected ? `[plan] Rejected: ${plan.slug}` : '[plan] Plan changed or request interrupted; review again.')
      return { handled: true }
    }
    const option = parts.slice(1).join(' ')
    let approach: string | undefined
    if (plan.options?.length) {
      if (option) approach = /^\d+$/.test(option) ? plan.options[Number(option) - 1]?.label : resolvePlanOptionLabel(plan.options, option)
      else approach = plan.options.find(o => o.recommended)?.label ?? plan.options[0]!.label
      if (!approach) { say('[plan] Unknown option; use /plan-view.'); return { handled: true } }
    } else if (option) { say('[plan] This plan has no selectable options.'); return { handled: true } }
    const { approvePlanWithGuards } = await import('../plan/plan-approval.js')
    if (!this.canCommit()) return { handled: true }
    const result = await approvePlanWithGuards(this.ctx.cwd, plan.slug, approach, revision, this.canCommit)
    if (!result.ok) { say(`[plan] ${result.reason}`); return { handled: true } }
    if (!this.canCommit()) { say('[plan] Approval interrupted; execution has not started.'); return { handled: true } }
    this.ctx.agent.setActivePlan({ slug: plan.slug, title: result.approved.title, selectedApproach: approach })
    say(`[plan] Approved: ${plan.slug}${approach ? ` — ${approach}` : ''}`)
    if (result.driftNote) say(result.driftNote)
    return this.canCommit() ? { handled: true, prompt: result.kickoff } : { handled: true }
  }
}
