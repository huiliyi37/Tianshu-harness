import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rivetHome, userConfigPath } from '../config/paths.js'
import { validateBindings } from './keybindings.js'

export const FRONTEND_ACTIONS = [
  'history', 'tasks', 'stash', 'freeze', 'resume', 'inputHistory', 'editor', 'lastTool', 'thinking', 'imagePaste',
] as const
export type FrontendAction = typeof FRONTEND_ACTIONS[number]

export interface FrontendPreferences {
  renderer: 'auto' | 'classic' | 'fullscreen'
  keymap: 'standard' | 'legacy'
  inputMode: 'single' | 'multiline'
  mouse: boolean
  copyOnSelect: boolean
  bindings: Partial<Record<FrontendAction, string>>
  welcome: 'compact' | 'full'
  appearanceSetup?: 'done'
}

// copyOnSelect 默认开：鼠标选中（输入框或全屏会话正文）松开即复制，对齐 codex 与多数终端的选中即复制。
export const DEFAULT_FRONTEND_PREFERENCES: Readonly<FrontendPreferences> = Object.freeze({
  renderer: 'auto', keymap: 'standard', inputMode: 'single', mouse: true,
  copyOnSelect: true, bindings: Object.freeze({}), welcome: 'full',
})

export function frontendPreferencesPath(): string {
  return join(rivetHome(), 'frontend.json')
}

function selectedFields(value: FrontendPreferences): FrontendPreferences {
  return {
    renderer: value.renderer, keymap: value.keymap, inputMode: value.inputMode,
    mouse: value.mouse, copyOnSelect: value.copyOnSelect,
    bindings: { ...value.bindings }, welcome: value.welcome, appearanceSetup: value.appearanceSetup,
  }
}

export function validateFrontendPreferences(prefs: FrontendPreferences): string[] {
  const errors: string[] = []
  if (prefs.appearanceSetup !== undefined && prefs.appearanceSetup !== 'done') errors.push('未知外观设置状态')
  if (!['auto', 'classic', 'fullscreen'].includes(prefs.renderer)) errors.push('未知渲染方式')
  if (!['standard', 'legacy'].includes(prefs.keymap)) errors.push('未知快捷键映射')
  if (!['single', 'multiline'].includes(prefs.inputMode)) errors.push('未知输入方式')
  if (!['compact', 'full'].includes(prefs.welcome)) errors.push('未知欢迎页样式')
  if (typeof prefs.mouse !== 'boolean' || typeof prefs.copyOnSelect !== 'boolean') errors.push('鼠标与复制设置必须为布尔值')
  return [...errors, ...validateBindings(prefs.bindings, prefs.keymap)]
}

export function loadFrontendPreferences(options?: { path?: string; existingConfig?: boolean }): FrontendPreferences {
  const path = options?.path ?? frontendPreferencesPath()
  // A missing config is not reliable evidence of a new user unless the caller checked it.
  const existing = options?.existingConfig ?? true
  const prefs: FrontendPreferences = { ...DEFAULT_FRONTEND_PREFERENCES, keymap: existing ? 'legacy' : 'standard', bindings: {} }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return prefs
    const value = raw as Record<string, unknown>
    if (value.appearanceSetup === 'done') prefs.appearanceSetup = 'done'
    if (typeof value.renderer === 'string' && ['auto', 'classic', 'fullscreen'].includes(value.renderer)) prefs.renderer = value.renderer as FrontendPreferences['renderer']
    if (value.keymap === 'standard' || value.keymap === 'legacy') prefs.keymap = value.keymap
    if (value.inputMode === 'single' || value.inputMode === 'multiline') prefs.inputMode = value.inputMode
    if (value.welcome === 'compact' || value.welcome === 'full') prefs.welcome = value.welcome
    if (typeof value.mouse === 'boolean') prefs.mouse = value.mouse
    if (typeof value.copyOnSelect === 'boolean') prefs.copyOnSelect = value.copyOnSelect
    if (value.bindings && typeof value.bindings === 'object' && !Array.isArray(value.bindings)) {
      prefs.bindings = value.bindings as FrontendPreferences['bindings']
      if (validateBindings(prefs.bindings, prefs.keymap).length > 0) prefs.bindings = {}
    }
  } catch { /* Missing or malformed preferences preserve conservative migration defaults. */ }
  return prefs
}

export function saveFrontendPreferences(prefs: FrontendPreferences, path = frontendPreferencesPath()): void {
  const errors = validateFrontendPreferences(prefs)
  if (errors.length > 0) throw new Error(errors.join('；'))
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(selectedFields(prefs), null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) rmSync(temp)
  }
}

/** Only the existence check is needed for migration; config contents stay in the config manager. */
export function hasExistingFrontendConfig(): boolean {
  return existsSync(userConfigPath())
}
