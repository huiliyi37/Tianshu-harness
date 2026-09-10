import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme, setTheme, getActiveThemeName, THEMES, THEME_NAMES } from '../theme.js'

afterEach(() => { setTheme('cobalt') })

describe('getTheme', () => {
  it('defaults to cobalt theme', () => {
    assert.equal(getActiveThemeName(), 'cobalt')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#6ab8ff') // 钴蓝 accent
    assert.equal(theme.success, '#58cbb4') // 青绿
    assert.equal(theme.error, '#ed7665')   // 珊瑚砖红
    assert.notEqual(theme.primary, '#d77757') // 不是 Claude 品牌橙
    assert.notEqual(theme.primary, '#c9b8ff') // 不是紫微紫
  })

  it('tianshu uses cinnabar user mark + bright neutral body + readable muted', () => {
    setTheme('tianshu')
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#d86459')      // 朱砂印 ▌ mark (softened & brightened)
    assert.equal(theme.assistantColor, '#d2d5dd') // 亮灰正文 (提亮至 #d2d5dd)
    assert.equal(theme.muted, '#adb2bf')          // 元信息灰 (提亮 ~6.5:1)
    assert.equal(theme.systemColor, '#adb2bf')    // 与 muted 对齐
    assert.equal(theme.pulseActive, '#dfb282')    // 星金 active pulse（= primary）
  })

  it('cobalt still available via explicit switch', () => {
    setTheme('cobalt')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#6ab8ff') // 钴蓝 — 唯一 accent（提亮）
    assert.equal(theme.userColor, '#fbbf24')      // 亮琥珀金 ▌ mark
    assert.equal(theme.assistantColor, '#c9cfd6') // 冷中性灰正文（提亮）
    assert.equal(theme.inlineCode, '#8ecae6')     // 行内代码柔亮天青（独立 token,不吃 secondary 灰青）
  })

  it('antigravity still available via explicit switch (cool azure accent)', () => {
    setTheme('antigravity')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#5aa9ff') // cool azure
    assert.equal(theme.error, '#f76b6b')   // coral red
    assert.equal(theme.userColor, '#d8e2ee') // 冷调近白（原 #38bdf8 与 primary 撞色）
  })

  it('slate still available via explicit switch (cool teal accent)', () => {
    setTheme('slate')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#56b6c2') // 冷静 teal
    assert.equal(theme.userColor, '#e2e6ec') // 中性亮白 ▌ mark
    assert.equal(theme.assistantColor, '#c4c9d2') // 柔中性正文
  })

  it('ziwei still available via explicit switch (cinnabar seal)', () => {
    setTheme('ziwei')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff')       // 紫微 — 帝星紫
    assert.equal(theme.userColor, '#d4453a')      // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d4453a')     // alert pulse
    assert.equal(theme.assistantColor, '#c9b8ff') // assistantColor
  })

  it('tianshu uses cinnabar seal for user mark + alert pulse', () => {
    setTheme('tianshu')
    const theme = getTheme(3)
    assert.equal(theme.userColor, '#d86459')   // 朱砂印 — user ▌ mark
    assert.equal(theme.pulseAlert, '#d86459')  // vivid seal, distinct from desaturated error
    assert.equal(theme.assistantColor, '#d2d5dd') // brightened neutral body
  })

  it('returns 256-color fallback when colorLevel < 3 (cobalt → blue accent)', () => {
    setTheme('cobalt')
    const theme = getTheme(1)
    assert.equal(theme.primary, 'blue')
    assert.equal(theme.error, 'red')
  })

  it('maps tool names to colors (ziwei: multi-color per HTML design, read_file→toolShell)', () => {
    setTheme('ziwei')
    const theme = getTheme(3)
    assert.equal(theme.toolColor('bash'), '#8ab4ff')        // 天枢蓝白 (toolShell)
    assert.equal(theme.toolColor('grep'), '#8ab4ff')        // same as bash
    assert.equal(theme.toolColor('glob'), '#8ab4ff')        // same as bash
    assert.equal(theme.toolColor('read_file'), '#8ab4ff')   // exploration → toolShell (was dim)
    assert.equal(theme.toolColor('edit_file'), '#c9b8ff')   // 紫微紫 (design --tc-edit)
    assert.equal(theme.toolColor('write_file'), '#c9b8ff')  // same as edit
    assert.equal(theme.toolColor('run_tests'), '#7ee7c7')   // 归航青 (design --tc-test)
    assert.equal(theme.toolColor('delegate_task'), '#ffd479') // 星金 (design --tc-delegate)
    assert.equal(theme.toolColor('unknown_tool'), theme.toolColor('read_file')) // default → toolShell
  })

  it('returns context bar color — dim for normal, warning/error for high', () => {
    const theme = getTheme(3)
    assert.equal(theme.contextColor(0.3), theme.dim)    // normal → dim (NOT primary)
    assert.equal(theme.contextColor(0.7), theme.dim)    // still normal → dim
    assert.equal(theme.contextColor(0.76), theme.warning) // 75%+ → warning
    assert.equal(theme.contextColor(0.89), theme.error)   // 88%+ → error
  })

  it('exposes muted color for secondary readable text', () => {
    const theme = getTheme(3)
    assert.equal(typeof theme.muted, 'string')
    assert.ok(theme.muted.length > 0)
    assert.notEqual(theme.muted, theme.dim)
  })

  it('voice 随主题(风格化):pastel→playful / cyberpunk·gemini→tech / 其余 default', () => {
    assert.equal(THEMES.graphite.truecolor.voice, 'default')
    assert.equal(THEMES.cobalt.truecolor.voice, 'default')
    assert.equal(THEMES.pastel.truecolor.voice, 'playful')
    assert.equal(THEMES.cyberpunk.truecolor.voice, 'tech')
    assert.equal(THEMES.gemini.truecolor.voice, 'tech')
    assert.equal(THEMES.antigravity.truecolor.voice, 'tech')
    // fallback 轨与 truecolor 轨同 voice(voice 是 def 层语义,与色轨无关)
    assert.equal(THEMES.pastel.fallback.voice, 'playful')
    // getTheme 读 active theme 的 voice
    setTheme('pastel')
    assert.equal(getTheme(3).voice, 'playful')
    setTheme('graphite')
    assert.equal(getTheme(3).voice, 'default')
  })

  it('inlineCode 缺省继承 secondary；cyberpunk/cobalt 单独给独立色（正文行内代码不吃点缀色/灰青）', () => {
    // 正文行内代码高频出现且取 theme.inlineCode——某主题的 secondary 若是点缀色
    // （cyberpunk 的品红粉）或低对比灰青（cobalt），必须给它独立色，否则正文整屏
    // 染色或代码弱化（2026-09 实锤 + 默认主题观感优化）。
    assert.equal(THEMES.graphite.truecolor.inlineCode, THEMES.graphite.truecolor.secondary)
    assert.equal(THEMES.cobalt.truecolor.inlineCode, '#8ecae6')
    assert.notEqual(THEMES.cobalt.truecolor.inlineCode, THEMES.cobalt.truecolor.secondary)
    assert.equal(THEMES.cyberpunk.truecolor.inlineCode, '#7aa2f7')
    assert.notEqual(THEMES.cyberpunk.truecolor.inlineCode, THEMES.cyberpunk.truecolor.secondary)
  })
})

describe('theme switching', () => {
  it('switches to cyberpunk theme', () => {
    setTheme('cyberpunk')
    assert.equal(getActiveThemeName(), 'cyberpunk')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#48c6e2')
    assert.equal(theme.error, '#e27585')
  })

  it('switches back to ziwei theme', () => {
    setTheme('cyberpunk')
    setTheme('ziwei')
    assert.equal(getActiveThemeName(), 'ziwei')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#c9b8ff')
  })
})

describe('THEME_NAMES', () => {
  it('lists every registered theme', () => {
    assert.deepEqual(new Set(THEME_NAMES), new Set(Object.keys(THEMES)))
  })

  it('can be used to validate config theme values', () => {
    assert.ok(THEME_NAMES.includes('cobalt'))
    assert.ok(THEME_NAMES.includes('tianshu'))
    assert.ok(!(THEME_NAMES as readonly string[]).includes('not-a-theme'))
  })
})
