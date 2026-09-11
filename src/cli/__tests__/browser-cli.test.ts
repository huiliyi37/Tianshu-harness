import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInstallPlan,
  runBrowserCLI,
  runBrowserStatus,
  PLAYWRIGHT_MIRROR_HOST,
} from '../browser-cli.js'

test('buildInstallPlan injects the CN mirror host by default', () => {
  const plan = buildInstallPlan([], 'darwin', null)
  assert.deepEqual(plan.args, ['playwright', 'install', 'chromium'])
  assert.equal(plan.env.PLAYWRIGHT_DOWNLOAD_HOST, PLAYWRIGHT_MIRROR_HOST)
  assert.equal(plan.command, 'npx')
})

test('buildInstallPlan pins playwright to the given version (#102)', () => {
  // 就绪检测按内嵌 playwright-core 的 browsers.json 找 revision；不钉版本的 npx
  // 会装最新 playwright 的另一个 revision，装完仍报未安装。
  const plan = buildInstallPlan([], 'darwin', '1.62.0')
  assert.deepEqual(plan.args, ['playwright@1.62.0', 'install', 'chromium'])
})

test('buildInstallPlan defaults to the embedded playwright-core version', () => {
  const embedded = createRequire(import.meta.url)('playwright-core/package.json') as { version: string }
  const plan = buildInstallPlan([], 'darwin')
  assert.deepEqual(plan.args, [`playwright@${embedded.version}`, 'install', 'chromium'])
})

test('buildInstallPlan --no-mirror drops the mirror env (official source)', () => {
  const plan = buildInstallPlan(['--no-mirror'], 'darwin')
  assert.equal('PLAYWRIGHT_DOWNLOAD_HOST' in plan.env, false)
})

test('buildInstallPlan uses npx.cmd on Windows', () => {
  assert.equal(buildInstallPlan([], 'win32').command, 'npx.cmd')
  assert.equal(buildInstallPlan([], 'linux').command, 'npx')
})

test('runBrowserStatus returns 0/1 matching install state and writes something', async () => {
  let out = ''
  const code = await runBrowserStatus((s) => { out += s })
  assert.ok(out.length > 0)
  assert.ok(code === 0 || code === 1)
  // on this machine chromium is installed → expect ready
  if (code === 0) assert.match(out, /就绪/)
  else assert.match(out, /rivet browser install|playwright-core/)
})

test('runBrowserCLI prints usage for no subcommand (exit 0) and unknown (exit 1)', async () => {
  let out = ''
  const help = await runBrowserCLI([], (s) => { out += s })
  assert.equal(help, 0)
  assert.match(out, /rivet browser/)

  out = ''
  const unknown = await runBrowserCLI(['frobnicate'], (s) => { out += s })
  assert.equal(unknown, 1)
})

test('runBrowserCLI routes status/check to the probe', async () => {
  let out = ''
  const code = await runBrowserCLI(['status'], (s) => { out += s })
  assert.ok(code === 0 || code === 1)
  assert.ok(out.length > 0)
})
