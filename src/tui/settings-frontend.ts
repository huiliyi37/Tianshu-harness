import { DEFAULT_FRONTEND_PREFERENCES, validateFrontendPreferences, type FrontendPreferences } from './frontend-preferences.js'
import type { SettingsBlockId, SettingsCategory, SettingsDraft, SettingsField, SettingsEffect, SettingsOption } from './settings-model.js'
export type { FrontendPreferences } from './frontend-preferences.js'

export function intField(input: {
  id: string
  label: string
  block: SettingsBlockId
  effect: SettingsEffect
  hint?: string
  min: number
  get: (draft: SettingsDraft) => number
  set: (draft: SettingsDraft, value: number) => SettingsDraft
  guard?: (draft: SettingsDraft) => string | undefined
}): SettingsField {
  return {
    id: input.id,
    label: input.label,
    kind: 'int',
    block: input.block,
    effect: input.effect,
    hint: input.hint,
    display: draft => String(input.get(draft)),
    raw: draft => String(input.get(draft)),
    apply: (draft, raw) => {
      const blocked = input.guard?.(draft)
      if (blocked) return { error: blocked }
      const value = Number.parseInt(raw.trim(), 10)
      if (!Number.isInteger(value) || value < input.min) {
        return { error: `需为不小于 ${input.min} 的整数` }
      }
      return input.set(draft, value)
    },
  }
}

export function frontendCategories(): SettingsCategory[] {
  const get = (d: SettingsDraft): FrontendPreferences => d.frontend ?? DEFAULT_FRONTEND_PREFERENCES
  const set = (d: SettingsDraft, patch: Partial<FrontendPreferences>): SettingsDraft | { error: string } => {
    const frontend = { ...get(d), ...patch }
    const errors = validateFrontendPreferences(frontend)
    return errors.length ? { error: errors.join('；') } : { ...d, frontend }
  }
  const choice = (key: 'keymap' | 'inputMode' | 'renderer' | 'welcome', label: string, options: SettingsOption[], effect: SettingsEffect, hint: string): SettingsField => ({
    id: `frontend.${key}`, label, block: 'frontend', kind: 'enum', effect, hint,
    display: d => options.find(option => option.id === get(d)[key])?.label ?? get(d)[key],
    options: () => options,
    selectedId: d => get(d)[key],
    apply: (d, value) => options.some(option => option.id === value) ? set(d, { [key]: value }) : { error: `未知取值：${value}` },
  })
  const toggle = (key: 'mouse' | 'copyOnSelect', label: string, hint: string): SettingsField => ({
    id: `frontend.${key}`, label, block: 'frontend', kind: 'bool', effect: 'immediate', hint,
    display: d => get(d)[key] ? '开' : '关',
    selectedId: d => String(get(d)[key]),
    apply: (d, value) => set(d, { [key]: value === 'true' }),
  })
  return [
    { id: 'interaction', label: '交互', fields: [
      choice('keymap', '快捷键映射', [{ id: 'standard', label: '天枢标准' }, { id: 'legacy', label: '旧版兼容' }], 'next-startup', '保存为用户默认；下次启动生效。/keybindings 查看动作与冲突'),
      choice('inputMode', '输入方式', [{ id: 'single', label: '标准单行' }, { id: 'multiline', label: '多行输入' }], 'immediate', '保存后应用当前会话并作为默认；多行模式 Enter 换行，发送键依据宿主能力'),
    ] },
    { id: 'appearance', label: '外观与终端', fields: [
      choice('renderer', '渲染方式', [{ id: 'auto', label: '自动' }, { id: 'classic', label: '经典' }, { id: 'fullscreen', label: '全屏' }], 'immediate', '空闲且无待审批时可切换；宿主不支持或切换失败不保存'),
      toggle('mouse', '鼠标交互', '保存后应用当前会话；仅全屏且宿主支持时启用'),
      toggle('copyOnSelect', '选中即复制', '保存后应用当前会话；选择结束时复制，取决于宿主剪贴板能力'),
      choice('welcome', '欢迎页', [{ id: 'compact', label: '紧凑' }, { id: 'full', label: '完整' }], 'next-startup', '下次启动生效；首次真实输入后收起引导'),
    ] },
  ]
}

export function frontendBlockValue(frontend: FrontendPreferences | undefined): unknown {
  return frontend && {
    renderer: frontend.renderer, keymap: frontend.keymap, inputMode: frontend.inputMode,
    mouse: frontend.mouse, copyOnSelect: frontend.copyOnSelect, welcome: frontend.welcome,
    bindings: Object.fromEntries(Object.entries(frontend.bindings).sort(([a], [b]) => a.localeCompare(b))),
  }
}
