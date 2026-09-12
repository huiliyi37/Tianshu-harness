import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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

describe('buildWindowsSelfUpdateScript', () => {
  const base = {
    pid: 4242,
    packageName: 'tianshu-tui',
    channel: 'latest',
    npmPath: 'C:\\Program Files\\nodejs\\npm.cmd',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tianshu-tui\\dist\\main.js'],
    cwd: 'C:\\work\\proj',
    relaunch: true,
    logPath: 'C:\\Users\\me\\AppData\\Local\\.rivet\\update.log',
  }

  it('waits for the current pid before installing (release file lock)', () => {
    const script = buildWindowsSelfUpdateScript(base)
    assert.match(script, /Wait-Process -Id 4242/)
    // install must come after the wait so the process has exited
    assert.ok(script.indexOf('Wait-Process') < script.indexOf('npm install -g'))
    assert.match(script, /install -g 'tianshu-tui@latest'/)
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
    await fetchNpmLatestVersion('tianshu-tui')
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
    await fetchNpmLatestVersion('tianshu-tui')
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
    await fetchNpmLatestVersion('tianshu-tui')
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
    assert.equal(await fetchNpmLatestVersion('tianshu-tui'), null)
  })

  it('fetchNpmLatestVersion returns null on non-UTF-8 bytes', async () => {
    // GBK 编码的中文（非合法 UTF-8），复现 "Unexpected token ''" 现场。
    // 用显式字节构造，不依赖运行平台（Windows/macOS）的默认代码页。
    globalThis.fetch = async () =>
      new Response(Buffer.from([0xb4, 0xed, 0xce, 0xf3, 0xd2, 0xb3, 0xc3, 0xe6]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    assert.equal(await fetchNpmLatestVersion('tianshu-tui'), null)
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
    await npmPackageExists('tianshu-tui')
    assert.equal(method, 'GET')
  })
})
