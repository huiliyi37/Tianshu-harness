/**
 * 常驻余额角标的接线契约（集成层，纯函数测试覆盖不到的部分，issue #98）。
 *
 * 角标的数据经由 /cache overlay 已注册的 cachePanelData provider 取得——
 * 纯函数测试只覆盖 formatOfficialUsageBadge/formatWorkspaceMode，这里实例化
 * 真实 TuiApp + 真实 provider，证明「provider → app 渲染循环 → 输入区状态行」
 * 这条跨模块边界真的接通了：ready 出现、loading/unavailable/缺失/抛错都不出现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import type { CachePanelData, CachePanelOfficial } from '../../format/cache-panel.js'

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function panelData(official: CachePanelOfficial): CachePanelData {
  return { period: 'today', session: null, aggregates: null, loading: false, official }
}

interface Priv {
  renderLive: () => void
}

async function frameWith(provider: () => CachePanelData): Promise<string> {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  app.registerOverlays({ cachePanelData: provider })
  out.clear()
  ;(app as unknown as Priv).renderLive()
  await flush()
  return stripAnsi(out.chunks.join(''))
}

test('官方快照 ready → 输入区状态行出现常驻余额角标', async () => {
  const frame = await frameWith(() => panelData({
    status: 'ready', source: 'platform', todayCost: 1.23, monthCost: 45.6, balance: '12.34', currency: 'CNY',
  }))
  assert.match(frame, /余额 ¥12\.34/)
})

test('loading / unavailable → 状态行无角标（不刷屏不报错）', async () => {
  const loading = await frameWith(() => panelData({ status: 'loading' }))
  assert.doesNotMatch(loading, /余额/)

  const unavailable = await frameWith(() => panelData({ status: 'unavailable', hint: '未检测到 DeepSeek 凭证。' }))
  assert.doesNotMatch(unavailable, /余额/)
})

test('provider 抛错 → 渲染不崩、无角标', async () => {
  const frame = await frameWith(() => { throw new Error('boom') })
  assert.doesNotMatch(frame, /余额/)
})
