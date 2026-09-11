import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBrowserMissingBanner, probeChromium, type ChromiumProbe } from '../browser-readiness.js'

test('banner is empty when chromium is installed', () => {
  assert.equal(formatBrowserMissingBanner({ state: 'ready', installed: true, executablePath: '/x' }), '')
})

test('browser-missing banner points to the one-shot command + manual fallback', () => {
  const b = formatBrowserMissingBanner({ state: 'browser-missing', installed: false })
  assert.match(b, /rivet browser install/)
  assert.match(b, /chromium/)
  // manual fallback carries the mirror env for CN users
  // the manual command is pinned to the embedded playwright-core version (#102)
  assert.match(b, /npx playwright(@\d+\.\d+\.\d+)? install chromium/)
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
