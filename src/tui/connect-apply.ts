import { setupProvider, registerProvider, upsertProviderModel } from '../config/manager.js'
import { contractModels } from '../config/contract-models.js'
import type { Config } from '../config/schema.js'
import type { ConnectCommit } from './connect-flow.js'

/** Reconnect edits the default key; explicit register --force remains a full reset. */
export function persistConnectCommit(commit: ConnectCommit): void {
  if (commit.mode === 'preset') {
    setupProvider(commit.setup)
  } else if (commit.mode === 'add-model') {
    upsertProviderModel(commit.providerName, commit.model)
  } else {
    const options = {
      providerName: commit.providerName, baseUrl: commit.baseUrl,
      ...(commit.apiKey ? { apiKey: commit.apiKey } : {}),
      protocol: commit.protocol, models: commit.models, makeDefault: commit.makeDefault,
      ...(commit.advanced ? { advanced: commit.advanced } : {}),
    }
    if (commit.updateExisting) setupProvider(options)
    else registerProvider(options)
  }
}

/** An optional connection must not reset an unrelated active provider. */
export function resolveConnectRuntimeSelection(
  commit: ConnectCommit,
  config: Config,
  active?: { provider: string; model: string },
): { provider: string; model: string } | undefined {
  const provider = commit.mode === 'preset' ? commit.setup.providerName : commit.providerName
  const makeDefault = commit.mode === 'preset' ? commit.setup.makeDefault : commit.mode === 'custom' && commit.makeDefault
  if (active && !makeDefault && active.provider !== provider) return undefined
  const entry = config.provider.providers[provider]
  if (!entry) return undefined
  const models = contractModels(entry)
  const selected = commit.mode === 'add-model'
    ? models.find(m => m.id === commit.model.id)
    : !makeDefault && active?.provider === provider ? models.find(m => m.id === active.model) ?? models[0] : models[0]
  return selected ? { provider, model: selected.id } : undefined
}
