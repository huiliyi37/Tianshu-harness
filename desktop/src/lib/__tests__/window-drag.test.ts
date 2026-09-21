import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOW_NO_DRAG_SELECTOR } from '../window-drag.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cssSrc = readFileSync(join(here, '../../styles.css'), 'utf8')
const titleBarSrc = readFileSync(join(here, '../../components/TitleBar.tsx'), 'utf8')
const workspaceSrc = readFileSync(join(here, '../../surfaces/WorkspaceSurface.tsx'), 'utf8')

test('WINDOW_NO_DRAG_SELECTOR excludes buttons, inputs, and explicit opt-outs', () => {
  assert.match(WINDOW_NO_DRAG_SELECTOR, /button/)
  assert.match(WINDOW_NO_DRAG_SELECTOR, /input/)
  assert.match(WINDOW_NO_DRAG_SELECTOR, /data-no-drag/)
  assert.match(WINDOW_NO_DRAG_SELECTOR, /data-tauri-drag-region="false"/)
})

test('custom titlebar stays above settings and is a drag region', () => {
  assert.match(cssSrc, /\.titlebar\s*\{[^}]*z-index:\s*10000/)
  assert.match(cssSrc, /\.titlebar\s*\{[^}]*-webkit-app-region:\s*drag/)
  assert.match(cssSrc, /\.titlebar-controls[\s\S]*?-webkit-app-region:\s*no-drag/)
  assert.match(titleBarSrc, /data-tauri-drag-region/)
  assert.match(titleBarSrc, /onWindowDragMouseDown/)
})

test('settings overlay keeps a drag strip and does not cover caption buttons', () => {
  assert.match(workspaceSrc, /className="settings-page"/)
  assert.match(workspaceSrc, /settings-page-topbar/)
  assert.match(workspaceSrc, /data-tauri-drag-region/)
  assert.match(workspaceSrc, /data-settings-open/)
  assert.match(cssSrc, /\.settings-page\s*\{[^}]*z-index:\s*200/)
  assert.match(cssSrc, /\.settings-page-topbar[\s\S]*?-webkit-app-region:\s*drag/)
  assert.match(cssSrc, /html\[data-settings-open\][\s\S]*?pointer-events:\s*none/)
})
