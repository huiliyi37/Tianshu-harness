/**
 * P2 Mobile Remote — serve 静态挂载策略测试（/mobile 前缀，auth 门前）。
 *
 * 条件矩阵（S3 全格）：mobileDir（配/不配）× 路径（/mobile、/mobile/、/mobile/assets/x、
 * 穿越、不存在）× auth（无 token）× Host（回环/evil）。
 *
 * 基建说明：与 host-policy.test.ts 同构——node fetch 禁止设置 Host 头，而 Host 判定是
 * 被测对象的一部分，因此用原始 socket 请求（rawRequest）精确控制 Host 行与原始路径
 * （含未归一化的 `..` 穿越形态）。
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../index.js'

const TOKEN = 'test-token-abc'
const HTML_BODY = '<!doctype html><html><head><title>rivet-mobile-fixture</title></head><body>mobile</body></html>'
const JS_BODY = "console.log('rivet-mobile-asset')"

/** 原始 HTTP 请求：精确控制 Host 行与请求路径（不归一化）。 */
function rawRequest(
  port: number,
  opts: { path?: string; method?: string; httpVersion?: string; hostHeader?: string | null; extraHeaders?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      const lines = [`${opts.method ?? 'GET'} ${opts.path ?? '/'} ${opts.httpVersion ?? 'HTTP/1.1'}`]
      if (opts.hostHeader !== null) {
        lines.push(`Host: ${opts.hostHeader ?? `127.0.0.1:${port}`}`)
      }
      for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) lines.push(`${k}: ${v}`)
      lines.push('Connection: close', '', '')
      sock.write(lines.join('\r\n'))
    })
    let data = ''
    sock.on('data', (c) => { data += c.toString() })
    sock.on('end', () => {
      const idx = data.indexOf('\r\n\r\n')
      if (idx < 0) { reject(new Error(`malformed response: ${data.slice(0, 200)}`)); return }
      const head = data.slice(0, idx)
      const headLines = head.split('\r\n')
      const status = Number(headLines[0]?.split(' ')[1])
      const headers: Record<string, string> = {}
      for (const l of headLines.slice(1)) {
        const i = l.indexOf(':')
        if (i > 0) headers[l.slice(0, i).toLowerCase().trim()] = l.slice(i + 1).trim()
      }
      // Node 对无 Content-Length 的响应自动 chunked——按帧解码，否则 body 带帧前缀。
      let body = data.slice(idx + 4)
      if (headers['transfer-encoding'] === 'chunked') {
        let out = ''
        let rest = body
        while (rest.length > 0) {
          const lineEnd = rest.indexOf('\r\n')
          if (lineEnd < 0) break
          const size = parseInt(rest.slice(0, lineEnd), 16)
          if (!Number.isFinite(size) || size <= 0) break
          out += rest.slice(lineEnd + 2, lineEnd + 2 + size)
          rest = rest.slice(lineEnd + 2 + size + 2)
        }
        body = out
      }
      resolve({ status, headers, body })
    })
    sock.on('error', reject)
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('rawRequest timeout')) })
  })
}

/** 建一个含 mobile.html 与 assets/app.js 的临时 mobileDir fixture。 */
function makeMobileFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-mobile-policy-'))
  writeFileSync(join(dir, 'mobile.html'), HTML_BODY, 'utf-8')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'app.js'), JS_BODY, 'utf-8')
  fixtures.push(dir)
  return dir
}

const fixtures: string[] = []
const servers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of servers.splice(0)) await close()
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function startTestServer(opts: { mobileDir?: string; host?: string } = {}) {
  const srv = await startServer(
    0,
    {
      'GET /ping': () => ({ status: 200, body: { ok: true } }),
    },
    TOKEN,
    { host: opts.host ?? '127.0.0.1', mobileDir: opts.mobileDir },
  )
  return srv
}

async function withServer(opts: Parameters<typeof startTestServer>[0], fn: (s: { port: number }) => Promise<void>) {
  const srv = await startTestServer(opts)
  servers.push(() => new Promise<void>((resolve) => srv.close(() => resolve())))
  try {
    await fn({ port: srv.port })
  } finally {
    const idx = servers.length - 1
    servers.splice(idx, 1)
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
}

describe('mobileDir 未配置 → /mobile 不暴露', () => {
  test('GET /mobile 无 token → 404（而非 401/200）', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile' })
      assert.equal(r.status, 404)
    })
  })
  test('GET /mobile/assets/x 无 token → 404', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/assets/app.js' })
      assert.equal(r.status, 404)
    })
  })
})

describe('mobileDir 已配置 → /mobile 免 Bearer 静态服务', () => {
  test('GET /mobile（无尾斜杠）→ 302 规范化到 /mobile/（保留 query）', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile' })
      assert.equal(r.status, 302)
      assert.equal(r.headers['location'], '/mobile/')
      // query 保留：/mobile?token=… 的规范化不丢 token。
      const rq = await rawRequest(port, { path: '/mobile?token=abc' })
      assert.equal(rq.status, 302)
      assert.equal(rq.headers['location'], '/mobile/?token=abc')
    })
  })
  test('GET /mobile/ → 200 text/html', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/' })
      assert.equal(r.status, 200)
      assert.match(r.headers['content-type'] ?? '', /^text\/html/)
    })
  })
  test('GET /mobile/assets/app.js → 200 正确 Content-Type（无 token）', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/assets/app.js' })
      assert.equal(r.status, 200)
      assert.match(r.headers['content-type'] ?? '', /javascript/)
      assert.equal(r.body, JS_BODY)
    })
  })
  test('API 路径隔离：GET /ping 无 token 仍 401', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping' })
      assert.equal(r.status, 401)
    })
  })
  test('Host evil（回环 bind）在静态挂载前被拒 → 403', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile', hostHeader: 'evil.com' })
      assert.equal(r.status, 403)
      const r2 = await rawRequest(port, { path: '/mobile/assets/app.js', hostHeader: 'evil.com' })
      assert.equal(r2.status, 403)
    })
  })
  test('穿越 /mobile/../secret → 404（禁逃逸）', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/../secret' })
      assert.equal(r.status, 404)
    })
  })
  test('编码穿越 /mobile/%2e%2e/secret → 404', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/%2e%2e/secret' })
      assert.equal(r.status, 404)
    })
  })
  test('不存在文件 /mobile/nope.js → 404', async () => {
    await withServer({ mobileDir: makeMobileFixture() }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/nope.js' })
      assert.equal(r.status, 404)
    })
  })
})

describe('符号链接逃逸防护（审查 2026-09-12：词法包含性挡不住 symlink，realpath 收口）', () => {
  /** mobile fixture 内放指向外部的 symlink（文件 + 目录两种形态）。无权限平台 → null（跳过）。 */
  function makeSymlinkFixture(): { root: string } | null {
    const root = makeMobileFixture()
    const outside = mkdtempSync(join(tmpdir(), 'rivet-mobile-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET', 'utf-8')
    fixtures.push(outside)
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
      symlinkSync(outside, join(root, 'linked-dir'), 'dir')
    } catch {
      return null
    }
    return { root }
  }

  test('root 内指向外部文件的 symlink → 404 且不泄露内容', async (t) => {
    const fx = makeSymlinkFixture()
    if (!fx) { t.skip('symlink unavailable on this platform'); return }
    await withServer({ mobileDir: fx.root }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/leak.txt' })
      assert.equal(r.status, 404)
      assert.ok(!r.body.includes('TOP-SECRET'), '响应不应含外部文件内容')
    })
  })

  test('root 内指向外部目录的 symlink → 404 且不泄露内容', async (t) => {
    const fx = makeSymlinkFixture()
    if (!fx) { t.skip('symlink unavailable on this platform'); return }
    await withServer({ mobileDir: fx.root }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/linked-dir/secret.txt' })
      assert.equal(r.status, 404)
      assert.ok(!r.body.includes('TOP-SECRET'), '响应不应含外部文件内容')
    })
  })

  test('正对照：root 内指向内部文件的 symlink 仍 200', async (t) => {
    const root = makeMobileFixture()
    try {
      symlinkSync(join(root, 'assets', 'app.js'), join(root, 'alias.js'))
    } catch {
      t.skip('symlink unavailable on this platform')
      return
    }
    await withServer({ mobileDir: root }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/mobile/alias.js' })
      assert.equal(r.status, 200)
      assert.equal(r.body, JS_BODY)
    })
  })
})
