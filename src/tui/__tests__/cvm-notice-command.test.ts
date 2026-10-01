/**
 * `/cvm` — 级别开关命令（issue #247 第 2 条）。
 *
 * 分两层：纯函数（解析 / 循环 / 回执文案）+ 注册契约与 handler 行为。
 * 最后三条是 app 层集成——开关真的能拦住渲染，而不只是改了个字段。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../engine/app.js'
import { MockOut, MockIn } from '../engine/__tests__/_harness.js'
import { describeCvmGate, nextCvmGate, parseCvmGate, registerCvmNoticeCommand } from '../cvm-notice-command.js'
import type { CvmNoticeGate } from '../../agent/cvm-notice.js'
import type { CvmInterceptionNotice } from '../../agent/cvm-notice.js'

// ── 纯函数 ──────────────────────────────────────────────────────

test('parseCvmGate：只认四档，其余返回 null（交给无参循环）', () => {
  assert.equal(parseCvmGate('off'), 'off')
  assert.equal(parseCvmGate('intercept'), 'intercept')
  assert.equal(parseCvmGate('WARN'), 'warn', '大小写不敏感')
  assert.equal(parseCvmGate('all'), 'all')
  assert.equal(parseCvmGate('silent'), null)
  assert.equal(parseCvmGate(undefined), null)
  assert.equal(parseCvmGate(''), null)
})

test('nextCvmGate 循环：off → intercept → warn → all → off', () => {
  assert.equal(nextCvmGate('off'), 'intercept')
  assert.equal(nextCvmGate('intercept'), 'warn')
  assert.equal(nextCvmGate('warn'), 'all')
  assert.equal(nextCvmGate('all'), 'off')
})

test('describeCvmGate：逐档列出**实际放行了哪几级**（warn 的名字看不出它含 intercept）', () => {
  assert.equal(describeCvmGate('off'), 'CVM 拦截提示 → off（全部关闭）')
  assert.ok(describeCvmGate('intercept').includes('显示：拦截'), describeCvmGate('intercept'))
  assert.ok(describeCvmGate('warn').includes('显示：拦截 / 警告'), describeCvmGate('warn'))
  assert.ok(describeCvmGate('all').includes('显示：拦截 / 警告 / 提示'), describeCvmGate('all'))
})

// ── 注册契约 ────────────────────────────────────────────────────

test('注册进 slash 表：名字 /cvm、immediate（不改在途 run 的任何行为）', () => {
  let captured: { name?: string; immediate?: boolean; description?: string } | undefined
  const fake = {
    registerSlashCommand: (c: never) => { captured = c },
  }
  registerCvmNoticeCommand(fake as unknown as TuiApp)
  assert.equal(captured?.name, '/cvm')
  assert.equal(captured?.immediate, true)
  assert.ok(captured?.description?.includes('off/intercept/warn/all'), captured?.description)
})

test('handler：带参切换并回执；无参走循环档', () => {
  let gate: CvmNoticeGate = 'intercept'
  const lines: string[] = []
  let handler: ((ctx: { trimmed: string }) => unknown) | undefined
  const fake = {
    registerSlashCommand: (c: { handler: (ctx: { trimmed: string }) => unknown }) => { handler = c.handler },
    get cvmNoticeGate() { return gate },
    set cvmNoticeGate(v: CvmNoticeGate) { gate = v },
    commitStatic: (t: string) => { lines.push(t) },
  }
  registerCvmNoticeCommand(fake as unknown as TuiApp)

  handler!({ trimmed: '/cvm all' })
  assert.equal(gate, 'all')
  assert.ok(lines[0]!.includes('显示：拦截 / 警告 / 提示'), lines[0])

  handler!({ trimmed: '/cvm' })          // 无参：all → off
  assert.equal(gate, 'off')
  assert.ok(lines[1]!.includes('全部关闭'), lines[1])

  handler!({ trimmed: '/cvm 乱写' })      // 非法参数 → 走循环
  assert.equal(gate, 'intercept')
})

// ── app 层：开关真的拦得住渲染 ───────────────────────────────────

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  return app
}
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const scrollback = (app: TuiApp) => stripAnsi(app.getScrollbackContent())

const interceptNotice: CvmInterceptionNotice = {
  level: 'intercept', kind: 'verification-debt', ruleId: 'CV1', mode: 'active', turn: 1,
  text: '⛨ CVM 拦截：验证债务（CV1） — 已注入纠偏',
}
const infoNotice: CvmInterceptionNotice = {
  level: 'info', kind: 'gate-blocked', ruleId: null, mode: 'shadow', turn: 1,
  text: '⛨ CVM 提示：门禁让位 — 已记台账，未发声',
}

test('默认档 intercept：拦截级渲染，提示级被挡住（默认不是全关，也不是全开）', () => {
  const app = makeApp()
  assert.equal(app.cvmNoticeGate, 'intercept', '默认档必须是 intercept——issue 明确否定了默认全关')
  app.callbacks.onCvmInterception?.(infoNotice)
  assert.ok(!scrollback(app).includes('CVM 提示'), '默认档不该放行提示级')
  app.callbacks.onCvmInterception?.(interceptNotice)
  assert.ok(scrollback(app).includes('CVM 拦截'), '默认档必须放行拦截级')
})

test('切到 off 后拦截级也不再渲染；切到 all 后提示级出现', () => {
  const app = makeApp()
  app.cvmNoticeGate = 'off'
  app.callbacks.onCvmInterception?.(interceptNotice)
  assert.ok(!scrollback(app).includes('CVM'), 'off 必须一票否决')

  app.cvmNoticeGate = 'all'
  app.callbacks.onCvmInterception?.(infoNotice)
  assert.ok(scrollback(app).includes('CVM 提示'), 'all 应放行提示级')
})

test('关掉的级别不占窗口计数：重新打开后 ×N 不含被关期间的次数', () => {
  const app = makeApp()
  app.cvmNoticeGate = 'off'
  app.callbacks.onCvmInterception?.(interceptNotice)
  app.callbacks.onCvmInterception?.(interceptNotice)

  app.cvmNoticeGate = 'intercept'
  app.callbacks.onCvmInterception?.(interceptNotice)   // 新窗口首条
  app.callbacks.onCvmInterception?.(interceptNotice)   // 窗口内第二条
  app.flushCvmNotices(Date.now() + 60_000)

  const text = scrollback(app)
  assert.ok(text.includes('CVM 拦截 ×2：验证债务'), `只应合并重开后的 2 次：${text.slice(0, 400)}`)
  assert.ok(!text.includes('×4'), '不得把关掉期间的次数算进来')
})

test('档位在窗口期间被关掉：到期的合并行也必须被拦住（两道过滤的第二道）', () => {
  const app = makeApp()
  app.callbacks.onCvmInterception?.(interceptNotice)
  app.callbacks.onCvmInterception?.(interceptNotice)   // 窗口内累计 2

  app.cvmNoticeGate = 'off'                             // 窗口开着时关掉档位
  app.flushCvmNotices(Date.now() + 60_000)

  assert.ok(!scrollback(app).includes('×2'), `关档后到期的合并行不得渲染：${scrollback(app).slice(0, 400)}`)
})
