import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficialCustomerView } from '../../../models/official-contract.js'
import { CachePanelSource } from '../../cache-panel-source.js'
import { renderCachePanel, formatOfficialUsageBadge } from '../cache-panel.js'
import { getTheme } from '../../theme.js'

const subscription = { subscriptionId: null, currentCycle: null, paidFutureCycles: [], nextProductId: null, nextProductRevision: null, renewalMode: 'manual' as const, cancelAtPeriodEnd: false, revision: '1' }
const view: OfficialCustomerView = { version: 2, mode: 'package', revision: 'a'.repeat(64), membership: { tier: 'lite', status: 'active', expiresAt: '2099-01-01T00:00:00Z' }, subscription, quotaBar: { percent: 50, state: 'available' } }
const strip = (value: string) => value.replace(/\x1B\[[0-9;]*m/g, '')

test('actual cache renderer and compact badge show the TianShu quota bar, not money', () => {
  const official = { status: 'ready' as const, source: 'tianshu' as const, customerView: view }
  const text = strip(renderCachePanel({ period: 'today', session: null, aggregates: null, loading: false, official }, 100, 40, getTheme()).join('\n'))
  assert.match(text, /额度.*50%/)
  assert.match(text, /天枢/)
  assert.doesNotMatch(text, /¥|CNY|platform\.deepseek|4000/)
  assert.match(strip(formatOfficialUsageBadge(official, undefined, getTheme()) ?? ''), /额度.*50%/)
  const payg = { ...official, customerView: { ...view, mode: 'payg' as const, quotaBar: undefined, moneyBalance: { currency: 'CNY' as const, amount: '123.45' } } }
  assert.match(strip(formatOfficialUsageBadge(payg, undefined, getTheme()) ?? ''), /123\.45 CNY/)
})

test('cache source retires old account observations and ignores a late pure-payg response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tianshu-quota-source-'))
  let owner = 'payg-owner', fail = false, clock = 100000
  let release!: (value: { source: 'tianshu'; customerView: OfficialCustomerView }) => void
  const late = new Promise<{ source: 'tianshu'; customerView: OfficialCustomerView }>(resolve => { release = resolve })
  const source = new CachePanelSource({ sessionsRoot: () => root, session: () => null, resolvePricing: () => undefined, now: () => clock, officialSourceKey: () => owner, loadOfficial: async () => {
    if (fail) throw Error('owned unavailable')
    return owner === 'payg-owner' ? late : { source: 'tianshu', customerView: view }
  }, onUpdate: () => {} })
  try {
    source.data()
    owner = 'package-owner'
    assert.equal(source.data().official.status, 'loading')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(source.data().official.customerView, view)
    release({ source: 'tianshu', customerView: { ...view, mode: 'payg', quotaBar: undefined, moneyBalance: { currency: 'CNY', amount: '123.45' } } })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(source.data().official.customerView, view)
    fail = true
    clock += 60001
    assert.equal(source.data().official.customerView, undefined)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(source.data().official.status, 'unavailable')
  } finally { await rm(root, { recursive: true, force: true }) }
})
