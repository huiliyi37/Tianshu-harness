/**
 * domain-picker 改版与创世碑文卡测试：
 * - 选择页：列表行内别名+职责标语、详情区展示提示词精华（essence）、滚动窗口选中可见
 * - 创世碑文卡：头部/印记/碑文段落/滚动与边界
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderDomainPicker, renderDomainGenesisCard, genesisCardMaxScroll } from '../overlay.js'
import type { DomainPickerData, DomainGenesisCardData } from '../overlay.js'
import { STAR_GENESIS } from '../../../agent/star-genesis-data.js'
import { DOMAIN_SWITCH_CACHE_NOTE } from '../../../agent/domain-picker-entries.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function pickerData(): DomainPickerData {
  return {
    entries: [
      { key: 'auto', name: 'Auto', motto: '按任务匹配', alias: '按任务匹配', tagline: '关键词自动路由 · 未命中回退天权', meta: '', essence: '自动匹配', current: false, uiPersona: { separator: 'thin', accent: 'primary', glyph: '❂' } },
      {
        key: 'tianquan', name: '天权', motto: '观天之道，执天之行', alias: '方案审查官', tagline: '称量归位 · 严谨门禁',
        meta: '', essence: '你当前在天权域。你是天权——称量者与高处的眼。秤的两端都要放东西：改动的收益是什么，代价是什么。',
        founder: 'DeepSeek V4 Pro', expertise: '称量与审查——这值得建吗、这该拆吗，每个动作前替你掂量。',
        current: true, uiPersona: { separator: 'thin', accent: 'warning', glyph: '⚖' },
      },
    ],
    selectedIndex: 1,
  }
}

/** 8 项（Auto + 7 域）——矮终端下触发列表滚动窗口。 */
function pickerDataMany(): DomainPickerData {
  const mk = (key: string, name: string, alias: string, tagline: string, essence: string, current = false): DomainPickerData['entries'][number] => ({
    key, name, motto: `${name}之格言`, alias, tagline, meta: '', essence,
    founder: undefined, expertise: `${name}的一句话专长`,
    current, uiPersona: { separator: 'thin', accent: 'primary', glyph: '☥' },
  })
  return {
    entries: [
      { key: 'auto', name: 'Auto', motto: '按任务匹配', alias: '按任务匹配', tagline: '关键词自动路由', meta: '', essence: '自动匹配', current: false, uiPersona: { separator: 'thin', accent: 'primary', glyph: '❂' } },
      mk('d1', '甲', '甲别名', '甲标语', '甲精华'),
      mk('d2', '乙', '乙别名', '乙标语', '乙精华'),
      mk('d3', '丙', '丙别名', '丙标语', '丙精华'),
      mk('d4', '丁', '丁别名', '丁标语', '丁精华'),
      mk('d5', '戊', '戊别名', '戊标语', '戊精华', true),
      mk('d6', '己', '己别名', '己标语', '己精华'),
      mk('d7', '庚', '庚别名', '庚标语', '庚精华'),
    ],
    selectedIndex: 5,
  }
}

describe('renderDomainPicker — 别名行内 · 提示词精华入详情区', () => {
  it('列表行内展示别名与职责标语，不再放创始星', () => {
    const lines = renderDomainPicker(pickerData(), 90, 18, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('方案审查官')), '行内应有工程别名')
    assert.ok(lines.some(l => l.includes('称量归位')), '行内应有职责标语')
    assert.ok(!lines.some(l => l.includes('DeepSeek V4 Pro') && !l.includes('创始星')), '创始星只应出现在详情区徽章行，不在列表行')
  })

  it('详情区展示别名、职责标语、motto 与提示词精华', () => {
    const lines = renderDomainPicker(pickerData(), 90, 24, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('方案审查官')), '详情区含别名')
    assert.ok(lines.some(l => l.includes('创始星：DeepSeek V4 Pro') || lines.some(l2 => l2.includes('DeepSeek V4 Pro')), '详情区含创始星'))
    assert.ok(lines.some(l => l.includes('「观天之道，执天之行」')), 'motto 保留')
    assert.ok(lines.some(l => l.includes('称量者与高处的眼')), 'essence 提示词精华多行展示')
  })

  it('详情区 essence 按宽度折行，末行截断不越界', () => {
    const width = 40
    const lines = renderDomainPicker(pickerData(), width, 24, theme).map(stripAnsi)
    for (const l of lines) {
      assert.ok(l.length <= width, `行宽不得超 ${width}：${l}`)
    }
    assert.ok(lines.some(l => l.includes('你当前在天权域')), 'essence 首句可见')
  })

  it('底部常驻缓存碎裂备注', () => {
    const lines = renderDomainPicker(pickerData(), 90, 18, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes(DOMAIN_SWITCH_CACHE_NOTE)), '底部应有缓存备注')
  })

  it('矮终端列表滚动：选中项（index 5）恒可见，截断处有指示', () => {
    const lines = renderDomainPicker(pickerDataMany(), 90, 18, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('戊') && l.includes('戊别名')), '选中项在可视区内')
    assert.ok(lines.some(l => l.includes('↓') || l.includes('↑')), '截断指示行存在')
  })

  it('Auto 条目无 founder 时详情区正常 fallback', () => {
    const data = pickerData()
    const lines = renderDomainPicker({ ...data, selectedIndex: 0 }, 90, 24, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('Auto')), '详情区显示 Auto')
    assert.ok(lines.some(l => l.includes('按任务匹配')), '别名 fallback 正常')
  })
})

function cardData(scroll = 0): DomainGenesisCardData {
  const genesis = STAR_GENESIS.find(g => g.key === 'qisha')!
  return { genesis, glyph: '◌', accent: 'warning', scroll }
}

describe('renderDomainGenesisCard — 创世碑文卡', () => {
  it('头部含星名与主星模型，motto 随行', () => {
    const lines = renderDomainGenesisCard(cardData(), 90, 30, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('七杀 · Claude Opus 5')), '头部 星名·模型')
    assert.ok(lines.some(l => l.includes('肃秋非杀')), 'motto 在头部')
  })

  it('印记 seal 与释义可见', () => {
    const lines = renderDomainGenesisCard(cardData(), 90, 30, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('印记 七·0·◌')), '印记行')
    assert.ok(lines.some(l => l.includes('留白位')), '释义行')
  })

  it('碑文段落完整呈现（含关键句）', () => {
    const h = 70
    assert.equal(genesisCardMaxScroll(cardData(), 90, h), 0, '该高度下全文应一屏放下')
    const lines = renderDomainGenesisCard(cardData(), 90, h, theme).map(stripAnsi)
    const joined = lines.map(l => l.replace(/[│\s]/g, '')).join('')
    assert.ok(joined.includes('我来减'), '星盟首段')
    assert.ok(joined.includes('指认的门槛为零'), '关键句')
    assert.ok(joined.includes('遇帝则化权'), '末段')
  })

  it('滚动：maxScroll 与切片一致，越界被夹取', () => {
    const max = genesisCardMaxScroll(cardData(), 90, 12)
    assert.ok(max > 0, '小高度下应可滚动')
    const top = renderDomainGenesisCard(cardData(0), 90, 12, theme).map(stripAnsi)
    const bottom = renderDomainGenesisCard(cardData(max + 99), 90, 12, theme).map(stripAnsi)
    assert.ok(top.some(l => l.includes('七杀 · Claude Opus 5')), '第 0 屏是头部')
    assert.ok(bottom.some(l => l.includes('遇帝则化权') || l.includes('终于能呼吸')), '末屏是碑文尾段')
    assert.ok(bottom.some(l => l.includes('返回')), 'footer 在位')
  })
})

describe('renderDomainPicker — 矮终端不超屏（回归）', () => {
  it('height < 13 时渲染行数不超过 height（底部内容不被 overlay-engine 截断）', () => {
    const data = pickerDataMany()
    for (const height of [8, 10, 12, 13, 14, 18]) {
      const lines = renderDomainPicker(data, 90, height, theme)
      assert.ok(
        lines.length <= height,
        `height=${height} 时渲染 ${lines.length} 行，超屏 ${lines.length - height} 行（底部备注/footer/边框会被截断）`,
      )
    }
  })

  it('矮终端选中项仍可见且详情区有徽章内容', () => {
    const lines = renderDomainPicker(pickerDataMany(), 90, 10, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('戊') && l.includes('戊别名')), '选中项在可视区内')
    assert.ok(lines.some(l => l.includes('戊 · 戊别名')), '详情区徽章行（glyph+星名+别名）存在')
  })
})
