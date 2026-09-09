import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { formatGlanceLeft, shortenCwd, type GlanceBarInput } from '../format/glance-bar.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const HOME = homedir()

/** 剥离 ANSI 转义码，取纯文本（便于断言内容而非颜色）。 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function baseInput(overrides: Partial<GlanceBarInput> = {}): GlanceBarInput {
  return { width: 120, domainName: '天枢', ...overrides }
}

describe('shortenCwd', () => {
  it('replaces home prefix with ~', () => {
    assert.equal(shortenCwd(HOME), '~')
    assert.equal(shortenCwd(`${HOME}/app/deepseek-tui`), '~/app/deepseek-tui')
  })

  it('returns path unchanged when not under home', () => {
    assert.equal(shortenCwd('/tmp/foo'), '/tmp/foo')
    assert.equal(shortenCwd('/usr/local/bin'), '/usr/local/bin')
  })
})

describe('formatGlanceLeft cwd display', () => {
  it('shows branch + cwd on wide terminal', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      branch: 'main',
      cwd: '/Users/test/app',
    }), theme))
    assert.match(out, / main/, 'branch shows with git glyph')
    assert.match(out, /\/Users\/test\/app/, 'cwd should appear after branch')
  })

  it('shows shortened cwd (~ prefix)', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      branch: 'dev',
      cwd: `${HOME}/projects/foo`,
    }), theme))
    // home 被替换为 ~（跨平台）
    assert.ok(out.includes('~/projects/foo'), `expected ~/projects/foo in: ${out}`)
  })

  it('uses three-tier color hierarchy (accent > secondary > dim)', () => {
    // 分支用 git 符号增强醒目度；色阶 primary/accent > secondary > dim
    const out = formatGlanceLeft(baseInput({
      branch: 'feature',
      cwd: '/tmp/proj',
    }), theme)
    // 含三种 ANSI 色码段（星域 accent + 分支 secondary + cwd dim）
    const colorSegments = out.match(/\x1b\[[0-9;]*m/g) ?? []
    assert.ok(colorSegments.length >= 6, `expect >=6 color codes (open+close for 3 tiers), got ${colorSegments.length}`)
  })

  it('hides branch and cwd on narrow terminal (<60 cols)', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      width: 40,
      branch: 'main',
      cwd: '/Users/test/app',
    }), theme))
    // 窄终端时分支和 cwd 都不显示（只留星域名），避免挤爆
    assert.equal(out.includes(' main'), false, 'branch hidden when narrow')
    assert.equal(out.includes('/Users/test/app'), false, 'cwd hidden when narrow')
    assert.ok(out.includes('天枢'), 'domain name always shows')
  })

  it('shows branch only when cwd is undefined', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      branch: 'main',
    }), theme))
    assert.match(out, / main/, 'branch shows with git glyph')
    assert.equal(out.includes('~'), false, 'no cwd part when undefined')
  })

  it('shows neither branch nor cwd when both undefined', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      domainName: '天枢',
    }), theme))
    assert.equal(out.includes('('), false)
    assert.equal(out.includes('~'), false)
    assert.ok(out.includes('天枢'))
  })
})
