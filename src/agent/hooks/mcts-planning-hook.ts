import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import { AnchorVault, type SealedAnchor } from '../anchor-vault.js'
import { MCTSPlanner, type MCTSPlanResult, type MCTSPlannerOpts } from '../mcts-planner.js'
import { buildSeedPrompt } from '../seed-prompt-builder.js'

export interface MCTSPlanningHookOpts {
  /** Calls a lightweight LLM with the given prompt, returns its response */
  callSeedModel: (prompt: string, signal?: AbortSignal) => Promise<string>
  /** Number of branches to explore (default: 3) */
  branches?: number
  /** Which turn to activate MCTS planning (default: 1) */
  planningTurn?: number
  /** Projection threshold — candidates above this are filtered as junk */
  threshold?: number
  /** Getter for the user's original message (task anchor) */
  getUserMessage: () => string | null
  /** Callback to receive the planning result */
  onResult?: (result: MCTSPlanResult) => void
}

/**
 * MCTS Planning Hook — on the configured turn, sends de-anchored prompts
 * to a lightweight seed model, filters junk, injects all surviving seeds
 * as inspiration for the main model.
 */
export function createMCTSPlanningHook(opts: MCTSPlanningHookOpts): PreTurnRuntimeHook {
  const vault = new AnchorVault()
  let sealed: SealedAnchor | null = null
  let hasRun = false
  let signal: AbortSignal | undefined

  const explore: MCTSPlannerOpts['explore'] = async (_task, idx) => {
    signal?.throwIfAborted()
    return opts.callSeedModel(buildSeedPrompt(sealed!, idx), signal)
  }

  const planner = new MCTSPlanner({
    explore,
    branches: opts.branches ?? 3,
    threshold: opts.threshold,
  })
  const planningTurn = opts.planningTurn ?? 1

  return {
    phase: 'preTurn',
    name: 'mcts-planning',
    async run(ctx: RuntimeHookContext) {
      if (hasRun || ctx.snapshot.turn !== planningTurn) return
      hasRun = true

      const userMsg = opts.getUserMessage()
      if (!userMsg) return
      signal = ctx.signal
      signal?.throwIfAborted()
      sealed = vault.seal(userMsg)

      const result = await planner.plan(sealed.original, sealed.phrases)
      signal?.throwIfAborted()
      opts.onResult?.(result)

      if (result.allJunk) {
        ctx.effects.injectUserMessage(
          '<破军-探索 type="mcts">WARNING: All explored paths are pure echo of the task wording. ' +
          'Consider reframing at a higher level of abstraction. 贪狼胶囊（docs/seed-capsule-tanlang.md）有探索方法论。</破军-探索>',
        )
      } else {
        const seedList = result.seeds
          .map((s, i) => `- Seed ${i + 1}: ${s.text}`)
          .join('\n')
        ctx.effects.injectUserMessage(
          `<破军-探索 type="mcts">以下是从不同角度生成的探索路径，供参考：\n${seedList}</破军-探索>`,
        )
      }
    },
  }
}
