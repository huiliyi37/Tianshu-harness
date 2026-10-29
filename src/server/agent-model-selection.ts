import { createManagedAccountAuth, isOfficialProvider, prepareRuntimeContext } from '../models/model-runtime.js'
import type { AuthProvider } from '../auth/types.js'
import { type ServeContext, type ResolvedModelSpec, resolveServeContext, resolveManagedTargetSelection } from './serve.js'

function specOfContext(ctx: ServeContext): ResolvedModelSpec {
  return {
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    model: { id: ctx.model.id, maxTokens: ctx.model.maxTokens, contextWindow: ctx.model.contextWindow, reasoningEffort: ctx.model.reasoningEffort, capabilities: ctx.model.capabilities },
  }
}

export function resolveInitialSpec(ctx: ServeContext, reload?: () => ServeContext): ResolvedModelSpec {
  if (isOfficialProvider(ctx.provider)) return specOfContext(ctx)
  if (reload) {
    try {
      const fresh = reload()
      if (fresh.configured) return specOfContext(fresh)
    } catch {  }
  }
  if (ctx.configured) return specOfContext(ctx)
  return specOfContext(resolveServeContext())
}

export async function prepareManagedTarget(
  ctx: ServeContext, modelId: string | undefined, reload: (() => ServeContext) | undefined,
  ownedOfficialAuth: AuthProvider | undefined, fallbackToDefault: boolean, signal?: AbortSignal,
  initialSelection?: NonNullable<ReturnType<typeof resolveManagedTargetSelection>>,
): Promise<{ context: ServeContext; spec: ResolvedModelSpec; ownedOfficialAuth?: AuthProvider } | null> {
  signal?.throwIfAborted()
  const target = initialSelection ?? resolveManagedTargetSelection(ctx, modelId, reload, fallbackToDefault)
  if (!target) return null
  const { context: selected, spec } = target
  const providerName = spec.providerName ?? spec.provider.name
  const config = { ...selected.config, provider: { ...selected.config.provider, providers: { ...selected.config.provider.providers, [providerName]: spec.provider } } }
  if (!isOfficialProvider(spec.provider)) return { context: { ...selected, config }, spec, ownedOfficialAuth }
  const auth = ownedOfficialAuth ?? spec.auth ?? createManagedAccountAuth()
  const prepared = await prepareRuntimeContext({ ...selected, config, auth, signal }, `${providerName}:${spec.model.id}`, 'agent', undefined, { reusePrepared: !!initialSelection && !!ownedOfficialAuth, signal })
  return { context: prepared, spec: { provider: prepared.provider, model: prepared.model, apiKey: prepared.apiKey, auth: prepared.auth }, ownedOfficialAuth: ownedOfficialAuth ?? prepared.auth }
}

