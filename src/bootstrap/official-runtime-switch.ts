import { switchAgentRuntime, type BootstrapContext } from '../bootstrap.js'
import { OfficialError } from '../models/official-contract.js'
import { isOfficialProvider, prepareRuntimeContext, resolveProviderForModel } from '../models/model-runtime.js'

const preparedSwitchIntents = new WeakMap<BootstrapContext, symbol>()

export async function switchPreparedAgentRuntime(ctx: BootstrapContext, modelId: string, provider?: string): Promise<ReturnType<typeof switchAgentRuntime>> {
  const intent = Symbol()
  preparedSwitchIntents.set(ctx, intent)
  const selected = resolveProviderForModel(ctx, modelId, provider)
  if (!selected || 'error' in selected || !isOfficialProvider(selected.provider)) return switchAgentRuntime(ctx, modelId, provider)
  const reference = provider ? `${provider}:${modelId}` : modelId
  try {
    const prepared = await prepareRuntimeContext(ctx, reference)
    if (preparedSwitchIntents.get(ctx) !== intent) return { ok: false, error: 'model_selection_changed' }
    ctx.config = prepared.config
    return switchAgentRuntime(ctx, modelId, provider)
  } catch (error) { return { ok: false, error: error instanceof OfficialError ? error.code : 'service_error' } }
}
