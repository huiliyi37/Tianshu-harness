import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareSemver,
  parseSemver,
  emitLines,
  buildWindowsSelfUpdateScript,
  updateInstallSpec,
  withResumeArgs,
  checkForUpdate,
  fetchNpmLatestVersion,
  fetchGitHubLatestVersion,
  npmPackageExists,
  isValidUpdateVersion,
  runUpdate,
  detectInstallRoot,
  formatDeclinedUpdate,
  getCurrentVersion,
} from '../updater.js'
import { WinStreamDecoder } from '../../platform.js'
import { ProxyAgent } from 'undici'

describe('updater semver', () => {
  it('parses plain versions', () => {
    assert.deepEqual(parseSemver('2.9.0'), [2, 9, 0, undefined])
    assert.deepEqual(parseSemver('v3.0.0'), [3, 0, 0, undefined])
    assert.deepEqual(parseSemver('1.2'), [1, 2, 0, undefined])
  })

  it('parses prereleases and strips build metadata', () => {
    assert.deepEqual(parseSemver('3.0.0-beta.2'), [3, 0, 0, 'beta.2'])
    assert.deepEqual(parseSemver('2.9.0+build.123'), [2, 9, 0, undefined])
    assert.deepEqual(parseSemver('3.0.0-rc.1+sha.abc'), [3, 0, 0, 'rc.1'])
  })

  it('compares release versions', () => {
    assert.equal(compareSemver('2.9.0', '3.0.0'), -1)
    assert.equal(compareSemver('3.0.0', '2.9.0'), 1)
    assert.equal(compareSemver('2.9.0', '2.9.0'), 0)
    assert.equal(compareSemver('2.9.1', '2.9.0'), 1)
  })

  it('treats release as newer than prerelease with same core', () => {
    assert.equal(compareSemver('3.0.0', '3.0.0-beta'), 1)
    assert.equal(compareSemver('3.0.0-beta', '3.0.0'), -1)
  })

  it('compares prereleases', () => {
    assert.equal(compareSemver('3.0.0-beta', '3.0.0-rc'), -1)
    assert.equal(compareSemver('3.0.0-beta.1', '3.0.0-beta.2'), -1)
  })

  // issue #121 — canary/构建号落在第 4+ 段（如 1.2.3.4）；旧实现只比前 3 段，
  // 把 1.2.3.4 与 1.2.3 判为相等，导致漏报/误报更新。
  // 注意 compareSemver 返回的是段差值（非 -1/0/1 符号化），故按符号断言。
  it('compares 4+ segment build versions', () => {
    assert.ok(compareSemver('1.2.3.4', '1.2.3') > 0)
    assert.ok(compareSemver('1.2.3', '1.2.3.4') < 0)
    assert.equal(compareSemver('1.2.3.4', '1.2.3.4'), 0)
    assert.ok(compareSemver('1.2.3.5', '1.2.3.4') > 0)
    assert.equal(compareSemver('1.2.3.0', '1.2.3'), 0)
  })
})

// issue #115 — /update 横幅告知「升级到 check.latest」，实际安装却写死 npm 'latest'
// dist-tag：npm 尚未发布该版本时用户被装回旧版（或直接失败），横幅却已承诺新版。
describe('updateInstallSpec', () => {
  it('returns the version the banner promised, without the v prefix', () => {
    assert.equal(updateInstallSpec('v3.18.2'), '3.18.2')
    assert.equal(updateInstallSpec('3.18.2'), '3.18.2')
    assert.equal(updateInstallSpec('v3.18.2-canary.1'), '3.18.2-canary.1')
  })
})

describe('formatDeclinedUpdate', () => {
  it('local 安装写明没装上、原因，以及全局和项目两条手动命令', () => {
    const lines = formatDeclinedUpdate({
      current: '3.27.0',
      latest: '3.28.0',
      packageName: 'tianshu-harness',
      kind: 'local',
    })
    const text = lines.join('\n')
    assert.match(text, /没有安装 3\.28\.0/)
    assert.match(text, /当前仍是 3\.27\.0/)
    assert.match(text, /原因：/)
    assert.match(text, /npm install -g tianshu-harness@3\.28\.0/)
    assert.match(text, /npm install tianshu-harness@3\.28\.0/)
    assert.doesNotMatch(text, /Run \/update/)
    assert.doesNotMatch(text, /Install source/)
  })

  it('无法判断安装方式时说明没有自动安装', () => {
    const text = formatDeclinedUpdate({
      current: '3.27.0',
      latest: 'v3.28.0',
      packageName: 'tianshu-harness',
      kind: 'unknown',
    }).join('\n')
    assert.match(text, /没有安装 v3\.28\.0/)
    assert.match(text, /无法判断/)
    assert.match(text, /npm install -g tianshu-harness@3\.28\.0/)
  })
})

describe('/update 不再复读启动横幅', () => {
  it('拒绝安装时走 formatDeclinedUpdate，不打印 Install source', () => {
    const src = readFileSync(new URL('../slash-commands.ts', import.meta.url), 'utf8')
    assert.match(src, /formatDeclinedUpdate\(/)
    assert.doesNotMatch(src, /Install source:/)
    assert.doesNotMatch(src, /formatUpdateBanner\(/)
  })
})

describe('buildWindowsSelfUpdateScript', () => {
  const base = {
    pid: 4242,
    packageName: 'tianshu-harness',
    channel: 'latest',
    npmPath: 'C:\\Program Files\\nodejs\\npm.cmd',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tianshu-harness\\dist\\main.js'],
    cwd: 'C:\\work\\proj',
    relaunch: true,
    logPath: 'C:\\Users\\me\\AppData\\Local\\.rivet\\update.log',
  }

  it('waits for the current pid before installing (release file lock)', () => {
    const script = buildWindowsSelfUpdateScript(base)
    assert.match(script, /Wait-Process -Id 4242/)
    // install must come after the wait so the process has exited
    assert.ok(script.indexOf('Wait-Process') < script.indexOf('npm install -g'))
    assert.match(script, /install -g 'tianshu-harness@latest'/)
  })

  // issue #124 — packageName@channel 裸插进命令行：含空格时 PowerShell 会把 spec
  // 拆成两个参数导致安装失败；同脚本其它参数都经 q() 单引号包裹，此处必须一致。
  it('quotes the package spec in the install line', () => {
    const script = buildWindowsSelfUpdateScript({ ...base, packageName: 'my pkg' })
    assert.match(script, /install -g 'my pkg@latest'/)
  })

  it('uses the provided absolute npm path instead of bare npm', () => {
    const script = buildWindowsSelfUpdateScript(base)
    assert.match(script, /& 'C:\\Program Files\\nodejs\\npm\.cmd' install -g/)
  })

  it('logs to the provided log path and creates the directory if needed', () => {
    const script = buildWindowsSelfUpdateScript(base)
    assert.match(script, /\$log = 'C:\\Users\\me\\AppData\\Local\\\.rivet\\update\.log'/)
    assert.match(script, /New-Item -ItemType Directory -Path \$logDir -Force/)
  })

  it('relaunches only on successful install and preserves argv', () => {
    const script = buildWindowsSelfUpdateScript(base)
    assert.match(script, /if \(\$code -ne 0\) \{ exit \$code \}/)
    assert.match(script, /Start-Process -FilePath 'C:\\Program Files\\nodejs\\node\.exe'/)
    assert.match(script, /dist\\main\.js/)
  })

  it('omits relaunch when relaunch=false', () => {
    const script = buildWindowsSelfUpdateScript({ ...base, relaunch: false })
    assert.ok(!script.includes('Start-Process'))
    assert.match(script, /npm install -g/)
  })

  it('escapes embedded single quotes in paths (PowerShell doubling)', () => {
    const script = buildWindowsSelfUpdateScript({
      ...base,
      execPath: "C:\\o'brien\\node.exe",
    })
    assert.match(script, /'C:\\o''brien\\node\.exe'/)
  })

  it('carries --resume <id> into the relaunch ArgumentList (escaped)', () => {
    const sid = 'abc123-def-456'
    const script = buildWindowsSelfUpdateScript({
      ...base,
      argv: withResumeArgs(base.argv, sid),
    })
    assert.match(script, /-ArgumentList @\(/)
    assert.match(script, /'--resume'/)
    assert.ok(script.includes(`'${sid}'`), 'session id present as a quoted arg')
  })
})

describe('withResumeArgs', () => {
  it('returns argv unchanged (minus session flags) when no sessionId', () => {
    assert.deepEqual(withResumeArgs(['dist/main.js']), ['dist/main.js'])
    assert.deepEqual(withResumeArgs(['dist/main.js', '--verbose']), ['dist/main.js', '--verbose'])
  })

  it('appends --resume <id> when sessionId given', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
  })

  it('strips pre-existing --new / --continue before appending current resume', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--new'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--continue'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
  })

  it('strips a stale --resume <oldid> (with its value) then appends current id', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--resume', 'old-id', '--verbose'], 'new-id'),
      ['dist/main.js', '--verbose', '--resume', 'new-id'],
    )
  })

  it('handles bare --resume with no following value', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--resume'], 'new-id'),
      ['dist/main.js', '--resume', 'new-id'],
    )
    // trailing --resume followed by another flag (not a value) — flag preserved
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--resume', '--verbose']),
      ['dist/main.js', '--verbose'],
    )
  })

  it('strips short flags -c and -r (with value) too', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '-c'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '-r', 'old-id', '--verbose'], 'new-id'),
      ['dist/main.js', '--verbose', '--resume', 'new-id'],
    )
    // 裸 -r（无值）也剔除
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '-r'], 'sid-2'),
      ['dist/main.js', '--resume', 'sid-2'],
    )
  })
})

describe('updater emitLines', () => {
  const collect = (text: string): string[] => {
    const out: string[] = []
    emitLines(text, (l) => out.push(l))
    return out
  }

  it('splits on LF and CRLF', () => {
    assert.deepEqual(collect('a\nb\r\nc'), ['a', 'b', 'c'])
  })

  it('drops the trailing empty line when text ends with a newline', () => {
    assert.deepEqual(collect('done\n'), ['done'])
    assert.deepEqual(collect('a\nb\n'), ['a', 'b'])
  })

  it('keeps interior blank lines', () => {
    assert.deepEqual(collect('a\n\nb'), ['a', '', 'b'])
  })

  it('is a no-op on empty input (decoder flush with nothing buffered)', () => {
    assert.deepEqual(collect(''), [])
  })
})

describe('updater WinStreamDecoder integration', () => {
  // The /update stream now routes child stdout/stderr bytes through
  // WinStreamDecoder before line-splitting. Guard the write→end contract:
  // clean UTF-8 fed as one chunk must round-trip losslessly with no duplicate
  // or dropped content on flush (the property updater relies on).
  it('round-trips clean UTF-8 across write + end', () => {
    const dec = new WinStreamDecoder()
    const msg = 'npm 安装完成 ✓\n更新成功'
    const out = dec.write(Buffer.from(msg, 'utf-8')) + dec.end()
    assert.equal(out, msg)
  })

  it('end() returns empty when nothing was written', () => {
    const dec = new WinStreamDecoder()
    assert.equal(dec.end(), '')
  })
})


describe('checkForUpdate cache behavior', () => {
  let tmpHome: string
  let origHome: string | undefined
  let origFetch: typeof globalThis.fetch

  before(() => {
    origHome = process.env.RIVET_HOME
    tmpHome = mkdtempSync(join(tmpdir(), 'rivet-update-test-'))
    process.env.RIVET_HOME = tmpHome
    origFetch = globalThis.fetch
  })

  after(() => {
    globalThis.fetch = origFetch
    if (origHome === undefined) {
      delete process.env.RIVET_HOME
    } else {
      process.env.RIVET_HOME = origHome
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('does not write cache when network request fails', async () => {
    // 使用 404 而非抛异常： fetchWithRetry 对 4xx 不重试，避免单测等待重试退避。
    globalThis.fetch = async () => new Response('not found', { status: 404 })
    const result = await checkForUpdate(undefined, { bypassCache: true })
    assert.equal(result, null)
    assert.equal(existsSync(join(tmpHome, 'update-check.json')), false)
  })

  it('writes cache when network request succeeds', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ version: '99.0.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const result = await checkForUpdate(undefined, { bypassCache: true })
    assert.ok(result)
    assert.equal(result!.hasUpdate, true)
    assert.equal(existsSync(join(tmpHome, 'update-check.json')), true)
  })
})

describe('fetchNpmLatestVersion proxy support', () => {
  let origFetch: typeof globalThis.fetch
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']
  const origProxyValues: Record<string, string | undefined> = {}
  let origNoSystemProxy: string | undefined

  before(() => {
    origFetch = globalThis.fetch
    // 系统代理（Windows 注册表 / macOS scutil）是环境变量之外的第二条代理通道——
    // 不清掉它，开了系统代理的机器上「无代理」用例永远拿到 ProxyAgent。
    origNoSystemProxy = process.env.RIVET_NO_SYSTEM_PROXY
    process.env.RIVET_NO_SYSTEM_PROXY = '1'
    for (const key of proxyKeys) {
      origProxyValues[key] = process.env[key]
      delete process.env[key]
    }
  })

  after(() => {
    globalThis.fetch = origFetch
    if (origNoSystemProxy === undefined) delete process.env.RIVET_NO_SYSTEM_PROXY
    else process.env.RIVET_NO_SYSTEM_PROXY = origNoSystemProxy
    for (const key of proxyKeys) {
      if (origProxyValues[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = origProxyValues[key]
      }
    }
  })

  it('uses ProxyAgent dispatcher when HTTPS_PROXY is set', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080'
    let capturedDispatcher: unknown
    globalThis.fetch = async (_url, init) => {
      capturedDispatcher = (init as { dispatcher?: unknown }).dispatcher
      return new Response(JSON.stringify({ version: '9.9.9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    await fetchNpmLatestVersion('tianshu-harness')
    assert.ok(capturedDispatcher instanceof ProxyAgent, 'expected ProxyAgent')
  })

  it('omits dispatcher when no proxy is configured', async () => {
    for (const key of proxyKeys) delete process.env[key]
    let capturedDispatcher: unknown = 'not-set'
    globalThis.fetch = async (_url, init) => {
      capturedDispatcher = (init as { dispatcher?: unknown }).dispatcher
      return new Response(JSON.stringify({ version: '9.9.9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    await fetchNpmLatestVersion('tianshu-harness')
    assert.equal(capturedDispatcher, undefined)
  })

  it('respects NO_PROXY for registry hostname', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080'
    process.env.NO_PROXY = 'registry.npmjs.org'
    let capturedDispatcher: unknown = 'not-set'
    globalThis.fetch = async (_url, init) => {
      capturedDispatcher = (init as { dispatcher?: unknown }).dispatcher
      return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
    }
    await fetchNpmLatestVersion('tianshu-harness')
    assert.equal(capturedDispatcher, undefined)
  })
})

describe('non-JSON 200 responses (proxy interception)', () => {
  let origFetch: typeof globalThis.fetch
  let origNoSystemProxy: string | undefined

  before(() => {
    origFetch = globalThis.fetch
    // 与 proxy 套件同纪律：屏蔽系统代理通道（Windows 注册表 / macOS scutil），
    // 保证 mock fetch 是唯一网络入口，避免真代理干扰断言。
    origNoSystemProxy = process.env.RIVET_NO_SYSTEM_PROXY
    process.env.RIVET_NO_SYSTEM_PROXY = '1'
  })

  after(() => {
    globalThis.fetch = origFetch
    if (origNoSystemProxy === undefined) delete process.env.RIVET_NO_SYSTEM_PROXY
    else process.env.RIVET_NO_SYSTEM_PROXY = origNoSystemProxy
  })

  // 代理/网关劫持时可能以 200 返回 GBK 编码的 HTML 错误页（Windows 代码页 936 常见），
  // res.json() 会抛 SyntaxError —— 两处 fetch 都必须吞掉并返回 null，
  // 否则 /update 命令以 unhandled promise rejection 崩溃。
  it('fetchNpmLatestVersion returns null on HTML body with 200', async () => {
    globalThis.fetch = async () =>
      new Response('<html><body>proxy error</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=GBK' },
      })
    assert.equal(await fetchNpmLatestVersion('tianshu-harness'), null)
  })

  it('fetchNpmLatestVersion returns null on non-UTF-8 bytes', async () => {
    // GBK 编码的中文（非合法 UTF-8），复现 "Unexpected token ''" 现场。
    // 用显式字节构造，不依赖运行平台（Windows/macOS）的默认代码页。
    globalThis.fetch = async () =>
      new Response(Buffer.from([0xb4, 0xed, 0xce, 0xf3, 0xd2, 0xb3, 0xc3, 0xe6]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    assert.equal(await fetchNpmLatestVersion('tianshu-harness'), null)
  })

  it('fetchGitHubLatestVersion returns null on HTML body with 200', async () => {
    globalThis.fetch = async () =>
      new Response('<html><body>blocked</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    assert.equal(await fetchGitHubLatestVersion('owner', 'repo'), null)
  })

  it('fetchGitHubLatestVersion returns null on non-UTF-8 bytes', async () => {
    globalThis.fetch = async () =>
      new Response(Buffer.from([0xb4, 0xed, 0xce, 0xf3, 0xd2, 0xb3, 0xc3, 0xe6]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    assert.equal(await fetchGitHubLatestVersion('owner', 'repo'), null)
  })
})

describe('npmPackageExists', () => {
  let origFetch: typeof globalThis.fetch

  before(() => {
    origFetch = globalThis.fetch
  })

  after(() => {
    globalThis.fetch = origFetch
  })

  it('uses GET instead of HEAD to avoid proxy interception', async () => {
    let method: string | undefined
    globalThis.fetch = async (_url, init) => {
      method = (init as { method?: string }).method
      return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
    }
    await npmPackageExists('tianshu-harness')
    assert.equal(method, 'GET')
  })
})

// ─── 更新版本规格白名单：远端版本不得拼进 shell 命令 ───
// /update 的 POSIX 全局安装走 spawn(command, { shell: true })，版本字符串
// 来自 registry / GitHub releases 的 JSON。此前只判 typeof string，而
// parseSemver 会把 '9.9.9; <命令>' 宽松解析为 9.9.9 通过 hasUpdate 判定，
// 随后 shell 把它拆成两条命令执行——恶意镜像/代理返回 crafted 版本即可
// 在用户运行 /update 时拿到命令执行。白名单字符集不含任何 shell 元字符。
describe('update version spec whitelist', () => {
  let origFetch: typeof globalThis.fetch
  let origNoSystemProxy: string | undefined

  before(() => {
    origFetch = globalThis.fetch
    origNoSystemProxy = process.env.RIVET_NO_SYSTEM_PROXY
    process.env.RIVET_NO_SYSTEM_PROXY = '1'
  })

  after(() => {
    globalThis.fetch = origFetch
    if (origNoSystemProxy === undefined) delete process.env.RIVET_NO_SYSTEM_PROXY
    else process.env.RIVET_NO_SYSTEM_PROXY = origNoSystemProxy
  })

  it('accepts plain, canary, prerelease and build-metadata versions', () => {
    for (const v of ['3.37.4', '1.2.3.4', '3.0.0-beta.2', 'v3.37.4', '3.0.0+build.1', '3.0.0-rc.1+sha.abc']) {
      assert.equal(isValidUpdateVersion(v), true, v)
    }
  })

  it('rejects shell metacharacters and non-version specs', () => {
    for (const v of ['9.9.9; echo pwned', '1.2.3$(id)', '1.2.3`id`', '1.2.3 && rm -rf /', '1.2.3|cat', '1.2', 'latest', '', '3.37.4 ', '3.37.4\nrm']) {
      assert.equal(isValidUpdateVersion(v), false, JSON.stringify(v))
    }
  })

  it('fetchNpmLatestVersion ignores a crafted version from every mirror', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ version: '9.9.9; echo pwned' }), { status: 200 })
    assert.equal(await fetchNpmLatestVersion('tianshu-harness'), null)
  })

  it('fetchGitHubLatestVersion ignores a crafted tag', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: 'v9.9.9$(id)', published_at: '2026-10-31T00:00:00Z' }), { status: 200 })
    assert.equal(await fetchGitHubLatestVersion('owner', 'repo'), null)
  })

  it('runUpdate refuses a crafted channel before any network request', async () => {
    // 全局安装判定：包根落在 `npm prefix -g`/node_modules 下即为 global。
    // 在全局前缀下建临时包根（finally 清理），不碰任何已装包。
    let prefix: string | null = null
    try {
      prefix = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 5_000 }).trim() || null
    } catch {
      prefix = null
    }
    if (!prefix) return
    const root = join(prefix, 'node_modules', 'rivet-update-spec-test')
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'rivet-update-spec-test', version: '1.0.0' }))
      globalThis.fetch = async () => { throw new Error('must not fetch') }
      const lines: string[] = []
      const result = await runUpdate(root, '9.9.9; echo pwned', (line) => { lines.push(line) })
      assert.equal(result.ok, false)
      assert.match(result.message, /unsafe/)
      assert.equal(lines.length, 0)
    } finally {
      globalThis.fetch = origFetch
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─── 包根解析：dist/ 的 ESM 声明不得劫持安装根 ───
// dist/package.json 只含 {"type":"module"}（stage-runtime-deps.js 为「dist 脱离仓库
// 独立分发」而写）。若实现是「向上找到第一个 package.json 就返回」，就会停在
// <root>/dist：getCurrentVersion → null、readPackageName → null、detectInstallType
// 误判为 local。表现为欢迎页版本号消失、自动更新检查拿不到包名。
describe('detectInstallRoot 不被 dist 的 ESM 声明劫持', () => {
  /** 造一棵最小安装树：根有真包声明，dist/ 只有 ESM 声明。 */
  function makeInstallTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'rivet-install-root-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tianshu-harness', version: '9.9.9' }))
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true })
    writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'module' }))
    // 入口文件必须真实存在——detectInstallRoot 对 argv[1] 做 realpathSync，
    // 路径不存在会直接 catch → null（那会让测试红在探针上而不是被测行为上）。
    writeFileSync(join(root, 'dist', 'main.js'), '')
    writeFileSync(join(root, 'dist', 'cli', 'entry.js'), '')
    return root
  }

  // realpath 归一化：macOS 的 /var 是 /private/var 的 symlink，
  // findInstallRoot 返回的是 realpath 展开后的祖先目录。
  it('入口位于 dist/ 时返回真正的包根而非 dist', () => {
    const root = makeInstallTree()
    try {
      assert.equal(detectInstallRoot(join(root, 'dist', 'main.js')), realpathSync(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('入口位于 dist/cli/ 时同样返回包根', () => {
    const root = makeInstallTree()
    try {
      assert.equal(detectInstallRoot(join(root, 'dist', 'cli', 'entry.js')), realpathSync(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // 下游消费方的前提：返回的根必须真能读出 name/version。
  // readPackageName → null 与 detectInstallType → local 都是「根错了」的症状，
  // 所以断言 root 可被它们消费，而不是只断言路径相等。
  it('返回的根可被消费方读出 name 与 version', () => {
    const root = makeInstallTree()
    try {
      const resolved = detectInstallRoot(join(root, 'dist', 'main.js'))
      assert.ok(resolved, '包根不应为 null')
      const pkg = JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf-8')) as { name?: string }
      assert.equal(pkg.name, 'tianshu-harness')
      assert.equal(getCurrentVersion(resolved), '9.9.9')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // 默认参数接线：发布态 bin 不传路径，靠 process.argv[1]。
  // 只有这条用例需要动 argv——其余走显式参数，不污染进程全局。
  it('无参调用时默认读 process.argv[1]', () => {
    const root = makeInstallTree()
    const origArgv1 = process.argv[1]
    try {
      process.argv[1] = join(root, 'dist', 'cli', 'entry.js')
      assert.equal(detectInstallRoot(), realpathSync(root))
    } finally {
      // noUncheckedIndexedAccess：argv[1] 类型是 string | undefined，
      // 原值缺失时要 delete 而不是赋 undefined。
      if (origArgv1 === undefined) delete process.argv[1]
      else process.argv[1] = origArgv1
      rmSync(root, { recursive: true, force: true })
    }
  })

  // runtime bundle 的布局没有根级 package.json（build-runtime-bundle.sh 只写
  // version.txt），若它被解压进一个自带 package.json 的目录树，仅凭「有无 version」
  // 判定会继续上溯到那个无关项目，把它的版本当成本包版本显示出来——比 null 更坏。
  it('祖先链上的无关包声明不会被误认成本包根', () => {
    const outer = mkdtempSync(join(tmpdir(), 'rivet-outer-'))
    try {
      writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'my-own-app', version: '0.0.1' }))
      const bundle = join(outer, 'tools', 'tianshu-runtime-9.9.9')
      mkdirSync(join(bundle, 'dist', 'cli'), { recursive: true })
      writeFileSync(join(bundle, 'dist', 'package.json'), JSON.stringify({ type: 'module' }))
      writeFileSync(join(bundle, 'dist', 'cli', 'entry.js'), '')
      assert.equal(detectInstallRoot(join(bundle, 'dist', 'cli', 'entry.js')), null)
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })
})
