/**
 * Host 策略与远程可达性测试（P1 Mobile Remote）。
 *
 * 覆盖：startServer host 绑定、Host header 三分支判定（回环 / allowlist / TLS LAN 本机地址）、
 * Bearer 强制、CORS 头回归、GET /remote/info 端点。
 *
 * 基建说明：node fetch 禁止设置 Host 头（forbidden header），而 Host 判定正是被测对象，
 * 因此用原始 socket HTTP 请求（rawRequest）精确控制 Host 行（含「无 Host 行」形态，
 * HTTP/1.0 客户端）。
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { startServer } from '../index.js'
import { buildRemoteInfoRoutes, sortLanUrls } from '../remote-info-routes.js'
import { isLoopbackBind, isLoopbackHostHeader } from '../host-policy.js'
import { defaultLanHosts, filterLanDirectHosts, parseHostsAllow } from '../host-policy.js'

const TOKEN = 'test-token-abc'

/** 原始 HTTP 请求：精确控制 Host 行。hostHeader === null 时不发 Host 行。 */
function rawRequest(
  port: number,
  opts: { path?: string; method?: string; httpVersion?: string; hostHeader?: string | null; extraHeaders?: Record<string, string>; connectHost?: string } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    // connectHost：IPv6 通配绑定（::）用例需连 ::1 才达得到（不依赖双栈映射）。
    const sock = connect(port, opts.connectHost ?? '127.0.0.1', () => {
      const lines = [`${opts.method ?? 'GET'} ${opts.path ?? '/'} ${opts.httpVersion ?? 'HTTP/1.1'}`]
      if (opts.hostHeader !== null) {
        lines.push(`Host: ${opts.hostHeader ?? `127.0.0.1:${port}`}`)
      }
      for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) lines.push(`${k}: ${v}`)
      lines.push('Connection: close', '', '')
      sock.write(lines.join('\r\n'))
    })
    const chunks: Buffer[] = []
    sock.on('data', (c: Buffer) => { chunks.push(c) })
    sock.on('end', () => {
      const buf = Buffer.concat(chunks)
      const sep = Buffer.from('\r\n\r\n')
      const idx = buf.indexOf(sep)
      if (idx < 0) { reject(new Error(`malformed response: ${buf.toString('utf-8', 0, 200)}`)); return }
      const head = buf.toString('utf-8', 0, idx)
      const headLines = head.split('\r\n')
      const status = Number(headLines[0]?.split(' ')[1])
      const headers: Record<string, string> = {}
      for (const l of headLines.slice(1)) {
        const i = l.indexOf(':')
        if (i > 0) headers[l.slice(0, i).toLowerCase().trim()] = l.slice(i + 1).trim()
      }
      // Node 对无 Content-Length 的响应自动 chunked——按帧解码，否则 body 带帧前缀。
      // 必须按**字节**切：chunk 头里的长度是字节数，body 含多字节字符时（如中文网卡名
      // "以太网"，9 字节/3 字符）字符串下标 ≠ 字节偏移，按字符切会多吃几个字符、末尾残留
      // "0\r\n\r"，JSON.parse 报 "Unexpected non-whitespace character after JSON"。
      const raw = buf.subarray(idx + sep.length)
      let out: Buffer
      if (headers['transfer-encoding'] === 'chunked') {
        const parts: Buffer[] = []
        let off = 0
        while (off < raw.length) {
          const lineEnd = raw.indexOf('\r\n', off)
          if (lineEnd < 0) break
          const size = parseInt(raw.toString('latin1', off, lineEnd), 16)
          if (!Number.isFinite(size) || size <= 0) break
          parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size))
          off = lineEnd + 2 + size + 2
        }
        out = Buffer.concat(parts)
      } else {
        out = raw
      }
      resolve({ status, headers, body: out.toString('utf-8') })
    })
    sock.on('error', reject)
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('rawRequest timeout')) })
  })
}

const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` })

async function startTestServer(opts: { host?: string; allowedHosts?: string[]; withRemoteInfo?: boolean; lanDirect?: boolean } = {}) {
  const routes: Record<string, never> = {}
  const srv = await startServer(
    0,
    {
      'GET /ping': () => ({ status: 200, body: { ok: true } }),
      'GET /health': () => ({ status: 200, body: { ok: true } }),
      ...(opts.withRemoteInfo
        ? buildRemoteInfoRoutes(TOKEN, { host: opts.host ?? '127.0.0.1', allowedHosts: opts.allowedHosts, lanDirect: opts.lanDirect })
        : {}),
    },
    TOKEN,
    { host: opts.host ?? '127.0.0.1', allowedHosts: opts.allowedHosts, lanDirect: opts.lanDirect },
  )
  return {
    port: srv.port,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    routes,
  }
}

const servers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of servers.splice(0)) await close()
})

async function withServer(opts: Parameters<typeof startTestServer>[0], fn: (s: { port: number }) => Promise<void>) {
  const s = await startTestServer(opts)
  servers.push(s.close)
  try {
    await fn(s)
  } finally {
    const idx = servers.indexOf(s.close)
    if (idx >= 0) servers.splice(idx, 1)
    await s.close()
  }
}

describe('loopback default bind (127.0.0.1)', () => {
  test('accepts loopback host with actual port', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: `127.0.0.1:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('accepts localhost host', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: `localhost:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('accepts loopback host without port (HTTP/1.0 style)', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: '127.0.0.1', extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('omits Host line entirely -> allowed (HTTP/1.0 no-Host client)', async () => {
    await withServer({}, async ({ port }) => {
      // Node 解析层强制 HTTP/1.1 必须带 Host（400 早于应用层）；真实无 Host
      // 客户端形态是 HTTP/1.0——原注释「无 Host（HTTP/1.0 工具）放行」所指。
      const r = await rawRequest(port, { path: '/ping', httpVersion: 'HTTP/1.0', hostHeader: null, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('rejects foreign host before auth (403 not 401)', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: 'evil.com', extraHeaders: auth() })
      assert.equal(r.status, 403)
      const r2 = await rawRequest(port, { hostHeader: 'evil.com' })
      assert.equal(r2.status, 403)
    })
  })
  test('rejects loopback with wrong port', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: `127.0.0.1:${port + 1}`, extraHeaders: auth() })
      assert.equal(r.status, 403)
    })
  })
  test('rejects non-loopback IPv6 literal', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: '[::ffff:192.168.1.5]', extraHeaders: auth() })
      assert.equal(r.status, 403)
    })
  })
})

describe('/health 鉴权旁路边界（2026-10-07 审计加固）', () => {
  test('/health stays auth-free without bearer', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/health', hostHeader: `127.0.0.1:${port}` })
      assert.equal(r.status, 200)
    })
  })

  test('/health?probe=1 still bypasses auth (冷启动探测兼容)', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/health?probe=1', hostHeader: `127.0.0.1:${port}` })
      assert.notEqual(r.status, 401, 'query 变体不得回落到 Bearer 校验（原 startsWith 行为保留）')
    })
  })

  test('/healthfoo no longer bypasses auth（精确匹配修复：无 bearer → 401）', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/healthfoo', hostHeader: `127.0.0.1:${port}` })
      assert.equal(r.status, 401)
    })
  })
})

describe('LAN bind requires encrypted transport', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
    test(`plaintext ${host} is refused before listening`, async () => {
      await assert.rejects(startTestServer({ host }), /requires TLS/)
    })
  }
})

describe('allowlist (RIVET_SERVE_HOSTS_ALLOW)', () => {
  test('allowlisted host accepted on loopback bind', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: '192.168.1.5', extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('allowlisted host accepted with arbitrary port', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: '192.168.1.5:9999', extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('non-allowlisted host rejected even with bearer', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: 'evil.com', extraHeaders: auth() })
      assert.equal(r.status, 403)
    })
  })
  test('loopback still accepted when allowlist configured', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: `localhost:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('an allowlist cannot authorize plaintext LAN transport', async () => {
    await assert.rejects(startTestServer({ host: '0.0.0.0', allowedHosts: ['192.168.1.5'] }), /requires TLS/)
  })
})

describe('CORS regression', () => {
  test('known webview origin gets ACAO reflection', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { method: 'OPTIONS', hostHeader: `127.0.0.1:${port}`, extraHeaders: { origin: 'tauri://localhost', 'access-control-request-method': 'GET' } })
      assert.equal(r.status, 204)
      assert.equal(r.headers['access-control-allow-origin'], 'tauri://localhost')
    })
  })
  test('unknown origin gets no CORS headers', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { method: 'OPTIONS', hostHeader: `127.0.0.1:${port}`, extraHeaders: { origin: 'https://evil.example' } })
      assert.equal(r.status, 204)
      assert.equal(r.headers['access-control-allow-origin'], undefined)
    })
  })
})

describe('parseHostsAllow warn 路径（P1 fail-open 修复）', () => {
  function captureWarn(fn: () => unknown): { result: unknown; warnings: string[] } {
    const warnings: string[] = []
    const orig = console.warn
    console.warn = (msg?: unknown, ...rest: unknown[]) => { warnings.push([msg, ...rest].map(String).join(' ')) }
    try {
      return { result: fn(), warnings }
    } finally {
      console.warn = orig
    }
  }

  test('合法条目解析成功且不告警', () => {
    const { result, warnings } = captureWarn(() => parseHostsAllow('192.168.1.5, 10.0.0.7'))
    assert.deepEqual(result, ['192.168.1.5', '10.0.0.7'])
    assert.equal(warnings.length, 0)
  })
  test('raw 为空/undefined → undefined 且不告警', () => {
    assert.equal(captureWarn(() => parseHostsAllow(undefined)).result, undefined)
    assert.equal(captureWarn(() => parseHostsAllow('')).result, undefined)
  })
  test('全非法条目 → undefined 且 console.warn 显式提示（不再静默）', () => {
    const { result, warnings } = captureWarn(() => parseHostsAllow('evil.com:8080, foo/bar'))
    assert.equal(result, undefined)
    assert.ok(warnings.length >= 1, 'expected a console.warn for all-invalid allowlist')
    assert.match(warnings[0]!, /RIVET_SERVE_HOSTS_ALLOW/)
  })
  test('非法条目被忽略、合法条目保留 → 合法集合且不告警', () => {
    const { result, warnings } = captureWarn(() => parseHostsAllow('192.168.1.5, evil.com:8080, x/y'))
    assert.deepEqual(result, ['192.168.1.5'])
    assert.equal(warnings.length, 0)
  })
})

describe('GET /remote/info', () => {
  test('lanUrls 排序：物理接口优先、虚拟垫底、组内保序（审查 F2）', () => {
    const input = [
      { name: 'utun4', address: '198.18.0.1' },
      { name: 'en0', address: '192.168.1.5' },
      { name: 'en5', address: '10.0.0.2' },
      { name: 'bridge100', address: '172.16.0.1' },
      { name: 'wl0', address: '192.168.2.7' },
      { name: 'en1', address: '192.168.1.6' },
    ]
    const sorted = sortLanUrls(input)
    assert.deepEqual(
      sorted.map((u) => u.name),
      ['en0', 'en5', 'wl0', 'en1', 'utun4', 'bridge100'],
      '物理（en/wl）组应在虚拟（utun/bridge）前且组内保枚举序',
    )
  })
  test('lanUrls 排序：无物理接口时中间名次在虚拟前', () => {
    const sorted = sortLanUrls([
      { name: 'tap0', address: '10.0.0.1' },
      { name: 'eth0', address: '192.168.0.3' },
    ])
    assert.equal(sorted[0]!.name, 'eth0')
  })
  test('loopback bind reports mode loopback', async () => {
    await withServer({ withRemoteInfo: true }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/remote/info', hostHeader: `127.0.0.1:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
      const body = JSON.parse(r.body)
      assert.equal(body.mode, 'loopback')
      assert.equal(body.listenHost, '127.0.0.1')
      assert.ok(Array.isArray(body.lanUrls))
    })
  })
  test('LAN metadata reports HTTPS when TLS is configured', async () => {
    const route = buildRemoteInfoRoutes(TOKEN, { host: '0.0.0.0', protocol: 'https' })['GET /remote/info']!
    const result = await route({}, {}, auth())
    assert.equal((result.body as { mode: string }).mode, 'lan')
    assert.equal((result.body as { protocol: string }).protocol, 'https')
  })
  test('requires bearer token', async () => {
    await withServer({ withRemoteInfo: true }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/remote/info', hostHeader: `127.0.0.1:${port}` })
      assert.equal(r.status, 401)
    })
  })
})

// ── 回环判定单一真源（host-policy.ts）──────────────────────────
// 2026-09 审查：此前 index.ts 与 remote-info-routes.ts 各持一份判定，两份都把
// '::' 当回环（index.ts 紧邻的注释却写着「LAN 模式：…::」——代码与注释自相矛盾）。
// IPv6 通配绑定下非回环 Host 全 403：手机到不了 /mobile，/remote/info 还误报
// loopback（桌面设置页不画二维码）。以下钉住修正后的语义。
describe('host-policy 回环判定（单一真源）', () => {
  test("'::' 是 IPv6 通配地址（双栈等效 0.0.0.0），不是回环绑定", () => {
    assert.equal(isLoopbackBind('::'), false, "'::' 绑双栈全部接口——必须进 LAN 模式")
    assert.equal(isLoopbackBind('0.0.0.0'), false)
    assert.equal(isLoopbackBind('::1'), true)
    assert.equal(isLoopbackBind('127.0.0.1'), true)
    assert.equal(isLoopbackBind('localhost'), true)
    assert.equal(isLoopbackBind(' 127.0.0.1 '), true, '前后空白容错')
  })

  test('127.0.0.0/8 整段判回环（不止 127.0.0.1）', () => {
    assert.equal(isLoopbackBind('127.0.0.2'), true)
    assert.equal(isLoopbackBind('127.31.4.9'), true)
    assert.equal(isLoopbackBind('128.0.0.1'), false)
  })

  test('IPv4-mapped 回环算回环，mapped 私网不算', () => {
    assert.equal(isLoopbackBind('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackBind('::ffff:192.168.1.5'), false)
  })

  test('Host 头：127/8 + IPv6 字面量 + 端口一致性', () => {
    assert.equal(isLoopbackHostHeader('127.0.0.2:3100', 3100), true)
    assert.equal(isLoopbackHostHeader('127.0.0.2', 3100), true)
    assert.equal(isLoopbackHostHeader('127.0.0.2:3101', 3100), false, '端口不符不放行')
    assert.equal(isLoopbackHostHeader('[::1]:3100', 3100), true)
    assert.equal(isLoopbackHostHeader('[::1]', 3100), true)
    assert.equal(isLoopbackHostHeader('[::ffff:192.168.1.5]:3100', 3100), false)
    assert.equal(isLoopbackHostHeader('evil.com', 3100), false)
    assert.equal(isLoopbackHostHeader('localhost:3100', 3100), true)
  })
})

describe('IPv6 通配绑定 (::) — 与 0.0.0.0 同等 LAN 语义', () => {
  test('IPv6 wildcard plaintext is refused before listening', async () => {
    await assert.rejects(startTestServer({ host: '::' }), /requires TLS/)
  })

  test('Host 头 127.0.0.2:port 判回环放行（默认 127.0.0.1 绑定）', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: `127.0.0.2:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
})

// ── LAN Direct：Host allowlist 收紧到私网（设计 §5.3 Wave 1 第 3 条）──────
// 语义：LAN Direct 模式下 defaultLanHosts 剔除公网地址——仅保留 RFC1918 私网、
// link-local、回环与本机名。防线意义：即使机器处于公网 IP 直连场景，公网 Host
// 也被拒（双保险）。普通模式（未 opt-in）行为完全不变。
describe('LAN Direct host allowlist 收紧', () => {
  test('filterLanDirectHosts：保留私网/link-local/回环/本机名，剔除公网与 CGNAT', () => {
    const kept = [
      '192.168.1.5', '10.0.0.7', '172.16.0.1', '172.31.255.254', // RFC1918
      '169.254.10.20', '127.0.0.1', '[::1]', '[::ffff:192.168.1.5]', // link-local / 回环
      'mymac.local', 'localhost', '[fe80::1]', '[fd00::1]', // 本机名 / IPv6 link-local / ULA
    ]
    const dropped = [
      '172.32.0.1', '172.15.0.1', '192.169.1.5', '11.0.0.1', // 邻接 172.16-31 与 192.168 的越界/近邻
      '8.8.8.8', '100.64.0.1', '[2001:db8::1]', '[::ffff:8.8.8.8]', // 公网 / CGNAT
    ]
    assert.deepEqual(filterLanDirectHosts([...kept, ...dropped]), kept)
    assert.deepEqual(filterLanDirectHosts(dropped), [])
  })

  test('普通模式 defaultLanHosts 行为不变（不过滤）', () => {
    assert.ok(defaultLanHosts('8.8.8.8').includes('8.8.8.8'), '未 opt-in 时 bindHost 原样保留')
  })

  test('LAN Direct 模式 defaultLanHosts 剔除公网 bindHost', () => {
    const hosts = defaultLanHosts('8.8.8.8', { lanDirect: true })
    assert.ok(!hosts.includes('8.8.8.8'), '公网 bindHost 不得进 allowlist')
    assert.deepEqual(hosts, filterLanDirectHosts(hosts), '结果整体落在私网/本机集合内')
  })

  test('LAN Direct 模式下公网 Host 被 403，回环 Host 仍放行', async () => {
    await withServer({ host: '0.0.0.0', lanDirect: true }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: '8.8.8.8', extraHeaders: auth() })
      assert.equal(r.status, 403)
      const ok = await rawRequest(port, { path: '/ping', hostHeader: `127.0.0.1:${port}`, extraHeaders: auth() })
      assert.equal(ok.status, 200)
    })
  })

  test('/remote/info 暴露 lanDirect 字段（缺省 false）', async () => {
    const off = buildRemoteInfoRoutes(TOKEN, { host: '0.0.0.0', allowedHosts: ['192.168.1.5'] })['GET /remote/info']!
    const offBody = (await off({}, {}, auth())).body as { lanDirect: boolean; mode: string }
    assert.equal(offBody.lanDirect, false)
    assert.equal(offBody.mode, 'lan')

    const on = buildRemoteInfoRoutes(TOKEN, { host: '0.0.0.0', lanDirect: true })['GET /remote/info']!
    assert.equal(((await on({}, {}, auth())).body as { lanDirect: boolean }).lanDirect, true)
  })
})
