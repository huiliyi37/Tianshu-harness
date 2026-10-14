/**
 * FallbackStreamClient — wraps a primary StreamClient and tries fallback
 * providers when the primary exhausts all retries. Each fallback provider
 * is lazy-initialized on first use to avoid wasted allocations.
 */

import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import { type ErrorCategory, classifyApiError } from './error-classifier.js'

export interface FallbackEntry {
  name: string
  create: () => StreamClient
}

export class FallbackStreamClient implements StreamClient {
  private activeClient: StreamClient
  private activeName: string
  private readonly fallbacks: FallbackEntry[]
  private readonly onFallback?: (from: string, to: string, error: unknown) => void

  constructor(
    primary: StreamClient,
    primaryName: string,
    fallbacks: FallbackEntry[],
    onFallback?: (from: string, to: string, error: unknown) => void,
  ) {
    this.activeClient = primary
    this.activeName = primaryName
    this.fallbacks = fallbacks
    this.onFallback = onFallback
  }

  setReasoningEffort(effort: string): void {
    this.activeClient.setReasoningEffort?.(effort)
  }

  setThinking(mode: 'enabled' | 'disabled'): void {
    this.activeClient.setThinking?.(mode)
  }

  consumeWireDivergence(): import('./stream-client.js').WireDivergence | null {
    return this.activeClient.consumeWireDivergence?.() ?? null
  }
  previewContextRequest(request: OaiChatRequest): OaiChatRequest { return this.activeClient.previewContextRequest?.(request) ?? request }
  getExecutionPolicy() { return this.activeClient.getExecutionPolicy?.() ?? { singleAttempt: false } }
  setRuntimeSessionId(id: string): void { this.activeClient.setRuntimeSessionId?.(id) }
  getMainPrefixProof() { return this.activeClient.getMainPrefixProof?.() }
  authorizeCacheGeneration(reason: string): void { this.activeClient.authorizeCacheGeneration?.(reason) }
  restoreExecutionSnapshot(snapshot: import('./continuation-prefix.js').ContinuationPrefixProof): void { this.activeClient.restoreExecutionSnapshot?.(snapshot) }
  restoreRewindAuthorization(authorization: import('./continuation-prefix.js').RewindGenerationAuthorization): void { this.activeClient.restoreRewindAuthorization?.(authorization) }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: unknown
    const tried = [this.activeName]

    try {
      await this.activeClient.stream(request, callbacks, signal)
      return
    } catch (err) {
      lastError = err
      if (signal?.aborted) throw err
      if (this.activeClient.getMainPrefixProof?.() || this.activeClient.getExecutionPolicy?.().singleAttempt) throw err

      const classified = classifyApiError(err)
      if (!this.shouldFallback(classified.category)) throw err
    }

    for (const entry of this.fallbacks) {
      if (signal?.aborted) break
      tried.push(entry.name)

      try {
        const fallbackClient = entry.create()
        this.onFallback?.(this.activeName, entry.name, lastError)
        this.activeClient = fallbackClient
        this.activeName = entry.name
        await fallbackClient.stream(request, callbacks, signal)
        return
      } catch (err) {
        lastError = err
        if (signal?.aborted) throw err

        const classified = classifyApiError(err)
        if (!this.shouldFallback(classified.category)) throw err
      }
    }

    throw lastError
  }

  private shouldFallback(category: ErrorCategory): boolean {
    const fallbackCategories = new Set([
      'rate_limit', 'server_error', 'overloaded',
      'timeout', 'stream_parse',
      // 上游网关返回畸形响应（WAF/边缘节点故障）：换一个 provider 通常立刻就好，
      // 属于「本 provider 此刻不可用」而不是「请求本身有问题」。
      'malformed_response',
    ])
    return fallbackCategories.has(category)
  }
}
