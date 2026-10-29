import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as grants from '../pro-grant.js'

const owner = { subject: '11111111-1111-4111-8111-111111111111', accountSessionId: '22222222-2222-4222-8222-222222222222', deviceId: 'synthetic-device' }
const claims = { source: 'official-membership', product: 'tianshu-desktop', ...owner, tier: 'pro', membershipRevision: '3', maxOfflineMs: 0, iat: 1000000, exp: 1050000, lic: 1100000 }

test('membership claim verification is an explicit account-bound operation', () => {
  assert.equal(typeof grants.validateOfficialMembershipClaims, 'function')
  const result = grants.validateOfficialMembershipClaims(claims, { now: 1000001 }, owner)
  assert.equal(result.ok, true)
})

test('membership claims cannot cross account, device, offline, or expiry boundaries', () => {
  assert.equal(typeof grants.validateOfficialMembershipClaims, 'function')
  for (const changed of [
    { subject: '33333333-3333-4333-8333-333333333333' },
    { accountSessionId: '33333333-3333-4333-8333-333333333333' },
    { deviceId: 'another-device' },
    { maxOfflineMs: 1 },
    { exp: 1060001 },
    { membershipRevision: 'untrusted' },
  ]) assert.equal(grants.validateOfficialMembershipClaims({ ...claims, ...changed }, { now: 1000001 }, owner).ok, false)
  assert.equal(grants.validateOfficialMembershipClaims(claims, { now: claims.exp }, owner).ok, false)
})
