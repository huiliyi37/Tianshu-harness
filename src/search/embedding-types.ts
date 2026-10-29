import type { ModelRequestAuthorizer } from '../api/request-authorization.js'
import type { ResolveModelInput, ModelRuntimeDeps } from '../models/model-runtime.js'

export interface EmbeddingProvider {
  /** Stable id for cache invalidation when the model changes. */
  readonly id: string
  /** True when embeddings can actually be produced (key/endpoint present). */
  isAvailable(): boolean
  checkAccess?(): Promise<void>
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>
}


export interface RemoteEmbeddingOptions {
  requestAuth?: ModelRequestAuthorizer
  prepareRequestAuth?: () => Promise<ModelRequestAuthorizer>
  checkAccess?: () => Promise<void>
  baseUrl: string
  apiKey: string
  model: string
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Max texts per request. */
  batchSize?: number
}


export interface EmbeddingConfig {
  managed?: { input: ResolveModelInput; deps?: ModelRuntimeDeps }
  baseUrl?: string
  apiKey?: string
  model?: string
  fetchImpl?: typeof fetch
}
