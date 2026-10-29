import { catalogSchema, exactOrigin, OfficialError, purposeSchema, type Catalog, type Purpose, type Binding } from './official-contract.js'
import { projectCustomerOperation } from './official-customer-view.js'
import { providerSchema, type Config } from '../config/schema.js'

export const OFFICIAL_PROVIDER_ID = 'tianshu-official'

export function projectOfficialCatalogConfig(config: Config, catalog: Catalog): Config {
  const providers = config.provider.providers
  let providerId = OFFICIAL_PROVIDER_ID
  let suffix = 2
  while (providers[providerId] && providers[providerId]!.auth?.type !== 'tianshu-account') providerId = `${OFFICIAL_PROVIDER_ID}-${suffix++}`
  const existing = providers[providerId]
  const models = catalogForPurpose(catalog, 'agent').models.flatMap(model => {
    const bindings = model.bindings.filter(binding => binding.stream)
    if (bindings.length !== 1) return []
    const local = existing?.models.find(candidate => candidate.id === model.id)
    return [{ ...local, id: model.id, description: model.displayName, contextWindow: Math.min(local?.contextWindow ?? Infinity, model.contextWindow!),
      maxTokens: Math.min(local?.maxTokens ?? Infinity, model.maxOutputTokens!), managed: { bindingId: bindings[0]!.id }, pricing: undefined,
      supportsVision: local?.supportsVision !== false && model.capabilities?.vision === true }]
  })
  const provider = providerSchema.parse({ ...existing, name: providerId, auth: { type: 'tianshu-account' }, baseUrl: undefined,
    apiKey: undefined, apiKeyEnv: undefined, keyRef: undefined, keys: undefined, models })
  return { ...config, provider: { ...config.provider, providers: { ...providers, [providerId]: provider } } }
}

function validPath(binding: Binding): boolean {
  const paths: Record<string, [string, string]> = { chat: ['openai', '/v1/chat/completions'], responses: ['openai-responses', '/v1/responses'], messages: ['anthropic', '/v1/messages'], 'image-generation': ['openai', '/v1/images/generations'], embedding: ['openai', '/v1/embeddings'] }
  if (binding.operation === 'generate-content') return binding.protocol === 'gemini' && /^[A-Za-z0-9._-]+$/.test(binding.modelId) && binding.path === `/v1beta/models/${binding.modelId}:${binding.stream ? 'streamGenerateContent' : 'generateContent'}`
  return paths[binding.operation]?.[0] === binding.protocol && paths[binding.operation]?.[1] === binding.path
}
export function parseOfficialCatalog(value: unknown, origins: readonly string[]): Catalog {
  const catalog = catalogSchema.parse(projectCustomerOperation('catalog.list',value,{catalogOrigins:origins})), models = new Set<string>(), bindings = new Set<string>()
  for (const model of catalog.models) {
    if (models.has(model.id)) throw new OfficialError('catalog_unavailable')
    models.add(model.id)
    for (const binding of model.bindings) {
      if (bindings.has(binding.id) || binding.modelId !== model.id || !origins.includes(exactOrigin(binding.origin)) || !validPath(binding)
        || model.costStatus === 'available' && !model.prices?.some(price => price.pricingRevision === binding.pricingRevision)) throw new OfficialError('catalog_unavailable')
      bindings.add(binding.id)
      const headers = new Set<string>()
      for (const [name, value] of Object.entries(binding.requiredHeaders ?? {})) {
        const key = name.toLowerCase()
        if (headers.has(key) || !['anthropic-version', 'content-type', 'accept'].includes(key) || /[\r\n]/.test(value)) throw new OfficialError('catalog_unavailable')
        headers.add(key)
      }
    }
  }
  return catalog
}
export function catalogForPurpose(catalog: Catalog, purpose: Purpose): Catalog {
  purposeSchema.parse(purpose)
  return { revision: catalog.revision, models: catalog.models.flatMap(model => {
    if (model.status !== 'available') return []
    const bindings = model.bindings.filter(binding => {
      if (purpose === 'image-generation' || purpose === 'embedding') return binding.operation === purpose
      if (!['chat', 'responses', 'messages', 'generate-content'].includes(binding.operation)) return false
      if (purpose === 'agent') return !!model.contextWindow && !!model.maxOutputTokens && model.capabilities?.tools === true && binding.capabilities?.tools === true
      if (purpose === 'vision') return binding.capabilities?.vision === true
      return true
    })
    return bindings.length ? [{ ...model, bindings, ...(model.prices ? { prices: model.prices.filter(price => bindings.some(binding => binding.pricingRevision === price.pricingRevision)) } : {}) }] : []
  }) }
}
