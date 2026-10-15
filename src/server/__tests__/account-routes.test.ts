/**
 * 账号路由契约（桌面端账号页经 sidecar 走 device flow）。
 *
 * 本测试锁住四件容易做错、且错了不会自己报错的事：
 *  1. **凭据不出 sidecar** —— poll 成功时 accessToken 落盘，但绝不回传 WebView。
 *     回传了也能跑通（页面照样显示已登录），代价是 Supabase session 进了
 *     渲染进程内存与 devtools，且前端与 CLI 出现两份真值。
 *  2. **轮询是单次 check**，不是 5 分钟长循环 —— 前端 rivetFetch 默认 15s 超时
 *     会把长循环切断（desktop/src/runtime/client.ts 的超时注释）。
 *  3. **登出只清 account.json**，不碰 provider 凭据 —— TokenStore 按 provider
 *     名分文件，登出顺手清掉用户的 codex 登录是真实可能犯的错。
 *  4. **`approved` 却缺 accessToken 视为异常**而非「成功但空」—— 否则空凭据
 *     落盘，用户下次启动发现自己「已登录」但什么都做不了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildAccountRoutes, type AccountApi } from '../account-routes.js'
import { TokenStore } from '../../auth/token-store.js'
import { readSecret, writeSecret, secretsPath } from '../../config/secrets-store.js'
import { __resetSecretCipherCache } from '../../auth/secure-store.js'
import {
  accountIdentityUrl,
  accountManageUrl,
  cachedAccountIdentity,
  cachedAccountProfile,
  isAccountIdentityStale,
  saveAccountIdentity,
  saveAccountProfile,
  type DeviceCreateResult,
  type DevicePollResult,
  type StellarIdentity,
} from '../../auth/account.js'
import type { ActivateAccountLicenseCode } from '../../auth/account-license.js'

import { readNativeDeviceFingerprint } from '../../auth/account-device.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

test('account partition is available before website metadata completes', async () => {
  const { home, cleanup } = makeHome()
  try {
    const credential = `fixture.${Buffer.from(JSON.stringify({ sub: 'current-owner' })).toString('base64url')}.fixture`
    new TokenStore(home, 'account').save({ accessToken: credential, expiresAt: Date.now() + 3600000 })
    const response = await routerFor(home)('GET', '/account/status', undefined, AUTH)
    assert.equal((response.body as {userId:string}).userId,'current-owner')
    assert.equal(JSON.stringify(response.body).includes(credential),false)
  } finally { cleanup() }
})

const DEVICE: DeviceCreateResult = {
  deviceCode: 'dc-1',
  userCode: 'UC-1234',
  verifyUrl: 'https://tianshuharness.com/auth/device?code=UC-1234',
  expiresIn: 300,
  pollInterval: 5,
}

/** 每个用例一个临时 RIVET_HOME —— 落盘断言读的是真实磁盘，不是桩的内存。 */
function makeHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'rivet-account-routes-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/**
 * 默认桩：网络面全假，落盘面用**真实** TokenStore/saveAccountToken
 * （只有真实落盘才能验证「凭据进文件、不进响应体」这条不变量）。
 */
function stubApi(over: Partial<AccountApi> = {}): AccountApi {
  return {
    requestDeviceCode: async () => DEVICE,
    checkDeviceOnce: async () => ({ status: 'pending' }),
    fetchAccountProfile: async () => null,
    accountStore: (home) => new TokenStore(home, 'account'),
    saveAccountToken: (store, poll) => {
      if (!poll.accessToken) throw new Error('saveAccountToken: missing accessToken')
      const data = {
        accessToken: poll.accessToken,
        refreshToken: poll.refreshToken,
        expiresAt: Date.now() + (poll.expiresIn ?? 3600) * 1000,
      }
      store.save(data)
      return data
    },
    // 星籍三条：读缓存的与 TTL 判定用**真实实现**（纯函数，桩掉就验不到 TTL 语义）；
    // 只有网络面（fetchStellarIdentity）默认回 null —— 由各用例按需覆写。
    fetchStellarIdentity: async () => null,
    saveAccountIdentity,
    cachedAccountIdentity,
    isAccountIdentityStale,
    // 账号资料（头像 + 创始铭牌）同规矩：缓存与写盘用真实实现，网络面默认回 null。
    fetchAccountProfileSnapshot: async () => null,
    saveAccountProfile,
    cachedAccountProfile,
    accountIdentityUrl,
    accountManageUrl,
    // 默认不可用：需要它的用例必须显式覆写，免得「忘了给桩却看起来跑通了」
    activateAccountLicense: async () => { throw new Error('activateAccountLicense: this case must stub it') },
    ...over,
  }
}

function routerFor(home: string, over: Partial<AccountApi> = {}) {
  return createRouter(buildAccountRoutes({ apiToken: TOKEN, account: stubApi(over), rivetHome: home }))
}

test('账号资料修改用已登录凭据写远端并刷新缓存，响应不泄露凭据', async () => {
  const { home, cleanup } = makeHome()
  try {
    const credential=`fixture.${Buffer.from(JSON.stringify({sub:'owner'})).toString('base64url')}.fixture`
    new TokenStore(home, 'account').save({ accessToken: credential, expiresAt: Date.now() + 3600000 })
    let changed = false
    const router = routerFor(home, { updateAccountProfile: async (access, input) => {
      assert.equal(access, credential); assert.equal(input.name, '新昵称'); changed = true; return { ok: true }
    }, fetchAccountProfile: async () => ({ userId: 'owner', email: null, displayName: '新昵称' }) })
    const response = await router('POST', '/account/profile', { name: '新昵称', avatar: null,expectedUserId:'owner' }, AUTH)
    assert.equal(response.status, 200); assert.equal(changed, true)
    assert.equal(JSON.stringify(response.body).includes(credential), false)
    assert.equal(cachedAccountProfile(new TokenStore(home, 'account').load())?.account?.displayName, '新昵称')
  } finally { cleanup() }
})

test('旧窗口的账号 A 资料不能写入后台已经切换的账号 B',async()=>{
 const {home,cleanup}=makeHome()
 try {
  const credential=`fixture.${Buffer.from(JSON.stringify({sub:'owner-B'})).toString('base64url')}.fixture`
  new TokenStore(home,'account').save({accessToken:credential,expiresAt:Date.now()+3600000})
  let writes=0
  const router=routerFor(home,{updateAccountProfile:async()=>{writes++;return {ok:true}}})
  const response=await router('POST','/account/profile',{name:'账号A的草稿',expectedUserId:'owner-A'},AUTH)
  assert.equal(response.status,409)
  assert.equal(writes,0)
  assert.equal(new TokenStore(home,'account').load()?.accessToken,credential)
 }finally{cleanup()}
})

test('登出期间完成的资料保存不恢复旧账号缓存', async () => {
  const { home, cleanup } = makeHome()
  try {
    const credential=`fixture.${Buffer.from(JSON.stringify({sub:'uid-1'})).toString('base64url')}.fixture`
    new TokenStore(home, 'account').save({ accessToken: credential, expiresAt: Date.now() + 3600000 })
    let release!: (value: { ok: boolean }) => void
    const pending = new Promise<{ ok: boolean }>(resolve => { release = resolve })
    const router = routerFor(home, { updateAccountProfile: async () => pending })
    const updating = router('POST', '/account/profile', { name: '新昵称', avatar: null,expectedUserId:'uid-1' }, AUTH)
    await new Promise(resolve => setTimeout(resolve, 10))
    await router('POST', '/account/logout', undefined, AUTH)
    release({ ok: true })
    assert.equal((await updating).status, 409)
    assert.equal(new TokenStore(home, 'account').load(), null)
  } finally { cleanup() }
})

test('所有账号路由都要 Bearer token——缺 token 一律 401', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home)
    for (const [method, path] of [
      ['POST', '/account/cancel'],
      ['POST', '/account/device'],
      ['POST', '/account/poll'],
      ['GET', '/account/status'],
      ['POST', '/account/identity/refresh'],
      ['POST', '/account/activate-device'],
      ['POST', '/account/logout'],
    ] as const) {
      const res = await router(method, path, {}, {})
      assert.equal(res.status, 401, `${method} ${path} 未鉴权`)
    }
  } finally {
    cleanup()
  }
})

test('POST /account/device 透传 userCode/verifyUrl/deviceCode 并带上设备名', async () => {
  const { home, cleanup } = makeHome()
  try {
    let seen: Record<string, unknown> | undefined
    const router = routerFor(home, {
      requestDeviceCode: async (opts) => {
        seen = opts as Record<string, unknown>
        return DEVICE
      },
    })
    const res = await router('POST', '/account/device', { deviceName: 'probe-host' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as DeviceCreateResult
    assert.equal(body.userCode, 'UC-1234')
    assert.equal(body.verifyUrl, DEVICE.verifyUrl)
    // deviceCode 是 RFC 8628 里给客户端的轮询凭据，必须回给前端（否则无法 poll）
    assert.equal(body.deviceCode, 'dc-1')
    assert.equal(seen?.deviceName, 'probe-host')
  } finally {
    cleanup()
  }
})

test('POST /account/poll 缺 deviceCode 是 400，不是静默 pending', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home)
    const res = await router('POST', '/account/poll', {}, AUTH)
    assert.equal(res.status, 400)
  } finally {
    cleanup()
  }
})

test('POST /account/poll 单次 check 后立即返回 pending——不长循环', async () => {
  const { home, cleanup } = makeHome()
  try {
    let calls = 0
    const router = routerFor(home, {
      checkDeviceOnce: async () => {
        calls++
        return { status: 'pending' }
      },
    })
    const started = Date.now()
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as DevicePollResult).status, 'pending')
    assert.equal(calls, 1, '路由必须自己单次 check（前端负责按 pollInterval 重发）')
    assert.ok(Date.now() - started < 1000, '单次 check 不得挂住')
  } finally {
    cleanup()
  }
})

test('POST /account/poll approved：token 落盘但绝不回传 WebView', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, {
      checkDeviceOnce: async () => ({
        status: 'approved',
        accessToken: 'AT-SECRET',
        refreshToken: 'RT-SECRET',
        expiresIn: 3600,
      }),
    })
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as DevicePollResult).status, 'approved')

    const serialized = JSON.stringify(res.body)
    assert.ok(!serialized.includes('AT-SECRET'), 'accessToken 不得出现在响应体（凭据不出 sidecar）')
    assert.ok(!serialized.includes('RT-SECRET'), 'refreshToken 不得出现在响应体')

    const saved = new TokenStore(home, 'account').load()
    assert.equal(saved?.accessToken, 'AT-SECRET', 'token 必须落盘，否则 CLI/TUI 读不到这次登录')
  } finally {
    cleanup()
  }
})

test('POST /account/poll pending 时不写盘——空凭据落盘会让下次启动谎报已登录', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, { checkDeviceOnce: async () => ({ status: 'pending' }) })
    await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(new TokenStore(home, 'account').load(), null)
  } finally {
    cleanup()
  }
})

test('POST /account/poll approved 却缺 accessToken → 5xx 且不写盘', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, { checkDeviceOnce: async () => ({ status: 'approved' }) })
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.ok(res.status >= 500, `缺凭据应是异常，得到 ${res.status}`)
    assert.equal(new TokenStore(home, 'account').load(), null)
  } finally {
    cleanup()
  }
})

test('GET /account/status 未登录 → loggedIn:false（不是 500）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const res = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as { loggedIn: boolean }).loggedIn, false)
  } finally {
    cleanup()
  }
})

test('GET /account/status 已登录 → loggedIn:true + 邮箱', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({
      accessToken: 'AT',
      expiresAt: Date.now() + 3600_000,
    })
    const router = routerFor(home, {
      fetchAccountProfile: async () => ({ email: 'qa-test@tianshuharness.com', userId: 'u-1' }),
    })
    const res = await router('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { loggedIn: boolean; email: string | null; userId: string | null }
    assert.equal(body.loggedIn, true)
    assert.equal(body.email, null, 'first response is local, network runs in background')
    await waitFor(() => Boolean(cachedAccountProfile(new TokenStore(home, 'account').load())?.account))
    const next = await router('GET', '/account/status', {}, AUTH)
    assert.equal((next.body as typeof body).email, 'qa-test@tianshuharness.com')
    assert.equal((next.body as typeof body).userId, 'u-1')
  } finally {
    cleanup()
  }
})

test('GET /account/status 拉不到 profile 时降级——离线不等于未登录', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    const router = routerFor(home, {
      fetchAccountProfile: async () => {
        throw new Error('network down')
      },
    })
    const res = await router('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { loggedIn: boolean; email: string | null }
    assert.equal(body.loggedIn, true)
    assert.equal(body.email, null)
  } finally {
    cleanup()
  }
})

test('POST /account/logout 清账号凭据，但不碰 provider 凭据', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT-ACCOUNT', expiresAt: Date.now() + 3600_000 })
    new TokenStore(home, 'codex').save({ accessToken: 'AT-CODEX', expiresAt: Date.now() + 3600_000 })

    const res = await routerFor(home)('POST', '/account/logout', {}, AUTH)
    assert.equal(res.status, 200)

    assert.equal(new TokenStore(home, 'account').load(), null, '登出必须清账号凭据')
    assert.equal(
      new TokenStore(home, 'codex').load()?.accessToken,
      'AT-CODEX',
      '登出天枢账号不得顺手清掉 provider 登录',
    )
  } finally {
    cleanup()
  }
})

test('退出天枢账号并重新授权保留模型配置、Key 池和可解密的 API Key，重启后也可读', async () => {
  const { home, cleanup } = makeHome()
  const previous = process.env.RIVET_TOKEN_STORE
  try {
    process.env.RIVET_TOKEN_STORE = 'local-key'
    const files = [join(home, 'config.json'), join(home, 'provider-keys.json')]
    writeFileSync(files[0]!, JSON.stringify({ provider: { default: 'custom', providers: { custom: { keyRef: 'model-key' } } } }))
    writeFileSync(files[1]!, JSON.stringify({ version: 1, providers: { custom: [{ id: 'key-1', keyRef: 'model-key', models: [{ id: 'fixture-model' }] }] } }))
    writeSecret('model-key', 'fixture-api-key', home)
    files.push(secretsPath(home))
    const before = files.map(file => readFileSync(file))
    new TokenStore(home, 'account').save({ accessToken: 'fixture-old-account', expiresAt: Date.now() + 3600000 })
    const route = routerFor(home, {
      checkDeviceOnce: async () => ({ status: 'approved', accessToken: 'fixture-new-account', expiresIn: 3600 }),
    })
    assert.equal((await route('POST', '/account/logout', {}, AUTH)).status, 200)
    assert.equal((await route('POST', '/account/device', {}, AUTH)).status, 200)
    assert.equal((await route('POST', '/account/poll', { deviceCode: DEVICE.deviceCode }, AUTH)).status, 200)
    assert.equal(new TokenStore(home, 'account').load()?.accessToken, 'fixture-new-account')
    files.forEach((file, i) => assert.deepEqual(readFileSync(file), before[i]))
    __resetSecretCipherCache()
    assert.equal(readSecret('model-key', home), 'fixture-api-key')
  } finally {
    if (previous === undefined) delete process.env.RIVET_TOKEN_STORE
    else process.env.RIVET_TOKEN_STORE = previous
    __resetSecretCipherCache()
    cleanup()
  }
})

// ── 星籍（Task 4.2）──────────────────────────────────────────────────────

const IDENTITY: StellarIdentity = { stellarId: 'TS-FU-AKKV7C', primaryDomain: 'FU', title: 'observer' }

/** 等后台刷新落地（它是 fire-and-forget，没有可 await 的把手）。有界轮询，不睡死。 */
async function waitFor(fn: () => boolean, ms = 500): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('POST /account/poll approved：星籍顺带落盘，且不出现在响应体', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, {
      checkDeviceOnce: async () => ({ status: 'approved', accessToken: 'AT-SECRET', expiresIn: 3600 }),
      fetchStellarIdentity: async () => IDENTITY,
    })
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(res.status, 200)
    assert.ok(!JSON.stringify(res.body).includes('TS-FU-AKKV7C'), '星籍不必进响应体（前端会再拉一次 status）')

    const saved = new TokenStore(home, 'account').load()
    assert.equal(saved?.accessToken, 'AT-SECRET', '星籍落盘不得抹掉 token')
    assert.equal(saved?.identity?.stellarId, 'TS-FU-AKKV7C')
    assert.equal(saved?.identity?.primaryDomain, 'FU')
  } finally {
    cleanup()
  }
})

test('POST /account/poll approved：星籍拉取失败/抛错都不影响登录结果', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, {
      checkDeviceOnce: async () => ({ status: 'approved', accessToken: 'AT-2', expiresIn: 3600 }),
      fetchStellarIdentity: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(res.status, 200, '星籍是装饰性信息，拿不到不该把登录判成失败')
    assert.equal((res.body as { status: string }).status, 'approved')
    assert.equal(new TokenStore(home, 'account').load()?.accessToken, 'AT-2')
    assert.equal(new TokenStore(home, 'account').load()?.identity, undefined)
  } finally {
    cleanup()
  }
})

test('GET /account/status：无缓存 → 三字段为 null，并在后台补缓存', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    const router = routerFor(home, { fetchStellarIdentity: async () => IDENTITY })

    const res = await router('GET', '/account/status', {}, AUTH)
    const body = res.body as { stellarId: string | null; primaryDomain: string | null; title: string | null }
    assert.equal(body.stellarId, null, '首次查询先回 null（不阻塞响应）')

    await waitFor(() => Boolean(new TokenStore(home, 'account').load()?.identity))
    assert.equal(new TokenStore(home, 'account').load()?.identity?.primaryDomain, 'FU')
  } finally {
    cleanup()
  }
})

test('GET /account/status：缓存新鲜 → 直接回三字段，不打网络', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    const token = { accessToken: 'AT', expiresAt: Date.now() + 3600_000 }
    store.save(token)
    saveAccountIdentity(store, token, IDENTITY)

    let calls = 0
    const router = routerFor(home, {
      fetchStellarIdentity: async () => {
        calls += 1
        return IDENTITY
      },
    })
    const res = await router('GET', '/account/status', {}, AUTH)
    const body = res.body as { stellarId: string | null; primaryDomain: string | null; title: string | null }
    assert.equal(body.stellarId, 'TS-FU-AKKV7C')
    assert.equal(body.primaryDomain, 'FU')
    assert.equal(body.title, 'observer')

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(calls, 0, '新鲜缓存不得触发网络——星籍一生只变一次，轮询纯浪费')
  } finally {
    cleanup()
  }
})

test('GET /account/status：缓存陈旧 → 立刻回旧值，后台刷新出新值', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    const token = { accessToken: 'AT', expiresAt: Date.now() + 3600_000 }
    store.save(token)
    // 直接写一条 fetchedAt 很旧的缓存（绕过 TTL）
    store.save({ ...token, identity: { ...IDENTITY, stellarId: 'TS-TS-OLD001', primaryDomain: 'TS', fetchedAt: 1 } })

    const router = routerFor(home, {
      fetchStellarIdentity: async () => IDENTITY,
    })
    const res = await router('GET', '/account/status', {}, AUTH)
    const body = res.body as { primaryDomain: string | null }
    assert.equal(body.primaryDomain, 'TS', '陈旧时先给旧值（stale-while-revalidate）')

    await waitFor(() => new TokenStore(home, 'account').load()?.identity?.primaryDomain === 'FU')
    assert.equal(new TokenStore(home, 'account').load()?.identity?.primaryDomain, 'FU', '后台应刷新出新星籍')
  } finally {
    cleanup()
  }
})

test('后台刷新不得用发起时的旧 token 覆盖期间的新登录（并发竞态）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    store.save({ accessToken: 'AT-OLD', expiresAt: Date.now() + 3600_000 })

    let release: (v: StellarIdentity | null) => void = () => {}
    const gate = new Promise<StellarIdentity | null>((r) => {
      release = r
    })
    const router = routerFor(home, { fetchStellarIdentity: () => gate })

    const res = await router('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)

    // 星籍还在路上时用户重新登录了（poll 写入了新 token）
    store.save({ accessToken: 'AT-NEW', expiresAt: Date.now() + 7200_000 })
    release(IDENTITY)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(
      store.load()?.accessToken,
      'AT-NEW',
      '旧 token + 星籍的写回会把刚登录的会话打回旧凭据（表现为「登录后又掉线」）',
    )
  } finally {
    cleanup()
  }
})

test('GET /account/status：带上官网星籍页 URL（供「在官网查看」）', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    const res = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal((res.body as { identityUrl: string }).identityUrl, accountIdentityUrl())
    assert.match(accountIdentityUrl(), /\/space\/identity$/)
  } finally {
    cleanup()
  }
})

test('GET /account/status：带上账号与授权页 URL（「设备与授权」区的入口目标）', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    const res = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal((res.body as { manageUrl: string }).manageUrl, accountManageUrl())
    // 路径锚定在 /space/account：文案刻意不承诺「管理设备」（官网解绑入口 Task 4.1 未做），
    // 但入口指向的页面必须是账号与授权页，不是星籍页——两者同基址，只有路径能区分。
    assert.match(accountManageUrl(), /\/space\/account$/)
  } finally {
    cleanup()
  }
})

test('GET /account/status：带上次同步时刻（有缓存才有，供界面解释"可能是旧的"）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    const token = { accessToken: 'AT', expiresAt: Date.now() + 3600_000 }
    store.save(token)

    // 无缓存 → null（不是 0，前端据此不渲染那一行）
    const before = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal((before.body as { identityFetchedAt: number | null }).identityFetchedAt, null)

    saveAccountIdentity(store, token, IDENTITY)
    const after = await routerFor(home)('GET', '/account/status', {}, AUTH)
    const at = (after.body as { identityFetchedAt: number | null }).identityFetchedAt
    assert.equal(typeof at, 'number')
    assert.ok((at ?? 0) > 0, '有缓存时应给出正的时间戳')
  } finally {
    cleanup()
  }
})

// ── 强制刷新（用户点了按钮，就该拿到结果或明确的失败）─────────────────────

test('POST /account/identity/refresh：未登录 401（不是悄悄回空）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const res = await routerFor(home)('POST', '/account/identity/refresh', {}, AUTH)
    assert.equal(res.status, 401)
  } finally {
    cleanup()
  }
})

test('POST /account/identity/refresh：成功 → refreshed:true 且落盘', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    // 先塞一条陈旧缓存，验证刷新真的换了值
    saveAccountIdentity(
      new TokenStore(home, 'account'),
      { accessToken: 'AT', expiresAt: Date.now() + 3600_000 },
      { stellarId: 'TS-TS-OLD001', primaryDomain: 'TS', title: 'observer' },
    )

    const router = routerFor(home, { fetchStellarIdentity: async () => IDENTITY })
    const res = await router('POST', '/account/identity/refresh', {}, AUTH)
    const body = res.body as { refreshed: boolean; stellarId: string; primaryDomain: string }
    assert.equal(body.refreshed, true)
    assert.equal(body.primaryDomain, 'FU')
    assert.equal(new TokenStore(home, 'account').load()?.identity?.primaryDomain, 'FU')
  } finally {
    cleanup()
  }
})

test('POST /account/identity/refresh：拉不到 → refreshed:false 并回缓存值（不谎报成功）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    const token = { accessToken: 'AT', expiresAt: Date.now() + 3600_000 }
    store.save(token)
    saveAccountIdentity(store, token, IDENTITY)

    const router = routerFor(home, { fetchStellarIdentity: async () => null })
    const res = await router('POST', '/account/identity/refresh', {}, AUTH)
    const body = res.body as { refreshed: boolean; primaryDomain: string | null }
    assert.equal(body.refreshed, false, '拉不到就必须如实说没刷上')
    assert.equal(body.primaryDomain, 'FU', '同时把手里那份旧值给出去，不显示空白')
  } finally {
    cleanup()
  }
})

test('POST /account/identity/refresh：刷新期间换了账号 → 不写盘（不把 A 的星籍挂到 B 上）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    store.save({ accessToken: 'AT-A', expiresAt: Date.now() + 3600_000 })

    let release: (v: StellarIdentity | null) => void = () => {}
    const gate = new Promise<StellarIdentity | null>((r) => {
      release = r
    })
    const router = routerFor(home, { fetchStellarIdentity: () => gate })

    const pending = router('POST', '/account/identity/refresh', {}, AUTH)
    store.save({ accessToken: 'AT-B', expiresAt: Date.now() + 3600_000 })
    release(IDENTITY)
    const res = await pending

    const body = res.body as { refreshed: boolean; stellarId: string | null }
    assert.equal(body.refreshed, false)
    assert.equal(body.stellarId, null)
    const after = store.load()
    assert.equal(after?.accessToken, 'AT-B')
    assert.equal(after?.identity, undefined, 'A 的星籍不许落到 B 的凭据上')
  } finally {
    cleanup()
  }
})

// ── 账号资料（头像 + 创始铭牌）─────────────────────────────────────────
//
// 与星籍同一套语义：缓存优先、陈旧后台刷新、没取到就回 null（不造空壳）。
// 桩只换网络面（fetchAccountProfileSnapshot），缓存与落盘走真实实现。

const FOUNDING_SNAPSHOT = { badgeCode: 'FOUNDER_TIER_1', rank: 7, tier: 1, total: 300, limit: 300 }

test('GET /account/status：回头像与创始铭牌（有缓存时）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    store.save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    saveAccountProfile(
      store,
      store.load()!,
      { avatarUrl: 'https://cdn.example/a.png', founding: FOUNDING_SNAPSHOT, fetchedAt: 0 },
      999,
    )

    const res = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as {
      avatarUrl: string | null
      founding: typeof FOUNDING_SNAPSHOT | null
      profileFetchedAt: number | null
    }
    assert.equal(body.avatarUrl, 'https://cdn.example/a.png')
    assert.equal(body.founding?.badgeCode, 'FOUNDER_TIER_1')
    assert.equal(body.founding?.rank, 7)
    assert.equal(body.profileFetchedAt, 999, '带上次同步时刻，让界面能解释"为什么这可能是旧的"')
  } finally {
    cleanup()
  }
})

test('GET /account/status：二档创始（有 rank 无 badge）原样透传，档位不丢', async () => {
  // 二/三档正是「位次分母恒 300」那条缺陷的唯一曝光面（消费侧见 desktop 的
  // founding-view）：路由只保证快照如实透传，不做任何档位推导。
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    store.save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    const tier2 = { badgeCode: null, rank: 450, tier: 2, total: 640, limit: 300 }
    saveAccountProfile(store, store.load()!, { avatarUrl: null, founding: tier2, fetchedAt: 0 }, 1)

    const res = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { founding: typeof tier2 | null }
    assert.equal(body.founding?.tier, 2, '档位由 sidecar 算好，路由不得吞掉')
    assert.equal(body.founding?.rank, 450, '位次是这条形状里唯一不可再生的信息')
    assert.equal(body.founding?.badgeCode, null, '缺徽章不等于非创始——不该整块消失')
  } finally {
    cleanup()
  }
})

test('GET /account/status：无资料缓存 → 两字段回 null，并在后台补缓存', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    const router = routerFor(home, {
      fetchAccountProfileSnapshot: async () => ({
        avatarUrl: 'https://cdn.example/b.png',
        founding: FOUNDING_SNAPSHOT,
        fetchedAt: 0,
      }),
    })

    const res = await router('GET', '/account/status', {}, AUTH)
    const body = res.body as { avatarUrl: string | null; founding: unknown }
    assert.equal(body.avatarUrl, null, '首次请求先给 null，不为装饰性信息多等一次网络')
    assert.equal(body.founding, null)

    await waitFor(() => new TokenStore(home, 'account').load()?.profile?.avatarUrl === 'https://cdn.example/b.png')
    const cached = new TokenStore(home, 'account').load()?.profile
    assert.equal(cached?.avatarUrl, 'https://cdn.example/b.png', '后台应把资料补进缓存')
    assert.equal(cached?.founding?.rank, 7)
  } finally {
    cleanup()
  }
})

test('GET /account/status：资料陈旧 → 先回旧值，后台刷新出新值', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    store.save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    // fetchedAt=1 直接写成"很旧"（绕过 TTL，不依赖测试运行时刻）
    saveAccountProfile(
      store,
      store.load()!,
      { avatarUrl: 'https://cdn.example/old.png', founding: null, fetchedAt: 1 },
      1,
    )

    const router = routerFor(home, {
      fetchAccountProfileSnapshot: async () => ({
        avatarUrl: 'https://cdn.example/new.png',
        founding: FOUNDING_SNAPSHOT,
        fetchedAt: 0,
      }),
    })
    const res = await router('GET', '/account/status', {}, AUTH)
    assert.equal((res.body as { avatarUrl: string | null }).avatarUrl, 'https://cdn.example/old.png', '陈旧时先给旧值')

    await waitFor(() => new TokenStore(home, 'account').load()?.profile?.avatarUrl === 'https://cdn.example/new.png')
    assert.equal(new TokenStore(home, 'account').load()?.profile?.avatarUrl, 'https://cdn.example/new.png')
  } finally {
    cleanup()
  }
})

test('POST /account/poll approved：账号资料顺带落盘，且响应体不含凭据', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, {
      checkDeviceOnce: async () => ({ status: 'approved', accessToken: 'AT-NEW', expiresIn: 3600 }),
      fetchAccountProfileSnapshot: async () => ({
        avatarUrl: 'https://cdn.example/c.png',
        founding: FOUNDING_SNAPSHOT,
        fetchedAt: 0,
      }),
    })
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(res.status, 200)

    const disk = new TokenStore(home, 'account').load()
    assert.equal(disk?.accessToken, 'AT-NEW', '凭据落盘')
    assert.equal(disk?.profile?.avatarUrl, 'https://cdn.example/c.png', '资料随登录顺带落盘')
    assert.equal(disk?.profile?.founding?.badgeCode, 'FOUNDER_TIER_1')
    assert.ok(!JSON.stringify(res.body).includes('AT-NEW'), '凭据不得进响应体（不变量）')
  } finally {
    cleanup()
  }
})

test('approved response does not wait for metadata; duplicate polls reuse the receipt', async () => {
  const { home, cleanup } = makeHome()
  let release!: (identity: StellarIdentity) => void, calls = 0
  const metadata = new Promise<StellarIdentity>(resolve => { release = resolve })
  try {
    const router = routerFor(home, {
      checkDeviceOnce: async () => { calls++; return { status: 'approved', accessToken: 'FAKE-NEW' } },
      fetchStellarIdentity: () => metadata,
      fetchAccountProfileSnapshot: async () => ({ avatarUrl: 'https://example.com/avatar.png', founding: null, fetchedAt: Date.now() }),
    })
    const response = await Promise.race([
      router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('approval blocked by metadata')), 250)),
    ])
    assert.equal((response.body as { status: string }).status, 'approved')
    assert.equal(new TokenStore(home, 'account').load()?.accessToken, 'FAKE-NEW')
    await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(calls, 1, 'a lost approved response must not consume the grant twice')
    release(IDENTITY); await waitFor(() => Boolean(new TokenStore(home, 'account').load()?.identity))
    const saved = new TokenStore(home, 'account').load()
    assert.equal(saved?.profile?.avatarUrl, 'https://example.com/avatar.png', 'both categories survive out-of-order writes')
    assert.equal(saved?.identity?.stellarId, IDENTITY.stellarId)
  } finally { release(IDENTITY); cleanup() }
})
test('logout or cancel while a poll is in flight prevents credential resurrection', async () => {
  for (const path of ['/account/logout', '/account/cancel']) {
    const { home, cleanup } = makeHome()
    let release!: (result: DevicePollResult) => void
    const pending = new Promise<DevicePollResult>(resolve => { release = resolve })
    try {
      const router = routerFor(home, { checkDeviceOnce: () => pending })
      const poll = router('POST', '/account/poll', { deviceCode: 'dc-old' }, AUTH)
      await Promise.resolve()
      await router('POST', path, {}, AUTH)
      release({ status: 'approved', accessToken: 'FAKE-OLD' })
      assert.equal(((await poll).body as { status: string }).status, 'expired')
      assert.equal(new TokenStore(home, 'account').load(), null)
    } finally { cleanup() }
  }
})
test('status returns immediately while offline, refreshes are deduplicated and persisted across restart', async () => {
  const { home, cleanup } = makeHome()
  let release!: (value: { email: string; userId: string; displayName: string }) => void, calls = 0
  const contact = new Promise<{ email: string; userId: string; displayName: string }>(resolve => { release = resolve })
  try {
    new TokenStore(home, 'account').save({ accessToken: 'FAKE', expiresAt: Date.now() + 3600_000 })
    const router = routerFor(home, { fetchAccountProfile: () => { calls++; return contact } })
    await Promise.race([Promise.all(Array.from({ length: 4 }, () => router('GET', '/account/status', {}, AUTH))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('status blocked by network')), 250))])
    assert.equal(calls, 1)
    release({ email: 'example@example.com', userId: 'fake-user', displayName: 'Stellar traveler' })
    await waitFor(() => Boolean(cachedAccountProfile(new TokenStore(home, 'account').load())?.account))
    const restarted = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal((restarted.body as { displayName: string }).displayName, 'Stellar traveler')
    assert.equal((restarted.body as { email: string }).email, 'example@example.com')
  } finally { cleanup() }
})

test('metadata finishing after identity preserves both star ID and account contact', async () => {
  const { home, cleanup } = makeHome()
  const profile = { avatarUrl: 'https://example.com/portrait.png', founding: null, fetchedAt: Date.now() }
  let release!: (value: typeof profile) => void
  const pendingProfile = new Promise<typeof profile>(resolve => { release = resolve })
  try {
    const router = routerFor(home, {
      checkDeviceOnce: async () => ({ status: 'approved', accessToken: 'FAKE-CREDENTIAL' }),
      fetchStellarIdentity: async () => IDENTITY,
      fetchAccountProfile: async () => ({ email: 'fixture@example.com', userId: 'fake-user' }),
      fetchAccountProfileSnapshot: () => pendingProfile,
    })
    await router('POST', '/account/poll', { deviceCode: 'dc-merge' }, AUTH)
    await waitFor(() => Boolean(cachedAccountProfile(new TokenStore(home, 'account').load())?.account))
    release(profile)
    await waitFor(() => new TokenStore(home, 'account').load()?.profile?.avatarUrl === profile.avatarUrl)
    const saved = new TokenStore(home, 'account').load()
    assert.equal(saved?.identity?.stellarId, IDENTITY.stellarId)
    assert.equal(cachedAccountProfile(saved)?.account?.email, 'fixture@example.com')
  } finally { release(profile); cleanup() }
})


test('expired device credentials rotate once before every identity request and survive restart', async () => {
  const {home,cleanup} = makeHome()
  try {
    const store = new TokenStore(home,'account')
    store.save({accessToken:'fake-expired',refreshToken:'fake-refresh',expiresAt:1})
    let rotations = 0
    const assertFresh = (access:string) => assert.equal(access,'fake-rotated')
    const router = routerFor(home, {
      refreshAccountToken: async value => { rotations++; assert.equal(value,'fake-refresh'); return {status:'approved',accessToken:'fake-rotated',refreshToken:'fake-next',expiresIn:3600} },
      fetchStellarIdentity: async access => {assertFresh(access);return IDENTITY},
      fetchAccountProfile: async access => {assertFresh(access);return {email:null,userId:'me',displayName:'官网昵称'}},
      fetchAccountProfileSnapshot: async access => {assertFresh(access);return {avatarUrl:null,founding:FOUNDING_SNAPSHOT,fetchedAt:Date.now(),unconfirmed:[]}},
    })
    await Promise.all(Array.from({length:4},()=>router('GET','/account/status',{},AUTH)))
    await waitFor(()=>store.load()?.profile?.founding?.rank === 7)
    assert.equal(rotations,1)
    const result = await router('GET','/account/status',{},AUTH)
    const body = result.body as {syncState:string;displayName:string;profileConfirmed:boolean}
    assert.equal(body.syncState,'cached')
    assert.equal(body.profileConfirmed,true)
    assert.equal(body.displayName,'官网昵称')
    assert.equal(store.load()?.refreshToken,'fake-next')
    assert.ok(!JSON.stringify(result.body).includes('fake-rotated'))
    const restart = await routerFor(home)('GET','/account/status',{},AUTH)
    assert.equal((restart.body as {founding:{rank:number}}).founding.rank,7)
  } finally {cleanup()}
})
test('partial identity fetch retries missing badges despite a successful contact cache', async () => {
  const {home,cleanup} = makeHome()
  const realNow = Date.now
  try {
    const store = new TokenStore(home,'account')
    store.save({accessToken:'fake',expiresAt:Date.now()+3600000})
    let badgeCalls=0
    const router=routerFor(home,{
      fetchStellarIdentity:async()=>IDENTITY,
      fetchAccountProfile:async()=>({email:null,userId:'me',displayName:'已登录'}),
      fetchAccountProfileSnapshot:async()=>++badgeCalls===1 ? null : {avatarUrl:null,founding:FOUNDING_SNAPSHOT,fetchedAt:Date.now(),unconfirmed:[]},
    })
    await router('POST','/account/identity/refresh',{},AUTH)
    const partial=await router('GET','/account/status',{},AUTH)
    assert.equal((partial.body as {syncState:string}).syncState,'partial')
    assert.equal((partial.body as {profileConfirmed:boolean}).profileConfirmed,false)
    const afterBackoff = realNow() + 31_000
    Date.now = () => afterBackoff
    await router('GET','/account/status',{},AUTH)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(badgeCalls,2,'contact fetchedAt must not hide a failed badge request for 24 hours')
    const complete=await router('GET','/account/status',{},AUTH)
    assert.equal((complete.body as {founding:{rank:number}}).founding.rank,7)
    assert.equal((complete.body as {syncState:string}).syncState,'cached')
  } finally {Date.now = realNow; cleanup()}
})
test('logout during device renewal never writes a late rotated credential', async () => {
  const {home,cleanup}=makeHome()
  const revoked: string[] = []
  let release!:(v:DevicePollResult)=>void
  try {
    const store=new TokenStore(home,'account')
    store.save({accessToken:'expired',refreshToken:'fake-refresh',expiresAt:1})
    const router=routerFor(home,{revokeAccountSession:async value=>{revoked.push(value);return true},refreshAccountToken:()=>new Promise(resolve=>{release=resolve})})
    const pending=router('POST','/account/identity/refresh',{},AUTH)
    await router('POST','/account/logout',{},AUTH)
    release({status:'approved',accessToken:'late',refreshToken:'late-refresh'})
    await pending
    assert.equal(store.load(),null)
    assert.deepEqual(revoked,['expired','late'])
  } finally {cleanup()}
})


test('real account API wiring accepts website device grants and projects verified founding identity', async () => {
  const {home,cleanup}=makeHome()
  const realFetch=globalThis.fetch
  const credential = `header.${Buffer.from(JSON.stringify({sub:'me',type:'access'})).toString('base64url')}.fake-signature`
  try {
    new TokenStore(home,'account').save({accessToken:'expired',refreshToken:'fake-refresh',expiresAt:1})
    let rotations=0
    globalThis.fetch=async input=>{
      const url=String(input)
      let body:unknown
      if(url.includes('tui-auth-refresh')) {rotations++;body={accessToken:credential,refreshToken:'fake-next',expiresIn:3600}}
      else if(url.includes('tui-account-snapshot')) body={version:1,userId:'me',profile:{status:'ok',fetchedAt:Date.now(),data:{avatarUrl:'https://example.com/avatar.png',founding:{badgeCode:'FOUNDER_TIER_2',rank:420,tier:2,total:1300,limit:300},account:{userId:'me',email:null,displayName:'\u5b98\u7f51\u672c\u4eba',username:'real-handle',joinedAt:'2026-09-03T00:00:00Z'}}},identity:{status:'ok',fetchedAt:Date.now(),data:{stellarId:'TS-QS-REAL42',primaryDomain:'QS',title:'observer'}},entitlements:{status:'ok',fetchedAt:Date.now(),data:[]}}
      else if(url.includes('/auth/v1/user')) return new Response('{}',{status:403})
      else if(url.includes('/profiles')) body=[{id:'me',display_name:'官网本人',username:'real-handle',avatar_url:'https://example.com/avatar.png',created_at:'2026-09-03T00:00:00Z'}]
      else if(url.includes('/stellar_identities')) body=[{user_id:'me',stellar_id:'TS-QS-REAL42',primary_domain:'QS',title:'observer'}]
      else if(url.includes('/user_badges')) body=[{badge_code:'FOUNDER_TIER_2'}]
      else if(url.includes('get_my_founder_rank')) body={is_founder:true,rank:420,total:1300}
      else throw new Error('unexpected account endpoint')
      return new Response(JSON.stringify(body))
    }
    const router=createRouter(buildAccountRoutes({apiToken:TOKEN,rivetHome:home,noProxy:'*'}))
    const refresh=await router('POST','/account/identity/refresh',{},AUTH)
    assert.equal((refresh.body as {complete:boolean}).complete,true)
    assert.equal(rotations,1,'default API must actually consume the renewal method')
    const status=await router('GET','/account/status',{},AUTH)
    const body=status.body as {displayName:string;stellarId:string;syncState:string;founding:{rank:number;tier:number}}
    assert.equal(body.displayName,'官网本人')
    assert.equal(body.stellarId,'TS-QS-REAL42')
    assert.equal(body.syncState,'cached')
    assert.equal(body.founding.tier,2)
    assert.equal(body.founding.rank,420)
    assert.ok(!JSON.stringify(status.body).includes(credential))
  } finally {globalThis.fetch=realFetch;cleanup()}
})
test('account replacement during renewal retains the new owner and discards the late rotation', async () => {
  const {home,cleanup}=makeHome()
  let release!:(v:DevicePollResult)=>void
  try {
    const store=new TokenStore(home,'account')
    store.save({accessToken:'expired-A',refreshToken:'fake-refresh-A',expiresAt:1})
    const router=routerFor(home,{refreshAccountToken:()=>new Promise(resolve=>{release=resolve})})
    const pending=router('POST','/account/identity/refresh',{},AUTH)
    store.save({accessToken:'account-B',expiresAt:Date.now()+3600000})
    release({status:'approved',accessToken:'late-A',refreshToken:'late-refresh-A'})
    await pending
    assert.equal(store.load()?.accessToken,'account-B')
  } finally {cleanup()}
})


test('desktop fingerprint survives the actual sidecar device request and repeated login', async () => {
  const { home, cleanup } = makeHome()
  const sent: string[] = []
  try {
    const native = readNativeDeviceFingerprint() ?? 'native-device-001'
    const router = routerFor(home, { requestDeviceCode: async opts => { sent.push(opts.deviceFingerprint ?? ''); return DEVICE } })
    assert.equal((await router('POST', '/account/device', { deviceFingerprint: native }, AUTH)).status, 200)
    assert.equal((await router('POST', '/account/device', {}, AUTH)).status, 200)
    assert.equal(sent.length,2);assert.equal(sent.every(value=>value===native),true)
    assert.equal((await router('POST', '/account/device', { deviceFingerprint: '../bad' }, AUTH)).status, 400)
  } finally { cleanup() }
})

 test('cancel invalidates the remote code; logout revokes only this session and still clears offline', async () => {
  const { home, cleanup } = makeHome()
  const cancelled: string[] = [], revoked: string[] = []
  try {
    const route = routerFor(home, { cancelDeviceCode: async code => { cancelled.push(code); return true }, revokeAccountSession: async value => { revoked.push(value); throw new Error('offline') } })
    await route('POST', '/account/device', {}, AUTH)
    await route('POST', '/account/cancel', {}, AUTH)
    assert.deepEqual(cancelled, [DEVICE.deviceCode])
    new TokenStore(home, 'account').save({ accessToken: 'session-fixture', expiresAt: Date.now()+3600000 })
    const result = await route('POST', '/account/logout', {}, AUTH)
    assert.deepEqual(revoked, ['session-fixture'])
    assert.equal((result.body as {remoteRevoked:boolean}).remoteRevoked, false)
    assert.equal(new TokenStore(home, 'account').load(), null)
  } finally { cleanup() }
 })

test('late consumed approval after cancellation revokes the returned remote session', async () => {
 const {home,cleanup}=makeHome()
 let release!: (value:DevicePollResult)=>void
 const revoked:string[]=[]
 try {
  const route=routerFor(home,{checkDeviceOnce:()=>new Promise(resolve=>{release=resolve}),revokeAccountSession:async value=>{revoked.push(value);return true}})
  const polling=route('POST','/account/poll',{deviceCode:'pending-fixture'},AUTH)
  await route('POST','/account/cancel',{},AUTH)
  release({status:'approved',accessToken:'late-session-fixture'})
  await polling
  assert.deepEqual(revoked,['late-session-fixture'])
  assert.equal(new TokenStore(home,'account').load(),null)
 } finally {cleanup()}
})


test('real routes expose snapshot errors without clearing identity or mistaking an expired session for offline', async()=> {
  const {home,cleanup}=makeHome()
  try {
    const store=new TokenStore(home,'account')
    const credential=`fixture.${Buffer.from(JSON.stringify({sub:'sync-owner'})).toString('base64url')}.fixture`
    store.save({accessToken:credential,expiresAt:Date.now()+3600000})
    saveAccountIdentity(store,store.load()!,{stellarId:'TS-QS-CACHED',primaryDomain:'QS',title:'observer'})
    for (const code of ['auth_required','forbidden','network_error','timeout','service_error','endpoint_unavailable','protocol_error'] as const) {
      const router=routerFor(home,{fetchAccountSnapshot:async()=>({code,elapsedMs:1})})
      const refreshed=await router('POST','/account/identity/refresh',{},AUTH)
      assert.equal((refreshed.body as {code:string}).code,code)
      const state=(await router('GET','/account/status',undefined,AUTH)).body as Record<string,unknown>
      assert.equal(state.stellarId,'TS-QS-CACHED')
      assert.equal(state.authStatus,code==='auth_required'?'reauth_required':'unverified')
      assert.equal(state.syncCode,code);assert.ok(!JSON.stringify(state).includes(credential))
    }
  } finally {cleanup()}
})
test('a confirmed empty snapshot clears only the identity and is a successful synchronized Basic account',async()=> {
 const {home,cleanup}=makeHome()
 try {
  const store=new TokenStore(home,'account'); store.save({accessToken:'fixture',expiresAt:Date.now()+3600000})
  saveAccountIdentity(store,store.load()!,{stellarId:'old',primaryDomain:'QS',title:'observer'})
  const at=Date.now()
  const router=routerFor(home,{fetchAccountSnapshot:async()=>({code:'ok',elapsedMs:0,snapshot:{version:1,userId:'owner',profile:{status:'ok',fetchedAt:at,data:{avatarUrl:null,founding:null,fetchedAt:at,account:{userId:'owner',email:null,displayName:'Basic member'}}},identity:{status:'empty',fetchedAt:at,data:null},entitlements:{status:'ok',fetchedAt:at,data:[]}}})})
  const res=await router('POST','/account/identity/refresh',{},AUTH); assert.equal((res.body as {complete:boolean}).complete,true)
  const state=(await router('GET','/account/status',undefined,AUTH)).body as Record<string,unknown>
  assert.equal(state.stellarId,null);assert.equal(state.avatarUrl,null);assert.equal(state.founding,null);assert.equal(state.authStatus,'authenticated');assert.deepEqual(state.entitlements,[])
 } finally {cleanup()}
})

// ── 设备许可恢复：凭据消费收回 sidecar（2026-10-06 P0）─────────────────────
//
// `account.json` 自 v3.21.1 起是 AES-256-GCM 密文信封（`secure-store.ts`
// encodeSecret）。桌面壳曾按明文 JSON 取顶层 `accessToken`，于是「恢复 Pro
// 激活」在默认安装下恒返回 auth_required（记于
// `.rivet/plans/账户激活-p0-修复-把凭据消费收回-sidecar.md`）。凭据消费因此
// 收到这里：sidecar 解密取凭据 → 调官网 EF → 只把签名后的 grant 交出去。

test('POST /account/activate-device 从密文信封取凭据代跑恢复，响应体不含凭据', async () => {
  const { home, cleanup } = makeHome()
  try {
    const credential = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner-1' })).toString('base64url')}.fixture`
    // 真实 TokenStore：写的是密文信封，走的是真解密路径——「拿得到凭据」这件事
    // 只有真实落盘 + 真解密能证，桩掉就恰好漏掉本次 P0 的格式契约。
    new TokenStore(home, 'account').save({ accessToken: credential, expiresAt: Date.now() + 3600000 })
    let seen: { accessToken: string; licenseId: string; deviceId: string } | undefined
    const router = routerFor(home, {
      activateAccountLicense: async (accessToken, licenseId, deviceId) => {
        seen = { accessToken, licenseId, deviceId }
        return { code: 'ok', grant: 'signed-grant' }
      },
    })
    const res = await router('POST', '/account/activate-device', { licenseId: 'lic-1', deviceId: 'machine-uid-1' }, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as { grant: string }).grant, 'signed-grant')
    // 信封确实被解开：解出来的凭据到了调用点，设备指纹与许可号也透传了
    assert.equal(seen?.accessToken, credential)
    assert.equal(seen?.licenseId, 'lic-1')
    assert.equal(seen?.deviceId, 'machine-uid-1')
    assert.equal(JSON.stringify(res.body).includes(credential), false, '凭据不许回传')
  } finally { cleanup() }
})

test('POST /account/activate-device 未登录是 401 auth_required，不打官网', async () => {
  const { home, cleanup } = makeHome()
  try {
    let called = 0
    const router = routerFor(home, {
      activateAccountLicense: async () => { called++; return { code: 'ok', grant: 'signed-grant' } },
    })
    const res = await router('POST', '/account/activate-device', { licenseId: 'lic-1', deviceId: 'machine-uid-1' }, AUTH)
    assert.equal(res.status, 401)
    assert.equal((res.body as { error: string }).error, 'auth_required')
    assert.equal(called, 0, '没有凭据就不该发请求')
  } finally { cleanup() }
})

test('POST /account/activate-device 请求期间账号被替换：迟到的 grant 不返回', async () => {
  const { home, cleanup } = makeHome()
  try {
    const store = new TokenStore(home, 'account')
    store.save({ accessToken: 'fixture-original', expiresAt: Date.now() + 3600000 })
    const router = routerFor(home, {
      activateAccountLicense: async () => {
        // 请求在途时换号（或登出）——旧壳侧守卫是这条不变量的家，现在它在 sidecar
        store.save({ accessToken: 'fixture-replacement', expiresAt: Date.now() + 3600000 })
        return { code: 'ok', grant: 'late-grant' }
      },
    })
    const res = await router('POST', '/account/activate-device', { licenseId: 'lic-1', deviceId: 'machine-uid-1' }, AUTH)
    assert.equal(res.status, 409)
    assert.equal((res.body as { error: string }).error, 'account_changed')
    assert.equal(JSON.stringify(res.body).includes('late-grant'), false)
  } finally { cleanup() }
})

test('POST /account/activate-device 官网失败码原样透出，不混成服务不可用', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'fixture', expiresAt: Date.now() + 3600000 })
    const cases: [ActivateAccountLicenseCode, number][] = [
      ['auth_required', 401],
      ['endpoint_unavailable', 404],
      ['activation_limit_reached', 403],
      ['device_mismatch', 403],
      ['license_not_owned', 403],
      ['network_error', 502],
      ['timeout', 502],
      ['protocol_error', 502],
      ['service_error', 502],
    ]
    for (const [code, status] of cases) {
      const router = routerFor(home, { activateAccountLicense: async () => ({ code }) })
      const res = await router('POST', '/account/activate-device', { licenseId: 'lic-1', deviceId: 'machine-uid-1' }, AUTH)
      assert.equal(res.status, status, `${code} 的状态码`)
      assert.equal((res.body as { error: string }).error, code)
    }
  } finally { cleanup() }
})

test('POST /account/activate-device 许可号或设备指纹非法是 400，不打官网', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'fixture', expiresAt: Date.now() + 3600000 })
    let called = 0
    const router = routerFor(home, {
      activateAccountLicense: async () => { called++; return { code: 'ok', grant: 'signed-grant' } },
    })
    for (const body of [{}, { licenseId: '' , deviceId: 'machine-uid-1' }, { licenseId: 'x'.repeat(129), deviceId: 'machine-uid-1' }, { licenseId: 'lic-1', deviceId: 'bad id' }, { licenseId: 'lic-1' }]) {
      const res = await router('POST', '/account/activate-device', body, AUTH)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
    assert.equal(called, 0)
  } finally { cleanup() }
})
