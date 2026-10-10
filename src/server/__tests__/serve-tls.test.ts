import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { request as httpRequest } from 'node:http'
import { startServer } from '../index.js'
import { assertSecureBind, readServeTlsArgs, resolveLanDirect } from '../serve-transport.js'

test('TLS options require both certificate and identity files', () => {
  assert.equal(readServeTlsArgs([]), undefined)
  assert.throws(() => readServeTlsArgs(['--tls-cert', 'missing']), /supplied together/)
  assert.throws(() => readServeTlsArgs(['--tls-key', '--port']), /Missing value/)
})

test('real TLS LAN listener keeps Bearer auth and serves encrypted responses', async (t) => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) }
  catch { t.skip('openssl is required to generate an ephemeral test certificate'); return }
  const dir = mkdtempSync(join(tmpdir(), 'serve-tls-'))
  const cert = join(dir, 'certificate.pem'), identity = join(dir, 'identity.pem')
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', identity, '-out', cert], { stdio: 'ignore' })
    server = await startServer(0, { 'GET /ping': () => ({ status: 200, body: { ok: true } }) }, 'fixture', {
      host: '0.0.0.0', tls: readServeTlsArgs(['--tls-cert', cert, '--tls-key', identity]),
    })
    const get = (authorization?: string, host?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server!.port, path: '/ping', rejectUnauthorized: false,
        headers: { ...(authorization ? { authorization } : {}), ...(host ? { host } : {}) } }, res => {
        let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode!, body }))
      }); req.on('error', reject); req.end()
    })
    assert.equal((await get()).status, 401)
    assert.equal((await get('Bearer fixture', 'evil.example')).status, 403)
    const result = await get('Bearer fixture')
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.body), { ok: true })
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-loopback binds require TLS before starting a listener', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5', '127.evil.example']) assert.throws(() => assertSecureBind(host), /requires TLS/)
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.doesNotThrow(() => assertSecureBind(host))
  assert.doesNotThrow(() => assertSecureBind('0.0.0.0', { cert: 'fixture', key: 'fixture' }))
})

// ── LAN Direct 显式 opt-in（设计 docs/design/2026-10-08-issue402-lan-direct-connect.md §5.3 Wave 1）──
// 契约：无 opt-in 时一切行为与现状完全一致；opt-in 才放行「非回环 + 无 TLS」，
// 且放行必须留下可审计的 console.warn（设计原文措辞「LAN direct plaintext enabled」）。
function captureWarn(fn: () => void): string[] {
  const warnings: string[] = []
  const orig = console.warn
  console.warn = (msg?: unknown, ...rest: unknown[]) => { warnings.push([msg, ...rest].map(String).join(' ')) }
  try { fn() } finally { console.warn = orig }
  return warnings
}

describe('LAN Direct opt-in — assertSecureBind 三分支', () => {
  test('无 opt-in：非回环 + 无 TLS 仍抛错（现状保持）', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
      assert.throws(() => assertSecureBind(host), /requires TLS/)
      assert.throws(() => assertSecureBind(host, undefined, {}), /requires TLS/)
      assert.throws(() => assertSecureBind(host, undefined, { lanDirect: false }), /requires TLS/)
    }
  })

  test('opt-in === true：放行并 console.warn 记录 LAN plaintext', () => {
    const warnings = captureWarn(() => {
      assert.doesNotThrow(() => assertSecureBind('0.0.0.0', undefined, { lanDirect: true }))
      assert.doesNotThrow(() => assertSecureBind('192.168.1.5', undefined, { lanDirect: true }))
    })
    assert.equal(warnings.length, 2, '每次 opt-in 放行都应留下一条可审计告警')
    for (const w of warnings) assert.match(w, /LAN direct plaintext enabled/)
  })

  test('有 TLS：放行且与 opt-in 无关（不产生告警）', () => {
    const warnings = captureWarn(() => {
      assert.doesNotThrow(() => assertSecureBind('0.0.0.0', { cert: 'fixture', key: 'fixture' }))
      assert.doesNotThrow(() => assertSecureBind('0.0.0.0', { cert: 'fixture', key: 'fixture' }, { lanDirect: true }))
    })
    assert.equal(warnings.length, 0)
  })

  test('回环绑定：无论 opt-in 与否都放行且不告警', () => {
    const warnings = captureWarn(() => {
      for (const host of ['127.0.0.1', 'localhost', '::1']) {
        assert.doesNotThrow(() => assertSecureBind(host, undefined, { lanDirect: true }))
      }
    })
    assert.equal(warnings.length, 0)
  })

  test('resolveLanDirect：显式 opts 优先于 env，env 仅字面 "1" 视为开启', () => {
    assert.equal(resolveLanDirect(true, undefined), true)
    assert.equal(resolveLanDirect(false, '1'), false, '显式 false 覆盖 env=1')
    assert.equal(resolveLanDirect(undefined, '1'), true)
    assert.equal(resolveLanDirect(undefined, '0'), false)
    assert.equal(resolveLanDirect(undefined, 'true'), false, '不接受 "true" 等变体，只认 "1"')
    assert.equal(resolveLanDirect(undefined, undefined), false)
  })
})

test('LAN Direct opt-in 后 startServer 可起非回环明文监听（Bearer 门禁不变）', async () => {
  let srv: Awaited<ReturnType<typeof startServer>> | undefined
  const emitted: string[] = []
  const orig = console.warn
  console.warn = (msg?: unknown, ...rest: unknown[]) => { emitted.push([msg, ...rest].map(String).join(' ')) }
  try {
    srv = await startServer(0, { 'GET /ping': () => ({ status: 200, body: { ok: true } }) }, 'fixture', {
      host: '0.0.0.0', lanDirect: true,
    })
  } finally {
    console.warn = orig
  }
  assert.ok(emitted.some((w) => /LAN direct plaintext enabled/.test(w)), 'opt-in 放行须有告警')
  try {
    const get = (authorization?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: srv!.port, path: '/ping',
        headers: { ...(authorization ? { authorization } : {}) } }, res => {
        let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode!, body }))
      }); req.on('error', reject); req.end()
    })
    assert.equal((await get()).status, 401, '明文 LAN 模式下 Bearer 门禁不得放宽')
    assert.equal((await get('Bearer fixture')).status, 200)
  } finally {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()))
  }
})

test('无 opt-in 时 startServer 仍拒绝非回环明文（防回归）', async () => {
  await assert.rejects(
    startServer(0, { 'GET /ping': () => ({ status: 200, body: { ok: true } }) }, 'fixture', { host: '0.0.0.0' }),
    /requires TLS/,
  )
})

// ── serve.ts 接线契约：lanDirect 下传（runServe 集成太重，同 server-shutdown-drain 先例）
// 修前实测（探针 .rivet/scratch/probe-landirect-handoff.mjs）：runServe 用显式 opts
// 解析出 lanDirect=true、本地 assertSecureBind 放行并打印明文告警、allowlist 按私网
// 收窄——但 startServer 的实参缺 lanDirect，startServer 用 opts.lanDirect
// (undefined) 回落到 env 二次判定为 false，随即抛 'Non-loopback access requires TLS'。
// 与 serve.ts 注释声明的不变量「本进程内只解析一次」直接冲突。
test('serve.ts 接线契约：runServe 解析出的 lanDirect 必须原样下传给 startServer', () => {
  const source = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8')
  const call = /await startServer\([^;]*\)/.exec(source)?.[0]
  assert.ok(call, 'serve.ts 应仍以 `await startServer(port, routes, apiToken, {...})` 启动')
  assert.match(call, /\blanDirect\b/, 'lanDirect 必须随 opts 下传——否则 startServer 回落到 env 二次判定，显式 opt-in 在下一跳被丢')
  assert.equal(
    (source.match(/resolveLanDirect\(/g) ?? []).length, 1,
    'runServe 内 lanDirect 只解析一次——assertSecureBind 与 allowlist 收窄须看到同一判定',
  )
})
