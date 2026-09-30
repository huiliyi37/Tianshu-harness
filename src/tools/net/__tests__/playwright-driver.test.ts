import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  findSystemChromium,
  headlessShellCandidates,
  resolveChromiumBinary,
} from '../playwright-driver.js'

// issue #302 — Linux 用户系统已装 chromium（/usr/bin/chromium），但 playwright
// 下载版缺失时检测报"未安装"、启动失败。这里钉住系统浏览器探测的路径表与
// 选择顺序（playwright 下载版优先、系统安装版兜底）。

test('findSystemChromium picks the first existing candidate on Linux', () => {
  assert.equal(
    findSystemChromium('linux', (p) => p === '/usr/bin/chromium', {}),
    '/usr/bin/chromium',
  )
})

test('findSystemChromium probes Debian-style chromium-browser and snap paths', () => {
  assert.equal(
    findSystemChromium('linux', (p) => p === '/usr/bin/chromium-browser', {}),
    '/usr/bin/chromium-browser',
  )
  assert.equal(
    findSystemChromium('linux', (p) => p === '/snap/bin/chromium', {}),
    '/snap/bin/chromium',
  )
  // Chrome 系兜底：只装了 Google Chrome 的机器同样可用
  assert.equal(
    findSystemChromium('linux', (p) => p === '/usr/bin/google-chrome-stable', {}),
    '/usr/bin/google-chrome-stable',
  )
})

test('findSystemChromium resolves Windows Chrome under ProgramFiles', () => {
  const env = {
    PROGRAMFILES: 'C:/PF',
    'PROGRAMFILES(X86)': 'C:/PF86',
    LOCALAPPDATA: 'C:/LA',
  }
  assert.equal(
    findSystemChromium('win32', (p) => p === 'C:/PF/Google/Chrome/Application/chrome.exe', env),
    'C:/PF/Google/Chrome/Application/chrome.exe',
  )
  assert.equal(
    findSystemChromium('win32', (p) => p === 'C:/LA/Chromium/Application/chrome.exe', env),
    'C:/LA/Chromium/Application/chrome.exe',
  )
})

test('findSystemChromium resolves macOS app bundle paths', () => {
  assert.equal(
    findSystemChromium('darwin', (p) => p === '/Applications/Chromium.app/Contents/MacOS/Chromium', {}),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  )
})

test('findSystemChromium returns undefined when nothing exists or platform is unknown', () => {
  assert.equal(findSystemChromium('linux', () => false, {}), undefined)
  assert.equal(findSystemChromium('aix' as NodeJS.Platform, () => true, {}), undefined)
})

// issue #302（同族，headless shell）——probe 查的是 chromium-<rev>/chrome.exe，
// 而 launch({headless:true}) 实际执行 chromium_headless_shell-<rev>。两者不同文件，
// 导致「只有完整版」时谎报就绪、「只有 shell」时能用却报未安装。这里钉住从完整版
// 路径推导 shell 候选的规律（layout 取自 playwright 自身 EXECUTABLE_PATHS 表）。

test('headlessShellCandidates derives the Windows shell path from the full chromium path', () => {
  const full = 'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
  const c = headlessShellCandidates(full)
  assert.ok(
    c.includes(
      'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
    ),
    `应含 Win 布局候选，实得：${JSON.stringify(c)}`,
  )
})

test('headlessShellCandidates covers Linux x64 and arm64 layouts', () => {
  const full = '/home/u/.cache/ms-playwright/chromium-1179/chrome-linux64/chrome'
  const c = headlessShellCandidates(full)
  assert.ok(c.includes('/home/u/.cache/ms-playwright/chromium_headless_shell-1179/chrome-headless-shell-linux64/chrome-headless-shell'))
  assert.ok(c.includes('/home/u/.cache/ms-playwright/chromium_headless_shell-1179/chrome-linux/headless_shell'))
})

test('headlessShellCandidates covers macOS layouts', () => {
  const full = '/Users/u/Library/Caches/ms-playwright/chromium-1179/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  const c = headlessShellCandidates(full)
  assert.ok(c.includes('/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1179/chrome-headless-shell-mac-arm64/chrome-headless-shell'))
  assert.ok(c.includes('/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1179/chrome-headless-shell-mac-x64/chrome-headless-shell'))
})

test('headlessShellCandidates returns [] when the path has no chromium-<rev> segment', () => {
  assert.deepEqual(headlessShellCandidates('/opt/somewhere/chrome'), [])
  assert.deepEqual(headlessShellCandidates(''), [])
})

const shellOf = (full: string): string => headlessShellCandidates(full)[0]!

test('resolveChromiumBinary (headless) picks the headless shell when present', () => {
  const full = '/r/chromium-1234/chrome-linux64/chrome'
  const shell = shellOf(full)
  const r = resolveChromiumBinary(
    { chromium: { executablePath: () => full } },
    { headless: true, exists: (p) => p === full || p === shell, findSystem: () => undefined },
  )
  assert.equal(r.source, 'playwright')
  assert.equal(r.executablePath, shell)
})

test('resolveChromiumBinary (headless) falls back to the FULL chromium when the shell is missing (#302 场景 A)', () => {
  const full = '/r/chromium-1234/chrome-linux64/chrome'
  const r = resolveChromiumBinary(
    { chromium: { executablePath: () => full } },
    { headless: true, exists: (p) => p === full, findSystem: () => undefined },
  )
  assert.equal(r.source, 'playwright')
  assert.equal(r.executablePath, full)
})

test('resolveChromiumBinary (headless) falls back to the system browser', () => {
  const full = '/r/chromium-1234/chrome-linux64/chrome'
  const r = resolveChromiumBinary(
    { chromium: { executablePath: () => full } },
    { headless: true, exists: () => false, findSystem: () => '/usr/bin/chromium' },
  )
  assert.equal(r.source, 'system')
  assert.equal(r.executablePath, '/usr/bin/chromium')
})

test('resolveChromiumBinary (headless) reports missing when nothing exists', () => {
  const r = resolveChromiumBinary(
    { chromium: { executablePath: () => '/r/chromium-1234/chrome-linux64/chrome' } },
    { headless: true, exists: () => false, findSystem: () => undefined },
  )
  assert.equal(r.source, 'missing')
  assert.equal(r.executablePath, undefined)
})

test('resolveChromiumBinary (headed) prefers the full chromium, never the shell', () => {
  const full = '/r/chromium-1234/chrome-linux64/chrome'
  const shell = shellOf(full)
  const r = resolveChromiumBinary(
    { chromium: { executablePath: () => full } },
    { headless: false, exists: (p) => p === full || p === shell, findSystem: () => undefined },
  )
  assert.equal(r.source, 'playwright')
  assert.equal(r.executablePath, full)
})

test('resolveChromiumBinary tolerates executablePath() throwing and still finds the system browser', () => {
  const mod = {
    chromium: {
      executablePath: () => {
        throw new Error('registry misconfigured')
      },
    },
  }
  const r = resolveChromiumBinary(mod, { headless: true, exists: () => false, findSystem: () => '/usr/bin/chromium' })
  assert.equal(r.source, 'system')
})

test('resolveChromiumBinary uses a real file as the playwright download (self-check on this machine)', () => {
  const self = fileURLToPath(import.meta.url)
  const r = resolveChromiumBinary({ chromium: { executablePath: () => self } }, { headless: true, findSystem: () => '/usr/bin/chromium' })
  assert.equal(r.source, 'playwright')
  assert.equal(r.executablePath, self)
})