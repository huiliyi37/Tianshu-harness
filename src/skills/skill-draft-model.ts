import { createPurposeClient, isOfficialProvider } from '../models/model-runtime.js'
import { loadConfig } from '../config/manager.js'
import { contractModels } from '../config/contract-models.js'
import { findModelOwner, findModelInKey, resolveModelRef } from '../config/provider-keys.js'
import { createProviderClient, resolveApiKey } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { createAuthProvider } from '../auth/registry.js'

/** A standalone, tool-free model request; never borrows or resets an active agent. */
export async function completeSkillDraft(system: string, user: string): Promise<string> {
  const config = loadConfig()
  const ref = config.agent.defaultModel
  const parsed = ref ? resolveModelRef(config.provider.providers, ref) : undefined
  const provider = config.provider.providers[parsed?.provider ?? config.provider.default]
  if (!provider) throw new Error('Configure a model provider before generating a skill draft')
  const selected = parsed?.modelRef ? parsed.keyId ? findModelInKey(provider, parsed.keyId, parsed.modelRef) : findModelOwner(provider, parsed.modelRef) : undefined
  const model = selected?.model ?? (!parsed?.modelRef ? contractModels(provider)[0] : undefined)
  if (!model) throw new Error('Configured model is unavailable')
  const owner = selected ?? findModelOwner(provider, model.id)
  const effective = owner?.owner ? { ...provider, ...owner.owner } : provider
  const apiKey = effective.auth?.type === 'oauth' ? '' : resolveApiKey(effective)
  const auth = isOfficialProvider(effective) ? undefined : createAuthProvider(effective.auth ?? undefined, process.env, apiKey, { ...config.network, proxy: effective.proxy ?? config.network.proxy })
  const client = isOfficialProvider(effective) ? createPurposeClient(config.provider.providers, effective, model.id, 'skill', { maxTokens: 8192, network: config.network }) : createProviderClient(effective, resolveCapabilities(provider.name, provider.capabilities, model.capabilities), {
    apiKey, model: model.id, maxTokens: 8192, auth, network: config.network,
  })
  let output = '', failure: Error | undefined
  await client.stream({ model: model.id, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 8192 }, {
    onTextDelta: delta => { output += delta }, onThinkingDelta: () => {}, onContentBlock: () => {},
    onStopReason: reason => { if (reason === 'length' || reason === 'max_tokens') failure = new Error('Draft was truncated; choose fewer materials') },
    onError: error => { failure = error },
  }, AbortSignal.timeout(120000))
  if (failure) throw failure
  return output
}
