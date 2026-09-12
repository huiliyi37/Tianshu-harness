import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateIP, resolveAndAssertPublic, SSRFError } from '../ssrf.js'

describe('isPrivateIP', () => {
  it('detects loopback IPv4', () => {
    assert.equal(isPrivateIP('127.0.0.1'), true)
  })

  it('detects 10.x.x.x range', () => {
    assert.equal(isPrivateIP('10.0.0.1'), true)
  })

  it('detects 192.168.x.x range', () => {
    assert.equal(isPrivateIP('192.168.1.1'), true)
  })

  it('detects 172.16.x.x range', () => {
    assert.equal(isPrivateIP('172.16.0.1'), true)
  })

  it('detects link-local 169.254.x.x', () => {
    assert.equal(isPrivateIP('169.254.169.254'), true)
  })

  it('allows public IPs', () => {
    assert.equal(isPrivateIP('8.8.8.8'), false)
    assert.equal(isPrivateIP('1.1.1.1'), false)
  })

  it('detects IPv6 loopback', () => {
    assert.equal(isPrivateIP('::1'), true)
  })

  it('detects IPv4-mapped private IPv6 addresses', () => {
    assert.equal(isPrivateIP('::ffff:127.0.0.1'), true)
    assert.equal(isPrivateIP('::ffff:10.0.0.1'), true)
    assert.equal(isPrivateIP('::ffff:a9fe:a9fe'), true)
  })

  // issue #116 — IPv4-translated (::ffff:0:0:0/96) literals embed the same
  // IPv4 host as their IPv4-mapped twin and used to slip past the blacklist.
  it('detects IPv4-translated private IPv6 addresses', () => {
    assert.equal(isPrivateIP('::ffff:0:169.254.169.254'), true)
    assert.equal(isPrivateIP('::ffff:0:127.0.0.1'), true)
    assert.equal(isPrivateIP('::ffff:0:10.0.0.1'), true)
    assert.equal(isPrivateIP('::ffff:0:a9fe:a9fe'), true)
  })

  // 同一个文件里两种互斥策略曾是漏洞：::ffff: 按「镜像 v4 保留段」处理（公网映射放行），
  // 而 NAT64(64:ff9b::/96) 与 6to4(2002::/16) 却整段封闭——后者会把映射到公网的地址
  // 也判成私有，在 NAT64 网络（IPv6-only 访问 IPv4 互联网）下等于 web_fetch 全站失效。
  // 统一口径：过渡段内嵌 IPv4 时，只有映射到 v4 保留段的形态才拦。
  it('mirrors IPv4 reserved ranges into NAT64/6to4, not blocking the whole prefix', () => {
    // NAT64：低 32 位即 IPv4
    assert.equal(isPrivateIP('64:ff9b::a9fe:a9fe'), true, 'NAT64 映射 169.254.169.254 必须拦')
    assert.equal(isPrivateIP('64:ff9b::7f00:1'), true, 'NAT64 映射 127.0.0.1 必须拦')
    assert.equal(isPrivateIP('64:ff9b::a00:1'), true, 'NAT64 映射 10.0.0.1 必须拦')
    assert.equal(isPrivateIP('64:ff9b::808:808'), false, 'NAT64 映射 8.8.8.8 是公网，放行')
    assert.equal(isPrivateIP('64:ff9b::5db8:d822'), false, 'NAT64 映射 93.184.216.34 是公网，放行')
    // 6to4：2002:WWXX:YYZZ::/48，前 32 位即 IPv4
    assert.equal(isPrivateIP('2002:a9fe:a9fe::1'), true, '6to4 内嵌 169.254.169.254 必须拦')
    assert.equal(isPrivateIP('2002:7f00:1::1'), true, '6to4 内嵌 127.0.0.1 必须拦')
    assert.equal(isPrivateIP('2002:808:808::1'), false, '6to4 内嵌 8.8.8.8 是公网，放行')
  })

  it('detects reserved IPv6 ranges', () => {
    assert.equal(isPrivateIP('::'), true)
    assert.equal(isPrivateIP('fe90::1'), true)
    assert.equal(isPrivateIP('ff02::1'), true)
  })

  it('allows public IPv6', () => {
    assert.equal(isPrivateIP('2001:4860:4860::8888'), false)
  })

  // issue #116 — mirroring the IPv4 ranges into the embedded-IPv4 prefixes
  // must not block genuinely public addresses written in those forms.
  it('keeps public IPv4-mapped and IPv4-translated addresses allowed', () => {
    assert.equal(isPrivateIP('::ffff:8.8.8.8'), false)
    assert.equal(isPrivateIP('::ffff:5db8:d822'), false)
    assert.equal(isPrivateIP('::ffff:0:8.8.8.8'), false)
    assert.equal(isPrivateIP('::ffff:0:5db8:d822'), false)
  })
})

describe('resolveAndAssertPublic', () => {
  it('returns address for public hostname', async () => {
    const result = await resolveAndAssertPublic('example.com', async () => ({ address: '93.184.216.34' }))
    assert.equal(result.address, '93.184.216.34')
  })

  it('throws SSRFError for private address', async () => {
    await assert.rejects(
      async () => resolveAndAssertPublic('evil.local', async () => ({ address: '10.0.0.1' })),
      (err: unknown) => err instanceof SSRFError && err.hostname === 'evil.local' && err.address === '10.0.0.1',
    )
  })

  it('passes through the family from the lookup', async () => {
    const result = await resolveAndAssertPublic('example.com', async () => ({ address: '93.184.216.34', family: 4 }))
    assert.equal(result.family, 4)
  })

  it('infers family from the address when the lookup omits it', async () => {
    const v4 = await resolveAndAssertPublic('example.com', async () => ({ address: '93.184.216.34' }))
    assert.equal(v4.family, 4)
    const v6 = await resolveAndAssertPublic('example.com', async () => ({ address: '2001:4860:4860::8888' }))
    assert.equal(v6.family, 6)
  })

  // URL.hostname 对 IPv6 literal 返回带方括号的形式（"[::1]"）：isIP 返回 0、dns.lookup
  // 也解析不了它，于是校验形同失效（lookup 直接 ENOTFOUND，或注入型 lookup 拿到脏主机名）。
  // 必须在最靠内的一层剥括号——4 个消费点（http-fetch 1 处 + render-fetch 3 处）都传
  // URL.hostname，改这里等于全部覆盖。
  it('strips IPv6 literal brackets before the lookup and the private check', async () => {
    const looked: string[] = []
    await assert.rejects(
      async () => resolveAndAssertPublic('[::1]', async (host) => {
        looked.push(host)
        return { address: '::1', family: 6 }
      }),
      (err: unknown) => err instanceof SSRFError,
    )
    assert.deepEqual(looked, ['::1'], '括号必须在 lookup 之前剥掉')
  })

  it('allows a public IPv6 literal after stripping brackets', async () => {
    const res = await resolveAndAssertPublic('[2606:4700::1111]', async () => ({
      address: '2606:4700::1111',
      family: 6,
    }))
    assert.equal(res.address, '2606:4700::1111')
  })

  // issue #116 — the guard sits in the DNS-result path, so a translated
  // metadata address must be rejected there too, not only in isPrivateIP.
  it('rejects an IPv4-translated private address from the lookup', async () => {
    await assert.rejects(
      async () => resolveAndAssertPublic('metadata.example', async () => ({ address: '::ffff:0:169.254.169.254', family: 6 })),
      (err: unknown) => err instanceof SSRFError && err.address === '::ffff:0:169.254.169.254',
    )
  })
})
