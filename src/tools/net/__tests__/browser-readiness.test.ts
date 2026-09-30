import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { formatBrowserMissingBanner, probeChromium, type ChromiumProbe } from '../browser-readiness.js'

test('banner is empty when chromium is installed', () => {
  assert.equal(formatBrowserMissingBanner({ state: 'ready', installed: true, executablePath: '/x' }), '')
})

test('browser-missing banner points to the one-shot command + manual fallback', () => {
  const b = formatBrowserMissingBanner({ state: 'browser-missing', installed: false })
  assert.match(b, /rivet browser install/)
  assert.match(b, /chromium/)
  // manual fallback carries the mirror env for CN users
  // 收编迭代（PR #109 审查①）：钉版硬断言替代可选正则——manual 命令必须钉在
  // 内嵌 playwright-core 版本上，否则装出别的 revision、检测仍报未安装（#102）。
  const embedded = createRequire(import.meta.url)('playwright-core/package.json') as { version: string }
  assert.ok(
    b.includes(`npx playwright@${embedded.version} install chromium`),
    `banner 应含钉版手动命令 playwright@${embedded.version}：${b}`,
  )
})

test('module-missing banner does NOT tell the user to install a browser', () => {
  const b = formatBrowserMissingBanner({ state: 'module-missing', installed: false, reason: 'Cannot find module' })
  assert.match(b, /playwright-core/)
  assert.doesNotMatch(b, /rivet browser install/)
  // 引导安装 playwright-core 而非 chromium
  assert.match(b, /npm i playwright-core/)
  // 覆盖 CLI 安装用户
  assert.match(b, /CLI 安装用户/)
  assert.match(b, /原始错误/)
})

test('probeChromium returns a well-formed three-state result on this machine', async () => {
  const p: ChromiumProbe = await probeChromium()
  assert.ok(['ready', 'browser-missing', 'module-missing'].includes(p.state))
  assert.equal(typeof p.installed, 'boolean')
  // installed ⟺ state==='ready'
  assert.equal(p.installed, p.state === 'ready')
  if (p.installed) assert.ok(p.executablePath, 'ready probe carries an executablePath')
})

// NOTE: probeChromium 的 browser-missing 分支已用**子进程**（PLAYWRIGHT_BROWSERS_PATH
// 指向空目录，进程启动前注入）实测验证——playwright-core 在模块加载时读取该 env 并缓存，
// 同进程内运行时改 env 不生效，故这里不用 in-process env mutation 重测（会误判为 ready）。
// browser-missing 的**结构**（banner 文案、三态字段）由上面的纯函数测试覆盖。

// issue #302 — 系统已装 chromium（playwright 下载版缺失）时，探测必须报就绪并
// 标出来源，而不是把用户引向无用的"未安装"引导。注入而非 env 技巧：同进程内
// 换不了 playwright 已缓存的 browsers 路径（见上方 NOTE），注入是唯一可测路径。
test('probeChromium reports ready with source=system when only a system browser exists (#302)', async () => {
  const p = await probeChromium({
    loadModule: async () => ({ chromium: { executablePath: () => '/missing/playwright/chromium' } }),
    findSystem: () => '/usr/bin/chromium',
  })
  assert.equal(p.state, 'ready')
  assert.equal(p.installed, true)
  assert.equal(p.source, 'system')
  assert.equal(p.executablePath, '/usr/bin/chromium')
})

test('probeChromium marks the playwright download source when present', async () => {
  const self = fileURLToPath(import.meta.url)
  const p = await probeChromium({
    loadModule: async () => ({ chromium: { executablePath: () => self } }),
    findSystem: () => '/usr/bin/chromium',
  })
  assert.equal(p.state, 'ready')
  assert.equal(p.source, 'playwright')
})

test('probeChromium stays browser-missing when neither source exists', async () => {
  const p = await probeChromium({
    loadModule: async () => ({ chromium: { executablePath: () => '/missing/playwright/chromium' } }),
    findSystem: () => undefined,
  })
  assert.equal(p.state, 'browser-missing')
  assert.equal(p.installed, false)
})

test('probeChromium keeps module-missing semantics with an injected loader', async () => {
  const p = await probeChromium({
    loadModule: async () => {
      throw new Error('Cannot find module playwright-core')
    },
  })
  assert.equal(p.state, 'module-missing')
  assert.match(p.reason ?? '', /Cannot find module/)
})
