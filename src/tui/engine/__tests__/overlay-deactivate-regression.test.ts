/**
 * Overlay deactivate 回归测试 — 防止 domain/model/theme picker 切换后
 * 出现的三种回归：
 *
 * 1. Ghost rendering：旧帧残留（exec 在 deactivate 之后运行）
 * 2. 输入框消失：deactivateOverlay 没正确恢复 live region
 * 3. 输入框跑到屏幕顶部：cursorUp(999) 全屏擦除把 append 起点拉到顶
 *
 * 这些 bug 在历史上反复出现（314c54f2, c8acfec9, a169152b, 以及
 * 027744ae / bb6a9329 / 03f73669 / e6ba2a27 序列）。此测试锁定正确行为。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeApp, stripAnsi } from './_harness.js'

describe('Overlay deactivate · picker exit regression', () => {
  // startConnect() 现在会读盘（connect-draft.json），测试需隔离 RIVET_HOME。
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-overlay-reg-'))
    process.env.RIVET_HOME = home
  })
  afterEach(() => {
    delete process.env.RIVET_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('deactivateOverlay writes exactly one live region after overlay exit', () => {
    const { app, out } = makeApp()
    out.clear()

    // Simulate: activate overlay → deactivate
    app.activateOverlay('domain-picker')
    out.clear() // discard activate's output
    app.deactivateOverlay()

    // After deactivate, screen should have exactly one input box border (╭)
    const allOutput = out.chunks.join('')
    const topBorders = stripAnsi(allOutput).match(/^(?:[─━┄-]{3,}|[─━┄-] .+ [─━┄-]{2,})\s*$/gm) ?? []
    assert.equal(topBorders.length, 2, `Expected 2 writing rules in one composer after deactivate, got ${topBorders.length}`)
  })

  it('deactivateOverlay does not use cursorUp(999) which moves input to screen top', () => {
    const { app, out } = makeApp()
    app.start() // paint initial live region
    out.clear()

    app.activateOverlay('domain-picker')
    out.clear()
    app.deactivateOverlay()

    const output = out.chunks.join('')
    // cursorUp(999) = \x1B[999A — must NOT appear (it moves cursor to screen top)
    assert.doesNotMatch(output, /\x1B\[999A/, 'cursorUp(999) must not be used — it sends input box to screen top')
  })

  it('deactivateOverlay produces output containing the input prompt (❯)', () => {
    const { app, out } = makeApp()
    app.start()
    out.clear()

    app.activateOverlay('model-picker')
    out.clear()
    app.deactivateOverlay()

    const output = out.chunks.join('')
    const plain = stripAnsi(output)
    assert.ok(plain.includes('❯'), 'Input prompt symbol ❯ must be present after deactivate')
  })

  it('successive activate/deactivate cycles do not accumulate ghost frames', () => {
    const { app, out } = makeApp()
    app.start()

    for (let i = 0; i < 3; i++) {
      app.activateOverlay('theme-picker')
      out.clear()
      app.deactivateOverlay()
    }

    const output = out.chunks.join('')
    const topBorders = stripAnsi(output).match(/^(?:[─━┄-]{3,}|[─━┄-] .+ [─━┄-]{2,})\s*$/gm) ?? []
    assert.equal(topBorders.length, 2, `Expected 2 writing rules in one composer after 3 cycles, got ${topBorders.length} — ghost accumulation`)
  })

  it('connect overlay: activate → deactivate leaves exactly one clean live frame', () => {
    const { app, out } = makeApp()
    app.start()
    app.startConnect()
    out.clear()
    app.deactivateOverlay()

    const output = out.chunks.join('')
    const topBorders = stripAnsi(output).match(/^(?:[─━┄-]{3,}|[─━┄-] .+ [─━┄-]{2,})\s*$/gm) ?? []
    assert.equal(topBorders.length, 2, `Expected 2 writing rules in one composer after connect exit, got ${topBorders.length}`)
    const plain = stripAnsi(output)
    assert.ok(plain.includes('❯'), 'Input prompt symbol ❯ must be present after connect overlay exit')
  })

  it('deactivateOverlay without an active overlay preserves the existing frame', () => {
    const { app, out } = makeApp()
    app.activateOverlay('domain-picker')
    app.deactivateOverlay()
    out.clear()
    // No overlay was left: the live frame must retain its cursor anchor and diff cache.
    app.deactivateOverlay()
    const output = out.chunks.join('')
    assert.equal(output, '', 'An unchanged frame must not append another input box at the caret')
    app.dispose()
  })

  // 回归：overlay 期间有 pending commit（commitStatic 排队），退出时
  // flushPendingMainCommits 回放画了第一帧，deactivateOverlay 的 renderLive
  // 不能再 append 叠加（两层框体）。应走 fullRewrite 覆盖第一帧，只留一帧。
  // 已知边缘场景（suppressCommitRender 在 mock 环境未完全覆盖 writeBatcher 异步
  // 时序），核心路径（domain picker 切换无 commit）已修复，此用例待后续收口。
  it.todo('deactivate with pending commits: no double border from flush + renderLive')
})
