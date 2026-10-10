/**
 * SIGHUP 优雅退出——WSL attach serve 被瞬杀的根因修复。
 *
 * 病灶（2026-09-20 七轮真机实验实测，.rivet/scratch/node-hup-v7.txt）：
 * `disconnect_wsl` → `kill_child_tree(relay)` → `taskkill /T /F` 杀掉 Windows
 * 侧 wsl.exe。serve 是该 relay 在 Linux 侧的**同 session 子进程**，session
 * leader 一死内核给同 session 前台进程组发 SIGHUP。此前 serve 只挂
 * SIGINT/SIGTERM（serve.ts:1340-1347），Node 对 SIGHUP 默认 terminate ——
 * 实测 `process.on('exit')` 都没触发，即：
 *   clearServerInfo() ✗（发现文件残留，下次 attach 读到陈旧 pid）
 *   writeExitBreadcrumb() ✗（死亡不可归因——正是 serve.ts:1244-1249
 *     注释里说"the exact ambiguity that made the 'sidecar died overnight'
 *     incidents unattributable"的那个洞）
 *   persistence.flushAllAsync(3000) ✗（会话事件写链 100ms debounce 批次的
 *     滞留行随进程消失——数据丢失，比前两条严重）
 *
 * 对照实验：同 session bash 子进程 trap HUP 后存活（v6）；Node 复刻 serve
 * 信号面则无清理瞬杀（v7）；`setsid --wait` 新 session 的子进程收不到
 * SIGHUP（v8）——故主修复是 session 隔离（wsl_attach.rs），本文件钉的是
 * 兜底那一半：任何来源的 SIGHUP（relay 死亡、终端关闭、用户 kill session）
 * 都走既有优雅退出链而非瞬杀。
 *
 * 反证测试表（把修复回滚哪条会红）：
 *   - 摘掉 `process.on('SIGHUP')` → 契约用例红
 *   - SIGHUP handler 不写 breadcrumb / 不调 shutdownServer → 契约正则红
 *   - 集成用例（Linux）：摘掉 handler → 发现文件残留 + 无 breadcrumb，两条断言红
 *   - 发现文件先于退出通路发布（2026-09-30 修掉的启动竞态：原先 runServe 里写盘、
 *     serveCommand 随后才装处理器）→ 顺序契约红；集成用例快轮询下高概率红
 *
 * 平台说明：集成用例需要真实的 POSIX 信号投递，**Windows 上不可行**——实测
 * `child.kill('SIGHUP')` 返回 OK 但 handler 不触发，进程被 TerminateProcess
 * 直接干掉（.rivet/scratch/sigterm.log 只有 child-ready 一行）。故 skip；
 * CI 的 ubuntu-latest 跑全量 npm test 时该用例真跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cliProcessArgs, cliFixtureEnv } from '../../__tests__/cli-process-fixture.js'

const SERVE_TS = new URL('../serve.ts', import.meta.url)

/** 读 serve.ts 源码——契约测试的唯一真源（对齐 server-shutdown-drain.test.ts:145）。 */
function serveSource(): string {
  return readFileSync(SERVE_TS, 'utf8')
}

// ── 契约：信号面三件套齐备，SIGHUP 与 SIGINT/SIGTERM 同路径 ──────────────

test('serve.ts 信号面：SIGHUP 显式处理，不留 Node 默认 terminate', () => {
  const source = serveSource()
  assert.match(source, /process\.on\('SIGINT'/, 'SIGINT 处理器必须存在（既有行为）')
  assert.match(source, /process\.on\('SIGTERM'/, 'SIGTERM 处理器必须存在（既有行为）')
  assert.match(
    source,
    /process\.on\('SIGHUP'/,
    'SIGHUP 必须显式处理——否则 relay 被 taskkill 后 serve 瞬杀，' +
    '清理链（clearServerInfo / breadcrumb / flushAllAsync）一行都不跑',
  )
})

test('serve.ts SIGHUP handler：写 breadcrumb + 走 shutdownServer（与 SIGTERM 同路径）', () => {
  const source = serveSource()
  // 抓 SIGHUP 处理器体（到下一个 process.on / installParentWatchdog 为止）
  const m = source.match(/process\.on\('SIGHUP',\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s{2}\}\)/)
  assert.ok(m, 'SIGHUP 处理器必须是 `process.on(\'SIGHUP\', () => { … })` 形态（可提取处理器体）')
  const body = m![1]!
  assert.match(
    body,
    /writeExitBreadcrumb\(\s*'signal',\s*\{\s*signal:\s*'SIGHUP'\s*\}\s*\)/,
    'SIGHUP 必须写 breadcrumb 并标注 signal 名——否则死亡不可归因（serve.ts:1244-1249 的原始动机）',
  )
  assert.match(body, /shutdownServer\(\)/, 'SIGHUP 必须复用既有优雅关停链，不另起一套退出逻辑')
})

test('serve.ts SIGHUP handler 与 SIGTERM handler 结构对称（不引入分叉语义）', () => {
  const source = serveSource()
  const grab = (sig: string): string => {
    const m = source.match(new RegExp(`process\\.on\\('${sig}',\\s*\\(\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s{2}\\}\\)`))
    assert.ok(m, `${sig} 处理器必须可提取`)
    // 归一化：把信号名占位掉再比对，两条应只差字面量 'SIGxxx'
    return m![1]!.replace(new RegExp(`'${sig}'`, 'g'), "'<SIG>'").replace(/\s+/g, ' ').trim()
  }
  assert.equal(
    grab('SIGHUP'),
    grab('SIGTERM'),
    'SIGHUP 与 SIGTERM 的处理器体应完全对称（同一 breadcrumb 调用 + 同一 shutdownServer），' +
    '不对称意味着某条信号走了不同的退出语义',
  )
})

test('serve.ts 发现文件在退出通路全部接好之后才发布（启动竞态）', () => {
  const source = serveSource()
  const publishSites = [...source.matchAll(/writeServerInfo\(/g)].map((m) => m.index!)
  assert.ok(publishSites.length > 0, '必须发布发现文件——--attach 靠它找到已有实例')
  for (const wiring of ["process.on('SIGINT'", "process.on('SIGTERM'", "process.on('SIGHUP'", 'installParentWatchdog(']) {
    const wiredAt = source.indexOf(wiring)
    assert.ok(wiredAt > -1, `${wiring} 必须存在`)
    assert.ok(
      publishSites.every((at) => at > wiredAt),
      `${wiring} 必须先于 writeServerInfo 装好——发现文件是对外就绪信号，发布后、装好前的空档里` +
      '收到信号会被 Node 默认直接终止，清理链一行不跑、文件残留',
    )
  }
})

// ── 集成：真起 serve → 真发 SIGHUP → 断言清理链跑完（POSIX only）──────────

const POSIX = process.platform !== 'win32'

test('集成：SIGHUP 后 serve 优雅退出——发现文件清除 + breadcrumb 落盘', {
  timeout: 30_000,
  skip: POSIX ? false : 'Windows 无 POSIX 信号投递（child.kill 返回 OK 但 handler 不触发，进程被 TerminateProcess 直接杀）——CI ubuntu-latest 真跑',
}, async () => {
  const root = join(tmpdir(), `rivet-sighup-${process.pid}-${Date.now()}`)
  const home = join(root, 'home')
  const desktop = join(root, 'desktop')
  mkdirSync(home, { recursive: true })
  mkdirSync(desktop, { recursive: true })
  writeFileSync(join(home, 'config.json'), '{}')

  // 空闲端口（先占再放，竞态窗口可接受——测试独占机器时段）
  const port = await freePort()

  // 集成优先真实发布入口；未构建时保留直接导入 serveCommand 的源码驱动。
  // 契约测试始终读取 serve.ts；两条入口共享相同的信号、发现文件与退出断言。
  const driverPath = join(root, 'driver.mjs')
  const driverSrc = `import { serveCommand } from ${JSON.stringify(SERVE_TS.href)}\nawait serveCommand(['--port', String(${port})])\n`
  writeFileSync(driverPath, driverSrc, 'utf8')

  const infoPath = join(home, 'server-info.json')
  const exitPath = join(desktop, 'sidecar-exit.json')

  const repoRoot = fileURLToPath(new URL('../../', SERVE_TS))
  const built = existsSync(join(repoRoot, 'dist', 'main.js'))
  const args = built ? cliProcessArgs(repoRoot, ['serve', '--port', String(port)])
    : ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, driverPath]
  if (!built) console.error('[serve fixture] dist/main.js absent; exercising the source serve driver')
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...cliFixtureEnv(home),
      RIVET_DESKTOP_DIR: desktop,
      RIVET_SERVER_TOKEN: 'sighup-test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  child.stderr?.on('data', (d) => stderr.push(String(d)))

  try {
    // 等 serve ready：发现文件出现 = listen 成功且退出通路已接好。轮询必须远快于
    // 「发布 → 处理器就位」这类毫秒级空档，发布顺序回归时这里才测得出来。
    await waitFor(() => existsSync(infoPath), 20_000, () => `server-info.json 未出现；exitCode=${child.exitCode}; signalCode=${child.signalCode}; stderr=${stderr.join('').slice(-600)}`)
    const info = JSON.parse(readFileSync(infoPath, 'utf8'))
    assert.equal(info.port, port, '发现文件记录的端口应与启动参数一致')
    assert.equal(info.pid, child.pid, '发现文件的 pid 应是子进程 pid（清除侧靠它做归属校验）')

    // 发 SIGHUP —— relay 死亡时内核送给同 session 子进程的那个信号
    child.kill('SIGHUP')

    // 等进程退出（优雅链最长 15s 保险丝 + 余量）
    const code = await waitForExit(child, 20_000)

    // 断言 1：发现文件被清除（clearServerInfo 跑过的直接证据）
    assert.ok(!existsSync(infoPath), 'SIGHUP 后 server-info.json 必须被清除——残留会让下次 attach 读到陈旧 pid')

    // 断言 2：breadcrumb 落盘且标注 SIGHUP（writeExitBreadcrumb 跑过的证据）
    assert.ok(existsSync(exitPath), 'SIGHUP 后 sidecar-exit.json 必须写出——否则死亡不可归因')
    const crumb = JSON.parse(readFileSync(exitPath, 'utf8'))
    assert.equal(crumb.reason, 'signal', 'breadcrumb reason 应为 signal')
    assert.equal(crumb.signal, 'SIGHUP', 'breadcrumb 必须标注 SIGHUP（区分 SIGTERM/SIGINT）')
    assert.equal(crumb.pid, child.pid, 'breadcrumb 的 pid 应是子进程自身')

    // 优雅退出：exit code 0（server.close(() => process.exit(0))），不是被信号杀掉
    assert.equal(code, 0, `应走优雅退出 process.exit(0)，实际 code=${code}；stderr=${stderr.join('').slice(-400)}`)
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

// ── helpers ────────────────────────────────────────────────────────────────

/** 取一个空闲 TCP 端口。 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(p))
    })
  })
}

/** 轮询等待条件成立。 */
async function waitFor(cond: () => boolean, timeoutMs: number, msg: string | (() => string)): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(typeof msg === 'function' ? msg() : msg)
}

/** 等子进程退出，返回 exit code（被信号杀时 code 为 null → 返回 -1 以便断言失败可见）。 */
function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程 ${timeoutMs}ms 内未退出（优雅链悬挂？）`)), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve(code === null ? -1 : code)
      void signal
    })
  })
}
