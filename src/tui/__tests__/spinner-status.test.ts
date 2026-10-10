import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import chalk from 'chalk'
import {
  formatSpinnerStatus,
  formatTokenCount,
  formatTurnWorkSummary,
  formatElapsedHuman,
  formatJobAwaitWait,
  jobAwaitLimitMs,
  configureSpinnerVerbs,
  setReducedMotion,
  resetSpinnerConfig,
} from '../format/spinner-status.js'
import { getTheme } from '../theme.js'
import type { JobRow } from '../job-registry.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

const glyphProfiles = [
  { name: 'Unicode', asciiUi: '0', colorLevel: 0, frame: '◒', done: '◆' },
  { name: 'ASCII', asciiUi: '1', colorLevel: 3, frame: '/', done: '*' },
] as const

function withGlyphProfile(profile: (typeof glyphProfiles)[number], run: () => void): void {
  const previousAscii = process.env.RIVET_ASCII_UI
  const previousColorLevel = chalk.level
  process.env.RIVET_ASCII_UI = profile.asciiUi
  chalk.level = profile.colorLevel
  try { run() }
  finally {
    if (previousAscii === undefined) delete process.env.RIVET_ASCII_UI
    else process.env.RIVET_ASCII_UI = previousAscii
    chalk.level = previousColorLevel
  }
}

describe('formatSpinnerStatus', () => {
  it('idle returns null', () => {
    assert.equal(formatSpinnerStatus({ tick: 0, phase: 'idle', elapsedMs: 0 }, theme), null)
  })

  for (const profile of glyphProfiles) {
    it(`shows one ${profile.name} spinner frame + verb + elapsed at color level ${profile.colorLevel}`, () => {
      withGlyphProfile(profile, () => {
        resetSpinnerConfig()
        const line = formatSpinnerStatus({ tick: 3, phase: 'thinking', elapsedMs: 5_000 }, theme)
        assert.ok(line)
        assert.equal(stripAnsi(line), `${profile.frame} thinking… 5s`, 'explicit glyph profile overrides color capability')
      })
    })
  }

  it('thinking uses the verb pool while streaming and waiting describe their activity', () => {
    resetSpinnerConfig()
    const thinking = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const streaming = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'streaming', elapsedMs: 0 }, theme)!)
    const analyzing = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'analyzing', elapsedMs: 0 }, theme)!)
    const waiting = stripAnsi(formatSpinnerStatus({ tick: 5, phase: 'waiting', elapsedMs: 0 }, theme)!)
    assert.ok(thinking.includes('thinking'))
    assert.ok(streaming.includes('正在生成'))
    assert.ok(analyzing.includes('thinking'))
    assert.ok(waiting.includes('等待响应'))
  })

  it('verb rotates by elapsed time slice (8s per verb), stable within a slice', () => {
    resetSpinnerConfig()
    const early = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const sameSlice = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 7_000 }, theme)!)
    const nextSlice = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 9_000 }, theme)!)
    assert.equal(early.split('…')[0], sameSlice.split('…')[0], 'same verb inside one 8s slice')
    assert.notEqual(early.split('…')[0], nextSlice.split('…')[0], 'verb rotates after slice boundary')
  })

  it('configureSpinnerVerbs replace/append modes', () => {
    configureSpinnerVerbs(['酝酿中'], 'replace')
    const line = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 60_000 }, theme)!)
    assert.ok(line.includes('酝酿中'), 'replaced pool has a single verb regardless of elapsed')
    configureSpinnerVerbs(['自定义词'], 'append')
    const appended = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    assert.ok(appended.includes('thinking'), 'append keeps default pool head')
    resetSpinnerConfig()
  })

  it('reducedMotion freezes frame and verb', () => {
    setReducedMotion(true)
    const a = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const b = stripAnsi(formatSpinnerStatus({ tick: 7, phase: 'thinking', elapsedMs: 20_000 }, theme)!)
    assert.equal(a[0], b[0], 'frame is static regardless of tick')
    assert.equal(a.split('…')[0], b.split('…')[0], 'verb is frozen regardless of elapsed')
    resetSpinnerConfig()
  })

  it('spinner frame advances with tick', () => {
    const a = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 0 }, theme)!)
    const b = stripAnsi(formatSpinnerStatus({ tick: 1, phase: 'thinking', elapsedMs: 0 }, theme)!)
    assert.notEqual(a[0], b[0])
  })

  it('stalled and normal produce different output (amber)', () => {
    // 测试环境 theme 可能回退到命名色（fg('') 无 SGR），用 hex theme 验证换色
    const hexTheme = { ...theme, secondary: '#d4a5f5', warning: '#ffdac1' }
    const normal = formatSpinnerStatus({ tick: 0, phase: 'streaming', elapsedMs: 5000 }, hexTheme)!
    const stalled = formatSpinnerStatus({ tick: 0, phase: 'streaming', elapsedMs: 5000, stalled: true }, hexTheme)!
    assert.equal(stripAnsi(normal), stripAnsi(stalled), 'same text')
    assert.notEqual(normal, stalled, 'different color')
  })

  it('elapsed over a minute renders Xm Ys', () => {
    const line = stripAnsi(formatSpinnerStatus({ tick: 0, phase: 'thinking', elapsedMs: 66_000 }, theme)!)
    assert.ok(line.includes('1m 6s'))
  })
})

describe('formatElapsedHuman / formatTokenCount', () => {
  it('formats sub-minute and minute elapsed', () => {
    assert.equal(formatElapsedHuman(9_500), '9s')
    assert.equal(formatElapsedHuman(66_000), '1m 6s')
  })

  it('formats token counts', () => {
    assert.equal(formatTokenCount(890), '890')
    assert.equal(formatTokenCount(12_300), '12.3k')
    assert.equal(formatTokenCount(1_200_000), '1.20M')
  })
})

describe('formatTurnWorkSummary', () => {
  for (const profile of glyphProfiles) {
    it(`renders the ${profile.name} done glyph + elapsed + in→out tokens at color level ${profile.colorLevel}`, () => {
      withGlyphProfile(profile, () => {
        const line = stripAnsi(formatTurnWorkSummary({
          elapsedMs: 66_000,
          inputTokens: 12_300,
          outputTokens: 890,
        }, theme))
        assert.equal(line, `${profile.done} 完成 · 1m 6s · 12.3k→890`, 'explicit glyph profile overrides color capability')
      })
    })
  }
})

// ── job(await) 等待区如实化 ─────────────────────────────────────────
// 契约：阻塞在 job(action:'await') 期间如实显示「在等谁 / 已等多久 / 上限多少」，
// 动词池不轮换（根修「琢磨中 8m11s」式撒谎）。

describe('jobAwaitLimitMs', () => {
  it('与 job-tool clamp 同口径：缺省 120s、封顶 600s', () => {
    assert.equal(jobAwaitLimitMs(undefined), 120_000)
    assert.equal(jobAwaitLimitMs(null), 120_000)
    assert.equal(jobAwaitLimitMs('abc'), 120_000)
    assert.equal(jobAwaitLimitMs(30_000), 30_000)
    assert.equal(jobAwaitLimitMs('45000'), 45_000)
    assert.equal(jobAwaitLimitMs(9_999_999), 600_000)
  })
})

describe('formatJobAwaitWait', () => {
  const now = 1_000_000
  const jobRow = (overrides: Partial<JobRow> = {}): JobRow => ({
    id: 'a1',
    command: 'npm run dev',
    status: 'running',
    startedAt: now - 50_000,
    lastLine: '',
    terminal: false,
    unread: false,
    ...overrides,
  })

  it('正常文案：⏳ 等待后台任务 <cmd> · 已等 Xs / 上限 Ys', () => {
    const view = formatJobAwaitWait({ jobId: 'a1', startMs: now - 5_000 }, jobRow(), now)
    assert.ok(view.line.includes('等待后台任务 npm run dev'), view.line)
    assert.ok(view.line.includes('已等 5s'), view.line)
    assert.ok(view.line.includes('上限 2m 0s'), view.line)
    assert.equal(view.detail, undefined, '无 lastLine 不出次行')
  })

  it('有 lastLine 时次行跟随（截断 + 压平空白）', () => {
    const view = formatJobAwaitWait(
      { jobId: 'a1', startMs: now - 5_000 },
      jobRow({ lastLine: 'vite ready\nin 300ms' }),
      now,
    )
    assert.ok(view.detail, '应有次行')
    assert.ok(view.detail!.includes('vite ready in 300ms'), view.detail)
    assert.ok(!view.detail!.includes('\n'), '次行不得含换行')
  })

  it('cmd 超过 40 字符截断', () => {
    const long = 'x'.repeat(80)
    const view = formatJobAwaitWait({ jobId: 'a1', startMs: now - 5_000 }, jobRow({ command: long }), now)
    assert.ok(view.line.includes('…'), '截断应带省略号')
    assert.ok(!view.line.includes(long), '不得包含完整长命令')
  })

  it('无 jobRow 时降级为「等待后台任务 <jobId>」不带 cmd', () => {
    const view = formatJobAwaitWait({ jobId: 'job-9', startMs: now - 12_000 }, undefined, now)
    assert.ok(view.line.includes('等待后台任务 job-9'), view.line)
    assert.ok(view.line.includes('已等 12s'), view.line)
    assert.equal(view.detail, undefined)
  })

  it('timeout 参数换算进上限（封顶 600s）', () => {
    const view = formatJobAwaitWait({ jobId: 'a1', timeoutMs: 30_000, startMs: now - 5_000 }, jobRow(), now)
    assert.ok(view.line.includes('上限 30s'), view.line)
    const capped = formatJobAwaitWait({ jobId: 'a1', timeoutMs: 9_999_999, startMs: now - 5_000 }, jobRow(), now)
    assert.ok(capped.line.includes('上限 10m 0s'), capped.line)
  })

  it('超过上限 → 转「运行已久 — Ctrl+C 可中断」档', () => {
    const view = formatJobAwaitWait({ jobId: 'a1', timeoutMs: 120_000, startMs: now - 491_000 }, jobRow(), now)
    assert.ok(view.line.includes('后台任务运行已久'), view.line)
    assert.ok(view.line.includes('Ctrl+C 可中断'), view.line)
    assert.ok(view.line.includes('8m 11s'), view.line)
    assert.ok(!view.line.includes('等待后台任务'), '超上限不再报等待口径')
  })

  it('动词不轮换：同一命令不同已等时长，静态前缀稳定', () => {
    const a = formatJobAwaitWait({ jobId: 'a1', startMs: now - 5_000 }, jobRow(), now)
    const b = formatJobAwaitWait({ jobId: 'a1', startMs: now - 13_000 }, jobRow(), now)
    const c = formatJobAwaitWait({ jobId: 'a1', startMs: now - 61_000 }, jobRow(), now)
    const prefix = (v: string) => v.split('·')[0]!
    assert.equal(prefix(a.line), prefix(b.line))
    assert.equal(prefix(b.line), prefix(c.line))
    for (const v of [a, b, c]) {
      assert.ok(!v.line.includes('琢磨中') && !v.line.includes('思索中') && !v.line.includes('推演中'),
        `不得冒充思考系动词: ${v.line}`)
    }
  })
})


describe('formatSpinnerStatus：activityLabel 如实化（analyzing 相位不冒充思考）', () => {
  it('设置 activityLabel 时取代动词池轮换', () => {
    const out = formatSpinnerStatus({ tick: 0, phase: 'analyzing', elapsedMs: 65_000, activityLabel: 'Run(npm test)' }, theme)!
    assert.ok(out.includes('Run(npm test)'), out)
    assert.ok(!out.includes('思索中') && !out.includes('琢磨中'), out)
    assert.ok(out.includes('1m 5s'), out)
  })

  it('未设置时保持动词池（回归）', () => {
    const out = formatSpinnerStatus({ tick: 0, phase: 'analyzing', elapsedMs: 65_000 }, theme)!
    assert.ok(out.includes('…'), out)
  })

  it('approvalWait 优先级仍高于一切', () => {
    const out = formatSpinnerStatus({ tick: 0, phase: 'analyzing', elapsedMs: 5_000, activityLabel: 'Run(x)', approvalWait: { toolName: 'bash', waitMs: 3_000 } }, theme)!
    assert.ok(out.includes('等待审批 bash'), out)
    assert.ok(!out.includes('Run(x)'), out)
  })
})

describe('formatSpinnerStatus：activityLabel 宽度适配（耗时不被长标签挤掉）', () => {
  const longLabel = `mcp·verylongserver:some_tool(${'x'.repeat(50)})`

  it('窄终端下长 activityLabel 被裁剪，耗时仍在行内', () => {
    const out = formatSpinnerStatus(
      { tick: 0, phase: 'analyzing', elapsedMs: 65_000, columns: 40, activityLabel: longLabel },
      theme,
    )!
    const plain = stripAnsi(out)
    assert.ok(plain.includes('1m 5s'), `耗时被挤掉: ${plain}`)
    assert.ok(plain.includes('…'), `长标签应先裁剪: ${plain}`)
    // 80 列终端下原样显示会超宽 → clampLine 从尾部截掉耗时，这一行是根修
    const out80 = formatSpinnerStatus(
      { tick: 0, phase: 'analyzing', elapsedMs: 65_000, columns: 80, activityLabel: longLabel },
      theme,
    )!
    assert.ok(stripAnsi(out80).includes('1m 5s'), stripAnsi(out80))
  })

  it('未给 columns 时保持原样（旧调用兼容）', () => {
    const out = formatSpinnerStatus(
      { tick: 0, phase: 'analyzing', elapsedMs: 65_000, activityLabel: 'Run(npm test)' },
      theme,
    )!
    assert.equal(stripAnsi(out).includes('Run(npm test)'), true)
    assert.equal(stripAnsi(out).includes('…'), false)
  })

  it('窄终端下短标签不裁剪（不制造无谓省略号）', () => {
    const out = formatSpinnerStatus(
      { tick: 0, phase: 'analyzing', elapsedMs: 65_000, columns: 80, activityLabel: 'Run(npm test)' },
      theme,
    )!
    assert.ok(stripAnsi(out).includes('Run(npm test)'), stripAnsi(out))
  })
})
