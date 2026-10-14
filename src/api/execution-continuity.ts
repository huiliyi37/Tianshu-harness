import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { proveWirePrefix, isCompleteExecutionSnapshot, isRewindGenerationAuthorization, ContinuationPrefixError, LocalWorkerPolicyError, type ContinuationPrefixProof, type RewindGenerationAuthorization } from './continuation-prefix.js'
import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import type { Usage } from './types.js'
import { normalizeBaseUrl } from './endpoint-map.js'

export interface ExecutionScope {
  singleAttempt: boolean
  sends: number
  sessionId?: string
  model?: string
  requestId?: string
  attemptId?: string
  usageFields?: Record<string, string>
  commits?: Promise<void>[]
  rejectedSend?: { url: string; body: Record<string, unknown>; owner?: string; requestId?: string; attemptId?: string }
  beforeSend?: (url: string, body: Record<string, unknown>, owner?: string) => void
}
const scopes = new AsyncLocalStorage<ExecutionScope>()
export function currentExecutionScope(): ExecutionScope | undefined { return scopes.getStore() }

/** The transport boundary, after provider transforms and before any HTTP send. */
export function checkExecutionSend(url: string, body: Record<string, unknown>, owner?: string): void {
  const scope = scopes.getStore()
  if (!scope) return
  if (scope.singleAttempt && scope.sends > 0) {
    scope.rejectedSend = { url, body, owner, requestId: scope.requestId, attemptId: scope.attemptId }
    throw new LocalWorkerPolicyError('Worker request already sent; automatic retry is disabled')
  }
  scope.beforeSend?.(url, body, owner)
  scope.sends++
}

export async function prepareExecutionSend(url: string, body: Record<string, unknown>, owner?: string): Promise<void> {
  checkExecutionSend(url, body, owner)
  await Promise.all(currentExecutionScope()?.commits ?? [])
}

/** Principal identity only. Access tokens and JWT contents are never stored. */
export function credentialPrincipal(headers: RequestInit['headers']): string | undefined {
  const h = new Headers(headers)
  let owner = h.get('chatgpt-account-id') ?? h.get('x-account-id')
  if (!owner) {
    try {
      const jwt = h.get('authorization')?.replace(/^Bearer /i, '').split('.')
      const claims = jwt?.length === 3 ? JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString('utf8')) : undefined
      owner = typeof claims?.sub === 'string' ? claims.sub : undefined
    } catch { /* opaque credentials use a non-reversible fingerprint below */ }
  }
  if (owner) return createHash('sha256').update(owner).digest('hex')
  const opaque = h.get('x-api-key') ?? h.get('x-goog-api-key') ?? h.get('authorization')?.replace(/^Bearer /i, '').trim()
  return opaque ? createHash('sha256').update(`opaque:${opaque}`).digest('hex') : undefined
}

function normalizedBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages ?? body.input ?? body.contents ?? []
  return {
    ...body,
    messages: [
      ...(body.system ? [{ role: 'system', content: body.system }] : []),
      ...(body.instructions ? [{ role: 'system', content: body.instructions }] : []),
      ...(body.systemInstruction ? [{ role: 'system', content: body.systemInstruction }] : []),
      ...(Array.isArray(messages) ? messages : [{ role: 'input', content: messages }]),
    ],
    thinking: body.thinking ?? body.reasoning ?? (body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens,
  }
}

export interface ContinuityClientOptions {
  provider: string
  model: string
  credentialScope?: string
  expectedPrincipal?: string
  singleAttempt?: boolean
  prior?: ContinuationPrefixProof
  sessionId?: string
}
const policies = new WeakMap<StreamClient, ContinuityClientOptions>()

/** Proxy forwards the entire optional client surface; side paths never replace the main baseline. */
export function withExecutionContinuity(client: StreamClient, options: ContinuityClientOptions): StreamClient {
  const existing = policies.get(client)
  if (existing) {
    if (options.singleAttempt) existing.singleAttempt = true
    return client
  }
  let proof = options.prior
  let generation = proof?.cacheGenerationId ?? randomUUID()
  let generationReason = proof?.generationReason ?? 'initial'
  let terminal: Error | undefined
  let unlocked = !proof
  let sessionId = options.sessionId
  let rewindBaseline: ContinuationPrefixProof | undefined
  let pendingRewind: RewindGenerationAuthorization | undefined
  const restoreOptions = (prior: ContinuationPrefixProof) => {
    client.restoreExecutionOptions?.(prior.options!)
    const savedThinking = prior.options?.thinking as Record<string, unknown> | undefined
    const savedOutput = prior.options?.output_config as Record<string, unknown> | undefined
    const effort = prior.options?.reasoning_effort ?? savedOutput?.effort ?? savedThinking?.effort
    if (typeof effort === 'string') client.setReasoningEffort?.(effort)
    if (savedThinking?.type === 'enabled' || savedThinking?.type === 'disabled') client.setThinking?.(savedThinking.type)
    else if (savedThinking?.type === 'adaptive' || (!savedThinking && typeof effort === 'string')) client.setThinking?.('enabled')
  }
  if (proof && (!proof.options || proof.version !== 2)) {
    terminal = new LocalWorkerPolicyError('Legacy execution snapshot is incomplete; explicitly start a new cache generation')
  }
  const authorize = (reason: string) => {
    if (options.singleAttempt && terminal) throw terminal
    terminal = undefined
    proof = undefined
    rewindBaseline = undefined
    pendingRewind = undefined
    unlocked = true
    generation = randomUUID()
    generationReason = reason
    client.authorizeCacheGeneration?.(reason)
  }
  const wrapped = new Proxy(client, {
    get(target, prop) {
      if (prop === 'getMainPrefixProof') return () => proof
      if (prop === 'getExecutionPolicy') return () => ({ singleAttempt: options.singleAttempt === true })
      if (prop === 'setRuntimeSessionId') return (id: string) => { sessionId = id }
      if (prop === 'authorizeCacheGeneration') return authorize
      if (prop === 'restoreRewindAuthorization') return (authorization: RewindGenerationAuthorization) => {
        if (!isRewindGenerationAuthorization(authorization) || authorization.model !== options.model || options.singleAttempt) {
          throw new LocalWorkerPolicyError('回退授权的模型或执行策略不匹配；禁止恢复')
        }
        authorize(authorization.reason)
        generation = authorization.cacheGenerationId
        pendingRewind = authorization
        if (authorization.prior.model === options.model) {
          rewindBaseline = authorization.prior
          restoreOptions(authorization.prior)
          unlocked = false
        }
      }
      if (prop === 'restoreExecutionSnapshot') return (prior: ContinuationPrefixProof) => {
        if (!isCompleteExecutionSnapshot(prior)) throw new LocalWorkerPolicyError('Execution snapshot missing normalized options')
        restoreOptions(prior)
        rewindBaseline = undefined
        pendingRewind = undefined
        proof = prior; generation = prior.cacheGenerationId ?? generation; generationReason = prior.generationReason ?? 'restored'; unlocked = false
      }
      if (prop === 'setReasoningEffort' || prop === 'setThinking' || prop === 'restoreExecutionOptions') return (...args: unknown[]) => {
        if (!unlocked) return
        const fn: unknown = Reflect.get(target, prop, target)
        if (typeof fn === 'function') fn.apply(target, args)
      }
      if (prop === 'stream') return async (request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal) => {
        if (terminal) throw terminal
        const protectedRequest = request.prefixProbe === true || request.diagnostics?.purpose === 'worker_execution' || request.diagnostics?.purpose === 'worker_finalize'
        const parent = currentExecutionScope()
        let sends = 0
        let rejectedSend: ExecutionScope['rejectedSend']
        const scope: ExecutionScope = { singleAttempt: options.singleAttempt === true || parent?.singleAttempt === true,
          get sends() { return parent?.singleAttempt ? parent.sends : sends },
          set sends(value) { if (parent?.singleAttempt) parent.sends = value; else sends = value },
          get rejectedSend() { return parent?.singleAttempt ? parent.rejectedSend : rejectedSend },
          set rejectedSend(value) { if (parent?.singleAttempt) parent.rejectedSend = value; else rejectedSend = value },
          sessionId: sessionId ?? parent?.sessionId, model: options.model, commits: parent?.commits ?? [] }
        let comparison = 'baseline_missing'
        let previousMainRequestId: string | undefined
        let requestPrefix: ContinuationPrefixProof | undefined
        let attemptPrefix: ContinuationPrefixProof | undefined
        const makePrefix = (url: string, raw: Record<string, unknown>, owner?: string) => {
          const body = normalizedBody(raw)
          const next = proveWirePrefix(body, options.provider, currentExecutionScope()?.requestId ?? randomUUID(), normalizeBaseUrl(url))
          next.model = String(raw.model ?? options.model)
          next.cacheGenerationId = generation
          next.generationReason = generationReason
          next.credentialScope = `${options.credentialScope ?? `${options.provider}:default`}${owner ? `:principal:${owner}` : ''}`
          return next
        }
        if (protectedRequest) scope.beforeSend = (url, raw, owner) => {
          if (pendingRewind && (request.rewindAuthorizationId !== pendingRewind.cacheGenerationId
            || !request.validateRewindRequest || !request.onExecutionSnapshot)) {
            throw new LocalWorkerPolicyError('回退授权缺少匹配的历史封印或耐久提交通道；请求未发送')
          }
          request.validateRewindRequest?.(request.messages)
          const next = makePrefix(url, raw, owner)
          attemptPrefix = next
          const baseline = requestPrefix?.cacheGenerationId === generation ? requestPrefix : proof ?? rewindBaseline
          comparison = baseline ? 'equal' : generationReason === 'initial' ? 'baseline_missing' : 'generation_changed'
          previousMainRequestId = baseline?.requestId
          try {
            if (options.expectedPrincipal && owner !== options.expectedPrincipal) throw new LocalWorkerPolicyError('Root session credential owner changed; model request not sent')
            if (baseline) {
              if (baseline.provider !== next.provider || baseline.model !== next.model || baseline.endpointHash !== next.endpointHash
                || baseline.credentialScope !== next.credentialScope) throw new ContinuationPrefixError('binding', baseline, next)
              if (baseline.optionsHash !== next.optionsHash) throw new ContinuationPrefixError('options', baseline, next)
              if (baseline.toolsHash !== next.toolsHash) throw new ContinuationPrefixError('tools', baseline, next)
              const at = baseline === rewindBaseline ? -1 : baseline.messages.findIndex((message, index) => next.messages[index]?.hash !== message.hash)
              if (at !== -1) throw new ContinuationPrefixError(at, baseline, next)
            }
          } catch (error) {
            comparison = 'fork'
            throw error
          }
          if (!requestPrefix || requestPrefix.cacheGenerationId !== generation) {
            const previousProof = proof
            const previousRewind = rewindBaseline
            requestPrefix = next
            proof = next
            rewindBaseline = undefined
            unlocked = false
            const commit = request.onExecutionSnapshot?.(next)
            if (commit) scope.commits!.push(commit.then(() => { pendingRewind = undefined }).catch(() => {
              proof = previousProof
              requestPrefix = undefined
              rewindBaseline = previousRewind
              throw new LocalWorkerPolicyError('回退授权耐久提交失败；请求未发送')
            }))
          }
        }
        const check = scope.beforeSend
        if (parent?.beforeSend) scope.beforeSend = (url, raw, owner) => { parent.beforeSend!(url, raw, owner); check?.(url, raw, owner) }
        let failure: Error | undefined
        const observe = (usage: Partial<Usage>, status: 'complete' | 'aborted', identity?: { requestId?: string; attemptId?: string }): Partial<Usage> => {
          const requestId = usage.observation?.requestId ?? identity?.requestId
          const attemptId = usage.observation?.attemptId ?? identity?.attemptId
          const rejected = status === 'aborted' && requestId && attemptId
            && scope.rejectedSend?.requestId === requestId && scope.rejectedSend.attemptId === attemptId
            ? scope.rejectedSend : undefined
          const attempted = rejected ? makePrefix(rejected.url, rejected.body, rejected.owner) : attemptPrefix ?? proof
          if (!protectedRequest || !attempted) return usage
          return { ...usage, observation: {
            ...usage.observation,
            requestId: requestId ?? attempted.requestId,
            attemptId: attemptId ?? attempted.requestId,
            status: usage.observation?.status ?? status,
            fields: usage.observation?.fields ?? scope.usageFields ?? (status === 'complete'
              ? Object.fromEntries(Object.keys(usage).filter(key => key.endsWith('_tokens')).map(key => [key, key])) : {}),
            ...(proof ? { executionSnapshot: proof } : {}),
            wire: { ...usage.observation?.wire, provider: attempted.provider, model: attempted.model,
              purpose: request.diagnostics?.purpose, messages: attempted.messages, toolsHash: attempted.toolsHash,
              options: attempted.options ?? {}, endpointHash: attempted.endpointHash,
              baseline: previousMainRequestId || request.diagnostics?.priorPrefix || (rejected && proof) ? 'present' : usage.observation?.wire?.baseline ?? 'baseline_missing',
              comparison: rejected ? 'not_checked' : comparison,
              previousMainRequestId: (rejected ? proof?.requestId : previousMainRequestId) ?? request.diagnostics?.previousMainRequestId },
            continuity: { cacheGenerationId: generation, generationReason, optionsHash: attempted.optionsHash,
              toolsHash: attempted.toolsHash, credentialScope: attempted.credentialScope },
          } }
        }
        const observed: StreamCallbacks = { ...callbacks,
          onError: error => { failure = error; callbacks.onError(error) },
          onStreamAttemptAborted: info => callbacks.onStreamAttemptAborted?.({ ...info, usage: observe(info.usage ?? {}, 'aborted', info) }),
          onStopReason: (reason, usage) => {
            callbacks.onStopReason(reason, observe(usage, 'complete'))
          },
        }
        try {
          await scopes.run(scope, () => client.stream(request, observed, signal))
          if (failure) throw failure
        } catch (error) {
          if (options.singleAttempt) terminal = error instanceof Error ? error : new Error(String(error))
          throw error
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  policies.set(wrapped, options)
  return wrapped
}
