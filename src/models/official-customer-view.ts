import type { Summary } from './official-customer-types.js'

type Parser = (value: unknown) => unknown
type Fields = Record<string, Parser>
const invalid = (): never => { throw Error('invalid_customer_response') }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const text: Parser = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 ? value : invalid()
const string: Parser = value => typeof value === 'string' && value.length <= 8192 ? value : invalid()
const boolean: Parser = value => typeof value === 'boolean' ? value : invalid()
const integer: Parser = value => Number.isSafeInteger(value) && Number(value) >= 0 ? value : invalid()
const one = (...values: unknown[]): Parser => value => values.includes(value) ? value : invalid()
const nullable = (parser: Parser): Parser => value => value === null ? null : parser(value)
const optional = (parser: Parser): Parser => value => value === undefined ? undefined : parser(value)
const list = (parser: Parser): Parser => value => Array.isArray(value) && value.length <= 10000 ? value.map(parser) : invalid()
const shape = (fields: Fields): Parser => value => {
  const source = object(value), result: Record<string, unknown> = {}
  if (Object.keys(source).some(key => !Object.prototype.hasOwnProperty.call(fields, key))) invalid()
  for (const [key, parser] of Object.entries(fields)) { const parsed = parser(source[key]); if (parsed !== undefined) result[key] = parsed }
  return result
}
const timestamp: Parser = value => {
  const result = text(value) as string
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0,19) !== result.slice(0,19)) invalid()
  return result
}
const money = shape({currency:one('CNY','USD'),amount:value => /^(0|[1-9]\d{0,17})(\.\d{1,12})?$/.test(text(value) as string) ? value : invalid()})
const cycle = shape({productId:text,productRevision:text,startsAt:timestamp,endsAt:timestamp,status:one('scheduled','active','ended','refunded')})
const subscription = shape({subscriptionId:nullable(text),currentCycle:nullable(cycle),paidFutureCycles:list(cycle),nextProductId:nullable(text),nextProductRevision:nullable(text),renewalMode:one('manual'),cancelAtPeriodEnd:boolean,revision:text})
const quotaBar: Parser = value => {
  const result = shape({percent:nullable(integer),state:one('available','low','empty','unavailable')})(value) as Record<string, unknown>
  const percent = result.percent
  if (result.state === 'unavailable') { if (percent !== null) invalid() }
  else if (typeof percent !== 'number' || percent > 100 || result.state === 'empty' && percent !== 0 || result.state === 'low' && percent > 20 || result.state === 'available' && percent <= 20) invalid()
  return result
}

export function parseOfficialCustomerView(value: unknown): Summary {
  const source = object(value)
  const fields: Fields = {version:one(2),mode:one('package','payg','unavailable'),revision:value => /^[0-9a-f]{64}$/.test(text(value) as string) ? value : invalid(),membership:shape({tier:one('none','lite','pro','max'),status:one('active','inactive'),expiresAt:nullable(timestamp)}),subscription}
  if (source.mode === 'package') fields.quotaBar = quotaBar
  if (source.mode === 'payg') fields.moneyBalance = shape({currency:one('CNY'),amount:value => /^(0|[1-9]\d{0,17})\.\d{2}$/.test(text(value) as string) ? value : invalid()})
  return shape(fields)(source) as Summary
}

export function validateCustomerOperation(operation: unknown, input: unknown): asserts input is Record<string, unknown> {
  if (typeof operation !== 'string') invalid()
  const fields = object(input)
  const required: Record<string,string[]> = {
    'view.get':[], 'catalog.list':[], 'products.list':[], 'subscription.get':[],
    'quote.get':['productId','productRevision'], 'order.create':['quoteId'], 'order.get':['orderId'],
    'model.quote.get':['bindingId','catalogRevision','pricingRevision'],
    'subscription.change':['subscriptionId','productId','productRevision','expectedRevision'],
    'subscription.cancel':['subscriptionId','expectedRevision'], 'refund.request':['orderId','reason'], 'refund.get':['refundId'],
  }
  if (operation === 'usage.list' || operation === 'billing.list') {
    if (Object.keys(fields).some(key => !['cursor','limit'].includes(key)) || fields.limit !== undefined && (!Number.isSafeInteger(fields.limit) || Number(fields.limit) < 1 || Number(fields.limit) > 100) || fields.cursor !== undefined && (typeof fields.cursor !== 'string' || !/^[a-z0-9-]{0,64}$/.test(fields.cursor))) invalid()
    return
  }
  const names = required[operation as string] ?? invalid()
  const allowed = operation === 'quote.get' ? [...names,'subscriptionId'] : names
  if (Object.keys(fields).some(key => !allowed.includes(key)) || names.some(key => typeof fields[key] !== 'string' || !(fields[key] as string).trim() || (fields[key] as string).length > 256) || fields.subscriptionId !== undefined && (typeof fields.subscriptionId !== 'string' || !fields.subscriptionId.trim() || fields.subscriptionId.length > 256)) invalid()
}

interface ProjectionOptions {catalogOrigins?: readonly string[]; checkout?: Parser}
const capabilities: Parser = value => {
  if (value === null) return null
  const result = object(value)
  if (Object.keys(result).length > 128 || Object.entries(result).some(([key,enabled]) => key.length > 128 || enabled !== null && typeof enabled !== 'boolean')) invalid()
  return {...result}
}
const headers: Parser = value => {
  if (value === null) return null
  const result = object(value)
  if (Object.entries(result).some(([key,content]) => !['anthropic-version','content-type','accept'].includes(key.toLowerCase()) || typeof content !== 'string' || content.length > 256 || /[\r\n]/.test(content))) invalid()
  return {...result}
}
const rates = nullable(shape({input:shape({money,perTokens:one(1000000)}),output:shape({money,perTokens:one(1000000)}),cacheRead:shape({money,perTokens:one(1000000)})}))
const price = shape({kind:one('token','expression','per-request','unknown'),period:one('peak','offPeak','fixed'),pricingRevision:text,rates,perRequest:optional(nullable(money))})
const priceSchedule: Parser = value => {
  if(value===null)return null
  const result=shape({period:one('peak','offPeak'),timezone:one('Asia/Shanghai'),calendarRevision:value=>(text(value) as string).length<=256?value:invalid(),asOf:timestamp,validUntil:timestamp,nextTransition:nullable(timestamp)})(value) as Record<string,unknown>
  if(Date.parse(result.asOf as string)>=Date.parse(result.validUntil as string) || result.nextTransition!==null && Date.parse(result.nextTransition as string)<Date.parse(result.validUntil as string))invalid()
  return result
}

export function projectCustomerOperation(operation: string,value: unknown,options: ProjectionOptions = {}): unknown {
  if (operation === 'view.get') return parseOfficialCustomerView(value)
  if (operation.startsWith('subscription.')) return subscription(value)
  const status = one('pending','processing','paid','failed','expired','refunding','refunded')
  const refund = shape({refundId:text,orderId:text,status,amount:money,refundPolicyRevision:string,requestedAt:timestamp,completedAt:nullable(timestamp)})
  if (operation === 'refund.request' || operation === 'refund.get') return refund(value)
  if (operation === 'usage.list') {
    if(object(value).status==='available')return shape({status:one('available'),chargeStatus:one('unavailable'),items:list(shape({id:text,createdAt:timestamp,modelId:text,inputTokens:integer,outputTokens:integer})),nextCursor:nullable(text)})(value)
    return shape({status:one('unavailable'),items:value => Array.isArray(value) && !value.length ? [] : invalid(),nextCursor:one(null)})(value)
  }
  if (operation === 'billing.list') return shape({items:list(shape({orderId:text,status,money,refunds:list(refund)})),nextCursor:nullable(text)})(value)
  if (operation === 'products.list') return shape({revision:text,items:list(shape({productId:text,productRevision:text,kind:one('subscription','refill'),name:text,membershipTier:nullable(one('lite','pro','max')),price:money,refundPolicyRevision:string,refundPolicyText:string,available:boolean}))})(value)
  if (operation === 'quote.get') return shape({quoteId:text,productId:text,productRevision:text,amount:money,refundPolicyRevision:text,refundPolicyText:text,validUntil:timestamp,paymentMethods:list(text),cycleStartsAt:nullable(timestamp),cycleEndsAt:nullable(timestamp),issuanceAt:nullable(timestamp)})(value)
  if (operation === 'order.create' || operation === 'order.get') return shape({orderId:text,productId:text,productRevision:text,status,amount:money,refundPolicyRevision:string,refundPolicyText:nullable(text),checkoutUrl:options.checkout ?? (value => value === null ? null : invalid()),expiresAt:timestamp,cycleStartsAt:nullable(timestamp),cycleEndsAt:nullable(timestamp),issuanceAt:nullable(timestamp),paidAt:nullable(timestamp)})(value)
  if (operation === 'model.quote.get') {
    const source = object(value)
    const fields: Fields = {quoteId:text,modelId:text,bindingId:text,pricingRevision:text,calendarRevision:text,tier:one('standard','subscriber'),period:one('peak','offPeak','fixed'),timezone:one('Asia/Shanghai'),asOf:timestamp,validUntil:timestamp,kind:one('opaque'),costStatus:one('unavailable')}
    if (source.kind !== 'opaque') {fields.kind = one('token','expression','per-request');fields.costStatus = one('available');fields.rates = rates;fields.perRequest = nullable(money)}
    return shape(fields)(source)
  }
  if (operation === 'catalog.list') {
    const binding = shape({id:text,modelId:text,operation:one('chat','responses','messages','generate-content','image-generation','embedding'),protocol:one('openai','openai-responses','anthropic','gemini'),origin:value => {
      const origin = new URL(text(value) as string)
      return origin.protocol === 'https:' && origin.origin === value && !origin.username && !origin.password && options.catalogOrigins?.includes(origin.origin) ? value : invalid()
    },path:value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\r\n#]/.test(value) ? value : invalid(),stream:boolean,capabilities,requiredHeaders:headers,thinkingPolicy:string,pricingRevision:text,billingMode:optional(one('server'))})
    const model: Parser = value => {
      const source = object(value)
      const fields: Fields = {id:text,displayName:text,provider:text,status:one('available','unavailable','unverified'),contextWindow:nullable(integer),maxOutputTokens:nullable(integer),capabilities,bindings:list(binding),costStatus:one('unavailable')}
      if (source.costStatus === 'available') {fields.costStatus = one('available');fields.prices = list(price);fields.priceSchedule = priceSchedule}
      return shape(fields)(source)
    }
    return shape({revision:string,models:list(model)})(value)
  }
  return invalid()
}
