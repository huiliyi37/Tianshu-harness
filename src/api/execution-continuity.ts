import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { proveWirePrefix, continuityFailureDetails, assertCanonicalSourcePrefix, isCompleteExecutionSnapshot, isRewindGenerationAuthorization, ContinuationPrefixError, LocalWorkerPolicyError, type ContinuationPrefixProof, type RewindGenerationAuthorization } from './continuation-prefix.js'
import { captureNativeProof, isProvenNativeContinuation, type NativeSourceBoundaries } from './native-continuation.js'
import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import type { Usage } from './types.js'
import { normalizeBaseUrl } from './endpoint-map.js'
import { proRegistry } from './pro-registry.js'

export interface ExecutionScope {
  wireTransformVersion?: string
  normalization?: import('./wire-normalization.js').WireNormalizationSummary
  provider?: string
  singleAttempt: boolean
  sends: number
  sessionId?: string
  model?: string
  requestId?: string
  attemptId?: string
  usageFields?: Record<string, string>
  commits?: Promise<void>[]
  nativeSourceBoundaries?: NativeSourceBoundaries
  rejectedSend?: { url: string; body: Record<string, unknown>; owner?: string; requestId?: string; attemptId?: string }
  beforeSend?: (url: string, body: Record<string, unknown>, owner?: string) => void
}
const scopes = new AsyncLocalStorage<ExecutionScope>()
const validations = new AsyncLocalStorage<{ guards: number; accepted: LocalWorkerPolicyError }>()
const providerRequirements = new AsyncLocalStorage<readonly string[]>()
export function currentExecutionScope(): ExecutionScope | undefined { return scopes.getStore() }
export function isExecutionValidation(): boolean { return validations.getStore() !== undefined }

export async function validateExecutionHistory(client: StreamClient, request: OaiChatRequest): Promise<void> {
  const validation = { guards: 0, accepted: new LocalWorkerPolicyError('Execution history validation accepted') }
  const parent = currentExecutionScope()
  const scope: ExecutionScope = { singleAttempt: parent?.singleAttempt === true, sends: 0, commits: [],
    sessionId: parent?.sessionId, beforeSend: parent?.beforeSend }
  try {
    await validations.run(validation, () => scopes.run(scope, () => client.stream({ ...request,
      prefixProbe: true, messages: structuredClone(request.messages),
    }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } })))
  } catch (error) {
    if (error === validation.accepted) return
    throw error
  }
  throw new LocalWorkerPolicyError('History validation did not reach a protected transport boundary')
}

export function assertExecutionAccess(): void {
  for (const provider of providerRequirements.getStore() ?? []) proRegistry.assertProviderAccess(provider)
}

export function withProviderRequirement<T>(provider: string, operation: () => T): T {
  return withProviderRequirements([provider], operation)
}

export function currentProviderRequirements(): readonly string[] { return providerRequirements.getStore() ?? [] }

export function withProviderRequirements<T>(providers: readonly string[], operation: () => T): T {
  return propagateProviderRequirements(providers, () => { assertExecutionAccess(); return operation() })
}

export function propagateProviderRequirements<T>(providers: readonly string[], operation: () => T): T {
  const requiredProviders = [...new Set([...currentProviderRequirements(), ...providers])]
  return providerRequirements.run(requiredProviders, operation)
}

/** The transport boundary, after provider transforms and before any HTTP send. */
export function checkExecutionSend(url: string, body: Record<string, unknown>, owner?: string): void {
  const scope = scopes.getStore()
  if (!scope) return
  if (scope.singleAttempt && scope.sends > 0) {
    scope.rejectedSend = { url, body, owner, requestId: scope.requestId, attemptId: scope.attemptId }
    throw new LocalWorkerPolicyError('Worker request already sent; automatic retry is disabled')
  }
  try { scope.beforeSend?.(url, body, owner) }
  finally { scope.nativeSourceBoundaries = undefined }
  const validation = validations.getStore()
  if (validation) {
    if (!validation.guards) throw new LocalWorkerPolicyError('History validation requires a protected baseline guard at the transport boundary')
    throw validation.accepted
  }
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
  let restoredFirstRequest = false
  let abortedContinuation = false
  let lastProtectedSignal: AbortSignal | undefined
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
  if (proof && !isCompleteExecutionSnapshot(proof)) {
    terminal = new LocalWorkerPolicyError('Legacy execution snapshot is incomplete; explicitly start a new cache generation')
  }
  const authorize = (reason: string) => {
    if (options.singleAttempt && terminal) throw terminal
    terminal = undefined
    proof = undefined
    rewindBaseline = undefined
    pendingRewind = undefined
    restoredFirstRequest = false
    abortedContinuation = false
    lastProtectedSignal = undefined
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
        // resume/重建后的首个请求允许合法漂移（重注入、落盘投影差、显式换模型）——
        // baseline 本来就是上一个 run 的 wire 快照，语义上该开新代次而非死锁。
        // 2026-10-14 起只对 worker（singleAttempt）放宽；2026-10-16 推广到主会话：
        // 打断标记改写已发送消息把会话砖死，resume 也救不回（revit-4213e2/2026101609914b2d8192）。
        restoredFirstRequest = true
      }
      if (prop === 'setReasoningEffort' || prop === 'setThinking' || prop === 'restoreExecutionOptions') return (...args: unknown[]) => {
        if (!unlocked) return
        const fn: unknown = Reflect.get(target, prop, target)
        if (typeof fn === 'function') fn.apply(target, args)
      }
      if (prop === 'stream') return async (request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal) => {
        proRegistry.assertProviderAccess(options.provider)
        if (terminal) throw terminal
        const validation = validations.getStore()
        const protectedRequest = request.prefixProbe === true || request.diagnostics?.purpose === 'worker_execution' || request.diagnostics?.purpose === 'worker_finalize'
        // 用户打断（abort）会丢弃上一轮的部分输出，携带 volatile 注入的尾消息随之合法重建——
        // 上一个受保护请求的信号已 aborted 时武装一次性放宽，直到下一次成功发送。
        if (protectedRequest && !validation) { abortedContinuation ||= lastProtectedSignal?.aborted === true; lastProtectedSignal = signal }
        const parent = currentExecutionScope()
        let sends = 0
        let rejectedSend: ExecutionScope['rejectedSend']
        const scope: ExecutionScope = { singleAttempt: options.singleAttempt === true || parent?.singleAttempt === true,
          get sends() { return parent?.singleAttempt ? parent.sends : sends },
          set sends(value) { if (parent?.singleAttempt) parent.sends = value; else sends = value },
          get rejectedSend() { return parent?.singleAttempt ? parent.rejectedSend : rejectedSend },
          set rejectedSend(value) { if (parent?.singleAttempt) parent.rejectedSend = value; else rejectedSend = value },
          provider: options.provider, sessionId: sessionId ?? parent?.sessionId, model: options.model, commits: parent?.commits ?? [] }
        let rejectedContinuity: ReturnType<typeof continuityFailureDetails>
        let comparison = 'baseline_missing'
        let previousMainRequestId: string | undefined
        let requestPrefix: ContinuationPrefixProof | undefined
        let attemptPrefix: ContinuationPrefixProof | undefined
        const makePrefix = (url: string, raw: Record<string, unknown>, owner?: string) => {
          const body = normalizedBody(raw)
          const next = proveWirePrefix(body, options.provider, currentExecutionScope()?.requestId ?? randomUUID(), normalizeBaseUrl(url))
          const mapping = currentExecutionScope()?.nativeSourceBoundaries
          if (mapping) Object.assign(next, captureNativeProof(body, mapping))
          next.model = String(raw.model ?? options.model)
          next.cacheGenerationId = generation
          next.generationReason = generationReason
          const wireTransformVersion = currentExecutionScope()?.wireTransformVersion
          if (wireTransformVersion) next.wireTransformVersion = wireTransformVersion
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
          request.validateSourceHistory?.(next)
          attemptPrefix = next
          const baseline = requestPrefix?.cacheGenerationId === generation ? requestPrefix : proof ?? rewindBaseline
          comparison = baseline ? 'equal' : generationReason === 'initial' ? 'baseline_missing' : 'generation_changed'
          previousMainRequestId = baseline?.requestId
          try {
            if (validation && (!baseline || baseline === rewindBaseline)) throw new LocalWorkerPolicyError('History validation requires an existing protected baseline')
            if (options.expectedPrincipal && owner !== options.expectedPrincipal) throw new LocalWorkerPolicyError('Root session credential owner changed; model request not sent')
            if (baseline) {
              // provider/endpoint/凭证是信任边界，恒 fail-closed；仅 model 档在
              // resume 首请求仅允许主会话切到当前配置模型；worker 保持固定模型绑定。
              if (baseline.provider !== next.provider || baseline.endpointHash !== next.endpointHash
                || baseline.credentialScope !== next.credentialScope) throw new ContinuationPrefixError('binding', baseline, next)
              const modelDrift = baseline.model !== next.model
              if (modelDrift && (!restoredFirstRequest || scope.singleAttempt || next.model !== options.model)) {
                throw new ContinuationPrefixError('binding', baseline, next)
              }
              if (baseline.optionsHash !== next.optionsHash) throw new ContinuationPrefixError('options', baseline, next)
              if (baseline.toolsHash !== next.toolsHash) throw new ContinuationPrefixError('tools', baseline, next)
              if (baseline !== rewindBaseline && baseline.canonicalSource !== undefined && !currentExecutionScope()?.nativeSourceBoundaries) {
                throw new LocalWorkerPolicyError('Native conversion evidence required by execution snapshot; request not sent')
              }
              if (baseline !== rewindBaseline && (baseline.canonicalSource !== undefined || next.canonicalSource !== undefined)) assertCanonicalSourcePrefix(baseline, next)
              const at = baseline === rewindBaseline ? -1 : baseline.messages.findIndex((message, index) => next.messages[index]?.hash !== message.hash)
              // 两条放宽各有边界，勿混：
              //   resume_prefix_drift（restoredFirstRequest，resume/重建后的首请求）放宽
              //   **任意位置**的消息分叉——baseline 是上一个 run 的 wire 快照，resume 的
              //   重注入与落盘投影差会让整段前缀合法重建，语义上该开新代次而非死锁。
              //   abort_tail_rebuild（abortedContinuation）只放宽「baseline 最后一条 user
              //   消息起」的分叉：abort 的合法形态是从被丢弃的 partial 输出往前的注入尾
              //   消息重建，更早的历史改写仍 fail-closed。
              const mapping = currentExecutionScope()?.nativeSourceBoundaries
              const nativeContinues = baseline !== rewindBaseline && mapping
                ? isProvenNativeContinuation(baseline, next, normalizedBody(raw), mapping) : undefined
              // A restored OpenAI-style request may rebuild the same source/render
              // history from a stale persisted wire proof. An explicit negative
              // native proof remains a hard rejection (forged tail/layout or a
              // historical rewrite); only absent native evidence can rebase.
              const restoreRebase = restoredFirstRequest && !validation && at !== -1 && nativeContinues === undefined
              if (nativeContinues === false) throw new ContinuationPrefixError(at === -1 ? 'native_evidence' : at, baseline, next)
              const lastUserAt = baseline.messages.reduce((last, message, index) => message.role === 'user' ? index : last, -1)
              // An unchanged source AND render cannot justify a resume/abort rewrite.
              // Old mixed-normalization baselines require the explicit repair transaction.
              const stableProjection = request.continuityEvidence?.sourcePrefix === 'same' && request.continuityEvidence.renderPrefix === 'same'
              // model switch 优先于 prefix drift：换模型即换缓存命名空间（前缀逐字节相同也全
              // 失效），是更强的原因信号——「换模型 + 消息同时漂移」不该被记成纯 prefix drift，
              // 否则按 generationReason 筛「换过模型」的会话会漏。到达此处的 modelDrift 必为：
              // 主会话 + resume 首请求 + 切到当前配置模型（其余组合上方已抛）。
              const driftReason = modelDrift ? 'resume_model_switch'
                : at !== -1 && nativeContinues !== true
                  ? restoreRebase ? 'resume_prefix_drift' : stableProjection ? undefined
                    : abortedContinuation && lastUserAt !== -1 && at >= lastUserAt ? 'abort_tail_rebuild'
                    : undefined
                  : undefined
              if (validation && driftReason) throw new ContinuationPrefixError(at === -1 ? 'binding' : at, baseline, next)
              if (at !== -1 && nativeContinues !== true && !driftReason) throw new ContinuationPrefixError(at, baseline, next)
              if (driftReason) {
                generation = randomUUID()
                generationReason = driftReason
                next.cacheGenerationId = generation
                next.generationReason = generationReason
                comparison = 'generation_changed'
                client.authorizeCacheGeneration?.(generationReason)
              }
            }
          } catch (error) {
            comparison = 'fork'
            if (error instanceof LocalWorkerPolicyError) {
              const history = request.continuityEvidence
              const stage = error instanceof ContinuationPrefixError && typeof error.changed === 'number'
                ? history?.renderPrefix === 'changed' ? 'render'
                  : history?.sourcePrefix === 'same' && history.renderPrefix === 'same' ? 'transport' : 'unknown'
                : undefined
              error.continuityEvidence = { ...history, normalization: scope.normalization, ...(stage ? { stage } : {}), ...error.continuityEvidence }
            }
            rejectedContinuity = continuityFailureDetails(error)
            throw error
          }
          if (validation) { validation.guards++; return }
          restoredFirstRequest = false
          abortedContinuation = false
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
            continuity: { cacheGenerationId: generation, generationReason, ...(attempted.wireTransformVersion ? { wireTransformVersion: attempted.wireTransformVersion } : {}), optionsHash: attempted.optionsHash,
              toolsHash: attempted.toolsHash, credentialScope: attempted.credentialScope },
          } }
        }
        const observed: StreamCallbacks = validation ? callbacks : { ...callbacks,
          onError: error => { failure = error; callbacks.onError(error) },
          onStreamAttemptAborted: info => callbacks.onStreamAttemptAborted?.({ ...info, continuityFailure: rejectedContinuity, usage: observe(info.usage ?? {}, 'aborted', info) }),
          onStopReason: (reason, usage) => {
            callbacks.onStopReason(reason, observe(usage, 'complete'))
          },
        }
        try {
          await scopes.run(scope, () => client.stream(request, observed, signal))
          if (failure) throw failure
        } catch (error) {
          if (options.singleAttempt && !validation) terminal = error instanceof Error ? error : new Error(String(error))
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
