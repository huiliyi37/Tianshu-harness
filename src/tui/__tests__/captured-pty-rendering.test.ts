import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import chalk from 'chalk'
import { resolveFrontendRenderer } from '../engine/renderer-policy.js'
import { fg, bg, detectHyperlinkSupport, detectImageProtocol } from '../engine/ansi.js'
import { getTheme, resolveThemeEntry, getActiveThemeName } from '../theme.js'

const original = process.env.RIVET_CAPTURED_PTY
const mode = process.env.RIVET_TERMINAL_MODE
const level = chalk.level
afterEach(() => {
  if (original === undefined) delete process.env.RIVET_CAPTURED_PTY; else process.env.RIVET_CAPTURED_PTY = original
  if (mode === undefined) delete process.env.RIVET_TERMINAL_MODE; else process.env.RIVET_TERMINAL_MODE = mode
  chalk.level = level
})

for (const platform of ['win32', 'darwin', 'linux'] as const) test(`captured profile vetoes fullscreen on ${platform}`, () => {
  assert.equal(resolveFrontendRenderer('fullscreen', true, false, { RIVET_CAPTURED_PTY: '1', WT_SESSION: 'real', COLORTERM: 'truecolor' }, platform), 'classic')
  assert.equal(resolveFrontendRenderer('fullscreen', true, false, { RIVET_TERMINAL_MODE: 'native', RIVET_CAPTURED_PTY: '1' }, platform), 'fullscreen')
})

test('captured output quantizes foreground and background to 16 colors despite truecolor', () => {
  process.env.RIVET_CAPTURED_PTY = '1'; delete process.env.RIVET_TERMINAL_MODE; chalk.level = 3
  for (const value of ['#ff0000', '#12ab34', '#00aaff', '#000000', '#ffffff']) {
    assert.match(fg(value), /^\x1b\[(?:3[0-7]|9[0-7])m$/)
    assert.match(bg(value), /^\x1b\[(?:4[0-7]|10[0-7])m$/)
  }
  assert.deepEqual(getTheme(3), resolveThemeEntry(getActiveThemeName())!.fallback)
})

test('captured output vetoes inline graphics and hyperlinks even with host capability flags', () => {
  const env = { RIVET_CAPTURED_PTY: '1', WT_SESSION: 'wt', TERM_PROGRAM: 'WezTerm', TERM: 'xterm-kitty', RIVET_HYPERLINKS: '1', RIVET_IMAGES: 'kitty' }
  assert.equal(detectHyperlinkSupport(env), false)
  assert.equal(detectImageProtocol(env, true), 'none')
})

test('native terminals retain explicit advanced render behavior', () => {
  process.env.RIVET_TERMINAL_MODE = 'native'; process.env.RIVET_CAPTURED_PTY = '1'; chalk.level = 3
  assert.match(fg('#12ab34'), /38;2;/)
  assert.equal(detectImageProtocol({ RIVET_TERMINAL_MODE: 'native', RIVET_IMAGES: 'kitty' }, true), 'kitty')
})
