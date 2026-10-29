import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { OfficialError, type Binding, type OfficialErrorCode } from '../models/official-contract.js'
import { getNetworkConfig } from '../config/manager.js'
import { providerDispatcher } from './provider-network.js'

export type Operation = Binding['operation']
export interface ModelRequestAuthorizer {
  authorize(input: { operation: Operation; method: string; url: string; headers: Record<string, string> }): Promise<{ url: string; headers: Record<string, string>; redirect: 'manual' | 'error' }>
}
interface AuthorizerControl {
  owner: object
  model: string
  principal?: string
  requestId?: string
  direct?: boolean
  signal?(): AbortSignal
  capture(): ModelRequestAuthorizer
  check(): Promise<void>
  refuse(error: OfficialError): void
  policy(body: Record<string, unknown>, effort?: string): void
}
const controls = new WeakMap<ModelRequestAuthorizer, AuthorizerControl>()
const retryChecks = new WeakMap<OfficialError, () => Promise<void>>()
interface OfficialRequestPrincipal {
  headers: RequestInit['headers']
  principal?: string
  direct: boolean
  active: boolean
}
const requestPrincipals = new AsyncLocalStorage<OfficialRequestPrincipal | undefined>()
const ownerPrincipals = new WeakMap<object, Map<string, string>>()
function principalFor(control: AuthorizerControl, operation: Operation, url: string): string | undefined {
  if (!control.principal || !/^[a-f0-9]{64}$/.test(control.principal)) return undefined
  let bindings = ownerPrincipals.get(control.owner)
  if (!bindings) { bindings = new Map(); ownerPrincipals.set(control.owner, bindings) }
  const key = JSON.stringify([control.principal, control.model, operation, new URL(url).href])
  let principal = bindings.get(key)
  if (!principal) {
    principal = createHash('sha256').update(key).digest('hex')
    bindings.set(key, principal)
  }
  return principal
}
export function currentOfficialRequestPrincipal(headers: RequestInit['headers']): string | undefined {
  const current = requestPrincipals.getStore()
  return current?.active && current.headers === headers ? current.principal : undefined
}
export function isDirectOfficialRequest(headers: RequestInit['headers']): boolean {
  const current = requestPrincipals.getStore()
  return current?.active === true && current.headers === headers && current.direct
}
/** Node construction only. Runtime's closure owns the original broker identity. */
export function sealModelRequestAuthorizer(authorizer: ModelRequestAuthorizer, control: AuthorizerControl): ModelRequestAuthorizer {
  controls.set(authorizer, Object.freeze({ ...control }))
  return Object.freeze(authorizer)
}
export function isModelRequestAuthorizer(value: ModelRequestAuthorizer | undefined, owner?: object): value is ModelRequestAuthorizer { return !!value && controls.has(value) && (owner === undefined || controls.get(value)!.owner === owner) }
export function modelAuthorizationSignal(authorizer: ModelRequestAuthorizer): AbortSignal | undefined {
  const control = controls.get(authorizer)
  if (!control) throw new OfficialError('auth_required', 401, false)
  return control.signal?.()
}
export function captureModelAuthorization(authorizer: ModelRequestAuthorizer | undefined, model: string): ModelRequestAuthorizer | undefined {
  if (!authorizer) return undefined
  const control = controls.get(authorizer)
  if (!control || control.model !== model) throw new OfficialError('model_unavailable', 409, false)
  const captured = control.capture()
  const capturedControl = controls.get(captured)
  if (!capturedControl || capturedControl.model !== model) throw new OfficialError('auth_required', 401, false)
  return sealModelRequestAuthorizer({ authorize: input => captured.authorize(input) }, { ...capturedControl, requestId: randomUUID() })
}
export function applyOfficialRequestPolicy(authorizer: ModelRequestAuthorizer | undefined, body: object, effort?: string): void {
  if (authorizer) {
    const control = controls.get(authorizer)
    if (!control) throw new OfficialError('auth_required', 401, false)
    control.policy(body as Record<string, unknown>, effort)
  }
}
export async function authorizeModelRequest(authorizer: ModelRequestAuthorizer | undefined, operation: Operation, url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
  if (!authorizer) return { url, init }
  const control = controls.get(authorizer)
  if (!control) throw new OfficialError('auth_required', 401, false)
  const authorized = await authorizer.authorize({ operation, method: init.method ?? 'GET', url, headers: Object.fromEntries(new Headers(init.headers)) })
  if (control.requestId) authorized.headers = { ...authorized.headers, 'x-request-id': control.requestId }
  const signal = control.signal?.()
  return { url: authorized.url, init: { ...init, headers: authorized.headers, redirect: authorized.redirect, ...(signal ? { signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal } : {}) } }
}
const statuses: Partial<Record<OfficialErrorCode, readonly number[]>> = {
  auth_required: [401], account_changed: [401, 409], credential_revoked: [401, 403], model_unavailable: [403, 409, 503], capability_unknown: [400, 409],
  pricing_changed: [400, 403, 409, 503], catalog_unavailable: [409, 503], insufficient_balance: [402], supplier_balance_unavailable: [503], entitlement_unavailable: [503], rate_limit_unavailable: [503], service_error: [503], rate_limited: [429],
}
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
export function projectOfficialInferenceError(value: unknown, status: number, retryAfter: string | null, now = Date.now()): OfficialError {
  const fallback = () => new OfficialError('service_error', 503, false)
  const root = object(value), error = object(root?.error)
  if (!root || !error) return fallback()
  const v1 = root.version === 1 && typeof root.requestId === 'string' && root.requestId.length > 0 && root.requestId.length <= 128 && !Object.hasOwn(root, 'data') && typeof error.retryable === 'boolean'
  const code = error.code as OfficialErrorCode
  if (!v1) return fallback()
  if (typeof code !== 'string' || !Object.hasOwn(statuses, code) || !statuses[code]?.includes(status)) return fallback()
  if (code !== 'rate_limited') return new OfficialError(code, status, false)
  const metadata = object(error.metadata) ?? error
  const seconds = metadata.retryAfterSeconds, scope = metadata.scope
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0 || seconds > 86400 || typeof scope !== 'string' || !['account', 'binding', 'key', 'supplier'].includes(scope)) return fallback()
  let wait = seconds
  if (retryAfter !== null) {
    const parsed = /^\d+$/.test(retryAfter) ? Number(retryAfter) : (Date.parse(retryAfter) - now) / 1000
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 86400) return fallback()
    wait = Math.max(wait, Math.ceil(parsed))
  }
  return new OfficialError(code, status, true, wait, scope as 'account' | 'binding' | 'key' | 'supplier')
}
async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}) }, 5000)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65536) return undefined
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch { return undefined } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export async function checkOfficialResponse(authorizer: ModelRequestAuthorizer | undefined, response: Response): Promise<void> {
  if (!authorizer || response.ok) return
  const control = controls.get(authorizer)
  if (!control) throw new OfficialError('auth_required', 401, false)
  const error = control.direct
    ? new OfficialError(response.status === 401 ? 'credential_revoked' : response.status === 402 ? 'insufficient_balance' : response.status === 429 ? 'rate_limited' : 'service_error', response.status === 401 ? 401 : response.status === 402 ? 402 : response.status === 429 ? 429 : 503, false)
    : projectOfficialInferenceError(await readBoundedJson(response), response.status, response.headers.get('retry-after'))
  if (control.direct) await response.body?.cancel().catch(() => {})
  if (error.code === 'rate_limited') retryChecks.set(error, control.check)
  else control.refuse(error)
  throw error
}
export async function checkOfficialRetry(error: OfficialError): Promise<void> { await retryChecks.get(error)?.() }
export function officialStreamFailure(authorizer: ModelRequestAuthorizer | undefined, error: unknown): unknown {
  if (!authorizer || (error instanceof Error && error.name === 'AbortError') || error instanceof OfficialError) return error
  const safe = new OfficialError('service_error', 503, false)
  controls.get(authorizer)?.refuse(safe)
  return safe
}

import { fetchWithTimeout } from './fetch-timeout.js'
/** Native clients retain their body/readers; this is the final HTTP authority seam. */
export async function fetchModelWithTimeout(authorizer: ModelRequestAuthorizer | undefined, operation: Operation, ...args: Parameters<typeof fetchWithTimeout>): Promise<Response> {
  try {
    const wire = await authorizeModelRequest(authorizer, operation, String(args[0]), args[1])
    const control = authorizer && controls.get(authorizer)
    const ownership = control && principalFor(control, operation, wire.url)
    const principal = control ? { headers: wire.init.headers, principal: ownership, direct: control.direct === true, active: true } : undefined
    const network = authorizer ? getNetworkConfig() : undefined
    const dispatcher = control?.direct || network?.proxy || network?.noProxy
      ? providerDispatcher(wire.url, network) ?? args[3] : args[3]
    let response: Response
    try {
      response = await requestPrincipals.run(principal, () => fetchWithTimeout(wire.url, wire.init, args[2], dispatcher, args[4], args[5]))
    } finally { if (principal) principal.active = false }
    await checkOfficialResponse(authorizer, response)
    return response
  } catch (error) { throw officialStreamFailure(authorizer, error) }
}

/** Parser diagnostics are observable before a parser's outer catch runs. */
export function officialStreamCallbacks(authorizer: ModelRequestAuthorizer | undefined, callbacks: import('./stream-client.js').StreamCallbacks): import('./stream-client.js').StreamCallbacks {
  if (!authorizer) return callbacks
  let sawToolCall = false
  return { ...callbacks,
    onContentBlock: block => { if (block.type === 'tool_use') sawToolCall = true; callbacks.onContentBlock(block) },
    onStopReason: (reason, usage) => callbacks.onStopReason(sawToolCall && ['end_turn', 'stop'].includes(reason) ? 'tool_use' : reason, usage),
    onError: error => callbacks.onError(officialStreamFailure(authorizer, error) as Error),
    onStreamAttemptAborted: info => callbacks.onStreamAttemptAborted?.({ ...info, errorName: info.errorName === 'AbortError' ? 'AbortError' : 'OfficialError', errorMessage: info.errorName === 'AbortError' ? 'Aborted' : 'service_error' }),
  }
}

/** Internal delegation retains the native control; JSON never supplies one. */
export async function checkModelAuthorization(authorizer: ModelRequestAuthorizer): Promise<void> {
  const control = controls.get(authorizer)
  if (!control) throw new OfficialError('auth_required', 401, false)
  await control.check()
}
export function refuseModelAuthorization(authorizer: ModelRequestAuthorizer, error: OfficialError): void {
  const control = controls.get(authorizer)
  if (!control) throw new OfficialError('auth_required', 401, false)
  control.refuse(error)
}
