import { createPurposeClient, isOfficialProvider, type ModelSubmission } from '../models/model-runtime.js'
import { OfficialError } from '../models/official-contract.js'
import type { SessionRecord, SessionEvent } from './protocol.js'
import type { ProviderConfig } from '../config/schema.js'
import { resolveModelRef, findModelOwner, findModelInKey } from '../config/provider-keys.js'
import { createProviderClient, resolveApiKey, resolveCredentialKey } from '../api/factory.js'
import { createAuthProvider } from '../auth/registry.js'
import { resolveCapabilities } from '../api/provider.js'
import { completionFromClient } from '../agent/goal-criteria.js'
import { extractSessionTitle, type CompletionFn } from '../agent/title-extract.js'
import { stripTerminalEscapes } from '../utils/safe-path.js'

export interface TitleModels {
  submission?: ModelSubmission
  providers: Record<string, ProviderConfig>
  current?: string
  cheap?: { provider: string; model: string }
}

/** Title clients use the same auth/key ownership as the main model, with their own lifecycle. */
export function buildTitleCompletion(ref: string, providers: TitleModels['providers'], id: string, deps: {
  submission?: ModelSubmission
  standalone?: boolean
  createAuth?: typeof createAuthProvider
  createClient?: typeof createProviderClient
} = {}): CompletionFn | null {
  const parsed = resolveModelRef(providers, ref)
  for (const [name, provider] of Object.entries(providers)) {
    if (parsed.provider && parsed.provider !== name) continue
    const found = parsed.keyId
      ? findModelInKey(provider, parsed.keyId, parsed.modelRef)
      : findModelOwner(provider, parsed.modelRef)
    if (!found) continue
    if (isOfficialProvider(provider)) return completionFromClient(createPurposeClient(providers, provider, found.model.id, 'title', { maxTokens: 256, reasoningEffort: 'off', sessionId: id }, deps.submission, deps.standalone), found.model.id, 256)
    try {
      const auth = provider.auth?.type === 'oauth'
        ? (deps.createAuth ?? createAuthProvider)(provider.auth, process.env, provider.apiKey) : undefined
      if (auth && !auth.isAuthenticated()) continue
      const key = found.owner
      const apiKey = auth ? '' : key && (key.keyRef || key.apiKey || key.apiKeyEnv)
        ? resolveCredentialKey({ name, keyRef: key.keyRef, apiKey: key.apiKey, apiKeyEnv: key.apiKeyEnv })
        : resolveApiKey(provider)
      const client = (deps.createClient ?? createProviderClient)({ ...provider, thinking: 'disabled' }, resolveCapabilities(name, provider.capabilities), {
        apiKey, auth, model: found.model.id, maxTokens: 256, reasoningEffort: 'off', sessionId: id,
      })
      return completionFromClient(client, found.model.id, 256)
    } catch { /* unavailable candidate; continue to the selected model */ }
  }
  return null
}

export function titleInput(text: string | undefined, attachments: string[] = []): string {
  return stripTerminalEscapes(text ?? '').trim().slice(0, 800)
    || attachments.join('、').slice(0, 800)
}

export function fallbackTitle(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 40)
}

export async function loadTitleInput(record: SessionRecord, events: SessionEvent[], persistence?: {
  loadEventsAsync?: (id: string) => Promise<SessionEvent[]>
  loadEvents?: (id: string) => SessionEvent[]
}): Promise<string> {
  if (record.titleInput) return record.titleInput
  // A long session's ring may no longer contain the opener. Only read the selected log.
  const history = persistence?.loadEventsAsync ? await persistence.loadEventsAsync(record.id)
    : persistence?.loadEvents ? persistence.loadEvents(record.id) : events
  const first = history.find(e => e.type === 'user')?.data
  return titleInput(typeof first?.promptText === 'string' ? first.promptText
    : typeof first?.text === 'string' ? first.text : '',
    [first?.documents, first?.archives].flatMap(items => Array.isArray(items) ? items.map(d => String((d as { name?: string }).name ?? '')) : [])
      .concat(Array.isArray(first?.images) && first.images.length ? ['Image'] : []),
  )
}

export function canGenerateTitle(record: SessionRecord): boolean {
  // Unknown provenance is an existing user title, never an auto-replacement candidate.
  return !record.archived && (!record.title?.trim() || record.titleSource === 'fallback')
}

export class SessionTitleCoordinator {
  private readonly inflight = new Map<string, Promise<void>>()
  constructor(private readonly deps: {
    get: (id: string) => SessionRecord | undefined
    save: (record: SessionRecord) => void
    models: (id: string) => TitleModels | undefined
    generated?: (id: string, title: string) => void
    complete?: typeof buildTitleCompletion
    timeoutMs?: number
  }) {}

  generate(id: string, input: string, explicit = false): Promise<void> {
    const running = this.inflight.get(id)
    if (running) return running
    const record = this.deps.get(id)
    if (!record || !canGenerateTitle(record) || !input || (!explicit && (record.titleGenerationAttempts ?? 0) >= 2)) {
      return Promise.resolve()
    }
    record.titleInput = input.slice(0, 800)
    record.title = fallbackTitle(input)
    record.titleSource = 'fallback'
    record.titleGenerationState = 'pending'
    record.titleGenerationAttempts = (record.titleGenerationAttempts ?? 0) + 1
    this.deps.save(record)
    const expectedTitle = record.title
    const work = this.run(id, record, expectedTitle, input, explicit).finally(() => this.inflight.delete(id))
    this.inflight.set(id, work)
    return work
  }

  private async run(id: string, original: SessionRecord, expectedTitle: string, input: string, explicit: boolean): Promise<void> {
    let models: TitleModels | undefined
    try { models = this.deps.models(id) } catch { /* unavailable configuration */ }
    const submission = explicit ? models?.submission : models?.submission?.capture()
    const refs = [...new Set([
      ...(models?.cheap ? [`${models.cheap.provider}:${models.cheap.model}`] : []),
      ...(models?.current ? [models.current] : []),
    ])]
    let title: string | null = null
    for (const ref of refs) {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        let officialFailure: OfficialError | undefined
        const complete = (this.deps.complete ?? buildTitleCompletion)(ref, models!.providers, id, { submission, standalone: explicit })
        if (!complete) continue
        const timeout = new Promise<null>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve(null) }, this.deps.timeoutMs ?? 10_000)
        })
        title = await Promise.race([extractSessionTitle(input, async (...args) => { try { return await complete(...args) } catch (error) { if (error instanceof OfficialError) officialFailure = error; throw error } }, controller.signal), timeout])
        if (title || officialFailure) break
      } catch (error) { if (error instanceof OfficialError) break }
      finally { if (timer) clearTimeout(timer) }
    }
    const current = this.deps.get(id)
    if (current !== original || !canGenerateTitle(current) || current.title !== expectedTitle) return
    current.titleGenerationState = title ? 'complete' : 'failed'
    if (title) { current.title = title; current.titleSource = 'generated' }
    this.deps.save(current)
    if (title) this.deps.generated?.(id, title)
  }
}
