import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderModelPicker, renderThemePicker, stepModelPickerEffort } from '../format/overlay.js'
import type { ModelPickerData, ThemePickerData } from '../format/overlay.js'
import { getTheme, THEMES } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('renderModelPicker', () => {
  it('renders border and model list', () => {
    const data: ModelPickerData = {
      entries: [
        { id: 'deepseek-chat', provider: 'deepseek', current: true, contextWindow: 64000 },
        { id: 'gpt-5.5', provider: 'openai', current: false, contextWindow: 128000 },
      ],
      selectedIndex: 0,
    }
    const lines = renderModelPicker(data, 80, 20, theme)
    assert.ok(lines.length > 0)
    assert.ok(stripAnsi(lines[0]!).includes('│'))
    // alias 废弃后模型一律按原 ID 展示——不再有 alias (id) 双段
    assert.ok(lines.some(l => stripAnsi(l).includes('deepseek-chat')))
    assert.ok(lines.some(l => stripAnsi(l).includes('gpt-5.5')))
  })

  it('shows selected indicator and current mark', () => {
    const data: ModelPickerData = {
      entries: [
        { id: 'model-a', provider: 'provider-a', current: false },
        { id: 'model-b', provider: 'provider-b', current: true },
      ],
      selectedIndex: 0,
    }
    const lines = renderModelPicker(data, 80, 20, theme)
    // SelectedIndex = 0 (model-a) -> should have > cursor（id-only 展示，按 id 找行）
    const modelALine = lines.find(l => stripAnsi(l).includes('model-a'))
    const modelBLine = lines.find(l => stripAnsi(l).includes('model-b'))
    assert.ok(modelALine && stripAnsi(modelALine).includes('>'))
    // Current = true (model-b) -> should have ● current mark
    assert.ok(modelBLine && stripAnsi(modelBLine).includes('●'))
  })

  it('shows model specs in bottom preview region', () => {
    const data: ModelPickerData = {
      entries: [
        { id: 'deepseek-chat', provider: 'deepseek', current: true, contextWindow: 64000 },
      ],
      selectedIndex: 0,
    }
    const lines = renderModelPicker(data, 80, 15, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('上下文配额: 64,000 tokens')))
    assert.ok(lines.some(l => stripAnsi(l).includes('极速先锋')))
  })
})

describe('renderThemePicker', () => {
  it('renders themes list', () => {
    const data: ThemePickerData = {
      entries: [
        { name: 'cobalt', current: true, isDefault: false, description: '钴蓝主题' },
        { name: 'gemini', current: false, isDefault: true, description: '双子星主题' },
      ],
      selectedIndex: 1,
    }
    const lines = renderThemePicker(data, 80, 20, theme)
    assert.ok(lines.length > 0)
    assert.ok(lines.some(l => stripAnsi(l).includes('cobalt')))
    assert.ok(lines.some(l => stripAnsi(l).includes('gemini')))
    // selectedIndex = 1 (gemini) -> has > cursor
    const geminiLine = lines.find(l => stripAnsi(l).includes('gemini'))
    assert.ok(geminiLine && stripAnsi(geminiLine).includes('>'))
  })

  it('renders theme details and primary/secondary color swatches', () => {
    const data: ThemePickerData = {
      entries: [
        { name: 'gemini', current: true, isDefault: false, description: '双子星独特微光渐变' },
      ],
      selectedIndex: 0,
    }
    const lines = renderThemePicker(data, 80, 15, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('双子星独特微光渐变')))
    // Test ANSI color swatch preview
    const swatchLine = lines.find(l => stripAnsi(l).includes('Accent') && stripAnsi(l).includes('Success'))
    assert.ok(swatchLine)
    assert.ok(/\x1B\[/.test(swatchLine), 'swatch preview row has ANSI color sequences')
  })
})

// ── effort 行（CC 对标：/model 面板内随模型调整推理等级）─────────────

describe('renderModelPicker effort row', () => {
  const baseEntries = [
    { id: 'deepseek-v4-pro', provider: 'deepseek', current: true, contextWindow: 64000, effortSupported: true },
  ]

  it('renders effort row with level and adjust hint when supported', () => {
    const data: ModelPickerData = {
      entries: baseEntries,
      selectedIndex: 0,
      effort: { value: 'high', supported: true },
    }
    const lines = renderModelPicker(data, 80, 20, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.match(text, /high effort/)
    assert.match(text, /<\/> 调整/)
  })

  it('renders auto sentinel with explanation', () => {
    const data: ModelPickerData = {
      entries: baseEntries,
      selectedIndex: 0,
      effort: { value: 'auto', supported: true },
    }
    const text = lines0(renderModelPicker(data, 80, 20, theme))
    assert.match(text, /auto（按任务自动）/)
    assert.doesNotMatch(text, /auto effort/)
  })

  it('renders unsupported models with a muted notice instead of the adjust hint', () => {
    const data: ModelPickerData = {
      entries: [{ ...baseEntries[0]!, effortSupported: false }],
      selectedIndex: 0,
      effort: { value: 'high', supported: false },
    }
    const text = lines0(renderModelPicker(data, 80, 20, theme))
    assert.match(text, /此模型不支持推理等级调节/)
    assert.doesNotMatch(text, /<\/> 调整/)
  })

  it('flips footer semantics to CC style: Enter=set default, s=session only', () => {
    const data: ModelPickerData = { entries: baseEntries, selectedIndex: 0 }
    const text = lines0(renderModelPicker(data, 80, 20, theme))
    assert.match(text, /Enter:设为默认/)
    assert.match(text, /s:仅本会话/)
  })

  it('omits the effort row entirely when data.effort is absent', () => {
    const data: ModelPickerData = { entries: baseEntries, selectedIndex: 0 }
    const text = lines0(renderModelPicker(data, 80, 20, theme))
    assert.doesNotMatch(text, /effort/)
    assert.doesNotMatch(text, /推理等级/)
  })
})

describe('stepModelPickerEffort', () => {
  it('steps toward heavier levels on > and wraps max→auto', () => {
    assert.equal(stepModelPickerEffort('auto', '>'), 'off')
    assert.equal(stepModelPickerEffort('low', '>'), 'medium')
    assert.equal(stepModelPickerEffort('max', '>'), 'auto')
  })

  it('steps toward lighter levels on < and wraps auto→max', () => {
    assert.equal(stepModelPickerEffort('off', '<'), 'auto')
    assert.equal(stepModelPickerEffort('medium', '<'), 'low')
    assert.equal(stepModelPickerEffort('auto', '<'), 'max')
  })
})

function lines0(lines: string[]): string {
  return lines.map(stripAnsi).join('\n')
}
