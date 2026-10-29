/**
 * Pluggable embedding provider for true semantic (vector) code search.
 *
 * The default backend calls an OpenAI-compatible `/embeddings` endpoint using
 * the configured provider's base URL + key (DeepSeek/OpenAI/etc). When no key
 * or endpoint is available — or the call fails — the provider reports itself
 * unavailable and search degrades to BM25. So embeddings are a strict upgrade:
 * they never make the offline path worse.
 *
 * Custom/local providers (transformers.js, fastembed, a local server) can be
 * dropped in by implementing EmbeddingProvider and passing it where the index
 * is constructed.
 */

import { isRuntimeLeanAspect } from '../config/runtime-lean.js'
import { authorizeModelRequest, captureModelAuthorization, checkModelAuthorization, checkOfficialResponse, officialStreamFailure } from '../api/request-authorization.js'
import { createManagedAccountAuth, prepareModelRuntime, resolveModelRuntime, resolveProviderForModel, isOfficialProvider } from '../models/model-runtime.js'
import { OfficialError } from '../models/official-contract.js'
import type { EmbeddingProvider, RemoteEmbeddingOptions, EmbeddingConfig } from './embedding-types.js'
export type { EmbeddingProvider, RemoteEmbeddingOptions, EmbeddingConfig } from './embedding-types.js'


/** Per-request timeout for the embeddings endpoint. A hung provider would
 *  otherwise stall indexing indefinitely; embeddings are a strict upgrade, so
 *  timing out degrades to BM25 rather than blocking. Override with
 *  RIVET_EMBEDDING_TIMEOUT (ms). */
function embeddingTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_EMBEDDING_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 30_000
}


/** OpenAI-compatible `/embeddings` provider. */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  private baseUrl: string
  private apiKey: string
  private model: string
  private fetchImpl: typeof fetch
  private batchSize: number
  private readonly options: RemoteEmbeddingOptions

  constructor(opts: RemoteEmbeddingOptions) {
    this.options = { ...opts }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.batchSize = Math.max(1, opts.batchSize ?? 64)
    this.id = `remote:${this.model}`
  }

  isAvailable(): boolean {
    return Boolean(this.model && (this.options.requestAuth || this.options.prepareRequestAuth || this.baseUrl && this.apiKey))
  }

  async checkAccess(): Promise<void> {
    if (this.options.checkAccess) await this.options.checkAccess()
    else if (this.options.requestAuth) await checkModelAuthorization(this.options.requestAuth)
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const requestAuth = captureModelAuthorization(this.options.prepareRequestAuth ? await this.options.prepareRequestAuth() : this.options.requestAuth, this.model)
    try {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const wire = await authorizeModelRequest(requestAuth, 'embedding', `${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: AbortSignal.timeout(embeddingTimeoutMs()),
      })
      const res = await this.fetchImpl(wire.url, wire.init).catch(error => { throw officialStreamFailure(requestAuth, error) })
      await checkOfficialResponse(requestAuth, res)
      if (!res.ok) {
        throw new Error(`embeddings request failed: ${res.status}`)
      }
      const json = await res.json() as { data?: Array<{ embedding: number[]; index?: number }> }
      const data = json.data ?? []
      if (requestAuth && (!Array.isArray(data) || data.length !== batch.length || data.some(item => !Array.isArray(item?.embedding) || !item.embedding.length || item.embedding.some(value => !Number.isFinite(value))))) throw new Error('Invalid embedding response')
      // Preserve input order (API returns an `index` field).
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (requestAuth && ordered.some((item, index) => item.index !== index)) throw new Error('Invalid embedding response')
      for (const d of ordered) out.push(d.embedding)
    }
    return out
    } catch (error) { throw officialStreamFailure(requestAuth, error) }
  }
}

/** A provider that never produces vectors — forces BM25-only search. */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'null'
  isAvailable(): boolean { return false }
  async embed(): Promise<number[][]> { return [] }
}


/**
 * Build the default embedding provider from explicit config, falling back to
 * env vars, then to a null (offline) provider. Resolution order:
 *   1. explicit opts
 *   2. RIVET_EMBEDDING_{BASE_URL,API_KEY,MODEL}
 *   3. common provider keys (OPENAI_API_KEY / DEEPSEEK_API_KEY) with sane defaults
 */
export function createEmbeddingProvider(opts: EmbeddingConfig = {}): EmbeddingProvider {
  const env = process.env
  if (env.RIVET_NO_EMBEDDINGS === '1' || isRuntimeLeanAspect('embeddings')) return new NullEmbeddingProvider()

  if (opts.managed) {
    const { deps } = opts.managed
    const input = { ...opts.managed.input }
    const auth = input.auth ?? input.prepared?.auth ?? createManagedAccountAuth(deps)
    const selected = resolveProviderForModel(input, input.modelId, input.targetProvider)
    if (!selected || 'error' in selected || !isOfficialProvider(selected.provider)) throw new OfficialError('model_unavailable', 409, false)
    return new RemoteEmbeddingProvider({ baseUrl: selected.provider.baseUrl, apiKey: '', model: selected.modelId, fetchImpl: opts.fetchImpl,
      checkAccess: async () => { await prepareModelRuntime({ ...input, auth, purpose: 'embedding' }, deps) },
      prepareRequestAuth: async () => {
        const runtime = await resolveModelRuntime({ ...input, auth, purpose: 'embedding' }, deps)
        if (!runtime.requestAuth) throw new OfficialError('auth_required', 401, false)
        return runtime.requestAuth
      },
    })
  }

  const baseUrl = opts.baseUrl
    ?? env.RIVET_EMBEDDING_BASE_URL
    ?? (env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : undefined)
    ?? (env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com/v1' : undefined)

  const apiKey = opts.apiKey
    ?? env.RIVET_EMBEDDING_API_KEY
    ?? env.OPENAI_API_KEY
    ?? env.DEEPSEEK_API_KEY

  const model = opts.model
    ?? env.RIVET_EMBEDDING_MODEL
    ?? 'text-embedding-3-small'

  if (!baseUrl || !apiKey || !model) return new NullEmbeddingProvider()
  return new RemoteEmbeddingProvider({ baseUrl, apiKey, model, fetchImpl: opts.fetchImpl })
}
