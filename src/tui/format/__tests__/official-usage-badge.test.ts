/**
 * 常驻余额角标（issue #98）——官方快照 → 单行徽章的三态契约。
 *
 * 三态：ready 占位 / loading 与 unavailable（未配置、查询失败）不占位。
 * 覆盖 formatOfficialUsageBadge 纯函数 + formatWorkspaceMode 的接线（输入区状态行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatOfficialUsageBadge, type CachePanelOfficial } from '../cache-panel.js'
import { formatWorkspaceMode } from '../workspace-chrome.js'
import { color } from '../../engine/ansi.js'
import { displayWidth, ambiguousWideEnabled } from '../../width.js'
import { getTheme, setTheme } from '../../theme.js'

setTheme('tianshu')
const theme = getTheme()

const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

const readyPlatform: CachePanelOfficial = {
  status: 'ready', source: 'platform', todayCost: 1.23, monthCost: 45.6, balance: '12.34', currency: 'CNY',
}

// ── formatOfficialUsageBadge ─────────────────────────────────────────

test('ready + platform：显示「余额 ¥金额」', () => {
  assert.equal(formatOfficialUsageBadge(readyPlatform, undefined, theme), color('余额 ¥12.34', theme.success))
})

test('ready + balance（API key 口径）：同样显示余额', () => {
  const o: CachePanelOfficial = { status: 'ready', source: 'balance', balance: '9.50', currency: 'CNY' }
  assert.equal(formatOfficialUsageBadge(o, undefined, theme), color('余额 ¥9.50', theme.success))
})

test('非 CNY 币种带上货币码，避免误读为人民币', () => {
  const o: CachePanelOfficial = { status: 'ready', source: 'balance', balance: '7.00', currency: 'USD' }
  assert.equal(formatOfficialUsageBadge(o, undefined, theme), color('余额 7.00 USD', theme.success))
})

test('峰时 muted、闲时 success（计价时段决定着色）', () => {
  assert.equal(formatOfficialUsageBadge(readyPlatform, 'offpeak', theme), color('余额 ¥12.34', theme.success))
  assert.equal(formatOfficialUsageBadge(readyPlatform, 'peak', theme), color('余额 ¥12.34', theme.muted))
})

test('ready 但无余额：降级显示今日用量', () => {
  const o: CachePanelOfficial = { status: 'ready', source: 'platform', todayCost: 0.5, currency: 'CNY' }
  assert.equal(formatOfficialUsageBadge(o, undefined, theme), color('今日 ¥0.50', theme.success))
})

test('ready 但既无余额也无今日用量：不占位', () => {
  const o: CachePanelOfficial = { status: 'ready', source: 'platform', currency: 'CNY' }
  assert.equal(formatOfficialUsageBadge(o, undefined, theme), null)
})

test('loading 不占位（不刷屏）', () => {
  assert.equal(formatOfficialUsageBadge({ status: 'loading' }, undefined, theme), null)
})

test('unavailable（未配置 / 查询失败）不占位', () => {
  assert.equal(formatOfficialUsageBadge({ status: 'unavailable', hint: '未检测到 DeepSeek 凭证。' }, undefined, theme), null)
  assert.equal(formatOfficialUsageBadge({ status: 'unavailable', hint: '官方账单查询失败：boom' }, undefined, theme), null)
})

// ── formatWorkspaceMode 接线 ─────────────────────────────────────────

test('状态行有余额角标：ready 时并进 mode 行', () => {
  const row = stripAnsi(formatWorkspaceMode({ width: 200, approvalMode: 'auto-safe', officialUsage: readyPlatform }, theme))
  assert.match(row, /余额 ¥12\.34/)
})

test('状态行降级：loading / unavailable / 未注入 都无角标', () => {
  for (const o of [{ status: 'loading' } as CachePanelOfficial, { status: 'unavailable', hint: 'x' } as CachePanelOfficial, undefined]) {
    const row = stripAnsi(formatWorkspaceMode({ width: 200, approvalMode: 'auto-safe', officialUsage: o }, theme))
    assert.doesNotMatch(row, /余额/)
  }
})

test('状态行宽度账：窄终端不因角标超宽', () => {
  const row = formatWorkspaceMode({ width: 40, approvalMode: 'auto-safe', officialUsage: readyPlatform, tasks: 3 }, theme)
  const w = displayWidth(stripAnsi(row), { ambiguousAsWide: ambiguousWideEnabled() })
  assert.ok(w <= 40, `应截断到 40 列以内，实得 ${w}：「${stripAnsi(row)}」`)
})
