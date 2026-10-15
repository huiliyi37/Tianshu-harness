import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAccountSnapshot, mergeAccountSnapshot, parseAccountSnapshot, type AccountSnapshot } from '../account-sync.js'

const snapshot = (): AccountSnapshot => ({ version: 1, userId: 'me',
  profile: { status: 'ok', fetchedAt: 1, data: { avatarUrl: null, founding: null, fetchedAt: 1, account: { userId: 'me', email: null, displayName: 'Website' } } },
  identity: { status: 'empty', data: null, fetchedAt: 1 }, entitlements: { status: 'ok', data: [], fetchedAt: 1 },
})

test('当前设备绑定来自服务端快照，缓存不凭旧身份猜绑定', () => {
  const raw = { ...snapshot(), deviceBinding: { state: 'bound', licenseId: 'license-fixture' } }
  const parsed = parseAccountSnapshot(raw, 'me')
  assert.deepEqual(parsed?.deviceBinding, raw.deviceBinding)
  assert.deepEqual(mergeAccountSnapshot(undefined, { code: 'ok', snapshot: parsed!, elapsedMs: 0 }).snapshot?.deviceBinding, raw.deviceBinding)
  assert.equal(parseAccountSnapshot({ ...raw, deviceBinding: { state: 'bound', licenseId: null } }, 'me'), null)
})
for (const [status, code] of [[401, 'auth_required'], [403, 'forbidden'], [404, 'endpoint_unavailable'], [503, 'service_error']] as const) {
  test(`snapshot classifies HTTP ${status} as ${code}`, async () => {
    const result = await fetchAccountSnapshot('fixture', 'https://example.test', {}, 'me', { fetchImpl: async () => new Response('{}', { status }) })
    assert.equal(result.code, code)
  })
}
test('empty identity is confirmed success; unexpected credentials are stripped', async () => {
  const raw = { ...snapshot(), accessToken: 'must-not-escape' }
  const result = await fetchAccountSnapshot('fixture', 'https://example.test', {}, 'me', { fetchImpl: async (input, init) => {
    assert.equal(String(input), 'https://example.test/functions/v1/tui-account-snapshot')
    assert.equal(init?.method, 'POST')
    return Response.json(raw)
  } })
  assert.equal(result.code, 'ok')
  assert.equal(result.snapshot?.identity.status, 'empty')
  assert.ok(!JSON.stringify(result.snapshot).includes('must-not-escape'))
})
for (const [name, expected] of [['TimeoutError', 'timeout'], ['TypeError', 'network_error']] as const) {
  test(`snapshot distinguishes ${name}`, async () => {
    const result = await fetchAccountSnapshot('fixture', 'https://example.test', {}, 'me', { fetchImpl: async () => { throw Object.assign(new Error('private request must not be logged'), { name }) } })
    assert.equal(result.code, expected)
  })
}
test('malformed JSON and wrong owner fail as protocol errors', async () => {
  for (const body of ['not-json', JSON.stringify({ ...snapshot(), userId: 'other' })]) {
    const result = await fetchAccountSnapshot('fixture', 'https://example.test', {}, 'me', { fetchImpl: async () => new Response(body) })
    assert.equal(result.code, 'protocol_error')
  }
})
test('failed categories retain cache and timestamps, confirmed absence clears it', () => {
  const old = snapshot()
  old.identity = { status: 'ok', fetchedAt: 7, data: { stellarId: 'TS-QS-REAL', primaryDomain: 'QS', title: 'observer' } }
  const previous = { code: 'ok' as const, checkedAt: 10, snapshot: old }
  const failed = snapshot(); failed.identity = { status: 'service_error' }
  const merged = mergeAccountSnapshot(previous, { code: 'ok', snapshot: failed, elapsedMs: 1 })
  assert.equal(merged.snapshot?.identity.data?.stellarId, 'TS-QS-REAL')
  assert.equal(merged.snapshot?.identity.fetchedAt, 7)
  assert.equal(merged.snapshot?.identity.status, 'service_error')
  assert.equal(mergeAccountSnapshot(previous, { code: 'ok', snapshot: snapshot(), elapsedMs: 1 }).snapshot?.identity.data, null)
  assert.equal(mergeAccountSnapshot(previous, { code: 'auth_required', elapsedMs: 1 }).snapshot?.identity.data?.stellarId, 'TS-QS-REAL')
})
test('未确认的许可不得用官网镜像期限/空配额顶掉已确认值，也不得复活可恢复', () => {
  // 复现路径：授权服务不可用时，官网快照仍把**分区**标成 ok，只把该条降级为
  // `unconfirmed`，并把官网镜像的期限（可能已过期）与空配额放进载荷。分区可信
  // 不等于每条可信——整段替换会让上一次确认为真的到期时间与设备配额消失。
  const confirmed = snapshot()
  confirmed.entitlements = { status: 'ok', fetchedAt: 100, data: [
    { id: 'L1', plan: 'pro', name: '年度 Pro', expiresAt: 1_700_000_000_000, status: 'active', restorable: true, reason: 'ok', deviceLimit: 2, devicesUsed: 1 },
    { id: 'L2', plan: 'pro', name: '永久 Pro', expiresAt: null, status: 'active', restorable: true, reason: 'ok', deviceLimit: 1, devicesUsed: 1 },
    { id: 'L3', plan: 'basic', name: 'Basic', expiresAt: null, status: 'active', restorable: false, reason: 'ok', deviceLimit: null, devicesUsed: null },
  ] }
  const previous = { code: 'ok' as const, checkedAt: 100, snapshot: confirmed }
  const degraded = snapshot()
  degraded.entitlements = { status: 'ok', fetchedAt: 200, data: [
    { id: 'L1', plan: 'pro', name: '年度 Pro', expiresAt: 1_600_000_000_000, status: 'unconfirmed', restorable: false, reason: 'service_error', deviceLimit: null, devicesUsed: null },
    { id: 'L2', plan: 'pro', name: '永久 Pro', expiresAt: 1_600_000_000_000, status: 'unconfirmed', restorable: false, reason: 'service_error', deviceLimit: null, devicesUsed: null },
    { id: 'L4', plan: 'pro', name: '新许可', expiresAt: null, status: 'unconfirmed', restorable: false, reason: 'license_not_provisioned', deviceLimit: null, devicesUsed: null },
  ] }

  const merged = mergeAccountSnapshot(previous, { code: 'ok', snapshot: degraded, elapsedMs: 1 })
  const entries = merged.snapshot!.entitlements.data!
  assert.equal(entries.length, 3)
  const l1 = entries[0]!, l2 = entries[1]!, l4 = entries[2]!
  assert.equal(l1.expiresAt, 1_700_000_000_000, '已确认的到期时间必须保留，不能被镜像值顶掉')
  assert.equal(l1.deviceLimit, 2); assert.equal(l1.devicesUsed, 1)
  assert.equal(l1.status, 'unconfirmed', '本次的「未知」状态要留下')
  assert.equal(l1.reason, 'service_error')
  assert.equal(l1.restorable, false, '未知不得变成可恢复')
  assert.equal(l2.expiresAt, null, '确认过的 null（永久授权）也是确认值，不能被镜像日期顶掉')
  assert.equal(l2.deviceLimit, 1)
  assert.equal(l4.expiresAt, null, '没有已确认对应条目的，保持本次原样')
  assert.equal(l4.deviceLimit, null)
  assert.equal(merged.snapshot?.entitlements.fetchedAt, 200, '本次同步时刻照常前进')
})

test('a different owner cannot inherit cached data', () => {
  const other = snapshot(); other.userId = 'other'; other.identity = { status: 'service_error' }
  assert.equal(mergeAccountSnapshot({ code: 'ok', checkedAt: 1, snapshot: snapshot() }, { code: 'ok', snapshot: other, elapsedMs: 1 }).snapshot?.identity.data, undefined)
})
test('Basic or revoked grants cannot become restorable Pro', () => {
  for (const [plan, status] of [['basic', 'active'], ['pro', 'revoked']]) {
    const value = snapshot()
    value.entitlements.data = [{ id: 'license', plan, status, name: 'Plan', restorable: true, reason: 'ok', expiresAt: null, deviceLimit: 2, devicesUsed: 0 }] as AccountSnapshot['entitlements']['data']
    assert.equal(parseAccountSnapshot(value, 'me'), null)
  }
})


test('invalid nested profile fields fail closed and failed category bodies are discarded', () => {
 const raw=snapshot(); (raw.profile.data!.account as unknown as Record<string,unknown>).email={accessToken:'private-fixture'}
 assert.equal(parseAccountSnapshot(raw,'me'),null)
 raw.profile.status='service_error'
 const parsed=parseAccountSnapshot(raw,'me')
 assert.equal(parsed?.profile.data,undefined);assert.ok(!JSON.stringify(parsed).includes('private-fixture'))
})


test('the actual desktop login request explicitly selects counted client approval', async()=>{
 const {requestDeviceCode}=await import('../account.js')
 await requestDeviceCode({deviceFingerprint:'fixture-device',fetchImpl:async(_url,init)=>{
  assert.equal(JSON.parse(String(init?.body)).purpose,'client-login')
  return Response.json({deviceCode:'fixture',userCode:'fixture',verifyUrl:'https://example.test/auth/device',expiresIn:300,pollInterval:5})
 }})
})
