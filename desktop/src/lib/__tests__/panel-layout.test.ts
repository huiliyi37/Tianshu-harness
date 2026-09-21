import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampSidebar,
  clampReview,
  sizeForPanelResize,
  persistableSidebarPct,
  persistableReviewPct,
  isCollapsedSize,
  loadPanelLayout,
  saveSidebarWidth,
  resetPanelLayout,
  MIN_SIDEBAR_PX,
} from '../panel-layout.ts'

class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}

const g = globalThis as unknown as { localStorage: MemStorage }
g.localStorage = new MemStorage()

test('sizeForPanelResize emits an explicit percent string (v4 resize() treats numbers as px)', () => {
  assert.equal(sizeForPanelResize(16), '16%')
  assert.equal(sizeForPanelResize(26), '26%')
  assert.notEqual(typeof sizeForPanelResize(16), 'number')
})

test('persistableSidebarPct skips collapse and maximize/restore 0-width glitch frames', () => {
  assert.equal(persistableSidebarPct({ asPercentage: 0, inPixels: 0 }), null)
  assert.equal(persistableSidebarPct({ asPercentage: 16, inPixels: 40 }), null)
  assert.equal(persistableSidebarPct({ asPercentage: 16, inPixels: MIN_SIDEBAR_PX - 1 }), null)
  assert.equal(persistableSidebarPct({ asPercentage: 16, inPixels: 260 }), 16)
  assert.equal(persistableSidebarPct({ asPercentage: 3, inPixels: 260 }), 12) // clamp to min %
  assert.equal(persistableSidebarPct({ asPercentage: 80, inPixels: 900 }), 35) // clamp to max %
})

test('persistableReviewPct skips sub-min pixel frames', () => {
  assert.equal(persistableReviewPct({ asPercentage: 26, inPixels: 80 }), null)
  assert.equal(persistableReviewPct({ asPercentage: 26, inPixels: 320 }), 26)
})

test('isCollapsedSize treats 0% and 0px as collapsed', () => {
  assert.equal(isCollapsedSize({ asPercentage: 0, inPixels: 0 }), true)
  assert.equal(isCollapsedSize({ asPercentage: 0, inPixels: 12 }), true)
  assert.equal(isCollapsedSize({ asPercentage: 16, inPixels: 260 }), false)
})

test('clampSidebar / clampReview stay in layout bounds', () => {
  assert.equal(clampSidebar(0), 12)
  assert.equal(clampSidebar(16), 16)
  assert.equal(clampSidebar(99), 35)
  assert.equal(clampReview(0), 15)
  assert.equal(clampReview(60), 45)
})

test('loadPanelLayout ignores a persisted 0 left over from a restore glitch', () => {
  localStorage.clear()
  localStorage.setItem('rivet:sidebar-w', '0')
  const layout = loadPanelLayout()
  assert.equal(layout.sidebar, 12)
})

test('saveSidebarWidth then loadPanelLayout round-trips a healthy percent', () => {
  localStorage.clear()
  saveSidebarWidth(18)
  assert.equal(loadPanelLayout().sidebar, 18)
})

test('resetPanelLayout restores defaults', () => {
  localStorage.clear()
  saveSidebarWidth(30)
  const next = resetPanelLayout()
  assert.equal(next.sidebar, 16)
  assert.equal(loadPanelLayout().sidebar, 16)
})
