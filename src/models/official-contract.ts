import { z } from 'zod'
import { projectCustomerOperation, validateCustomerOperation } from './official-customer-view.js'

export const purposeSchema = z.enum(['agent', 'compact', 'title', 'judge', 'greeting', 'report', 'skill', 'vision', 'image-generation', 'embedding', 'probe'])
export type Purpose = z.infer<typeof purposeSchema>
export interface OfficialIdentityRef { readonly subject: string; readonly accountSessionId: string; readonly deviceId: string; readonly generation: number; readonly incarnation: string }
export interface OfficialCredential { credential: string; subject: string; accountSessionId: string; generation: number; expiresAt: string; catalogRevision: string; directAvailable?: boolean }
export interface OfficialDirectGrant { readonly credential: string; readonly subject: string; readonly accountSessionId: string; readonly expiresAt: string; readonly catalogRevision: string; readonly bindingId: string; readonly modelId: string; readonly protocol: 'openai'; readonly origin: string; readonly path: '/v1/chat/completions' }
export const textSchema = z.string().min(1).max(8192)
export const utcSchema = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 19) === s.slice(0, 19))
export const moneySchema = z.object({ currency: z.enum(['CNY', 'USD']), amount: z.string().regex(/^\d+(?:\.\d+)?$/).max(128) })
export const quotaSchema = z.object({ unit: z.literal('quota'), amount: z.string().regex(/^-?\d+$/).max(128), conversionRevision: textSchema })
export type Money = z.infer<typeof moneySchema>
export type Quota = z.infer<typeof quotaSchema>
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const capabilitiesSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), z.boolean().nullable()).nullable()
const rateSchema = z.object({ money: moneySchema, perTokens: z.literal(1000000) })
export const ratesSchema = z.object({ input: rateSchema, output: rateSchema, cacheRead: rateSchema })
export const priceKindSchema = z.enum(['token', 'expression', 'per-request', 'unknown'])
export const periodSchema = z.enum(['peak', 'offPeak', 'fixed'])
const priceFields = { kind: priceKindSchema, rates: ratesSchema.nullable(), perRequest: moneySchema.nullable() }
function validPrice(value: { kind: string; rates?: unknown; perRequest?: unknown }): boolean {
  return (value.kind === 'token') === (value.rates !== null) && (value.kind === 'per-request') === (value.perRequest != null)
}
export const catalogPriceSchema = z.object({ ...priceFields, perRequest: moneySchema.nullable().optional(), period: periodSchema, pricingRevision: textSchema }).refine(validPrice)
export const priceQuoteSchema = z.object({ kind:z.enum(['token','expression','per-request','unknown','opaque']),costStatus:z.enum(['available','unavailable']),rates:ratesSchema.nullable().optional(),perRequest:moneySchema.nullable().optional(),quoteId: textSchema, modelId: textSchema, bindingId: textSchema, pricingRevision: textSchema, calendarRevision: z.string().max(256), tier: z.enum(['standard', 'subscriber']), period: periodSchema, timezone: z.literal('Asia/Shanghai'), asOf: utcSchema, validUntil: utcSchema }).strict().refine(value => value.kind === 'opaque' ? value.costStatus === 'unavailable' && value.rates === undefined && value.perRequest === undefined : value.kind !== 'unknown' && value.costStatus === 'available' && value.rates !== undefined && value.perRequest !== undefined && validPrice(value))
export type PriceQuote = z.infer<typeof priceQuoteSchema>
export const bindingSchema = z.object({ billingMode: z.literal('server').optional(), id: textSchema, modelId: textSchema, operation: z.enum(['chat', 'responses', 'messages', 'generate-content', 'image-generation', 'embedding']), protocol: z.enum(['openai', 'openai-responses', 'anthropic', 'gemini']), origin: textSchema, path: textSchema, stream: z.boolean(), capabilities: capabilitiesSchema, requiredHeaders: z.record(z.string(), z.string().max(8192)).nullable(), thinkingPolicy: z.string().max(8192), pricingRevision: textSchema })
export type Binding = z.infer<typeof bindingSchema>
const priceScheduleSchema = z.object({ period: z.enum(['peak', 'offPeak']), timezone: z.literal('Asia/Shanghai'), calendarRevision: textSchema.max(256), asOf: utcSchema, validUntil: utcSchema, nextTransition: utcSchema.nullable() }).refine(s => Date.parse(s.asOf) < Date.parse(s.validUntil) && (s.nextTransition === null || Date.parse(s.validUntil) <= Date.parse(s.nextTransition)))
export const catalogSchema = z.object({ revision: z.string().max(256), models: z.array(z.object({ id: textSchema, displayName: textSchema, provider: textSchema, status: z.enum(['available', 'unavailable', 'unverified']), contextWindow: integer.positive().nullable(), maxOutputTokens: integer.positive().nullable(), capabilities: capabilitiesSchema, bindings: z.array(bindingSchema).max(1000),costStatus:z.enum(['available','unavailable']), prices: z.array(catalogPriceSchema).max(1000).optional(), priceSchedule: priceScheduleSchema.nullable().optional() }).strict().refine(value => value.costStatus === 'unavailable' ? value.prices === undefined && value.priceSchedule === undefined : value.prices !== undefined)).max(10000) }).strict()
export type Catalog = z.infer<typeof catalogSchema>
export type OfficialModel = Catalog['models'][number]

export const officialErrorCodes = ['customer_upgrade_required', 'auth_required', 'account_changed', 'credential_revoked', 'model_unavailable', 'capability_unknown', 'pricing_changed', 'entitlement_unavailable', 'insufficient_balance', 'supplier_balance_unavailable', 'catalog_unavailable', 'payment_unavailable', 'rate_limited', 'rate_limit_unavailable', 'service_error', 'invalid_request', 'browser_unavailable', 'browser_binding_invalid', 'reauth_required', 'flow_not_approved', 'flow_consumed', 'flow_expired', 'flow_not_found'] as const
export type OfficialErrorCode = typeof officialErrorCodes[number]
const statuses: Partial<Record<OfficialErrorCode, number>> = { auth_required: 401, credential_revoked: 401, account_changed: 409, invalid_request: 400, pricing_changed: 409, model_unavailable: 409, capability_unknown: 409, insufficient_balance: 402, rate_limited: 429, browser_binding_invalid: 403, reauth_required: 403, flow_not_found: 404, flow_expired: 410, flow_consumed: 409 }
export class OfficialError extends Error {
  constructor(readonly code: OfficialErrorCode, readonly status = statuses[code] ?? 503, readonly retryable = status >= 500, readonly retryAfterSeconds?: number, readonly scope?: 'account' | 'binding' | 'key' | 'supplier') { super(code); this.name = 'OfficialError' }
  publicError() { return { code: this.code, message: this.code, retryable: this.retryable, ...(this.code === 'rate_limited' ? { retryAfterSeconds: this.retryAfterSeconds, scope: this.scope } : {}) } }
}
export type OfficialProducer = 'bootstrap' | 'account' | 'gateway'
// Transport status is authoritative only within the fixed producer's wire contract.
// Keep this separate from locally generated errors (for example local account_changed is 409).
const accountStatuses: Partial<Record<OfficialErrorCode, number>> = {
  auth_required: 401, account_changed: 401, credential_revoked: 401, invalid_request: 400,
  pricing_changed: 409, browser_binding_invalid: 403, reauth_required: 403, flow_not_approved: 409,
  flow_consumed: 409, flow_expired: 410, flow_not_found: 404, rate_limited: 429,
  insufficient_balance: 402, model_unavailable: 503, capability_unknown: 400,
}
const gatewayStatuses: Partial<Record<OfficialErrorCode, readonly number[]>> = {
  auth_required: [401], credential_revoked: [403], model_unavailable: [403],
  catalog_unavailable: [409, 503], pricing_changed: [400, 403, 409, 503],
  entitlement_unavailable: [503], supplier_balance_unavailable: [503],
  rate_limited: [429], rate_limit_unavailable: [503], service_error: [503],
}
function producerStatusAllowed(producer: OfficialProducer, status: number, code: OfficialErrorCode, retryable: boolean): boolean {
  if (producer === 'gateway') return gatewayStatuses[code]?.includes(status) ?? false
  if (producer === 'bootstrap') {
    // W1 emits local invalid_request/400, then maps validated bridge failures to 401/503.
    return (code === 'invalid_request' && status === 400 && !retryable) || status === (retryable ? 503 : 401)
  }
  return status === (accountStatuses[code] ?? (code === 'payment_unavailable' && !retryable ? 400 : 503))
}
export function parseEnvelope(value: unknown, producer: OfficialProducer, status: number, requestId?: string, wireVersion: 1 | 2 = 1): unknown {
  const result = z.object({ version: z.literal(wireVersion), requestId: z.string().max(128), data: z.unknown().optional(), error: z.unknown().optional() }).strict().parse(value)
  if (requestId !== undefined && result.requestId !== requestId) throw new OfficialError('service_error')
  if (result.error !== undefined) {
    if (result.data !== undefined) throw new OfficialError('service_error')
    const error = z.object({ code: z.enum(officialErrorCodes), retryable: z.boolean(), retryAfterSeconds: integer.positive().optional(), scope: z.enum(['account', 'binding', 'key', 'supplier']).optional() }).parse(result.error)
    if (error.code === 'rate_limited' && (!error.retryAfterSeconds || !error.scope)) throw new OfficialError('service_error')
    if (!producerStatusAllowed(producer, status, error.code, error.retryable)) throw new OfficialError('service_error')
    throw new OfficialError(error.code, status, error.retryable, error.retryAfterSeconds, error.scope)
  }
  if (status !== 200 || result.data === undefined) throw new OfficialError('service_error')
  return result.data
}
export function publicFailure(error: unknown): OfficialError { return error instanceof OfficialError ? error : new OfficialError('service_error') }
export function exactOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new OfficialError('service_error')
  return value
}

export type { Summary as OfficialCustomerView } from './official-customer-types.js'
export { parseOfficialCustomerView } from './official-customer-view.js'
export type AccountSummary = import('./official-customer-types.js').Summary
export interface OfficialStatus {
  sourceEpoch: string | null
  portalLinks: { wallet: string | null; usage: string | null }
  identity: OfficialIdentityRef | null
  status: 'unauthenticated' | 'unavailable' | 'ready' | 'expired' | 'syncing'
  expiresAt: string | null
  catalogRevision: string | null
  syncedAt: string | null
  customerView: AccountSummary | null
}
export type AccountOperationResult = import('./official-customer-types.js').ModelResults
export type AccountOperation = keyof AccountOperationResult
export function parseAccountRequest(raw: unknown): { version: 2; op: AccountOperation; input: Record<string, unknown>; requestId: string } {
  try {
    const data = z.object({ version:z.literal(2), op:z.string(),input:z.unknown(),requestId:z.string().refine(value => value.length>0 && Buffer.byteLength(value)<=128) }).strict().parse(raw)
    validateCustomerOperation(data.op,data.input)
    return { version:2, op:data.op as AccountOperation,input:data.input,requestId:data.requestId }
  } catch { throw new OfficialError('invalid_request') }
}
export function projectAccount(op: AccountOperation, data: unknown, _subject: string, checkoutOrigins: readonly string[], catalogOrigins: readonly string[] = []): unknown {
  try {
    return projectCustomerOperation(op,data,{catalogOrigins,checkout:value => {
      if(value===null)return null
      if(typeof value!=='string')throw new OfficialError('service_error')
      const url=new URL(value)
      if(url.username||url.password||url.hash||!checkoutOrigins.includes(exactOrigin(url.origin)))throw new OfficialError('service_error')
      return value
    }})
  } catch(error) { throw publicFailure(error) }
}
