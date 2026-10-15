/**
 * server-info.json 发现文件——读写原子性、pid 归属清除、坏文件降级、attach 探测。
 *
 * 数据流（复杂 spec 工作流——dataflow verifier 姿态）：
 *   serveCommand：listen 成功且信号/看门狗退出通路接好 → writeServerInfo({port, token, pid, startedAt})
 *   serve 关停（close 链 / 信号 / parent-gone）→ clearServerInfo（pid 校验后删）
 *   serveCommand --attach → readServerInfo + isServerInfoAlive → 复用或新起
 *
 * 反证测试表（哪些实现会红）：
 *   - 非 rename 原子写（直接 writeFileSync 目标）→ 「rename 后无残留 tmp」用例红
 *   - 清除不校验 pid → 「A 先退 B 仍在」用例必红
 *   - 坏 JSON / 缺字段 / 越界 port → 必须返回 undefined 而非抛异常
 *   - attach 探测超时/401/坏响应 → isServerInfoAlive 必须返回 false
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServer } from '../index.js'
import {
  writeServerInfo,
  readServerInfo,
  clearServerInfo,
  isServerInfoAlive,
  resolveAttachHandshake,
  printSpawnedHandshake,
  enableJsonModeStdoutPurity,
  type ServerInfo,
} from '../server-info.js'
import { serverLogger, resetServerLogger, formatLog } from '../logger.js'

const TOKEN = 'server-info-test-token'

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-server-info-'))
  return join(dir, 'server-info.json')
}

function sampleInfo(pid = process.pid): ServerInfo {
  return { port: 34567, host: '127.0.0.1', token: TOKEN, pid, startedAt: new Date().toISOString() }
}

// ── v1 兼容（无 host 字段的旧文件）──────────────────────────────

test('readServerInfo：无 host 字段的 v1 文件 → 补默认 127.0.0.1；坏 host 类型 → undefined', () => {
  const p = tempPath()
  try {
    const { host: _omit, ...v1 } = sampleInfo()
    writeFileSync(p, JSON.stringify(v1))
    const read = readServerInfo(p)
    assert.equal(read?.host, '127.0.0.1', 'v1 文件补默认 host')
    assert.equal(read?.port, v1.port)

    writeFileSync(p, JSON.stringify({ ...sampleInfo(), host: 123 }))
    assert.equal(readServerInfo(p), undefined, 'host 非字符串降级')
    writeFileSync(p, JSON.stringify({ ...sampleInfo(), host: '' }))
    assert.equal(readServerInfo(p), undefined, 'host 空串降级')
  } finally {
    rmSync(dirnameOf(p), { recursive: true, force: true })
  }
})

// ── 读写往返 ────────────────────────────────────────────────────────

test('写入后读取往返一致；rename 后无残留 tmp；文件 mode 0600（token 明文 owner-only）', () => {
  const p = tempPath()
  try {
    const info = sampleInfo()
    writeServerInfo(info, p)
    assert.ok(existsSync(p), '发现文件已落盘')
    assert.deepEqual(readServerInfo(p), info)
    assert.ok(!existsSync(`${p}.${info.pid}.tmp`), 'rename 后无残留 tmp')
    // POSIX 下 mode 0600——含明文 Bearer token，不按 umask 落 644
    if (process.platform !== 'win32') {
      assert.equal(statSync(p).mode & 0o777, 0o600, '发现文件权限 owner-only')
    }
  } finally {
    rmSync(dirnameOf(p), { recursive: true, force: true })
  }
})

// ── 坏文件降级 ──────────────────────────────────────────────────────

test('坏 JSON / 缺字段 / 端口越界 → readServerInfo 返回 undefined，不抛', () => {
  const p = tempPath()
  try {
    writeFileSync(p, '{not-json')
    assert.equal(readServerInfo(p), undefined, '坏 JSON 降级')
    writeFileSync(p, JSON.stringify({ port: 3100, token: 'x' }))
    assert.equal(readServerInfo(p), undefined, '缺 pid/startedAt 降级')
    writeFileSync(p, JSON.stringify({ ...sampleInfo(), port: 70000 }))
    assert.equal(readServerInfo(p), undefined, '端口越界降级')
    writeFileSync(p, JSON.stringify({ ...sampleInfo(), port: 0 }))
    assert.equal(readServerInfo(p), undefined, '端口为 0 降级')
    writeFileSync(p, JSON.stringify({ ...sampleInfo(), token: '' }))
    assert.equal(readServerInfo(p), undefined, '空 token 降级')
    assert.equal(readServerInfo(join(p, '..', 'nonexistent.json')), undefined, '文件不存在降级')
  } finally {
    rmSync(dirnameOf(p), { recursive: true, force: true })
  }
})

// ── pid 归属清除（竞态契约的清除侧）────────────────────────────────

test('clearServerInfo：pid 归属自己才删；归属他人不动', () => {
  const p = tempPath()
  try {
    // 归属他人 → 不删（B 仍在跑，A 先退不得删 B 的文件）
    writeServerInfo(sampleInfo(999999), p)
    clearServerInfo(p, 12345)
    assert.ok(existsSync(p), 'pid 不匹配时文件保留')
    // 归属自己 → 删
    writeServerInfo(sampleInfo(12345), p)
    clearServerInfo(p, 12345)
    assert.ok(!existsSync(p), 'pid 匹配时删除')
  } finally {
    rmSync(dirnameOf(p), { recursive: true, force: true })
  }
})

test('clearServerInfo：文件不存在时是 no-op，不抛', () => {
  const p = tempPath()
  try {
    clearServerInfo(p)
    assert.ok(!existsSync(p))
  } finally {
    rmSync(dirnameOf(p), { recursive: true, force: true })
  }
})

// ── liveness 探测（真实 HTTP，startServer 起临时实例）──────────────

test('isServerInfoAlive：对活的 serve 实例返回 true；关停后 false', { timeout: 20_000 }, async () => {
  const server = await startServer(0, { 'GET /status': () => ({ status: 200, body: { running: false } }) }, TOKEN)
  const info: ServerInfo = { port: server.port, host: '127.0.0.1', token: TOKEN, pid: process.pid, startedAt: new Date().toISOString() }
  try {
    assert.equal(await isServerInfoAlive(info), true, '活实例探测通过')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  // 关停后（端口已释放）探测必须 false—— attach 不会连上一个死端口
  await sleep(300)
  assert.equal(await isServerInfoAlive(info), false, '关停后探测失败')
})

test('isServerInfoAlive：错误 token（401）/ probe 抛异常 → false', { timeout: 10_000 }, async () => {
  const server = await startServer(0, { 'GET /status': () => ({ status: 200, body: { running: false } }) }, TOKEN)
  try {
    const badToken: ServerInfo = { port: server.port, host: '127.0.0.1', token: 'wrong-token', pid: process.pid, startedAt: new Date().toISOString() }
    assert.equal(await isServerInfoAlive(badToken), false, '错误 token 探测失败')
    const throwing: ServerInfo = { port: server.port, host: '127.0.0.1', token: TOKEN, pid: process.pid, startedAt: new Date().toISOString() }
    assert.equal(await isServerInfoAlive(throwing, async () => { throw new Error('probe boom') }), false, 'probe 抛异常时 false')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function dirnameOf(p: string): string {
  return dirname(p)
}

// ── 握手语义（resolveAttachHandshake / printSpawnedHandshake）────────
// 注入 print/probe 隔离：真单元测试——把实现改坏（如漏 token 字段、
// attached 极性反）这些测试会红。serveCommand 只留 3 行接线（见下方源码契约）。

test('resolveAttachHandshake：无发现文件 → false 不打印（stale 新起分支）', async () => {
  // 受控 RIVET_HOME：tempPath 下必然无发现文件——分支语义不依赖环境
  const dir = mkdtempSync(join(tmpdir(), 'rivet-hs0-'))
  process.env.RIVET_HOME = dir
  try {
    const lines: string[] = []
    const attached = await resolveAttachHandshake({ jsonMode: true, print: (l) => lines.push(l) })
    assert.equal(attached, false, '无发现文件必须走新起分支')
    assert.equal(lines.length, 0, '未附着时不打印任何握手输出')
  } finally {
    delete process.env.RIVET_HOME
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAttachHandshake：发现文件指向死实例（probe 失败）→ false（stale 分支）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-hs1-'))
  process.env.RIVET_HOME = dir
  try {
    // 死端口坐标——默认 probe fetch 会 ECONNREFUSED → false
    writeServerInfo({ port: 1, host: '127.0.0.1', token: 'dead', pid: 999999, startedAt: new Date().toISOString() }, join(dir, 'server-info.json'))
    const lines: string[] = []
    const attached = await resolveAttachHandshake({ jsonMode: true, print: (l) => lines.push(l) })
    assert.equal(attached, false, '死实例必须走新起分支（探测兜底 stale 窗口）')
    assert.equal(lines.length, 0)
  } finally {
    delete process.env.RIVET_HOME
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAttachHandshake：活实例 + jsonMode → 单行 attached:true JSON；非 jsonMode 两行人读行', { timeout: 15_000 }, async () => {
  const server = await startServer(0, { 'GET /status': () => ({ status: 200, body: { running: false } }) }, TOKEN)
  try {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-hs-'))
    process.env.RIVET_HOME = dir
    try {
      const info: ServerInfo = { port: server.port, host: '127.0.0.1', token: TOKEN, pid: 12345, startedAt: new Date().toISOString() }
      writeServerInfo(info, join(dir, 'server-info.json'))
      const lines: string[] = []
      const attached = await resolveAttachHandshake({ jsonMode: true, print: (l) => lines.push(l) })
      assert.equal(attached, true, '活实例必须附着成功')
      assert.equal(lines.length, 1, 'jsonMode 恰输出一行')
      const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
      assert.equal(parsed.attached, true)
      assert.equal(parsed.port, server.port)
      assert.equal(parsed.host, '127.0.0.1')
      assert.equal(parsed.token, TOKEN)
      assert.equal(parsed.pid, 12345)
      // 非 jsonMode：两行人读输出
      const human: string[] = []
      const attached2 = await resolveAttachHandshake({ jsonMode: false, print: (l) => human.push(l) })
      assert.equal(attached2, true)
      assert.equal(human.length, 2, '非 jsonMode 两行（附着行 + URL 行）')
      assert.match(human[1] ?? '', /http:\/\/127\.0\.0\.1:\d+\/status/)
    } finally {
      delete process.env.RIVET_HOME
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('printSpawnedHandshake：坐标直供输出 attached:false——不回读磁盘，双实例竞态下输出本实例坐标', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-hs2-'))
  process.env.RIVET_HOME = dir
  try {
    // 传入坐标 = 本实例内存真源（runServe 的 RunningServer.serverInfo）
    const mine: ServerInfo = { port: 34567, host: '192.168.1.5', token: 'spawn-tok', pid: 4242, startedAt: new Date().toISOString() }
    const lines: string[] = []
    printSpawnedHandshake(mine, (l) => lines.push(l))
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    assert.equal(parsed.attached, false)
    assert.equal(parsed.port, 34567)
    assert.equal(parsed.host, '192.168.1.5', 'host 用传入值——非默认 host（--host LAN IP）不被硬编码覆盖')
    assert.equal(parsed.token, 'spawn-tok')
    assert.equal(parsed.pid, 4242)

    // 反竞态：磁盘上躺着「别人」的坐标（并发新起的后一个实例覆盖了发现文件），
    // 输出仍必须是本实例坐标——回读实现会在此红。
    writeServerInfo({ port: 39999, host: '127.0.0.1', token: 'other-instance', pid: 999999, startedAt: new Date().toISOString() }, join(dir, 'server-info.json'))
    const lines2: string[] = []
    printSpawnedHandshake(mine, (l) => lines2.push(l))
    const still = JSON.parse(lines2[0] ?? '') as Record<string, unknown>
    assert.equal(still.port, 34567, '输出本实例 port 而非磁盘上他实例的 39999')
    assert.equal(still.token, 'spawn-tok')
    assert.equal(still.pid, 4242)
  } finally {
    delete process.env.RIVET_HOME
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── serveCommand 接线契约（源码文本断言，同 serve-timing 模式；serveCommand
// 含 process.exit，in-process 会杀 runner，故接线用源码契约 + e2e 实测双保险）──

const serveSrc = readFileSync(join(process.cwd(), 'src', 'server', 'serve.ts'), 'utf8')

test('serveCommand 契约：attach 接线——write 回调退出、jsonMode 重定向 logger、坐标内存直供', () => {
  const jsonAt = serveSrc.indexOf("const jsonMode = args.includes('--json')")
  const attachAt = serveSrc.indexOf("if (args.includes('--attach')) await attachOrExit(jsonMode)")
  assert.ok(jsonAt > -1 && attachAt > -1, '--json / --attach flag 已解析')
  assert.ok(jsonAt < attachAt, 'jsonMode 声明在 attach 接线之前')
  const purityAt = serveSrc.indexOf('if (jsonMode) enableJsonModeStdoutPurity()')
  assert.ok(purityAt > -1 && purityAt < attachAt, 'jsonMode 先启用 stdout 纯度再走 attach（顺序保证握手输出前生效）')
  // jsonMode 新起分支：banner 走 stderr、握手坐标用 RunningServer.serverInfo（内存直供）
  const stderrBannerAt = serveSrc.indexOf('console.error(`Rivet Runtime API listening on')
  const spawnedAt = serveSrc.indexOf('printSpawnedHandshake(server.serverInfo, (l) => console.log(l))')
  assert.ok(stderrBannerAt > -1 && spawnedAt > -1, 'jsonMode 分支存在：stderr banner + 握手输出')
  assert.ok(spawnedAt > stderrBannerAt, '握手输出在 banner 之后（listen 已完成）')
})

test('server-info 契约：attachOrExit 经 write 回调退出（防管道截断）；jsonMode 重定向 info→stderr', () => {
  const infoSrc = readFileSync(join(process.cwd(), 'src', 'server', 'server-info.ts'), 'utf8')
  // write 回调退出：同步 process.exit 会丢弃未 flush 的管道缓冲（wsl.exe stdio 半行 JSON）
  assert.match(infoSrc, /process\.stdout\.write\([^,]+, \(\) => process\.exit\(0\)\)/, '退出必须挂在 write 回调里')
  assert.doesNotMatch(infoSrc, /once\('drain', \(\) => process\.exit\(0\)\)\s*\n\s*process\.exit\(0\)/, 'drain 后紧跟同步 exit 是无效防护')
  // stdout 纯度：info 重定向 stderr（cron startup/app-open trigger 每次启动 fire）
  assert.match(infoSrc, /info: \(message, context\) => console\.error\(formatLog\('INFO'/, 'jsonMode 重定向 info→stderr')
})

test('formatLog：jsonMode 重定向复用同一格式——[server:LEVEL] message + JSON context', () => {
  assert.equal(formatLog('INFO', 'hello'), '[server:INFO] hello')
  assert.equal(formatLog('INFO', 'fired', { n: 3 }), '[server:INFO] fired {"n":3}')
  assert.equal(formatLog('WARN', 'x', { err: 'boom' }), '[server:WARN] x {"err":"boom"}')
})

test('jsonMode logger 重定向行为：setServerLogger 后 info 不再落 stdout', () => {
  const out: string[] = []
  const err: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true }) as typeof process.stderr.write
    // 调本体函数（非字面复刻）——函数体被改坏（如 info 写回 stdout）时此测试必红
    enableJsonModeStdoutPurity()
    serverLogger.info('startup trigger fired 3 task(s)')
    serverLogger.warn('watcher failed')
    assert.equal(out.length, 0, 'info/warn 不落 stdout——stdout 只留给握手 JSON')
    assert.ok(err.length >= 2, 'info/warn 全部落 stderr')
    assert.ok(err.join('\n').includes('[server:INFO] startup trigger fired 3 task(s)'), 'info 格式保持 [server:INFO] 字面')
    // 顺带钉住 skill-loader 收编后的通道：触发播种日志路径的 info 也走 stderr
    serverLogger.info('[skills] bundled-skills dir=/x; seeded 1 new')
    assert.equal(out.length, 0, 'skill-loader 播种日志同样不落 stdout')
  } finally {
    process.stdout.write = origWrite
    process.stderr.write = origErr
    resetServerLogger()
  }
})
