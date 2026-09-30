import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { findSystemChromium, resolveChromiumBinary } from '../playwright-driver.js'

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

test('resolveChromiumBinary prefers the playwright download when present', () => {
  // 用测试文件自身作为"存在的文件"——跨平台可用的真实路径。
  const self = fileURLToPath(import.meta.url)
  const mod = { chromium: { executablePath: () => self } }
  const r = resolveChromiumBinary(mod, () => '/usr/bin/chromium')
  assert.equal(r.source, 'playwright')
  assert.equal(r.executablePath, self)
})

test('resolveChromiumBinary falls back to the system browser when the download is missing', () => {
  const mod = { chromium: { executablePath: () => '/definitely/missing/playwright/chromium' } }
  const r = resolveChromiumBinary(mod, () => '/usr/bin/chromium')
  assert.equal(r.source, 'system')
  assert.equal(r.executablePath, '/usr/bin/chromium')
})

test('resolveChromiumBinary reports missing when neither source exists', () => {
  const mod = { chromium: { executablePath: () => '/definitely/missing/playwright/chromium' } }
  assert.deepEqual(resolveChromiumBinary(mod, () => undefined), { source: 'missing' })
})

test('resolveChromiumBinary tolerates executablePath() throwing and still finds the system browser', () => {
  const mod = {
    chromium: {
      executablePath: () => {
        throw new Error('registry misconfigured')
      },
    },
  }
  const r = resolveChromiumBinary(mod, () => '/usr/bin/chromium')
  assert.equal(r.source, 'system')
})
