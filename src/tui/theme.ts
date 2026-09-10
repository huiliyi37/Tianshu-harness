/**
 * 主题系统 — 语义 token 解析层。
 *
 * 两段式架构（2026-07 重构）：
 * - theme-palettes.ts: 调色板定义（语义 token → 颜色值 + background/description 元数据）
 * - theme.ts（本文件）: palette → RivetTheme 解析、主题切换、自定义主题注册表
 *
 * 颜色深度分档（渲染端 ansi.ts 消化）：
 * - level >= 2: truecolor 轨（hex；level 2 由 fg() 现场量化为 xterm-256）
 * - level <= 1: fallback 轨（chalk 命名色 → 基础 16 色 SGR）
 *
 * 自定义主题：~/.rivet/themes/*.json 经 theme-custom.ts 加载后注册到本模块，
 * 以 `custom:<name>` 引用。语义 token 局部覆盖，缺省继承 base 主题。
 */

import chalk from 'chalk'
import {
  THEME_PALETTES,
  type ColorSet,
  type ThemeName,
  type ThemeOverrides,
  type ThemePaletteDef,
  type ThemeVoice,
} from './theme-palettes.js'

export type { ThemeName, ColorSet, ThemeOverrides, ThemeVoice }

export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  muted: string
  pulseQuiet: string
  pulseActive: string
  pulseAlert: string
  userColor: string
  assistantColor: string
  systemColor: string
  /** 品牌词专用色（「天枢」字样、品牌星 ✦）。缺省 = primary。 */
  brandColor: string
  /** 正文行内代码色。缺省 = secondary（多数主题如此）；cyberpunk 单独指定，
   *  避免品红粉在正文里大面积出现导致整屏发红。 */
  inlineCode: string
  /** 语气档(主题风格化):greeting 问候池 / guide 首启文案按此选文案变体。 */
  voice: ThemeVoice
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}

export const THEME_NAMES = Object.keys(THEME_PALETTES) as [ThemeName, ...ThemeName[]]

function makeToolColor(c: ColorSet) {
  return (name: string): string => {
    switch (name) {
      // 探索族（shell）：bash / grep / glob / read / semantic / repo 等
      case 'bash': case 'grep': case 'glob':
      case 'read_file': case 'read_section': case 'read_policy':
      case 'semantic_search': case 'repo_map': case 'repo_graph':
      case 'inspect_project': case 'related_tests': case 'file_info': case 'ls':
        return c.toolShell ?? c.primary
      case 'edit_file': case 'write_file': case 'hash_edit': case 'apply_patch':
        return c.toolEdit ?? c.secondary
      case 'run_tests': return c.toolTest ?? c.success
      case 'delegate_task': case 'delegate_batch': return c.toolDelegate ?? c.warning
      default: return c.toolShell ?? c.dim
    }
  }
}

function makeContextColor(c: Pick<ColorSet, 'dim' | 'warning' | 'error'>) {
  return (pct: number): string => {
    if (pct >= 0.88) return c.error
    if (pct >= 0.75) return c.warning
    return c.dim
  }
}

function buildTheme(
  colors: ColorSet,
  overrides?: ThemeOverrides,
  auxiliaryDefault = '#9aa2b1',
  voice: ThemeVoice = 'default',
): RivetTheme {
  return {
    ...colors,
    muted: overrides?.muted ?? auxiliaryDefault,
    userColor: overrides?.userColor ?? colors.primary,
    assistantColor: overrides?.assistantColor ?? colors.secondary,
    systemColor: overrides?.systemColor ?? auxiliaryDefault,
    brandColor: overrides?.brandColor ?? colors.primary,
    inlineCode: overrides?.inlineCode ?? colors.secondary,
    voice,
    toolColor: makeToolColor(colors),
    contextColor: makeContextColor(colors),
  }
}

export interface ThemeEntry {
  truecolor: RivetTheme
  fallback: RivetTheme
  /** 面向的终端背景（auto 检测选主题、亮色对比度决策用）。 */
  background: 'dark' | 'light'
  /** /theme picker 描述。 */
  description: string
}

function buildEntry(def: ThemePaletteDef): ThemeEntry {
  return {
    truecolor: buildTheme(def.truecolor, def.overrides, undefined, def.voice ?? 'default'),
    // fallback 轨必须保持纯 ANSI 命名色。复用 truecolor 的 hex 默认值会让
    // level 0/1 终端重新收到 38;2 序列，等于悄悄绕过能力降级。
    fallback: buildTheme(def.fallback, def.fallbackOverrides, def.fallback.dim, def.voice ?? 'default'),
    background: def.background,
    description: def.description,
  }
}

export const THEMES: Record<ThemeName, ThemeEntry> = Object.fromEntries(
  (Object.entries(THEME_PALETTES) as [ThemeName, ThemePaletteDef][])
    .map(([name, def]) => [name, buildEntry(def)]),
) as Record<ThemeName, ThemeEntry>

// ── 自定义主题注册表 ───────────────────────────────────────────────

export interface CustomThemeInput {
  /** 语义 token 局部覆盖（truecolor 轨；hex）。缺省继承 base。 */
  colors?: Partial<ColorSet>
  /** userColor/assistantColor/muted/systemColor 覆盖（hex）。 */
  overrides?: ThemeOverrides
  /** 继承的内置主题。缺省按 background 选 cobalt（dark）/ paper（light）。 */
  base?: ThemeName
  background?: 'dark' | 'light'
  description?: string
}

const customThemes = new Map<string, ThemeEntry>()

/** 注册自定义主题（不含 `custom:` 前缀的裸名）。覆盖同名旧注册。 */
export function registerCustomTheme(name: string, input: CustomThemeInput): void {
  const background = input.background ?? 'dark'
  const baseName: ThemeName = input.base && input.base in THEME_PALETTES
    ? input.base
    : (background === 'light' ? 'paper' : 'cobalt')
  const baseDef = THEME_PALETTES[baseName]
  const colors: ColorSet = { ...baseDef.truecolor, ...input.colors }
  const overrides: ThemeOverrides = { ...baseDef.overrides, ...input.overrides }
  // voice 继承 base(风格化跟随基底皮肤;custom 不单独标 voice)
  const voice = baseDef.voice ?? 'default'
  customThemes.set(name, {
    truecolor: buildTheme(colors, overrides, undefined, voice),
    // 16 色轨没有 hex 可映射，继承 base 的 fallback（自定义 hex 只在 truecolor 生效）。
    // 第三个参数锁死辅助色默认值 = base fallback 的命名色，避免 muted/systemColor
    // 落回 truecolor 轨的 hex 默认值，让 level 0/1 终端收到 38;2 序列。
    fallback: buildTheme(baseDef.fallback, baseDef.fallbackOverrides, baseDef.fallback.dim, voice),
    background,
    description: input.description ?? `Custom theme (base: ${baseName})`,
  })
}

/** 已注册的自定义主题裸名列表（不含 `custom:` 前缀）。 */
export function listCustomThemes(): string[] {
  return [...customThemes.keys()]
}

/** 清空自定义主题注册表（测试用）。 */
export function clearCustomThemes(): void {
  customThemes.clear()
}

/** 解析主题条目：内置名或 `custom:<name>`。未知名返回 undefined。 */
export function resolveThemeEntry(name: string): ThemeEntry | undefined {
  if (name.startsWith('custom:')) return customThemes.get(name.slice('custom:'.length))
  return (THEMES as Record<string, ThemeEntry>)[name]
}

// ── 主题切换 ───────────────────────────────────────────────────────

/** 进程内默认主题（未配置 ui.theme 时的落点）。2026-09 用户要求换回 cobalt
 *  ——它在 2026-07-07~07-17 本就是默认（后被 graphite 取代，09-10 短暂换过
 *  cyberpunk）。cobalt 的定位即「视觉极度舒适」的冷调中性，适合做默认。 */
let activeTheme: string = 'cobalt'

/** 切换主题。接受内置名或 `custom:<name>`；未知名 no-op 并返回 false。 */
export function setTheme(name: ThemeName | (string & {})): boolean {
  if (!resolveThemeEntry(name)) return false
  activeTheme = name
  return true
}

export function getActiveThemeName(): string {
  return activeTheme
}

/** 当前主题面向的终端背景。 */
export function getActiveThemeBackground(): 'dark' | 'light' {
  return resolveThemeEntry(activeTheme)?.background ?? 'dark'
}

export function getTheme(colorLevel?: number): RivetTheme {
  const level = colorLevel ?? chalk.level
  const entry = resolveThemeEntry(activeTheme) ?? THEMES.cobalt
  // level 2（256 色）走 truecolor 轨：ansi.ts fg() 会现场量化为 38;5。
  return level >= 2 ? entry.truecolor : entry.fallback
}
