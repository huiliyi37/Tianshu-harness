import { createHash } from 'node:crypto'
import { createAnchorGraph } from '../prompt/anchor-graph.js'
import { normalizeAntiAnchoringConfig, type AntiAnchoringConfigInput } from './anti-anchoring-config.js'
import { type StreamClient } from '../api/stream-client.js'
import { type OaiChatRequest } from '../api/oai-types.js'

/**
 * Dependencies for {@link AntiAnchoringController}. All AgentLoop access goes
 * through closures so the controller never imports AgentLoop. Wired in
 * loop-factory.ts.
 */
export interface AntiAnchoringDeps {
  getFingerprint: () => { systemSha256: string; toolsSha256: string }
  getModel: () => string
  getLastCycleClose: () => string | null | undefined
  getSessionId: () => string | undefined
  getAntiAnchoringConfig: () => AntiAnchoringConfigInput
  streamClient: StreamClient
  getAbortSignal: () => AbortSignal | undefined
}

/**
 * HEARTH anti-anchoring side-channel extracted verbatim from AgentLoop (W-L6a):
 * the anchor-graph builder and the independent-path seed-model call. Both are
 * experimental MCTS-planning inputs with no prefix-cache coupling.
 */
export class AntiAnchoringController {
  constructor(private readonly deps: AntiAnchoringDeps) {}

  /**
   * Build the HEARTH anchor graph from current runtime state.
   *
   * - pole_structure = hash of system + tools fingerprint
   * - pole_void = XOR complement of pole_structure
   * - cycle_close = last session's cycle_close (or empty if first)
   * - cycle_open = current session's sessionId (deterministic seed)
   * - center_belief = hash of system prompt alone (founding covenant)
   */
  buildAnchorGraph(): ReturnType<typeof createAnchorGraph> {
    const fp = this.deps.getFingerprint()
    const structureHash = createHash('sha256')
      .update(`${fp.systemSha256}:${fp.toolsSha256}`)
      .digest('hex')
    const voidShape = hexComplement(structureHash)

    const prevCycleClose =
      this.deps.getLastCycleClose() ?? ''

    const currentCycleOpen = createHash('sha256')
      .update(`cycle-open:${this.deps.getSessionId() ?? 'unknown'}`)
      .digest('hex')

    const centerBeliefHash = fp.systemSha256

    return createAnchorGraph({
      structureHash,
      voidShape,
      prevCycleClose,
      currentCycleOpen,
      centerBeliefHash,
    })
  }

  async callSeedModel(prompt: string, hookSignal?: AbortSignal): Promise<string> {
    const sessionSignal = this.deps.getAbortSignal()
    const signal = hookSignal && sessionSignal ? AbortSignal.any([hookSignal, sessionSignal]) : hookSignal ?? sessionSignal
    signal?.throwIfAborted()
    const antiAnchoring = normalizeAntiAnchoringConfig(this.deps.getAntiAnchoringConfig())
    const request: OaiChatRequest = {
      model: this.deps.getModel(),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: antiAnchoring.seedMaxTokens,
      stream: true,
      temperature: 0.9,
      tool_choice: 'none',
    }
    let text = ''
    await this.deps.streamClient.stream(request, {
      onTextDelta: delta => { text += delta },
      onThinkingDelta: () => {},
      onContentBlock: block => {
        if (block.type === 'text') text += block.text
      },
      onStopReason: () => {},
      onError: error => { throw error },
    }, signal)
    signal?.throwIfAborted()
    return text.trim()
  }
}

/**
 * Compute the bitwise XOR complement of a hex string.
 * Each hex digit is XOR'd with 0xf, producing its complement.
 * Used by HEARTH to compute pole_void from pole_structure.
 */
function hexComplement(hex: string): string {
  let result = ''
  for (let i = 0; i < hex.length; i++) {
    result += (0xf ^ parseInt(hex[i]!, 16)).toString(16)
  }
  return result
}
