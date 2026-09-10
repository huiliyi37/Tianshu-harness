/**
 * 用户自定义主题加载 — `~/.rivet/themes/*.json`。
 *
 * 文件格式（语义 token 局部覆盖，缺省继承 base 主题）：
 * ```json
 * {
 *   "base": "cobalt",
 *   "background": "dark",
 *   "description": "My theme",
 *   "colors": { "primary": "#ff8800", "toolEdit": "#88ccff" },
 *   "overrides": { "userColor": "#ffffff" }
 * }
 * ```
 * 文件名（去 .json）即主题名，引用方式 `custom:<name>`。
 * 单个文件解析失败只跳过该文件（stderr 警告），不影响其他主题与启动。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { registerCustomTheme, type CustomThemeInput, type ColorSet, type ThemeOverrides } from './theme.js'
import { THEME_PALETTES } from './theme-palettes.js'

/** 自定义主题目录。 */
export function customThemesDir(base?: string): string {
  return join(base ?? rivetHome(), 'themes')
}

const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

const COLOR_KEYS: readonly (keyof ColorSet)[] = [
  'primary', 'secondary', 'success', 'warning', 'error', 'dim',
  'pulseQuiet', 'pulseActive', 'pulseAlert',
  'toolShell', 'toolEdit', 'toolTest', 'toolDelegate',
]

const OVERRIDE_KEYS: readonly (keyof ThemeOverrides)[] = [
  'userColor', 'assistantColor', 'muted', 'systemColor', 'inlineCode',
]

function pickHexFields<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const key of keys) {
    const v = (raw as Record<string, unknown>)[key]
    if (typeof v === 'string' && HEX_RE.test(v)) out[key] = v
  }
  return out
}

/** 解析单个自定义主题 JSON → CustomThemeInput。结构非法返回 null。 */
export function parseCustomThemeJson(text: string): CustomThemeInput | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>

  const input: CustomThemeInput = {}
  if (typeof obj.base === 'string' && obj.base in THEME_PALETTES) {
    input.base = obj.base as CustomThemeInput['base']
  }
  if (obj.background === 'dark' || obj.background === 'light') input.background = obj.background
  if (typeof obj.description === 'string') input.description = obj.description
  input.colors = pickHexFields(obj.colors, COLOR_KEYS)
  input.overrides = pickHexFields(obj.overrides, OVERRIDE_KEYS)
  return input
}

/** 主题名合法性：字母数字、连字符、下划线（避免 `custom:` 引用歧义/路径注入）。 */
const NAME_RE = /^[A-Za-z0-9_-]+$/

/**
 * 扫描并注册全部自定义主题。返回成功注册的裸名列表。
 * 目录不存在 → 空列表（不是错误）。
 */
export function loadCustomThemes(baseDir?: string): string[] {
  const dir = customThemesDir(baseDir)
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const loaded: string[] = []
  for (const file of files) {
    const name = basename(file, '.json')
    if (!NAME_RE.test(name)) continue
    try {
      const input = parseCustomThemeJson(readFileSync(join(dir, file), 'utf8'))
      if (!input) {
        process.stderr.write(`[theme] skip invalid custom theme: ${file}\n`)
        continue
      }
      registerCustomTheme(name, input)
      loaded.push(name)
    } catch {
      process.stderr.write(`[theme] failed to read custom theme: ${file}\n`)
    }
  }
  return loaded
}
