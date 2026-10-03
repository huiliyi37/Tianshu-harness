import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSystemChromium, pickBrowserPath, resolveLaunchExecutablePath } from '../playwright-driver.js'

function makePathDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pw-locate-'))
  for (const f of files) {
    const p = join(dir, f)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '#!/bin/sh\n')
  }
  return dir
}

test('findSystemChromium 在 PATH 目录里命中候选名（#303 发行版 chromium 场景）', () => {
  const dir = makePathDir(['chromium'])
  const hit = findSystemChromium('linux', `/usr/local/bin:${dir}:/usr/bin`, () => true)
  // exists 注入恒真 → 第一个 PATH 目录的第一候选即命中
  assert.equal(hit, '/usr/local/bin/chromium')
})

test('exists 判定生效：跳过不存在的条目，命中真实存在的', () => {
  // 'linux' 语义的 PATH 段须为 POSIX 形状：临时目录带 Windows 盘符（`C:\…`）
  // 时，盘符冒号会被 ':' 分隔符切坏、全部候选 miss（恒红，与 exists 判定
  // 语义无关）。exists 注入精确匹配 → 前两个候选跳过、google-chrome 命中。
  const dir = '/opt/browsers'
  const chrome = `${dir}/google-chrome`
  const hit = findSystemChromium('linux', dir, (p) => p === chrome)
  assert.equal(hit, chrome)
})

test('PATH 找不到时回落平台常用安装位', () => {
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  const hit = findSystemChromium('darwin', '/nonexistent', (p) => p === edge)
  assert.equal(hit, edge)
})

test('win32：候选带 .exe 后缀、PATH 用 ; 分隔', () => {
  const dir = makePathDir(['msedge.exe'])
  // 真实存在性判定：第一段 C:\nope 全 miss（证明 ; 分隔生效），目录里只有真实
  // 的 msedge.exe 文件，候选扫到它才命中（证明 win32 候选带 .exe 后缀）。
  const hit = findSystemChromium('win32', `C:\\nope;${dir}`, existsSync)
  assert.equal(hit, `${dir}/msedge.exe`)
})

test('候选顺序：chromium 系优先于 google-chrome', () => {
  // PATH 段须与 'linux' 语义自洽（':' 分隔、POSIX 形状）：临时目录带 Windows
  // 盘符（`C:\…`）时，盘符冒号被当作分隔符切出 `C` 段、返回畸形成员（恒红，
  // 与候选顺序的语义无关）。
  const dir = '/opt/browsers'
  const hit = findSystemChromium('linux', dir, () => true)
  assert.equal(hit, `${dir}/chromium`)
})

test('什么都没有 → undefined（调用方报 browser-missing）', () => {
  assert.equal(findSystemChromium('linux', '', () => false), undefined)
  assert.equal(findSystemChromium('linux', '/nonexistent:/also-nope', () => false), undefined)
})

// ==== 收编公开仓 PR #320：launch 判据（显式 → 托管 → 系统）====
// 探测侧 resolveChromiumProbe 与这里共用同一判据——check/use 一致（#302）。

test('#320: resolveLaunchExecutablePath——显式指定优先，原样透传（不做存在性预检）', () => {
  const hit = resolveLaunchExecutablePath(
    { executablePath: () => '/managed/chrome' },
    '/explicit/chrome',
    () => '/sys/chromium',
  )
  assert.equal(hit, '/explicit/chrome')
})

test('#320: 托管缓存存在 → 用托管 full chromium（显式透传绕开 headless-shell 错位）', () => {
  const dir = makePathDir(['chrome'])
  const managed = join(dir, 'chrome')
  const hit = resolveLaunchExecutablePath(
    { executablePath: () => managed },
    undefined,
    () => '/sys/chromium',
  )
  assert.equal(hit, managed)
})

test('#320: 托管缓存缺失 → 系统浏览器兜底', () => {
  const hit = resolveLaunchExecutablePath(
    { executablePath: () => '/nonexistent/pw/chrome' },
    undefined,
    () => '/usr/bin/chromium',
  )
  assert.equal(hit, '/usr/bin/chromium')
})

test('#320: executablePath() 抛错 → 系统浏览器兜底', () => {
  const hit = resolveLaunchExecutablePath(
    {
      executablePath: () => {
        throw new Error('registry boom')
      },
    },
    undefined,
    () => '/usr/bin/chromium',
  )
  assert.equal(hit, '/usr/bin/chromium')
})

test('#320: 两边都没有 → undefined（回落 registry 默认解析）；方法缺省同样兜底', () => {
  assert.equal(
    resolveLaunchExecutablePath({ executablePath: () => '/nonexistent' }, undefined, () => undefined),
    undefined,
  )
  // executablePath 方法可缺省（browser-debug 的测试桩 / connectOverCDP 场景）
  assert.equal(resolveLaunchExecutablePath({}, undefined, () => undefined), undefined)
})

// ==== 2026-10-02 审查收口：pickBrowserPath 共享内核（探测/启动单一判据） ====
// 探测侧 resolveChromiumProbe 与启动侧 resolveLaunchExecutablePath 都经此实现——
// 「声称共用、实为两份」的审查发现由此关闭；判据改一处即两侧生效。

test('pickBrowserPath：托管存在 → playwright（优先于系统）', () => {
  const dir = makePathDir(['chrome'])
  const managed = join(dir, 'chrome')
  assert.deepEqual(pickBrowserPath(managed, '/usr/bin/chromium'), {
    executablePath: managed,
    source: 'playwright',
  })
})

test('pickBrowserPath：托管缺失 → 系统兜底（source=system）', () => {
  assert.deepEqual(pickBrowserPath('/nonexistent/pw/chrome', '/usr/bin/chromium'), {
    executablePath: '/usr/bin/chromium',
    source: 'system',
  })
})

test('pickBrowserPath：双缺 → 空（调用方各自回落 browser-missing / registry 默认）', () => {
  assert.deepEqual(pickBrowserPath('/nonexistent/pw/chrome', undefined), {})
  assert.deepEqual(pickBrowserPath(undefined, undefined), {})
})
