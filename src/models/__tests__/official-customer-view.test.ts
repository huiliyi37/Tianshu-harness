import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccountRequest, projectAccount } from '../official-contract.js'
import { officialFixture } from '../../auth/__tests__/official-model-auth.test.js'
import { fixtureConfiguration } from '../../auth/__tests__/official-model-auth.test.js'
import { createSecretCipher, decodeSecret } from '../../auth/secure-store.js'
import { buildOfficialModelRoutes } from '../../server/official-model-routes.js'

const subscription = { subscriptionId: null, currentCycle: null, paidFutureCycles: [], nextProductId: null, nextProductRevision: null, renewalMode: 'manual', cancelAtPeriodEnd: false, revision: '1' }
const base = { version: 2, revision: 'a'.repeat(64), membership: { tier: 'lite', status: 'active', expiresAt: '2099-01-01T00:00:00Z' }, subscription }
const packageView = { ...base, mode: 'package', quotaBar: { percent: 50, state: 'available' } }
const paygView = { ...base, mode: 'payg', moneyBalance: { currency: 'CNY', amount: '123.45' } }

test('customer-v2 accepts the minimal package view without importing a management summary', () => {
  const request = parseAccountRequest({ version: 2, op: 'view.get', input: {}, requestId: 'closed-customer' })
  assert.deepEqual(projectAccount(request.op, packageView, 'synthetic-owner', []), packageView)
  const result = JSON.stringify(projectAccount(request.op, packageView, 'synthetic-owner', []))
  assert.doesNotMatch(result, /moneyBalance|creditValue|wallet|inputTokens|quota"/)
})

test('customer-v2 only accepts money in a server-proven pure payg view', () => {
  const request = parseAccountRequest({ version: 2, op: 'view.get', input: {}, requestId: 'payg-customer' })
  assert.deepEqual(projectAccount(request.op, paygView, 'synthetic-owner', []), paygView)
  for (const extra of [{ moneyBalance: paygView.moneyBalance }, { wallet: { available: '4000' } }, { creditValue: { currency: 'CNY', amount: '40.00' } }])
    assert.throws(() => projectAccount(request.op, { ...packageView, ...extra }, 'synthetic-owner', []))
})

test('legacy requests and forged owner fields cannot regain a monetary summary', () => {
  assert.throws(() => parseAccountRequest({ op: 'summary', input: {}, requestId: 'legacy' }))
  assert.throws(() => parseAccountRequest({ version: 2, op: 'view.get', input: { userId: 8 }, requestId: 'forged' }))
})

test('the actual broker reads only a v2 customer view through the owned account transport', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker()
    const identity = broker.captureOfficialIdentity()!
    const view = await broker.account(identity, {version:2,op:'view.get',input:{},requestId:'actual-customer-view'})
    assert.deepEqual(view, { ...base, membership:{tier:'none',status:'inactive',expiresAt:null}, subscription:{...subscription,revision:'s1'},mode:'package',quotaBar:{percent:null,state:'unavailable'} })
    const sent = fixture.requests.find(request => request.path.endsWith('/tui-model-account'))!
    assert.equal(sent.body.version, 2)
    assert.equal(sent.body.op, 'view.get')
    assert.doesNotMatch(JSON.stringify(view), /moneyBalance|wallet|creditValue|"quota"/)
  } finally { await fixture.close() }
})

test('actual managed catalog and inference quote keep bindings but withhold package unit prices', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const broker = await fixture.broker()
    const identity = broker.captureOfficialIdentity()!
    const catalog = await broker.getOfficialCatalog(identity, 'agent')
    assert.equal(catalog.models.length, 1)
    assert.equal(catalog.models[0]!.costStatus, 'unavailable')
    assert.equal(catalog.models[0]!.prices, undefined)
    const quote = await broker.getOfficialPriceQuote(identity, {bindingId:'chat-1',catalogRevision:'catalog-1',pricingRevision:'price-1'})
    assert.equal(quote.kind, 'opaque')
    assert.doesNotMatch(JSON.stringify(quote), /"rates"|"perRequest"|"money"|conversionRevision/)
    assert.ok(fixture.requests.some(request => request.path === '/api/official/v2/customer/catalog'))
    assert.ok(fixture.requests.some(request => request.path === '/api/official/v2/customer/model-quote'))
  } finally { await fixture.close() }
})

test('a cold restart and failed view refresh cannot recover money from the old disk cache', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    fixture.setOverride(path => path.endsWith('/tui-model-account') ? {data:paygView} : undefined)
    const broker = await fixture.broker()
    const identity = broker.captureOfficialIdentity()!
    const status = await broker.syncOfficialAccess(identity)
    assert.equal(status.customerView?.mode, 'payg')
    assert.equal('balance' in status, false)
    const cached = decodeSecret(createSecretCipher(fixture.home,'local-key'),readFileSync(join(fixture.home,'official-access.json'),'utf8'))!
    const saved = JSON.parse(cached)
    assert.equal(saved.version,2)
    assert.equal('summary' in saved,false)
    assert.equal('customerView' in saved,false)
    assert.doesNotMatch(cached,/123\.45|moneyBalance|creditValue|"wallet"/)
    const restarted = await fixture.broker()
    assert.equal(restarted.getOfficialStatus().customerView,null)
    fixture.setOverride(path => path.endsWith('/tui-model-account') ? {status:503,error:{code:'service_error',message:'service_error',retryable:true}} : undefined)
    const failed = await broker.syncOfficialAccess(identity)
    assert.equal(failed.customerView,null)
    assert.equal(broker.getOfficialStatus().customerView,null)
  } finally { await fixture.close() }
})

test('late payg response cannot replace package view after the broker source changes', async () => {
  const fixture = await officialFixture()
  let release: (() => void) | undefined
  try {
    await fixture.install('A')
    const broker = await fixture.broker()
    const identity = broker.captureOfficialIdentity()!
    let admitted: (() => void) | undefined
    const started = new Promise<void>(resolve => {admitted=resolve})
    const pendingReply = new Promise<void>(resolve => {release=resolve})
    fixture.setOverride(path => path.endsWith('/tui-model-account') ? {data:paygView} : undefined)
    fixture.setBeforeReply(async path => {if(path.endsWith('/tui-model-account')){admitted?.();await pendingReply}})
    const pending = broker.syncOfficialAccess(identity)
    const outcome = pending.then(value => ({value}), error => ({error}))
    await Promise.race([started,outcome])
    await fixture.install('B')
    release?.()
    const refused = await outcome
    assert.equal('error' in refused,true)
    assert.match(String('error' in refused ? refused.error : ''),/account_changed/)
    fixture.setOverride(path => path.endsWith('/tui-model-account') ? {data:packageView} : undefined)
    fixture.setBeforeReply(undefined)
    const next = broker.captureOfficialIdentity()!
    const current = await broker.syncOfficialAccess(next)
    assert.deepEqual(current.customerView,packageView)
    assert.equal('balance' in current,false)
    assert.doesNotMatch(JSON.stringify(current.customerView),/123\.45|moneyBalance|creditValue|"wallet"/)
  } finally { release?.();await fixture.close() }
})

test('the authenticated sidecar uses v2 customer routes and rejects the retired account route', async () => {
  const fixture = await officialFixture()
  try {
    await fixture.install('A')
    const routes = buildOfficialModelRoutes({home:fixture.home,apiToken:'local-customer-fixture',fetchImpl:fixture.fetchImpl,configuration:fixtureConfiguration})
    const headers = {authorization:'Bearer local-customer-fixture'}
    const status = await routes['GET /official-model/status']!(undefined,{},headers)
    assert.equal(status.status,200)
    assert.equal((status.body as {version:number}).version,2)
    assert.equal(typeof routes['POST /official-model/customer'],'function')
    const view = await routes['POST /official-model/customer']!({version:2,op:'view.get',input:{},requestId:'sidecar-view'},{},headers)
    assert.equal(view.status,200)
    assert.equal((view.body as {version:number}).version,2)
    assert.doesNotMatch(JSON.stringify(view.body),/moneyBalance|creditValue|"wallet"|"quota"/)
    const legacy = await routes['POST /official-model/account']!({op:'summary',input:{},requestId:'legacy'},{},headers)
    assert.equal(legacy.status,426)
    assert.equal((legacy.body as {error:{code:string}}).error.code,'customer_upgrade_required')
    const unauthenticated = await routes['POST /official-model/customer']!({version:2,op:'view.get',input:{},requestId:'denied'},{},{authorization:'Bearer wrong'})
    assert.equal(unauthenticated.status,401)
  } finally { await fixture.close() }
})
