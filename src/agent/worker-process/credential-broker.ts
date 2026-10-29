import { randomUUID } from 'node:crypto'
import { exportModelDelegation, exportPreparedModelDelegation, originalRuntimeIdentity, createDelegatedSubmission, type DelegatedModelSnapshot, type ResolvedModelRuntime, type PreparedModelRuntime, type ModelSubmission, type ResolveModelInput, type WorkerModelSelection } from '../../models/model-runtime.js'
import { OfficialError, type OfficialIdentityRef, type OfficialErrorCode } from '../../models/official-contract.js'
import { checkModelAuthorization, refuseModelAuthorization, modelAuthorizationSignal, type ModelRequestAuthorizer } from '../../api/request-authorization.js'

export interface WorkerAuthRequest {
  t: 'auth-request'; requestId: string; kind: 'authorize' | 'check' | 'refuse'
  bindingId: string; modelId: string; operation: string; method: string; path: string; catalogRevision: string
  code?: OfficialErrorCode
}
export interface WorkerAuthResult {
  t: 'auth-result'; requestId: string
  authorization?: Awaited<ReturnType<ModelRequestAuthorizer['authorize']>>
  error?: OfficialErrorCode
}
const safeCodes = new Set<OfficialErrorCode>(['auth_required', 'account_changed', 'credential_revoked', 'model_unavailable', 'capability_unknown', 'pricing_changed', 'catalog_unavailable', 'insufficient_balance', 'supplier_balance_unavailable', 'entitlement_unavailable', 'rate_limit_unavailable', 'service_error', 'rate_limited'])
export type WorkerPrepareMode = 'runtime' | 'metadata'
export interface WorkerPrepareCancel { t: 'model-prepare-cancel'; requestId: string }
export interface WorkerPrepareRequest { t: 'model-prepare'; requestId: string; selectionId: string; mode?: WorkerPrepareMode }
export interface WorkerPrepareResult { t: 'model-prepared'; requestId: string; mode?: WorkerPrepareMode; snapshot?: DelegatedModelSnapshot; error?: OfficialErrorCode }
export interface WorkerCredentialBroker {
  readonly signal: AbortSignal
  readonly selections: WorkerModelSelection[]
  prepare(request: WorkerPrepareRequest): Promise<WorkerPrepareResult>
  cancelPrepare(requestId: string): void
  snapshots: DelegatedModelSnapshot[]
  handle(request: WorkerAuthRequest): Promise<WorkerAuthResult>
  add(runtime: ResolvedModelRuntime): void
  dispose(): void
}
export function createWorkerCredentialBroker(identity: OfficialIdentityRef, runtime: ResolvedModelRuntime): WorkerCredentialBroker {
  const allowed = new Map<string, { runtime: ResolvedModelRuntime; snapshot: DelegatedModelSnapshot }>()
  const seen = new Set<string>()
  const controller = new AbortController(), signals = new Set<AbortSignal>()
  const revoked = () => broker.dispose()
  let disposed = false, pending = 0
  const broker: WorkerCredentialBroker = {
    signal: controller.signal,
    snapshots: [], selections: [],
    async prepare(request) { return { t: 'model-prepared', requestId: request.requestId, mode: request.mode, error: 'model_unavailable' } },
    cancelPrepare() {},
    add(value) {
      const snapshot = exportModelDelegation(value)
      if (originalRuntimeIdentity(value) !== identity || allowed.size >= 64) throw new OfficialError('auth_required', 401, false)
      const signal = modelAuthorizationSignal(value.requestAuth!)
      if (signal?.aborted) throw new OfficialError('account_changed')
      if (signal && !signals.has(signal)) { signals.add(signal); signal.addEventListener('abort', revoked, { once: true }) }
      allowed.set(snapshot.binding.id, { runtime: value, snapshot }); broker.snapshots.push(snapshot)
    },
    async handle(request) {
      const result = (error?: OfficialErrorCode, authorization?: WorkerAuthResult['authorization']): WorkerAuthResult => ({ t: 'auth-result', requestId: request.requestId, error, authorization })
      const entry = allowed.get(request.bindingId)
      if (seen.size >= 4096) broker.dispose()
      if (disposed || pending >= 64 || !/^[a-zA-Z0-9-]{1,80}$/.test(request.requestId) || seen.has(request.requestId) || !entry) return result('auth_required')
      const { runtime: selected, snapshot } = entry
      if (request.modelId !== snapshot.model.id || request.operation !== snapshot.binding.operation || request.method !== 'POST' || request.path !== snapshot.binding.path || request.catalogRevision !== snapshot.catalogRevision || !['authorize', 'check', 'refuse'].includes(request.kind)) return result('model_unavailable')
      seen.add(request.requestId)
      if (request.kind === 'refuse') {
        refuseModelAuthorization(selected.requestAuth!, new OfficialError(request.code && safeCodes.has(request.code) ? request.code : 'service_error', undefined, false))
        return result()
      }
      pending++
      let timer: ReturnType<typeof setTimeout> | undefined
      let expired = false
      try {
        return await Promise.race([
          (async () => {
            await checkModelAuthorization(selected.requestAuth!)
            if (disposed || expired) return result('auth_required')
            const authorization = request.kind === 'authorize' ? await selected.requestAuth!.authorize({ operation: snapshot.binding.operation, method: 'POST', url: snapshot.binding.origin + snapshot.binding.path, headers: { 'content-type': 'application/json' } }) : undefined
            await checkModelAuthorization(selected.requestAuth!)
            return disposed || expired ? result('auth_required') : result(undefined, authorization)
          })(),
          new Promise<WorkerAuthResult>(resolve => { timer = setTimeout(() => { expired = true; resolve(result('service_error')) }, 10_000) }),
        ])
      } catch (error) { return result(error instanceof OfficialError ? error.code : 'service_error') }
      finally { if (timer) clearTimeout(timer); pending-- }
    },
    dispose() { if (disposed) return; disposed = true; allowed.clear(); for (const signal of signals) signal.removeEventListener('abort', revoked); signals.clear(); controller.abort(new OfficialError('account_changed')) },
  }
  broker.add(runtime)
  return broker
}



export function createLazyWorkerCredentialBroker(submission: ModelSubmission, choices: readonly ResolveModelInput[]): WorkerCredentialBroker {
  if (choices.length > 256) throw new OfficialError('model_unavailable', 409, false)
  const pinned = submission.capture()
  const selections: WorkerModelSelection[] = []
  const allowed = new Map<string, ResolveModelInput>()
  type Work = { controller: AbortController; promise: Promise<PreparedModelRuntime | ResolvedModelRuntime>; consumers: Set<string> }
  const preparing = new Map<string, Work>()
  const pendingPreparations = new Map<string, { cancel: () => void }>()
  const seen = new Set<string>()
  const controller = new AbortController()
  let base: WorkerCredentialBroker | undefined
  let disposed = false, pending = 0
  for (const input of choices) {
    const selection = Object.freeze({ selectionId: randomUUID(), providerName: input.provider.name, modelId: input.modelId, purpose: input.purpose })
    selections.push(selection)
    const config = structuredClone(input.config)
    const freeze = (value: unknown): void => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child) } }
    freeze(config)
    const provider = config.provider.providers[input.provider.name]
    if (!provider) throw new OfficialError('model_unavailable', 409, false)
    allowed.set(selection.selectionId, Object.freeze({ config, provider, apiKey: '', modelId: input.modelId, targetProvider: input.provider.name, purpose: input.purpose }))
  }
  const broker: WorkerCredentialBroker = {
    signal: controller.signal,
    snapshots: [], selections,
    add(runtime) {
      if (disposed) throw new OfficialError('auth_required', 401, false)
      runtime = { ...runtime, requestAuth: pinned.forModel(runtime.provider, runtime.modelId) }
      if (!base) {
        base = createWorkerCredentialBroker(originalRuntimeIdentity(runtime), runtime)
        base.signal.addEventListener('abort', () => controller.abort(new OfficialError('account_changed')), { once: true })
      } else base.add(runtime)
      broker.snapshots = base.snapshots
    },
    async handle(request) {
      if (seen.size >= 4096) broker.dispose()
      if (disposed || !base || pending >= 64 || seen.has(request.requestId) || !/^[a-zA-Z0-9-]{1,80}$/.test(request.requestId)) return { t: 'auth-result', requestId: request.requestId, error: 'auth_required' }
      seen.add(request.requestId); pending++
      try { return await base.handle(request) } finally { pending-- }
    },
    cancelPrepare(requestId) { pendingPreparations.get(requestId)?.cancel() },
    async prepare(request) {
      const mode = request.mode ?? 'runtime'
      const failure = (error: OfficialErrorCode): WorkerPrepareResult => ({ t: 'model-prepared', requestId: request.requestId, mode, error })
      if (seen.size >= 4096) broker.dispose()
      const input = allowed.get(request.selectionId)
      if (disposed || pending >= 64 || !input || !['runtime', 'metadata'].includes(mode) || !/^[a-zA-Z0-9-]{1,80}$/.test(request.requestId) || seen.has(request.requestId)) return failure('auth_required')
      seen.add(request.requestId); pending++
      const key = `${mode}:${request.selectionId}`
      let work = preparing.get(key)
      if (!work) {
        const controller = new AbortController()
        work = { controller, consumers: new Set(), promise: undefined! }
        work.promise = mode === 'metadata' ? pinned.prepareModel({ ...input, signal: controller.signal }) : pinned.resolve({ ...input, signal: controller.signal })
        preparing.set(key, work)
      }
      const owned = work
      owned.consumers.add(request.requestId)
      let expired = false
      let cancel!: (code?: OfficialErrorCode) => void
      const cancelled = new Promise<WorkerPrepareResult>(resolve => { cancel = (code = 'auth_required') => {
        expired = true
        owned.consumers.delete(request.requestId)
        if (!owned.consumers.size) {
          owned.controller.abort(new OfficialError(code, undefined, false))
          if (preparing.get(key) === owned) preparing.delete(key)
        }
        resolve(failure(code))
      } })
      pendingPreparations.set(request.requestId, { cancel })
      const timer = setTimeout(() => cancel('service_error'), 10_000)
      try {
        return await Promise.race([
          (async (): Promise<WorkerPrepareResult> => {
            const prepared = await owned.promise
            await pinned.check()
            if (disposed || expired || !owned.consumers.has(request.requestId)) return failure('auth_required')
            if (mode === 'metadata') return { t: 'model-prepared', requestId: request.requestId, mode, snapshot: exportPreparedModelDelegation(prepared) }
            const runtime = prepared as ResolvedModelRuntime
            if (!broker.snapshots.some(s => s.binding.id === runtime.model.managed?.bindingId)) broker.add(runtime)
            return { t: 'model-prepared', requestId: request.requestId, mode, snapshot: exportModelDelegation(runtime) }
          })(), cancelled,
        ])
      } catch (error) { return failure(error instanceof OfficialError ? error.code : 'service_error') }
      finally {
        clearTimeout(timer); pendingPreparations.delete(request.requestId); pending--
        owned.consumers.delete(request.requestId)
        if (!owned.consumers.size) {
          owned.controller.abort(new OfficialError('auth_required', undefined, false))
          if (preparing.get(key) === owned) preparing.delete(key)
        }
      }
    },
    dispose() { if (disposed) return; disposed = true; for (const item of pendingPreparations.values()) item.cancel(); base?.dispose(); allowed.clear(); preparing.clear(); controller.abort(new OfficialError('account_changed')) },
  }
  return broker
}

type ChannelResult = WorkerAuthResult | WorkerPrepareResult
type ChannelRequest = WorkerAuthRequest | WorkerPrepareRequest
export function createWorkerAuthChannel(send: (request: ChannelRequest | WorkerPrepareCancel) => void, signal: AbortSignal) {
  type Pending = { kind: ChannelResult['t']; mode?: WorkerPrepareMode; resolve: (result: ChannelResult) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }
  const pending = new Map<string, Pending>()
  let closed = false, count = 0
  const finish = (requestId: string, result: ChannelResult, cancel = false) => {
    const item = pending.get(requestId)
    if (!item) return
    pending.delete(requestId); clearTimeout(item.timer); item.cleanup()
    if (cancel && item.kind === 'model-prepared') { try { send({ t: 'model-prepare-cancel', requestId }) } catch {} }
    item.resolve(result)
  }
  const dispose = () => { closed = true; for (const [requestId, item] of pending) finish(requestId, { t: item.kind, requestId, error: 'auth_required' }, true) }
  signal.addEventListener('abort', dispose, { once: true })
  const exchange = async (message: ChannelRequest, kind: ChannelResult['t'], requestSignal?: AbortSignal): Promise<ChannelResult> => {
    signal.throwIfAborted(); requestSignal?.throwIfAborted()
    if (++count > 4096) dispose()
    if (closed || pending.size >= 64) throw new OfficialError('auth_required', 401, false)
    const requestId = message.requestId
    const result = await new Promise<ChannelResult>(resolve => {
      const abort = () => finish(requestId, { t: kind, requestId, error: 'auth_required' }, true)
      const timer = setTimeout(() => finish(requestId, { t: kind, requestId, error: 'service_error' }, true), 10_000)
      pending.set(requestId, { kind, mode: message.t === 'model-prepare' ? message.mode ?? 'runtime' : undefined, resolve, timer, cleanup: () => requestSignal?.removeEventListener('abort', abort) })
      requestSignal?.addEventListener('abort', abort, { once: true })
      try { send(message) } catch { dispose() }
    })
    signal.throwIfAborted(); requestSignal?.throwIfAborted()
    if (closed || result.error) throw new OfficialError(result.error && safeCodes.has(result.error) ? result.error : 'auth_required', undefined, false)
    return result
  }
  const request = (snapshot: DelegatedModelSnapshot, kind: WorkerAuthRequest['kind'], code?: OfficialErrorCode) => exchange({ t: 'auth-request', requestId: randomUUID(), kind, bindingId: snapshot.binding.id, modelId: snapshot.model.id, operation: snapshot.binding.operation, method: 'POST', path: snapshot.binding.path, catalogRevision: snapshot.catalogRevision, code }, 'auth-result') as Promise<WorkerAuthResult>
  return {
    accept(result: ChannelResult) {
      const item = pending.get(result.requestId)
      if (!item) return
      const invalid = result.t !== item.kind || result.error !== undefined && !safeCodes.has(result.error)
        || result.t === 'model-prepared' && ((result.mode ?? 'runtime') !== item.mode || Boolean(result.snapshot) === Boolean(result.error))
        || result.t === 'auth-result' && Boolean(result.authorization) && Boolean(result.error)
      finish(result.requestId, invalid ? { t: item.kind, requestId: result.requestId, error: 'service_error' } : result, invalid)
    },
    dispose() { signal.removeEventListener('abort', dispose); dispose() },
    connect(snapshots: DelegatedModelSnapshot[], selections: WorkerModelSelection[] = []) { return createDelegatedSubmission(snapshots, {
      signal,
      async prepare(selection, mode = 'runtime', requestSignal) {
        const result = await exchange({ t: 'model-prepare', requestId: randomUUID(), selectionId: selection.selectionId, mode }, 'model-prepared', requestSignal) as WorkerPrepareResult
        if (!result.snapshot) throw new OfficialError('service_error', 503, false)
        return result.snapshot
      },
      async authorize(snapshot, input) { if (input.method !== 'POST' || input.operation !== snapshot.binding.operation) throw new OfficialError('model_unavailable', 409, false); const result = await request(snapshot, 'authorize'); if (!result.authorization) throw new OfficialError('auth_required', 401, false); return result.authorization },
      async check(snapshot) { await request(snapshot, 'check') },
      refuse(snapshot, error) { void request(snapshot, 'refuse', error.code).catch(() => {}) },
    }, selections) },
  }
}
