export interface Money {
  currency: 'CNY' | 'USD'
  amount: string
}
export interface Quota {
  unit: 'quota'
  amount: string
  conversionRevision: string
}
export interface PortalError {
  code: string
  message: string
  retryable: boolean
  retryAfterSeconds?: number
  scope?: 'account' | 'binding' | 'key' | 'supplier'
}
export type Envelope<T, Version extends 1 | 2 = 1> =
  | { version: Version; requestId: string; data: T; error?: never }
  | { version: Version; requestId: string; error: PortalError; data?: never }
export interface ModelSource {
  subject: string
  sessionId: string
  generation: number
}
export type Purpose =
  | 'agent'
  | 'compact'
  | 'title'
  | 'judge'
  | 'greeting'
  | 'report'
  | 'skill'
  | 'vision'
  | 'image-generation'
  | 'embedding'
  | 'probe'
export type Capabilities = Record<string, boolean | null> | null
export interface Binding {
  billingMode?: 'server'
  id: string
  modelId: string
  operation:
    | 'chat'
    | 'responses'
    | 'messages'
    | 'generate-content'
    | 'image-generation'
    | 'embedding'
  protocol: 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
  origin: string
  path: string
  stream: boolean
  capabilities: Capabilities
  requiredHeaders: Record<string, string> | null
  thinkingPolicy: string
  pricingRevision: string
}
export interface CatalogPrice {
  kind: 'token' | 'expression' | 'per-request' | 'unknown'
  period: 'peak' | 'offPeak' | 'fixed'
  pricingRevision: string
  rates: Record<
    'input' | 'output' | 'cacheRead',
    { money: Money; perTokens: 1000000 }
  > | null
  perRequest?: Money | null
}
export interface PriceSchedule {
  period: 'peak' | 'offPeak'
  timezone: 'Asia/Shanghai'
  calendarRevision: string
  asOf: string
  validUntil: string
  nextTransition: string | null
}
export interface OfficialModel {
  id: string
  displayName: string
  provider: string
  status: 'available' | 'unavailable' | 'unverified'
  contextWindow: number | null
  maxOutputTokens: number | null
  capabilities: Capabilities
  bindings: Binding[]
  costStatus: 'available' | 'unavailable'
  prices?: CatalogPrice[]
  priceSchedule?: PriceSchedule | null
}
export interface Catalog {
  revision: string
  models: OfficialModel[]
}
export interface Cycle {
  productId: string
  productRevision: string
  startsAt: string
  endsAt: string
  status: 'scheduled' | 'active' | 'ended' | 'refunded'
}
export interface Subscription {
  subscriptionId: string | null
  currentCycle: Cycle | null
  paidFutureCycles: Cycle[]
  nextProductId: string | null
  nextProductRevision: string | null
  renewalMode: 'manual'
  cancelAtPeriodEnd: boolean
  revision: string
}
export interface QuotaBar {
  percent: number | null
  state: 'available' | 'low' | 'empty' | 'unavailable'
}
interface CustomerBase {
  version: 2
  revision: string
  membership: { tier: 'none' | 'lite' | 'pro' | 'max'; status: 'active' | 'inactive'; expiresAt: string | null }
  subscription: Subscription
}
export type Summary = CustomerBase & (
  | { mode: 'package'; quotaBar: QuotaBar; moneyBalance?: never }
  | { mode: 'payg'; moneyBalance: Money; quotaBar?: never }
  | { mode: 'unavailable'; quotaBar?: never; moneyBalance?: never }
)
export interface Product {
  productId: string
  productRevision: string
  kind: 'subscription' | 'refill'
  name: string
  membershipTier: 'lite' | 'pro' | 'max' | null
  price: Money
  refundPolicyRevision: string
  refundPolicyText: string
  available: boolean
}
export interface ProductQuote {
  quoteId: string
  productId: string
  productRevision: string
  amount: Money
  refundPolicyRevision: string
  refundPolicyText: string
  validUntil: string
  paymentMethods: string[]
  cycleStartsAt: string | null
  cycleEndsAt: string | null
  issuanceAt: string | null
}
export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'refunding'
  | 'refunded'
export interface ProductOrder {
  orderId: string
  productId: string
  productRevision: string
  status: OrderStatus
  amount: Money
  refundPolicyRevision: string
  refundPolicyText?: string | null
  checkoutUrl: string | null
  expiresAt: string
  cycleStartsAt: string | null
  cycleEndsAt: string | null
  issuanceAt: string | null
  paidAt: string | null
}
export interface Refund {
  refundId: string
  orderId: string
  status: 'pending' | 'processing' | 'refunded' | 'failed'
  amount: Money
  refundPolicyRevision: string
  requestedAt: string
  completedAt: string | null
}
export interface Usage {
  id: string
  createdAt: string
  modelId: string
  inputTokens: number
  outputTokens: number
}
export interface Bill {
  orderId: string
  status: OrderStatus
  money: Money
  refunds: Refund[]
}
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}
export interface ModelResults {
  'view.get': Summary
  'catalog.list': Catalog
  'products.list': { revision: string; items: Product[] }
  'subscription.get': Subscription
  'subscription.change': Subscription
  'subscription.cancel': Subscription
  'quote.get': ProductQuote
  'order.create': ProductOrder
  'order.get': ProductOrder
  'refund.request': Refund
  'refund.get': Refund
  'usage.list': Page<Usage> & { status: 'available' | 'unavailable'; chargeStatus?: 'unavailable' }
  'billing.list': Page<Bill>
}
export type ModelAccountOperation = keyof ModelResults
export interface FlowStatus {
  status: 'pending' | 'approved' | 'consumed' | 'expired'
  expiresAt: string
  mode: 'login' | 'reauth'
  scope: null | 'developer_key.create' | 'developer_key.reveal'
  authenticationAfter: string | null
}
