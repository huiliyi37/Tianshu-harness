/**
 * 天枢账号 device flow 客户端（CLI / TUI 侧）。
 *
 * ## 为什么另写一个而不是复用 src/auth/device-flow.ts
 * `device-flow.ts` 是按 RFC 8628 通用形状解析的——读 `raw.device_code` /
 * `raw.user_code` / `raw.verification_uri`（snake_case）。而官网 EF
 * `tui-auth-create` 返回的是**驼峰**：
 *   {"deviceCode":"…","userCode":"…","expiresIn":300,"pollInterval":5,"verifyUrl":"…"}
 * 照搬那套解析会静默拿到 undefined，用户看到「登录中」永远转圈。
 * 2026-09-14 实测线上 EF 响应确认（部署后 verifyUrl 已是 tianshuharness.com/auth/device）。
 *
 * 运行：npm exec -- tsx --test src/auth/__tests__/account.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cancelDeviceCode,
  revokeAccountSession,
  parseDeviceCreate,
  parseDevicePoll,
  isTerminalPollStatus,
  accountStore,
  saveAccountToken,
  deviceAuthorizeUrl,
  requestDeviceCode,
  fetchStellarIdentity,
  parseStellarIdentity,
  saveAccountIdentity,
  cachedAccountIdentity,
  isAccountIdentityStale,
  jwtSubject,
  ACCOUNT_IDENTITY_TTL_MS,
  fetchAccountProfile,
  refreshAccountToken,
  fetchAccountAvatar,
  fetchFoundingBadge,
  fetchAccountProfileSnapshot,
  saveAccountProfile,
  cachedAccountProfile,
} from '../account.js'

// ── 解析契约 ─────────────────────────────────────────────────────────────

test('解析官网 EF 的驼峰响应', () => {
  const r = parseDeviceCreate({
    deviceCode: 'dc-abc123',
    userCode: '483920',
    expiresIn: 300,
    pollInterval: 5,
    verifyUrl: 'https://tianshuharness.com/auth/device',
  })
  assert.equal(r.deviceCode, 'dc-abc123')
  assert.equal(r.userCode, '483920')
  assert.equal(r.expiresIn, 300)
  assert.equal(r.pollInterval, 5)
  assert.equal(r.verifyUrl, 'https://tianshuharness.com/auth/device')
})

test('缺 deviceCode 或 userCode 时抛错，不返回半成品', () => {
  assert.throws(() => parseDeviceCreate({ userCode: '483920', verifyUrl: 'x' }), /deviceCode/)
  assert.throws(() => parseDeviceCreate({ deviceCode: 'dc-1', verifyUrl: 'x' }), /userCode/)
  assert.throws(() => parseDeviceCreate({ deviceCode: 'dc-1', userCode: '1' }), /verifyUrl/)
})

test('轮询状态：pending 无 token、approved 带 token', () => {
  const pending = parseDevicePoll({ status: 'pending' })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.accessToken, undefined)

  const ok = parseDevicePoll({
    status: 'approved',
    accessToken: 'at-xyz',
    refreshToken: 'rt-xyz',
    expiresIn: 3600,
  })
  assert.equal(ok.status, 'approved')
  assert.equal(ok.accessToken, 'at-xyz')
  assert.equal(ok.refreshToken, 'rt-xyz')
  assert.equal(ok.expiresIn, 3600)
})

test('approved 但缺 accessToken 视为异常，不写入空凭据', () => {
  assert.throws(() => parseDevicePoll({ status: 'approved' }), /accessToken/)
})

test('终态判定：denied / expired / already_consumed 都要停下来', () => {
  assert.equal(isTerminalPollStatus('denied'), true)
  assert.equal(isTerminalPollStatus('expired'), true)
  assert.equal(isTerminalPollStatus('already_consumed'), true)
  assert.equal(isTerminalPollStatus('error'), true)
  assert.equal(isTerminalPollStatus('pending'), false)
  assert.equal(isTerminalPollStatus('approved'), false)
})

// ── 落盘 ─────────────────────────────────────────────────────────────────

test('账号 token 落到 <RIVET_HOME>/account.json，权限 0600', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-acct-'))
  try {
    const store = accountStore(home)
    const saved = saveAccountToken(store, {
      status: 'approved',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresIn: 3600,
    })

    assert.equal(saved.accessToken, 'at-1')
    assert.equal(saved.refreshToken, 'rt-1')
    assert.ok(saved.expiresAt > Date.now(), 'expiresAt 应是从现在起算的未来时间')

    // 文件名必须是 account.json —— 与 provider 的 <provider>.json 区分开，
    // 否则会覆盖掉同名的 provider 凭据。
    // 内容自 v3.21.1 起是 AES-256-GCM 信封（向量⑥ 加固）：断言的是**明文不再
    // 落盘**这一安全性质，而不是具体格式——格式演进不该让安全断言失效。
    const raw = readFileSync(join(home, 'account.json'), 'utf8')
    assert.ok(!raw.includes('at-1'), 'accessToken 不允许明文落盘')
    assert.ok(!raw.includes('rt-1'), 'refreshToken 不允许明文落盘')
    const envelope = JSON.parse(raw) as { v?: number; s?: string }
    assert.equal(envelope.v, 1, '应是带版本号的密文信封')
    assert.equal(envelope.s, 'aes-256-gcm')

    // POSIX 纵深防御（0600）仅 POSIX 适用——Windows 无 POSIX mode 语义
    // （NTFS 由 ACL 决定访问控制），凭据层由 DPAPI 托管密钥保护。
    if (process.platform !== 'win32') {
      const mode = statSync(join(home, 'account.json')).mode & 0o777
      assert.equal(mode, 0o600, `凭据文件权限应为 0600，实际 ${mode.toString(8)}`)
    }

    // 能读回来
    assert.equal(store.load()?.accessToken, 'at-1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('信封顶层没有 accessToken——任何按明文解析凭据文件的消费方必然读不到', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-acct-'))
  try {
    const store = accountStore(home)
    saveAccountToken(store, { status: 'approved', accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600 })

    // 格式契约（`secure-store.ts` encodeSecret）：密文信封顶层只有 v/s/b/d。
    // 这条断言把「谁可以消费凭据」写实——读取只可能发生在持有 TokenStore
    // 的 Node 侧（sidecar / CLI）。曾有一个 Rust 壳按 `data.get("accessToken")`
    // 读这个文件，于是「恢复 Pro 激活」在默认安装下恒返回 auth_required
    // （2026-10-06，桌面端 P0）；格式演进时这条会先红，别再让第二个消费方踩进来。
    const envelope = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(envelope).sort(), ['b', 'd', 's', 'v'])
    assert.equal(envelope.accessToken, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('saveAccountToken 拒绝没有 token 的轮询结果', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-acct-'))
  try {
    const store = accountStore(home)
    assert.throws(() => saveAccountToken(store, { status: 'pending' }), /accessToken/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 授权链接 ─────────────────────────────────────────────────────────────

test('设备授权链接补上 userCode——裸基址会让授权页停在「缺少授权码」', () => {
  // 页面契约（官网 DeviceAuthorizeView.vue）：从 route.query.code 读设备码，
  // 读不到就进 no-code 态，文案是「请从终端或桌面端的提示里复制完整链接，
  // 或在地址后补上 ?code= 参数」——即客户端该给出完整链接。
  // 而 EF 的 verifyUrl 是可配置的页面基址、不带 code（2026-09-14 实测线上响应：
  // {"verifyUrl":"https://tianshuharness.com/auth/device"}）。
  assert.equal(
    deviceAuthorizeUrl('https://tianshuharness.com/auth/device', '483920'),
    'https://tianshuharness.com/auth/device?code=483920',
  )
  // 基址已带 query 时用 & 续接——拼出两个 ? 会让页面读不到 code
  assert.equal(
    deviceAuthorizeUrl('https://x.dev/auth/device?lang=zh', '483920'),
    'https://x.dev/auth/device?lang=zh&code=483920',
  )
})

test('requestDeviceCode 返回的 verifyUrl 可直接打开（已含 code）', async () => {
  const created = await requestDeviceCode({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          deviceCode: 'dc-1',
          userCode: '483920',
          expiresIn: 300,
          pollInterval: 5,
          verifyUrl: 'https://tianshuharness.com/auth/device',
        }),
        { status: 200 },
      ),
  })
  assert.equal(created.verifyUrl, 'https://tianshuharness.com/auth/device?code=483920')
  assert.equal(created.userCode, '483920')
})

test('客户端登录请求明确要求持久设备绑定，不复用论坛免绑定用途', async () => {
  let purpose: unknown
  await requestDeviceCode({ deviceFingerprint: 'hardware-fixture', fetchImpl: async (_url, init) => {
    purpose = JSON.parse(String(init?.body)).purpose
    return new Response(JSON.stringify({ deviceCode: 'fixture', userCode: '123456', verifyUrl: 'https://tianshuharness.com/auth/device' }))
  } })
  assert.equal(purpose, 'client-login')
})

// ── 星籍（stellar identity）──────────────────────────────────────────────

/** 造一个形状正确的 access token（只填 sub，够 jwtSubject 用）。 */
function tokenFor(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub, role: 'authenticated' }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.sig`
}

test('jwtSubject 解出 sub；坏 token 回 null 而不是抛', () => {
  assert.equal(jwtSubject(tokenFor('u-42')), 'u-42')
  assert.equal(jwtSubject('not-a-jwt'), null)
  assert.equal(jwtSubject('a.@@@notbase64@@@.c'), null)
  assert.equal(jwtSubject(''), null)
})

test('parseStellarIdentity：缺字段回 null，title 缺省 observer', () => {
  assert.deepEqual(
    parseStellarIdentity({ stellar_id: 'TS-FU-AKKV7C', primary_domain: 'FU', title: 'observer' }),
    { stellarId: 'TS-FU-AKKV7C', primaryDomain: 'FU', title: 'observer' },
  )
  // PostgREST 返回的是数组——取第一行
  assert.deepEqual(
    parseStellarIdentity([{ stellar_id: 'TS-FU-AKKV7C', primary_domain: 'FU' }]),
    { stellarId: 'TS-FU-AKKV7C', primaryDomain: 'FU', title: 'observer' },
  )
  assert.equal(parseStellarIdentity([]), null, '空结果（没有星籍）不是错误，但也没有身份')
  assert.equal(parseStellarIdentity({ primary_domain: 'FU' }), null, '缺 stellar_id')
  assert.equal(parseStellarIdentity({ stellar_id: 'TS-FU-AKKV7C' }), null, '缺 primary_domain')
  assert.equal(parseStellarIdentity(null), null)
})

test('fetchStellarIdentity：RLS 放行时取回本人星籍', async () => {
  let seen = ''
  const identity = await fetchStellarIdentity(tokenFor('u-42'), {
    fetchImpl: async (input) => {
      seen = String(input)
      return new Response(
        JSON.stringify([
          { user_id: 'u-42', stellar_id: 'TS-FU-AKKV7C', primary_domain: 'FU', title: 'observer' },
        ]),
        { status: 200 },
      )
    },
  })
  assert.deepEqual(identity, { stellarId: 'TS-FU-AKKV7C', primaryDomain: 'FU', title: 'observer' })
  assert.match(seen, /\/rest\/v1\/stellar_identities/)
})

test('fetchStellarIdentity：返回行不属于本人 → 拒绝（策略改宽也不显示别人的星籍）', async () => {
  const identity = await fetchStellarIdentity(tokenFor('u-42'), {
    fetchImpl: async () =>
      new Response(JSON.stringify([{ user_id: 'someone-else', stellar_id: 'TS-TS-XXXXXX', primary_domain: 'TS' }]), {
        status: 200,
      }),
  })
  assert.equal(identity, null)
})

test('fetchStellarIdentity：401 / 空结果 / 网络异常一律回 null，不抛', async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => new Response('{"message":"invalid claim"}', { status: 401 }),
    async () => new Response('[]', { status: 200 }),
    async () => {
      throw new Error('ECONNRESET')
    },
  ]
  for (const impl of cases) {
    const got = await fetchStellarIdentity(tokenFor('u-42'), { fetchImpl: impl })
    assert.equal(got, null)
  }
})

test('saveAccountIdentity 以 token 为底展开——部分写不会抹掉 accessToken', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-acct-identity-'))
  try {
    const store = accountStore(home)
    const token = saveAccountToken(store, {
      status: 'approved',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
    })

    saveAccountIdentity(store, token, { stellarId: 'TS-FU-AKKV7C', primaryDomain: 'FU', title: 'observer' }, 1000)

    const back = store.load()
    assert.equal(back?.accessToken, 'at-1', 'accessToken 必须还在——save() 是全量写')
    assert.equal(back?.refreshToken, 'rt-1')
    assert.deepEqual(back?.identity, {
      stellarId: 'TS-FU-AKKV7C',
      primaryDomain: 'FU',
      title: 'observer',
      fetchedAt: 1000,
    })
    // 登出后身份不留孤儿
    store.clear()
    assert.equal(store.load(), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('cachedAccountIdentity 与 TTL：坏数据回 null，过期判 stale', () => {
  assert.equal(cachedAccountIdentity(null), null)
  assert.equal(cachedAccountIdentity({ accessToken: 'x', expiresAt: 0 }), null, '旧文件无 identity 字段')
  assert.equal(
    cachedAccountIdentity({ accessToken: 'x', expiresAt: 0, identity: { stellarId: '', primaryDomain: 'FU', title: 'observer', fetchedAt: 1 } }),
    null,
    'stellarId 为空串视为无缓存',
  )

  const cached = cachedAccountIdentity({
    accessToken: 'x',
    expiresAt: 0,
    identity: { stellarId: 'TS-FU-AKKV7C', primaryDomain: 'FU', title: 'observer', fetchedAt: 1000 },
  })
  assert.deepEqual(cached, {
    identity: { stellarId: 'TS-FU-AKKV7C', primaryDomain: 'FU', title: 'observer' },
    fetchedAt: 1000,
  })

  assert.equal(isAccountIdentityStale(1000, 1000 + ACCOUNT_IDENTITY_TTL_MS - 1), false)
  assert.equal(isAccountIdentityStale(1000, 1000 + ACCOUNT_IDENTITY_TTL_MS + 1), true)
  assert.equal(isAccountIdentityStale(0, Date.now()), true, 'fetchedAt 缺失视为陈旧')
})


// ── 账号资料快照（头像 + 创始铭牌）──────────────────────────────────────
//
// 数据源与星籍同通道（PostgREST + 用户 JWT，RLS 收口本人）。桩按 URL 分发，
// 把"打哪个端点、回什么形状"显式写出来——这样 RPC 形状变化时测试会明确报错，
// 而不是让线上的陌生形状静默变成"没有铭牌"。

/** 按 URL 子串分发的 fetch 桩。 */
function routedFetch(routes: { match: string; body?: unknown; status?: number; throws?: boolean }[]): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input)
    const hit = routes.find((r) => url.includes(r.match))
    if (!hit) return new Response('[]', { status: 404 })
    if (hit.throws) throw new Error('network down')
    return new Response(JSON.stringify(hit.body ?? null), { status: hit.status ?? 200 })
  }) as unknown as typeof fetch
}

/** 构造一个 payload 带 sub 的 JWT 形状串（只用于对账分支，不参与验签）。 */
function jwtWithSub(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `header.${payload}.sig`
}

test('website profile display name supersedes stale Auth metadata and ignores another user', async () => {
  const auth = { id: 'me', email: 'me@example.com', user_metadata: { username: 'old-name' } }
  const read = (id: string) => fetchAccountProfile(jwtWithSub('me'), { fetchImpl: routedFetch([
    { match: '/auth/v1/user', body: auth },
    { match: '/profiles', body: [{ id, display_name: 'Website name', username: 'website-handle' }] },
  ]) })
  assert.equal((await read('me'))?.displayName, 'Website name')
  assert.equal((await read('someone-else'))?.displayName, 'old-name')
})

test('头像：读本人 profiles 行的 avatar_url', async () => {
  const avatar = await fetchAccountAvatar('t', {
    fetchImpl: routedFetch([{ match: '/profiles', body: [{ id: 'u1', avatar_url: 'https://cdn.example/a.png' }] }]),
  })
  assert.equal(avatar, 'https://cdn.example/a.png')
})

test('头像：行不属于本 token 时丢弃（策略被改宽也不显示别人的头像）', async () => {
  const avatar = await fetchAccountAvatar(jwtWithSub('me'), {
    fetchImpl: routedFetch([{ match: '/profiles', body: [{ id: 'someone-else', avatar_url: 'https://cdn.example/b.png' }] }]),
  })
  assert.equal(avatar, null)
})

test('头像：无头像（null 列）与取数失败都回 null，不抛', async () => {
  const noAvatar = await fetchAccountAvatar('t', {
    fetchImpl: routedFetch([{ match: '/profiles', body: [{ id: 'u1', avatar_url: null }] }]),
  })
  assert.equal(noAvatar, null)

  const unauthorized = await fetchAccountAvatar('t', {
    fetchImpl: routedFetch([{ match: '/profiles', status: 401 }]),
  })
  assert.equal(unauthorized, null)

  const offline = await fetchAccountAvatar('t', { fetchImpl: routedFetch([{ match: '/profiles', throws: true }]) })
  assert.equal(offline, null)
})

test('创始：徽章多行时取最高档（legacy 命名也认）', async () => {
  const founding = await fetchFoundingBadge('t', {
    fetchImpl: routedFetch([
      { match: '/user_badges', body: [{ badge_code: 'PROMAX_ULTRA_FOUNDER' }, { badge_code: 'FOUNDER_TIER_3' }] },
      { match: 'get_my_founder_rank', body: { is_founder: true, rank: 42, total: 640, limit: 300, tier: 'FOUNDER_TIER_1' } },
    ]),
  })
  assert.ok(founding)
  assert.equal(founding.badgeCode, 'PROMAX_ULTRA_FOUNDER', '保留原始 code，归一由展示层做')
  assert.equal(founding.tier, 1, 'legacy code 应归到一档（tier 最小的档位最高）')
  assert.equal(founding.rank, 42)
  assert.equal(founding.total, 640)
})

test('创始：RPC 形状陌生时只丢位次，不丢徽章', async () => {
  const founding = await fetchFoundingBadge('t', {
    fetchImpl: routedFetch([
      { match: '/user_badges', body: [{ badge_code: 'FOUNDER_TIER_2' }] },
      { match: 'get_my_founder_rank', body: {} },
    ]),
  })
  assert.ok(founding, '徽章取到了就该有铭牌')
  assert.equal(founding.badgeCode, 'FOUNDER_TIER_2')
  assert.equal(founding.rank, null, '形状不符时位次为 null，不编造')
  assert.equal(founding.tier, 2, '档位可由 badge_code 独立推出')
})

test('创始：非创始用户回 null（不渲染空壳铭牌）', async () => {
  const none = await fetchFoundingBadge('t', {
    fetchImpl: routedFetch([
      { match: '/user_badges', body: [] },
      { match: 'get_my_founder_rank', body: { is_founder: false, rank: null, total: 0, limit: 300, tier: null } },
    ]),
  })
  assert.equal(none, null)
})

test('创始：有 rank 无 badge 时档位由位次推出——这是真实可达的快照形状', async () => {
  // 授予函数与 `user_badges` 之间可以有窗口期（历史数据里也见过缺徽章的行）。
  // 这条形状一旦丢了 tier，消费端就只能靠 badge_code 推档位 → 渲染出空壳铭牌
  // 并把位次一起丢掉（桌面端 Wave 5 审查发现 2.1）。所以 tier 必须在这里算出来。
  const founding = await fetchFoundingBadge('t', {
    fetchImpl: routedFetch([
      { match: '/user_badges', body: [] },
      { match: 'get_my_founder_rank', body: { is_founder: true, rank: 450, total: 640 } },
    ]),
  })
  assert.ok(founding, '有位次就是创始用户——不该因为缺徽章整块消失')
  assert.equal(founding.badgeCode, null)
  assert.equal(founding.rank, 450)
  assert.equal(founding.tier, 2, '位次 450 落在二档，档位必须随快照一起给出')
})

test('创始：limit 恒为「一档名额」，不随档位变——它不能当位次分母', async () => {
  // 展示口径：位次行的分母取自档位区间上端（300/600/1000，见 founding-tiers 的 to）。
  // 若有人把这里"修"成 limit = 当前档位的 to，等于在 sidecar 里造出第二份档位表；
  // 而客户端若拿 limit 当分母，二/三档就会写出「创始 No. 450 / 300」。
  const tier3 = await fetchFoundingBadge('t', {
    fetchImpl: routedFetch([
      { match: '/user_badges', body: [{ badge_code: 'FOUNDER_TIER_3' }] },
      { match: 'get_my_founder_rank', body: { is_founder: true, rank: 800, total: 640 } },
    ]),
  })
  assert.ok(tier3)
  assert.equal(tier3.tier, 3)
  assert.equal(tier3.rank, 800)
  assert.equal(tier3.limit, 300, 'limit 是一档名额的语义，与消费方所在档位无关')
})

test('快照：确认无头像与铭牌仍返回确认状态；任一取到保留该项', async () => {
  const empty = await fetchAccountProfileSnapshot('t', {
    fetchImpl: routedFetch([
      { match: '/profiles', body: [{ id: 'u1', avatar_url: null }] },
      { match: '/user_badges', body: [] },
      { match: 'get_my_founder_rank', body: { is_founder: false } },
    ]),
  })
  assert.ok(empty, '确认没有头像或创始身份，不等于网络失败')
  assert.deepEqual(empty.unconfirmed, [])

  const avatarOnly = await fetchAccountProfileSnapshot('t', {
    fetchImpl: routedFetch([
      { match: '/profiles', body: [{ id: 'u1', avatar_url: 'https://cdn.example/a.png' }] },
      { match: '/user_badges', body: [] },
      { match: 'get_my_founder_rank', body: { is_founder: false } },
    ]),
  })
  assert.ok(avatarOnly)
  assert.equal(avatarOnly.avatarUrl, 'https://cdn.example/a.png')
  assert.equal(avatarOnly.founding, null)
})

test('saveAccountProfile 部分写不丢 accessToken（凭据与资料同生命周期）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-profile-'))
  try {
    const store = accountStore(dir)
    const token = saveAccountToken(store, {
      status: 'approved',
      accessToken: 'tok-keep-me',
      refreshToken: 'refresh-keep-me',
      expiresIn: 3600,
    })
    saveAccountProfile(
      store,
      token,
      { avatarUrl: 'https://cdn.example/a.png', founding: { badgeCode: 'FOUNDER_TIER_1', rank: 7, tier: 1, total: 300, limit: 300 }, fetchedAt: 0 },
      1234,
    )
    const reloaded = store.load()
    assert.equal(reloaded?.accessToken, 'tok-keep-me', 'accessToken 不得被快照写抹掉')
    assert.equal(reloaded?.refreshToken, 'refresh-keep-me')
    assert.equal(reloaded?.profile?.fetchedAt, 1234, 'fetchedAt 由 helper 统一盖章')
    assert.equal(reloaded?.profile?.founding?.rank, 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cachedAccountProfile 形状不全回 null，字段类型不符时按缺省处理', () => {
  assert.equal(cachedAccountProfile(null), null)
  assert.equal(cachedAccountProfile({ accessToken: 't', expiresAt: 0 }), null, '没有 profile 字段')

  const partial = cachedAccountProfile({
    accessToken: 't',
    expiresAt: 0,
    profile: { avatarUrl: 'https://cdn.example/a.png', founding: null, fetchedAt: 5 },
  })
  assert.ok(partial)
  assert.equal(partial.avatarUrl, 'https://cdn.example/a.png')
  assert.equal(partial.fetchedAt, 5)

  const bothEmpty = cachedAccountProfile({
    accessToken: 't',
    expiresAt: 0,
    profile: { avatarUrl: null, founding: null, fetchedAt: 5 },
  })
  assert.equal(bothEmpty, null, '两半都空等于没有——回 null 而不是一个空壳')
})

test('authorization URL replaces stale codes and preserves query/hash routing', () => {
  const url = new URL(deviceAuthorizeUrl('https://example.com/auth/device?code=old&lang=zh#confirm', 'NEW 42'))
  assert.deepEqual(url.searchParams.getAll('code'), ['NEW 42'])
  assert.equal(url.searchParams.get('lang'), 'zh')
  assert.equal(url.hash, '#confirm')
  assert.throws(() => deviceAuthorizeUrl('javascript:alert(1)', 'DEMO'))
})
test('unknown poll statuses are protocol errors, never silent undefined states', () => {
  assert.deepEqual(parseDevicePoll({ status: 'unexpected' }), { status: 'error' })
})


test('account contact caches website name and valid join date without exposing credentials', async () => {
  const profile = await fetchAccountProfile('FAKE', { fetchImpl: async () => new Response(JSON.stringify({
    email: 'fixture@example.com', id: 'fake-user', user_metadata: { username: 'stellar-traveler' }, created_at: '2026-09-03T00:00:00Z',
  })) })
  assert.equal(profile?.displayName, 'stellar-traveler')
  assert.equal(profile?.joinedAt, '2026-09-03T00:00:00Z')
  const storeHome = mkdtempSync(join(tmpdir(), 'rivet-account-contact-'))
  try {
    const store = accountStore(storeHome)
    const saved = saveAccountToken(store, { status: 'approved', accessToken: 'FAKE' })
    saveAccountProfile(store, saved, { avatarUrl: null, founding: null, account: profile, fetchedAt: Date.now() })
    assert.equal(cachedAccountProfile(store.load())?.account?.displayName, 'stellar-traveler')
  } finally { rmSync(storeHome, { recursive: true, force: true }) }
})


test('device profile survives GoTrue rejecting the custom device session', async () => {
  const profile = await fetchAccountProfile(jwtWithSub('device-owner'), { fetchImpl: async input => {
    const url = String(input)
    if (url.includes('/auth/v1/user')) return new Response('{}', { status: 403 })
    assert.ok(url.includes('id=eq.device-owner'))
    return new Response(JSON.stringify([{ id: 'device-owner', display_name: '官网昵称', username: 'stellar', created_at: '2026-09-03T00:00:00Z' }]))
  } })
  assert.equal(profile?.displayName, '官网昵称')
  assert.equal(profile?.username, 'stellar')
  assert.equal(profile?.userId, 'device-owner')
  assert.equal(profile?.joinedAt, '2026-09-03T00:00:00Z')
  assert.equal(profile?.email, null, 'do not fabricate email from the unsigned JWT payload')
  assert.equal(await fetchAccountProfile(jwtWithSub('device-owner'), { fetchImpl: async input => String(input).includes('/auth/v1/user')
    ? new Response('{}', {status:403}) : new Response(JSON.stringify([{id:'another-user',display_name:'Wrong user'}])) }), null)
})
test('a verified ordinary profile without avatar is distinct from failed synchronization', async () => {
  const snapshot = await fetchAccountProfileSnapshot(jwtWithSub('me'), { fetchImpl: routedFetch([
    { match: '/profiles', body: [{ id:'me', avatar_url:null }] },
    { match: '/user_badges', body: [] },
    { match: 'get_my_founder_rank', body: {is_founder:false,rank:null,total:1200} },
  ]) })
  assert.ok(snapshot)
  assert.deepEqual(snapshot.unconfirmed, [])
  assert.equal(snapshot.founding, null)
})
test('device refresh uses the website rotation endpoint and rejects incomplete responses', async () => {
  const rotated = await refreshAccountToken('fake-refresh', { fetchImpl: async (input, init) => {
    assert.ok(String(input).endsWith('/functions/v1/tui-auth-refresh'))
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer fake-refresh')
    return new Response(JSON.stringify({accessToken:'fake-new',refreshToken:'fake-next',expiresIn:3600}))
  } })
  assert.equal(rotated?.accessToken, 'fake-new')
  assert.equal(await refreshAccountToken('fake-refresh', { fetchImpl: async () => new Response(JSON.stringify({accessToken:'incomplete'})) }), null)
})

test('real cancellation/logout clients send scoped capabilities and expose server failure', async () => {
 const bodies:unknown[]=[]
 const fetchImpl = (async (url:unknown, init?:RequestInit) => {
  assert.match(String(url),/\/functions\/v1\/tui-auth-end$/)
  assert.ok((init?.headers as Record<string,string>).apikey)
  bodies.push(JSON.parse(String(init?.body)))
  return new Response('{}',{status:bodies.length===1?200:503})
 }) as typeof fetch
 assert.equal(await cancelDeviceCode('CODE0001',{fetchImpl}),true)
 assert.equal(await revokeAccountSession('session-fixture',{fetchImpl}),false)
 assert.deepEqual(bodies,[{deviceCode:'CODE0001'},{accessToken:'session-fixture'}])
})
